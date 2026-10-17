// Server-rendered HTML UI (no JS framework). Auto-refresh 60s in the browser; no AI tokens.
import { leadershipAuthor } from "./auth";
import { getHubConfig, waitingRank } from "./config";
import { loadSettings, STATUSES, formatDuration, summarizePeriods, type PeriodRow, type Status } from "./core";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function fmt(ms: number | null | undefined, offsetMinutes = 0): string {
  if (!ms) return "—";
  const d = new Date(ms + offsetMinutes * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "—";
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 60) return `${m}'`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, "0")}'`;
  return `${Math.floor(h / 24)}d`;
}

function tzLabel(offsetMinutes: number): string {
  if (!offsetMinutes) return "UTC";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m ? `UTC${sign}${h}:${String(m).padStart(2, "0")}` : `UTC${sign}${h}`;
}

async function clock(db: D1Database): Promise<number> {
  return (await loadSettings(db)).tz_offset_minutes;
}

const STATUS_LABEL: Record<Status, string> = {
  pending_approval: "Pending approval", backlog: "Backlog", assigned: "Assigned", in_progress: "In progress", review: "Review",
  blocked: "Blocked", done: "Done", cancelled: "Cancelled",
};
const BOARD_COLS: Status[] = ["pending_approval", "backlog", "assigned", "in_progress", "review", "blocked", "done"];
const RULE_LABEL: Record<string, string> = {
  NOT_STARTED: "Not started", STALE: "Stale", BLOCKED_LONG: "Blocked too long", OVERDUE: "Overdue",
};

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--bd:#dfe3e8;--tx:#1d2733;--mut:#677788}
*{box-sizing:border-box}body{margin:0;font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--tx)}
header{display:flex;gap:16px;align-items:center;padding:10px 16px;background:#14324a;color:#fff;flex-wrap:wrap}
header a{color:#cfe3f5;text-decoration:none}header b{font-size:16px}
main{padding:12px 16px}a{color:#1565c0}
form.f{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}select,button{padding:4px 8px}
.board{display:grid;grid-template-columns:110px repeat(7,minmax(180px,1fr));gap:6px;overflow-x:auto;min-width:1100px}
.colh{font-weight:600;padding:6px;background:#e9edf2;border-radius:6px;position:sticky;top:0}
.lane{font-weight:700;padding:6px;align-self:start}
.lane small{display:block;font-weight:400;color:var(--mut)}
.cell{background:#eef1f4;border-radius:6px;padding:4px;min-height:40px}
.card{display:block;background:var(--card);border:1px solid var(--bd);border-left:4px solid var(--s);border-radius:6px;padding:6px;margin:4px 0;color:inherit;text-decoration:none}
.card:hover{box-shadow:0 1px 4px #0002}.code{font:12px ui-monospace,monospace;color:var(--mut)}
.meta{display:flex;justify-content:space-between;color:var(--mut);font-size:12px;margin-top:4px}
.badge{display:inline-block;padding:1px 6px;border-radius:9px;font-size:11px;color:#fff;background:var(--s)}
.dur{font-size:11px;color:var(--mut);white-space:nowrap}
.flag{font-size:11px;font-weight:700;color:#c62828}.flag.y{color:#b26a00}
.s-pending_approval{--s:#fb8c00}.s-backlog{--s:#90a4ae}.s-assigned{--s:#5c6bc0}.s-in_progress{--s:#1e88e5}.s-review{--s:#8e24aa}.s-blocked{--s:#e53935}.s-done{--s:#43a047}.s-cancelled{--s:#757575}
.alerts{background:#fff3f3;border:1px solid #f5c2c2;border-radius:6px;padding:8px 12px;margin-bottom:12px}
.lead{background:#fff3f3;box-shadow:inset 3px 0 #b26a00}
table{border-collapse:collapse;width:100%;background:#fff}td,th{border-bottom:1px solid var(--bd);padding:6px;text-align:left;vertical-align:top}
@media (max-width:700px){.board{min-width:900px}}
`;

function page(title: string, body: string, email: string, offsetMinutes: number) {
  const org = getHubConfig().orgName;
  const logout = getHubConfig().authMode === "token"
    ? `<form method="post" action="/logout" style="margin:0"><button type="submit">Log out</button></form>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60"><title>${esc(title)} · Status Hub</title><style>${CSS}</style></head><body>
<header><b>${esc(org)}</b><a href="/">Kanban</a><a href="/new">New task</a><a href="/alerts">Alerts</a><a href="/members">Members</a>
<span style="margin-left:auto;font-size:12px;opacity:.8">${esc(email)} · ${tzLabel(offsetMinutes)} · auto-refresh 60s</span>${logout}</header>
<main>${body}</main></body></html>`;
}

export function renderLogin(error?: string, next?: string): string {
  const org = getHubConfig().orgName;
  const nextField = next ? `<input type="hidden" name="next" value="${esc(next)}">` : "";
  const err = error ? `<p class="flag">${esc(error)}</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Log in · Status Hub</title><style>${CSS}</style></head><body>
<header><b>${esc(org)}</b></header>
<main><h2>Log in</h2>${err}
<form method="post" action="/login">${nextField}
<p><label>Login token<br><input type="password" name="token" autocomplete="current-password" required></label></p>
<button type="submit">Log in</button></form>
<p>Ask an operator for a login token. The token is stored only as a hash.</p>
</main></body></html>`;
}

interface CardRow {
  code: string; title: string; status: Status; project_code: string; feature_code: string; feature_title: string;
  assignee_id: string | null; reviewer_id: string | null; last_update_at: number; alerts: string | null; open_blockers: number; waiting_on: string | null;
  status_since: number | null;
}

function card(c: CardRow, now: number, tz: number) {
  const al = c.alerts ? c.alerts.split(",") : [];
  const flags = [
    ...al.map((r) => `<span class="flag${r === "STALE" ? " y" : ""}">⚠ ${esc(RULE_LABEL[r] ?? r)}</span>`),
    c.open_blockers ? `<span class="flag">⛔ waiting on ${esc(c.waiting_on)}</span>` : "",
  ].filter(Boolean).join(" ");
  const since = c.status_since ?? c.last_update_at;
  return `<a class="card s-${c.status}" href="/t/${encodeURIComponent(c.code)}" title="${esc(c.feature_code)} · ${esc(c.feature_title)}">
<div class="code">${esc(c.code)} <span class="badge">${esc(STATUS_LABEL[c.status])}</span> <span class="dur" title="in this status since ${fmt(since, tz)}">${esc(c.status)} · ${formatDuration(now - since)}</span></div>
<div>${esc(c.title)}</div>${flags ? `<div>${flags}</div>` : ""}
<div class="meta"><span>👤 ${esc(c.assignee_id ?? "unassigned")}${c.reviewer_id ? ` · reviewer ${esc(c.reviewer_id)}` : ""}</span><span title="${fmt(c.last_update_at, tz)}">⟳ ${ago(c.last_update_at, now)}</span></div></a>`;
}

const DONE_PREVIEW = 10;

function scope(project: string, member: string, where: string[], binds: unknown[]) {
  if (project) { where.push("t.project_code = ?"); binds.push(project); }
  if (member) { where.push("t.assignee_id = ?"); binds.push(member); }
}

function querySuffix(project: string, member: string): string {
  const q = new URLSearchParams();
  if (project) q.set("project", project);
  if (member) q.set("member", member);
  const s = q.toString();
  return s ? `?${s}` : "";
}

const CARD_SQL = `
SELECT t.code, t.title, t.status, t.project_code, t.feature_code, f.title AS feature_title, t.assignee_id, t.reviewer_id, t.last_update_at,
  (SELECT group_concat(a.rule) FROM alerts a WHERE a.task_code = t.code AND a.cleared_at IS NULL) AS alerts,
  (SELECT COUNT(*) FROM blockers b WHERE b.task_code = t.code AND b.resolved_at IS NULL) AS open_blockers,
  (SELECT b.waiting_on FROM blockers b WHERE b.task_code = t.code AND b.resolved_at IS NULL ORDER BY b.opened_at LIMIT 1) AS waiting_on,
  (SELECT p.started_at FROM status_periods p WHERE p.task_code = t.code AND p.ended_at IS NULL) AS status_since
FROM tasks t JOIN features f ON f.code = t.feature_code`;

export async function renderBoard(db: D1Database, url: URL, email: string, now = Date.now()) {
  const project = url.searchParams.get("project") || "";
  const member = url.searchParams.get("member") || "";
  const statusF = (url.searchParams.get("status") || "") as Status | "";
  const where: string[] = ["t.status != 'done'"];
  const binds: unknown[] = [];
  scope(project, member, where, binds);
  if (statusF && STATUSES.includes(statusF)) { where.push("t.status = ?"); binds.push(statusF); }
  const doneWhere = ["t.status = 'done'"];
  const doneBinds: unknown[] = [];
  scope(project, member, doneWhere, doneBinds);
  const showDone = !statusF || statusF === "done";
  const [cards, projects, members, alertCount, doneCards, doneCount] = await db.batch([
    db.prepare(`${CARD_SQL} WHERE ${where.join(" AND ")} ORDER BY t.last_update_at DESC LIMIT 1000`).bind(...binds),
    db.prepare("SELECT code, name FROM projects WHERE status != 'archived' ORDER BY code"),
    db.prepare("SELECT id, name FROM members WHERE active = 1 ORDER BY id"),
    db.prepare("SELECT rule, COUNT(*) AS n FROM alerts WHERE cleared_at IS NULL GROUP BY rule"),
    db.prepare(`${CARD_SQL} WHERE ${doneWhere.join(" AND ")} ORDER BY t.done_at DESC, t.code DESC LIMIT ?`).bind(...doneBinds, DONE_PREVIEW),
    db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${doneWhere.join(" AND ")}`).bind(...doneBinds),
  ]);
  const tz = await clock(db);
  const rows = cards.results as unknown as CardRow[];
  if (showDone) rows.push(...(doneCards.results as unknown as CardRow[]));
  const doneTotal = Number((doneCount.results[0] as { n: number }).n);
  const projs = (projects.results as { code: string; name: string }[]).filter((p) => !project || p.code === project);
  const cols = statusF && statusF !== "cancelled" ? [statusF] : BOARD_COLS;
  const opt = (v: string, cur: string, label = v) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;

  const filters = `<form class="f" method="get">
<select name="project"><option value="">All projects</option>${(projects.results as any[]).map((p) => opt(p.code, project, `${p.code} · ${p.name}`)).join("")}</select>
<select name="member"><option value="">All members</option>${(members.results as any[]).map((m) => opt(m.id, member, m.name)).join("")}</select>
<select name="status"><option value="">All statuses</option>${STATUSES.map((s) => opt(s, statusF, STATUS_LABEL[s])).join("")}</select>
<button>Filter</button><a href="/?status=pending_approval${project ? `&amp;project=${esc(project)}` : ""}">Pending approval</a> <a href="/">Clear</a></form>`;

  const ac = alertCount.results as { rule: string; n: number }[];
  const alertBar = ac.length
    ? `<div class="alerts"><b>Open alerts:</b> ${ac.map((a) => `${esc(RULE_LABEL[a.rule] ?? a.rule)}: <b>${a.n}</b>`).join(" · ")} — <a href="/alerts">view</a></div>`
    : "";

  const doneHref = `/done${querySuffix(project, member)}`;
  const grid = `<div class="board" style="grid-template-columns:110px repeat(${cols.length},minmax(180px,1fr))">
<div></div>${cols.map((s) => `<div class="colh s-${s}"><span class="badge">${esc(STATUS_LABEL[s])}</span> ${rows.filter((r) => r.status === s).length}${s === "done" ? ` <a href="${esc(doneHref)}">See all (${doneTotal})</a>` : ""}</div>`).join("")}
${projs.map((p) => {
    const pr = rows.filter((r) => r.project_code === p.code);
    return `<div class="lane"><a href="/p/${esc(p.code)}">${esc(p.code)}</a><small>${esc(p.name)}</small></div>` +
      cols.map((s) => `<div class="cell">${pr.filter((r) => r.status === s).map((r) => card(r, now, tz)).join("")}</div>`).join("");
  }).join("")}</div>`;

  const cancelled = rows.filter((r) => r.status === "cancelled" && (!project || r.project_code === project));
  const cancelledBox = !statusF || statusF === "cancelled"
    ? `<details style="margin-top:12px"${statusF === "cancelled" ? " open" : ""}><summary>Cancelled (${cancelled.length})</summary>${cancelled.map((r) => card(r, now, tz)).join("")}</details>`
    : "";
  return page("Kanban", alertBar + filters + grid + cancelledBox, email, tz);
}

export async function renderNewTask(db: D1Database, email: string) {
  const cfg = getHubConfig();
  const pms = await db.prepare("SELECT id FROM members WHERE active = 1 AND role = 'pm' ORDER BY id").all<{ id: string }>();
  const requesters = [...new Set([...cfg.ownerIds, ...cfg.approverIds, ...pms.results.map((m) => m.id)])];
  const tz = await clock(db);
  return page("New task", `<h2>New task</h2>
<form method="post" action="/new">
<p><label>Feature<br><input name="feature" required placeholder="PRJ-CORE-001"></label></p>
<p><label>Title<br><input name="title" required minlength="3"></label></p>
<p><label>Assignee<br><input name="assignee" placeholder="member id"></label></p>
<p><label>Status<br><select name="status"><option value="">default</option><option>pending_approval</option><option>backlog</option><option>assigned</option></select></label></p>
<p><label>Requested by<br><select name="requested_by"><option value=""></option>${requesters.map((id) => `<option>${esc(id)}</option>`).join("")}</select></label></p>
<p><label>Requested at (epoch ms)<br><input name="requested_at" inputmode="numeric"></label></p>
<p><label>Request link<br><input name="request_link" type="url" placeholder="https://"></label></p>
<button>Create</button></form>
<p>If requester, time, or link is missing, the task stays in Pending approval. An assignee does not change status by itself.</p>`, email, tz);
}

export async function renderDone(db: D1Database, url: URL, email: string, now = Date.now()) {
  const project = url.searchParams.get("project") || "";
  const member = url.searchParams.get("member") || "";
  const where = ["t.status = 'done'"];
  const binds: unknown[] = [];
  scope(project, member, where, binds);
  const { results } = await db.prepare(
    `${CARD_SQL} WHERE ${where.join(" AND ")} ORDER BY t.done_at DESC, t.code DESC`,
  ).bind(...binds).all<CardRow>();
  const tz = await clock(db);
  const back = `/${querySuffix(project, member)}`;
  const title = project ? `Done · ${project}` : "Done";
  return page("Done", `<p><a href="${esc(back)}">← Kanban</a></p><h2>${esc(title)} (${results.length})</h2>
${results.map((c) => card(c, now, tz)).join("") || "<p>No done tasks.</p>"}`, email, tz);
}

export async function renderTask(db: D1Database, code: string, email: string, now = Date.now(), notice?: { error?: string; pr_url?: string }) {
  const t = await db.prepare(`${CARD_SQL} WHERE t.code = ?`).bind(code).first<CardRow>();
  if (!t) return null;
  const full = await db.prepare("SELECT * FROM tasks WHERE code = ?").bind(code).first<any>();
  const [u, b, sp, fb] = await db.batch([
    db.prepare("SELECT * FROM updates WHERE task_code = ? ORDER BY at DESC, id DESC LIMIT 100").bind(code),
    db.prepare("SELECT * FROM blockers WHERE task_code = ? ORDER BY opened_at DESC").bind(code),
    db.prepare("SELECT id, status, started_at, ended_at, member_id FROM status_periods WHERE task_code = ? ORDER BY started_at, id").bind(code),
    db.prepare("SELECT id, author, note, at FROM feedback WHERE task_code = ? ORDER BY at DESC, id DESC LIMIT 100").bind(code),
  ]);
  const tz = await clock(db);
  const per = summarizePeriods(sp.results as unknown as PeriodRow[], now);
  const badge = (st: Status) => `<span class="s-${st}"><span class="badge">${esc(STATUS_LABEL[st] ?? st)}</span></span>`;
  const timeline = `<h3>Time in status</h3>
<table class="periods"><tr><th>Status</th><th>Started</th><th>Ended</th><th>Duration</th><th>By</th></tr>
${per.timeline.map((p) => `<tr><td>${badge(p.status)}</td><td>${fmt(p.started_at, tz)}</td><td>${p.open ? "<i>current</i>" : fmt(p.ended_at, tz)}</td><td>${p.duration}</td><td>${esc(p.member_id ?? "")}</td></tr>`).join("") || "<tr><td colspan=5>—</td></tr>"}
</table>
<table class="totals" style="margin-top:6px"><tr><th>Totals by status</th>${STATUSES.filter((st) => per.totals[st]).map((st) => `<th>${badge(st)}</th>`).join("")}</tr>
<tr><td></td>${STATUSES.filter((st) => per.totals[st]).map((st) => `<td>${per.totals[st].duration}${per.totals[st].periods > 1 ? ` <small>(${per.totals[st].periods} times)</small>` : ""}</td>`).join("")}</tr></table>`;
  const links = (j: string | null) => (j ? (JSON.parse(j) as string[]).map((l) => `<a href="${esc(l)}" rel="noopener">${esc(l)}</a>`).join("<br>") : "");
  const history = [
    ...(u.results as any[]).map((x) => ({ at: x.at as number, id: x.id as number, who: String(x.member_id), status: `${x.status_from ?? ""} → ${x.status_to ?? ""}`, note: `${esc(x.note)}${x.approved_by ? ` · approved by ${esc(x.approved_by)}` : ""}<br>${links(x.links)}`, lead: false })),
    ...(fb.results as any[]).map((x) => ({ at: x.at as number, id: x.id as number, who: String(x.author), status: "leadership feedback", note: esc(x.note), lead: true })),
  ].sort((a, b) => b.at - a.at || b.id - a.id);
  const author = leadershipAuthor(email);
  const feedbackForm = author ? `<h3>Leadership feedback</h3>
<form method="post" action="/t/${esc(code)}/feedback"><textarea name="note" maxlength="500" required rows="3" style="width:100%;max-width:640px"></textarea>
<div><button>Send</button></div></form>` : "";
  const reqCell = (v: unknown) => (v ? esc(v) : "Not set");
  const reqLink = full.request_link
    ? `<a href="${esc(full.request_link)}">${esc(full.request_link)}</a>`
    : "Not set";
  return page(code, `<p><a href="/?project=${esc(t.project_code)}">← ${esc(t.project_code)}</a></p>
<table><tr><th>Requested by</th><td>${reqCell(full.requested_by)}</td></tr>
<tr><th>Requested at</th><td>${full.requested_at ? fmt(full.requested_at, tz) : "Not set"}</td></tr>
<tr><th>Request link</th><td>${reqLink}</td></tr></table>
${card(t, now, tz)}
<table><tr><th>Feature</th><td>${esc(t.feature_code)} · ${esc(t.feature_title)}</td></tr>
<tr><th>Reviewer</th><td>${full.reviewer_id ? esc(full.reviewer_id) : "—"}</td></tr>
<tr><th>Assigned at</th><td>${fmt(full.assigned_at, tz)}</td></tr><tr><th>Started</th><td>${fmt(full.started_at, tz)}</td></tr>
<tr><th>Due</th><td>${fmt(full.due_at, tz)}</td></tr><tr><th>Done at</th><td>${fmt(full.done_at, tz)}</td></tr>
<tr><th>PR</th><td>${full.pr_url ? `<a href="${esc(full.pr_url)}">${esc(full.pr_url)}</a>` : "—"}
<form method="post" action="/t/${encodeURIComponent(code)}" class="f" style="margin:6px 0 0">
<label>PR URL <input name="pr_url" value="${esc(notice?.pr_url ?? full.pr_url ?? "")}" size="52" placeholder="https://"></label>
<button type="submit">Save</button></form>
${notice?.error ? `<p class="flag">${esc(notice.error)}</p>` : ""}</td></tr></table>
${timeline}
<h3>Blockers</h3><table><tr><th>#</th><th>Kind</th><th>Waiting on</th><th>Detail</th><th>Opened</th><th>Closed</th></tr>
${(b.results as any[]).map((x) => `<tr><td>${x.id}</td><td>${esc(x.kind)}</td><td>${esc(x.waiting_on)}</td><td>${esc(x.detail)}</td><td>${fmt(x.opened_at, tz)}</td><td>${fmt(x.resolved_at, tz)}</td></tr>`).join("")}</table>
${feedbackForm}
<h3>History</h3><table><tr><th>When</th><th>Who</th><th>Status</th><th>Note</th></tr>
${history.map((x) => `<tr${x.lead ? ' class="lead"' : ""}><td>${fmt(x.at, tz)}</td><td>${esc(x.who)}</td><td>${esc(x.status)}</td><td>${x.note}</td></tr>`).join("")}</table>`, email, tz);
}

export async function renderProject(db: D1Database, code: string, email: string) {
  const p = await db.prepare("SELECT * FROM projects WHERE code = ?").bind(code).first<any>();
  if (!p) return null;
  const [mods, feats] = await db.batch([
    db.prepare("SELECT * FROM modules WHERE project_code = ? ORDER BY code").bind(code),
    db.prepare(`SELECT f.code, f.module_code, f.title, f.priority, f.owner_id,
      (SELECT COUNT(*) FROM tasks t WHERE t.feature_code = f.code AND t.status != 'cancelled') AS total,
      (SELECT COUNT(*) FROM tasks t WHERE t.feature_code = f.code AND t.status = 'done') AS done
      FROM features f WHERE f.project_code = ? ORDER BY f.code`).bind(code),
  ]);
  const fs = feats.results as any[];
  const tz = await clock(db);
  return page(code, `<h2>${esc(p.code)} · ${esc(p.name)}</h2><p>Owner: ${esc(p.owner_id)} ${p.repo_url ? `· <a href="${esc(p.repo_url)}">repo</a>` : ""} · <a href="/?project=${esc(code)}">Kanban</a></p>
${(mods.results as any[]).map((m) => `<h3>${esc(m.code)} · ${esc(m.name)}</h3><table><tr><th>Feature</th><th>Priority</th><th>Owner</th><th>Progress</th></tr>
${fs.filter((f) => f.module_code === m.code).map((f) => `<tr><td><a href="/?project=${esc(code)}">${esc(f.code)}</a> ${esc(f.title)}</td><td>${esc(f.priority)}</td><td>${esc(f.owner_id)}</td><td>${f.total ? Math.round((100 * f.done) / f.total) : 0}% (${f.done}/${f.total})</td></tr>`).join("") || "<tr><td colspan=4>—</td></tr>"}</table>`).join("")}`, email, tz);
}

export async function renderAlerts(db: D1Database, email: string, now = Date.now()) {
  const tz = await clock(db);
  const cfg = getHubConfig();
  const [a, b] = await db.batch([
    db.prepare(`SELECT a.rule, a.fired_at, t.code, t.title, t.assignee_id, t.assigned_at, t.last_update_at FROM alerts a
      JOIN tasks t ON t.code = a.task_code WHERE a.cleared_at IS NULL ORDER BY a.rule, a.fired_at`),
    db.prepare(`SELECT b.*, t.title FROM blockers b JOIN tasks t ON t.code = b.task_code WHERE b.resolved_at IS NULL ORDER BY b.opened_at`),
  ]);
  const blockers = (b.results as any[]).slice().sort((x, y) => {
    const rank = waitingRank(String(x.waiting_on), cfg) - waitingRank(String(y.waiting_on), cfg);
    return rank || Number(x.opened_at) - Number(y.opened_at);
  });
  return page("Alerts", `<h2>Open blockers</h2><table><tr><th>Task</th><th>Waiting on</th><th>Detail</th><th>Opened</th></tr>
${blockers.map((x) => `<tr><td><a href="/t/${esc(x.task_code)}">${esc(x.task_code)}</a> ${esc(x.title)}</td><td><b>${esc(x.waiting_on)}</b></td><td>${esc(x.detail)}</td><td>${fmt(x.opened_at, tz)} (${ago(x.opened_at, now)})</td></tr>`).join("")}</table>
<h2>Alerts</h2><table><tr><th>Rule</th><th>Task</th><th>Member</th><th>Assigned</th><th>Last update</th></tr>
${(a.results as any[]).map((x) => `<tr><td>${esc(RULE_LABEL[x.rule] ?? x.rule)}</td><td><a href="/t/${esc(x.code)}">${esc(x.code)}</a> ${esc(x.title)}</td><td><a href="/m/${esc(x.assignee_id)}">${esc(x.assignee_id)}</a></td><td>${fmt(x.assigned_at, tz)} (${ago(x.assigned_at, now)})</td><td>${fmt(x.last_update_at, tz)}</td></tr>`).join("")}</table>`, email, tz);
}

export async function renderMembers(db: D1Database, email: string) {
  const { results } = await db.prepare(`SELECT m.id, m.name, m.role, m.is_admin, (m.token_hash IS NOT NULL) AS has_token,
    (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = m.id AND t.status IN ('assigned','in_progress','review','blocked')) AS open,
    (SELECT COUNT(*) FROM alerts a JOIN tasks t ON t.code = a.task_code WHERE t.assignee_id = m.id AND a.cleared_at IS NULL) AS alerts
    FROM members m WHERE m.active = 1 ORDER BY m.is_admin DESC, m.id`).all<any>();
  const tz = await clock(db);
  return page("Members", `<table><tr><th>Member</th><th>Role</th><th>Token</th><th>Open tasks</th><th>Alerts</th></tr>
${results.map((m) => `<tr><td><a href="/m/${esc(m.id)}">${esc(m.name)}</a></td><td>${esc(m.role)}${m.is_admin ? " · admin" : ""}</td><td>${m.has_token ? "yes" : "none"}</td><td>${m.open}</td><td>${m.alerts}</td></tr>`).join("")}</table>`, email, tz);
}

export async function renderMember(db: D1Database, id: string, email: string, now = Date.now()) {
  const m = await db.prepare("SELECT * FROM members WHERE id = ?").bind(id).first<any>();
  if (!m) return null;
  const [cards, ups, ns] = await db.batch([
    db.prepare(`${CARD_SQL} WHERE t.assignee_id = ? AND t.status IN ('assigned','in_progress','review','blocked') ORDER BY t.last_update_at DESC`).bind(id),
    db.prepare("SELECT * FROM updates WHERE member_id = ? ORDER BY at DESC LIMIT 30").bind(id),
    db.prepare(`SELECT COUNT(*) AS n FROM alerts a JOIN tasks t ON t.code = a.task_code WHERE a.rule = 'NOT_STARTED' AND t.assignee_id = ? AND a.fired_at >= ?`).bind(id, now - 7 * 86_400_000),
  ]);
  const tz = await clock(db);
  return page(m.name, `<h2>${esc(m.name)} <small>(${esc(m.role)})</small></h2><p>Not-started alerts in the last 7 days: <b>${(ns.results[0] as any).n}</b></p>
${(cards.results as any[]).map((c) => card(c, now, tz)).join("") || "<p>No open tasks.</p>"}
<h3>Timeline</h3><table>${(ups.results as any[]).map((x) => `<tr><td>${fmt(x.at, tz)}</td><td><a href="/t/${esc(x.task_code)}">${esc(x.task_code)}</a></td><td>${esc(x.status_from ?? "")} → ${esc(x.status_to ?? "")}</td><td>${esc(x.note)}</td></tr>`).join("")}</table>`, email, tz);
}
