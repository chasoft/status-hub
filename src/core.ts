// Business logic for Status Hub. Pure functions over D1; no AI calls.
// All timestamps are epoch ms UTC.
import { getHubConfig, isPrivilegedId } from "./config";
import { enqueueWebhook } from "./webhooks";

export type Status =
  | "pending_approval" | "backlog" | "assigned" | "in_progress" | "review" | "blocked" | "done" | "cancelled";

export const STATUSES: Status[] = [
  "pending_approval", "backlog", "assigned", "in_progress", "review", "blocked", "done", "cancelled",
];

/** True when the value is a configured owner or approver id. Those ids are not required to be members. */
export function isApprover(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && isPrivilegedId(v);
}

export interface Member {
  id: string;
  name: string;
  role: string;
  is_admin: number;
}

export class AppError extends Error {
  constructor(public code: "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT", message: string) {
    super(message);
  }
  get httpStatus(): number {
    return { BAD_REQUEST: 400, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409 }[this.code];
  }
}

// ---------- permissions (always derived from the token's member, never from params)

const LEADER_ROLES = new Set(["pm", "po", "lead", "admin"]);
export const isAdmin = (m: Member) => m.is_admin === 1 || m.role === "admin";
export const isLeader = (m: Member) => isAdmin(m) || LEADER_ROLES.has(m.role);

export function requireLeader(m: Member, action: string) {
  if (!isLeader(m)) throw new AppError("FORBIDDEN", `${action} cần quyền pm/po/lead/admin (bạn: ${m.role})`);
}
export function requireAdmin(m: Member, action: string) {
  if (!isAdmin(m)) throw new AppError("FORBIDDEN", `${action} chỉ admin được làm`);
}

// ---------- code formats

export const PROJECT_RE = /^[A-Z]{2,5}$/;
export const MODULE_PART_RE = /^[A-Z]{2,6}$/;
export const MODULE_RE = /^[A-Z]{2,5}-[A-Z]{2,6}$/;
export const FEATURE_RE = /^[A-Z]{2,5}-[A-Z]{2,6}-\d{3,}$/;
export const TASK_RE = /^[A-Z]{2,5}-[A-Z]{2,6}-\d{3,}\.\d+$/;

// ---------- lifecycle

// report_status may perform these. blocked is entered only via set_blocker.
// pm/admin may also move backlog, assigned, or blocked → pending_approval.
// pending_approval is left only by an admin (approve -> backlog/assigned, reject -> cancelled).
const TRANSITIONS: Record<Status, Status[]> = {
  pending_approval: ["backlog", "assigned", "cancelled"],
  backlog: ["assigned", "pending_approval", "cancelled"], // assigned only via explicit report_status, never via assignee
  assigned: ["in_progress", "pending_approval", "cancelled"],
  in_progress: ["review", "assigned", "cancelled"], // assigned: agent stopped working
  review: ["done", "in_progress", "cancelled"],
  blocked: ["pending_approval", "cancelled"],
  done: [],
  cancelled: [],
};

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------- helpers

export const NOTE_MAX = 500;

export function clipNote(note: string | undefined | null): string | null {
  if (note == null) return null;
  const n = note.trim();
  if (n.length > NOTE_MAX) throw new AppError("BAD_REQUEST", `note tối đa ${NOTE_MAX} ký tự`);
  return n || null;
}

/** http(s) only. Rejects other schemes and non-URLs with BAD_REQUEST. */
function assertHttpUrl(raw: string, label = "link"): string {
  const u = raw.trim();
  let protocol = "";
  try {
    protocol = new URL(u).protocol;
  } catch {
    protocol = "";
  }
  if (!u || u.length > 500 || (protocol !== "http:" && protocol !== "https:")) {
    throw new AppError("BAD_REQUEST", `${label} không hợp lệ: chỉ nhận URL http hoặc https`);
  }
  return u;
}

function validLinks(links: string[] | undefined): string[] {
  const out = (links ?? []).map((l) => l.trim()).filter(Boolean);
  if (out.length > 10) throw new AppError("BAD_REQUEST", "tối đa 10 link");
  return out.map((l) => assertHttpUrl(l, "link"));
}

/** Empty means "no explicit pr_url". A non-empty value must be http(s). */
function explicitPrUrl(raw: string | null | undefined): string | null {
  if (raw == null || raw.trim() === "") return null;
  return assertHttpUrl(raw, "pr_url");
}

function pullLink(links: string[]): string | null {
  return links.find((l) => /\/pull\/\d+/.test(l)) ?? null;
}

async function getMember(db: D1Database, id: string): Promise<Member> {
  const m = await db.prepare("SELECT id, name, role, is_admin FROM members WHERE id = ? AND active = 1")
    .bind(id).first<Member>();
  if (!m) throw new AppError("NOT_FOUND", `không có member '${id}'`);
  return m;
}

export interface TaskRow {
  code: string; feature_code: string; project_code: string; title: string;
  assignee_id: string | null; status: Status; created_by: string | null;
  created_at: number; assigned_at: number | null; started_at: number | null;
  last_update_at: number; done_at: number | null; due_at: number | null; pr_url: string | null;
  reviewer_id: string | null;
  requested_by: string | null;
  requested_at: number | null;
  request_link: string | null;
  agent_url: string | null;
  agent_status: string | null;
  agent_updated_at: number | null;
}

export async function getTaskRow(db: D1Database, code: string): Promise<TaskRow> {
  const t = await db.prepare("SELECT * FROM tasks WHERE code = ?").bind(code).first<TaskRow>();
  if (!t) throw new AppError("NOT_FOUND", `không có task '${code}'`);
  return t;
}

export function canEditTask(m: Member, t: { assignee_id: string | null }) {
  return isLeader(m) || t.assignee_id === m.id;
}
function canTouchTask(m: Member, t: TaskRow) {
  return canEditTask(m, t);
}

/** Assignee, reviewer, or the same leaders who can already edit the task. */
function canSetAgent(m: Member, t: TaskRow) {
  return canTouchTask(m, t) || t.reviewer_id === m.id;
}

const AGENT_STATUS_MAX = 64;

/** https only. Empty means clear. */
function explicitHttpsUrl(raw: string | null | undefined, label: string): string | null {
  if (raw == null || raw.trim() === "") return null;
  const u = raw.trim();
  let protocol = "";
  try {
    protocol = new URL(u).protocol;
  } catch {
    protocol = "";
  }
  if (!u || u.length > 500 || protocol !== "https:") {
    throw new AppError("BAD_REQUEST", `${label} must be an https URL`);
  }
  return u;
}

export const REQUEST_MAX = 50_000;

export interface OutputRef {
  attachments: { id: number; name: string; version: number }[];
  links: string[];
}

export interface RequestVersionMeta {
  version: number;
  author_id: string;
  at: number;
  note: string | null;
}

function cleanRequestBody(markdown: string): string {
  const body = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!body) throw new AppError("BAD_REQUEST", "request markdown is empty");
  if (body.length > REQUEST_MAX) throw new AppError("BAD_REQUEST", `request markdown is longer than ${REQUEST_MAX} characters`);
  return body;
}

/** Insert a new request version. Previous rows are left as they were. */
export async function setRequestDocument(db: D1Database, actor: Member, p: {
  task: string; markdown: string; note?: string | null;
}, now = Date.now()) {
  const t = await getTaskRow(db, p.task);
  if (!canEditTask(actor, t)) throw new AppError("FORBIDDEN", "chỉ người được giao (hoặc pm/po/lead/admin) được sửa task này");
  const body = cleanRequestBody(p.markdown);
  const note = clipNote(p.note);
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM request_versions WHERE task_code = ?")
      .bind(t.code).first<{ v: number }>();
    const version = (cur?.v ?? 0) + 1;
    try {
      await db.prepare(
        "INSERT INTO request_versions (task_code, version, body, author_id, created_at, note) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(t.code, version, body, actor.id, now, note).run();
      return { task: t.code, version, author_id: actor.id, at: now, note, markdown: body };
    } catch (err) {
      if (attempt === 0 && /UNIQUE|constraint/i.test(String(err))) continue;
      throw err;
    }
  }
  throw new AppError("CONFLICT", "could not store the request version");
}

export async function getRequestDocument(db: D1Database, task: string, version?: number | null) {
  if (!TASK_RE.test(task)) throw new AppError("BAD_REQUEST", "mã task không hợp lệ");
  await getTaskRow(db, task);
  if (version != null && (!Number.isInteger(version) || version < 1)) {
    throw new AppError("BAD_REQUEST", "version must be a positive integer");
  }
  const listed = await db.prepare(
    "SELECT version, author_id, created_at, note FROM request_versions WHERE task_code = ? ORDER BY version DESC",
  ).bind(task).all<{ version: number; author_id: string; created_at: number; note: string | null }>();
  const versions: RequestVersionMeta[] = listed.results.map((row) => ({
    version: row.version, author_id: row.author_id, at: row.created_at, note: row.note,
  }));
  const latest = versions[0]?.version ?? null;
  const wanted = version ?? latest;
  if (wanted == null) {
    return { task, version: null, latest: null, markdown: null, author_id: null, at: null, note: null, versions };
  }
  const row = await db.prepare(
    "SELECT version, body, author_id, created_at, note FROM request_versions WHERE task_code = ? AND version = ?",
  ).bind(task, wanted).first<{ version: number; body: string; author_id: string; created_at: number; note: string | null }>();
  if (!row) throw new AppError("NOT_FOUND", `request version ${wanted} was not found`);
  return {
    task, version: row.version, latest, markdown: row.body, author_id: row.author_id,
    at: row.created_at, note: row.note, versions,
  };
}

export async function reviewSnapshot(db: D1Database, task: string, extraLinks: string[] = []): Promise<OutputRef & { request_version: number | null }> {
  const [atts, links, req] = await db.batch([
    db.prepare(
      `SELECT a.id, a.name, v.version FROM attachments a
       JOIN attachment_versions v ON v.attachment_id = a.id
       WHERE a.task_code = ? AND a.grp = 'output'
         AND v.version = (SELECT MAX(version) FROM attachment_versions WHERE attachment_id = a.id)
       ORDER BY a.name`,
    ).bind(task),
    db.prepare("SELECT url FROM output_links WHERE task_code = ? ORDER BY id").bind(task),
    db.prepare("SELECT MAX(version) AS v FROM request_versions WHERE task_code = ?").bind(task),
  ]);
  const seen = new Set<string>();
  const allLinks: string[] = [];
  for (const url of [
    ...(links.results as { url: string }[]).map((row) => row.url),
    ...extraLinks,
  ]) {
    if (!seen.has(url)) {
      seen.add(url);
      allLinks.push(url);
    }
  }
  return {
    request_version: (req.results[0] as { v: number | null } | undefined)?.v ?? null,
    attachments: atts.results as { id: number; name: string; version: number }[],
    links: allLinks,
  };
}

export function outputRefJson(ref: OutputRef): string {
  return JSON.stringify({ attachments: ref.attachments, links: ref.links });
}

export async function addOutputLink(db: D1Database, actor: Member, p: { task: string; url: string; note?: string | null }, now = Date.now()) {
  const t = await getTaskRow(db, p.task);
  if (!canEditTask(actor, t)) throw new AppError("FORBIDDEN", "chỉ người được giao (hoặc pm/po/lead/admin) được sửa task này");
  const url = assertHttpUrl(p.url, "output link");
  const note = clipNote(p.note);
  const res = await db.prepare(
    "INSERT INTO output_links (task_code, url, author_id, created_at, note) VALUES (?, ?, ?, ?, ?) RETURNING id",
  ).bind(t.code, url, actor.id, now, note).run();
  const id = (res.results[0] as { id: number } | undefined)?.id;
  return { id, task: t.code, url, at: now, note };
}

export interface AttachmentSummaryItem {
  id: number;
  name: string;
  version_count: number;
  latest_version: number;
  mime: string;
  bytes: number;
}

export async function attachmentSummary(db: D1Database, task: string): Promise<{
  requirement: AttachmentSummaryItem[];
  output: AttachmentSummaryItem[];
  output_links: { id: number; url: string; at: number; note: string | null }[];
}> {
  const [rows, links] = await db.batch([
    db.prepare(
      `SELECT a.id, a.grp, a.name, COUNT(v.version) AS version_count, MAX(v.version) AS latest_version,
              (SELECT mime FROM attachment_versions WHERE attachment_id = a.id ORDER BY version DESC LIMIT 1) AS mime,
              (SELECT bytes FROM attachment_versions WHERE attachment_id = a.id ORDER BY version DESC LIMIT 1) AS bytes
       FROM attachments a JOIN attachment_versions v ON v.attachment_id = a.id
       WHERE a.task_code = ? GROUP BY a.id ORDER BY a.grp, a.name`,
    ).bind(task),
    db.prepare("SELECT id, url, created_at, note FROM output_links WHERE task_code = ? ORDER BY id").bind(task),
  ]);
  const grouped: { requirement: AttachmentSummaryItem[]; output: AttachmentSummaryItem[] } = { requirement: [], output: [] };
  for (const row of rows.results as {
    id: number; grp: "requirement" | "output"; name: string; version_count: number; latest_version: number; mime: string; bytes: number;
  }[]) {
    grouped[row.grp].push({
      id: row.id, name: row.name, version_count: row.version_count, latest_version: row.latest_version, mime: row.mime, bytes: row.bytes,
    });
  }
  return {
    ...grouped,
    output_links: (links.results as { id: number; url: string; created_at: number; note: string | null }[]).map((row) => ({
      id: row.id, url: row.url, at: row.created_at, note: row.note,
    })),
  };
}

// ---------- status periods (time-in-status)

/**
 * Statements that close the task's open status period and open a new one.
 * Always run them inside the SAME db.batch() as the tasks.status UPDATE so the
 * period log never disagrees with tasks.status. uq_periods_open guarantees at
 * most one open period per task.
 */
export function periodStmts(db: D1Database, code: string, status: Status, memberId: string, now: number): D1PreparedStatement[] {
  return [
    db.prepare("UPDATE status_periods SET ended_at = MAX(?, started_at) WHERE task_code = ? AND ended_at IS NULL").bind(now, code),
    db.prepare("INSERT INTO status_periods (task_code, status, started_at, member_id) VALUES (?, ?, ?, ?)").bind(code, status, now, memberId),
  ];
}

export interface PeriodRow {
  id: number; status: Status; started_at: number; ended_at: number | null; member_id: string | null;
}

/** Compact duration: 45m, 2h15m, 3d4h. */
export function formatDuration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d${h % 24}h` : `${d}d`;
}

export function summarizePeriods(periods: PeriodRow[], now = Date.now()) {
  const timeline = periods.map((p) => {
    const ms = Math.max(0, (p.ended_at ?? now) - p.started_at);
    return { ...p, open: p.ended_at === null, duration_ms: ms, duration: formatDuration(ms) };
  });
  const totals: Record<string, { duration_ms: number; duration: string; periods: number }> = {};
  for (const p of timeline) {
    const t = (totals[p.status] ??= { duration_ms: 0, duration: "", periods: 0 });
    t.duration_ms += p.duration_ms;
    t.periods += 1;
  }
  for (const t of Object.values(totals)) t.duration = formatDuration(t.duration_ms);
  const cur = timeline.find((p) => p.open) ?? null;
  return {
    current: cur ? { status: cur.status, since: cur.started_at, duration_ms: cur.duration_ms, duration: cur.duration } : null,
    timeline,
    totals,
  };
}

export async function getPeriods(db: D1Database, code: string): Promise<PeriodRow[]> {
  const { results } = await db.prepare(
    "SELECT id, status, started_at, ended_at, member_id FROM status_periods WHERE task_code = ? ORDER BY started_at, id",
  ).bind(code).all<PeriodRow>();
  return results;
}

export async function getTaskTimeline(db: D1Database, code: string, now = Date.now()) {
  const t = await getTaskRow(db, code);
  return { code: t.code, status: t.status, ...summarizePeriods(await getPeriods(db, code), now) };
}

export async function openAlertsFor(db: D1Database, memberId: string) {
  const { results } = await db.prepare(
    `SELECT a.task_code, a.rule, a.fired_at FROM alerts a JOIN tasks t ON t.code = a.task_code
     WHERE a.cleared_at IS NULL AND t.assignee_id = ? ORDER BY a.fired_at LIMIT 20`,
  ).bind(memberId).all();
  return results;
}

// ---------- registry (admin)

export async function createProject(db: D1Database, actor: Member, p: {
  code: string; name: string; owner?: string; repo_url?: string;
}, now = Date.now()) {
  requireAdmin(actor, "create_project");
  if (!PROJECT_RE.test(p.code)) throw new AppError("BAD_REQUEST", "mã project phải khớp ^[A-Z]{2,5}$");
  if (p.owner) await getMember(db, p.owner);
  try {
    await db.batch([
      db.prepare("INSERT INTO projects (code, name, owner_id, repo_url, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(p.code, p.name, p.owner ?? null, p.repo_url ?? null, now),
      db.prepare("INSERT INTO modules (code, project_code, name, owner_id, created_at) VALUES (?, ?, 'Core', ?, ?)")
        .bind(`${p.code}-CORE`, p.code, p.owner ?? null, now),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new AppError("CONFLICT", `project ${p.code} đã có`);
    throw e;
  }
  return { code: p.code, modules: [`${p.code}-CORE`] };
}

export async function createModule(db: D1Database, actor: Member, p: {
  project: string; code: string; name: string; owner?: string;
}, now = Date.now()) {
  requireAdmin(actor, "create_module");
  if (!MODULE_PART_RE.test(p.code)) throw new AppError("BAD_REQUEST", "mã module phải khớp ^[A-Z]{2,6}$");
  const proj = await db.prepare("SELECT code FROM projects WHERE code = ?").bind(p.project).first();
  if (!proj) throw new AppError("NOT_FOUND", `không có project ${p.project}`);
  if (p.owner) await getMember(db, p.owner);
  const code = `${p.project}-${p.code}`;
  try {
    await db.prepare("INSERT INTO modules (code, project_code, name, owner_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(code, p.project, p.name, p.owner ?? null, now).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new AppError("CONFLICT", `module ${code} đã có`);
    throw e;
  }
  return { code };
}

// ---------- code allocation: counter bump + insert in ONE batch (single transaction)

export async function createFeature(db: D1Database, actor: Member, p: {
  module: string; title: string; spec_url?: string; priority?: string; owner?: string; due_at?: number;
}, now = Date.now()) {
  requireLeader(actor, "create_feature");
  const mod = await db.prepare("SELECT code, project_code FROM modules WHERE code = ?").bind(p.module)
    .first<{ code: string; project_code: string }>();
  if (!mod) throw new AppError("NOT_FOUND", `không có module ${p.module}`);
  const priority = p.priority ?? "P2";
  if (!/^P[0-3]$/.test(priority)) throw new AppError("BAD_REQUEST", "priority P0..P3");
  if (p.owner) await getMember(db, p.owner);
  const scope = `F:${mod.code}`;
  const res = await db.batch([
    db.prepare("INSERT OR IGNORE INTO counters (scope, next) VALUES (?, 0)").bind(scope),
    db.prepare("UPDATE counters SET next = next + 1 WHERE scope = ? RETURNING next").bind(scope),
    db.prepare(
      `INSERT INTO features (code, module_code, project_code, title, spec_url, owner_id, priority, due_at, created_at)
       SELECT ? || '-' || printf('%03d', next), ?, ?, ?, ?, ?, ?, ?, ? FROM counters WHERE scope = ?`,
    ).bind(mod.code, mod.code, mod.project_code, p.title, p.spec_url ?? null, p.owner ?? actor.id, priority,
      p.due_at ?? null, now, scope),
  ]);
  const n = (res[1].results[0] as { next: number }).next;
  return { code: `${mod.code}-${String(n).padStart(3, "0")}` };
}

const CREATE_STATUSES = new Set<Status>(["pending_approval", "backlog", "assigned"]);

export interface TaskRequest {
  requested_by?: string | null;
  requested_at?: number | null;
  request_link?: string | null;
}

/** Owner id, approver id, or an active member whose role is pm. */
async function assertRequester(db: D1Database, id: string) {
  if (isPrivilegedId(id)) return;
  const m = await db.prepare("SELECT role FROM members WHERE id = ? AND active = 1").bind(id).first<{ role: string }>();
  if (m?.role === "pm") return;
  throw new AppError("BAD_REQUEST", "requested_by must be a configured owner id, approver id, or an active pm member");
}

/** Missing any of the three request fields forces pending_approval and ignores the requested status. */
async function parseRequest(db: D1Database, p: TaskRequest): Promise<{ requested_by: string | null; requested_at: number | null; request_link: string | null; complete: boolean }> {
  const byRaw = p.requested_by?.trim() || null;
  if (byRaw) await assertRequester(db, byRaw);
  let requested_at: number | null = null;
  if (p.requested_at != null) {
    if (!Number.isInteger(p.requested_at)) throw new AppError("BAD_REQUEST", "requested_at phải là epoch ms");
    requested_at = p.requested_at;
  }
  let request_link: string | null = null;
  if (p.request_link != null && p.request_link.trim() !== "") request_link = validLinks([p.request_link])[0];
  return { requested_by: byRaw, requested_at, request_link, complete: !!(byRaw && requested_at != null && request_link) };
}

/** A complete request uses the backlog rule: assignee does not change status. An explicit status still wins. */
function resolveCreateStatus(actor: Member, requested: Status | undefined, requestComplete: boolean): Status {
  if (!requestComplete) return "pending_approval";
  if (!isAdmin(actor)) {
    if (requested && requested !== "pending_approval") {
      throw new AppError("FORBIDDEN", "member không phải admin chỉ tạo được task ở pending_approval");
    }
    return "pending_approval";
  }
  if (!requested) return "backlog";
  if (!CREATE_STATUSES.has(requested)) {
    throw new AppError("BAD_REQUEST", "create_task chỉ nhận pending_approval, backlog hoặc assigned");
  }
  return requested;
}

export async function createTask(db: D1Database, actor: Member, p: {
  feature: string; title: string; assignee?: string; due_at?: number; status?: Status;
  pr_url?: string | null; links?: string[]; request?: string | null;
} & TaskRequest, now = Date.now()) {
  const f = await db.prepare("SELECT code, project_code FROM features WHERE code = ?").bind(p.feature)
    .first<{ code: string; project_code: string }>();
  if (!f) throw new AppError("NOT_FOUND", `không có feature ${p.feature}`);
  if (p.assignee) await getMember(db, p.assignee);
  const links = validLinks(p.links);
  const pr = explicitPrUrl(p.pr_url) ?? pullLink(links);
  const req = await parseRequest(db, p);
  const status = resolveCreateStatus(actor, p.status, req.complete);
  const note = status === "pending_approval"
    ? (p.assignee ? `tạo task chờ duyệt, đề xuất giao ${p.assignee}` : "tạo task chờ duyệt")
    : (p.assignee ? `giao cho ${p.assignee}` : "tạo task");
  const requestMd = p.request?.trim() ? cleanRequestBody(p.request) : "";
  const scope = `T:${f.code}`;
  const res = await db.batch([
    db.prepare("INSERT OR IGNORE INTO counters (scope, next) VALUES (?, 0)").bind(scope),
    db.prepare("UPDATE counters SET next = next + 1 WHERE scope = ? RETURNING next").bind(scope),
    db.prepare(
      `INSERT INTO tasks (code, feature_code, project_code, title, assignee_id, status, created_by, created_at,
                          assigned_at, last_update_at, due_at, pr_url, requested_by, requested_at, request_link)
       SELECT ? || '.' || next, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM counters WHERE scope = ?`,
    ).bind(f.code, f.code, f.project_code, p.title, p.assignee ?? null, status, actor.id, now,
      status === "assigned" ? now : null, now, p.due_at ?? null, pr,
      req.requested_by, req.requested_at, req.request_link, scope),
    db.prepare(
      `INSERT INTO updates (task_code, member_id, at, status_from, status_to, note, links)
       SELECT ? || '.' || next, ?, ?, NULL, ?, ?, ? FROM counters WHERE scope = ?`,
    ).bind(f.code, actor.id, now, status, note, links.length ? JSON.stringify(links) : null, scope),
    db.prepare(
      `INSERT INTO status_periods (task_code, status, started_at, member_id)
       SELECT ? || '.' || next, ?, ?, ? FROM counters WHERE scope = ?`,
    ).bind(f.code, status, now, actor.id, scope),
    ...(requestMd ? [db.prepare(
      `INSERT INTO request_versions (task_code, version, body, author_id, created_at, note)
       SELECT ? || '.' || next, 1, ?, ?, ?, NULL FROM counters WHERE scope = ?`,
    ).bind(f.code, requestMd, actor.id, now, scope)] : []),
  ]);
  const n = (res[1].results[0] as { next: number }).next;
  const code = `${f.code}.${n}`;
  if (status === "assigned" && p.assignee && p.assignee !== actor.id) {
    await notifyAssigned(db, { code, title: p.title, status }, p.assignee, actor.id, now);
  }
  return { code, status, pr_url: pr, request_version: requestMd ? 1 : null };
}

/**
 * Set pr_url / links without changing status. Assignee or a leader.
 * Omitted pr_url is left as-is unless links contain a /pull/N URL.
 * Empty pr_url clears it.
 */
export async function updateTask(db: D1Database, actor: Member, p: {
  task: string; pr_url?: string | null; links?: string[];
}, now = Date.now()) {
  const t = await getTaskRow(db, p.task);
  if (!canTouchTask(actor, t)) throw new AppError("FORBIDDEN", "chỉ người được giao (hoặc pm/po/lead/admin) được sửa task này");
  const hasPr = p.pr_url !== undefined;
  const hasLinks = p.links !== undefined;
  if (!hasPr && !hasLinks) throw new AppError("BAD_REQUEST", "cần pr_url hoặc links");
  const links = hasLinks ? validLinks(p.links) : null;
  const pr = hasPr ? explicitPrUrl(p.pr_url) : (pullLink(links ?? []) ?? undefined);
  const stmts: D1PreparedStatement[] = [];
  if (pr !== undefined) stmts.push(db.prepare("UPDATE tasks SET pr_url = ? WHERE code = ?").bind(pr, t.code));
  stmts.push(db.prepare(
    `INSERT INTO updates (task_code, member_id, at, status_from, status_to, note, links) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(t.code, actor.id, now, t.status, t.status, pr !== undefined ? "cập nhật pr_url" : "cập nhật links",
    links && links.length ? JSON.stringify(links) : null));
  await db.batch(stmts);
  return { code: t.code, pr_url: pr !== undefined ? pr : t.pr_url };
}

/**
 * Attach or clear the cloud agent working this task. Does not change task status.
 * Omitted fields stay as they are. null or "" clears that field.
 */
export async function setAgent(db: D1Database, actor: Member, p: {
  task: string; agent_url?: string | null; status?: string | null;
}, now = Date.now()) {
  const t = await getTaskRow(db, p.task);
  if (!canSetAgent(actor, t)) {
    throw new AppError("FORBIDDEN", "only the assignee, reviewer, or a leader (pm, po, lead, admin) can set the agent");
  }
  if (p.agent_url === undefined && p.status === undefined) {
    throw new AppError("BAD_REQUEST", "provide agent_url or status");
  }
  const sets: string[] = [];
  const binds: unknown[] = [];
  let agent_url = t.agent_url;
  let agent_status = t.agent_status;
  if (p.agent_url !== undefined) {
    agent_url = explicitHttpsUrl(p.agent_url, "agent_url");
    sets.push("agent_url = ?");
    binds.push(agent_url);
  }
  if (p.status !== undefined) {
    const trimmed = p.status?.trim() ?? "";
    if (trimmed.length > AGENT_STATUS_MAX) throw new AppError("BAD_REQUEST", `status is longer than ${AGENT_STATUS_MAX} characters`);
    agent_status = trimmed || null;
    sets.push("agent_status = ?");
    binds.push(agent_status);
  }
  sets.push("agent_updated_at = ?");
  binds.push(now);
  await db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE code = ?`).bind(...binds, t.code).run();
  return { code: t.code, agent_url, agent_status, agent_updated_at: now };
}

/** Kanban create form. The UI session has no member id; record it as an admin (is_admin). */
export async function createTaskFromUi(db: D1Database, p: Parameters<typeof createTask>[2], now = Date.now()) {
  const actor = await db.prepare(
    "SELECT id, name, role, is_admin FROM members WHERE active = 1 AND is_admin = 1 ORDER BY id LIMIT 1",
  ).first<Member>();
  if (!actor) throw new AppError("BAD_REQUEST", "không có admin để ghi task");
  return createTask(db, actor, p, now);
}

export async function assignTask(db: D1Database, actor: Member, p: { task: string; assignee: string }, now = Date.now()) {
  requireLeader(actor, "assign_task");
  const t = await getTaskRow(db, p.task);
  await getMember(db, p.assignee);
  if (t.status === "done" || t.status === "cancelled") throw new AppError("CONFLICT", `task đã ${t.status}`);
  if (t.status === "pending_approval") {
    throw new AppError("BAD_REQUEST", "task pending_approval phải được admin duyệt (report_status, approved_by là owner hoặc approver đã cấu hình) trước khi giao");
  }
  // Assignee never changes status. A task already in 'assigned' restarts the NOT_STARTED clock.
  const resetClock = t.status === "assigned";
  await db.batch([
    resetClock
      ? db.prepare("UPDATE tasks SET assignee_id = ?, last_update_at = ?, assigned_at = ? WHERE code = ?")
        .bind(p.assignee, now, now, t.code)
      : db.prepare("UPDATE tasks SET assignee_id = ?, last_update_at = ? WHERE code = ?")
        .bind(p.assignee, now, t.code),
    db.prepare(`INSERT INTO updates (task_code, member_id, at, status_from, status_to, note) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(t.code, actor.id, now, t.status, t.status, `giao cho ${p.assignee}`),
    ...(resetClock ? [
      db.prepare("UPDATE alerts SET cleared_at = ? WHERE task_code = ? AND rule = 'NOT_STARTED' AND cleared_at IS NULL").bind(now, t.code),
      ...periodStmts(db, t.code, "assigned", actor.id, now),
    ] : []),
  ]);
  if (p.assignee !== actor.id && (p.assignee !== t.assignee_id || resetClock) && WAKE_ON_ASSIGN.has(t.status)) {
    await notifyAssigned(db, t, p.assignee, actor.id, now);
  }
  return { code: t.code, status: t.status, assignee: p.assignee };
}

/** Statuses where a new assignee has work to pick up. backlog waits for report_status → assigned. */
const WAKE_ON_ASSIGN = new Set<Status>(["assigned", "in_progress", "review", "blocked"]);

async function notifyAssigned(db: D1Database, t: { code: string; title: string; status: Status }, assignee: string, by: string, now: number) {
  await enqueueWebhook(db, {
    member: assignee,
    task: { code: t.code, title: t.title, status: t.status },
    event: "task.assigned",
    text: `${t.code} "${t.title}" is assigned to you (${t.status}) by ${by}.`,
    data: { assigned_by: by },
  }, now);
}

/** Set or clear reviewer_id without a status change. Assignee or a leader. */
export async function setReviewer(db: D1Database, actor: Member, p: { task: string; reviewer: string }, now = Date.now()) {
  const t = await getTaskRow(db, p.task);
  if (!canTouchTask(actor, t)) throw new AppError("FORBIDDEN", "chỉ người được giao (hoặc pm/po/lead/admin) được sửa task này");
  const raw = p.reviewer.trim();
  const reviewer = raw ? (await getMember(db, raw)).id : null;
  await db.batch([
    db.prepare("UPDATE tasks SET reviewer_id = ?, last_update_at = ? WHERE code = ?").bind(reviewer, now, t.code),
    db.prepare("INSERT INTO updates (task_code, member_id, at, status_from, status_to, note) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(t.code, actor.id, now, t.status, t.status, reviewer ? `reviewer ${reviewer}` : "bỏ reviewer"),
  ]);
  return { code: t.code, reviewer_id: reviewer };
}

/** Set or clear due_at (epoch ms). Assignee or a leader. */
export async function setDueAt(db: D1Database, actor: Member, p: { task: string; due_at: number | null }, now = Date.now()) {
  const t = await getTaskRow(db, p.task);
  if (!canTouchTask(actor, t)) throw new AppError("FORBIDDEN", "chỉ người được giao (hoặc pm/po/lead/admin) được sửa task này");
  if (p.due_at != null && (!Number.isInteger(p.due_at) || p.due_at < 0)) throw new AppError("BAD_REQUEST", "due_at must be epoch ms");
  await db.batch([
    db.prepare("UPDATE tasks SET due_at = ?, last_update_at = ? WHERE code = ?").bind(p.due_at, now, t.code),
    db.prepare("INSERT INTO updates (task_code, member_id, at, status_from, status_to, note) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(t.code, actor.id, now, t.status, t.status, p.due_at == null ? "bỏ hạn" : "cập nhật hạn"),
  ]);
  return { code: t.code, due_at: p.due_at };
}

/** Leader edit of a feature's priority. */
export async function setFeaturePriority(db: D1Database, actor: Member, p: { feature: string; priority: string }) {
  requireLeader(actor, "set priority");
  if (!/^P[0-3]$/.test(p.priority)) throw new AppError("BAD_REQUEST", "priority P0..P3");
  const f = await db.prepare("SELECT code, project_code FROM features WHERE code = ?").bind(p.feature).first<{ code: string; project_code: string }>();
  if (!f) throw new AppError("NOT_FOUND", `không có feature '${p.feature}'`);
  await db.prepare("UPDATE features SET priority = ? WHERE code = ?").bind(p.priority, f.code).run();
  return { code: f.code, project_code: f.project_code, priority: p.priority };
}

// ---------- reporting

export async function reportStatus(db: D1Database, actor: Member, p: {
  task: string; status: Status; note?: string; links?: string[]; approved_by?: string; reviewer?: string;
}, now = Date.now()) {
  const t = await getTaskRow(db, p.task);
  if (p.status === "blocked") throw new AppError("BAD_REQUEST", "muốn sang blocked thì dùng set_blocker (ghi rõ chờ ai)");
  // Entering pending_approval on an existing task is pm or admin only. isAdmin covers
  // role admin and is_admin = 1. Everyone else is 403, even the assignee.
  if (p.status === "pending_approval" && actor.role !== "pm" && !isAdmin(actor)) {
    throw new AppError("FORBIDDEN", `chuyển sang pending_approval chỉ pm hoặc admin (bạn: ${actor.role})`);
  }
  let approvedBy: string | null = null;
  if (t.status === "pending_approval") {
    if (!isAdmin(actor)) throw new AppError("FORBIDDEN", "duyệt hoặc từ chối task pending_approval chỉ admin được làm");
    if (p.status !== "backlog" && p.status !== "assigned" && p.status !== "cancelled") {
      throw new AppError("BAD_REQUEST", `không được chuyển pending_approval → ${p.status}`);
    }
    if (!isApprover(p.approved_by)) throw new AppError("BAD_REQUEST", "approved_by must be a configured owner or approver id");
    approvedBy = p.approved_by;
  }
  if (!canTouchTask(actor, t)) throw new AppError("FORBIDDEN", "chỉ người được giao (hoặc pm/po/lead/admin) được báo status task này");
  if (!canTransition(t.status, p.status)) {
    throw new AppError("BAD_REQUEST", `không được chuyển ${t.status} → ${p.status}`);
  }
  const note = clipNote(p.note);
  const links = validLinks(p.links);
  if (p.status === "done" && !note) throw new AppError("BAD_REQUEST", "sang done phải có note kết quả");
  if (t.status === "pending_approval" && p.status === "cancelled" && !note) {
    throw new AppError("BAD_REQUEST", "từ chối pending_approval phải có note");
  }
  const reviewerRaw = p.reviewer?.trim() ?? "";
  const reviewerId = reviewerRaw ? (await getMember(db, reviewerRaw)).id : null;
  if (p.status === "review" && !reviewerId && !t.reviewer_id) {
    throw new AppError("BAD_REQUEST", "sang review phải có reviewer (member id đang active)");
  }
  // From blocked, a move into pending_approval closes open need_approval blockers
  // in the same batch as the status period (same columns as resolveBlocker).
  // Any other open kind is rejected so those blockers stay open.
  let closeNeedApproval = false;
  if (p.status === "pending_approval") {
    const open = await db.prepare(
      "SELECT kind FROM blockers WHERE task_code = ? AND resolved_at IS NULL ORDER BY id",
    ).bind(t.code).all<{ kind: string }>();
    const other = [...new Set(open.results.map((b) => b.kind).filter((k) => k !== "need_approval"))];
    if (other.length) {
      throw new AppError(
        "BAD_REQUEST",
        `không chuyển sang pending_approval khi còn blocker khác need_approval đang mở: ${other.join(", ")}`,
      );
    }
    closeNeedApproval = t.status === "blocked" && open.results.some((b) => b.kind === "need_approval");
  }
  const pr = pullLink(links);
  let requestVersion: number | null = null;
  let outputRef: string | null = null;
  if (p.status === "review") {
    const snap = await reviewSnapshot(db, t.code, links);
    if (snap.attachments.length === 0 && snap.links.length === 0) {
      throw new AppError("BAD_REQUEST", "Moving to review requires an output attachment or an output link.");
    }
    requestVersion = snap.request_version;
    outputRef = outputRefJson(snap);
  }
  await db.batch([
    ...(closeNeedApproval ? [db.prepare(
      `UPDATE blockers SET resolved_at = ?, resolved_by = ?, resolution = 'chuyển sang pending_approval'
       WHERE task_code = ? AND resolved_at IS NULL AND kind = 'need_approval'`,
    ).bind(now, actor.id, t.code)] : []),
    db.prepare(
      `UPDATE tasks SET status = ?, last_update_at = ?,
         assigned_at = CASE WHEN ? = 'assigned' THEN ? ELSE assigned_at END,
         started_at = CASE WHEN ? = 'in_progress' AND started_at IS NULL THEN ? ELSE started_at END,
         done_at = CASE WHEN ? = 'done' THEN ? ELSE done_at END,
         pr_url = COALESCE(?, pr_url),
         reviewer_id = COALESCE(?, reviewer_id)
       WHERE code = ?`,
    ).bind(p.status, now, p.status, now, p.status, now, p.status, now, pr, reviewerId, t.code),
    db.prepare(`INSERT INTO updates (task_code, member_id, at, status_from, status_to, note, links, approved_by, request_version, output_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(t.code, actor.id, now, t.status, p.status, note, links.length ? JSON.stringify(links) : null, approvedBy, requestVersion, outputRef),
    clearStale(db, t.code, now),
    ...periodStmts(db, t.code, p.status, actor.id, now),
  ]);
  await clearResolvedAlerts(db, now, t.code);
  if (p.status === "assigned" && (t.status === "backlog" || t.status === "pending_approval") && t.assignee_id && t.assignee_id !== actor.id) {
    await notifyAssigned(db, { code: t.code, title: t.title, status: "assigned" }, t.assignee_id, actor.id, now);
  }
  return {
    code: t.code, from: t.status, to: p.status, approved_by: approvedBy,
    reviewer_id: reviewerId ?? t.reviewer_id, alerts: await openAlertsFor(db, actor.id),
  };
}

// Progress note without status change (e.g. keeps STALE away).
export async function addNote(db: D1Database, actor: Member, p: { task: string; note: string; links?: string[] }, now = Date.now()) {
  const t = await getTaskRow(db, p.task);
  if (!canTouchTask(actor, t)) throw new AppError("FORBIDDEN", "không phải task của bạn");
  const note = clipNote(p.note);
  if (!note) throw new AppError("BAD_REQUEST", "note trống");
  const links = validLinks(p.links);
  await db.batch([
    db.prepare("UPDATE tasks SET last_update_at = ? WHERE code = ?").bind(now, t.code),
    db.prepare(`INSERT INTO updates (task_code, member_id, at, status_from, status_to, note, links) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(t.code, actor.id, now, t.status, t.status, note, links.length ? JSON.stringify(links) : null),
    clearStale(db, t.code, now),
  ]);
  await clearResolvedAlerts(db, now, t.code);
  return { code: t.code, status: t.status };
}

const BLOCKER_KINDS = ["need_info", "dependency", "access", "bug"];

export async function setBlocker(db: D1Database, actor: Member, p: {
  task: string; kind: string; waiting_on: string; detail: string;
}, now = Date.now()) {
  const t = await getTaskRow(db, p.task);
  if (!canTouchTask(actor, t)) throw new AppError("FORBIDDEN", "không phải task của bạn");
  if (p.kind === "need_approval") {
    throw new AppError("BAD_REQUEST", "need_approval không còn là blocker; hãy tạo task ở status pending_approval để chờ duyệt");
  }
  if (!BLOCKER_KINDS.includes(p.kind)) throw new AppError("BAD_REQUEST", `kind: ${BLOCKER_KINDS.join("/")}`);
  if (t.status === "pending_approval") {
    throw new AppError("BAD_REQUEST", "task pending_approval chưa được duyệt, không gắn blocker");
  }
  if (!["assigned", "in_progress", "blocked"].includes(t.status)) {
    throw new AppError("BAD_REQUEST", `không được chuyển ${t.status} → blocked`);
  }
  if (!isPrivilegedId(p.waiting_on)) await getMember(db, p.waiting_on);
  const detail = clipNote(p.detail);
  if (!detail) throw new AppError("BAD_REQUEST", "detail bắt buộc");
  const res = await db.batch([
    db.prepare(`INSERT INTO blockers (task_code, raised_by, kind, waiting_on, detail, opened_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(t.code, actor.id, p.kind, p.waiting_on, detail, now),
    db.prepare(`UPDATE tasks SET status = 'blocked', last_update_at = ?,
                started_at = COALESCE(started_at, ?) WHERE code = ?`).bind(now, now, t.code),
    db.prepare(`INSERT INTO updates (task_code, member_id, at, status_from, status_to, note) VALUES (?, ?, ?, ?, 'blocked', ?)`)
      .bind(t.code, actor.id, now, t.status, `chờ ${p.waiting_on}: ${detail}`.slice(0, NOTE_MAX)),
    // A second blocker on an already-blocked task keeps the current period.
    ...(t.status === "blocked" ? [] : periodStmts(db, t.code, "blocked", actor.id, now)),
  ]);
  await clearResolvedAlerts(db, now, t.code);
  return { blocker_id: (res[0].results[0] as { id: number }).id, code: t.code, status: "blocked" };
}

export async function resolveBlocker(db: D1Database, actor: Member, p: { id: number; note?: string }, now = Date.now()) {
  const b = await db.prepare("SELECT * FROM blockers WHERE id = ?").bind(p.id)
    .first<{ id: number; task_code: string; resolved_at: number | null }>();
  if (!b) throw new AppError("NOT_FOUND", `không có blocker ${p.id}`);
  if (b.resolved_at) throw new AppError("CONFLICT", "blocker đã đóng");
  const t = await getTaskRow(db, b.task_code);
  if (!canTouchTask(actor, t)) throw new AppError("FORBIDDEN", "không phải task của bạn");
  const note = clipNote(p.note);
  const remaining = await db.prepare("SELECT COUNT(*) AS n FROM blockers WHERE task_code = ? AND resolved_at IS NULL AND id != ?")
    .bind(t.code, b.id).first<{ n: number }>();
  // Only a blocked task moves. A cancelled, done, or otherwise unblocked task keeps its status.
  const left = remaining?.n ?? 0;
  const next: Status = t.status !== "blocked" ? t.status : left > 0 ? "blocked" : "in_progress";
  await db.batch([
    db.prepare("UPDATE blockers SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?").bind(now, actor.id, note, b.id),
    db.prepare("UPDATE tasks SET status = ?, last_update_at = ? WHERE code = ?").bind(next, now, t.code),
    db.prepare(`INSERT INTO updates (task_code, member_id, at, status_from, status_to, note) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(t.code, actor.id, now, t.status, next, note ?? `gỡ blocker #${b.id}`),
    ...(next === t.status ? [] : periodStmts(db, t.code, next, actor.id, now)),
  ]);
  await clearResolvedAlerts(db, now, t.code);
  if (t.status === "blocked" && t.assignee_id && t.assignee_id !== actor.id) {
    const detail = await db.prepare("SELECT kind, waiting_on, detail FROM blockers WHERE id = ?").bind(b.id)
      .first<{ kind: string; waiting_on: string; detail: string }>();
    await enqueueWebhook(db, {
      member: t.assignee_id,
      task: { code: t.code, title: t.title, status: next },
      event: "blocker.resolved",
      text: `Blocker #${b.id} on ${t.code} was resolved by ${actor.id}${note ? `: ${note}` : ""}. ${left > 0 ? `${left} blocker(s) still open.` : `Task is ${next}.`}`,
      data: {
        blocker: { id: b.id, kind: detail?.kind ?? null, waiting_on: detail?.waiting_on ?? null, detail: detail?.detail ?? null, resolution: note, resolved_by: actor.id },
        remaining_blockers: left,
      },
    }, now);
  }
  return { code: t.code, status: next };
}

// ---------- reads

export async function whoami(db: D1Database, m: Member) {
  const open = await db.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND status IN ('assigned','in_progress','review','blocked')",
  ).bind(m.id).first<{ n: number }>();
  const alerts = await openAlertsFor(db, m.id);
  return { id: m.id, name: m.name, role: m.role, admin: isAdmin(m), leader: isLeader(m), open_tasks: open?.n ?? 0, alerts: alerts.length };
}

const OPEN_MINE: Status[] = ["assigned", "in_progress", "review", "blocked"];

export interface ListMyTasksQuery {
  status?: Status | Status[];
  role?: "assignee" | "reviewer" | "any";
  limit?: number;
  offset?: number;
}

function listQuery(arg?: Status | Status[] | ListMyTasksQuery): { statuses: Status[]; role: "assignee" | "reviewer" | "any"; limit: number; offset: number } {
  let status: Status | Status[] | undefined;
  let role: "assignee" | "reviewer" | "any" = "assignee";
  let limit: number | undefined;
  let offset: number | undefined;
  if (Array.isArray(arg)) status = arg;
  else if (typeof arg === "string") status = arg;
  else if (arg) ({ status, role = "assignee", limit, offset } = arg);
  if (role !== "assignee" && role !== "reviewer" && role !== "any") {
    throw new AppError("BAD_REQUEST", "role phải là assignee, reviewer hoặc any");
  }
  const lim = limit ?? 50;
  const off = offset ?? 0;
  if (!Number.isInteger(lim) || lim < 1 || lim > 200) throw new AppError("BAD_REQUEST", "limit từ 1 đến 200");
  if (!Number.isInteger(off) || off < 0) throw new AppError("BAD_REQUEST", "offset phải là số nguyên >= 0");
  const list = status === undefined ? OPEN_MINE : Array.isArray(status) ? status : [status];
  if (list.length === 0) throw new AppError("BAD_REQUEST", "status rỗng");
  for (const s of list) if (!STATUSES.includes(s)) throw new AppError("BAD_REQUEST", `status không hợp lệ: ${s}`);
  return { statuses: list, role, limit: lim, offset: off };
}

/** `status` may be one status or an array. A string/array keeps the old call shape; an object adds role and paging. */
export async function listMyTasks(db: D1Database, m: Member, statusOrQuery?: Status | Status[] | ListMyTasksQuery, now = Date.now()) {
  const q = listQuery(statusOrQuery);
  const who = q.role === "assignee" ? "assignee_id = ?"
    : q.role === "reviewer" ? "reviewer_id = ?"
      : "(assignee_id = ? OR reviewer_id = ?)";
  const unreadFeedback = `(SELECT COUNT(*) FROM feedback f WHERE f.task_code = tasks.code
         AND (f.read_by IS NULL OR f.read_by != tasks.assignee_id))`;
  const sql = `SELECT code, title, status, assignee_id, reviewer_id, assigned_at, last_update_at, due_at,
      agent_url, agent_status, agent_updated_at,
      CASE WHEN assignee_id = ? AND reviewer_id = ? THEN 'both'
           WHEN assignee_id = ? THEN 'assignee' ELSE 'reviewer' END AS role,
      (SELECT p.started_at FROM status_periods p WHERE p.task_code = tasks.code AND p.ended_at IS NULL) AS status_since,
      ${unreadFeedback} AS unread_feedback_count
    FROM tasks WHERE ${who} AND (
      status IN (${q.statuses.map(() => "?").join(",")})
      OR (assignee_id = ? AND ${unreadFeedback} > 0)
    )
    ORDER BY last_update_at DESC, code DESC LIMIT ? OFFSET ?`;
  const binds: unknown[] = [m.id, m.id, m.id];
  binds.push(...(q.role === "any" ? [m.id, m.id] : [m.id]), ...q.statuses, m.id, q.limit, q.offset);
  const { results } = await db.prepare(sql).bind(...binds).all<{
    code: string; title: string; status: Status; assignee_id: string | null; reviewer_id: string | null;
    assigned_at: number | null; last_update_at: number; due_at: number | null;
    agent_url: string | null; agent_status: string | null; agent_updated_at: number | null;
    role: "assignee" | "reviewer" | "both"; status_since: number | null; unread_feedback_count: number;
  }>();
  const tasks = results.map((r) => {
    const since = r.status_since ?? r.last_update_at;
    return { ...r, status_since: since, in_status: formatDuration(now - since), unread_feedback_count: r.unread_feedback_count ?? 0 };
  });
  return { tasks, alerts: await openAlertsFor(db, m.id) };
}

/** Leadership note. `author` must already be taken from the UI session, never from form input. */
export async function addLeadershipFeedback(db: D1Database, p: {
  task: string; author: string; note: string;
}, now = Date.now()) {
  const allowed = new Set(Object.values(getHubConfig().leadershipAuthors));
  if (!p.author || !allowed.has(p.author)) throw new AppError("FORBIDDEN", "only a configured leadership author can add feedback");
  if (!TASK_RE.test(p.task)) throw new AppError("BAD_REQUEST", "mã task không hợp lệ");
  const t = await getTaskRow(db, p.task);
  const note = clipNote(p.note);
  if (!note) throw new AppError("BAD_REQUEST", "note trống");
  const snap = await reviewSnapshot(db, p.task, []);
  await db.batch([
    db.prepare(
      "INSERT INTO feedback (task_code, author, note, at, request_version, output_ref) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(p.task, p.author, note, now, snap.request_version, outputRefJson(snap)),
    db.prepare(`INSERT INTO alerts (task_code, rule, fired_at) VALUES (?, 'LEADERSHIP_FEEDBACK', ?)
                ON CONFLICT (task_code, rule) WHERE cleared_at IS NULL DO NOTHING`).bind(p.task, now),
  ]);
  await enqueueWebhook(db, {
    member: t.assignee_id,
    task: { code: t.code, title: t.title, status: t.status },
    event: "feedback.added",
    text: `Leadership feedback from ${p.author} on ${t.code} "${t.title}": ${note}`,
    data: { feedback: { author: p.author, note, at: now, request_version: snap.request_version } },
  }, now);
  return { code: p.task, author: p.author, at: now, request_version: snap.request_version, output_ref: outputRefJson(snap) };
}

interface FeedbackRow {
  id: number; author: string; note: string; at: number; read_by: string | null;
  request_version: number | null; output_ref: string | null;
}

function parseOutputRef(raw: string | null): OutputRef | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as OutputRef;
    if (!parsed || !Array.isArray(parsed.attachments) || !Array.isArray(parsed.links)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function getTask(db: D1Database, code: string, now = Date.now(), reader?: Pick<Member, "id"> | null) {
  const t = await getTaskRow(db, code);
  const [u, b, a, sp, fb] = await db.batch([
    db.prepare("SELECT member_id, at, status_from, status_to, note, links, approved_by, request_version, output_ref FROM updates WHERE task_code = ? ORDER BY at DESC, id DESC LIMIT 10").bind(code),
    db.prepare("SELECT id, kind, waiting_on, detail, opened_at, resolved_at FROM blockers WHERE task_code = ? ORDER BY opened_at DESC LIMIT 10").bind(code),
    db.prepare("SELECT rule, fired_at FROM alerts WHERE task_code = ? AND cleared_at IS NULL").bind(code),
    db.prepare("SELECT id, status, started_at, ended_at, member_id FROM status_periods WHERE task_code = ? ORDER BY started_at, id").bind(code),
    db.prepare("SELECT id, author, note, at, read_by, request_version, output_ref FROM feedback WHERE task_code = ? ORDER BY at DESC, id DESC LIMIT 20").bind(code),
  ]);
  const rows = fb.results as unknown as FeedbackRow[];
  const unread = (readBy: string | null) => readBy !== t.assignee_id || t.assignee_id === null;
  const feedback = rows.map((r) => ({
    id: r.id, author: r.author, note: r.note, at: r.at, unread: unread(r.read_by),
    request_version: r.request_version ?? null, output_ref: parseOutputRef(r.output_ref),
  }));
  // Only the current assignee's read clears the flag. Return the marker from before that write.
  if (reader && t.assignee_id && reader.id === t.assignee_id && rows.some((r) => unread(r.read_by))) {
    await db.batch([
      db.prepare(
        "UPDATE feedback SET read_at = ?, read_by = ? WHERE task_code = ? AND (read_by IS NULL OR read_by != ?)",
      ).bind(now, reader.id, code, reader.id),
      db.prepare(
        "UPDATE alerts SET cleared_at = ? WHERE task_code = ? AND rule = 'LEADERSHIP_FEEDBACK' AND cleared_at IS NULL",
      ).bind(now, code),
    ]);
  }
  const periods = summarizePeriods(sp.results as unknown as PeriodRow[], now);
  const request = await getRequestDocument(db, code);
  const attachments = await attachmentSummary(db, code);
  const updates = (u.results as Record<string, unknown>[]).map((row) => ({
    ...row,
    output_ref: parseOutputRef(typeof row.output_ref === "string" ? row.output_ref : null),
  }));
  return { task: t, current_status: periods.current, time_in_status: periods.totals, periods: periods.timeline,
    updates, blockers: b.results, alerts: a.results, feedback,
    request: request.version == null ? null : {
      version: request.version, latest: request.latest, author_id: request.author_id, at: request.at,
      note: request.note, markdown: request.markdown,
    },
    attachments };
}

export async function projectOverview(db: D1Database, code: string) {
  const p = await db.prepare("SELECT * FROM projects WHERE code = ?").bind(code).first();
  if (!p) throw new AppError("NOT_FOUND", `không có project ${code}`);
  const [counts, blockers, alerts] = await db.batch([
    db.prepare("SELECT status, COUNT(*) AS n FROM tasks WHERE project_code = ? GROUP BY status").bind(code),
    db.prepare(`SELECT b.id, b.task_code, b.waiting_on, b.detail, b.opened_at FROM blockers b JOIN tasks t ON t.code = b.task_code
                WHERE t.project_code = ? AND b.resolved_at IS NULL ORDER BY b.opened_at LIMIT 20`).bind(code),
    db.prepare(`SELECT a.task_code, a.rule, a.fired_at FROM alerts a JOIN tasks t ON t.code = a.task_code
                WHERE t.project_code = ? AND a.cleared_at IS NULL ORDER BY a.fired_at LIMIT 20`).bind(code),
  ]);
  const byStatus: Record<string, number> = {};
  for (const r of counts.results as { status: string; n: number }[]) byStatus[r.status] = r.n;
  return { project: p, tasks_by_status: byStatus, open_blockers: blockers.results, open_alerts: alerts.results };
}

export async function listAlerts(db: D1Database, actor: Member, scope?: string) {
  requireLeader(actor, "list_alerts");
  const q = scope
    ? db.prepare(`SELECT a.task_code, a.rule, a.fired_at, t.assignee_id FROM alerts a JOIN tasks t ON t.code = a.task_code
                  WHERE a.cleared_at IS NULL AND (t.project_code = ? OR t.assignee_id = ?) ORDER BY a.fired_at LIMIT 50`).bind(scope, scope)
    : db.prepare(`SELECT a.task_code, a.rule, a.fired_at, t.assignee_id FROM alerts a JOIN tasks t ON t.code = a.task_code
                  WHERE a.cleared_at IS NULL ORDER BY a.fired_at LIMIT 50`);
  return { alerts: (await q.all()).results };
}

// ---------- token admin (only hashes ever touch the server)

export async function setTokenHash(db: D1Database, actor: Member, p: { member: string; sha256: string | null }) {
  requireAdmin(actor, "set_token_hash");
  if (p.sha256 !== null && !/^[0-9a-f]{64}$/.test(p.sha256)) throw new AppError("BAD_REQUEST", "sha256 phải là 64 ký tự hex");
  await getMember(db, p.member);
  await db.prepare("UPDATE members SET token_hash = ? WHERE id = ?").bind(p.sha256, p.member).run();
  return { member: p.member, token: p.sha256 ? "set" : "revoked" };
}

// ---------- settings + cron

export interface Settings {
  not_started_minutes: number; stale_hours: number; stale_work_start_hour: number;
  stale_work_end_hour: number; blocked_hours: number; tz_offset_minutes: number;
}

export async function loadSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const s: Record<string, number> = {
    not_started_minutes: 15, stale_hours: 4, stale_work_start_hour: 8, stale_work_end_hour: 22,
    blocked_hours: 2, tz_offset_minutes: 0,
  };
  for (const r of results) if (r.key in s && Number.isFinite(Number(r.value))) s[r.key] = Number(r.value);
  const cfg = getHubConfig();
  if (cfg.notStartedMinutes != null) s.not_started_minutes = cfg.notStartedMinutes;
  if (cfg.staleHours != null) s.stale_hours = cfg.staleHours;
  if (cfg.staleWorkStartHour != null) s.stale_work_start_hour = cfg.staleWorkStartHour;
  if (cfg.staleWorkEndHour != null) s.stale_work_end_hour = cfg.staleWorkEndHour;
  if (cfg.blockedHours != null) s.blocked_hours = cfg.blockedHours;
  if (cfg.tzOffsetMinutes != null) s.tz_offset_minutes = cfg.tzOffsetMinutes;
  return s as unknown as Settings;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Milliseconds between from and to that fall inside [startHour, endHour) local time. */
export function workingMs(from: number, to: number, s: Pick<Settings, "stale_work_start_hour" | "stale_work_end_hour" | "tz_offset_minutes">): number {
  if (to <= from) return 0;
  const off = s.tz_offset_minutes * 60_000;
  const a = from + off, b = to + off; // shift to local "UTC-like" clock
  let total = 0;
  for (let day = Math.floor(a / DAY) * DAY; day < b; day += DAY) {
    const ws = day + s.stale_work_start_hour * HOUR;
    const we = day + s.stale_work_end_hour * HOUR;
    const lo = Math.max(a, ws), hi = Math.min(b, we);
    if (hi > lo) total += hi - lo;
  }
  return total;
}

const clearStale = (db: D1Database, code: string, now: number) =>
  db.prepare("UPDATE alerts SET cleared_at = ? WHERE task_code = ? AND rule = 'STALE' AND cleared_at IS NULL").bind(now, code);

/** Clear open alerts whose condition no longer holds (status changed). */
async function clearResolvedAlerts(db: D1Database, now: number, taskCode?: string) {
  const filter = taskCode ? " AND a.task_code = ?" : "";
  const sql = `UPDATE alerts SET cleared_at = ? WHERE cleared_at IS NULL${taskCode ? " AND task_code = ?" : ""} AND id IN (
    SELECT a.id FROM alerts a JOIN tasks t ON t.code = a.task_code WHERE a.cleared_at IS NULL${filter} AND (
      (a.rule = 'NOT_STARTED' AND t.status != 'assigned') OR
      (a.rule = 'STALE' AND t.status != 'in_progress') OR
      (a.rule = 'BLOCKED_LONG' AND NOT EXISTS (SELECT 1 FROM blockers b WHERE b.task_code = t.code AND b.resolved_at IS NULL)) OR
      (a.rule = 'OVERDUE' AND (t.status IN ('done','cancelled','pending_approval') OR t.due_at IS NULL OR t.due_at > ?))
    ))`;
  const binds: unknown[] = taskCode ? [now, taskCode, taskCode, now] : [now, now];
  await db.prepare(sql).bind(...binds).run();
}

/** Cron job: idempotent. Running it twice yields the same open alerts. */
export async function runChecks(db: D1Database, now = Date.now()) {
  const s = await loadSettings(db);
  await clearResolvedAlerts(db, now);

  const fire = (rule: string, where: string, ...binds: unknown[]) =>
    db.prepare(`INSERT INTO alerts (task_code, rule, fired_at)
                SELECT t.code, '${rule}', ? FROM tasks t WHERE ${where}
                ON CONFLICT (task_code, rule) WHERE cleared_at IS NULL DO NOTHING`).bind(now, ...binds);

  const stmts = [
    fire("NOT_STARTED", "t.status = 'assigned' AND t.assigned_at <= ?", now - s.not_started_minutes * 60_000),
    fire("BLOCKED_LONG", `t.status = 'blocked' AND EXISTS (SELECT 1 FROM blockers b WHERE b.task_code = t.code
          AND b.resolved_at IS NULL AND b.opened_at <= ?)`, now - s.blocked_hours * HOUR),
    fire("OVERDUE", "t.status NOT IN ('done','cancelled','pending_approval') AND t.due_at IS NOT NULL AND t.due_at < ?", now),
  ];

  // STALE counts only working hours, so evaluate in JS over in_progress tasks (bounded set).
  const { results: inProg } = await db.prepare(
    "SELECT code, last_update_at FROM tasks WHERE status = 'in_progress' AND last_update_at <= ?",
  ).bind(now - s.stale_hours * HOUR).all<{ code: string; last_update_at: number }>();
  const staleLimit = s.stale_hours * HOUR;
  const stale: string[] = [];
  const fresh: string[] = [];
  for (const t of inProg) (workingMs(t.last_update_at, now, s) >= staleLimit ? stale : fresh).push(t.code);
  for (const code of stale) {
    stmts.push(db.prepare(`INSERT INTO alerts (task_code, rule, fired_at) VALUES (?, 'STALE', ?)
                           ON CONFLICT (task_code, rule) WHERE cleared_at IS NULL DO NOTHING`).bind(code, now));
  }
  // Also clear STALE for tasks that were updated recently (last_update_at moved forward).
  stmts.push(db.prepare(`UPDATE alerts SET cleared_at = ? WHERE cleared_at IS NULL AND rule = 'STALE' AND task_code IN
    (SELECT code FROM tasks WHERE status = 'in_progress' AND last_update_at > ?)`).bind(now, now - staleLimit));
  // NOT_STARTED reset by reassign is handled in assignTask; BLOCKED_LONG cleared when blockers resolve.
  await db.batch(stmts);

  const open = await db.prepare("SELECT rule, COUNT(*) AS n FROM alerts WHERE cleared_at IS NULL GROUP BY rule").all();
  return { checked_at: now, open: open.results };
}
