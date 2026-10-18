import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as core from "../src/core";
import { accessJwt, fullRequest, member, UI, worker } from "./helpers";

async function taskPage(path: string) {
  const res = await worker.fetch(`${UI}${path}`, {
    headers: { "Cf-Access-Jwt-Assertion": await accessJwt("owner@example.com") },
  });
  return res.text();
}

describe("inline edit", () => {
  it("shows one hidden editor per field and saves assignee, reviewer, due, links, and priority", async () => {
    const lily = await member("lily");
    const feature = await core.createFeature(env.DB, lily, { module: "STS-CORE", title: "inline edit", priority: "P2" });
    const task = await core.createTask(env.DB, lily, {
      feature: feature.code, title: "inline fields", assignee: "peter", ...fullRequest,
    });
    const html = await taskPage(`/t/${task.code}`);
    const edits = [...html.matchAll(/<form class="inline-edit[\s\S]*?<\/form>/g)].map((m) => m[0]);
    for (const name of ["pr_url", "links", "assignee", "reviewer", "due_at"]) {
      const forms = edits.filter((form) => form.includes(`name="${name}"`));
      expect(forms, name).toHaveLength(1);
      expect(forms[0]).toContain('<span class="ie-form" hidden>');
      expect(forms[0]).toContain("novalidate");
      expect(forms[0]).not.toContain(">Save<");
    }
    expect(html).not.toContain(">PR URL<");

    const post = async (body: string) => worker.fetch(`${UI}/t/${task.code}`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": await accessJwt("owner@example.com"),
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });
    expect((await post("reviewer=jennifer")).status).toBe(200);
    expect((await core.getTaskRow(env.DB, task.code)).reviewer_id).toBe("jennifer");
    expect((await post("assignee=mira")).status).toBe(200);
    expect((await core.getTaskRow(env.DB, task.code)).assignee_id).toBe("mira");
    const due = await post("due_at=" + encodeURIComponent("2026-10-17T03:00"));
    expect(due.status).toBe(200);
    expect((await core.getTaskRow(env.DB, task.code)).due_at).toBe(Date.UTC(2026, 9, 17, 3, 0));
    const links = await post("links=" + encodeURIComponent("https://example.com/notes/a https://example.com/notes/b"));
    expect(links.status).toBe(200);
    const bad = await post("pr_url=" + encodeURIComponent("not-a-url"));
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toContain("http hoặc https");

    const priority = await worker.fetch(`${UI}/f/${feature.code}`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": await accessJwt("owner@example.com"),
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: "priority=P1",
    });
    expect(priority.status).toBe(200);
    const row = await env.DB.prepare("SELECT priority FROM features WHERE code = ?").bind(feature.code).first<{ priority: string }>();
    expect(row?.priority).toBe("P1");

    const project = await taskPage(`/p/STS`);
    expect(project).toContain('name="priority"');
    expect(project).toContain('<span class="ie-form" hidden>');
  });
});
