import { getHubConfig } from "./config";
import type { Member } from "./core";

const enc = new TextEncoder();

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = enc.encode(a), bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) {
    // still do a compare to keep timing flat
    crypto.subtle.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.subtle.timingSafeEqual(ab, bb);
}

/**
 * Bearer token format: shk_<memberId>_<random>. The member id is only a lookup key;
 * authenticity comes from a timing-safe compare of SHA-256(token) with members.token_hash.
 * Identity + role are ALWAYS taken from here, never from tool params.
 */
export async function authenticateBearer(db: D1Database, header: string | null): Promise<Member | null> {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  const m = /^shk_([a-z0-9-]{1,32})_[A-Za-z0-9_-]{32,}$/.exec(token);
  if (!m) return null;
  const row = await db.prepare("SELECT id, name, role, is_admin, token_hash FROM members WHERE id = ? AND active = 1")
    .bind(m[1]).first<Member & { token_hash: string | null }>();
  const computed = await sha256Hex(token);
  if (!row?.token_hash) {
    timingSafeEqualStr(computed, computed);
    return null;
  }
  if (!timingSafeEqualStr(computed, row.token_hash)) return null;
  return { id: row.id, name: row.name, role: row.role, is_admin: row.is_admin };
}

// ---------- Cloudflare Access JWT (UI)

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }
let jwksCache: { at: number; keys: Jwk[]; src: string } | null = null;

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function getJwks(env: AccessEnv): Promise<Jwk[]> {
  if (env.ENVIRONMENT === "test" && env.TEST_ACCESS_JWKS) return JSON.parse(env.TEST_ACCESS_JWKS).keys;
  const src = `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
  if (jwksCache && jwksCache.src === src && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const r = await fetch(src);
  if (!r.ok) throw new Error(`certs ${r.status}`);
  const keys = ((await r.json()) as { keys: Jwk[] }).keys;
  jwksCache = { at: Date.now(), keys, src };
  return keys;
}

/**
 * Access email → members.id. The UI only knows the viewer by this email (the verified
 * Access JWT). Role and admin flag always come from the members row after that.
 * UI_MEMBER_EMAILS wins. Otherwise the local-part is used when it is a member id
 * (`peter@example.com` → peter).
 */
export async function memberForAccessEmail(db: D1Database, email: string): Promise<Member | null> {
  const e = email.trim().toLowerCase();
  const local = e.split("@")[0] ?? "";
  const mapped = getHubConfig().emailMembers[e];
  const id = mapped ?? (/^[a-z0-9-]{1,32}$/.test(local) ? local : "");
  if (!id) return null;
  return db.prepare("SELECT id, name, role, is_admin FROM members WHERE id = ? AND active = 1")
    .bind(id).first<Member>();
}

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;  // e.g. your-team.cloudflareaccess.com
  ACCESS_AUD?: string;          // Access application AUD tag
  UI_ALLOWED_EMAILS?: string;   // comma separated, defense in depth on top of the Access policy
  ENVIRONMENT?: string;
  TEST_ACCESS_JWKS?: string;    // honoured only when ENVIRONMENT === "test"
}

/**
 * Author of a leadership note, taken only from the verified UI session.
 * Null when the email is not listed in LEADERSHIP_AUTHORS.
 */
export function leadershipAuthor(email: string): string | null {
  return getHubConfig().leadershipAuthors[email.trim().toLowerCase()] ?? null;
}

/** Returns the verified email, or null. */
export async function verifyAccessJwt(req: Request, env: AccessEnv): Promise<string | null> {
  const jwt = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt || !env.ACCESS_AUD || (!env.ACCESS_TEAM_DOMAIN && env.ENVIRONMENT !== "test")) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (header.alg !== "RS256") return null;
    const jwk = (await getJwks(env)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp < now) return null;
    if (payload.nbf && payload.nbf > now + 60) return null;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (env.ACCESS_TEAM_DOMAIN && payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    const email = String(payload.email ?? "").toLowerCase();
    if (!email) return null;
    const allow = (env.UI_ALLOWED_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!allow.includes(email)) return null;
    return email;
  } catch {
    return null;
  }
}
