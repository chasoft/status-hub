import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import * as core from "../src/core";
import { accessJwt, fullRequest, issueToken, mcpCall, member, UI } from "./helpers";

const T0 = Date.UTC(2026, 9, 17, 3, 0);
const KEY = "test-cursor-key";
const AGENT = "https://cursor.com/agents/bc-11111111-2222-3333-4444-555555555555";
const AGENT_ID = "bc-11111111-2222-3333-4444-555555555555";
const OUTPUT = "https://example.com/output/1";
const PR = "https://example.com/code/pull/15";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function taskFor(assignee: string, title: string) {
  const lily = await member("lily");
  const f = await core.createFeature(env.DB, lily, { module: "STS-CORE", title }, T0);
  const created = await core.createTask(env.DB, lily, {
    feature: f.code, title, assignee, ...fullRequest,
  }, T0);
  await core.reportStatus(env.DB, lily, { task: created.code, status: "assigned" }, T0);
  return created.code;
}

function mockCursor(reply: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.cursor.com/")) {
      calls.push({ url, init });
      return reply(url, init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return calls;
}

async function taskPage(code: string, apiKey?: string) {
  const ctx = createExecutionContext();
  const headers = { "Cf-Access-Jwt-Assertion": await accessJwt("peter@example.com") };
  const envWithKey = new Proxy(env, {
    get(target, prop, receiver) {
      if (prop === "CURSOR_API_KEY") return apiKey;
      return Reflect.get(target, prop, receiver);
    },
  });
  const res = await app.fetch(new Request(`${UI}/t/${code}`, { headers }), envWithKey, ctx);
  return { status: res.status, html: await res.text() };
}

describe("set_agent stores and clears the linked agent", () => {
  it("sets an https agent_url and status, then clears both with null", async () => {
    const code = await taskFor("peter", "attach agent");
    const peter = await member("peter");
    const set = await core.setAgent(env.DB, peter, { task: code, agent_url: ` ${AGENT} `, status: " RUNNING " }, T0 + 5);
    expect(set).toMatchObject({ code, agent_url: AGENT, agent_status: "RUNNING", agent_updated_at: T0 + 5 });
    expect((await core.getTask(env.DB, code)).task).toMatchObject({
      agent_url: AGENT, agent_status: "RUNNING", agent_updated_at: T0 + 5, status: "assigned",
    });
    const listed = await core.listMyTasks(env.DB, peter, "assigned", T0 + 5);
    expect(listed.tasks.find((t) => t.code === code)).toMatchObject({
      agent_url: AGENT, agent_status: "RUNNING", agent_updated_at: T0 + 5,
    });

    const kept = await core.setAgent(env.DB, peter, { task: code, status: "FINISHED" }, T0 + 6);
    expect(kept).toMatchObject({ agent_url: AGENT, agent_status: "FINISHED", agent_updated_at: T0 + 6 });

    const cleared = await core.setAgent(env.DB, peter, { task: code, agent_url: null, status: "" }, T0 + 7);
    expect(cleared).toMatchObject({ agent_url: null, agent_status: null, agent_updated_at: T0 + 7 });
    expect((await core.getTask(env.DB, code)).task).toMatchObject({
      agent_url: null, agent_status: null, agent_updated_at: T0 + 7, status: "assigned",
    });
  });

  it("rejects a non-https agent_url and leaves the row unchanged", async () => {
    const code = await taskFor("peter", "bad agent url");
    const peter = await member("peter");
    for (const agent_url of ["http://cursor.com/agents/bc-abc", "javascript:alert(1)", "not a url", "ftp://files.example/a"]) {
      const err = await core.setAgent(env.DB, peter, { task: code, agent_url }, T0 + 1).catch((e) => e);
      expect(err, agent_url).toMatchObject({ code: "BAD_REQUEST" });
      expect(err.message, agent_url).toMatch(/https/);
    }
    expect((await core.getTaskRow(env.DB, code)).agent_url).toBeNull();
    const empty = await core.setAgent(env.DB, peter, { task: code }, T0 + 2).catch((e) => e);
    expect(empty).toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("set_agent auth matches task editors plus the reviewer", () => {
  it("allows assignee, reviewer, and a leader, and rejects everyone else", async () => {
    const code = await taskFor("peter", "who may attach");
    const peter = await member("peter");
    await core.reportStatus(env.DB, peter, { task: code, status: "in_progress" }, T0 + 1);
    await core.reportStatus(env.DB, peter, { task: code, status: "review", reviewer: "quinn", links: [OUTPUT] }, T0 + 2);

    const jane = await core.setAgent(env.DB, await member("jane"), { task: code, agent_url: AGENT, status: "RUNNING" }, T0 + 3).catch((e) => e);
    expect(jane).toMatchObject({ code: "FORBIDDEN", httpStatus: 403 });
    expect((await core.getTaskRow(env.DB, code)).agent_url).toBeNull();

    await expect(core.setAgent(env.DB, await member("quinn"), { task: code, agent_url: AGENT, status: "RUNNING" }, T0 + 4))
      .resolves.toMatchObject({ agent_url: AGENT, agent_status: "RUNNING" });
    await expect(core.setAgent(env.DB, peter, { task: code, status: "PAUSED" }, T0 + 5))
      .resolves.toMatchObject({ agent_url: AGENT, agent_status: "PAUSED" });
    await expect(core.setAgent(env.DB, await member("olivia"), { task: code, status: "RUNNING" }, T0 + 6))
      .resolves.toMatchObject({ agent_status: "RUNNING" });
    await expect(core.setAgent(env.DB, await member("lily"), { task: code, agent_url: null, status: null }, T0 + 7))
      .resolves.toMatchObject({ agent_url: null, agent_status: null });
  });
});

describe("mcp set_agent", () => {
  it("sets and clears through MCP and returns the fields from get_task and list_my_tasks", async () => {
    const harry = await issueToken("harry");
    const f = (await mcpCall(harry, "create_feature", { module: "STS-CORE", title: "mcp agent" })).data.code;
    const code = (await mcpCall(harry, "create_task", {
      feature: f, title: "mcp agent task", assignee: "peter", ...fullRequest,
    })).data.code;
    const peter = await issueToken("peter");
    const jane = await issueToken("jane");

    const denied = await mcpCall(jane, "set_agent", { task: code, agent_url: AGENT, status: "RUNNING" });
    expect(denied.isError).toBe(true);
    expect(denied.data).toMatchObject({ error: "FORBIDDEN", status: 403 });

    const bad = await mcpCall(peter, "set_agent", { task: code, agent_url: "http://cursor.com/agents/bc-nope" });
    expect(bad.isError).toBe(true);
    expect(bad.data).toMatchObject({ error: "BAD_REQUEST", status: 400 });
    expect(bad.data.message).toMatch(/https/);

    const set = await mcpCall(peter, "set_agent", { task: code, agent_url: AGENT, status: "RUNNING" });
    expect(set.isError).toBe(false);
    expect(set.data).toMatchObject({ agent_url: AGENT, agent_status: "RUNNING" });
    expect((await mcpCall(peter, "get_task", { code })).data.task).toMatchObject({
      agent_url: AGENT, agent_status: "RUNNING",
    });
    const mine = await mcpCall(peter, "list_my_tasks", { status: "backlog" });
    expect(mine.data.tasks.find((t: { code: string }) => t.code === code)).toMatchObject({
      agent_url: AGENT, agent_status: "RUNNING",
    });

    const cleared = await mcpCall(peter, "set_agent", { task: code, agent_url: null, status: null });
    expect(cleared.isError).toBe(false);
    expect(cleared.data).toMatchObject({ agent_url: null, agent_status: null });
    expect((await mcpCall(peter, "get_task", { code })).data.task).toMatchObject({
      agent_url: null, agent_status: null,
    });
  });
});

describe("task page agent block", () => {
  it("shows the link and bot-reported status when CURSOR_API_KEY is missing", async () => {
    const code = await taskFor("peter", "page without key");
    await core.setAgent(env.DB, await member("peter"), {
      task: code, agent_url: AGENT, status: "<b>bot-queued</b>",
    }, T0);
    const calls = mockCursor(() => {
      throw new Error("cursor api must not be called without a key");
    });
    const { status, html } = await taskPage(code);
    expect(status).toBe(200);
    expect(calls).toHaveLength(0);
    expect(html).toContain("<h3>Agent</h3>");
    expect(html).toContain(`href="${AGENT}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain("noopener");
    expect(html).toContain("&lt;b&gt;bot-queued&lt;/b&gt;");
    expect(html).not.toContain("<b>bot-queued</b>");
    expect(html).toContain("17/10 03:00");
    expect(html).not.toContain(KEY);
  });

  it("formats the reported time in the configured timezone", async () => {
    const code = await taskFor("peter", "page in org timezone");
    await core.setAgent(env.DB, await member("peter"), {
      task: code, agent_url: AGENT, status: "bot-queued",
    }, T0);
    await env.DB.prepare("UPDATE settings SET value = '420' WHERE key = 'tz_offset_minutes'").run();
    try {
      const { html } = await taskPage(code);
      expect(html).toContain("17/10 10:00");
      expect(html).not.toContain("17/10 03:00");
    } finally {
      await env.DB.prepare("UPDATE settings SET value = '0' WHERE key = 'tz_offset_minutes'").run();
    }
  });

  it("shows live status, summary, and PR when the key is set, and falls back when the API fails", async () => {
    const code = await taskFor("peter", "page with key");
    await core.setAgent(env.DB, await member("peter"), {
      task: code, agent_url: AGENT, status: "bot-queued",
    }, T0);
    const calls = mockCursor(() => Response.json({
      id: AGENT_ID,
      status: "RUNNING",
      summary: "Fixing <b>x</b>",
      target: { prUrl: PR },
    }));
    const live = await taskPage(code, KEY);
    expect(live.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.cursor.com/v0/agents/${AGENT_ID}`);
    const auth = new Headers(calls[0].init?.headers).get("authorization");
    expect(auth).toBe(`Basic ${btoa(`${KEY}:`)}`);
    expect(live.html).toContain("RUNNING");
    expect(live.html).toContain("Fixing &lt;b&gt;x&lt;/b&gt;");
    expect(live.html).not.toContain("<b>x</b>");
    expect(live.html).toContain(`href="${PR}"`);
    expect(live.html).toContain('target="_blank"');
    expect(live.html).not.toContain(KEY);
    expect(live.html).not.toContain("bot-queued");

    const again = await taskPage(code, KEY);
    expect(again.html).toContain("RUNNING");
    expect(calls).toHaveLength(1);

    const other = "https://cursor.com/agents/bc-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await core.setAgent(env.DB, await member("peter"), { task: code, agent_url: other, status: "bot-queued" }, T0);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://api.cursor.com/")) return new Response("nope", { status: 500 });
      return originalFetch(input, init);
    }) as typeof fetch;
    const failed = await taskPage(code, KEY);
    expect(failed.html).toContain("bot-queued");
    expect(failed.html).toContain("17/10 03:00");
    expect(failed.html).toContain(`href="${other}"`);
    expect(failed.html).not.toContain("RUNNING");
    expect(failed.html).not.toContain(KEY);
  });

  it("waits up to 6s and caches a failed Cursor response so the next page load does not call again", async () => {
    const agentUrl = "https://cursor.com/agents/bc-fail0000-1111-2222-3333-444444444444";
    const code = await taskFor("peter", "cache api failure");
    await core.setAgent(env.DB, await member("peter"), { task: code, agent_url: agentUrl, status: "bot-queued" }, T0);
    const timeouts: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return realTimeout(ms);
    });
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://api.cursor.com/")) {
        calls++;
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return new Response("nope", { status: 502 });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const first = await taskPage(code, KEY);
      expect(first.html).toContain("bot-queued");
      expect(first.html).toContain("17/10 03:00");
      expect(first.html).not.toContain(KEY);
      expect(calls).toBe(1);
      expect(timeouts).toEqual([6_000]);
      const second = await taskPage(code, KEY);
      expect(second.html).toContain("bot-queued");
      expect(second.html).not.toContain(KEY);
      expect(calls).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("caches a Cursor timeout so the next page load does not call the API again", async () => {
    const agentUrl = "https://cursor.com/agents/bc-time0000-1111-2222-3333-444444444444";
    const code = await taskFor("peter", "cache api timeout");
    await core.setAgent(env.DB, await member("peter"), { task: code, agent_url: agentUrl, status: "bot-queued" }, T0);
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://api.cursor.com/")) {
        calls++;
        throw new DOMException("The operation was aborted", "AbortError");
      }
      return originalFetch(input);
    }) as typeof fetch;
    const first = await taskPage(code, KEY);
    expect(first.html).toContain("bot-queued");
    expect(first.html).not.toContain(KEY);
    expect(calls).toBe(1);
    const second = await taskPage(code, KEY);
    expect(second.html).toContain("bot-queued");
    expect(calls).toBe(1);
  });

  it("does not call Cursor for a non-cursor https link, and shows an empty agent block when unset", async () => {
    const code = await taskFor("peter", "plain link");
    await core.setAgent(env.DB, await member("peter"), {
      task: code, agent_url: "https://example.com/agent/1", status: "local",
    }, T0);
    const calls = mockCursor(() => {
      throw new Error("not a cursor agent url");
    });
    const linked = await taskPage(code, KEY);
    expect(calls).toHaveLength(0);
    expect(linked.html).toContain('href="https://example.com/agent/1"');
    expect(linked.html).toContain("local");
    expect(linked.html).toContain("17/10 03:00");

    const bare = await taskFor("peter", "no agent yet");
    const empty = await taskPage(bare, KEY);
    expect(empty.html).toContain("<h3>Agent</h3>");
    expect(empty.html).toContain("—");
    expect(calls).toHaveLength(0);
  });
});
