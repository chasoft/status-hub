import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as core from "../src/core";
import { accessJwt, fullRequest, issueToken, mcpCall, member, UI, worker } from "./helpers";

const T0 = Date.UTC(2026, 9, 17, 3, 0);

async function assignedTask(assignee: string, title: string, now = T0) {
  const lily = await member("lily");
  const f = await core.createFeature(env.DB, lily, { module: "STS-CORE", title }, now);
  const created = await core.createTask(env.DB, lily, {
    feature: f.code, title, assignee, ...fullRequest,
  }, now);
  await core.reportStatus(env.DB, lily, { task: created.code, status: "assigned" }, now);
  await core.reportStatus(env.DB, await member(assignee), { task: created.code, status: "in_progress" }, now + 1);
  return created.code;
}

describe("review requires a reviewer", () => {
  it("rejects review with 400 when no reviewer is set or given, and accepts an active member", async () => {
    const code = await assignedTask("peter", "needs a reviewer");
    const peter = await member("peter");
    const missing = await core.reportStatus(env.DB, peter, { task: code, status: "review" }, T0 + 2).catch((e) => e);
    expect(missing).toMatchObject({ code: "BAD_REQUEST" });
    expect(missing.httpStatus).toBe(400);
    expect(missing.message).toMatch(/reviewer/i);
    expect((await core.getTaskRow(env.DB, code)).status).toBe("in_progress");

    const unknown = await core.reportStatus(env.DB, peter, { task: code, status: "review", reviewer: "nobody" }, T0 + 3).catch((e) => e);
    expect(unknown).toMatchObject({ code: "NOT_FOUND" });
    expect((await core.getTaskRow(env.DB, code)).status).toBe("in_progress");

    await env.DB.prepare("UPDATE members SET active = 0 WHERE id = 'daniel'").run();
    try {
      const inactive = await core.reportStatus(env.DB, peter, { task: code, status: "review", reviewer: "daniel" }, T0 + 4).catch((e) => e);
      expect(inactive).toMatchObject({ code: "NOT_FOUND" });
      expect((await core.getTaskRow(env.DB, code)).status).toBe("in_progress");
    } finally {
      await env.DB.prepare("UPDATE members SET active = 1 WHERE id = 'daniel'").run();
    }

    await expect(core.reportStatus(env.DB, peter, { task: code, status: "review", reviewer: " quinn ", links: ["https://example.com/output/review"] }, T0 + 5))
      .resolves.toMatchObject({ from: "in_progress", to: "review" });
    expect((await core.getTask(env.DB, code)).task.reviewer_id).toBe("quinn");

    await core.reportStatus(env.DB, peter, { task: code, status: "in_progress" }, T0 + 6);
    await core.reportStatus(env.DB, peter, { task: code, status: "review", links: ["https://example.com/output/review"] }, T0 + 7);
    expect((await core.getTaskRow(env.DB, code)).reviewer_id).toBe("quinn");

    await core.reportStatus(env.DB, peter, { task: code, status: "in_progress" }, T0 + 8);
    await core.reportStatus(env.DB, peter, { task: code, status: "review", reviewer: "mira", links: ["https://example.com/output/review"] }, T0 + 9);
    expect((await core.getTaskRow(env.DB, code)).reviewer_id).toBe("mira");
  });

  it("shows the reviewer on the kanban card and the task page", async () => {
    const code = await assignedTask("peter", "visible reviewer", Date.now());
    await core.reportStatus(env.DB, await member("peter"), { task: code, status: "review", reviewer: "jennifer", links: ["https://example.com/output/review"] }, Date.now());
    const h = { "Cf-Access-Jwt-Assertion": await accessJwt("owner@example.com") };
    const board = await (await worker.fetch(`${UI}/?project=STS`, { headers: h })).text();
    expect(board).toContain(code);
    expect(board).toContain("reviewer jennifer");
    const page = await (await worker.fetch(`${UI}/t/${code}`, { headers: h })).text();
    expect(page).toContain("Reviewer");
    expect(page).toContain(">jennifer<");
  });
});

describe("mcp reviewer and list_my_tasks", () => {
  it("report_status and list_my_tasks accept reviewer, a status array, and role", async () => {
    const harry = await issueToken("harry");
    const f = (await mcpCall(harry, "create_feature", { module: "STS-CORE", title: "mcp reviewer" })).data.code;
    const t = (await mcpCall(harry, "create_task", {
      feature: f, title: "mcp review", assignee: "peter", ...fullRequest,
    })).data.code;
    const peter = await issueToken("peter");
    await mcpCall(harry, "report_status", { task: t, status: "assigned" });
    await mcpCall(peter, "report_status", { task: t, status: "in_progress" });
    const bad = await mcpCall(peter, "report_status", { task: t, status: "review" });
    expect(bad.isError).toBe(true);
    expect(bad.data).toMatchObject({ error: "BAD_REQUEST", status: 400 });
    expect(bad.data.message).toMatch(/reviewer/i);
    const ok = await mcpCall(peter, "report_status", { task: t, status: "review", reviewer: "quinn", links: ["https://example.com/output/review"] });
    expect(ok.isError).toBe(false);
    expect(ok.data).toMatchObject({ to: "review", reviewer_id: "quinn" });
    const got = await mcpCall(peter, "get_task", { code: t });
    expect(got.data.task.reviewer_id).toBe("quinn");
    const quinn = await issueToken("quinn");
    const listed = await mcpCall(quinn, "list_my_tasks", { status: ["in_progress", "review"], role: "reviewer", limit: 50, offset: 0 });
    expect(listed.isError).toBe(false);
    expect(listed.data.tasks.find((x: { code: string }) => x.code === t)).toMatchObject({ role: "reviewer", reviewer_id: "quinn" });
  });
});

describe("list_my_tasks filters and pages", () => {
  it("filters by status array and role, and returns role per row", async () => {
    const lily = await member("lily");
    const anna = await member("anna");
    const mine = await assignedTask("anna", "anna doing");
    const review = await assignedTask("ethan", "anna reviews");
    await core.reportStatus(env.DB, await member("ethan"), { task: review, status: "review", reviewer: "anna", links: ["https://example.com/output/review"] }, T0 + 2);
    const other = await assignedTask("peter", "not anna");
    const done = await assignedTask("anna", "anna done");
    await core.reportStatus(env.DB, anna, { task: done, status: "review", reviewer: "quinn", links: ["https://example.com/output/review"] }, T0 + 3);
    await core.reportStatus(env.DB, anna, { task: done, status: "done", note: "xong" }, T0 + 4);
    const both = await assignedTask("anna", "anna both");
    await core.reportStatus(env.DB, anna, { task: both, status: "review", reviewer: "anna", links: ["https://example.com/output/review"] }, T0 + 5);

    const asAssignee = await core.listMyTasks(env.DB, anna, "in_progress", T0 + 10);
    const assigneeCodes = asAssignee.tasks.map((t) => t.code);
    expect(assigneeCodes).toContain(mine);
    expect(assigneeCodes).not.toContain(review);
    expect(assigneeCodes).not.toContain(other);
    expect(asAssignee.tasks.find((t) => t.code === mine)?.role).toBe("assignee");

    const asReviewer = await core.listMyTasks(env.DB, anna, { status: "review", role: "reviewer" }, T0 + 10);
    expect(asReviewer.tasks.map((t) => t.code).sort()).toEqual([both, review].sort());
    expect(asReviewer.tasks.find((t) => t.code === review)?.role).toBe("reviewer");
    expect(asReviewer.tasks.find((t) => t.code === both)?.role).toBe("both");

    const any = await core.listMyTasks(env.DB, anna, { status: ["in_progress", "review"], role: "any" }, T0 + 10);
    const anyCodes = any.tasks.map((t) => t.code);
    expect(anyCodes).toEqual(expect.arrayContaining([mine, review, both]));
    expect(anyCodes).not.toContain(other);
    expect(anyCodes).not.toContain(done);
    expect(any.tasks.find((t) => t.code === mine)?.role).toBe("assignee");

    const open = await core.listMyTasks(env.DB, anna, { role: "assignee" }, T0 + 10);
    expect(open.tasks.map((t) => t.code)).not.toContain(done);
    expect(open.tasks.map((t) => t.code)).not.toContain(review);

    expect(lily.id).toBe("lily");
  });

  it("pages with limit (default 50, max 200) and offset instead of a 20 cap", async () => {
    const anna = await member("anna");
    const f = await core.createFeature(env.DB, await member("lily"), { module: "STS-CORE", title: "page me" }, T0);
    const stmts = [];
    for (let i = 1; i <= 25; i++) {
      const code = `${f.code}.${i}`;
      stmts.push(env.DB.prepare(
        `INSERT INTO tasks (code, feature_code, project_code, title, assignee_id, status, created_by, created_at, last_update_at)
         VALUES (?, ?, 'STS', ?, 'anna', 'in_progress', 'lily', ?, ?)`,
      ).bind(code, f.code, `page ${i}`, T0, T0 + i));
    }
    await env.DB.batch(stmts);

    const all = await core.listMyTasks(env.DB, anna, { status: "in_progress", role: "assignee" }, T0 + 100);
    const pageCodes = all.tasks.map((t) => t.code).filter((c) => c.startsWith(`${f.code}.`));
    expect(pageCodes).toHaveLength(25);
    expect(pageCodes[0]).toBe(`${f.code}.25`);

    const page = await core.listMyTasks(env.DB, anna, { status: "in_progress", limit: 10, offset: 20 }, T0 + 100);
    const sliced = page.tasks.map((t) => t.code).filter((c) => c.startsWith(`${f.code}.`));
    expect(sliced).toEqual([5, 4, 3, 2, 1].map((i) => `${f.code}.${i}`));

    const tooBig = await core.listMyTasks(env.DB, anna, { limit: 201 }).catch((e) => e);
    expect(tooBig).toMatchObject({ code: "BAD_REQUEST" });
    const badOff = await core.listMyTasks(env.DB, anna, { offset: -1 }).catch((e) => e);
    expect(badOff).toMatchObject({ code: "BAD_REQUEST" });
  });
});
