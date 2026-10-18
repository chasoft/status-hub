import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import * as core from "../src/core";
import { deliverDueWebhooks, setMemberWebhook } from "../src/webhooks";
import { fullRequest, issueToken, mcpCall, member } from "./helpers";

const T0 = Date.UTC(2026, 9, 18, 10, 30);
const HOOK = "https://hooks.example.com/assignee";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** A task in review: assignee works it, reviewer reviews it. */
async function inReview(assignee: string, reviewer: string, title: string) {
  const lily = await member("lily");
  const a = await member(assignee);
  const f = await core.createFeature(env.DB, lily, { module: "STS-CORE", title }, T0);
  const t = await core.createTask(env.DB, lily, { feature: f.code, title, assignee, ...fullRequest }, T0);
  await core.reportStatus(env.DB, lily, { task: t.code, status: "assigned" }, T0);
  await core.reportStatus(env.DB, a, { task: t.code, status: "in_progress" }, T0 + 1);
  await core.reportStatus(env.DB, a, { task: t.code, status: "review", reviewer, links: ["https://example.com/pull/1"] }, T0 + 2);
  await env.DB.prepare("DELETE FROM webhook_outbox WHERE task_code = ?").bind(t.code).run();
  return t.code;
}

describe("the reviewer gives the verdict", () => {
  it("reviewer can add_note and pass review → done", async () => {
    const code = await inReview("peter", "quinn", "pass review");
    const quinn = await issueToken("quinn");
    const note = await mcpCall(quinn, "add_note", { task: code, note: "QA started" });
    expect(note.isError).toBe(false);
    const done = await mcpCall(quinn, "report_status", { task: code, status: "done", note: "QA pass" });
    expect(done.isError).toBe(false);
    expect(done.data).toMatchObject({ from: "review", to: "done" });
    expect((await core.getTaskRow(env.DB, code)).status).toBe("done");
  });

  it("reviewer fails review → assigned with a required note and the assignee is woken with it", async () => {
    const sent: any[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === HOOK) { sent.push(JSON.parse(String(init?.body))); return new Response("ok"); }
      return originalFetch(input, init);
    }) as typeof fetch;
    await setMemberWebhook(env.DB, await member("lily"), { member: "ethan", url: HOOK });
    const code = await inReview("ethan", "quinn", "fail review");
    const quinn = await member("quinn");
    await expect(core.reportStatus(env.DB, quinn, { task: code, status: "assigned" }, T0 + 3)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const r = await core.reportStatus(env.DB, quinn, { task: code, status: "assigned", note: "Fails on step 3" }, T0 + 4);
    expect(r).toMatchObject({ from: "review", to: "assigned" });
    const t = await core.getTaskRow(env.DB, code);
    expect(t.status).toBe("assigned");
    expect(t.assigned_at).toBe(T0 + 4);
    expect(t.reviewer_id).toBe("quinn");
    await deliverDueWebhooks(env.DB, { now: T0 + 5 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "task.assigned", member: "ethan", reason: "review_failed", note: "Fails on step 3", assigned_by: "quinn",
      task: { code, status: "assigned" },
    });
    expect(sent[0].text).toContain("Fails on step 3");
  });

  it("the reviewer can do nothing else", async () => {
    const code = await inReview("peter", "quinn", "reviewer limits");
    const quinn = await member("quinn");
    for (const status of ["in_progress", "cancelled"] as const) {
      await expect(core.reportStatus(env.DB, quinn, { task: code, status, note: "x" }, T0 + 3)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(core.reportStatus(env.DB, quinn, { task: code, status: "done", note: "x", reviewer: "jane" }, T0 + 3)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(core.setBlocker(env.DB, quinn, { task: code, kind: "bug", waiting_on: "peter", detail: "x" }, T0 + 3)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(core.updateTask(env.DB, quinn, { task: code, pr_url: "https://example.com/pull/2" }, T0 + 3)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Once the task left review, the reviewer has no verdict to give.
    await core.reportStatus(env.DB, await member("peter"), { task: code, status: "in_progress" }, T0 + 4);
    await expect(core.reportStatus(env.DB, quinn, { task: code, status: "assigned", note: "x" }, T0 + 5)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Another member who is not the reviewer stays forbidden.
    const code2 = await inReview("peter", "quinn", "not my review");
    await expect(core.addNote(env.DB, await member("jane"), { task: code2, note: "x" }, T0 + 6)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(core.reportStatus(env.DB, await member("jane"), { task: code2, status: "done", note: "x" }, T0 + 6)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a leader can also fail a review; the note is required for everyone", async () => {
    const code = await inReview("peter", "quinn", "leader fails");
    const lily = await member("lily");
    await expect(core.reportStatus(env.DB, lily, { task: code, status: "assigned" }, T0 + 3)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await core.reportStatus(env.DB, lily, { task: code, status: "assigned", note: "QA fail" }, T0 + 4)).to).toBe("assigned");
  });
});
