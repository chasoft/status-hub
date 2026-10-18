import { createMcpHandler } from "agents/mcp/server";
import {
  authenticateBearer, authenticateLoginToken, clearSessionCookie, leadershipAuthor, memberForAccessEmail,
  openSession, resolveAuthMode, revokeSession, sessionEmail, sessionSecret, sessionTtlSeconds, verifyAccessJwt,
  type AuthEnv,
} from "./auth";
import {
  attachmentPolicy, contentDisposition, finishAttachmentUpload, getAttachmentObject, isImageMime, readCapped,
  addAttachmentBytes,
} from "./attachments";
import { configFromEnv, useHubConfig, type ConfigEnv } from "./config";
import { addLeadershipFeedback, addOutputLink, AppError, assignTask, createTaskFromUi, loadSettings, runChecks, setDueAt, setFeaturePriority, setRequestDocument, setReviewer, updateTask, type Status } from "./core";
import { DASHBOARD_JS } from "./dashboard-client";
import { renderMarkdown } from "./markdown";
import { createServer } from "./mcp";
import * as ui from "./ui";

export interface Env extends AuthEnv, ConfigEnv {
  DB: D1Database;
  UI_HOST: string;
  MCP_HOST: string;
  /** Optional. When unset, file attachments are hidden and MCP add_attachment errors. */
  ATTACHMENTS?: R2Bucket;
  ATTACHMENT_MAX_BYTES?: string;
  ATTACHMENT_ALLOWED_MIME?: string;
}

const SEC_HEADERS = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const text = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SEC_HEADERS } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SEC_HEADERS },
});

/**
 * CSRF guard for UI form POSTs. Browsers send Sec-Fetch-Site on every request and
 * scripts cannot set it, so it decides when present. Our pages use
 * Referrer-Policy: no-referrer, which makes Chrome send `Origin: null` even on a
 * same-origin form POST, so Origin alone cannot be the test. Without
 * Sec-Fetch-Site, fall back to Origin: absent passes (non-browser client),
 * anything else must parse to UI_HOST ("null" is rejected).
 */
function isSameOriginPost(req: Request, env: Env): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === env.UI_HOST; } catch { return false; }
}

function wantsJson(req: Request): boolean {
  return (req.headers.get("accept") || "").includes("application/json");
}

/** datetime-local is the wall clock in the deployment offset. Empty stays empty. */
function parseDueInput(raw: string, offsetMinutes: number): number | null {
  const value = raw.trim();
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new AppError("BAD_REQUEST", "due date must be a date and time");
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  if (!Number.isFinite(utc)) throw new AppError("BAD_REQUEST", "due date must be a date and time");
  return utc - offsetMinutes * 60_000;
}

async function postTaskEdit(req: Request, env: Env, code: string, email: string): Promise<Response> {
  if (!isSameOriginPost(req, env)) return text(403, "Forbidden");
  const actor = await memberForAccessEmail(env.DB, email);
  if (!actor) return text(403, "Forbidden");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return text(400, "Bad request");
  }
  const jsonMode = wantsJson(req);
  const field = form.has("request_body") ? "request_body" : form.has("assignee") ? "assignee" : form.has("reviewer") ? "reviewer" : form.has("due_at") ? "due_at" : form.has("links") ? "links" : "pr_url";
  const raw = String(form.get(field) ?? "");
  try {
    if (field === "assignee") {
      if (!raw.trim()) throw new AppError("BAD_REQUEST", "assignee is required");
      await assignTask(env.DB, actor, { task: code, assignee: raw.trim() });
    } else if (field === "reviewer") {
      await setReviewer(env.DB, actor, { task: code, reviewer: raw });
    } else if (field === "due_at") {
      const tz = (await loadSettings(env.DB)).tz_offset_minutes;
      await setDueAt(env.DB, actor, { task: code, due_at: parseDueInput(raw, tz) });
    } else if (field === "links") {
      const links = raw.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
      await updateTask(env.DB, actor, { task: code, links });
    } else if (form.has("request_body")) {
      await setRequestDocument(env.DB, actor, { task: code, markdown: raw, note: String(form.get("request_note") ?? "") });
    } else {
      await updateTask(env.DB, actor, { task: code, pr_url: raw });
    }
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    if (jsonMode) return json({ error: e.message }, e.httpStatus);
    if (e.code === "NOT_FOUND") return text(404, e.message);
    if (e.code === "FORBIDDEN") return text(403, e.message);
    const page = await ui.renderTask(env.DB, code, email, Date.now(), { error: e.message, field, value: raw, pr_url: field === "pr_url" ? raw : undefined }, null, !!env.ATTACHMENTS);
    return page ? html(page, e.httpStatus) : text(404, "Not found");
  }
  if (jsonMode) return json({ ok: true });
  return new Response(null, { status: 303, headers: { location: `/t/${encodeURIComponent(code)}`, ...SEC_HEADERS } });
}

async function postFeaturePriority(req: Request, env: Env, code: string, email: string): Promise<Response> {
  if (!isSameOriginPost(req, env)) return text(403, "Forbidden");
  const actor = await memberForAccessEmail(env.DB, email);
  if (!actor) return text(403, "Forbidden");
  let priority = "";
  try {
    priority = String((await req.formData()).get("priority") ?? "");
    const saved = await setFeaturePriority(env.DB, actor, { feature: code, priority });
    if (wantsJson(req)) return json({ ok: true });
    return new Response(null, { status: 303, headers: { location: `/p/${encodeURIComponent(saved.project_code)}`, ...SEC_HEADERS } });
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    if (wantsJson(req)) return json({ error: e.message }, e.httpStatus);
    return text(e.httpStatus, e.message);
  }
}

async function handleMcp(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const me = await authenticateBearer(env.DB, req.headers.get("authorization"));
  if (!me) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="status-hub"' },
    });
  }
  const handler = createMcpHandler(() => createServer(env.DB, me, { bucket: env.ATTACHMENTS, env }), {
    route: "/mcp",
    allowedHostnames: [env.MCP_HOST],
    corsOptions: false,
  } as any);
  return handler(req, env, ctx);
}

async function postFeedback(env: Env, code: string, email: string, req: Request): Promise<Response> {
  if (!isSameOriginPost(req, env)) return text(403, "Forbidden");
  const author = leadershipAuthor(email);
  if (!author) return text(403, "Forbidden");
  let note = "";
  try {
    note = String((await req.formData()).get("note") ?? "");
  } catch {
    return text(400, "Bad request");
  }
  try {
    await addLeadershipFeedback(env.DB, { task: code, author, note });
  } catch (e) {
    if (e instanceof AppError) return text(e.httpStatus, e.message);
    throw e;
  }
  return new Response(null, { status: 303, headers: { location: `/t/${encodeURIComponent(code)}`, ...SEC_HEADERS } });
}

async function postRequestPreview(req: Request, env: Env, _code: string): Promise<Response> {
  if (!isSameOriginPost(req, env)) return text(403, "Forbidden");
  let body = "";
  try {
    body = String((await req.formData()).get("body") ?? "");
  } catch {
    return text(400, "Bad request");
  }
  if (body.length > 50_000) return json({ error: "request markdown is longer than 50000 characters" }, 400);
  return json({ html: renderMarkdown(body) });
}

async function postAttachment(req: Request, env: Env, code: string, email: string): Promise<Response> {
  if (!isSameOriginPost(req, env)) return text(403, "Forbidden");
  const actor = await memberForAccessEmail(env.DB, email);
  if (!actor) return text(403, "Forbidden");
  let form: FormData;
  try { form = await req.formData(); } catch { return text(400, "Bad request"); }
  const file = form.get("file");
  if (!(file instanceof File)) return text(400, "file is required");
  const policy = attachmentPolicy(env);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || String(form.get("mime") ?? "");
  try {
    await addAttachmentBytes(env.DB, env.ATTACHMENTS, actor, {
      task: code,
      group: String(form.get("group") ?? ""),
      name: String(form.get("name") ?? file.name),
      mime,
      note: String(form.get("note") ?? ""),
      bytes,
    }, policy);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    const page = await ui.renderTask(env.DB, code, email, Date.now(), { error: e.message, field: "attachment" }, "overview", !!env.ATTACHMENTS);
    return page ? html(page, e.httpStatus) : text(e.httpStatus, e.message);
  }
  return new Response(null, { status: 303, headers: { location: `/t/${encodeURIComponent(code)}?tab=overview`, ...SEC_HEADERS } });
}

async function postOutputLink(req: Request, env: Env, code: string, email: string): Promise<Response> {
  if (!isSameOriginPost(req, env)) return text(403, "Forbidden");
  const actor = await memberForAccessEmail(env.DB, email);
  if (!actor) return text(403, "Forbidden");
  let url = "";
  let note = "";
  try {
    const form = await req.formData();
    url = String(form.get("url") ?? "");
    note = String(form.get("note") ?? "");
  } catch {
    return text(400, "Bad request");
  }
  try {
    await addOutputLink(env.DB, actor, { task: code, url, note });
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    const page = await ui.renderTask(env.DB, code, email, Date.now(), { error: e.message, field: "output_link", value: url }, "overview", !!env.ATTACHMENTS);
    return page ? html(page, e.httpStatus) : text(e.httpStatus, e.message);
  }
  return new Response(null, { status: 303, headers: { location: `/t/${encodeURIComponent(code)}?tab=overview`, ...SEC_HEADERS } });
}

async function handleUpload(req: Request, env: Env, token: string, email?: string): Promise<Response> {
  if (email && !isSameOriginPost(req, env)) return text(403, "Forbidden");
  const actor = email
    ? await memberForAccessEmail(env.DB, email)
    : await authenticateBearer(env.DB, req.headers.get("authorization"));
  if (!actor) {
    if (email) return text(403, "Forbidden");
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="status-hub"' },
    });
  }
  const policy = attachmentPolicy(env);
  try {
    let bytes: Uint8Array;
    const type = req.headers.get("content-type") || "";
    if (type.includes("multipart/form-data")) {
      const file = (await req.formData()).get("file");
      if (!(file instanceof File)) return text(400, "file is required");
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      bytes = await readCapped(req.body, policy.maxBytes);
    }
    const stored = await finishAttachmentUpload(env.DB, env.ATTACHMENTS, actor, token, bytes, policy);
    const { r2_key: _key, ...pub } = stored;
    return json(pub);
  } catch (e) {
    if (e instanceof AppError) return json({ error: e.message }, e.httpStatus);
    throw e;
  }
}

async function downloadAttachment(env: Env, code: string, id: number, versionRaw: string | null): Promise<Response> {
  const version = versionRaw == null || versionRaw === "" ? null : Number(versionRaw);
  if (versionRaw && !Number.isInteger(version)) return text(400, "version must be an integer");
  try {
    const obj = await getAttachmentObject(env.DB, env.ATTACHMENTS, code, id, version);
    const inline = isImageMime(obj.mime);
    return new Response(obj.body, {
      headers: {
        "content-type": obj.mime,
        "content-disposition": contentDisposition(obj.name, inline),
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    if (e instanceof AppError) return text(e.httpStatus, e.message);
    throw e;
  }
}

async function handleCreate(req: Request, env: Env, url: URL): Promise<Response> {
  if (!isSameOriginPost(req, env)) return text(403, "Forbidden");
  const form = await req.formData();
  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v.trim() : "";
  };
  const atRaw = str("requested_at");
  const requested_at = atRaw ? Number(atRaw) : undefined;
  if (atRaw && !Number.isInteger(requested_at)) return text(400, "requested_at must be epoch ms");
  const status = str("status");
  try {
    const created = await createTaskFromUi(env.DB, {
      feature: str("feature"),
      title: str("title"),
      assignee: str("assignee") || undefined,
      status: (status || undefined) as Status | undefined,
      requested_by: str("requested_by") || undefined,
      requested_at,
      request_link: str("request_link") || undefined,
      request: str("request") || undefined,
      due_at: str("due_at") ? Number(str("due_at")) : undefined,
    });
    return Response.redirect(new URL(`/t/${created.code}`, url).href, 303);
  } catch (e) {
    if (e instanceof AppError) return text(e.httpStatus, e.message);
    throw e;
  }
}

function safeNext(raw: string | null | undefined): string {
  if (!raw || raw.length > 512) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (raw.includes("\\") || raw.includes("://") || raw.includes("\n") || raw.includes("\r")) return "/";
  return raw;
}

function loginRedirect(url: URL): Response {
  const next = url.pathname + url.search;
  const q = next && next !== "/" ? `?next=${encodeURIComponent(next)}` : "";
  return new Response(null, {
    status: 303,
    headers: { location: `/login${q}`, "cache-control": "no-store", ...SEC_HEADERS },
  });
}

async function handleLogin(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method === "GET") {
    if (await sessionEmail(env.DB, req, env)) {
      return new Response(null, { status: 303, headers: { location: "/", "cache-control": "no-store", ...SEC_HEADERS } });
    }
    const next = safeNext(url.searchParams.get("next"));
    return html(ui.renderLogin(undefined, next === "/" ? "" : next));
  }
  if (req.method !== "POST") return text(405, "Method not allowed");
  if (!isSameOriginPost(req, env)) return text(403, "Forbidden");
  const secret = sessionSecret(env);
  if (!secret) return text(500, "AUTH_SESSION_SECRET is not set");
  let token = "";
  let next = "/";
  try {
    const form = await req.formData();
    token = String(form.get("token") ?? "").trim();
    next = safeNext(typeof form.get("next") === "string" ? String(form.get("next")) : "");
  } catch {
    return text(400, "Bad request");
  }
  const email = await authenticateLoginToken(env.DB, token, env.UI_ALLOWED_EMAILS);
  if (!email) return html(ui.renderLogin("Invalid token", next === "/" ? "" : next), 401);
  const cookie = await openSession(env.DB, email, secret, sessionTtlSeconds(env.AUTH_SESSION_TTL_SECONDS));
  return new Response(null, {
    status: 303,
    headers: { location: next, "set-cookie": cookie, "cache-control": "no-store", ...SEC_HEADERS },
  });
}

async function handleLogout(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return text(405, "Method not allowed");
  if (!isSameOriginPost(req, env)) return text(403, "Forbidden");
  await revokeSession(env.DB, req, env);
  return new Response(null, {
    status: 303,
    headers: { location: "/login", "set-cookie": clearSessionCookie(), "cache-control": "no-store", ...SEC_HEADERS },
  });
}

async function handleUi(req: Request, env: Env, url: URL): Promise<Response> {
  const mode = resolveAuthMode(env.AUTH_MODE);
  // magic-link needs an email sender. This Worker does not include one.
  if (mode === "magic-link") {
    return text(403, "AUTH_MODE=magic-link is not available. A magic link has to be emailed, and this Worker does not include an email provider.");
  }
  if (mode === "unknown") return text(403, "Forbidden: unknown AUTH_MODE");
  if (mode === "token" && url.pathname === "/login") return handleLogin(req, env, url);
  if (mode === "token" && url.pathname === "/logout") return handleLogout(req, env);
  // Access mode re-verifies the JWT so any other path to the Worker gets 403.
  const email = mode === "token" ? await sessionEmail(env.DB, req, env) : await verifyAccessJwt(req, env);
  if (!email) {
    if (mode === "access") return text(403, "Forbidden: Cloudflare Access required");
    if (req.method === "GET") return loginRedirect(url);
    return text(403, "Forbidden");
  }
  if (req.method === "POST" && url.pathname === "/new") return handleCreate(req, env, url);
  const path = url.pathname;
  if (req.method === "POST") {
    const preview = path.match(/^\/t\/([A-Z0-9.-]+)\/request-preview$/);
    if (preview) return postRequestPreview(req, env, preview[1]);
    const upload = path.match(/^\/t\/([A-Z0-9.-]+)\/attachments$/);
    if (upload) return postAttachment(req, env, upload[1], email);
    const link = path.match(/^\/t\/([A-Z0-9.-]+)\/output-link$/);
    if (link) return postOutputLink(req, env, link[1], email);
    const feedback = path.match(/^\/t\/([A-Z0-9.-]+)\/feedback$/);
    if (feedback) return postFeedback(env, feedback[1], email, req);
    const tokenUpload = path.match(/^\/attachment-uploads\/([A-Za-z0-9_-]{20,})$/);
    if (tokenUpload) return handleUpload(req, env, tokenUpload[1], email);
    const posted = path.match(/^\/t\/([A-Z0-9.-]+)$/);
    if (posted) return postTaskEdit(req, env, posted[1], email);
    const featurePost = path.match(/^\/f\/([A-Z]{2,5}-[A-Z]{2,6}-\d{3,})$/);
    if (featurePost) return postFeaturePriority(req, env, featurePost[1], email);
    return text(405, "Method not allowed");
  }
  if (req.method !== "GET") return text(405, "Method not allowed");
  if (path === "/assets/dashboard.js") {
    return new Response(DASHBOARD_JS, {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (path === "/api/board") return json(await ui.boardJson(env.DB, url));
  let m: RegExpMatchArray | null;
  let out: string | null = null;
  if (path === "/new") out = await ui.renderNewTask(env.DB, email);
  else if (path === "/") out = await ui.renderBoard(env.DB, url, email);
  else if (path === "/done") out = await ui.renderDone(env.DB, url, email);
  else if (path === "/alerts") out = await ui.renderAlerts(env.DB, email);
  else if (path === "/members") out = await ui.renderMembers(env.DB, email);
  else if ((m = path.match(/^\/t\/([A-Z0-9.-]+)\/attachments\/(\d+)$/))) {
    return downloadAttachment(env, m[1], Number(m[2]), url.searchParams.get("v"));
  }
  else if ((m = path.match(/^\/t\/([A-Z0-9.-]+)$/))) {
    const tab = url.searchParams.get("tab");
    const filesOn = !!env.ATTACHMENTS;
    if (url.searchParams.has("fragment")) {
      const frag = await ui.renderTaskFragment(env.DB, m[1], email, Date.now(), undefined, tab, filesOn, url);
      return frag ? html(frag) : text(404, "Not found");
    }
    out = await ui.renderTask(env.DB, m[1], email, Date.now(), undefined, tab, filesOn, url);
  }
  else if ((m = path.match(/^\/p\/([A-Z]{2,5})$/))) out = await ui.renderProject(env.DB, m[1], email);
  else if ((m = path.match(/^\/m\/([a-z0-9-]{1,32})$/))) out = await ui.renderMember(env.DB, m[1], email);
  return out ? html(out) : text(404, "Not found");
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    useHubConfig(configFromEnv(env));
    const url = new URL(req.url);
    if (url.hostname === env.MCP_HOST) {
      if (url.pathname === "/mcp") return handleMcp(req, env, ctx);
      const upload = url.pathname.match(/^\/attachment-uploads\/([A-Za-z0-9_-]{20,})$/);
      if (upload && req.method === "POST") return handleUpload(req, env, upload[1]);
      return text(404, "Not found");
    }
    if (url.hostname === env.UI_HOST) return handleUi(req, env, url);
    // Any other hostname (workers.dev, previews, raw IP): deny.
    return text(403, "Forbidden");
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    useHubConfig(configFromEnv(env));
    ctx.waitUntil(runChecks(env.DB).then((r) => console.log(JSON.stringify({ msg: "cron", ...r }))));
  },
} satisfies ExportedHandler<Env>;
