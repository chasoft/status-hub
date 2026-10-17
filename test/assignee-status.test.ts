import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as core from "../src/core";
import { accessJwt, fullRequest, issueToken, mcpCall, member, UI, worker } from "./helpers";

const T0 = Date.UTC(2026, 9, 17, 3, 0); // 10:00 UTC+7
const MIN = 60_000;

async function backlogTask(assignee?: string, extra: { due_at?: number; title?: string } = {}, now = T0) {
  const lily = await member("lily");
  const f = await core.createFeature(env.DB, lily, { module: "STS-CORE", title: "backlog owner" }, now);
  const t = await core.createTask(env.DB, lily, {
    feature: f.code, title: extra.title ?? "keep backlog", assignee, due_at: extra.due_at, ...fullRequest,
  }, now);
  return { lily, f, t };
}

const openRules = async (code: string) =>
  (await env.DB.prepare("SELECT rule FROM alerts WHERE task_code = ? AND cleared_at IS NULL ORDER BY rule").bind(code).all<{ rule: string }>())
    .results.map((r) => r.rule);

describe("assignee does not change status", () => {
  it("create_task with an assignee stays in backlog", async () => {
    const { t } = await backlogTask("peter");
    expect(t.status).toBe("backlog");
    const row = await core.getTaskRow(env.DB, t.code);
    expect(row).toMatchObject({ status: "backlog", assignee_id: "peter", assigned_at: null });
    expect((await core.getPeriods(env.DB, t.code)).map((p) => p.status)).toEqual(["backlog"]);
  });

  it("assign_task on a backlog task keeps backlog", async () => {
    const { t } = await backlogTask();
    const lily = await member("lily");
    const out = await core.assignTask(env.DB, lily, { task: t.code, assignee: "ethan" }, T0 + MIN);
    expect(out).toMatchObject({ status: "backlog", assignee: "ethan" });
    const row = await core.getTaskRow(env.DB, t.code);
    expect(row).toMatchObject({ status: "backlog", assignee_id: "ethan", assigned_at: null, started_at: null });
    expect((await core.getPeriods(env.DB, t.code)).map((p) => [p.status, p.ended_at])).toEqual([["backlog", null]]);
  });

  it("assign_task on an in-progress task does not bounce it to assigned", async () => {
    const { t } = await backlogTask("peter");
    const lily = await member("lily");
    const peter = await member("peter");
    await core.reportStatus(env.DB, lily, { task: t.code, status: "assigned" }, T0 + MIN);
    await core.reportStatus(env.DB, peter, { task: t.code, status: "in_progress" }, T0 + 2 * MIN);
    const out = await core.assignTask(env.DB, lily, { task: t.code, assignee: "ethan" }, T0 + 3 * MIN);
    expect(out.status).toBe("in_progress");
    const row = await core.getTaskRow(env.DB, t.code);
    expect(row).toMatchObject({ status: "in_progress", assignee_id: "ethan", started_at: T0 + 2 * MIN });
    expect((await core.getPeriods(env.DB, t.code)).map((p) => p.status)).toEqual(["backlog", "assigned", "in_progress"]);
  });

  it("only report_status moves backlog to assigned; NOT_STARTED waits for that status", async () => {
    const { t } = await backlogTask("quinn", { due_at: T0 + 48 * 60 * MIN });
    const quinn = await member("quinn");
    await expect(core.reportStatus(env.DB, quinn, { task: t.code, status: "in_progress" }, T0 + MIN))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await core.runChecks(env.DB, T0 + 20 * MIN);
    expect(await openRules(t.code)).toEqual([]);

    const moved = await core.reportStatus(env.DB, quinn, { task: t.code, status: "assigned" }, T0 + 21 * MIN);
    expect(moved).toMatchObject({ from: "backlog", to: "assigned" });
    expect((await core.getTaskRow(env.DB, t.code)).assigned_at).toBe(T0 + 21 * MIN);

    await core.runChecks(env.DB, T0 + 21 * MIN + 14 * MIN);
    expect(await openRules(t.code)).toEqual([]);
    await core.runChecks(env.DB, T0 + 21 * MIN + 16 * MIN);
    expect(await openRules(t.code)).toEqual(["NOT_STARTED"]);
  });

  it("reassigning an assigned task keeps status and resets the NOT_STARTED clock", async () => {
    const { t } = await backlogTask("peter");
    const lily = await member("lily");
    await core.reportStatus(env.DB, lily, { task: t.code, status: "assigned" }, T0);
    await core.runChecks(env.DB, T0 + 20 * MIN);
    expect(await openRules(t.code)).toEqual(["NOT_STARTED"]);

    const out = await core.assignTask(env.DB, lily, { task: t.code, assignee: "ethan" }, T0 + 20 * MIN);
    expect(out.status).toBe("assigned");
    expect((await core.getTaskRow(env.DB, t.code)).assigned_at).toBe(T0 + 20 * MIN);
    expect(await openRules(t.code)).toEqual([]);
    await core.runChecks(env.DB, T0 + 30 * MIN);
    expect(await openRules(t.code)).toEqual([]);
    await core.runChecks(env.DB, T0 + 20 * MIN + 16 * MIN);
    expect(await openRules(t.code)).toEqual(["NOT_STARTED"]);
  });

  it("OVERDUE still fires for a backlog task that has an assignee", async () => {
    const { t } = await backlogTask("jane", { due_at: T0 - MIN });
    await core.runChecks(env.DB, T0 + 20 * MIN);
    expect(await openRules(t.code)).toEqual(["OVERDUE"]);
  });

  it("MCP create and assign keep status; list_my_tasks shows backlog only when asked", async () => {
    const harry = await issueToken("harry");
    const f = (await mcpCall(harry, "create_feature", { module: "STS-CORE", title: "mcp backlog" })).data.code;
    const created = await mcpCall(harry, "create_task", { feature: f, title: "owned backlog", assignee: "ethan", ...fullRequest });
    expect(created.isError).toBe(false);
    expect(created.data.status).toBe("backlog");
    const code = created.data.code as string;

    const assigned = await mcpCall(harry, "assign_task", { task: code, assignee: "peter" });
    expect(assigned.data).toMatchObject({ status: "backlog", assignee: "peter" });

    const peter = await issueToken("peter");
    const open = await mcpCall(peter, "list_my_tasks");
    expect(open.data.tasks.map((x: { code: string }) => x.code)).not.toContain(code);
    const backlog = await mcpCall(peter, "list_my_tasks", { status: "backlog" });
    expect(backlog.data.tasks.map((x: { code: string }) => x.code)).toContain(code);

    const moved = await mcpCall(harry, "report_status", { task: code, status: "assigned" });
    expect(moved.data).toMatchObject({ from: "backlog", to: "assigned" });
  });

  it("Kanban keeps a backlog task with an assignee in the Backlog column", async () => {
    const { t } = await backlogTask("mira", { title: "Kanban backlog owner" }, Date.now() - 5 * MIN);
    const h = { "Cf-Access-Jwt-Assertion": await accessJwt("owner@example.com") };
    const body = await (await worker.fetch(`${UI}/?project=STS`, { headers: h })).text();
    expect(body).toMatch(new RegExp(`class="card s-backlog"[^>]*>[\\s\\S]*?${t.code}`));
    expect(body).not.toMatch(new RegExp(`class="card s-assigned"[^>]*>[\\s\\S]*?${t.code}`));
    const card = body.match(new RegExp(`<a class="card s-backlog"[^>]*>[\\s\\S]*?${t.code}[\\s\\S]*?</a>`))?.[0] ?? "";
    expect(card).toContain("👤 mira");
    expect(card).toContain("Kanban backlog owner");

    const filtered = await (await worker.fetch(`${UI}/?project=STS&member=mira`, { headers: h })).text();
    expect(filtered).toMatch(new RegExp(`class="card s-backlog"[^>]*>[\\s\\S]*?${t.code}`));
  });
});
