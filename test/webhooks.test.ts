import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import * as core from "../src/core";
import {
  deliverDueWebhooks, listWebhooks, openSecret, sealSecret, setMemberWebhook, testMemberWebhook,
  WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_MS,
} from "../src/webhooks";
import { accessJwt, fullRequest, issueToken, mcpCall, member, UI } from "./helpers";

const T0 = Date.UTC(2026, 9, 18, 10, 0);
const HOOK = "https://hooks.example.com/routine/abc";
const SECRET = "sender-key-not-for-logs";
const KEY = "test-webhook-encryption-key";
const originalFetch = globalThis.fetch;

interface Sent { url: string; headers: Headers; body: any; redirect?: string }

function mockHooks(status = 200) {
  const sent: Sent[] = [];
  const state = { status };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://hooks.example.com/")) {
      sent.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)), redirect: init?.redirect });
      return new Response("ok", { status: state.status });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return { sent, state };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("UPDATE members SET webhook_url = NULL, webhook_header_name = NULL, webhook_secret = NULL"),
    env.DB.prepare("DELETE FROM webhook_outbox"),
  ]);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function task(assignee: string, title: string, status: "assigned" | "in_progress" = "assigned") {
  const lily = await member("lily");
  const f = await core.createFeature(env.DB, lily, { module: "STS-CORE", title }, T0);
  const t = await core.createTask(env.DB, lily, { feature: f.code, title, assignee, ...fullRequest }, T0);
  await core.reportStatus(env.DB, lily, { task: t.code, status: "assigned" }, T0);
  if (status === "in_progress") await core.reportStatus(env.DB, await member(assignee), { task: t.code, status: "in_progress" }, T0 + 1);
  // Setup assignments are covered by their own test; start each test with an empty outbox.
  await env.DB.prepare("DELETE FROM webhook_outbox WHERE task_code = ?").bind(t.code).run();
  return t.code;
}

async function hook(id: string, opts: { secret?: boolean; key?: string } = {}) {
  return setMemberWebhook(env.DB, await member("lily"), {
    member: id, url: HOOK, ...(opts.secret === false ? {} : { header_name: "X-Sender-Key", secret: SECRET }),
  }, { key: opts.key });
}

async function outbox(member?: string) {
  const q = member
    ? env.DB.prepare("SELECT * FROM webhook_outbox WHERE member_id = ? ORDER BY id").bind(member)
    : env.DB.prepare("SELECT * FROM webhook_outbox ORDER BY id");
  return (await q.all<Record<string, any>>()).results;
}

describe("member webhook configuration", () => {
  it("is admin-only, https-only, and never returns the secret", async () => {
    const peter = await member("peter");
    await expect(setMemberWebhook(env.DB, peter, { member: "peter", url: HOOK })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const lily = await member("lily");
    await expect(setMemberWebhook(env.DB, lily, { member: "peter", url: "http://hooks.example.com/x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(setMemberWebhook(env.DB, lily, { member: "peter", url: "https://u:p@hooks.example.com/x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(setMemberWebhook(env.DB, lily, { member: "peter", url: HOOK, header_name: "Host", secret: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(setMemberWebhook(env.DB, lily, { member: "peter", url: HOOK, secret: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const out = await hook("peter", { key: KEY });
    expect(out).toEqual({ member: "peter", webhook_url: HOOK, header_name: "X-Sender-Key", secret: "set" });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    const row = await env.DB.prepare("SELECT webhook_secret FROM members WHERE id = 'peter'").first<{ webhook_secret: string }>();
    expect(row!.webhook_secret.startsWith("enc1:")).toBe(true);
    expect(row!.webhook_secret).not.toContain(SECRET);
    expect(await openSecret(row!.webhook_secret, KEY)).toBe(SECRET);
    expect(await openSecret(row!.webhook_secret, "wrong")).toBeNull();
    expect(await openSecret(row!.webhook_secret)).toBeNull();
    expect(await openSecret(await sealSecret("plain"))).toBe("plain");

    const listed = await listWebhooks(env.DB, lily);
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    expect(listed.webhooks.find((w) => w.member === "peter")).toMatchObject({ secret: "set", pending: 0 });

    // Omitted secret is kept; clearing the URL clears all three.
    await setMemberWebhook(env.DB, lily, { member: "peter", header_name: "X-Other" }, { key: KEY });
    expect((await env.DB.prepare("SELECT webhook_secret FROM members WHERE id = 'peter'").first<{ webhook_secret: string }>())!.webhook_secret).toBe(row!.webhook_secret);
    const cleared = await setMemberWebhook(env.DB, lily, { member: "peter", url: "" });
    expect(cleared).toEqual({ member: "peter", webhook_url: null, header_name: null, secret: "none" });
  });

  it("MCP: set_member_webhook and list_webhooks are admin-only and never echo the secret", async () => {
    const admin = await issueToken("lily");
    const dev = await issueToken("ethan");
    const denied = await mcpCall(dev, "set_member_webhook", { member: "ethan", url: HOOK });
    expect(denied.isError).toBe(true);
    expect(denied.data.status).toBe(403);
    const ok = await mcpCall(admin, "set_member_webhook", { member: "ethan", url: HOOK, header_name: "X-Sender-Key", secret: SECRET });
    expect(ok.isError).toBe(false);
    expect(ok.data).toMatchObject({ member: "ethan", secret: "set" });
    expect(JSON.stringify(ok.raw)).not.toContain(SECRET);
    const listed = await mcpCall(admin, "list_webhooks", {});
    expect(JSON.stringify(listed.raw)).not.toContain(SECRET);
    expect((await mcpCall(dev, "list_webhooks", {})).data.status).toBe(403);
    const who = await mcpCall(dev, "whoami", {});
    expect(JSON.stringify(who.raw)).not.toContain(SECRET);
  });

  it("Members page shows inline webhook fields to admins only and never renders the secret", async () => {
    await hook("peter");
    const adminPage = await (await app.fetch(new Request(`${UI}/members`, {
      headers: { "Cf-Access-Jwt-Assertion": await accessJwt("owner@example.com") },
    }), env, createExecutionContext())).text();
    expect(adminPage).toContain('action="/members/peter/webhook"');
    expect(adminPage).toContain('data-inline-kind="secret"');
    expect(adminPage).toContain(HOOK);
    expect(adminPage).not.toContain(SECRET);
    const viewerPage = await (await app.fetch(new Request(`${UI}/members`, {
      headers: { "Cf-Access-Jwt-Assertion": await accessJwt("peter@example.com") },
    }), env, createExecutionContext())).text();
    expect(viewerPage).not.toContain(HOOK);
    expect(viewerPage).not.toContain("/members/peter/webhook");

    const post = (email: string, body: string) => app.fetch(new Request(`${UI}/members/jane/webhook`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": "", "content-type": "application/x-www-form-urlencoded", accept: "application/json",
        "sec-fetch-site": "same-origin",
      },
      body,
    }), env, createExecutionContext());
    const withJwt = async (email: string, body: string) => {
      const req = new Request(`${UI}/members/jane/webhook`, {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": await accessJwt(email), "content-type": "application/x-www-form-urlencoded",
          accept: "application/json", "sec-fetch-site": "same-origin",
        },
        body,
      });
      return app.fetch(req as Parameters<typeof app.fetch>[0], env, createExecutionContext());
    };
    expect((await post("owner@example.com", "webhook_url=x")).status).toBe(403);
    expect((await withJwt("peter@example.com", `webhook_url=${encodeURIComponent(HOOK)}`)).status).toBe(403);
    expect((await withJwt("owner@example.com", "webhook_url=http%3A%2F%2Fx.example")).status).toBe(400);
    const ok = await withJwt("owner@example.com", `webhook_url=${encodeURIComponent(HOOK)}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect((await env.DB.prepare("SELECT webhook_url FROM members WHERE id = 'jane'").first<{ webhook_url: string }>())!.webhook_url).toBe(HOOK);
  });
});

describe("events reach the assignee's webhook", () => {
  it("leadership feedback from the UI is delivered right away with the sender key header", async () => {
    const { sent } = mockHooks();
    await hook("peter");
    const code = await task("peter", "feedback wake");
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`${UI}/t/${code}/feedback`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Cf-Access-Jwt-Assertion": await accessJwt("owner@example.com"),
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
      },
      body: "note=link+should+open+in+new+tab",
    }), env, ctx);
    expect(res.status).toBe(303);
    await waitOnExecutionContext(ctx);
    expect(sent).toHaveLength(1);
    const [msg] = sent;
    expect(msg.url).toBe(HOOK);
    expect(msg.redirect).toBe("manual");
    expect(msg.headers.get("X-Sender-Key")).toBe(SECRET);
    expect(msg.headers.get("content-type")).toBe("application/json");
    expect(msg.headers.get("x-status-hub-event")).toBe("feedback.added");
    expect(msg.body).toMatchObject({
      type: "feedback.added",
      member: "peter",
      task: { code, title: "feedback wake", status: "assigned", url: `https://${env.UI_HOST}/t/${code}` },
      feedback: { author: "Owner", note: "link should open in new tab" },
    });
    expect(msg.body.text).toContain("link should open in new tab");
    expect(msg.headers.get("x-status-hub-delivery")).toBe(msg.body.id);
    expect((await outbox("peter"))[0]).toMatchObject({ attempts: 1, last_status: 200 });
    expect((await outbox("peter"))[0].delivered_at).not.toBeNull();
  });

  it("assignment and a resolved blocker wake the assignee; the assignee's own actions do not", async () => {
    const { sent } = mockHooks();
    await hook("quinn", { secret: false });
    const lily = await member("lily");
    const harry = await member("harry");
    // create_task directly in assigned
    const f = await core.createFeature(env.DB, lily, { module: "STS-CORE", title: "wake on assign" }, T0);
    const created = await core.createTask(env.DB, lily, { feature: f.code, title: "wake on assign", assignee: "quinn", status: "assigned", ...fullRequest }, T0);
    // backlog → assigned via report_status
    const b = await core.createTask(env.DB, lily, { feature: f.code, title: "backlog first", assignee: "quinn", ...fullRequest }, T0);
    expect(b.status).toBe("backlog");
    expect(await outbox("quinn")).toHaveLength(1);
    await core.reportStatus(env.DB, lily, { task: b.code, status: "assigned" }, T0 + 1);
    // reassign from peter to quinn
    const other = await task("peter", "reassign me");
    await core.assignTask(env.DB, harry, { task: other, assignee: "quinn" }, T0 + 2);
    await deliverDueWebhooks(env.DB, { now: T0 + 3 });
    expect(sent.map((s) => [s.body.type, s.body.task.code])).toEqual([
      ["task.assigned", created.code], ["task.assigned", b.code], ["task.assigned", other],
    ]);
    expect(sent[2].body.assigned_by).toBe("harry");
    expect(sent[0].headers.get("X-Sender-Key")).toBeNull();

    // Blocker resolved by someone else wakes quinn; quinn resolving her own does not.
    const quinn = await member("quinn");
    await core.reportStatus(env.DB, quinn, { task: created.code, status: "in_progress" }, T0 + 4);
    const b1 = await core.setBlocker(env.DB, quinn, { task: created.code, kind: "need_info", waiting_on: "lily", detail: "need token" }, T0 + 5);
    const b2 = await core.setBlocker(env.DB, quinn, { task: created.code, kind: "access", waiting_on: "lily", detail: "need repo" }, T0 + 6);
    await core.resolveBlocker(env.DB, quinn, { id: b2.blocker_id }, T0 + 7);
    expect(await outbox("quinn")).toHaveLength(3);
    const r = await core.resolveBlocker(env.DB, lily, { id: b1.blocker_id, note: "token issued" }, T0 + 8);
    expect(r.status).toBe("in_progress");
    await deliverDueWebhooks(env.DB, { now: T0 + 9 });
    const last = sent[sent.length - 1].body;
    expect(last).toMatchObject({
      type: "blocker.resolved",
      task: { code: created.code, status: "in_progress" },
      blocker: { id: b1.blocker_id, kind: "need_info", detail: "need token", resolution: "token issued", resolved_by: "lily" },
      remaining_blockers: 0,
    });
  });

  it("members without a webhook queue nothing", async () => {
    const code = await task("olivia", "no hook");
    await core.addLeadershipFeedback(env.DB, { task: code, author: "Owner", note: "hello" }, T0 + 2);
    expect(await outbox()).toHaveLength(0);
  });
});

describe("retries and failure alert", () => {
  it("retries from the cron up to the limit, then raises WEBHOOK_FAILED; a later success clears it", async () => {
    const { sent, state } = mockHooks(500);
    await hook("jennifer", { key: KEY });
    const code = await task("jennifer", "flaky hook");
    await core.addLeadershipFeedback(env.DB, { task: code, author: "Owner", note: "please fix" }, T0 + 2);
    let now = T0 + 3;
    const first = await deliverDueWebhooks(env.DB, { now, key: KEY });
    expect(first).toMatchObject({ delivered: 0, failed: 1 });
    // Not due again until the retry delay passes.
    expect((await deliverDueWebhooks(env.DB, { now: now + 1000, key: KEY })).results).toHaveLength(0);
    for (let i = 2; i <= WEBHOOK_MAX_ATTEMPTS; i++) {
      now += WEBHOOK_RETRY_MS;
      await deliverDueWebhooks(env.DB, { now, key: KEY });
    }
    expect(sent).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    const [row] = await outbox("jennifer");
    expect(row).toMatchObject({ attempts: WEBHOOK_MAX_ATTEMPTS, last_status: 500, last_error: "HTTP 500" });
    expect(row.failed_at).not.toBeNull();
    const alerts = async () => (await env.DB.prepare(
      "SELECT rule FROM alerts WHERE task_code = ? AND cleared_at IS NULL",
    ).bind(code).all<{ rule: string }>()).results.map((a) => a.rule);
    expect(await alerts()).toContain("WEBHOOK_FAILED");
    now += WEBHOOK_RETRY_MS;
    expect((await deliverDueWebhooks(env.DB, { now, key: KEY })).results).toHaveLength(0);
    // The cron leaves the alert in place.
    await core.runChecks(env.DB, now);
    expect(await alerts()).toContain("WEBHOOK_FAILED");

    state.status = 202;
    await core.addLeadershipFeedback(env.DB, { task: code, author: "Owner", note: "again" }, now + 1);
    await deliverDueWebhooks(env.DB, { now: now + 2, key: KEY });
    expect(await alerts()).not.toContain("WEBHOOK_FAILED");
  });

  it("a network error or an unreadable secret counts as a failed attempt and is logged without the secret", async () => {
    const logs: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    try {
      globalThis.fetch = (async () => { throw new TypeError("boom"); }) as typeof fetch;
      await hook("mira", { key: KEY });
      const code = await task("mira", "network down");
      await core.addLeadershipFeedback(env.DB, { task: code, author: "Owner", note: "x" }, T0 + 2);
      const r1 = await deliverDueWebhooks(env.DB, { now: T0 + 3, key: KEY });
      expect(r1.results[0]).toMatchObject({ ok: false, error: "network error" });
      // Key missing: encrypted secret cannot be opened.
      const r2 = await deliverDueWebhooks(env.DB, { now: T0 + 3 + WEBHOOK_RETRY_MS });
      expect(r2.results[0]).toMatchObject({ ok: false });
      expect(String((r2.results[0] as { error?: string }).error)).toMatch(/WEBHOOK_SECRET_KEY/);
    } finally {
      console.log = log;
    }
    expect(logs.some((l) => l.includes('"msg":"webhook"'))).toBe(true);
    expect(logs.join("\n")).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain(HOOK);
  });

  it("test_member_webhook delivers once and is not retried", async () => {
    const { sent, state } = mockHooks(200);
    await hook("leo");
    const ok = await testMemberWebhook(env.DB, await member("lily"), { member: "leo" }, { now: T0 });
    expect(ok).toMatchObject({ member: "leo", ok: true, status: 200 });
    expect(sent[0].body).toMatchObject({ type: "webhook.test", member: "leo", task: null });
    state.status = 401;
    const bad = await testMemberWebhook(env.DB, await member("lily"), { member: "leo" }, { now: T0 + 1 });
    expect(bad).toMatchObject({ ok: false, status: 401, error: "HTTP 401" });
    expect((await deliverDueWebhooks(env.DB, { now: T0 + 2 * WEBHOOK_RETRY_MS })).results).toHaveLength(0);
    await expect(testMemberWebhook(env.DB, await member("peter"), { member: "leo" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("resolve_blocker keeps a cancelled or done task closed", () => {
  it("resolving a leftover blocker on a cancelled task does not reopen it", async () => {
    const lily = await member("lily");
    const code = await task("anna", "cancel with blocker", "in_progress");
    const anna = await member("anna");
    const b = await core.setBlocker(env.DB, anna, { task: code, kind: "need_info", waiting_on: "lily", detail: "waiting" }, T0 + 2);
    await core.reportStatus(env.DB, lily, { task: code, status: "cancelled", note: "test task" }, T0 + 3);
    const r = await core.resolveBlocker(env.DB, lily, { id: b.blocker_id, note: "cleanup" }, T0 + 4);
    expect(r.status).toBe("cancelled");
    expect((await core.getTaskRow(env.DB, code)).status).toBe("cancelled");
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM status_periods WHERE task_code = ? AND ended_at IS NULL AND status = 'cancelled'").bind(code).first<{ n: number }>();
    expect(open!.n).toBe(1);
    const resolved = await env.DB.prepare("SELECT resolved_at FROM blockers WHERE id = ?").bind(b.blocker_id).first<{ resolved_at: number }>();
    expect(resolved!.resolved_at).toBe(T0 + 4);
  });
});

describe("set_reviewer (admin)", () => {
  it("lets an admin move a self-reviewed task to another member; others get 403", async () => {
    const code = await task("chloe", "self review", "in_progress");
    await core.addOutputLink(env.DB, await member("chloe"), { task: code, url: "https://example.com/out" }, T0 + 2);
    await core.reportStatus(env.DB, await member("chloe"), { task: code, status: "review", reviewer: "chloe" }, T0 + 3);
    const chloe = await issueToken("chloe");
    const denied = await mcpCall(chloe, "set_reviewer", { task: code, reviewer: "chloe" });
    expect(denied.data.status).toBe(403);
    const admin = await issueToken("lily");
    const moved = await mcpCall(admin, "set_reviewer", { task: code, reviewer: "quinn" });
    expect(moved.isError).toBe(false);
    expect(moved.data).toEqual({ code, reviewer_id: "quinn" });
    const t = await core.getTaskRow(env.DB, code);
    expect(t.reviewer_id).toBe("quinn");
    expect(t.status).toBe("review");
    expect((await mcpCall(admin, "set_reviewer", { task: code, reviewer: "nobody" })).data.status).toBe(404);
  });
});
