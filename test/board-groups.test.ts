import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DASHBOARD_JS } from "../src/dashboard-client";
import {
  CARD_DARK, CARD_LIGHT, INK_DARK, INK_LIGHT, SURFACE_DARK, SURFACE_LIGHT,
  contrastRatio, featureHue, featurePalette,
} from "../src/feature-color";
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

function channelGap(a: string, b: string): number {
  const bytes = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16));
  const [ar, ag, ab] = bytes(a);
  const [br, bg, bb] = bytes(b);
  return Math.max(Math.abs(ar! - br!), Math.abs(ag! - bg!), Math.abs(ab! - bb!));
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

  it("keeps a pale fill and a readable outline in light and dark themes", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeGreaterThan(20);
    for (const code of CODES) {
      const p = featurePalette(code);
      expect(channelGap(p.light.bg, CARD_LIGHT)).toBeLessThanOrEqual(26);
      expect(channelGap(p.dark.bg, CARD_DARK)).toBeLessThanOrEqual(32);
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
    expect(body).toContain('class="sidebar"');
    expect(body).toContain('src="/assets/dashboard.js"');
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
    expect(block).not.toContain('data-lane=');
    expect(body).not.toContain(`data-group="board:pending_approval:${solo.code}"`);
    expect(body).not.toContain(`data-group="board:backlog:${grouped.code}"`);
    expect(body).toMatch(new RegExp(`class="card s-pending_approval"[^>]*>[\\s\\S]*?${c.code}`));
    expect(body).toMatch(new RegExp(`class="card s-backlog"[^>]*>[\\s\\S]*?${alone.code}`));
    expect(body).toContain('data-groups="open"');
    expect(body).toContain('data-groups="close"');
    expect(body).toContain("Expand groups");
    expect(body).toContain("Collapse groups");
    expect(DASHBOARD_JS).toContain("status-hub:groups");
    expect(DASHBOARD_JS).toContain("details.group");
    expect(body).toContain("--radius:5px");
    expect(body).toContain("position:sticky");
    expect(body).toContain("100dvh");
    const laneAt = body.indexOf(`data-lane="KBN"`);
    const groupAt = body.indexOf(`data-group="board:pending_approval:${grouped.code}"`);
    expect(laneAt).toBeGreaterThan(-1);
    expect(groupAt).toBeGreaterThan(laneAt);
  });
});

describe("table view", () => {
  it("lists one row per task, grouped and tinted, and honors filters and sort", async () => {
    const lily = await project("TBL");
    const alpha = await core.createFeature(env.DB, lily, { module: "TBL-CORE", title: "Alpha feature", priority: "P0" });
    const beta = await core.createFeature(env.DB, lily, { module: "TBL-CORE", title: "Beta feature", priority: "P2" });
    const due = Date.UTC(2026, 9, 17, 3, 0);
    const zebra = await core.createTask(env.DB, lily, {
      feature: alpha.code, title: "Zebra unique", assignee: "peter", due_at: due,
      pr_url: "https://github.com/example/repo/pull/4",
    });
    const apple = await core.createTask(env.DB, lily, {
      feature: alpha.code, title: "Apple unique", assignee: "mira", due_at: 9_000,
    });
    const other = await core.createTask(env.DB, lily, {
      feature: beta.code, title: "Other project row", assignee: "peter",
    });
    await env.DB.prepare("UPDATE tasks SET reviewer_id = 'quinn', status = 'backlog' WHERE code = ?").bind(apple.code).run();
    await env.DB.prepare("UPDATE settings SET value = '420' WHERE key = 'tz_offset_minutes'").run();

    const board = await html("/?project=TBL&view=board");
    expect(board).toContain('id="board"');
    expect(board).not.toContain('class="tasks"');
    expect(board).toContain('aria-current="page"');
    expect(board).toContain('class="sidebar"');

    const table = await html("/?view=table&project=TBL");
    expect(table).toContain('class="tasks"');
    expect(table).not.toContain('id="board"');
    expect(table).toContain('class="sidebar"');
    expect(table).toContain('class="topbar"');
    expect(table).toContain('id="drawer"');
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
    expect(table).toContain("17/10 10:00");
    expect(table).toContain('data-group-toggle');
    expect(table).toContain('href="/?project=TBL&amp;view=board"');
    expect(table).toContain('href="/?project=TBL&amp;view=table');
    expect(table).toContain(`href="/t/${zebra.code}"`);
    expect(table).toContain("padding:16px");
    expect(table).toContain("--radius:5px");
    expect(table).toContain("position:sticky");

    const zebraRow = table.match(new RegExp(`<tr class="task-row"[\\s\\S]*?${zebra.code}[\\s\\S]*?</tr>`))?.[0] ?? "";
    expect(zebraRow).toContain('data-inline-edit');
    expect(zebraRow).toContain('name="pr_url"');
    expect(zebraRow).toContain('<span class="ie-form" hidden>');
    expect(zebraRow).not.toContain(">Save<");
    expect(zebraRow).toContain('target="_blank"');
    expect(zebraRow).toContain('rel="noopener noreferrer"');
    expect(zebraRow).toContain("https://github.com/example/repo/pull/4");

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

    const jane = await html("/?view=table&project=TBL", "jane@example.com");
    const janeRow = jane.match(new RegExp(`<tr class="task-row"[\\s\\S]*?${zebra.code}[\\s\\S]*?</tr>`))?.[0] ?? "";
    expect(janeRow).not.toContain('name="pr_url"');
    expect(janeRow).toContain("https://github.com/example/repo/pull/4");
    expect(janeRow).toContain('target="_blank"');

    await env.DB.prepare("UPDATE settings SET value = '0' WHERE key = 'tz_offset_minutes'").run();
  });
});
