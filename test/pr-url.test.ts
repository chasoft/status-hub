import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as core from "../src/core";
import { accessJwt, fullRequest, issueToken, mcpCall, member, UI, worker } from "./helpers";

const PR = "https://github.com/example/repo/pull/7";

async function feature(title: string) {
  const lily = await member("lily");
  return core.createFeature(env.DB, lily, { module: "STS-CORE", title });
}

describe("pr_url on create and edit", () => {
  it("create_task stores pr_url", async () => {
    const lily = await member("lily");
    const f = await feature("create with pr");
    const t = await core.createTask(env.DB, lily, {
      feature: f.code, title: "open with pr", assignee: "peter",
      pr_url: PR, links: [PR],
    });
    expect(t.pr_url).toBe(PR);
    expect((await core.getTaskRow(env.DB, t.code)).pr_url).toBe(PR);
    const up = await env.DB.prepare("SELECT links FROM updates WHERE task_code = ?").bind(t.code).first<{ links: string }>();
    expect(JSON.parse(up!.links)).toEqual([PR]);
  });

  it("update_task replaces pr_url without changing status", async () => {
    const lily = await member("lily");
    const f = await feature("edit pr");
    const t = await core.createTask(env.DB, lily, { feature: f.code, title: "edit me", assignee: "peter", ...fullRequest });
    const next = "https://github.com/example/repo/pull/8";
    expect(await core.updateTask(env.DB, lily, { task: t.code, pr_url: next })).toMatchObject({ pr_url: next });
    const row = await core.getTaskRow(env.DB, t.code);
    expect(row.pr_url).toBe(next);
    expect(row.status).toBe("backlog");
  });

  it("rejects a URL that is not http(s)", async () => {
    const lily = await member("lily");
    const f = await feature("reject bad url");
    await expect(core.createTask(env.DB, lily, { feature: f.code, title: "ftp", pr_url: "ftp://example.com/a" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/http hoặc https/) });
    await expect(core.createTask(env.DB, lily, { feature: f.code, title: "js", pr_url: "javascript:alert(1)" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    const t = await core.createTask(env.DB, lily, { feature: f.code, title: "then edit" });
    await expect(core.updateTask(env.DB, lily, { task: t.code, pr_url: "not a url" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/http hoặc https/) });
    expect((await core.getTaskRow(env.DB, t.code)).pr_url).toBeNull();
  });

  it("update_task is 403 unless assignee or leader", async () => {
    const lily = await member("lily");
    const jane = await member("jane");
    const f = await feature("pr permission");
    const t = await core.createTask(env.DB, lily, { feature: f.code, title: "locked", assignee: "peter" });
    await expect(core.updateTask(env.DB, jane, { task: t.code, pr_url: PR })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await core.getTaskRow(env.DB, t.code)).pr_url).toBeNull();
    const peter = await member("peter");
    expect(await core.updateTask(env.DB, peter, { task: t.code, pr_url: PR })).toMatchObject({ pr_url: PR });
  });
});

describe("pr_url MCP and task form", () => {
  it("create_task and update_task accept pr_url and reject other schemes", async () => {
    const harry = await issueToken("harry");
    const f = (await mcpCall(harry, "create_feature", { module: "STS-CORE", title: "mcp pr url" })).data.code;
    const bad = await mcpCall(harry, "create_task", { feature: f, title: "nope url", pr_url: "ftp://files.example/a" });
    expect(bad.isError).toBe(true);
    expect(bad.data).toMatchObject({ error: "BAD_REQUEST" });
    expect(bad.data.message).toMatch(/http/);
    const made = await mcpCall(harry, "create_task", { feature: f, title: "with pr", assignee: "peter", pr_url: PR, links: [PR] });
    const ethan = await issueToken("ethan");
    const denied = await mcpCall(ethan, "update_task", { task: made.data.code, pr_url: "https://github.com/example/repo/pull/3" });
    expect(denied.isError).toBe(true);
    expect(denied.data).toMatchObject({ error: "FORBIDDEN", status: 403 });
    expect((await mcpCall(harry, "get_task", { code: made.data.code })).data.task.pr_url).toBe(PR);
    expect(made.isError).toBe(false);
    expect(made.data.pr_url).toBe(PR);
    const edited = await mcpCall(harry, "update_task", { task: made.data.code, pr_url: "http://example.com/pull/2" });
    expect(edited.isError).toBe(false);
    expect(edited.data.pr_url).toBe("http://example.com/pull/2");
    const again = await mcpCall(harry, "update_task", { task: made.data.code, pr_url: "javascript:alert(1)" });
    expect(again.isError).toBe(true);
    expect(again.data.error).toBe("BAD_REQUEST");
    expect(again.data.message).toMatch(/http/);
  });

  it("task-page pr form: neither assignee nor leader is 403; assignee and leader succeed", async () => {
    const harry = await issueToken("harry");
    const f = (await mcpCall(harry, "create_feature", { module: "STS-CORE", title: "ui pr auth" })).data.code;
    const code = (await mcpCall(harry, "create_task", { feature: f, title: "ui task", assignee: "peter" })).data.code;
    const post = async (email: string, pr: string, extra: Record<string, string> = {}) => worker.fetch(`${UI}/t/${code}`, {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": await accessJwt(email), "content-type": "application/x-www-form-urlencoded", ...extra },
      body: "pr_url=" + encodeURIComponent(pr),
      redirect: "manual",
    });
    const anon = await worker.fetch(`${UI}/t/${code}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "pr_url=" + encodeURIComponent(PR),
    });
    expect(anon.status).toBe(403);
    const jane = await post("jane@example.com", PR);
    expect(jane.status).toBe(403);
    expect((await mcpCall(harry, "get_task", { code })).data.task.pr_url).toBeNull();
    const assignee = await post("peter@example.com", PR);
    expect(assignee.status).toBe(303);
    expect((await mcpCall(harry, "get_task", { code })).data.task.pr_url).toBe(PR);
    const next = "https://github.com/example/repo/pull/8";
    const leader = await post("harry@example.com", next);
    expect(leader.status).toBe(303);
    expect((await mcpCall(harry, "get_task", { code })).data.task.pr_url).toBe(next);
    const bad = await post("peter@example.com", "javascript:alert(1)");
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("http hoặc https");
    expect((await mcpCall(harry, "get_task", { code })).data.task.pr_url).toBe(next);
    const cross = await post("harry@example.com", "https://github.com/example/repo/pull/9", { origin: "https://evil.example" });
    expect(cross.status).toBe(403);
    expect((await mcpCall(harry, "get_task", { code })).data.task.pr_url).toBe(next);
    const crossSite = await post("harry@example.com", "https://github.com/example/repo/pull/9", { origin: "null", "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);
    expect((await mcpCall(harry, "get_task", { code })).data.task.pr_url).toBe(next);
    // Real Chrome form POST: Origin is "null" because the page sets Referrer-Policy: no-referrer.
    const chrome = await post("harry@example.com", PR, { origin: "null", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" });
    expect(chrome.status).toBe(303);
    expect((await mcpCall(harry, "get_task", { code })).data.task.pr_url).toBe(PR);
  });
});
