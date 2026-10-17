import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import * as core from "../src/core";
import { accessJwt, fullRequest, issueToken, mcpCall, member, UI, worker } from "./helpers";

const SECRET = "test-only-session-secret";
const OWNER_EMAIL = "owner@example.com";
const VIEWER = "viewer@example.com";

function useMode(mode: string, ttl = "3600") {
  env.AUTH_MODE = mode;
  env.AUTH_SESSION_SECRET = SECRET;
  env.AUTH_SESSION_TTL_SECONDS = ttl;
}

function randomLoginToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const body = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `shu_${body}`;
}

async function issueUiLogin(email: string, opts: { expiresAt?: number | null; revoked?: boolean } = {}) {
  const token = randomLoginToken();
  await env.DB.prepare(
    `INSERT INTO ui_login_tokens (id, token_hash, email, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    await sha256Hex(token),
    email.trim().toLowerCase(),
    Date.now(),
    opts.expiresAt ?? null,
    opts.revoked ? Date.now() : null,
  ).run();
  return token;
}

function sessionPair(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  const pair = set.split(";")[0]?.trim() ?? "";
  if (!pair.startsWith("sh_session=")) throw new Error(`missing session cookie: ${set}`);
  return pair;
}

async function login(token: string, extra: Record<string, string> = {}, fields: Record<string, string> = {}) {
  return worker.fetch(`${UI}/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "null",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "navigate",
      ...extra,
    },
    body: new URLSearchParams({ token, ...fields }),
  });
}

async function authed(path: string, cookie: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  return worker.fetch(`${UI}${path}`, { ...init, headers, redirect: "manual" });
}

describe("AUTH_MODE=access", () => {
  it("keeps Cloudflare Access JWT checks when the mode is access, blank, or padded", async () => {
    for (const mode of ["access", "", " access "]) {
      useMode(mode);
      expect((await worker.fetch(`${UI}/`, { redirect: "manual" })).status).toBe(403);
      expect((await worker.fetch(`${UI}/login`, { redirect: "manual" })).status).toBe(403);
      const ok = await worker.fetch(`${UI}/`, {
        headers: { "Cf-Access-Jwt-Assertion": await accessJwt(OWNER_EMAIL) },
      });
      expect(ok.status, mode).toBe(200);
      expect(await ok.text()).not.toContain('action="/logout"');
      const cookieBypass = await worker.fetch(`${UI}/`, {
        headers: { cookie: "sh_session=forged" },
        redirect: "manual",
      });
      expect(cookieBypass.status, mode).toBe(403);
    }
  });

  it("rejects a cross-site create and accepts a same-origin Chrome create", async () => {
    useMode("access");
    const lily = await member("lily");
    const feature = await core.createFeature(env.DB, lily, { module: "STS-CORE", title: "csrf create" });
    const headers = {
      "Cf-Access-Jwt-Assertion": await accessJwt(OWNER_EMAIL),
      "content-type": "application/x-www-form-urlencoded",
    };
    const body = new URLSearchParams({ feature: feature.code, title: "cross site task" });
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>();
    const cross = await worker.fetch(`${UI}/new`, {
      method: "POST",
      redirect: "manual",
      headers: { ...headers, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      body,
    });
    expect(cross.status).toBe(403);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);

    const chrome = await worker.fetch(`${UI}/new`, {
      method: "POST",
      redirect: "manual",
      headers: { ...headers, origin: "null", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" },
      body: new URLSearchParams({
        feature: feature.code,
        title: "same origin task",
        requested_by: fullRequest.requested_by,
        requested_at: String(fullRequest.requested_at),
        request_link: fullRequest.request_link,
      }),
    });
    expect(chrome.status).toBe(303);
  });
});

describe("AUTH_MODE=token", () => {
  it("shows a login page and does not accept an Access JWT", async () => {
    useMode("Token");
    const anon = await worker.fetch(`${UI}/`, { redirect: "manual" });
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toContain("/login");
    const page = await worker.fetch(`${UI}/login`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('type="password"');
    expect(html).toContain('name="token"');
    expect(html).toContain("Log in");
    expect(html).not.toContain("Kanban");
    const jwt = await worker.fetch(`${UI}/`, {
      headers: { "Cf-Access-Jwt-Assertion": await accessJwt(OWNER_EMAIL) },
      redirect: "manual",
    });
    expect(jwt.status).toBe(303);
    expect((await worker.fetch("https://status-hub.example.workers.dev/")).status).toBe(403);
    expect((await mcpCall(null, "whoami")).http).toBe(401);
  });

  it("sets a signed session cookie for an allowed email and stores only the token hash", async () => {
    useMode("token", "3600");
    const token = await issueUiLogin(OWNER_EMAIL);
    const denied = await login(randomLoginToken());
    expect(denied.status).toBe(401);
    expect(denied.headers.get("set-cookie")).toBeNull();
    expect(await denied.text()).toContain("Invalid token");

    const stranger = await issueUiLogin("stranger@example.com");
    const blocked = await login(stranger);
    expect(blocked.status).toBe(401);

    const cross = await login(token, { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    expect(cross.status).toBe(403);
    expect(cross.headers.get("set-cookie")).toBeNull();

    const res = await login(token, {}, { next: "/alerts" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alerts");
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Secure");
    expect(set.toLowerCase()).toContain("samesite=lax");
    expect(set).toContain("Path=/");
    expect(set).toContain("Max-Age=3600");
    expect(set).not.toContain(token);
    expect(set).not.toContain(await sha256Hex(token));
    const cookie = sessionPair(res);

    const stored = await env.DB.prepare("SELECT id, token_hash, email, expires_at, revoked_at FROM ui_login_tokens WHERE email = ?").bind(OWNER_EMAIL).all<{ token_hash: string }>();
    const hash = await sha256Hex(token);
    expect(JSON.stringify(stored.results)).not.toContain(token);
    expect(stored.results.some((row) => row.token_hash === hash)).toBe(true);
    const sessions = await env.DB.prepare("SELECT id, email, expires_at, revoked_at FROM ui_sessions WHERE email = ?").bind(OWNER_EMAIL).all();
    expect(sessions.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(sessions.results)).not.toContain(token);

    const board = await authed("/alerts", cookie);
    expect(board.status).toBe(200);
    const boardHtml = await board.text();
    expect(boardHtml).toContain(OWNER_EMAIL);
    expect(boardHtml).toContain('action="/logout"');

    const open = await login(token, {}, { next: "https://evil.example" });
    expect(open.headers.get("location")).toBe("/");
    const slash = await login(token, {}, { next: "//evil.example" });
    expect(slash.headers.get("location")).toBe("/");
  });

  it("maps the session email to a member and to leadership authors", async () => {
    useMode("token");
    const harry = await issueToken("harry");
    const feature = (await mcpCall(harry, "create_feature", { module: "STS-CORE", title: "token member map" })).data.code;
    const code = (await mcpCall(harry, "create_task", { feature, title: "token pr", assignee: "peter" })).data.code;

    const peterCookie = sessionPair(await login(await issueUiLogin("peter@example.com")));
    const updated = await authed(`/t/${code}`, peterCookie, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "null", "sec-fetch-site": "same-origin" },
      body: "pr_url=" + encodeURIComponent("https://github.com/example/repo/pull/11"),
    });
    expect(updated.status).toBe(303);
    expect((await mcpCall(harry, "get_task", { code })).data.task.pr_url).toBe("https://github.com/example/repo/pull/11");

    const janeCookie = sessionPair(await login(await issueUiLogin("jane@example.com")));
    const jane = await authed(`/t/${code}`, janeCookie, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
      body: "pr_url=" + encodeURIComponent("https://github.com/example/repo/pull/12"),
    });
    expect(jane.status).toBe(403);

    const ownerCookie = sessionPair(await login(await issueUiLogin(OWNER_EMAIL)));
    const note = await authed(`/t/${code}/feedback`, ownerCookie, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "null", "sec-fetch-site": "same-origin" },
      body: "note=from+token+session&author=Spoofed",
    });
    expect(note.status).toBe(303);
    const rows = (await env.DB.prepare("SELECT author, note FROM feedback WHERE task_code = ?").bind(code).all<{ author: string; note: string }>()).results;
    expect(rows).toContainEqual({ author: "Owner", note: "from token session" });

    const viewerCookie = sessionPair(await login(await issueUiLogin(VIEWER)));
    const viewerPost = await authed(`/t/${code}/feedback`, viewerCookie, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
      body: "note=nope",
    });
    expect(viewerPost.status).toBe(403);
    const viewerPage = await authed(`/t/${code}`, viewerCookie);
    expect(await viewerPage.text()).not.toContain("<textarea");
  });

  it("rejects expired, revoked, and cross-site sessions, and logout invalidates the cookie", async () => {
    useMode("token");
    expect((await login(await issueUiLogin(OWNER_EMAIL, { expiresAt: Date.now() - 1000 }))).status).toBe(401);
    expect((await login(await issueUiLogin(OWNER_EMAIL, { revoked: true }))).status).toBe(401);
    expect((await login("shk_harry_" + "a".repeat(43))).status).toBe(401);

    const token = await issueUiLogin("harry@example.com");
    const cookie = sessionPair(await login(token));
    const cross = await authed("/logout", cookie, {
      method: "POST",
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    expect(cross.status).toBe(403);
    expect((await authed("/", cookie)).status).toBe(200);

    env.AUTH_SESSION_SECRET = "different-test-secret";
    const resigned = await authed("/", cookie, {});
    expect(resigned.status).toBe(303);
    env.AUTH_SESSION_SECRET = SECRET;

    const at = cookie.indexOf("=") + 8;
    const tampered = cookie.slice(0, at) + (cookie[at] === "A" ? "B" : "A") + cookie.slice(at + 1);
    expect((await authed("/", tampered)).status).toBe(303);

    await env.DB.prepare("UPDATE ui_sessions SET expires_at = ? WHERE email = ?").bind(1, "harry@example.com").run();
    expect((await authed("/", cookie)).status).toBe(303);

    const fresh = sessionPair(await login(token));
    const out = await authed("/logout", fresh, {
      method: "POST",
      headers: { origin: "null", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" },
    });
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/login");
    const cleared = out.headers.get("set-cookie") ?? "";
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("Secure");
    expect(cleared.toLowerCase()).toContain("samesite=lax");
    expect((await authed("/", fresh)).status).toBe(303);
    expect((await worker.fetch(`${UI}/logout`, { redirect: "manual" })).status).toBe(405);
  });

  it("fails closed when the session secret is missing", async () => {
    useMode("token");
    env.AUTH_SESSION_SECRET = "";
    const token = await issueUiLogin(VIEWER);
    const res = await login(token);
    expect(res.status).toBe(500);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toContain("AUTH_SESSION_SECRET");
    env.AUTH_SESSION_SECRET = SECRET;
  });
});

describe("AUTH_MODE=magic-link", () => {
  it("is refused because sending a link needs an email provider", async () => {
    for (const mode of ["magic-link", "oauth"]) {
      useMode(mode);
      const res = await worker.fetch(`${UI}/`, { redirect: "manual" });
      expect(res.status, mode).toBe(403);
      expect(res.headers.get("set-cookie"), mode).toBeNull();
      const body = await res.text();
      if (mode === "magic-link") expect(body).toContain("email provider");
      else expect(body.toLowerCase()).toContain("auth_mode");
      const posted = await worker.fetch(`${UI}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
        body: "token=anything",
      });
      expect(posted.status, mode).toBe(403);
    }
  });
});
