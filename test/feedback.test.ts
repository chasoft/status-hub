import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as core from "../src/core";
import { accessJwt, fullRequest, issueToken, mcpCall, member, UI, worker } from "./helpers";

const T0 = Date.UTC(2026, 9, 17, 3, 0);
const OWNER_EMAIL = "owner@example.com";
const APPROVER_EMAIL = "approver@example.com";
const VIEWER = "viewer@example.com"; // logged-in UI session with no leadership author

async function assignedTask(assignee = "peter") {
  const lily = await member("lily");
  const f = await core.createFeature(env.DB, lily, { module: "STS-CORE", title: "leadership feedback" }, T0);
  return core.createTask(env.DB, lily, { feature: f.code, title: "đọc phản hồi", assignee, status: "assigned", ...fullRequest }, T0);
}

async function postFeedback(email: string, code: string, body: string, origin?: string | Record<string, string>) {
  const extra = typeof origin === "string" ? { origin } : origin ?? {};
  return worker.fetch(`${UI}/t/${code}/feedback`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Cf-Access-Jwt-Assertion": await accessJwt(email),
      "content-type": "application/x-www-form-urlencoded",
      ...extra,
    },
    body,
  });
}

describe("leadership feedback", () => {
  it("rejects a logged-in session that is not a leadership author with 403", async () => {
    const t = await assignedTask();
    const denied = await postFeedback(VIEWER, t.code, "note=khong+duoc&author=Spoofed");
    expect(denied.status).toBe(403);
    const page = await (await worker.fetch(`${UI}/t/${t.code}`, {
      headers: { "Cf-Access-Jwt-Assertion": await accessJwt(VIEWER) },
    })).text();
    expect(page).not.toContain("<textarea");
    expect(page).not.toContain(">Send<");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE task_code = ?").bind(t.code).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("rejects a cross-origin POST even from a leadership author with 403", async () => {
    const t = await assignedTask();
    const res = await postFeedback(OWNER_EMAIL, t.code, "note=csrf", "https://evil.example");
    expect(res.status).toBe(403);
    const ok = await postFeedback(OWNER_EMAIL, t.code, "note=cung+origin", UI);
    expect(ok.status).toBe(303);
    const rows = (await env.DB.prepare("SELECT note FROM feedback WHERE task_code = ?").bind(t.code).all<{ note: string }>()).results;
    expect(rows.map((r) => r.note)).toEqual(["cung origin"]);
  });

  it("accepts the real Chrome form POST (Origin: null under Referrer-Policy no-referrer, Sec-Fetch-Site same-origin)", async () => {
    // Chrome sends Origin: null on this form because the page sets Referrer-Policy: no-referrer.
    const t = await assignedTask();
    const res = await postFeedback(OWNER_EMAIL, t.code, "note=tu+trinh+duyet", {
      origin: "null", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/t/${t.code}`);
    const rows = (await env.DB.prepare("SELECT note FROM feedback WHERE task_code = ?").bind(t.code).all<{ note: string }>()).results;
    expect(rows.map((r) => r.note)).toEqual(["tu trinh duyet"]);
  });

  it("still rejects cross-site and same-site browser POSTs, and Origin: null without Sec-Fetch-Site", async () => {
    const t = await assignedTask();
    const shapes: Record<string, string>[] = [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
      { origin: "null", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
      { origin: "https://other.example.com", "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate" },
      { origin: "null" },
      { origin: "https://evil.example" },
    ];
    for (const h of shapes) expect((await postFeedback(OWNER_EMAIL, t.code, "note=csrf", h)).status).toBe(403);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE task_code = ?").bind(t.code).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("escapes the note in the task page", async () => {
    const t = await assignedTask();
    await core.addLeadershipFeedback(env.DB, { task: t.code, author: "Owner", note: "<script>alert(1)</script>" }, T0);
    const html = await (await worker.fetch(`${UI}/t/${t.code}`, {
      headers: { "Cf-Access-Jwt-Assertion": await accessJwt(OWNER_EMAIL) },
    })).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("stores the leadership author from the session, never from the form", async () => {
    const t = await assignedTask("ethan");
    const approver = await postFeedback(APPROVER_EMAIL, t.code, "note=xem+lai+FTS&author=Spoofed");
    expect(approver.status).toBe(303);
    expect(approver.headers.get("location")).toBe(`/t/${t.code}`);
    const owner = await postFeedback(OWNER_EMAIL, t.code, "note=uu+tien+hom+nay&author=Spoofed");
    expect(owner.status).toBe(303);

    const html = await (await worker.fetch(`${UI}/t/${t.code}`, {
      headers: { "Cf-Access-Jwt-Assertion": await accessJwt(APPROVER_EMAIL) },
    })).text();
    expect(html).toContain("<textarea");
    expect(html).toContain(">Send<");
    expect(html).toContain("xem lai FTS");
    expect(html).toContain("uu tien hom nay");
    // Highlighted in the same history table, author is the session name.
    expect(html).toMatch(/<tr class="lead">[\s\S]*Approver[\s\S]*xem lai FTS/);
    expect(html).toMatch(/<tr class="lead">[\s\S]*Owner[\s\S]*uu tien hom nay/);

    const rows = (await env.DB.prepare(
      "SELECT author, note, at, read_at FROM feedback WHERE task_code = ? ORDER BY id",
    ).bind(t.code).all<{ author: string; note: string; at: number; read_at: number | null }>()).results;
    expect(rows.map((r) => [r.author, r.note])).toEqual([
      ["Approver", "xem lai FTS"],
      ["Owner", "uu tien hom nay"],
    ]);
    expect(rows.every((r) => typeof r.at === "number" && r.at > 0 && r.read_at == null)).toBe(true);
  });

  it("assignee get_task returns unread feedback then clears it; list_my_tasks shows the count", async () => {
    const t = await assignedTask("quinn");
    await core.addLeadershipFeedback(env.DB, { task: t.code, author: "Owner", note: "làm gấp phần index" }, T0 + 1);
    await core.addLeadershipFeedback(env.DB, { task: t.code, author: "Approver", note: "nhớ ghi chú kết quả" }, T0 + 2);

    const quinnTok = await issueToken("quinn");
    const ethanTok = await issueToken("ethan");
    const count = async () => {
      const mine = await mcpCall(quinnTok, "list_my_tasks");
      return mine.data.tasks.find((x: { code: string }) => x.code === t.code).unread_feedback_count;
    };
    expect(await count()).toBe(2);

    const other = await mcpCall(ethanTok, "get_task", { code: t.code });
    expect(other.data.feedback.map((f: { author: string; unread: boolean }) => [f.author, f.unread])).toEqual([
      ["Approver", true],
      ["Owner", true],
    ]);
    expect(await count()).toBe(2); // only the assignee's get_task marks read

    const seen = await mcpCall(quinnTok, "get_task", { code: t.code });
    expect(seen.data.feedback.map((f: { note: string; unread: boolean }) => [f.note, f.unread])).toEqual([
      ["nhớ ghi chú kết quả", true],
      ["làm gấp phần index", true],
    ]);
    expect(await count()).toBe(0);

    const again = await mcpCall(quinnTok, "get_task", { code: t.code });
    expect(again.data.feedback.every((f: { unread: boolean }) => f.unread === false)).toBe(true);
    expect(await count()).toBe(0);
  });

  it("a new assignee sees feedback the previous assignee already read", async () => {
    const t = await assignedTask("leo");
    await core.addLeadershipFeedback(env.DB, { task: t.code, author: "Approver", note: "đổi hướng" }, T0 + 5);
    const leo = await member("leo");
    const first = await core.getTask(env.DB, t.code, T0 + 6, leo);
    expect(first.feedback[0]).toMatchObject({ author: "Approver", unread: true });
    expect((await core.listMyTasks(env.DB, leo)).tasks.find((x) => x.code === t.code)?.unread_feedback_count).toBe(0);

    const harry = await member("harry");
    await core.assignTask(env.DB, harry, { task: t.code, assignee: "anna" }, T0 + 7);
    const anna = await member("anna");
    expect((await core.listMyTasks(env.DB, anna)).tasks.find((x) => x.code === t.code)?.unread_feedback_count).toBe(1);
    const seen = await core.getTask(env.DB, t.code, T0 + 8, anna);
    expect(seen.feedback[0].unread).toBe(true);
    expect((await core.listMyTasks(env.DB, anna)).tasks.find((x) => x.code === t.code)?.unread_feedback_count).toBe(0);
  });

  it("opens one LEADERSHIP_FEEDBACK alert for the task, visible like other alerts", async () => {
    const t = await assignedTask("quinn");
    const quinn = await member("quinn");
    const before = (await core.whoami(env.DB, quinn)).alerts;
    await core.addLeadershipFeedback(env.DB, { task: t.code, author: "Owner", note: "review the index" }, T0 + 1);
    await core.addLeadershipFeedback(env.DB, { task: t.code, author: "Approver", note: "add a test" }, T0 + 2);

    const rows = (await env.DB.prepare(
      "SELECT rule, cleared_at FROM alerts WHERE task_code = ? AND rule = 'LEADERSHIP_FEEDBACK'",
    ).bind(t.code).all<{ rule: string; cleared_at: number | null }>()).results;
    expect(rows).toEqual([{ rule: "LEADERSHIP_FEEDBACK", cleared_at: null }]);

    const mine = await core.listMyTasks(env.DB, quinn, undefined, T0 + 3);
    expect(mine.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ task_code: t.code, rule: "LEADERSHIP_FEEDBACK" }),
    ]));
    expect((await core.whoami(env.DB, quinn)).alerts).toBe(before + 1);

    const quinnTok = await issueToken("quinn");
    const moved = await mcpCall(quinnTok, "report_status", { task: t.code, status: "in_progress" });
    expect(moved.isError).toBe(false);
    expect(moved.data.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ task_code: t.code, rule: "LEADERSHIP_FEEDBACK" }),
    ]));

    const html = await (await worker.fetch(`${UI}/alerts`, {
      headers: { "Cf-Access-Jwt-Assertion": await accessJwt(VIEWER) },
    })).text();
    expect(html).toContain("Leadership feedback");
    expect(html).toContain(t.code);
  });

  it("clears the LEADERSHIP_FEEDBACK alert when the assignee get_task marks feedback read", async () => {
    const t = await assignedTask("quinn");
    await core.addLeadershipFeedback(env.DB, { task: t.code, author: "Owner", note: "please read" }, T0 + 1);
    const open = () => env.DB.prepare(
      "SELECT COUNT(*) AS n FROM alerts WHERE task_code = ? AND rule = 'LEADERSHIP_FEEDBACK' AND cleared_at IS NULL",
    ).bind(t.code).first<{ n: number }>();

    await core.getTask(env.DB, t.code, T0 + 2, await member("ethan"));
    expect((await open())!.n).toBe(1);

    const quinn = await member("quinn");
    const seen = await core.getTask(env.DB, t.code, T0 + 3, quinn);
    expect(seen.feedback[0]).toMatchObject({ unread: true });
    expect((await open())!.n).toBe(0);
    expect((await core.listMyTasks(env.DB, quinn, undefined, T0 + 4)).alerts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ task_code: t.code, rule: "LEADERSHIP_FEEDBACK" }),
    ]));

    const again = await core.getTask(env.DB, t.code, T0 + 5, quinn);
    expect(again.alerts).not.toEqual(expect.arrayContaining([expect.objectContaining({ rule: "LEADERSHIP_FEEDBACK" })]));

    await core.addLeadershipFeedback(env.DB, { task: t.code, author: "Approver", note: "a new note" }, T0 + 6);
    expect((await open())!.n).toBe(1);
  });

  it("includes a pending_approval task with unread feedback in the default list_my_tasks call", async () => {
    const peter = await member("peter");
    const lily = await member("lily");
    const f = await core.createFeature(env.DB, lily, { module: "STS-CORE", title: "unread outside filter" }, T0);
    const pending = await core.createTask(env.DB, peter, {
      feature: f.code, title: "pending with feedback", assignee: "peter",
    }, T0);
    expect(pending.status).toBe("pending_approval");
    const backlog = await core.createTask(env.DB, lily, {
      feature: f.code, title: "backlog with feedback", assignee: "peter", status: "backlog", ...fullRequest,
    }, T0 + 1);
    expect(backlog.status).toBe("backlog");

    const before = (await core.listMyTasks(env.DB, peter, undefined, T0 + 2)).tasks.map((x) => x.code);
    expect(before).not.toContain(pending.code);
    expect(before).not.toContain(backlog.code);

    await core.addLeadershipFeedback(env.DB, { task: pending.code, author: "Owner", note: "add the spec" }, T0 + 3);
    await core.addLeadershipFeedback(env.DB, { task: backlog.code, author: "Approver", note: "do this backlog item" }, T0 + 4);

    const mine = await core.listMyTasks(env.DB, peter, undefined, T0 + 5);
    expect(mine.tasks.find((x) => x.code === pending.code)).toMatchObject({ status: "pending_approval", unread_feedback_count: 1 });
    expect(mine.tasks.find((x) => x.code === backlog.code)).toMatchObject({ status: "backlog", unread_feedback_count: 1 });

    const onlyProgress = await core.listMyTasks(env.DB, peter, "in_progress", T0 + 5);
    expect(onlyProgress.tasks.map((x) => x.code)).toEqual(expect.arrayContaining([pending.code, backlog.code]));

    await core.getTask(env.DB, pending.code, T0 + 6, peter);
    const afterRead = await core.listMyTasks(env.DB, peter, undefined, T0 + 7);
    expect(afterRead.tasks.find((x) => x.code === pending.code)).toBeUndefined();
    expect(afterRead.tasks.find((x) => x.code === backlog.code)?.unread_feedback_count).toBe(1);
  });
});
