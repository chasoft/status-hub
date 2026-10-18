// How an attachment is previewed. HTML is always plain text. SVG stays an image.
import { contentDisposition, normalizeMime } from "./attachments";

export const PREVIEW_BYTE_CAP = 1024 * 1024;
export const PREVIEW_UNAVAILABLE = "This file can't be previewed.";
export const PREVIEW_TRUNCATED = "Showing the first 1 MB. Download the file for the rest.";

export type PreviewKind = "image" | "pdf" | "video" | "audio" | "markdown" | "table" | "text" | "binary";

export interface PreviewPlan {
  kind: PreviewKind;
  contentType: string;
  inline: boolean;
  lang: string;
}

const TEXT = "text/plain; charset=utf-8";

interface ExtInfo {
  kind: PreviewKind;
  contentType: string;
  lang: string;
}

const EXTENSIONS: Record<string, ExtInfo> = {
  png: { kind: "image", contentType: "image/png", lang: "" },
  jpg: { kind: "image", contentType: "image/jpeg", lang: "" },
  jpeg: { kind: "image", contentType: "image/jpeg", lang: "" },
  gif: { kind: "image", contentType: "image/gif", lang: "" },
  webp: { kind: "image", contentType: "image/webp", lang: "" },
  svg: { kind: "image", contentType: "image/svg+xml", lang: "" },
  avif: { kind: "image", contentType: "image/avif", lang: "" },
  pdf: { kind: "pdf", contentType: "application/pdf", lang: "" },
  mp4: { kind: "video", contentType: "video/mp4", lang: "" },
  webm: { kind: "video", contentType: "video/webm", lang: "" },
  mov: { kind: "video", contentType: "video/quicktime", lang: "" },
  mp3: { kind: "audio", contentType: "audio/mpeg", lang: "" },
  wav: { kind: "audio", contentType: "audio/wav", lang: "" },
  ogg: { kind: "audio", contentType: "audio/ogg", lang: "" },
  m4a: { kind: "audio", contentType: "audio/mp4", lang: "" },
  md: { kind: "markdown", contentType: TEXT, lang: "markdown" },
  markdown: { kind: "markdown", contentType: TEXT, lang: "markdown" },
  csv: { kind: "table", contentType: TEXT, lang: "csv" },
  tsv: { kind: "table", contentType: TEXT, lang: "tsv" },
  txt: { kind: "text", contentType: TEXT, lang: "txt" },
  log: { kind: "text", contentType: TEXT, lang: "log" },
  json: { kind: "text", contentType: TEXT, lang: "json" },
  yaml: { kind: "text", contentType: TEXT, lang: "yaml" },
  yml: { kind: "text", contentType: TEXT, lang: "yaml" },
  xml: { kind: "text", contentType: TEXT, lang: "xml" },
  html: { kind: "text", contentType: TEXT, lang: "html" },
  htm: { kind: "text", contentType: TEXT, lang: "html" },
  js: { kind: "text", contentType: TEXT, lang: "js" },
  mjs: { kind: "text", contentType: TEXT, lang: "js" },
  cjs: { kind: "text", contentType: TEXT, lang: "js" },
  jsx: { kind: "text", contentType: TEXT, lang: "js" },
  ts: { kind: "text", contentType: TEXT, lang: "ts" },
  tsx: { kind: "text", contentType: TEXT, lang: "ts" },
  py: { kind: "text", contentType: TEXT, lang: "py" },
  sh: { kind: "text", contentType: TEXT, lang: "sh" },
  bash: { kind: "text", contentType: TEXT, lang: "sh" },
  sql: { kind: "text", contentType: TEXT, lang: "sql" },
  css: { kind: "text", contentType: TEXT, lang: "css" },
};

const MIME_PLAN: Record<string, ExtInfo> = {
  "image/png": EXTENSIONS.png!,
  "image/jpeg": EXTENSIONS.jpg!,
  "image/gif": EXTENSIONS.gif!,
  "image/webp": EXTENSIONS.webp!,
  "image/svg+xml": EXTENSIONS.svg!,
  "image/avif": EXTENSIONS.avif!,
  "application/pdf": EXTENSIONS.pdf!,
  "video/mp4": EXTENSIONS.mp4!,
  "video/webm": EXTENSIONS.webm!,
  "video/quicktime": EXTENSIONS.mov!,
  "audio/mpeg": EXTENSIONS.mp3!,
  "audio/mp3": EXTENSIONS.mp3!,
  "audio/wav": EXTENSIONS.wav!,
  "audio/wave": EXTENSIONS.wav!,
  "audio/x-wav": EXTENSIONS.wav!,
  "audio/ogg": EXTENSIONS.ogg!,
  "audio/mp4": EXTENSIONS.m4a!,
  "audio/x-m4a": EXTENSIONS.m4a!,
  "text/markdown": EXTENSIONS.md!,
  "text/csv": EXTENSIONS.csv!,
  "text/tab-separated-values": EXTENSIONS.tsv!,
  "application/json": EXTENSIONS.json!,
  "text/json": EXTENSIONS.json!,
  "text/yaml": EXTENSIONS.yaml!,
  "application/yaml": EXTENSIONS.yaml!,
  "application/x-yaml": EXTENSIONS.yaml!,
  "text/xml": EXTENSIONS.xml!,
  "application/xml": EXTENSIONS.xml!,
  "text/html": EXTENSIONS.html!,
  "application/xhtml+xml": EXTENSIONS.html!,
  "text/css": EXTENSIONS.css!,
  "text/javascript": EXTENSIONS.js!,
  "application/javascript": EXTENSIONS.js!,
  "text/x-python": EXTENSIONS.py!,
  "text/x-shellscript": EXTENSIONS.sh!,
  "application/x-sh": EXTENSIONS.sh!,
  "application/sql": EXTENSIONS.sql!,
  "text/x-sql": EXTENSIONS.sql!,
};

const BINARY: PreviewPlan = {
  kind: "binary",
  contentType: "application/octet-stream",
  inline: false,
  lang: "",
};

export function fileExtension(name: string): string {
  const base = name.trim().toLowerCase().split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  const ext = base.slice(dot + 1);
  if (!/^[a-z0-9]{1,12}$/.test(ext)) return "";
  return ext;
}

function asPlan(info: ExtInfo): PreviewPlan {
  return { kind: info.kind, contentType: info.contentType, inline: true, lang: info.lang };
}

/** Extension wins, then the stored MIME. HTML is never served as text/html. */
export function previewPlan(name: string, mime: string): PreviewPlan {
  const ext = fileExtension(name);
  const normalized = normalizeMime(mime || "");
  if (ext === "ts" && normalized.startsWith("video/")) {
    return MIME_PLAN[normalized] ? asPlan(MIME_PLAN[normalized]!) : BINARY;
  }
  if (ext === "html" || ext === "htm") return asPlan(EXTENSIONS.html!);
  if (ext && EXTENSIONS[ext]) return asPlan(EXTENSIONS[ext]!);
  if (normalized && MIME_PLAN[normalized]) return asPlan(MIME_PLAN[normalized]!);
  if (normalized.startsWith("text/")) return { kind: "text", contentType: TEXT, inline: true, lang: "txt" };
  return BINARY;
}

export function textPreviewKind(kind: PreviewKind): boolean {
  return kind === "text" || kind === "markdown" || kind === "table";
}

export async function readCappedPreview(
  stream: ReadableStream<Uint8Array> | null,
  cap = PREVIEW_BYTE_CAP,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!stream) return { bytes: new Uint8Array(), truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (total + value.byteLength > cap) {
        const keep = cap - total;
        if (keep > 0) chunks.push(value.subarray(0, keep));
        total = cap;
        truncated = true;
        for (;;) {
          const rest = await reader.read();
          if (rest.done) break;
        }
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

/** Headers for a preview response. PDF omits sandbox so the browser viewer can run. */
export function previewResponseHeaders(
  plan: PreviewPlan,
  name: string,
  opts?: { truncated?: boolean; renderedHtml?: boolean; kind?: string },
): Record<string, string> {
  const rendered = !!opts?.renderedHtml;
  const contentType = opts?.kind === "diff"
    ? "application/json; charset=utf-8"
    : rendered ? "text/html; charset=utf-8" : plan.contentType;
  const inline = plan.inline || rendered;
  const csp = plan.kind === "pdf" && !rendered
    ? "default-src 'none'; script-src 'none'; base-uri 'none'"
    : "default-src 'none'; sandbox";
  const headers: Record<string, string> = {
    "content-type": contentType,
    "content-disposition": contentDisposition(name, inline),
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": csp,
    "x-preview-kind": opts?.kind || (rendered ? "markdown" : plan.kind),
  };
  if (plan.lang && !opts?.kind) headers["x-preview-lang"] = plan.lang;
  if (opts?.truncated) headers["x-preview-truncated"] = "1";
  return headers;
}
