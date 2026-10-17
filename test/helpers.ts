import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";

/** The Worker under test (default export). */
export const worker = (exports as unknown as { default: Fetcher }).default;
import { sha256Hex } from "../src/auth";
import type { Member } from "../src/core";

export const MCP_HOST = env.MCP_HOST;
export const UI_HOST = env.UI_HOST;
export const MCP = `https://${MCP_HOST}/mcp`;
export const UI = `https://${UI_HOST}`;
export const OWNER_ID = "owner";
export const APPROVER_ID = "approver";
export const OWNER_EMAIL = "owner@example.com";
export const APPROVER_EMAIL = "approver@example.com";

/** Complete request so an admin create keeps the assignee on backlog until report_status. */
export const fullRequest = {
  requested_by: OWNER_ID,
  requested_at: Date.UTC(2026, 9, 17, 3, 0),
  request_link: "https://example.com/requests/1",
};

export async function member(id: string): Promise<Member> {
  return (await env.DB.prepare("SELECT id, name, role, is_admin FROM members WHERE id = ?").bind(id).first<Member>())!;
}

/** Issue a token for a member in the test DB (production does this out-of-band). */
export async function issueToken(id: string): Promise<string> {
  const rand = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const token = `shk_${id}_${rand}`;
  await env.DB.prepare("UPDATE members SET token_hash = ? WHERE id = ?").bind(await sha256Hex(token), id).run();
  return token;
}

let rpcId = 1;
export async function mcpCall(token: string | null, name: string, args: Record<string, unknown> = {}) {
  const res = await worker.fetch(MCP, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      host: MCP_HOST, // workerd test fetch omits Host; production always sends it
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  let msg: any = null;
  if (raw.trim().startsWith("{")) msg = JSON.parse(raw);
  else {
    const line = raw.split("\n").find((l: string) => l.startsWith("data:"));
    if (line) msg = JSON.parse(line.slice(5));
  }
  const textOut = msg?.result?.content?.[0]?.text;
  return { http: res.status, isError: !!msg?.result?.isError, data: textOut ? JSON.parse(textOut) : null, raw: msg };
}

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function accessJwt(email: string, aud = "test-aud", expIn = 300): Promise<string> {
  const jwk = JSON.parse(env.TEST_PRIVATE_JWK);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const enc = new TextEncoder();
  const h = b64url(enc.encode(JSON.stringify({ alg: "RS256", kid: "test-kid", typ: "JWT" })));
  const now = Math.floor(Date.now() / 1000);
  const p = b64url(enc.encode(JSON.stringify({ aud: [aud], email, exp: now + expIn, iat: now, iss: "" })));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}
