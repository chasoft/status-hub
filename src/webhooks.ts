// Outbound webhooks. Each member may register one https URL plus an optional
// header name and secret value (for example a bot's sender key). Events about a
// task go to the task's assignee: leadership feedback, assignment, and a resolved
// blocker. Rows are written to webhook_outbox first, delivered right away through
// ctx.waitUntil, and retried by the five-minute cron. The secret is write-only:
// it is never returned, rendered, or logged.
import { getHubConfig } from "./config";
import { AppError, requireAdmin, type Member } from "./core";

export type WebhookEvent = "feedback.added" | "task.assigned" | "blocker.resolved" | "webhook.test";

export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_MAX_ATTEMPTS = 5;
/** A claimed or failed row waits this long, so the next cron run (every 5 minutes) retries it. */
export const WEBHOOK_RETRY_MS = 4 * 60_000;
const SECRET_MAX = 1024;
const URL_MAX = 500;
const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const RESERVED_HEADERS = new Set([
  "host", "content-type", "content-length", "connection", "transfer-encoding", "cookie", "user-agent",
  "x-status-hub-event", "x-status-hub-delivery",
]);

export interface WebhookOptions {
  /** WEBHOOK_SECRET_KEY. When set, secrets are AES-GCM encrypted in D1. */
  key?: string;
  now?: number;
  limit?: number;
}

// ---------- secret at rest

const enc = new TextEncoder();
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(secretKey: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(secretKey));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** `enc1:<iv>:<ciphertext>` with a key, `raw:<value>` without one. */
export async function sealSecret(value: string, secretKey?: string): Promise<string> {
  const k = secretKey?.trim();
  if (!k) return `raw:${value}`;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(k), enc.encode(value));
  return `enc1:${b64(iv)}:${b64(ct)}`;
}

/** Null when the stored value cannot be read (missing or wrong key). */
export async function openSecret(stored: string, secretKey?: string): Promise<string | null> {
  if (stored.startsWith("raw:")) return stored.slice(4);
  if (!stored.startsWith("enc1:")) return null;
  const k = secretKey?.trim();
  if (!k) return null;
  const [, iv, ct] = stored.split(":");
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(k), unb64(ct));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

// ---------- admin

function webhookUrl(raw: string): string {
  const u = raw.trim();
  let parsed: URL | null = null;
  try { parsed = new URL(u); } catch { parsed = null; }
  if (!parsed || u.length > URL_MAX || parsed.protocol !== "https:") {
    throw new AppError("BAD_REQUEST", "webhook_url must be an https URL");
  }
  if (parsed.username || parsed.password) throw new AppError("BAD_REQUEST", "webhook_url must not contain credentials; use header_name and secret");
  return u;
}

function headerName(raw: string): string {
  const h = raw.trim();
  if (!HEADER_RE.test(h)) throw new AppError("BAD_REQUEST", "header_name must be a valid HTTP header name (1 to 64 characters)");
  if (RESERVED_HEADERS.has(h.toLowerCase())) throw new AppError("BAD_REQUEST", `header_name ${h} is reserved`);
  return h;
}

function secretValue(raw: string): string {
  if (raw.length > SECRET_MAX) throw new AppError("BAD_REQUEST", `secret is longer than ${SECRET_MAX} characters`);
  if (/[\x00-\x1f\x7f]/.test(raw)) throw new AppError("BAD_REQUEST", "secret must not contain control characters");
  return raw;
}

interface WebhookRow {
  id: string;
  webhook_url: string | null;
  webhook_header_name: string | null;
  webhook_secret: string | null;
}

/** Public view of a member's webhook. Never includes the secret. */
export function webhookView(m: WebhookRow) {
  return {
    member: m.id,
    webhook_url: m.webhook_url,
    header_name: m.webhook_header_name,
    secret: m.webhook_secret ? "set" : "none",
  };
}

async function webhookRow(db: D1Database, id: string): Promise<WebhookRow> {
  const m = await db.prepare(
    "SELECT id, webhook_url, webhook_header_name, webhook_secret FROM members WHERE id = ? AND active = 1",
  ).bind(id).first<WebhookRow>();
  if (!m) throw new AppError("NOT_FOUND", `không có member '${id}'`);
  return m;
}

/**
 * Set or clear a member's webhook. Admin only.
 * url: https URL; null or "" clears the URL, header, and secret.
 * header_name, secret: omitted keeps the stored value; "" clears it.
 * A secret needs a header name to travel in.
 */
export async function setMemberWebhook(db: D1Database, actor: Member, p: {
  member: string; url?: string | null; header_name?: string | null; secret?: string | null;
}, opts: WebhookOptions = {}) {
  requireAdmin(actor, "set_member_webhook");
  const cur = await webhookRow(db, p.member);
  if (p.url === undefined && p.header_name === undefined && p.secret === undefined) {
    throw new AppError("BAD_REQUEST", "provide url, header_name, or secret");
  }
  let url = cur.webhook_url;
  let header = cur.webhook_header_name;
  let secret = cur.webhook_secret;
  if (p.url !== undefined) url = p.url == null || p.url.trim() === "" ? null : webhookUrl(p.url);
  if (p.header_name !== undefined) header = p.header_name == null || p.header_name.trim() === "" ? null : headerName(p.header_name);
  if (p.secret !== undefined) secret = p.secret == null || p.secret === "" ? null : await sealSecret(secretValue(p.secret), opts.key);
  if (url === null) {
    header = null;
    secret = null;
  }
  if (secret && !header) throw new AppError("BAD_REQUEST", "header_name is required when a secret is set");
  if (header && !url) throw new AppError("BAD_REQUEST", "set url before header_name");
  const now = opts.now ?? Date.now();
  await db.batch([
    db.prepare("UPDATE members SET webhook_url = ?, webhook_header_name = ?, webhook_secret = ? WHERE id = ?")
      .bind(url, header, secret, cur.id),
    // A new configuration clears the old failure alerts for this member's deliveries.
    db.prepare(`UPDATE alerts SET cleared_at = ? WHERE cleared_at IS NULL AND rule = 'WEBHOOK_FAILED'
                AND task_code IN (SELECT task_code FROM webhook_outbox WHERE member_id = ? AND failed_at IS NOT NULL)`)
      .bind(now, cur.id),
  ]);
  return webhookView({ id: cur.id, webhook_url: url, webhook_header_name: header, webhook_secret: secret });
}

/** Members with a webhook and their delivery counts. Admin only. Never includes secrets. */
export async function listWebhooks(db: D1Database, actor: Member) {
  requireAdmin(actor, "list_webhooks");
  const { results } = await db.prepare(
    `SELECT m.id, m.webhook_url, m.webhook_header_name, m.webhook_secret,
       (SELECT COUNT(*) FROM webhook_outbox o WHERE o.member_id = m.id AND o.delivered_at IS NULL AND o.failed_at IS NULL) AS pending,
       (SELECT COUNT(*) FROM webhook_outbox o WHERE o.member_id = m.id AND o.failed_at IS NOT NULL) AS failed,
       (SELECT MAX(delivered_at) FROM webhook_outbox o WHERE o.member_id = m.id) AS last_delivered_at,
       (SELECT o.last_error FROM webhook_outbox o WHERE o.member_id = m.id AND o.last_error IS NOT NULL ORDER BY o.id DESC LIMIT 1) AS last_error
     FROM members m WHERE m.active = 1 AND m.webhook_url IS NOT NULL ORDER BY m.id`,
  ).all<WebhookRow & { pending: number; failed: number; last_delivered_at: number | null; last_error: string | null }>();
  return {
    webhooks: results.map((r) => ({
      ...webhookView(r), pending: r.pending, failed: r.failed, last_delivered_at: r.last_delivered_at, last_error: r.last_error,
    })),
  };
}

// ---------- events

export interface TaskRef {
  code: string;
  title: string;
  status: string;
}

export function taskUrl(code: string): string | null {
  const host = getHubConfig().uiHost;
  return host ? `https://${host}/t/${encodeURIComponent(code)}` : null;
}

/**
 * Queue one event for a member. No-op (null) when the member has no webhook.
 * The payload is short JSON: type, id, at, member, task, a `text` summary, and event fields.
 */
export async function enqueueWebhook(db: D1Database, p: {
  member: string | null | undefined; task: TaskRef | null; event: WebhookEvent; text: string; data?: Record<string, unknown>;
}, now = Date.now()): Promise<number | null> {
  if (!p.member) return null;
  const m = await db.prepare("SELECT webhook_url FROM members WHERE id = ? AND active = 1 AND webhook_url IS NOT NULL")
    .bind(p.member).first<{ webhook_url: string }>();
  if (!m) return null;
  const payload = {
    type: p.event,
    id: crypto.randomUUID(),
    at: new Date(now).toISOString(),
    member: p.member,
    task: p.task ? { code: p.task.code, title: p.task.title, status: p.task.status, url: taskUrl(p.task.code) } : null,
    text: p.text.slice(0, 1000),
    ...(p.data ?? {}),
  };
  const res = await db.prepare(
    `INSERT INTO webhook_outbox (member_id, task_code, event, payload, created_at, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(p.member, p.task?.code ?? null, p.event, JSON.stringify(payload), now, now).run();
  return (res.results[0] as { id: number } | undefined)?.id ?? null;
}

// ---------- delivery

interface OutboxRow {
  id: number; member_id: string; task_code: string | null; event: string; payload: string; attempts: number;
}

type Attempt = { ok: true; status: number } | { ok: false; status: number | null; error: string };

async function post(url: string, header: string | null, secret: string | null, row: OutboxRow): Promise<Attempt> {
  let id = "";
  try { id = String((JSON.parse(row.payload) as { id?: unknown }).id ?? ""); } catch { id = ""; }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "status-hub-webhook/1",
    "x-status-hub-event": row.event,
    "x-status-hub-delivery": id,
  };
  if (header && secret != null) headers[header] = secret;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: row.payload,
      // A redirect would carry the secret header to another URL. Treat it as a failure.
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    const name = e instanceof Error ? e.name : "error";
    return { ok: false, status: null, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network error" };
  }
}

/** Claim a row: bump attempts and push next_attempt_at so a parallel run skips it. */
async function claim(db: D1Database, id: number, now: number): Promise<OutboxRow | null> {
  return db.prepare(
    `UPDATE webhook_outbox SET attempts = attempts + 1, last_attempt_at = ?, next_attempt_at = ?
     WHERE id = ? AND delivered_at IS NULL AND failed_at IS NULL AND next_attempt_at <= ?
     RETURNING id, member_id, task_code, event, payload, attempts`,
  ).bind(now, now + WEBHOOK_RETRY_MS, id, now).first<OutboxRow>();
}

async function deliverRow(db: D1Database, row: OutboxRow, opts: WebhookOptions, now: number) {
  const m = await db.prepare(
    "SELECT webhook_url, webhook_header_name, webhook_secret FROM members WHERE id = ? AND active = 1",
  ).bind(row.member_id).first<{ webhook_url: string | null; webhook_header_name: string | null; webhook_secret: string | null }>();
  let result: Attempt;
  if (!m?.webhook_url) {
    // The webhook was removed after the event was queued. Drop the row without an alert.
    await db.prepare("UPDATE webhook_outbox SET failed_at = ?, last_error = 'webhook removed' WHERE id = ?").bind(now, row.id).run();
    return { id: row.id, ok: false, dropped: true };
  }
  const secret = m.webhook_secret ? await openSecret(m.webhook_secret, opts.key) : null;
  if (m.webhook_secret && secret == null) result = { ok: false, status: null, error: "secret unreadable (check WEBHOOK_SECRET_KEY)" };
  else result = await post(m.webhook_url, m.webhook_header_name, secret, row);
  console.log(JSON.stringify({
    msg: "webhook", id: row.id, member: row.member_id, event: row.event, attempt: row.attempts,
    ok: result.ok, status: result.status, ...(result.ok ? {} : { error: result.error }),
  }));
  if (result.ok) {
    await db.batch([
      db.prepare("UPDATE webhook_outbox SET delivered_at = ?, last_status = ?, last_error = NULL WHERE id = ?").bind(now, result.status, row.id),
      ...(row.task_code ? [db.prepare(
        "UPDATE alerts SET cleared_at = ? WHERE task_code = ? AND rule = 'WEBHOOK_FAILED' AND cleared_at IS NULL",
      ).bind(now, row.task_code)] : []),
    ]);
    return { id: row.id, ok: true, status: result.status };
  }
  const final = row.attempts >= WEBHOOK_MAX_ATTEMPTS;
  await db.batch([
    db.prepare("UPDATE webhook_outbox SET last_status = ?, last_error = ?, failed_at = ? WHERE id = ?")
      .bind(result.status, result.error, final ? now : null, row.id),
    ...(final && row.task_code ? [db.prepare(
      `INSERT INTO alerts (task_code, rule, fired_at) VALUES (?, 'WEBHOOK_FAILED', ?)
       ON CONFLICT (task_code, rule) WHERE cleared_at IS NULL DO NOTHING`,
    ).bind(row.task_code, now)] : []),
  ]);
  return { id: row.id, ok: false, status: result.status, error: result.error, final };
}

/** Deliver due rows (new ones and retries). Safe to run in parallel: each row is claimed first. */
export async function deliverDueWebhooks(db: D1Database, opts: WebhookOptions = {}) {
  const now = opts.now ?? Date.now();
  const { results } = await db.prepare(
    `SELECT id FROM webhook_outbox WHERE delivered_at IS NULL AND failed_at IS NULL AND next_attempt_at <= ?
     ORDER BY id LIMIT ?`,
  ).bind(now, opts.limit ?? 25).all<{ id: number }>();
  const out: Awaited<ReturnType<typeof deliverRow>>[] = [];
  for (const { id } of results) {
    const row = await claim(db, id, now);
    if (row) out.push(await deliverRow(db, row, opts, now));
  }
  return { delivered: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length, results: out };
}

/** Admin: queue a webhook.test event for a member and deliver it now. */
export async function testMemberWebhook(db: D1Database, actor: Member, p: { member: string }, opts: WebhookOptions = {}) {
  requireAdmin(actor, "test_member_webhook");
  const m = await webhookRow(db, p.member);
  if (!m.webhook_url) throw new AppError("BAD_REQUEST", `member ${m.id} has no webhook`);
  const now = opts.now ?? Date.now();
  const id = await enqueueWebhook(db, {
    member: m.id, task: null, event: "webhook.test", text: `Status Hub test event for ${m.id}.`,
  }, now);
  const row = id == null ? null : await claim(db, id, now);
  if (!row) throw new AppError("CONFLICT", "could not queue the test event");
  const r = await deliverRow(db, row, opts, now);
  // A test is not retried.
  if (!r.ok) await db.prepare("UPDATE webhook_outbox SET failed_at = COALESCE(failed_at, ?) WHERE id = ?").bind(now, row.id).run();
  return { member: m.id, delivery_id: id, ok: r.ok, status: "status" in r ? r.status ?? null : null, error: "error" in r ? r.error : null };
}
