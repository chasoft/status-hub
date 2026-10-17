import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getHubConfig, useHubConfig } from "../src/config";
import * as core from "../src/core";
import { fullRequest, member } from "./helpers";

const T0 = Date.UTC(2026, 9, 17, 3, 0); // 10:00 UTC+7

async function setupTask(assignee = "peter", now = T0) {
  const lily = await member("lily");
  const f = await core.createFeature(env.DB, lily, { module: "SCOS-MAIL", title: "Inbox search" }, now);
  const created = await core.createTask(env.DB, lily, { feature: f.code, title: "FTS index", assignee, ...fullRequest }, now);
  // These tests start from 'assigned'. A complete request stays in backlog; the move is explicit.
  if (assignee) await core.reportStatus(env.DB, lily, { task: created.code, status: "assigned" }, now);
  return { f, t: { ...created, status: assignee ? "assigned" as const : created.status } };
}

describe("code allocation", () => {
  it("issues sequential codes in the hierarchy format", async () => {
    const { f, t } = await setupTask();
    expect(f.code).toMatch(/^SCOS-MAIL-\d{3}$/);
    expect(t.code).toBe(`${f.code}.1`);
  });

  it("parallel allocation yields no duplicates", async () => {
    const my = await member("my");
    const res = await Promise.all(
      Array.from({ length: 25 }, (_, i) => core.createFeature(env.DB, my, { module: "SCG-CORE", title: `F${i}` })),
    );
    const codes = res.map((r) => r.code);
    expect(new Set(codes).size).toBe(25);
    const nums = codes.map((c) => Number(c.split("-").pop())).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: 25 }, (_, i) => nums[0] + i));
    const f = codes[0];
    const tasks = await Promise.all(
      Array.from({ length: 10 }, (_, i) => core.createTask(env.DB, my, { feature: f, title: `T${i}`, assignee: "ethan" })),
    );
    expect(new Set(tasks.map((t) => t.code)).size).toBe(10);
  });

  it("project code must match ^[A-Z]{2,5}$ and only admins may create", async () => {
    const lily = await member("lily");
    await expect(core.createProject(env.DB, lily, { code: "TOOLONG", name: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(core.createProject(env.DB, lily, { code: "ab", name: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await core.createProject(env.DB, lily, { code: "NEW", name: "New" })).toEqual({ code: "NEW", modules: ["NEW-CORE"] });
    await expect(core.createProject(env.DB, lily, { code: "NEW", name: "dup" })).rejects.toMatchObject({ code: "CONFLICT" });
    const harry = await member("harry");
    expect((await core.createModule(env.DB, harry, { project: "NEW", code: "API", name: "API" })).code).toBe("NEW-API");
    const my = await member("my");
    await expect(core.createProject(env.DB, my, { code: "XYZ", name: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps the production seed empty and loads sample projects only in tests", async () => {
    const seed = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0002_"))!;
    expect(seed.queries.join("\n").toLowerCase()).not.toContain("insert");
    const { results } = await env.DB.prepare("SELECT code FROM projects ORDER BY code").all<{ code: string }>();
    for (const c of ["CNT", "SCG", "SCOS", "SCT", "SCV", "STS", "VMB", "XDL"]) expect(results.map((r) => r.code)).toContain(c);
    const admins = await env.DB.prepare("SELECT id FROM members WHERE is_admin = 1 ORDER BY id").all<{ id: string }>();
    expect(admins.results.map((r) => r.id)).toEqual(["harry", "lily"]);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM members").first<{ n: number }>();
    expect(n!.n).toBe(14);
    expect((await core.loadSettings(env.DB)).tz_offset_minutes).toBe(0);
  });
});

describe("lifecycle", () => {
  it("allows in_progress -> assigned and still rejects in_progress -> done", async () => {
    const { t } = await setupTask();
    const peter = await member("peter");
    await core.reportStatus(env.DB, peter, { task: t.code, status: "in_progress" }, T0 + 1);
    await expect(core.reportStatus(env.DB, peter, { task: t.code, status: "done", note: "xong" }, T0 + 2))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await core.getTaskRow(env.DB, t.code)).status).toBe("in_progress");
    await expect(core.reportStatus(env.DB, peter, { task: t.code, status: "assigned", note: "dừng" }, T0 + 3))
      .resolves.toMatchObject({ from: "in_progress", to: "assigned" });
    expect((await core.getTaskRow(env.DB, t.code)).status).toBe("assigned");
  });

  it("rejects invalid status transitions", async () => {
    const { t } = await setupTask();
    const peter = await member("peter");
    await expect(core.reportStatus(env.DB, peter, { task: t.code, status: "done", note: "x" }, T0 + 1))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(core.reportStatus(env.DB, peter, { task: t.code, status: "blocked" }, T0 + 1))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await core.reportStatus(env.DB, peter, { task: t.code, status: "in_progress" }, T0 + 2);
    await core.reportStatus(env.DB, peter, { task: t.code, status: "review", reviewer: "quinn", links: ["https://github.com/example/repo/pull/99"] }, T0 + 3);
    await expect(core.reportStatus(env.DB, peter, { task: t.code, status: "done" }, T0 + 4)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await core.reportStatus(env.DB, peter, { task: t.code, status: "done", note: "merged" }, T0 + 5);
    await expect(core.reportStatus(env.DB, peter, { task: t.code, status: "in_progress" }, T0 + 6)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const row = await core.getTaskRow(env.DB, t.code);
    expect(row).toMatchObject({ status: "done", pr_url: "https://github.com/example/repo/pull/99", started_at: T0 + 2, done_at: T0 + 5 });
  });

  it("only the assignee or a leader may report on a task", async () => {
    const { t } = await setupTask("peter");
    const ethan = await member("ethan");
    await expect(core.reportStatus(env.DB, ethan, { task: t.code, status: "in_progress" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const harry = await member("harry");
    await expect(core.reportStatus(env.DB, harry, { task: t.code, status: "in_progress" })).resolves.toMatchObject({ to: "in_progress" });
  });

  it("blocker flow requires waiting_on and returns to in_progress", async () => {
    const { t } = await setupTask("peter");
    const peter = await member("peter");
    const b = await core.setBlocker(env.DB, peter, { task: t.code, kind: "access", waiting_on: "owner", detail: "duyệt staging.env" }, T0 + 10);
    expect((await core.getTaskRow(env.DB, t.code)).status).toBe("blocked");
    await expect(core.setBlocker(env.DB, peter, { task: t.code, kind: "need_info", waiting_on: "nobody", detail: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await core.resolveBlocker(env.DB, peter, { id: b.blocker_id, note: "anh đã duyệt" }, T0 + 20);
    expect((await core.getTaskRow(env.DB, t.code)).status).toBe("in_progress");
  });
});

describe("cron checks", () => {
  it("is idempotent: running twice yields one alert per task+rule", async () => {
    const { t } = await setupTask("quinn", T0);
    const later = T0 + 20 * 60_000; // 20' after assignment > 15'
    await core.runChecks(env.DB, later);
    await core.runChecks(env.DB, later + 60_000);
    const { results } = await env.DB.prepare("SELECT * FROM alerts WHERE task_code = ?").bind(t.code).all();
    expect(results.length).toBe(1);
    expect(results[0]).toMatchObject({ rule: "NOT_STARTED", cleared_at: null });
    // condition no longer holds -> cleared, then a fresh run does not re-fire
    const quinn = await member("quinn");
    await core.reportStatus(env.DB, quinn, { task: t.code, status: "in_progress" }, later + 120_000);
    await core.runChecks(env.DB, later + 180_000);
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE task_code = ? AND cleared_at IS NULL").bind(t.code).first<{ n: number }>();
    expect(open!.n).toBe(0);
  });

  it("does not fire NOT_STARTED before 15 minutes", async () => {
    const { t } = await setupTask("leo", T0);
    await core.runChecks(env.DB, T0 + 14 * 60_000);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE task_code = ?").bind(t.code).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("BLOCKED_LONG after 2h and OVERDUE after due_at", async () => {
    const lily = await member("lily");
    const f = await core.createFeature(env.DB, lily, { module: "SCV-CORE", title: "404 fix" }, T0);
    const t = await core.createTask(env.DB, lily, { feature: f.code, title: "fix", assignee: "peter", due_at: T0 + HOUR, ...fullRequest }, T0);
    await core.reportStatus(env.DB, lily, { task: t.code, status: "assigned" }, T0);
    const peter = await member("peter");
    await core.setBlocker(env.DB, peter, { task: t.code, kind: "access", waiting_on: "harry", detail: "cần quyền" }, T0 + 60_000);
    await core.runChecks(env.DB, T0 + 2 * HOUR + 2 * 60_000);
    const rules = (await env.DB.prepare("SELECT rule FROM alerts WHERE task_code = ? AND cleared_at IS NULL ORDER BY rule").bind(t.code).all<{ rule: string }>())
      .results.map((r) => r.rule);
    expect(rules).toEqual(["BLOCKED_LONG", "OVERDUE"]);
  });

  it("STALE counts only configured working hours", async () => {
    const s = { stale_work_start_hour: 8, stale_work_end_hour: 22, tz_offset_minutes: 420 };
    const at = (d: number, h: number) => Date.UTC(2026, 9, d, h - 7, 0); // local hour h when offset is UTC+7
    expect(core.workingMs(at(17, 20), at(18, 9), s)).toBe(3 * HOUR); // 20-22 + 08-09
    expect(core.workingMs(at(17, 23), at(18, 7), s)).toBe(0);
    expect((await core.loadSettings(env.DB)).tz_offset_minutes).toBe(0);
    await env.DB.prepare("UPDATE settings SET value = '420' WHERE key = 'tz_offset_minutes'").run();

    const lily = await member("lily");
    const f = await core.createFeature(env.DB, lily, { module: "CNT-CORE", title: "spec" });
    const t = await core.createTask(env.DB, lily, { feature: f.code, title: "write", assignee: "olivia", ...fullRequest }, at(17, 19));
    await core.reportStatus(env.DB, lily, { task: t.code, status: "assigned" }, at(17, 19));
    const olivia = await member("olivia");
    await core.reportStatus(env.DB, olivia, { task: t.code, status: "in_progress" }, at(17, 20));
    await core.runChecks(env.DB, at(18, 9)); // 13h wall, 3h working -> not stale
    const q = () => env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE task_code = ? AND rule = 'STALE' AND cleared_at IS NULL").bind(t.code).first<{ n: number }>();
    expect((await q())!.n).toBe(0);
    await core.runChecks(env.DB, at(18, 10)); // 4h working -> stale
    expect((await q())!.n).toBe(1);
    await core.addNote(env.DB, olivia, { task: t.code, note: "đang viết phần 3" }, at(18, 10) + 1000);
    expect((await q())!.n).toBe(0);
    await env.DB.prepare("UPDATE settings SET value = '0' WHERE key = 'tz_offset_minutes'").run();
  });
});

describe("configured roles", () => {
  it("accepts owner brian and approver chi-hoa when those ids are configured", async () => {
    const prev = getHubConfig();
    useHubConfig({ ...prev, ownerIds: ["brian"], approverIds: ["chi-hoa"] });
    try {
      const lily = await member("lily");
      const f = await core.createFeature(env.DB, lily, { module: "STS-CORE", title: "configured roles" }, T0);
      const created = await core.createTask(env.DB, lily, {
        feature: f.code, title: "compat", assignee: "peter",
        requested_by: "brian", requested_at: T0, request_link: "https://example.com/requests/compat",
      }, T0);
      expect(created.status).toBe("backlog");
      await core.reportStatus(env.DB, lily, { task: created.code, status: "assigned" }, T0 + 1);
      const peter = await member("peter");
      const blocked = await core.setBlocker(env.DB, peter, {
        task: created.code, kind: "need_info", waiting_on: "chi-hoa", detail: "need a decision",
      }, T0 + 2);
      expect(blocked.status).toBe("blocked");
      const pending = await core.createTask(env.DB, lily, { feature: f.code, title: "needs approval" }, T0 + 3);
      const approved = await core.reportStatus(env.DB, lily, {
        task: pending.code, status: "assigned", approved_by: "brian", note: "ok",
      }, T0 + 4);
      expect(approved.approved_by).toBe("brian");
      const rejectMe = await core.createTask(env.DB, lily, { feature: f.code, title: "reject" }, T0 + 5);
      const rejected = await core.reportStatus(env.DB, lily, {
        task: rejectMe.code, status: "cancelled", approved_by: "chi-hoa", note: "no",
      }, T0 + 6);
      expect(rejected.approved_by).toBe("chi-hoa");
    } finally {
      useHubConfig(prev);
    }
  });
});

const HOUR = 3_600_000;
