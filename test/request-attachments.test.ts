import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ATTACHMENTS_UNAVAILABLE, addAttachmentBytes, attachmentPolicy, decodeBase64 } from "../src/attachments";
import * as core from "../src/core";
import { diffLines } from "../src/diff";
import { renderMarkdown } from "../src/markdown";
import { fmt } from "../src/ui";
import { accessJwt, fullRequest, issueToken, mcpCall, member, MCP, UI, worker } from "./helpers";

const T0 = Date.UTC(2026, 9, 18, 3, 0);
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const policy = attachmentPolicy({});

async function task(title: string) {
  const lily = await member("lily");
  const feature = await core.createFeature(env.DB, lily, { module: "STS-CORE", title }, T0);
  const created = await core.createTask(env.DB, lily, {
    feature: feature.code, title, assignee: "peter", ...fullRequest,
  }, T0);
  return created.code;
}

async function ui(path: string, email = "owner@example.com") {
  return worker.fetch(`${UI}${path}`, { headers: { "Cf-Access-Jwt-Assertion": await accessJwt(email) } });
}

describe("request versions", () => {
  it("keeps every edit and renders the latest markdown without raw HTML", async () => {
    const code = await task("request doc");
    const lily = await member("lily");
    const first = await core.setRequestDocument(env.DB, lily, {
      task: code,
      markdown: "## Who requested\n\nAda\n\n<script>alert(1)</script>\n\n[spec](javascript:alert(1))\n\n[board](https://example.com/spec)",
      note: "first draft",
    }, T0 + 1);
    expect(first.version).toBe(1);
    const second = await core.setRequestDocument(env.DB, lily, {
      task: code,
      markdown: "## What\n\nShip the board\n\n## Why\n\nOperators need one place",
      note: "scope",
    }, T0 + 2);
    expect(second.version).toBe(2);
    const v1 = await core.getRequestDocument(env.DB, code, 1);
    expect(v1.markdown).toContain("<script>alert(1)</script>");
    expect(v1.note).toBe("first draft");
    const latest = await core.getRequestDocument(env.DB, code);
    expect(latest.version).toBe(2);
    expect(latest.markdown).toContain("Ship the board");
    expect(latest.versions.map((item) => item.version)).toEqual([2, 1]);

    const html = await (await ui(`/t/${code}?tab=overview`)).text();
    expect(html).toContain("<h2>What</h2>");
    expect(html).toContain("Ship the board");
    expect(html).not.toContain("<script>");
    expect(html).toContain('name="rv"');
    expect(html).toContain("v2");
    expect(html).toContain('data-inline-kind="markdown"');
    expect(html).toContain('<span class="ie-form" hidden>');
    expect(html).not.toContain("data-md-preview");
    const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    const layoutAt = style.indexOf(".request-edit .ie-view,.request-edit .ie-form{");
    const hiddenAt = style.indexOf(".request-edit .ie-form[hidden],.request-edit .ie-view[hidden]{display:none}");
    expect(layoutAt).toBeGreaterThan(0);
    expect(hiddenAt).toBeGreaterThan(layoutAt);
    expect(style.slice(layoutAt, layoutAt + 120)).not.toContain("display:flex");
    const attachAt = html.indexOf('id="attachments"');
    const attachments = html.slice(attachAt, html.indexOf("<h2>", attachAt));
    expect(attachments).not.toContain("<textarea");
    expect(attachments).not.toContain("ie-form");

    const older = await (await ui(`/t/${code}?tab=overview&rv=1`)).text();
    expect(older).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(older).not.toContain('href="javascript:');
    expect(older).toContain('href="https://example.com/spec"');
    expect(older).toContain('target="_blank"');
    expect(older).toContain('rel="noopener noreferrer"');

    const diff = await (await ui(`/t/${code}?tab=overview&rv=2&diff=1`)).text();
    expect(diff).toContain("diff-add");
    expect(diff).toContain("diff-del");
    expect(diffLines(v1.markdown ?? "", latest.markdown ?? "").some((line) => line.kind === "add")).toBe(true);
  });

  it("serves set_request, get_request, and create_task request markdown over MCP", async () => {
    const token = await issueToken("lily");
    const feature = (await mcpCall(token, "create_feature", { module: "STS-CORE", title: "mcp request" })).data.code as string;
    const created = await mcpCall(token, "create_task", {
      feature, title: "with a request", assignee: "peter", ...fullRequest,
      request: "## Who requested\n\nOwner\n\n## What\n\nA versioned brief",
    });
    expect(created.isError).toBeFalsy();
    expect(created.data.request_version).toBe(1);
    const code = created.data.code as string;
    const got = await mcpCall(token, "get_request", { task: code });
    expect(got.data.version).toBe(1);
    expect(got.data.markdown).toContain("versioned brief");
    const next = await mcpCall(token, "set_request", { task: code, markdown: "## What\n\nRevised", note: "tighter" });
    expect(next.data.version).toBe(2);
    const old = await mcpCall(token, "get_request", { task: code, version: 1 });
    expect(old.data.markdown).toContain("versioned brief");
    const missing = await mcpCall(token, "get_request", { task: code, version: 9 });
    expect(missing.isError).toBe(true);
    expect(missing.data).toMatchObject({ error: "NOT_FOUND", status: 404 });
    const detail = await mcpCall(token, "get_task", { code });
    expect(detail.data.request).toMatchObject({ version: 2, markdown: "## What\n\nRevised" });
    expect(detail.data.attachments_configured).toBe(true);
  });
});

describe("attachments and review", () => {
  it("versions files in R2, hides nothing when the binding exists, and requires auth to download", async () => {
    const code = await task("files");
    const peter = await member("peter");
    const first = await addAttachmentBytes(env.DB, env.ATTACHMENTS, peter, {
      task: code, group: "requirement", name: "notes.txt", mime: "text/plain", note: "v1", bytes: new TextEncoder().encode("alpha"),
    }, policy, T0 + 1);
    const second = await addAttachmentBytes(env.DB, env.ATTACHMENTS, peter, {
      task: code, group: "requirement", name: "notes.txt", mime: "text/plain", note: "v2", bytes: new TextEncoder().encode("beta"),
    }, policy, T0 + 2);
    expect(second.version).toBe(2);
    expect(second.r2_key).not.toBe(first.r2_key);
    const png = decodeBase64(PNG_B64);
    const shot = await addAttachmentBytes(env.DB, env.ATTACHMENTS, peter, {
      task: code, group: "output", name: "shot.png", mime: "image/png", bytes: png,
    }, policy, T0 + 3);
    const listed = await env.ATTACHMENTS.list();
    const keys = listed.objects.map((obj) => obj.key);
    expect(keys).toContain(first.r2_key);
    expect(keys).toContain(second.r2_key);
    expect(keys).toContain(shot.r2_key);

    const anon = await worker.fetch(`${UI}/t/${code}/attachments/${first.id}?v=1`);
    expect(anon.status).toBe(403);
    const v1 = await ui(`/t/${code}/attachments/${first.id}?v=1`);
    expect(v1.status).toBe(200);
    expect(v1.headers.get("content-type")).toContain("text/plain");
    expect(v1.headers.get("content-disposition")).toContain("attachment");
    expect(await v1.text()).toBe("alpha");
    const v2 = await ui(`/t/${code}/attachments/${first.id}?v=2`);
    expect(await v2.text()).toBe("beta");
    const image = await ui(`/t/${code}/attachments/${shot.id}`);
    expect(image.headers.get("content-type")).toContain("image/png");
    expect(image.headers.get("content-disposition")).toContain("inline");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
    const otherTask = await worker.fetch(`${UI}/t/STS-CORE-001.1/attachments/${shot.id}`, {
      headers: { "Cf-Access-Jwt-Assertion": await accessJwt("owner@example.com") },
    });
    expect(otherTask.status).toBe(404);
    const mcpHost = await worker.fetch(`${MCP.replace(/\/mcp$/, "")}/t/${code}/attachments/${shot.id}`, {
      headers: { authorization: `Bearer ${await issueToken("peter")}` },
    });
    expect(mcpHost.status).toBe(404);

    const page = await (await ui(`/t/${code}?tab=overview`)).text();
    expect(page).toContain(">Requirement<");
    expect(page).toContain(">Output<");
    expect(page).toContain("notes.txt");
    expect(page).toContain("shot.png");
    expect(page).toContain("History for notes.txt");
    expect(page).toContain("Add file");
    expect(page).not.toContain("attach-preview");
    expect(page).toContain(`src="/t/${code}/attachments/${shot.id}?v=1"`);
    expect(page).not.toContain(first.r2_key);

    const badType = await addAttachmentBytes(env.DB, env.ATTACHMENTS, peter, {
      task: code, group: "requirement", name: "page.html", mime: "text/html", bytes: new TextEncoder().encode("<b>x</b>"),
    }, policy).catch((err) => err);
    expect(badType).toMatchObject({ code: "BAD_REQUEST" });
    const fakePng = await addAttachmentBytes(env.DB, env.ATTACHMENTS, peter, {
      task: code, group: "output", name: "fake.png", mime: "image/png", bytes: new TextEncoder().encode("not a png"),
    }, policy).catch((err) => err);
    expect(fakePng).toMatchObject({ code: "BAD_REQUEST" });
    const unbound = await addAttachmentBytes(env.DB, null, peter, {
      task: code, group: "output", name: "x.txt", mime: "text/plain", bytes: new TextEncoder().encode("x"),
    }, policy).catch((err) => err);
    expect(unbound).toMatchObject({ code: "BAD_REQUEST", message: ATTACHMENTS_UNAVAILABLE });
  });

  it("uploads through MCP base64 and the upload URL, and lists both groups", async () => {
    const code = await task("mcp files");
    const token = await issueToken("peter");
    const added = await mcpCall(token, "add_attachment", {
      task: code, group: "requirement", name: "brief.txt", mime: "text/plain", note: "input",
      content_base64: btoa("spec"),
    });
    expect(added.isError).toBeFalsy();
    expect(added.data).toMatchObject({ version: 1, name: "brief.txt", group: "requirement" });
    expect(added.data.r2_key).toBeUndefined();
    const pending = await mcpCall(token, "add_attachment", {
      task: code, group: "output", name: "report.txt", mime: "text/plain", upload: true, note: "deliverable",
    });
    expect(pending.data.pending).toBe(true);
    expect(pending.data.upload_path).toMatch(/^\/attachment-uploads\//);
    const unauth = await worker.fetch(`${MCP.replace(/\/mcp$/, "")}${pending.data.upload_path}`, {
      method: "POST",
      body: "report-v1",
    });
    expect(unauth.status).toBe(401);
    const uploaded = await worker.fetch(`${MCP.replace(/\/mcp$/, "")}${pending.data.upload_path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
      body: "report-v1",
    });
    expect(uploaded.status).toBe(200);
    const again = await mcpCall(token, "add_attachment", {
      task: code, group: "output", name: "report.txt", mime: "text/plain", content_base64: btoa("report-v2"),
    });
    expect(again.data.version).toBe(2);
    const list = await mcpCall(token, "list_attachments", { task: code });
    expect(list.data.configured).toBe(true);
    expect(list.data.requirement[0]).toMatchObject({ name: "brief.txt" });
    expect(list.data.requirement[0].versions).toHaveLength(1);
    expect(list.data.output[0].latest.version).toBe(2);
    expect(list.data.output[0].versions.map((item: { version: number }) => item.version)).toEqual([2, 1]);
    const detail = await mcpCall(token, "get_task", { code });
    expect(detail.data.attachments.requirement[0]).toMatchObject({ name: "brief.txt", latest_version: 1, version_count: 1 });
    expect(detail.data.attachments.output[0]).toMatchObject({ name: "report.txt", latest_version: 2, version_count: 2 });
    const privateUrl = await mcpCall(token, "add_attachment", {
      task: code, group: "requirement", name: "secret.txt", mime: "text/plain", source_url: "http://127.0.0.1/secret",
    });
    expect(privateUrl.isError).toBe(true);
    expect(privateUrl.data.message).toMatch(/public http/i);
  });

  it("blocks review until an output exists and records the versions feedback refers to", async () => {
    const code = await task("needs output");
    const peter = await member("peter");
    await core.reportStatus(env.DB, peter, { task: code, status: "assigned" }, T0 + 1);
    await core.reportStatus(env.DB, peter, { task: code, status: "in_progress" }, T0 + 2);
    await core.setRequestDocument(env.DB, peter, { task: code, markdown: "## What\n\nReview this" }, T0 + 3);
    const blocked = await core.reportStatus(env.DB, peter, { task: code, status: "review", reviewer: "quinn" }, T0 + 4).catch((err) => err);
    expect(blocked).toMatchObject({ code: "BAD_REQUEST" });
    expect(blocked.message).toMatch(/output/i);
    expect((await core.getTaskRow(env.DB, code)).status).toBe("in_progress");

    await addAttachmentBytes(env.DB, env.ATTACHMENTS, peter, {
      task: code, group: "requirement", name: "only-input.txt", mime: "text/plain", bytes: new TextEncoder().encode("in"),
    }, policy, T0 + 5);
    const still = await core.reportStatus(env.DB, peter, { task: code, status: "review", reviewer: "quinn" }, T0 + 6).catch((err) => err);
    expect(still).toMatchObject({ code: "BAD_REQUEST" });

    await addAttachmentBytes(env.DB, env.ATTACHMENTS, peter, {
      task: code, group: "output", name: "done.png", mime: "image/png", bytes: decodeBase64(PNG_B64),
    }, policy, T0 + 7);
    await expect(core.reportStatus(env.DB, peter, { task: code, status: "review", reviewer: "quinn" }, T0 + 8))
      .resolves.toMatchObject({ to: "review" });
    const update = await env.DB.prepare(
      "SELECT request_version, output_ref FROM updates WHERE task_code = ? AND status_to = 'review' ORDER BY id DESC LIMIT 1",
    ).bind(code).first<{ request_version: number; output_ref: string }>();
    expect(update?.request_version).toBe(1);
    expect(JSON.parse(update!.output_ref)).toMatchObject({ attachments: [{ name: "done.png", version: 1 }] });

    await core.addLeadershipFeedback(env.DB, { task: code, author: "Owner", note: "looks good" }, T0 + 9);
    const page = await (await ui(`/t/${code}?tab=overview`)).text();
    expect(page).toContain("looks good");
    expect(page).toContain("req v1");
    expect(page).toContain("done.png v1");

    const other = await task("link output");
    const assignee = await member("peter");
    await core.reportStatus(env.DB, assignee, { task: other, status: "assigned" }, T0 + 1);
    await core.reportStatus(env.DB, assignee, { task: other, status: "in_progress" }, T0 + 2);
    await core.addOutputLink(env.DB, assignee, { task: other, url: "https://example.com/output/report" }, T0 + 3);
    await expect(core.reportStatus(env.DB, assignee, { task: other, status: "review", reviewer: "quinn" }, T0 + 4))
      .resolves.toMatchObject({ to: "review" });
    const linkUpdate = await env.DB.prepare(
      "SELECT output_ref FROM updates WHERE task_code = ? AND status_to = 'review'",
    ).bind(other).first<{ output_ref: string }>();
    expect(JSON.parse(linkUpdate!.output_ref).links).toContain("https://example.com/output/report");
  });
});

describe("markdown sanitizer", () => {
  it("escapes raw HTML and refuses non-http links", () => {
    const html = renderMarkdown(`# Title\n\n<img src=x onerror="alert(1)">\n\n[ok](https://example.com/a)\n\n[bad](javascript:alert(1))\n\n**bold**`);
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img");
    expect(html).toContain("onerror=&quot;");
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("javascript:");
    const shot = renderMarkdown("![spec.png](/t/APP-CORE-001.1/attachments/1?v=2)\n\n![remote](https://example.com/a.png)\n\n![bad](javascript:alert(1))");
    expect(shot).toContain('class="md-thumb"');
    expect(shot).toContain('src="/t/APP-CORE-001.1/attachments/1?v=2"');
    expect(shot).toContain('data-version="2"');
    expect(shot).toContain('src="https://example.com/a.png"');
    expect(shot).not.toContain("javascript:");
  });

  it("formats timestamps in the configured offset", () => {
    const at = Date.UTC(2026, 9, 18, 1, 23);
    expect(fmt(at, 0)).toBe("18/10 01:23");
    expect(fmt(at, 420)).toBe("18/10 08:23");
  });
});
