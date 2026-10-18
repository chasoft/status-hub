import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as core from "../src/core";
import { accessJwt, fullRequest, member, UI, worker } from "./helpers";

async function page(path: string, email = "owner@example.com"): Promise<{ status: number; html: string; csp: string | null; type: string | null }> {
  const res = await worker.fetch(`${UI}${path}`, {
    headers: { "Cf-Access-Jwt-Assertion": await accessJwt(email) },
  });
  return {
    status: res.status,
    html: await res.text(),
    csp: res.headers.get("content-security-policy"),
    type: res.headers.get("content-type"),
  };
}

describe("dashboard shell", () => {
  it("renders a viewport board with project navigation and no full-page refresh", async () => {
    const res = await page("/?project=SCOS");
    expect(res.status).toBe(200);
    expect(res.csp).toContain("script-src 'self'");
    expect(res.csp).toContain("connect-src 'self'");
    expect(res.html).toContain("100dvh");
    expect(res.html).toContain('src="/assets/dashboard.js"');
    expect(res.html).not.toContain('http-equiv="refresh"');
    expect(res.html).not.toMatch(/\son[a-z]+=/i);
    expect(res.html).toContain('id="drawer"');
    expect(res.html).toContain('id="switcher"');
    expect(res.html).toContain('id="new-task"');
    expect(res.html).toContain("All projects");
    expect(res.html).toContain('data-project-link="SCOS"');
    expect(res.html).toContain("--radius:5px");
    expect(res.html).not.toContain("999px");
    expect(res.html).toContain("overflow-x:hidden");
    expect(res.html).toContain("details.lane[open]{flex:0 1 auto;max-height:100%");
    expect(res.html).toContain("position:sticky");
    expect(res.html).toContain('data-lock-open="1"');
    expect(res.html).not.toContain('data-lane="SCG"');
    expect(res.html).not.toContain('href="/p/SCG"');
  });

  it("collapses project lanes by default when more than three projects are shown", async () => {
    const { html } = await page("/");
    expect(html).toContain("Expand all");
    expect(html).toContain("Collapse all");
    const lanes = [...html.matchAll(/<details class="lane" data-lane="([A-Z]+)"([^>]*)>/g)];
    expect(lanes.length).toBeGreaterThan(3);
    for (const lane of lanes) expect(lane[2], lane[1]).not.toMatch(/\sopen(?:\s|>)/);
  });

  it("serves the dashboard script and the board JSON behind UI auth", async () => {
    expect((await worker.fetch(`${UI}/api/board`)).status).toBe(403);
    expect((await worker.fetch(`${UI}/assets/dashboard.js`)).status).toBe(403);

    const lily = await member("lily");
    const feature = await core.createFeature(env.DB, lily, { module: "STS-CORE", title: "json board" });
    const task = await core.createTask(env.DB, lily, {
      feature: feature.code, title: "json only SCOS", assignee: "peter", ...fullRequest,
    });
    const other = await core.createFeature(env.DB, lily, { module: "SCG-CORE", title: "json other" });
    const elsewhere = await core.createTask(env.DB, lily, {
      feature: other.code, title: "json on SCG", assignee: "peter", ...fullRequest,
    });

    const headers = { "Cf-Access-Jwt-Assertion": await accessJwt("owner@example.com") };
    const script = await worker.fetch(`${UI}/assets/dashboard.js`, { headers });
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    const source = await script.text();
    expect(source).toContain("status-hub:project");
    expect(source).toContain("status-hub:lanes");
    expect(source).toContain("status-hub:task-tab");
    expect(source).toContain("data-inline-edit");
    expect(source).toContain("replaceWith");
    expect(source).toContain("metaKey");
    expect(source).toContain("/api/board");
    expect(source).toContain("showModal");

    const body = await worker.fetch(`${UI}/api/board?project=STS&q=${encodeURIComponent("json only")}`, { headers });
    expect(body.status).toBe(200);
    expect(body.headers.get("content-type")).toContain("application/json");
    const json = await body.json() as {
      project: string;
      cards: { code: string; project_code: string; html: string }[];
    };
    expect(json.project).toBe("STS");
    expect(json.cards.map((c) => c.code)).toContain(task.code);
    expect(json.cards.map((c) => c.code)).not.toContain(elsewhere.code);
    expect(json.cards.every((c) => c.project_code === "STS")).toBe(true);
    expect(json.cards.find((c) => c.code === task.code)?.html).toContain("json only SCOS");
  });

  it("returns a task fragment for the drawer and keeps the full page", async () => {
    const lily = await member("lily");
    const feature = await core.createFeature(env.DB, lily, { module: "STS-CORE", title: "fragment feature" });
    const task = await core.createTask(env.DB, lily, {
      feature: feature.code, title: "fragment task", assignee: "mira", ...fullRequest,
    });
    const headers = { "Cf-Access-Jwt-Assertion": await accessJwt("owner@example.com") };
    const full = await page(`/t/${task.code}`);
    expect(full.html).toContain("<!doctype html>");
    expect(full.html).toContain('class="sidebar"');
    expect(full.html).toContain('id="task-detail"');

    const frag = await worker.fetch(`${UI}/t/${task.code}?fragment=1`, { headers });
    expect(frag.status).toBe(200);
    const html = await frag.text();
    expect(html).toContain('id="task-detail"');
    expect(html).toContain("fragment task");
    expect(html).toContain("Time in status");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('data-tab="overview"');
    expect(html).toContain('data-tab="timeline"');
    expect(html).toContain('data-tab="history"');
    expect(html).toContain('data-tab="blockers"');
    expect(html).not.toContain('data-tab="feedback"');
    expect(html).toContain('class="feedback-dock"');
    expect(html).toContain('class="feedback-pane"');
    expect(html).toContain("fragment task");
    const overview = html.slice(html.indexOf('id="panel-overview"'), html.indexOf('id="panel-timeline"'));
    expect(overview).not.toContain('class="card');
    expect(overview).not.toContain("<th>Field</th>");
    expect(overview).not.toContain("<th>Value</th>");
    expect(overview.match(/<table/g)).toHaveLength(2);
    expect(html).toContain('rows="1"');
    expect(html).toContain('data-inline-edit');
    expect(html).toContain('name="pr_url"');
    expect(html).toContain('<span class="ie-form" hidden>');
    const timeline = await worker.fetch(`${UI}/t/${task.code}?tab=timeline`, { headers });
    const timelineHtml = await timeline.text();
    expect(timelineHtml).toContain('data-tab="timeline" aria-selected="true"');
    expect(timelineHtml).toContain('id="panel-overview" class="task-panel" data-tab-panel="overview" aria-labelledby="tab-overview" hidden');
    expect(html.toLowerCase()).not.toContain("<!doctype");
    expect(html).not.toContain('class="sidebar"');
    expect(html).not.toContain("<script");
  });
});
