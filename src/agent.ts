// Live Cursor cloud-agent status for the task page. The API key stays on the server.

const AGENT_RE = /^https:\/\/cursor\.com\/agents\/(bc-[A-Za-z0-9-]+)\/?$/;
const TIMEOUT_MS = 6_000;
const CACHE_SECONDS = 30;
const MAX_BODY = 64_000;
/** Cached when Cursor fails or times out, so the next page load skips the slow call. */
const FALLBACK_BODY = '{"fallback":true}';

export interface LiveAgent {
  status: string;
  summary: string | null;
  prUrl: string | null;
}

/** `bc-…` id from https://cursor.com/agents/bc-<id>, or null when the URL is not that shape. */
export function cursorAgentId(url: string | null | undefined): string | null {
  if (!url) return null;
  return AGENT_RE.exec(url.trim())?.[1] ?? null;
}

function httpsUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const u = raw.trim();
  if (!u || u.length > 500) return null;
  try {
    if (new URL(u).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return u;
}

function parseAgent(body: string): LiveAgent | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const rec = data as { status?: unknown; summary?: unknown; target?: { prUrl?: unknown } };
  if (typeof rec.status !== "string") return null;
  const status = rec.status.trim();
  if (!status || status.length > 64) return null;
  const summary = typeof rec.summary === "string" ? rec.summary.trim().slice(0, 500) : "";
  return { status, summary: summary || null, prUrl: httpsUrl(rec.target?.prUrl) };
}

async function readLimited(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

async function remember(cache: Cache | undefined, cacheKey: Request, body: string, id: string) {
  if (!cache) return;
  try {
    await cache.put(cacheKey, new Response(body, {
      headers: { "Cache-Control": `public, max-age=${CACHE_SECONDS}`, "content-type": "application/json" },
    }));
  } catch (e) {
    console.error(JSON.stringify({ msg: "cursor_agent_cache", id, error: String(e) }));
  }
}

/**
 * GET https://api.cursor.com/v0/agents/{id} (Basic auth, key as the username).
 * Caches a successful body, and a failed or timed-out lookup, for 30s.
 * Returns null on a missing key, a non-cursor URL, or any failure so the page
 * can show the bot-reported status instead.
 */
export async function loadCursorAgent(apiKey: string | undefined, agentUrl: string | null): Promise<LiveAgent | null> {
  const key = apiKey?.trim();
  const id = cursorAgentId(agentUrl);
  if (!key || !id) return null;
  const url = `https://api.cursor.com/v0/agents/${encodeURIComponent(id)}`;
  const cacheKey = new Request(url);
  let cache: Cache | undefined;
  try {
    cache = caches.default;
  } catch {
    cache = undefined;
  }
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const text = await hit.text();
        if (text === FALLBACK_BODY) return null;
        const parsed = parseAgent(text);
        if (parsed) return parsed;
      }
    } catch (e) {
      console.error(JSON.stringify({ msg: "cursor_agent_cache", id, error: String(e) }));
    }
  }
  let body: string | null = null;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Basic ${btoa(`${key}:`)}`, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(JSON.stringify({ msg: "cursor_agent", id, status: res.status }));
      await remember(cache, cacheKey, FALLBACK_BODY, id);
      return null;
    }
    body = await readLimited(res, MAX_BODY);
  } catch (e) {
    console.error(JSON.stringify({ msg: "cursor_agent", id, error: e instanceof Error ? e.name : "error" }));
    await remember(cache, cacheKey, FALLBACK_BODY, id);
    return null;
  }
  if (body != null) {
    const parsed = parseAgent(body);
    if (parsed) {
      await remember(cache, cacheKey, body, id);
      return parsed;
    }
  }
  await remember(cache, cacheKey, FALLBACK_BODY, id);
  return null;
}
