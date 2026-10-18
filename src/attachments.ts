// R2 attachment bytes. D1 holds the version rows. Keys are never overwritten.
import { AppError, canEditTask, clipNote, getTaskRow, type Member } from "./core";

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
/** Hard cap so a config value cannot ask the Worker to buffer an unbounded body. */
export const MAX_BYTES_CAP = 25 * 1024 * 1024;
export const UPLOAD_TTL_MS = 15 * 60 * 1000;

export const DEFAULT_ATTACHMENT_MIME = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "text/yaml",
  "application/yaml",
  "text/xml",
  "application/xml",
  "text/html",
  "text/css",
  "text/javascript",
  "application/javascript",
  "text/x-python",
  "text/x-shellscript",
  "application/x-sh",
  "application/sql",
  "application/json",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
];

export const ATTACHMENTS_UNAVAILABLE =
  "Attachments are not configured. Add an R2 bucket binding named ATTACHMENTS. See docs/configuration.md.";

export type AttachmentGroup = "requirement" | "output";

export interface AttachmentPolicy {
  maxBytes: number;
  allowedMime: Set<string>;
}

export interface AttachmentEnv {
  ATTACHMENT_MAX_BYTES?: string;
  ATTACHMENT_ALLOWED_MIME?: string;
}

export interface StoredAttachment {
  id: number;
  task: string;
  group: AttachmentGroup;
  name: string;
  version: number;
  mime: string;
  bytes: number;
  author_id: string;
  at: number;
  note: string | null;
  r2_key: string;
}

export interface AttachmentVersionMeta {
  version: number;
  mime: string;
  bytes: number;
  author_id: string;
  at: number;
  note: string | null;
}

export interface AttachmentItem {
  id: number;
  name: string;
  versions: AttachmentVersionMeta[];
  latest: AttachmentVersionMeta;
}

export function attachmentPolicy(env: AttachmentEnv): AttachmentPolicy {
  let maxBytes = DEFAULT_MAX_BYTES;
  const rawMax = env.ATTACHMENT_MAX_BYTES?.trim();
  if (rawMax) {
    const n = Number(rawMax);
    if (Number.isInteger(n) && n > 0) maxBytes = Math.min(n, MAX_BYTES_CAP);
  }
  let allowed = DEFAULT_ATTACHMENT_MIME;
  const rawMime = env.ATTACHMENT_ALLOWED_MIME?.trim();
  if (rawMime) {
    const list = rawMime.split(",").map((item) => normalizeMime(item)).filter(Boolean);
    if (list.length) allowed = list;
  }
  return { maxBytes, allowedMime: new Set(allowed) };
}

export function requireBucket(bucket: R2Bucket | undefined | null): R2Bucket {
  if (!bucket) throw new AppError("BAD_REQUEST", ATTACHMENTS_UNAVAILABLE);
  return bucket;
}

export function normalizeMime(raw: string): string {
  return raw.trim().toLowerCase().split(";")[0]!.trim();
}

function brandAt(bytes: Uint8Array, offset: number): string {
  if (offset + 4 > bytes.length) return "";
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function sniffAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  if (brandAt(bytes, 4) !== "ftyp") return false;
  if (brandAt(bytes, 8) === "avif" || brandAt(bytes, 8) === "avis") return true;
  const end = Math.min(bytes.length, 32);
  for (let i = 16; i + 4 <= end; i += 4) {
    const brand = brandAt(bytes, i);
    if (brand === "avif" || brand === "avis") return true;
  }
  return false;
}

export function sniffImage(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif" | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (sniffAvif(bytes)) return "image/avif";
  return null;
}

/** SVG opened as an image. A leading HTML document is rejected. Scripts inside SVG are not executed by <img>. */
export function sniffSvg(bytes: Uint8Array): boolean {
  if (!bytes.length) return false;
  const sample = new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^\uFEFF/, "").trim().toLowerCase();
  if (sample.startsWith("<!doctype html") || sample.startsWith("<html")) return false;
  if (!(sample.startsWith("<svg") || sample.startsWith("<?xml"))) return false;
  return sample.includes("<svg");
}

export function isRasterImageMime(mime: string): boolean {
  return mime === "image/png" || mime === "image/jpeg" || mime === "image/gif" || mime === "image/webp" || mime === "image/avif";
}

export function isSvgMime(mime: string): boolean {
  return mime === "image/svg+xml";
}

export function isImageMime(mime: string): boolean {
  return isRasterImageMime(mime) || isSvgMime(mime);
}

function cleanName(name: string): string {
  const n = name.trim();
  if (!n || n.length > 200) throw new AppError("BAD_REQUEST", "attachment name must be 1–200 characters");
  if (/[\u0000-\u001f\\/]/.test(n)) throw new AppError("BAD_REQUEST", "attachment name cannot contain slashes or control characters");
  return n;
}

function asGroup(group: string): AttachmentGroup {
  if (group !== "requirement" && group !== "output") {
    throw new AppError("BAD_REQUEST", "group must be requirement or output");
  }
  return group;
}

function checkBytes(bytes: Uint8Array, mime: string, policy: AttachmentPolicy): string {
  if (bytes.byteLength === 0) throw new AppError("BAD_REQUEST", "attachment is empty");
  if (bytes.byteLength > policy.maxBytes) {
    throw new AppError("BAD_REQUEST", `attachment exceeds ${policy.maxBytes} bytes`);
  }
  const declared = normalizeMime(mime);
  if (!declared || !policy.allowedMime.has(declared)) {
    throw new AppError("BAD_REQUEST", `MIME type is not allowed: ${declared || "(empty)"}`);
  }
  if (isRasterImageMime(declared)) {
    const sniffed = sniffImage(bytes);
    if (sniffed !== declared) throw new AppError("BAD_REQUEST", `file contents are not ${declared}`);
  }
  if (isSvgMime(declared) && !sniffSvg(bytes)) {
    throw new AppError("BAD_REQUEST", "file contents are not image/svg+xml");
  }
  return declared;
}

function blockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const n = v4.slice(1).map(Number);
    if (n.some((part) => part > 255)) return true;
    const a = n[0] ?? 0;
    const b = n[1] ?? 0;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (host.includes(":")) {
    if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
    if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  }
  return false;
}

/** Public http(s) URL. Rejects loopback, link-local, and private addresses. */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch {
    throw new AppError("BAD_REQUEST", "source_url must be an http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError("BAD_REQUEST", "source_url must be an http or https URL");
  }
  if (url.username || url.password || blockedHost(url.hostname)) {
    throw new AppError("BAD_REQUEST", "source_url must be a public http or https URL");
  }
  return url;
}

export async function readCapped(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!stream) throw new AppError("BAD_REQUEST", "attachment is empty");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AppError("BAD_REQUEST", `attachment exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function decodeBase64(input: string): Uint8Array {
  const cleaned = input.replace(/\s+/g, "");
  if (!cleaned || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 === 1) {
    throw new AppError("BAD_REQUEST", "content_base64 is not valid base64");
  }
  let bin: string;
  try { bin = atob(cleaned); } catch {
    throw new AppError("BAD_REQUEST", "content_base64 is not valid base64");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function fetchPublic(raw: string, maxBytes: number): Promise<Uint8Array> {
  let current = assertPublicHttpUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(current.href, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      await res.body?.cancel();
      if (!next) throw new AppError("BAD_REQUEST", "source_url redirect had no location");
      current = assertPublicHttpUrl(new URL(next, current).href);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new AppError("BAD_REQUEST", `source_url returned HTTP ${res.status}`);
    }
    return readCapped(res.body, maxBytes);
  }
  throw new AppError("BAD_REQUEST", "source_url redirected too many times");
}

export async function addAttachmentBytes(
  db: D1Database,
  bucket: R2Bucket | undefined | null,
  actor: Member,
  input: { task: string; group: string; name: string; mime: string; note?: string | null; bytes: Uint8Array },
  policy: AttachmentPolicy,
  now = Date.now(),
): Promise<StoredAttachment> {
  const store = requireBucket(bucket);
  const task = await getTaskRow(db, input.task);
  if (!canEditTask(actor, task)) {
    throw new AppError("FORBIDDEN", "chỉ người được giao (hoặc pm/po/lead/admin) được sửa task này");
  }
  const group = asGroup(input.group);
  const name = cleanName(input.name);
  const mime = checkBytes(input.bytes, input.mime, policy);
  const note = clipNote(input.note ?? undefined);
  await db.prepare(
    `INSERT INTO attachments (task_code, grp, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(task_code, grp, name) DO NOTHING`,
  ).bind(task.code, group, name, actor.id, now).run();
  const row = await db.prepare(
    "SELECT id FROM attachments WHERE task_code = ? AND grp = ? AND name = ?",
  ).bind(task.code, group, name).first<{ id: number }>();
  if (!row) throw new AppError("CONFLICT", "could not store the attachment");
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await db.prepare(
      "SELECT COALESCE(MAX(version), 0) AS v FROM attachment_versions WHERE attachment_id = ?",
    ).bind(row.id).first<{ v: number }>();
    const version = (cur?.v ?? 0) + 1;
    const r2Key = `attachments/${task.code}/${row.id}/v${version}/${crypto.randomUUID()}`;
    try {
      await db.prepare(
        `INSERT INTO attachment_versions (attachment_id, version, r2_key, mime, bytes, author_id, created_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(row.id, version, r2Key, mime, input.bytes.byteLength, actor.id, now, note).run();
    } catch (err) {
      if (attempt === 0 && /UNIQUE|constraint/i.test(String(err))) continue;
      throw err;
    }
    try {
      await store.put(r2Key, input.bytes, { httpMetadata: { contentType: mime } });
    } catch (err) {
      await db.prepare("DELETE FROM attachment_versions WHERE r2_key = ?").bind(r2Key).run();
      throw err;
    }
    return {
      id: row.id, task: task.code, group, name, version, mime,
      bytes: input.bytes.byteLength, author_id: actor.id, at: now, note, r2_key: r2Key,
    };
  }
  throw new AppError("CONFLICT", "could not store the attachment version");
}

export async function addAttachmentFromSource(
  db: D1Database,
  bucket: R2Bucket | undefined | null,
  actor: Member,
  input: { task: string; group: string; name: string; mime: string; note?: string | null; sourceUrl: string },
  policy: AttachmentPolicy,
  now = Date.now(),
): Promise<StoredAttachment> {
  const bytes = await fetchPublic(input.sourceUrl, policy.maxBytes);
  return addAttachmentBytes(db, bucket, actor, { ...input, bytes }, policy, now);
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function prepareAttachmentUpload(
  db: D1Database,
  bucket: R2Bucket | undefined | null,
  actor: Member,
  input: { task: string; group: string; name: string; mime: string; note?: string | null },
  policy: AttachmentPolicy,
  now = Date.now(),
): Promise<{ token: string; expires_at: number; task: string; group: AttachmentGroup; name: string; mime: string }> {
  requireBucket(bucket);
  const task = await getTaskRow(db, input.task);
  if (!canEditTask(actor, task)) {
    throw new AppError("FORBIDDEN", "chỉ người được giao (hoặc pm/po/lead/admin) được sửa task này");
  }
  const group = asGroup(input.group);
  const name = cleanName(input.name);
  const mime = normalizeMime(input.mime);
  if (!mime || !policy.allowedMime.has(mime)) throw new AppError("BAD_REQUEST", `MIME type is not allowed: ${mime || "(empty)"}`);
  const note = clipNote(input.note ?? undefined);
  const token = newToken();
  const expires = now + UPLOAD_TTL_MS;
  await db.prepare(
    `INSERT INTO attachment_uploads (token, task_code, grp, name, mime, note, author_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(token, task.code, group, name, mime, note, actor.id, now, expires).run();
  return { token, expires_at: expires, task: task.code, group, name, mime };
}

export async function finishAttachmentUpload(
  db: D1Database,
  bucket: R2Bucket | undefined | null,
  actor: Member,
  token: string,
  bytes: Uint8Array,
  policy: AttachmentPolicy,
  now = Date.now(),
): Promise<StoredAttachment> {
  const row = await db.prepare(
    "SELECT token, task_code, grp, name, mime, note, author_id, expires_at, consumed_at FROM attachment_uploads WHERE token = ?",
  ).bind(token).first<{
    token: string; task_code: string; grp: string; name: string; mime: string; note: string | null;
    author_id: string; expires_at: number; consumed_at: number | null;
  }>();
  if (!row || row.consumed_at) throw new AppError("NOT_FOUND", "upload token was not found");
  if (row.author_id !== actor.id) throw new AppError("FORBIDDEN", "upload token belongs to another member");
  if (row.expires_at < now) throw new AppError("BAD_REQUEST", "upload token has expired");
  const stored = await addAttachmentBytes(db, bucket, actor, {
    task: row.task_code, group: row.grp, name: row.name, mime: row.mime, note: row.note, bytes,
  }, policy, now);
  await db.prepare("UPDATE attachment_uploads SET consumed_at = ? WHERE token = ? AND consumed_at IS NULL")
    .bind(now, token).run();
  return stored;
}

interface VersionRow {
  id: number; grp: AttachmentGroup; name: string; version: number; mime: string; bytes: number;
  author_id: string; created_at: number; note: string | null; r2_key: string;
}

export async function listAttachments(db: D1Database, task: string): Promise<{ requirement: AttachmentItem[]; output: AttachmentItem[] }> {
  await getTaskRow(db, task);
  const { results } = await db.prepare(
    `SELECT a.id, a.grp, a.name, v.version, v.mime, v.bytes, v.author_id, v.created_at, v.note, v.r2_key
     FROM attachments a JOIN attachment_versions v ON v.attachment_id = a.id
     WHERE a.task_code = ? ORDER BY a.grp, a.name, v.version DESC`,
  ).bind(task).all<VersionRow>();
  const groups: Record<AttachmentGroup, AttachmentItem[]> = { requirement: [], output: [] };
  const byId = new Map<number, AttachmentItem>();
  for (const row of results) {
    let item = byId.get(row.id);
    if (!item) {
      item = { id: row.id, name: row.name, versions: [], latest: null as unknown as AttachmentVersionMeta };
      byId.set(row.id, item);
      groups[row.grp].push(item);
    }
    const meta: AttachmentVersionMeta = {
      version: row.version, mime: row.mime, bytes: row.bytes, author_id: row.author_id, at: row.created_at, note: row.note,
    };
    item.versions.push(meta);
    if (!item.latest || meta.version > item.latest.version) item.latest = meta;
  }
  return groups;
}

export async function getAttachmentObject(
  db: D1Database,
  bucket: R2Bucket | undefined | null,
  task: string,
  id: number,
  version?: number | null,
): Promise<{ name: string; mime: string; version: number; bytes: number; body: ReadableStream }> {
  const store = requireBucket(bucket);
  if (!Number.isInteger(id) || id < 1) throw new AppError("NOT_FOUND", "attachment was not found");
  const att = await db.prepare(
    "SELECT id, task_code, name FROM attachments WHERE id = ? AND task_code = ?",
  ).bind(id, task).first<{ id: number; task_code: string; name: string }>();
  if (!att) throw new AppError("NOT_FOUND", "attachment was not found");
  const ver = version == null
    ? await db.prepare(
      "SELECT version, mime, bytes, r2_key FROM attachment_versions WHERE attachment_id = ? ORDER BY version DESC LIMIT 1",
    ).bind(att.id).first<{ version: number; mime: string; bytes: number; r2_key: string }>()
    : await db.prepare(
      "SELECT version, mime, bytes, r2_key FROM attachment_versions WHERE attachment_id = ? AND version = ?",
    ).bind(att.id, version).first<{ version: number; mime: string; bytes: number; r2_key: string }>();
  if (!ver) throw new AppError("NOT_FOUND", "attachment version was not found");
  const obj = await store.get(ver.r2_key);
  if (!obj) throw new AppError("NOT_FOUND", "attachment bytes were not found");
  return { name: att.name, mime: ver.mime, version: ver.version, bytes: ver.bytes, body: obj.body };
}

export function contentDisposition(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\w.\- ]+/g, "_").slice(0, 180) || "file";
  const star = encodeURIComponent(name);
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${star}`;
}
