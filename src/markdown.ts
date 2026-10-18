// Markdown to HTML. Raw HTML is escaped. Links are http(s) only and open in a new tab.

const EXT_ICON = `<svg class="ext" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" d="M4.5 2.5H2.5v7h7V7.5M6.5 2.5h3v3M9.5 2.5 5.5 6.5"/></svg>`;

export const REQUEST_TEMPLATE = `## Who requested

## What

## Why

## Acceptance criteria

## Impacted areas
`;

export function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** http(s) only. Drops userinfo and non-http schemes such as javascript:. */
export function safeHttpUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2000 || /[\u0000-\u001f]/.test(trimmed)) return null;
  let url: URL;
  try { url = new URL(trimmed); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url.href;
}

function linkHtml(href: string, text: string): string {
  return `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer">${text}<span class="ext-icon">${EXT_ICON}<span class="sr"> (opens in a new tab)</span></span></a>`;
}

/** Same-origin path or public http(s). javascript: and other schemes are dropped. */
export function safeImageSrc(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2000 || /[\u0000-\u001f\s"'<>]/.test(trimmed)) return null;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  return safeHttpUrl(trimmed);
}

function imageVersion(src: string): string {
  const match = /[?&]v=(\d+)/.exec(src);
  return match?.[1] ?? "";
}

/** Thumbnail button. The lightbox script reads data-lb. */
export function imageThumb(rawUrl: string, alt: string): string {
  const src = safeImageSrc(rawUrl);
  const name = alt.trim() || "Image";
  if (!src) return escHtml(name);
  const version = imageVersion(src);
  return `<button type="button" class="md-thumb" data-lb data-src="${escHtml(src)}" data-name="${escHtml(name)}" data-version="${escHtml(version)}" data-download="${escHtml(src)}"><img src="${escHtml(src)}" alt="${escHtml(name)}"></button>`;
}

/** Inline marks. `text` is raw markdown, not HTML. */
function inline(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i) {
        out += `<code>${escHtml(src.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }
    if (src.startsWith("![", i)) {
      const close = src.indexOf("]", i + 2);
      if (close > i && src[close + 1] === "(") {
        const endParen = src.indexOf(")", close + 2);
        if (endParen > close) {
          out += imageThumb(src.slice(close + 2, endParen), src.slice(i + 2, close));
          i = endParen + 1;
          continue;
        }
      }
    }
    if (src[i] === "[") {
      const close = src.indexOf("]", i + 1);
      if (close > i && src[close + 1] === "(") {
        const endParen = src.indexOf(")", close + 2);
        if (endParen > close) {
          const href = safeHttpUrl(src.slice(close + 2, endParen));
          const label = inline(src.slice(i + 1, close));
          if (href) out += linkHtml(href, label);
          else out += label;
          i = endParen + 1;
          continue;
        }
      }
    }
    if (src.startsWith("**", i) || src.startsWith("__", i)) {
      const mark = src.slice(i, i + 2);
      const end = src.indexOf(mark, i + 2);
      if (end > i + 2) {
        out += `<strong>${inline(src.slice(i + 2, end))}</strong>`;
        i = end + 2;
        continue;
      }
    }
    if ((src[i] === "*" || src[i] === "_") && src[i + 1] !== src[i]) {
      const mark = src[i]!;
      const end = src.indexOf(mark, i + 1);
      if (end > i + 1) {
        out += `<em>${inline(src.slice(i + 1, end))}</em>`;
        i = end + 1;
        continue;
      }
    }
    const auto = /^https?:\/\/[^\s<]+/.exec(src.slice(i));
    if (auto && (i === 0 || /\s/.test(src[i - 1] ?? ""))) {
      const trimmed = auto[0].replace(/[),.;:!?]+$/, "");
      const href = safeHttpUrl(trimmed);
      if (href) {
        out += linkHtml(href, escHtml(trimmed));
        i += trimmed.length;
        continue;
      }
    }
    out += escHtml(src[i]!);
    i += 1;
  }
  return out;
}

function fenceLang(line: string): boolean {
  return /^```[A-Za-z0-9_-]*\s*$/.test(line);
}

/** Sanitized HTML. The input is never concatenated into the page unescaped. */
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: string[] = [];
  let i = 0;
  const para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    blocks.push(`<p>${inline(para.join(" "))}</p>`);
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (fenceLang(line)) {
      flushPara();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !fenceLang(lines[i] ?? "")) {
        buf.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(`<pre><code>${escHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      i += 1;
      continue;
    }
    const imageOnly = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line.trim());
    if (imageOnly) {
      flushPara();
      blocks.push(imageThumb(imageOnly[2]!, imageOnly[1]!));
      i += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushPara();
      const level = heading[1]!.length;
      blocks.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara();
      blocks.push("<hr>");
      i += 1;
      continue;
    }
    if (line.startsWith(">")) {
      flushPara();
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith(">")) {
        quote.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push(inline((lines[i] ?? "").replace(/^\s*[-*]\s+/, "")));
        i += 1;
      }
      blocks.push(`<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? "")) {
        items.push(inline((lines[i] ?? "").replace(/^\s*\d+[.)]\s+/, "")));
        i += 1;
      }
      blocks.push(`<ol>${items.map((item) => `<li>${item}</li>`).join("")}</ol>`);
      continue;
    }
    para.push(line.trim());
    i += 1;
  }
  flushPara();
  return `<div class="md">${blocks.join("")}</div>`;
}
