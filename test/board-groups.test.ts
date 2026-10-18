import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CLIENT_SCRIPT } from "../src/client-script";
import { INK_DARK, INK_LIGHT, SURFACE_DARK, SURFACE_LIGHT, contrastRatio, featureHue, featurePalette } from "../src/feature-color";
import { clusterByFeature, sortTasks, type SortableTask } from "../src/groups";
import * as core from "../src/core";
import { accessJwt, member, UI, worker } from "./helpers";

const CODES = [
  "KBN-CORE-001", "KBN-CORE-002", "KBN-CORE-003", "KBN-CORE-014",
  "APP-MAIL-001", "STS-CORE-001", "VMB-CORE-010", "CNT-CORE-002",
  "SCOS-AUTH-008", "XDL-CORE-120", "SCG-CORE-004", "SCT-CORE-077",
];

function task(partial: Partial<SortableTask> & Pick<SortableTask, "code" | "title" | "feature_code">): SortableTask {
  return {
    project_code: "KBN",
    feature_title: partial.feature_code,
    status: "backlog",
    assignee_id: "peter",
    reviewer_id: null,
    priority: "P2",
    due_at: null,
    pr_url: null,
    status_since: 0,
    last_update_at: 0,
    ...partial,
  };
}

async function html(path: string, email = "owner@example.com"): Promise<string> {
  const res = await worker.fetch(`${UI}${path}`, {
    headers: { "Cf-Access-Jwt-Assertion": await accessJwt(email) },
  });
  expect(res.status, path).toBe(200);
  return res.text();
}

async function project(code: string) {
  const lily = await member("lily");
  await core.createProject(env.DB, lily, { code, name: code });
  return lily;
}

describe("feature color", () => {
  it("is deterministic and spreads distinct hues", () => {
    for (const code of CODES) {
      expect(featurePalette(code)).toEqual(featurePalette(code));
      expect(featureHue(code)).toBe(featureHue(code));
    }
    const hues = new Set(CODES.map((code) => featureHue(code)));
    expect(hues.size).toBe(CODES.length);
    expect(featurePalette("KBN-CORE-001").light.bg).not.toBe(featurePalette("KBN-CORE-002").light.bg);
  });

  it("keeps text and outline contrast in light and dark themes", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeGreaterThan(20);
    for (const code of CODES) {
      const p = featurePalette(code);
      expect(contrastRatio(INK_LIGHT, p.light.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(INK_DARK, p.dark.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.light.border, SURFACE_LIGHT)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(p.dark.border, SURFACE_DARK)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(p.light.border, p.light.bg)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(p.dark.border, p.dark.bg)).toBeGreaterThanOrEqual(3);
      expect(p.light.bg).not.toBe(p.dark.bg);
    }
  });
});

describe("cluster and sort", () => {
  it("groups only features with at least minSize tasks and keeps input order", () => {
    const items = [
      { feature_code: "A", feature_title: "Alpha", id: 1 },
      { feature_code: "B", feature_title: "Beta", id: 2 },
      { feature_code: "A", feature_title: "Alpha", id: 3 },
      { feature_code: "C", feature_title: "Cee", id: 4 },
    ];
    expect(clusterByFeature(items, 2)).toEqual([
      { kind: "group", feature_code: "A", feature_title: "Alpha", tasks: [items[0], items[2]] },
      { kind: "task", task: items[1] },
      { kind: "task", task: items[3] },
    ]);
    expect(clusterByFeature(items, 1).filter((item) => item.kind === "group")).toHaveLength(3);
  });

  it("sorts columns with empty values last and a stable code tie-break", () => {
    const rows = [
      task({ code: "A.2", title: "B", feature_code: "A", due_at: 200, priority: "P1" }),
      task({ code: "A.1", title: "A", feature_code: "A", due_at: null, priority: "P2" }),
      task({ code: "B.1", title: "A", feature_code: "B", due_at: 50, priority: "P0" }),
    ];
    expect(sortTasks(rows, "title", "asc", 0).map((row) => row.code)).toEqual(["A.1", "B.1", "A.2"]);
    expect(sortTasks(rows, "title", "desc", 0).map((row) => row.code)).toEqual(["A.2", "A.1", "B.1"]);
    expect(sortTasks(rows, "due", "asc", 0).map((row) => row.code)).toEqual(["B.1", "A.2", "A.1"]);
    expect(sortTasks(rows, "priority", "asc", 0).map((row) => row.code)).toEqual(["B.1", "A.2", "A.1"]);
    expect(sortTasks(rows, "status", "asc", 0).map((row) => row.status)[0]).toBe("backlog");
  });
});

describe("Kanban feature groups", () => {
  it("boxes tasks that share a feature inside one column and leaves a single task as a card", async () => {
    const lily = await project("KBN");
    const grouped = await core.createFeature(env.DB, lily, { module: "KBN-CORE", title: "Grouped inbox", priority: "P1" });
    const solo = await core.createFeature(env.DB, lily, { module: "KBN-CORE", title: "Solo note" });
    const a = await core.createTask(env.DB, lily, { feature: grouped.code, title: "Group one", assignee: "peter" });
    const b = await core.createTask(env.DB, lily, { feature: grouped.code, title: "Group two", assignee: "peter" });
    const alone = await core.createTask(env.DB, lily, { feature: grouped.code, title: "Other column", assignee: "mira" });
    await env.DB.prepare("UPDATE tasks SET status = 'backlog' WHERE code = ?").bind(alone.code).run();
    const c = await core.createTask(env.DB, lily, { feature: solo.code, title: "Just one", assignee: "mira" });

    const body = await html("/?project=KBN");
    const pal = featurePalette(grouped.code);
    expect(body).toContain(`data-group="board:pending_approval:${grouped.code}"`);
    expect(body).toContain(`data-feature="${grouped.code}"`);
    expect(body).toContain(pal.light.bg);
    expect(body).toContain(pal.dark.bg);
    expect(body).toContain(pal.light.border);
    const block = body.match(new RegExp(`<details class="group"[^>]*data-feature="${grouped.code}"[\\s\\S]*?</details>`))?.[0] ?? "";
    expect(block).toContain(a.code);
    expect(block).toContain(b.code);
    expect(block).toContain(grouped.code);
    expect(block).toContain("Grouped inbox");
    expect(block).toContain(`<span class="gcount">2</span>`);
    expect(block).toContain('class="chev"');
    expect(block).toContain(" open");
    expect(block).not.toContain(alone.code);
    expect(block).not.toContain('class="lane"');
    expect(block).not.toContain('class="colh');
    expect(body).not.toContain(`data-feature="${solo.code}"`);
    expect(body).not.toContain(`data-group="board:backlog:${grouped.code}"`);
    expect(body).toMatch(new RegExp(`class="card s-pending_approval"[^>]*>[\\s\\S]*?${c.code}`));
    expect(body).toMatch(new RegExp(`class="card s-backlog"[^>]*>[\\s\\S]*?${alone.code}`));
    expect(body).toContain('id="groups-expand"');
    expect(body).toContain('id="groups-collapse"');
    expect(body).toContain("Expand all groups");
    expect(body).toContain("Collapse all groups");
    expect(body).toContain("status-hub:collapsed-groups");
    expect(body).toContain("details.group[data-group]");
    expect(CLIENT_SCRIPT).not.toContain(".lane");
    expect(body).toContain("--radius:5px");
    expect(body).toContain("body.fit{height:100vh;overflow:hidden");
    expect(body).toContain("position:sticky");
    expect(body).toContain('class="fit"');
    const laneAt = body.indexOf('class="lane"');
    const groupAt = body.indexOf(`data-feature="${grouped.code}"`);
    expect(laneAt).toBeGreaterThan(-1);
    expect(groupAt).toBeGreaterThan(laneAt);
  });
});

describe("table view", () => {
  it("lists one row per task, grouped and tinted, and honors filters and sort", async () => {
    const lily = await project("TBL");
    const alpha = await core.createFeature(env.DB, lily, { module: "TBL-CORE", title: "Alpha feature", priority: "P0" });
    const beta = await core.createFeature(env.DB, lily, { module: "TBL-CORE", title: "Beta feature", priority: "P2" });
    const zebra = await core.createTask(env.DB, lily, {
      feature: alpha.code, title: "Zebra unique", assignee: "peter", due_at: 2_000,
      pr_url: "https://github.com/example/repo/pull/4",
    });
    const apple = await core.createTask(env.DB, lily, {
      feature: alpha.code, title: "Apple unique", assignee: "mira", due_at: 9_000,
    });
    const other = await core.createTask(env.DB, lily, {
      feature: beta.code, title: "Other project row", assignee: "peter",
    });
    await env.DB.prepare("UPDATE tasks SET reviewer_id = 'quinn', status = 'backlog' WHERE code = ?").bind(apple.code).run();

    const board = await html("/?project=TBL&view=board");
    expect(board).toContain('class="board"');
    expect(board).not.toContain('class="tasks"');
    expect(board).toContain('aria-current="page"');

    const table = await html("/?view=table&project=TBL");
    expect(table).toContain('class="tasks"');
    expect(table).not.toContain('class="board"');
    for (const label of ["Code", "Title", "Project", "Feature", "Status", "Assignee", "Reviewer", "Priority", "Due", "Time in status", "PR"]) {
      expect(table).toContain(label);
    }
    expect(table.match(/<tr class="task-row"/g)?.length).toBe(3);
    expect(table).toContain(`data-group="table:${alpha.code}"`);
    expect(table).toContain(featurePalette(alpha.code).light.bg);
    expect(table).toContain(featurePalette(beta.code).light.bg);
    expect(featurePalette(alpha.code).light.bg).not.toBe(featurePalette(beta.code).light.bg);
    expect(table).toContain(`<span class="gcount">2</span>`);
    expect(table).toContain(`<span class="gcount">1</span>`);
    expect(table).toContain("quinn");
    expect(table).toContain("P0");
    expect(table).toContain('class="g-toggle"');
    expect(table).toContain('href="/?view=board&amp;project=TBL"');
    expect(table).toContain('href="/?view=table&amp;project=TBL');
    expect(table).toContain(`task=${encodeURIComponent(zebra.code)}`);

    const asc = await html("/?view=table&project=TBL&sort=title&dir=asc");
    expect(asc.indexOf("Apple unique")).toBeLessThan(asc.indexOf("Zebra unique"));
    const desc = await html("/?view=table&project=TBL&sort=title&dir=desc");
    expect(desc.indexOf("Zebra unique")).toBeLessThan(desc.indexOf("Apple unique"));
    expect(asc).toContain("sort=title");
    expect(asc).toContain('aria-sort="ascending"');

    const memberFiltered = await html("/?view=table&project=TBL&member=mira");
    expect(memberFiltered).toContain(apple.code);
    expect(memberFiltered).not.toContain(zebra.code);
    const statusFiltered = await html("/?view=table&project=TBL&status=backlog");
    expect(statusFiltered).toContain(apple.code);
    expect(statusFiltered).not.toContain(zebra.code);
    const found = await html(`/?view=table&project=TBL&q=${encodeURIComponent("Zebra unique")}`);
    expect(found).toContain(zebra.code);
    expect(found).not.toContain(other.code);
    expect(found).not.toContain(apple.code);

    const drawer = await html(`/?view=table&project=TBL&task=${encodeURIComponent(zebra.code)}`);
    expect(drawer).toContain('class="drawer"');
    expect(drawer).toContain("Zebra unique");
    expect(drawer).toContain('class="drawer-close"');
    expect(drawer).toContain("Time in status");
    const zebraRow = drawer.match(new RegExp(`<tr class="task-row"[\\s\\S]*?${zebra.code}[\\s\\S]*?</tr>`))?.[0] ?? "";
    expect(zebraRow).toContain('name="pr_url"');
    expect(zebraRow).toContain("https://github.com/example/repo/pull/4");

    const jane = await html("/?view=table&project=TBL", "jane@example.com");
    const janeRow = jane.match(new RegExp(`<tr class="task-row"[\\s\\S]*?${zebra.code}[\\s\\S]*?</tr>`))?.[0] ?? "";
    expect(janeRow).not.toContain('name="pr_url"');
    expect(jane).toContain("https://github.com/example/repo/pull/4");
  });

  it("returns inline PR edits to the table and rejects an off-site next", async () => {
    const lily = await member("lily");
    const feature = await core.createFeature(env.DB, lily, { module: "TBL-CORE", title: "PR return" });
    const created = await core.createTask(env.DB, lily, { feature: feature.code, title: "Editable PR", assignee: "peter" });
    const next = `/?view=table&project=TBL&task=${created.code}`;
    const post = async (pr: string, nextValue: string) => worker.fetch(`${UI}/t/${created.code}`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": await accessJwt("owner@example.com"),
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
      },
      body: new URLSearchParams({ pr_url: pr, next: nextValue }).toString(),
      redirect: "manual",
    });
    const ok = await post("https://github.com/example/repo/pull/15", next);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(next);
    expect((await core.getTaskRow(env.DB, created.code)).pr_url).toBe("https://github.com/example/repo/pull/15");

    const evil = await post("https://github.com/example/repo/pull/16", "https://evil.example/phish");
    expect(evil.status).toBe(303);
    expect(evil.headers.get("location")).toBe(`/t/${created.code}`);
    expect((await core.getTaskRow(env.DB, created.code)).pr_url).toBe("https://github.com/example/repo/pull/16");

    const bad = await post("javascript:alert(1)", next);
    expect(bad.status).toBe(400);
    const page = await bad.text();
    expect(page).toContain('class="tasks"');
    expect(page).toContain('class="drawer"');
    expect(page).toContain("http hoặc https");
    expect((await core.getTaskRow(env.DB, created.code)).pr_url).toBe("https://github.com/example/repo/pull/16");
  });

  it("serves the inline script under a matching CSP hash", async () => {
    const res = await worker.fetch(`${UI}/?project=KBN`, {
      headers: { "Cf-Access-Jwt-Assertion": await accessJwt("owner@example.com") },
    });
    const body = await res.text();
    const script = body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBe(CLIENT_SCRIPT);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script!));
    let bin = "";
    for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`script-src 'sha256-${btoa(bin)}'`);
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).not.toContain("unsafe-eval");
  });
});
