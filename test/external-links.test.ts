import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as core from "../src/core";
import { accessJwt, fullRequest, member, UI, worker } from "./helpers";

const REQUEST = "https://example.com/requests/external-1";
const PR = "https://example.com/repos/sample/pull/27";
const NOTE = "https://example.com/notes/handoff";
const REPO = "https://example.com/repos/sample";

function anchors(html: string): { href: string; block: string }[] {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((m) => ({
    href: /href="([^"]*)"/.exec(m[1] ?? "")?.[1] ?? "",
    block: m[0],
  }));
}

function expectLinkPolicy(html: string) {
  const found = anchors(html);
  expect(found.length).toBeGreaterThan(0);
  let external = 0;
  for (const link of found) {
    const abs = /^https?:\/\//i.test(link.href);
    if (abs) {
      external += 1;
      expect(link.block, link.href).toContain('target="_blank"');
      expect(link.block, link.href).toContain('rel="noopener noreferrer"');
      expect(link.block, link.href).toContain('class="ext"');
      expect(link.block, link.href).toContain("opens in a new tab");
    } else {
      expect(link.block, link.href).not.toContain("target=");
      expect(link.block, link.href).not.toContain("noopener");
    }
  }
  expect(external).toBeGreaterThan(0);
}

describe("external links", () => {
  it("opens off-site hrefs in a new tab and leaves internal links in this tab", async () => {
    const lily = await member("lily");
    const feature = await core.createFeature(env.DB, lily, { module: "STS-CORE", title: "external links" });
    const task = await core.createTask(env.DB, lily, {
      feature: feature.code,
      title: "ship the handoff",
      assignee: "peter",
      pr_url: PR,
      ...fullRequest,
      request_link: REQUEST,
    });
    await core.addNote(env.DB, lily, { task: task.code, note: "handoff notes", links: [NOTE] });
    await env.DB.prepare("UPDATE projects SET repo_url = ? WHERE code = ?").bind(REPO, "STS").run();

    const headers = { "Cf-Access-Jwt-Assertion": await accessJwt("owner@example.com") };
    const taskPage = await (await worker.fetch(`${UI}/t/${task.code}`, { headers })).text();
    const fragment = await (await worker.fetch(`${UI}/t/${task.code}?fragment=1`, { headers })).text();
    const project = await (await worker.fetch(`${UI}/p/STS`, { headers })).text();
    const board = await (await worker.fetch(`${UI}/?project=STS`, { headers })).text();

    for (const html of [taskPage, fragment]) {
      expectLinkPolicy(html);
      for (const url of [REQUEST, PR, NOTE]) expect(html).toContain(url);
    }
    expectLinkPolicy(project);
    expect(project).toContain(REPO);

    const internal = anchors(board).filter((link) => !/^https?:\/\//i.test(link.href));
    expect(internal.length).toBeGreaterThan(0);
    for (const link of internal) {
      expect(link.block, link.href).not.toContain("target=");
      expect(link.block, link.href).not.toContain("noopener");
    }
    expect(anchors(board).some((link) => /^https?:\/\//i.test(link.href))).toBe(false);
  });
});