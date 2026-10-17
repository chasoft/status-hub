import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as core from "../src/core";
import { accessJwt, fullRequest, member, UI, worker } from "./helpers";

const T0 = Date.UTC(2026, 9, 17, 3, 0); // 10:00 UTC+7
const MIN = 60_000;
const HOUR = 60 * MIN;

async function newTask(assignee = "peter", now = T0) {
  const lily = await member("lily");
  const f = await core.createFeature(env.DB, lily, { module: "STS-CORE", title: "time in status" }, now);
  return core.createTask(env.DB, lily, { feature: f.code, title: "periods", assignee, ...fullRequest }, now);
}
const periods = (code: string) => core.getPeriods(env.DB, code);
const openCount = async (code: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM status_periods WHERE task_code = ? AND ended_at IS NULL").bind(code).first<{ n: number }>())!.n;

describe("formatDuration", () => {
  it("formats 45m, 2h15m, 3d4h", () => {
    expect(core.formatDuration(45 * MIN)).toBe("45m");
    expect(core.formatDuration(2 * HOUR + 15 * MIN)).toBe("2h15m");
    expect(core.formatDuration(3 * 24 * HOUR + 4 * HOUR + 59 * MIN)).toBe("3d4h");
    expect(core.formatDuration(2 * HOUR)).toBe("2h");
    expect(core.formatDuration(30_000)).toBe("0m");
  });
});

describe("status periods", () => {
  it("creating a task opens its first period", async () => {
    const t = await newTask();
    const p = await periods(t.code);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ status: "backlog", started_at: T0, ended_at: null, member_id: "lily" });
  });

  it("a transition closes the previous period and opens a new one", async () => {
    const t = await newTask();
    const peter = await member("peter");
    await core.reportStatus(env.DB, peter, { task: t.code, status: "assigned" }, T0 + 10 * MIN);
    const p = await periods(t.code);
    expect(p.map((x) => [x.status, x.started_at, x.ended_at, x.member_id])).toEqual([
      ["backlog", T0, T0 + 10 * MIN, "lily"],
      ["assigned", T0 + 10 * MIN, null, "peter"],
    ]);
  });

  it("every path keeps exactly one open period, and durations sum to wall time", async () => {
    const t = await newTask();
    const peter = await member("peter");
    const harry = await member("harry");
    const lily = await member("lily");
    await core.reportStatus(env.DB, lily, { task: t.code, status: "assigned" }, T0);
    await core.reportStatus(env.DB, peter, { task: t.code, status: "in_progress" }, T0 + 5 * MIN);
    expect(await openCount(t.code)).toBe(1);
    await core.setBlocker(env.DB, peter, { task: t.code, kind: "need_info", waiting_on: "harry", detail: "a" }, T0 + HOUR);
    expect(await openCount(t.code)).toBe(1);
    await core.setBlocker(env.DB, peter, { task: t.code, kind: "access", waiting_on: "owner", detail: "b" }, T0 + HOUR + 5 * MIN); // already blocked
    expect(await openCount(t.code)).toBe(1);
    const bl = (await env.DB.prepare("SELECT id FROM blockers WHERE task_code = ? ORDER BY id").bind(t.code).all<{ id: number }>()).results;
    await core.resolveBlocker(env.DB, harry, { id: bl[0].id }, T0 + 2 * HOUR);           // still blocked: no new period
    expect(await openCount(t.code)).toBe(1);
    await core.resolveBlocker(env.DB, harry, { id: bl[1].id }, T0 + 3 * HOUR);           // -> in_progress
    expect(await openCount(t.code)).toBe(1);
    await core.reportStatus(env.DB, peter, { task: t.code, status: "review", reviewer: "quinn" }, T0 + 4 * HOUR);
    await core.reportStatus(env.DB, harry, { task: t.code, status: "in_progress" }, T0 + 5 * HOUR);
    await core.assignTask(env.DB, harry, { task: t.code, assignee: "ethan" }, T0 + 6 * HOUR);
    expect((await core.getTaskRow(env.DB, t.code)).status).toBe("in_progress");
    expect(await openCount(t.code)).toBe(1);
    await core.reportStatus(env.DB, harry, { task: t.code, status: "review", reviewer: "quinn" }, T0 + 7 * HOUR);
    await core.reportStatus(env.DB, harry, { task: t.code, status: "done", note: "ok" }, T0 + 8 * HOUR);
    expect(await openCount(t.code)).toBe(1);

    const p = await periods(t.code);
    expect(p.map((x) => x.status)).toEqual([
      "backlog", "assigned", "in_progress", "blocked", "in_progress", "review", "in_progress", "review", "done",
    ]);
    // contiguous: each period ends exactly when the next starts
    for (let i = 1; i < p.length; i++) expect(p[i - 1].ended_at).toBe(p[i].started_at);
    expect(p.at(-1)!.ended_at).toBeNull(); // terminal status still has an open period

    const now = T0 + 9 * HOUR;
    const s = core.summarizePeriods(p, now);
    const sum = s.timeline.reduce((a, x) => a + x.duration_ms, 0);
    expect(sum).toBe(now - T0);
    expect(s.totals.blocked.duration_ms).toBe(2 * HOUR);
    expect(s.totals.blocked.duration).toBe("2h");
    expect(s.totals.in_progress.duration_ms).toBe(55 * MIN + HOUR + 2 * HOUR);
    expect(s.totals.in_progress.periods).toBe(3);
    expect(s.totals.review.duration_ms).toBe(2 * HOUR);
    expect(s.current).toMatchObject({ status: "done", since: T0 + 8 * HOUR, duration: "1h" });
  });

  it("the DB refuses a second open period for the same task", async () => {
    const t = await newTask();
    await expect(env.DB.prepare("INSERT INTO status_periods (task_code, status, started_at) VALUES (?, 'review', ?)")
      .bind(t.code, T0 + 1).run()).rejects.toThrow(/UNIQUE/);
  });

  it("get_task and list_my_tasks expose time in current status", async () => {
    const t = await newTask("quinn");
    const quinn = await member("quinn");
    await core.reportStatus(env.DB, await member("lily"), { task: t.code, status: "assigned" }, T0);
    await core.reportStatus(env.DB, quinn, { task: t.code, status: "in_progress" }, T0 + 30 * MIN);
    const d = await core.getTask(env.DB, t.code, T0 + 30 * MIN + 2 * HOUR + 15 * MIN);
    expect(d.current_status).toMatchObject({ status: "in_progress", since: T0 + 30 * MIN, duration: "2h15m" });
    expect(d.periods).toHaveLength(3);
    expect(d.time_in_status.assigned.duration).toBe("30m");
    const mine = await core.listMyTasks(env.DB, quinn, "in_progress", T0 + 30 * MIN + 45 * MIN);
    expect(mine.tasks.find((x: any) => x.code === t.code)).toMatchObject({ status_since: T0 + 30 * MIN, in_status: "45m" });
    const tl = await core.getTaskTimeline(env.DB, t.code, T0 + HOUR);
    expect(tl.timeline.map((x) => x.duration)).toEqual(["0m", "30m", "30m"]);
  });

  it("UI card shows time in status and task page shows the timeline", async () => {
    const t = await newTask("leo", Date.now() - 2 * HOUR - 15 * MIN - 5_000);
    const h = { "Cf-Access-Jwt-Assertion": await accessJwt("owner@example.com") };
    const board = await (await worker.fetch(`${UI}/?project=STS`, { headers: h })).text();
    expect(board).toContain("backlog · 2h15m");
    const page = await (await worker.fetch(`${UI}/t/${t.code}`, { headers: h })).text();
    expect(page).toContain("Time in status");
    expect(page).toContain("Totals by status");
    expect(page).toContain("2h15m");
    expect(page).toContain("current");
  });
});

describe("migration 0003 backfill", () => {
  it("opens one period per existing task at its last status change (or last update / created_at)", async () => {
    const mig = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0003_"))!;
    expect(mig).toBeTruthy();
    // Simulate the pre-0003 world: no status_periods table, tasks with history.
    await env.DB.exec("DROP TABLE status_periods");
    const ins = (code: string, status: string, created: number, last: number) =>
      env.DB.prepare(`INSERT INTO tasks (code, feature_code, project_code, title, assignee_id, status, created_by, created_at, last_update_at)
                      VALUES (?, 'STS-CORE-900', 'STS', 'legacy', 'peter', ?, 'lily', ?, ?)`).bind(code, status, created, last);
    const up = (code: string, at: number, from: string | null, to: string, who = "peter") =>
      env.DB.prepare("INSERT INTO updates (task_code, member_id, at, status_from, status_to) VALUES (?, ?, ?, ?, ?)").bind(code, who, at, from, to);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO features (code, module_code, project_code, title, created_at) VALUES ('STS-CORE-900', 'STS-CORE', 'STS', 'legacy', ?)`).bind(T0),
      ins("STS-CORE-900.1", "in_progress", T0, T0 + 3 * HOUR),
      up("STS-CORE-900.1", T0, null, "assigned", "lily"),
      up("STS-CORE-900.1", T0 + HOUR, "assigned", "in_progress"),
      up("STS-CORE-900.1", T0 + 3 * HOUR, "in_progress", "in_progress"), // a note, not a status change
      ins("STS-CORE-900.2", "review", T0, T0 + 2 * HOUR),                  // no updates at all
    ]);
    for (const q of mig.queries) await env.DB.prepare(q).run();

    const rows = (await env.DB.prepare("SELECT task_code, status, started_at, ended_at, member_id FROM status_periods WHERE task_code LIKE 'STS-CORE-900.%' ORDER BY task_code").all()).results;
    expect(rows).toEqual([
      { task_code: "STS-CORE-900.1", status: "in_progress", started_at: T0 + HOUR, ended_at: null, member_id: "peter" },
      { task_code: "STS-CORE-900.2", status: "review", started_at: T0 + 2 * HOUR, ended_at: null, member_id: "lily" },
    ]);
    // every task has exactly one open period after backfill
    const bad = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE
      (SELECT COUNT(*) FROM status_periods p WHERE p.task_code = t.code AND p.ended_at IS NULL) != 1`).first<{ n: number }>();
    expect(bad!.n).toBe(0);
    // and transitions keep working on backfilled tasks
    await core.reportStatus(env.DB, await member("peter"), { task: "STS-CORE-900.1", status: "review", reviewer: "quinn" }, T0 + 4 * HOUR);
    const p = await periods("STS-CORE-900.1");
    expect(p.map((x) => [x.status, x.started_at, x.ended_at])).toEqual([
      ["in_progress", T0 + HOUR, T0 + 4 * HOUR], ["review", T0 + 4 * HOUR, null],
    ]);
  });
});
