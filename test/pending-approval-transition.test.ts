import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as core from "../src/core";
import { fullRequest, member } from "./helpers";

const T0 = Date.UTC(2026, 9, 17, 3, 0);

async function assignedTask(title: string) {
  const lily = await member("lily");
  const f = await core.createFeature(env.DB, lily, { module: "STS-CORE", title }, T0);
  const t = await core.createTask(env.DB, lily, {
    feature: f.code, title, assignee: "peter", status: "assigned", ...fullRequest,
  }, T0);
  return t;
}

/** Blocked task whose open blocker kind is rewritten (set_blocker rejects need_approval). */
async function blockedWith(kind: string, title: string) {
  const t = await assignedTask(title);
  const peter = await member("peter");
  const b = await core.setBlocker(env.DB, peter, {
    task: t.code, kind: "access", waiting_on: "harry", detail: "chờ",
  }, T0 + 1_000);
  if (kind !== "access") {
    await env.DB.prepare("UPDATE blockers SET kind = ? WHERE id = ?").bind(kind, b.blocker_id).run();
  }
  return { code: t.code, blockerId: b.blocker_id };
}

describe("report_status into pending_approval", () => {
  it("lets a pm move blocked → pending_approval and close need_approval blockers", async () => {
    const { code } = await blockedWith("need_approval", "pm đóng need_approval");
    await env.DB.prepare(
      "INSERT INTO blockers (task_code, raised_by, kind, waiting_on, detail, opened_at) VALUES (?, 'peter', 'need_approval', 'owner', 'thêm', ?)",
    ).bind(code, T0 + 1_500).run();
    await env.DB.prepare(
      "INSERT INTO alerts (task_code, rule, fired_at) VALUES (?, 'BLOCKED_LONG', ?)",
    ).bind(code, T0 + 1_000).run();
    const my = await member("my");
    const now = T0 + 10_000;
    const moved = await core.reportStatus(env.DB, my, { task: code, status: "pending_approval" }, now);
    expect(moved).toMatchObject({ from: "blocked", to: "pending_approval" });
    expect((await core.getTaskRow(env.DB, code)).status).toBe("pending_approval");

    const blockers = (await env.DB.prepare(
      "SELECT kind, resolved_at, resolved_by, resolution FROM blockers WHERE task_code = ? ORDER BY id",
    ).bind(code).all<{ kind: string; resolved_at: number | null; resolved_by: string | null; resolution: string | null }>()).results;
    expect(blockers).toHaveLength(2);
    for (const b of blockers) {
      expect(b).toMatchObject({
        kind: "need_approval", resolved_at: now, resolved_by: "my", resolution: "chuyển sang pending_approval",
      });
    }
    const periods = await core.getPeriods(env.DB, code);
    const open = periods.filter((p) => p.ended_at === null);
    expect(open).toEqual([expect.objectContaining({ status: "pending_approval", started_at: now, member_id: "my" })]);
    expect(periods.find((p) => p.status === "blocked")).toMatchObject({ ended_at: now });

    const alert = await env.DB.prepare(
      "SELECT cleared_at FROM alerts WHERE task_code = ? AND rule = 'BLOCKED_LONG'",
    ).bind(code).first<{ cleared_at: number | null }>();
    expect(alert!.cleared_at).toBe(now);
  });

  it("lets pm or admin move backlog and assigned into pending_approval", async () => {
    const lily = await member("lily");
    const f = await core.createFeature(env.DB, lily, { module: "STS-CORE", title: "vào hàng chờ" }, T0);
    const backlog = await core.createTask(env.DB, lily, {
      feature: f.code, title: "backlog", ...fullRequest,
    }, T0);
    const my = await member("my");
    expect(await core.reportStatus(env.DB, my, { task: backlog.code, status: "pending_approval" }, T0 + 2_000))
      .toMatchObject({ from: "backlog", to: "pending_approval" });

    const assigned = await assignedTask("admin assigned");
    const harry = await member("harry");
    expect(await core.reportStatus(env.DB, harry, { task: assigned.code, status: "pending_approval" }, T0 + 3_000))
      .toMatchObject({ from: "assigned", to: "pending_approval" });
  });

  it("returns 403 for anyone who is not pm or admin", async () => {
    const { code } = await blockedWith("need_approval", "dev bị chặn");
    const peter = await member("peter");
    const olivia = await member("olivia");
    await expect(core.reportStatus(env.DB, peter, { task: code, status: "pending_approval" }, T0 + 4_000))
      .rejects.toMatchObject({ code: "FORBIDDEN", httpStatus: 403 });
    await expect(core.reportStatus(env.DB, olivia, { task: code, status: "pending_approval" }, T0 + 4_000))
      .rejects.toMatchObject({ code: "FORBIDDEN", httpStatus: 403 });
    expect((await core.getTaskRow(env.DB, code)).status).toBe("blocked");
    const open = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM blockers WHERE task_code = ? AND resolved_at IS NULL",
    ).bind(code).first<{ n: number }>();
    expect(open!.n).toBe(1);
  });

  it("rejects with 400 when a non-need_approval blocker is still open", async () => {
    const { code, blockerId } = await blockedWith("access", "blocker access");
    await env.DB.prepare(
      "INSERT INTO blockers (task_code, raised_by, kind, waiting_on, detail, opened_at) VALUES (?, 'peter', 'need_approval', 'owner', 'cũng chờ', ?)",
    ).bind(code, T0 + 1_200).run();
    const my = await member("my");
    await expect(core.reportStatus(env.DB, my, { task: code, status: "pending_approval" }, T0 + 5_000))
      .rejects.toMatchObject({
        code: "BAD_REQUEST",
        httpStatus: 400,
        message: expect.stringContaining("need_approval"),
      });
    expect((await core.getTaskRow(env.DB, code)).status).toBe("blocked");
    const rows = (await env.DB.prepare(
      "SELECT id, kind, resolved_at FROM blockers WHERE task_code = ? ORDER BY id",
    ).bind(code).all<{ id: number; kind: string; resolved_at: number | null }>()).results;
    expect(rows).toEqual([
      { id: blockerId, kind: "access", resolved_at: null },
      expect.objectContaining({ kind: "need_approval", resolved_at: null }),
    ]);
    const openPeriod = (await core.getPeriods(env.DB, code)).find((p) => p.ended_at === null);
    expect(openPeriod).toMatchObject({ status: "blocked" });
  });
});
