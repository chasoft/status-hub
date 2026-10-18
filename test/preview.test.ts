import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addAttachmentBytes, attachmentPolicy } from "../src/attachments";
import * as core from "../src/core";
import {
  PREVIEW_BYTE_CAP, PREVIEW_UNAVAILABLE, previewPlan,
} from "../src/preview";
import { accessJwt, fullRequest, member, MCP, UI, worker } from "./helpers";

const T0 = Date.UTC(2026, 9, 18, 3, 0);
const policy = attachmentPolicy({});
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

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

/** Stores bytes without the upload allowlist, so a binary type can be previewed. */
async function storeRaw(code: string, group: string, name: string, mime: string, bytes: Uint8Array): Promise<number> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO attachments (task_code, grp, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(code, group, name, "peter", now).run();
  const row = await env.DB.prepare(
    "SELECT id FROM attachments WHERE task_code = ? AND grp = ? AND name = ?",
  ).bind(code, group, name).first<{ id: number }>();
  if (!row) throw new Error("attachment row missing");
  const key = `attachments/${code}/${row.id}/v1/raw-bin`;
  await env.DB.prepare(
    `INSERT INTO attachment_versions (attachment_id, version, r2_key, mime, bytes, author_id, created_at, note)
     VALUES (?, 1, ?, ?, ?, 'peter', ?, NULL)`,
  ).bind(row.id, key, mime, bytes.byteLength, now).run();
  await env.ATTACHMENTS.put(key, bytes);
  return row.id;
}

describe("preview content types", () => {
  const cases: [string, string, string, string, boolean][] = [
    ["shot.png", "image/png", "image", "image/png", true],
    ["shot.jpg", "image/jpeg", "image", "image/jpeg", true],
    ["shot.jpeg", "application/octet-stream", "image", "image/jpeg", true],
    ["anim.gif", "image/gif", "image", "image/gif", true],
    ["pic.webp", "image/webp", "image", "image/webp", true],
    ["icon.svg", "image/svg+xml", "image", "image/svg+xml", true],
    ["photo.avif", "image/avif", "image", "image/avif", true],
    ["brief.pdf", "application/pdf", "pdf", "application/pdf", true],
    ["clip.mp4", "video/mp4", "video", "video/mp4", true],
    ["clip.webm", "video/webm", "video", "video/webm", true],
    ["clip.mov", "video/quicktime", "video", "video/quicktime", true],
    ["note.mp3", "audio/mpeg", "audio", "audio/mpeg", true],
    ["note.wav", "audio/wav", "audio", "audio/wav", true],
    ["note.ogg", "audio/ogg", "audio", "audio/ogg", true],
    ["note.m4a", "audio/mp4", "audio", "audio/mp4", true],
    ["brief.md", "text/markdown", "markdown", "text/plain; charset=utf-8", true],
    ["brief.markdown", "text/plain", "markdown", "text/plain; charset=utf-8", true],
    ["rows.csv", "text/csv", "table", "text/plain; charset=utf-8", true],
    ["rows.tsv", "text/tab-separated-values", "table", "text/plain; charset=utf-8", true],
    ["notes.txt", "text/plain", "text", "text/plain; charset=utf-8", true],
    ["run.log", "text/plain", "text", "text/plain; charset=utf-8", true],
    ["data.json", "application/json", "text", "text/plain; charset=utf-8", true],
    ["config.yaml", "text/yaml", "text", "text/plain; charset=utf-8", true],
    ["config.yml", "application/yaml", "text", "text/plain; charset=utf-8", true],
    ["feed.xml", "application/xml", "text", "text/plain; charset=utf-8", true],
    ["page.html", "text/html", "text", "text/plain; charset=utf-8", true],
    ["page.htm", "text/html", "text", "text/plain; charset=utf-8", true],
    ["app.js", "text/javascript", "text", "text/plain; charset=utf-8", true],
    ["app.ts", "text/plain", "text", "text/plain; charset=utf-8", true],
    ["app.tsx", "text/plain", "text", "text/plain; charset=utf-8", true],
    ["job.py", "text/x-python", "text", "text/plain; charset=utf-8", true],
    ["run.sh", "text/x-shellscript", "text", "text/plain; charset=utf-8", true],
    ["q.sql", "application/sql", "text", "text/plain; charset=utf-8", true],
    ["site.css", "text/css", "text", "text/plain; charset=utf-8", true],
    ["blob.bin", "application/octet-stream", "binary", "application/octet-stream", false],
    ["noext", "application/octet-stream", "binary", "application/octet-stream", false],
    ["readme", "text/markdown", "markdown", "text/plain; charset=utf-8", true],
  ];

  it.each(cases)("%s (%s) is %s served as %s", (name, mime, kind, type, inline) => {
    const plan = previewPlan(name, mime);
    expect(plan.kind).toBe(kind);
    expect(plan.contentType).toBe(type);
    expect(plan.inline).toBe(inline);
    if (name.endsWith(".html") || name.endsWith(".htm")) expect(plan.contentType).not.toContain("text/html");
  });

  it("treats .ts as TypeScript unless the stored type is video", () => {
    expect(previewPlan("stream.ts", "video/mp2t").kind).toBe("binary");
    expect(previewPlan("app.ts", "text/plain").lang).toBe("ts");
    expect(previewPlan("data.json", "application/json").lang).toBe("json");
    expect(previewPlan("rows.csv", "text/csv").lang).toBe("csv");
    expect(previewPlan("rows.tsv", "text/plain").lang).toBe("tsv");
  });
});

describe("preview endpoint", () => {
  it("requires UI auth and serves each kind with a strict content type", async () => {
    const code = await task("preview files");
    const peter = await member("peter");
    const md = "# Title\n\n<script>alert(1)</script>\n\n[ok](https://example.com/a)\n\n[bad](javascript:alert(1))\n";
    const brief = await addAttachmentBytes(env.DB, env.ATTACHMENTS, peter, {
      task: code, group: "output", name: "brief.md", mime: "text/markdown", bytes: new TextEncoder().encode(md),
    }, policy, T0 + 1);
    await addAttachmentBytes(env.DB, env.ATTACHMENTS, peter, {
      task: code, group: "output", name: "brief.md", mime: "text/markdown",
      bytes: new TextEncoder().encode("# Title\n\nRevised body\n"),
    }, policy, T0 + 2);
    const sheet = await addAttachmentBytes(env.DB, env.ATTACHMENTS, peter, {
      task: code, group: "requirement", name: "rows.csv", mime: "text/csv",
      bytes: new TextEncoder().encode("name,qty\nAda,2\n\"Bo, b\",3\n"),
    }, policy, T0 + 3);
    const data = await addAttachmentBytes(env.DB, env.ATTACHMENTS, peter, {
      task: code, group: "output", name: "data.json", mime: "application/json",
      bytes: new TextEncoder().encode('{"a":1,"b":"x"}'),
    }, policy, T0 + 4);
    const pdfBytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
    const pdf = await addAttachmentBytes(env.DB, env.ATTACHMENTS, peter, {
      task: code, group: "output", name: "spec.pdf", mime: "application/pdf", bytes: pdfBytes,
    }, policy, T0 + 5);
    const page = await addAttachmentBytes(env.DB, env.ATTACHMENTS, peter, {
      task: code, group: "requirement", name: "page.html", mime: "text/html",
      bytes: new TextEncoder().encode("<script>alert(1)</script><b>hi</b>"),
    }, policy, T0 + 6);
    const svg = await addAttachmentBytes(env.DB, env.ATTACHMENTS, peter, {
      task: code, group: "output", name: "mark.svg", mime: "image/svg+xml",
      bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="2" height="2"/></svg>'),
    }, policy, T0 + 7);
    const shot = await addAttachmentBytes(env.DB, env.ATTACHMENTS, peter, {
      task: code, group: "output", name: "shot.png", mime: "image/png", bytes: PNG,
    }, policy, T0 + 8);

    const anon = await worker.fetch(`${UI}/t/${code}/attachments/${brief.id}/preview?v=2`);
    expect(anon.status).toBe(403);

    const rendered = await ui(`/t/${code}/attachments/${brief.id}/preview?v=1&render=1`);
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get("content-type")).toContain("text/html");
    expect(rendered.headers.get("content-disposition")).toContain("inline");
    expect(rendered.headers.get("x-content-type-options")).toBe("nosniff");
    expect(rendered.headers.get("content-security-policy")).toContain("sandbox");
    expect(rendered.headers.get("x-preview-kind")).toBe("markdown");
    const html = await rendered.text();
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("javascript:");

    const source = await ui(`/t/${code}/attachments/${brief.id}/preview?v=2`);
    expect(source.headers.get("content-type")).toContain("text/plain");
    expect(source.headers.get("content-disposition")).toContain("inline");
    expect(source.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await source.text()).toContain("Revised body");

    const diff = await ui(`/t/${code}/attachments/${brief.id}/preview?v=2&diff=1`);
    expect(diff.headers.get("content-type")).toContain("application/json");
    expect(diff.headers.get("x-content-type-options")).toBe("nosniff");
    const diffBody = await diff.json() as { lines: { kind: string; text: string }[]; truncated: boolean };
    expect(diffBody.lines.some((line) => line.kind === "add" && line.text.includes("Revised"))).toBe(true);
    expect(diffBody.lines.some((line) => line.kind === "del")).toBe(true);

    const csv = await ui(`/t/${code}/attachments/${sheet.id}/preview`);
    expect(csv.headers.get("content-type")).toContain("text/plain");
    expect(csv.headers.get("x-preview-kind")).toBe("table");
    expect(csv.headers.get("x-preview-lang")).toBe("csv");
    expect(await csv.text()).toContain("Ada,2");

    const jsonFile = await ui(`/t/${code}/attachments/${data.id}/preview?render=1`);
    expect(jsonFile.headers.get("content-type")).toContain("text/plain");
    expect(jsonFile.headers.get("x-preview-kind")).toBe("text");
    expect(jsonFile.headers.get("x-preview-lang")).toBe("json");
    expect(await jsonFile.text()).toBe('{"a":1,"b":"x"}');

    const pdfRes = await ui(`/t/${code}/attachments/${pdf.id}/preview`);
    expect(pdfRes.headers.get("content-type")).toBe("application/pdf");
    expect(pdfRes.headers.get("content-disposition")).toContain("inline");
    expect(pdfRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(pdfRes.headers.get("content-security-policy")).not.toContain("sandbox");
    expect(new Uint8Array(await pdfRes.arrayBuffer())).toEqual(pdfBytes);
    const pdfDownload = await ui(`/t/${code}/attachments/${pdf.id}`);
    expect(pdfDownload.headers.get("content-disposition")).toContain("attachment");

    const htmlFile = await ui(`/t/${code}/attachments/${page.id}/preview?render=1`);
    expect(htmlFile.headers.get("content-type")).toContain("text/plain");
    expect(htmlFile.headers.get("content-type")).not.toContain("text/html");
    expect(htmlFile.headers.get("x-preview-kind")).toBe("text");
    expect(await htmlFile.text()).toBe("<script>alert(1)</script><b>hi</b>");

    const svgRes = await ui(`/t/${code}/attachments/${svg.id}/preview`);
    expect(svgRes.headers.get("content-type")).toBe("image/svg+xml");
    expect(svgRes.headers.get("content-disposition")).toContain("inline");
    expect(svgRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(svgRes.headers.get("content-security-policy")).toContain("sandbox");
    expect(await svgRes.text()).toContain("<script>alert(1)</script>");

    const image = await ui(`/t/${code}/attachments/${shot.id}/preview`);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-disposition")).toContain("inline");

    const other = await ui(`/t/STS-CORE-999.9/attachments/${shot.id}/preview`);
    expect(other.status).toBe(404);
    const mcpHost = await worker.fetch(`${MCP.replace(/\/mcp$/, "")}/t/${code}/attachments/${shot.id}/preview`, {
      headers: { authorization: `Bearer unused` },
    });
    expect(mcpHost.status).toBe(404);

    const huge = new Uint8Array(PREVIEW_BYTE_CAP + 32);
    huge.fill(97);
    const log = await addAttachmentBytes(env.DB, env.ATTACHMENTS, peter, {
      task: code, group: "output", name: "run.log", mime: "text/plain", bytes: huge,
    }, policy, T0 + 9);
    const capped = await ui(`/t/${code}/attachments/${log.id}/preview`);
    expect(capped.headers.get("x-preview-truncated")).toBe("1");
    expect(capped.headers.get("x-preview-kind")).toBe("text");
    const cappedBody = await capped.text();
    expect(cappedBody.length).toBe(PREVIEW_BYTE_CAP);
    expect(cappedBody.startsWith("a")).toBe(true);

    const binId = await storeRaw(code, "requirement", "blob.bin", "application/octet-stream", Uint8Array.from([0, 1, 2, 3, 4]));
    const binary = await ui(`/t/${code}/attachments/${binId}/preview`);
    expect(binary.status).toBe(200);
    expect(binary.headers.get("x-preview-kind")).toBe("binary");
    expect(binary.headers.get("content-type")).toContain("text/plain");
    expect(binary.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await binary.text()).toBe(PREVIEW_UNAVAILABLE);

    const taskPage = await (await ui(`/t/${code}?tab=overview`)).text();
    expect(taskPage).toContain(`data-kind="markdown"`);
    expect(taskPage).toContain(`data-kind="table"`);
    expect(taskPage).toContain(`data-kind="text"`);
    expect(taskPage).toContain(`data-kind="pdf"`);
    expect(taskPage).toContain(`data-kind="image"`);
    expect(taskPage).toContain(`/t/${code}/attachments/${brief.id}/preview?v=2`);
    expect(taskPage).toContain("data-lb-open=");
    expect(taskPage).toContain('id="lb-version"');
    expect(taskPage).toContain(".lb-tools:not([hidden])");
    expect(taskPage).toContain(".lb-stage.lb-doc{margin:0;background:var(--card)}");
    expect(taskPage).toContain("This file can't be previewed.");
    expect(taskPage).toContain("Showing the first 1 MB.");
    expect(taskPage).not.toContain("attach-preview");
    const script = await (await ui("/assets/dashboard.js")).text();
    expect(script).toContain("data-lb-view");
    expect(script).toContain("hl-key");
    expect(script).toContain("lb-table");
    expect(script).toContain("tools.hidden = !comparing");
    expect(script).toContain('classList.toggle("lb-doc"');
  });
});
