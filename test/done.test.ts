import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as core from "../src/core";
import { accessJwt, member, UI, worker } from "./helpers";

const DAY = 86_400_000;

function taskCodes(html: string): string[] {
  return [...html.matchAll(/href="\/t\/([^"]+)"/g)].map((m) => m[1]);
}

/** Create n done tasks. doneAt(i) is the done_at of task i. last_update_at is the reverse, so a last_update sort cannot pass. */
async function doneTasks(project: string, n: number, doneAt: (i: number) => number) {
  const lily = await member("lily");
  await core.createProject(env.DB, lily, { code: project, name: project });
  const f = await core.createFeature(env.DB, lily, { module: `${project}-CORE`, title: `${project} done` });
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = await core.createTask(env.DB, lily, { feature: f.code, title: `${project} ${i}`, assignee: "peter" });
    const at = doneAt(i);
    await env.DB.prepare("UPDATE tasks SET status = 'done', done_at = ?, last_update_at = ? WHERE code = ?")
      .bind(at, 10_000_000_000_000 - at, t.code).run();
    codes.push(t.code);
  }
  return codes;
}

async function html(path: string): Promise<string> {
  const res = await worker.fetch(`${UI}${path}`, {
    headers: { "Cf-Access-Jwt-Assertion": await accessJwt("owner@example.com") },
  });
  expect(res.status, path).toBe(200);
  return res.text();
}

describe("Done column", () => {
  it("shows only the 10 newest by done_at desc, and the link counts every done task after the filter", async () => {
    const now = Date.now();
    // i=0 is 33 days old; i=11 is now. Several of the top 10 are older than 7 days.
    const codes = await doneTasks("DOA", 12, (i) => now - (11 - i) * 3 * DAY);
    const open = await core.createTask(env.DB, await member("lily"), {
      feature: codes[0].slice(0, codes[0].lastIndexOf(".")), title: "still open", assignee: "peter",
    });
    const newest10 = codes.slice(2).reverse();

    const body = await html("/?project=DOA");
    expect(taskCodes(body)).toEqual([open.code, ...newest10]);
    expect(body).toContain("See all (12)");
    expect(body).toContain('href="/done?project=DOA"');

    const all = await html("/done?project=DOA");
    expect(taskCodes(all)).toEqual([...codes].reverse());
  });

  it("applies the project filter before the limit and carries it to the full list", async () => {
    const now = Date.now();
    // 11 done in DOB, oldest first. One newer task in DOC must not consume a DOB slot.
    const d02 = await doneTasks("DOB", 11, (i) => now - (10 - i) * DAY);
    const d03 = await doneTasks("DOC", 1, () => now + DAY);

    const filtered = await html("/?project=DOB");
    expect(taskCodes(filtered)).toEqual(d02.slice(1).reverse());
    expect(filtered).toContain("See all (11)");
    expect(filtered).toContain('href="/done?project=DOB"');

    const board = await html("/");
    const doneTotal = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'done'").first<{ n: number }>();
    expect(board).toContain(`See all (${doneTotal!.n})`);
    expect(board).toMatch(/<a href="\/done">See all \(\d+\)<\/a>/);
    // No project filter: the 10 newest done tasks overall, drawn in project-code lanes.
    const top = (await env.DB.prepare(
      "SELECT code, project_code FROM tasks WHERE status = 'done' ORDER BY done_at DESC, code DESC LIMIT 10",
    ).all<{ code: string; project_code: string }>()).results;
    const lanes = [...new Set(top.map((r) => r.project_code))].sort();
    const doneSet = new Set((await env.DB.prepare("SELECT code FROM tasks WHERE status = 'done'").all<{ code: string }>()).results.map((r) => r.code));
    expect(taskCodes(board).filter((c) => doneSet.has(c))).toEqual(
      lanes.flatMap((p) => top.filter((r) => r.project_code === p).map((r) => r.code)),
    );
    expect(top.some((r) => r.code === d03[0])).toBe(true);
    expect(top.some((r) => r.code === d02[0])).toBe(false);

    expect(taskCodes(await html("/done?project=DOB"))).toEqual([...d02].reverse());
    expect(taskCodes(await html("/done?project=DOC"))).toEqual(d03);
    const allDone = (await env.DB.prepare(
      "SELECT code FROM tasks WHERE status = 'done' ORDER BY done_at DESC, code DESC",
    ).all<{ code: string }>()).results.map((r) => r.code);
    expect(taskCodes(await html("/done"))).toEqual(allDone);
  });
});
