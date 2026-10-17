import { createMcpHandler } from "agents/mcp/server";
import {
  authenticateBearer, authenticateLoginToken, clearSessionCookie, leadershipAuthor, memberForAccessEmail,
  openSession, resolveAuthMode, revokeSession, sessionEmail, sessionSecret, sessionTtlSeconds, verifyAccessJwt,
  type AuthEnv,
} from "./auth";
import { configFromEnv, useHubConfig, type ConfigEnv } from "./config";
import { addLeadershipFeedback, AppError, createTaskFromUi, runChecks, updateTask, type Status } from "./core";
import { createServer } from "./mcp";
import * as ui from "./ui";

export interface Env extends AuthEnv, ConfigEnv {
  DB: D1Database;
  UI_HOST: string;
  MCP_HOST: string;
}

const SEC_HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const text = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SEC_HEADERS } });

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

async function postTaskPr(req: Request, env: Env, code: string, email: string): Promise<Response> {
  if (!isSameOriginPost(req, env)) return text(403, "Forbidden");
  const actor = await memberForAccessEmail(env.DB, email);
  if (!actor) return text(403, "Forbidden");
  let raw = "";
  try {
    raw = String((await req.formData()).get("pr_url") ?? "");
    await updateTask(env.DB, actor, { task: code, pr_url: raw });
  } catch (e) {
    if (e instanceof AppError && e.code === "NOT_FOUND") return text(404, e.message);
    if (e instanceof AppError && e.code === "FORBIDDEN") return text(403, e.message);
    if (e instanceof AppError) {
      const page = await ui.renderTask(env.DB, code, email, Date.now(), { error: e.message, pr_url: raw });
      return page ? html(page, 400) : text(404, "Not found");
    }
    throw e;
  }
  return new Response(null, { status: 303, headers: { location: `/t/${encodeURIComponent(code)}`, ...SEC_HEADERS } });
}

async function handleMcp(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const me = await authenticateBearer(env.DB, req.headers.get("authorization"));
  if (!me) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="status-hub"' },
    });
  }
  const handler = createMcpHandler(() => createServer(env.DB, me), {
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
    const feedback = path.match(/^\/t\/([A-Z0-9.-]+)\/feedback$/);
    if (feedback) return postFeedback(env, feedback[1], email, req);
    const posted = path.match(/^\/t\/([A-Z0-9.-]+)$/);
    if (!posted) return text(405, "Method not allowed");
    return postTaskPr(req, env, posted[1], email);
  }
  if (req.method !== "GET") return text(405, "Method not allowed");
  let m: RegExpMatchArray | null;
  let out: string | null = null;
  if (path === "/new") out = await ui.renderNewTask(env.DB, email);
  else if (path === "/") out = await ui.renderBoard(env.DB, url, email);
  else if (path === "/done") out = await ui.renderDone(env.DB, url, email);
  else if (path === "/alerts") out = await ui.renderAlerts(env.DB, email);
  else if (path === "/members") out = await ui.renderMembers(env.DB, email);
  else if ((m = path.match(/^\/t\/([A-Z0-9.-]+)$/))) out = await ui.renderTask(env.DB, m[1], email);
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
