import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as core from "../src/core";
import { accessJwt, fullRequest, issueToken, mcpCall, member, UI, worker } from "./helpers";

const T0 = Date.UTC(2026, 9, 17, 3, 0);

async function feature(title: string) {
  const lily = await member("lily");
  return core.createFeature(env.DB, lily, { module: "STS-CORE", title }, T0);
}

describe("STS-CORE-001.6 pending_approval", () => {
  it("lets any member create straight into pending_approval", async () => {
    const f = await feature("member create");
    const peter = await member("peter");
    const t = await core.createTask(env.DB, peter, {
      feature: f.code, title: "bot đề xuất", assignee: "ethan", ...fullRequest,
    }, T0);
    expect(t.status).toBe("pending_approval");
    const row = await core.getTaskRow(env.DB, t.code);
    expect(row).toMatchObject({ status: "pending_approval", assignee_id: "ethan", assigned_at: null });
    const note = await env.DB.prepare("SELECT note, status_to FROM updates WHERE task_code = ?").bind(t.code).first<{ note: string; status_to: string }>();
    expect(note).toMatchObject({ status_to: "pending_approval", note: "tạo task chờ duyệt, đề xuất giao ethan" });
  });

  it("forbids a non-admin from requesting another status when the request is complete", async () => {
    const f = await feature("non-admin status");
    const my = await member("my");
    await expect(core.createTask(env.DB, my, {
      feature: f.code, title: "muốn assigned", assignee: "peter", status: "assigned", ...fullRequest,
    }, T0)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("admin with a complete request stays backlog; an explicit status assigned can start without approved_by", async () => {
    const f = await feature("admin normal");
    const lily = await member("lily");
    const held = await core.createTask(env.DB, lily, {
      feature: f.code, title: "có người nhưng backlog", assignee: "peter", ...fullRequest,
    }, T0);
    expect(held.status).toBe("backlog");
    expect((await core.getTaskRow(env.DB, held.code)).assigned_at).toBeNull();
    const t = await core.createTask(env.DB, lily, {
      feature: f.code, title: "làm ngay", assignee: "peter", status: "assigned", ...fullRequest,
    }, T0 + 1);
    expect(t.status).toBe("assigned");
    const peter = await member("peter");
    const moved = await core.reportStatus(env.DB, peter, { task: t.code, status: "in_progress" }, T0 + 2);
    expect(moved).toMatchObject({ from: "assigned", to: "in_progress", approved_by: null });
  });

  it("approves and rejects only as admin, with approved_by, and a note on reject", async () => {
    const f = await feature("approve reject");
    const peter = await member("peter");
    const my = await member("my");
    const lily = await member("lily");
    const pending = await core.createTask(env.DB, peter, { feature: f.code, title: "chờ duyệt", assignee: "peter" }, T0);

    await expect(core.reportStatus(env.DB, peter, { task: pending.code, status: "assigned", approved_by: "owner" }, T0 + 1))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("chỉ admin") });
    await expect(core.reportStatus(env.DB, my, { task: pending.code, status: "backlog", approved_by: "approver" }, T0 + 1))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(core.reportStatus(env.DB, lily, { task: pending.code, status: "backlog" }, T0 + 1))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("approved_by") });
    await expect(core.reportStatus(env.DB, lily, { task: pending.code, status: "in_progress", approved_by: "owner" }, T0 + 1))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(core.reportStatus(env.DB, lily, { task: pending.code, status: "cancelled", approved_by: "owner" }, T0 + 1))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("note") });
    await expect(core.reportStatus(env.DB, peter, { task: pending.code, status: "pending_approval" }, T0 + 1))
      .rejects.toMatchObject({ code: "FORBIDDEN", httpStatus: 403 });

    const approved = await core.reportStatus(env.DB, lily, {
      task: pending.code, status: "assigned", approved_by: "owner", note: "anh duyệt",
    }, T0 + 2);
    expect(approved).toMatchObject({ from: "pending_approval", to: "assigned", approved_by: "owner" });
    const upd = await env.DB.prepare("SELECT approved_by, status_to FROM updates WHERE task_code = ? AND status_to = 'assigned'").bind(pending.code).first();
    expect(upd).toMatchObject({ approved_by: "owner", status_to: "assigned" });
    expect((await core.getTaskRow(env.DB, pending.code)).assigned_at).toBe(T0 + 2);

    const rejectMe = await core.createTask(env.DB, peter, { feature: f.code, title: "từ chối" }, T0 + 3);
    const rejected = await core.reportStatus(env.DB, lily, {
      task: rejectMe.code, status: "cancelled", approved_by: "approver", note: "không làm",
    }, T0 + 4);
    expect(rejected).toMatchObject({ to: "cancelled", approved_by: "approver" });
    expect((await core.getTaskRow(env.DB, rejectMe.code)).status).toBe("cancelled");
  });

  it("refuses assign_task and blockers on pending_approval, and rejects kind need_approval", async () => {
    const f = await feature("no blocker");
    const peter = await member("peter");
    const my = await member("my");
    const pending = await core.createTask(env.DB, peter, { feature: f.code, title: "chưa duyệt", assignee: "peter" }, T0);
    await expect(core.assignTask(env.DB, my, { task: pending.code, assignee: "ethan" }, T0 + 1))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("pending_approval") });
    await expect(core.setBlocker(env.DB, peter, { task: pending.code, kind: "access", waiting_on: "harry", detail: "khoá" }, T0 + 1))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("không gắn blocker") });

    const lily = await member("lily");
    const working = await core.createTask(env.DB, lily, {
      feature: f.code, title: "đang làm", assignee: "peter", ...fullRequest,
    }, T0);
    await expect(core.setBlocker(env.DB, peter, { task: working.code, kind: "need_approval", waiting_on: "owner", detail: "chờ duyệt" }, T0 + 1))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("pending_approval") });

    await env.DB.prepare(
      "INSERT INTO blockers (task_code, raised_by, kind, waiting_on, detail, opened_at) VALUES (?, ?, 'need_approval', 'owner', 'cũ', ?)",
    ).bind(working.code, "peter", T0).run();
    const got = await core.getTask(env.DB, working.code);
    expect(got.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "need_approval", detail: "cũ" })]));
  });

  it("does not raise alerts for a pending_approval task", async () => {
    const f = await feature("no alerts");
    const peter = await member("peter");
    const t = await core.createTask(env.DB, peter, {
      feature: f.code, title: "quá hạn nhưng chờ", assignee: "peter", due_at: T0 - 60_000,
    }, T0 - 3 * 3_600_000);
    await core.runChecks(env.DB, T0);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE task_code = ?").bind(t.code).first<{ n: number }>();
    expect(n!.n).toBe(0);
    const mine = await core.listMyTasks(env.DB, peter);
    expect(mine.tasks.map((x) => x.code)).not.toContain(t.code);
  });
});

describe("STS-CORE-001.9 request fields", () => {
  it("forces pending_approval when any request field is missing and ignores the requested status", async () => {
    const f = await feature("missing fields");
    const lily = await member("lily");
    for (const partial of [
      { requested_at: fullRequest.requested_at, request_link: fullRequest.request_link },
      { requested_by: "owner" as const, request_link: fullRequest.request_link },
      { requested_by: "approver" as const, requested_at: fullRequest.requested_at },
    ]) {
      const t = await core.createTask(env.DB, lily, {
        feature: f.code, title: "thiếu một trường", assignee: "peter", status: "assigned", ...partial,
      }, T0);
      expect(t.status).toBe("pending_approval");
    }
    const lily2 = await core.createTask(env.DB, lily, {
      feature: f.code, title: "admin không field", assignee: "peter", status: "backlog",
    }, T0);
    expect(lily2.status).toBe("pending_approval");
  });

  it("blocks leaving pending_approval except through approval", async () => {
    const f = await feature("blocked leave");
    const lily = await member("lily");
    const t = await core.createTask(env.DB, lily, {
      feature: f.code, title: "thiếu link", assignee: "peter", requested_by: "my", requested_at: T0,
    }, T0);
    expect(t.status).toBe("pending_approval");
    await expect(core.reportStatus(env.DB, lily, { task: t.code, status: "assigned" }, T0 + 1))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(core.assignTask(env.DB, lily, { task: t.code, assignee: "peter" }, T0 + 1))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    const ok = await core.reportStatus(env.DB, lily, {
      task: t.code, status: "backlog", approved_by: "owner", note: "đủ rồi",
    }, T0 + 2);
    expect(ok.to).toBe("backlog");
  });

  it("rejects an invalid request_link or requested_by even when other fields are missing", async () => {
    const f = await feature("bad request");
    const lily = await member("lily");
    await expect(core.createTask(env.DB, lily, {
      feature: f.code, title: "link sai", request_link: "ftp://files.example/req",
    }, T0)).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("link không hợp lệ") });
    await expect(core.createTask(env.DB, lily, {
      feature: f.code, title: "người sai", requested_by: "lily",
    }, T0)).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("requested_by") });
    await expect(core.createTask(env.DB, lily, {
      feature: f.code, title: "giờ sai", requested_at: 1.5,
    }, T0)).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("epoch ms") });
  });

  it("stores a complete request and shows it on the task page", async () => {
    const f = await feature("ui create");
    const h = { "Cf-Access-Jwt-Assertion": await accessJwt("owner@example.com") };
    const form = await worker.fetch(`${UI}/new`, { headers: h });
    expect(form.status).toBe(200);
    expect(await form.text()).toContain("New task");

    const missing = await worker.fetch(`${UI}/new`, {
      method: "POST",
      headers: { ...h, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({ feature: f.code, title: "thiếu yêu cầu", assignee: "peter", status: "assigned" }),
    });
    expect(missing.status).toBe(303);
    const missingUrl = missing.headers.get("location")!;
    const missingPage = await worker.fetch(missingUrl, { headers: h });
    const missingHtml = await missingPage.text();
    expect(missingHtml).toContain("Not set");
    const missingCode = missingUrl.split("/").pop()!;
    expect((await core.getTaskRow(env.DB, missingCode)).status).toBe("pending_approval");

    const bad = await worker.fetch(`${UI}/new`, {
      method: "POST",
      headers: { ...h, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({ feature: f.code, title: "url sai", request_link: "notaurl" }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("link không hợp lệ");

    const ok = await worker.fetch(`${UI}/new`, {
      method: "POST",
      headers: { ...h, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        feature: f.code, title: "đủ yêu cầu", assignee: "peter",
        requested_by: "owner", requested_at: String(T0), request_link: fullRequest.request_link,
      }),
    });
    expect(ok.status).toBe(303);
    const page = await (await worker.fetch(ok.headers.get("location")!, { headers: h })).text();
    expect(page).toContain("owner");
    expect(page).toContain(fullRequest.request_link);
    expect(page).toContain("17/10 03:00");
    expect(page).not.toContain("Not set");
    const code = ok.headers.get("location")!.split("/").pop()!;
    expect((await core.getTaskRow(env.DB, code)).status).toBe("backlog");
  });
});

describe("Kanban chờ duyệt", () => {
  it("puts the column before Backlog and filters by project", async () => {
    const lily = await member("lily");
    const scos = await core.createFeature(env.DB, lily, { module: "SCOS-CORE", title: "pending col" }, T0);
    const scg = await core.createFeature(env.DB, lily, { module: "SCG-CORE", title: "pending other" }, T0);
    const peter = await member("peter");
    const a = await core.createTask(env.DB, peter, { feature: scos.code, title: "chờ SCOS" }, T0);
    const b = await core.createTask(env.DB, peter, { feature: scg.code, title: "chờ SCG" }, T0);
    const h = { "Cf-Access-Jwt-Assertion": await accessJwt("approver@example.com") };
    const board = await (await worker.fetch(`${UI}/?project=SCOS`, { headers: h })).text();
    expect(board.indexOf("colh s-pending_approval")).toBeLessThan(board.indexOf("colh s-backlog"));
    expect(board).toContain(`href="/?status=pending_approval&amp;project=SCOS"`);
    expect(board).toContain(a.code);
    const filtered = await (await worker.fetch(`${UI}/?status=pending_approval&project=SCOS`, { headers: h })).text();
    expect(filtered).toContain(a.code);
    expect(filtered).not.toContain(b.code);
    expect(filtered).toContain("Pending approval");
  });

  it("exposes the status on MCP create_task", async () => {
    const harry = await issueToken("harry");
    const f = (await mcpCall(harry, "create_feature", { module: "STS-CORE", title: "mcp pending" })).data.code;
    const peter = await issueToken("peter");
    const created = await mcpCall(peter, "create_task", { feature: f, title: "từ bot peter", assignee: "ethan", ...fullRequest });
    expect(created.isError).toBe(false);
    expect(created.data.status).toBe("pending_approval");
    const denied = await mcpCall(peter, "report_status", { task: created.data.code, status: "assigned", approved_by: "owner" });
    expect(denied.data).toMatchObject({ error: "FORBIDDEN", status: 403 });
  });
});
