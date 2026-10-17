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

export interface AuthEnv extends AccessEnv {
  AUTH_MODE?: string;
  AUTH_SESSION_SECRET?: string;
  AUTH_SESSION_TTL_SECONDS?: string;
}

/** Same allow-list for every UI mode. Empty or omitted means nobody. */
export function emailAllowed(allowList: string | undefined, email: string): boolean {
  const allow = (allowList ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return allow.includes(email.trim().toLowerCase());
}

export type AuthMode = "access" | "token" | "magic-link" | "unknown";

/**
 * Blank and "access" keep Cloudflare Access. "magic-link" is recognized so the
 * Worker can refuse it: sending a link needs an email provider, which is not bundled.
 */
export function resolveAuthMode(value: string | undefined): AuthMode {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "" || v === "access") return "access";
  if (v === "token") return "token";
  if (v === "magic-link") return "magic-link";
  return "unknown";
}

const LOGIN_TOKEN = /^shu_[A-Za-z0-9_-]{43,128}$/;
const SESSION_COOKIE = "sh_session";
const DEFAULT_TTL = 12 * 60 * 60;
const MAX_TTL = 30 * 24 * 60 * 60;
const MIN_SECRET = 16;

export function sessionTtlSeconds(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_TTL;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL;
  return Math.min(Math.floor(n), MAX_TTL);
}

/** Null when the secret is missing or shorter than 16 characters. Token mode then fails closed. */
export function sessionSecret(env: { AUTH_SESSION_SECRET?: string }): string | null {
  const secret = env.AUTH_SESSION_SECRET ?? "";
  return secret.length >= MIN_SECRET ? secret : null;
}

/**
 * Login token → email. The raw token is hashed and compared with ui_login_tokens.token_hash.
 * The email must be on UI_ALLOWED_EMAILS. Nothing here writes the raw token.
 */
export async function authenticateLoginToken(db: D1Database, token: string, allowList: string | undefined, now = Date.now()): Promise<string | null> {
  const computed = await sha256Hex(LOGIN_TOKEN.test(token) ? token : `invalid:${token.length}`);
  if (!LOGIN_TOKEN.test(token)) {
    timingSafeEqualStr(computed, computed);
    return null;
  }
  const row = await db.prepare(
    `SELECT token_hash, email FROM ui_login_tokens
     WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
  ).bind(computed, now).first<{ token_hash: string; email: string }>();
  if (!row?.token_hash || !timingSafeEqualStr(computed, row.token_hash)) {
    timingSafeEqualStr(computed, row?.token_hash ?? computed);
    return null;
  }
  const email = row.email.trim().toLowerCase();
  if (!email || !emailAllowed(allowList, email)) return null;
  return email;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signSession(secret: string, sid: string, expSec: number): Promise<string> {
  const payload = b64urlEncode(enc.encode(JSON.stringify({ v: 1, sid, exp: expSec })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload)));
  return `${payload}.${b64urlEncode(sig)}`;
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

async function sessionIdFromCookie(req: Request, secret: string, nowSec: number): Promise<string | null> {
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  let sig: Uint8Array;
  try { sig = b64urlDecode(raw.slice(dot + 1)); } catch { return null; }
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(payload));
  if (!ok) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as { v?: unknown; sid?: unknown; exp?: unknown };
    if (body.v !== 1 || typeof body.sid !== "string" || typeof body.exp !== "number") return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.sid)) return null;
    if (body.exp < nowSec) return null;
    return body.sid;
  } catch {
    return null;
  }
}

function cookieHeader(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return cookieHeader("", 0);
}

/** Insert a server-side session and return the Set-Cookie header. Logout revokes the row. */
export async function openSession(db: D1Database, email: string, secret: string, ttlSeconds: number, now = Date.now()): Promise<string> {
  const sid = crypto.randomUUID();
  const expMs = now + ttlSeconds * 1000;
  await db.prepare(
    "INSERT INTO ui_sessions (id, email, expires_at, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)",
  ).bind(sid, email, expMs, now).run();
  const value = await signSession(secret, sid, Math.floor(expMs / 1000));
  return cookieHeader(value, ttlSeconds);
}

/** Verified session email, or null. Allow-list is checked again so a removed email loses access. */
export async function sessionEmail(db: D1Database, req: Request, env: AuthEnv, now = Date.now()): Promise<string | null> {
  const secret = sessionSecret(env);
  if (!secret) return null;
  const sid = await sessionIdFromCookie(req, secret, Math.floor(now / 1000));
  if (!sid) return null;
  const row = await db.prepare(
    "SELECT email, expires_at, revoked_at FROM ui_sessions WHERE id = ?",
  ).bind(sid).first<{ email: string; expires_at: number; revoked_at: number | null }>();
  if (!row || row.revoked_at != null || row.expires_at <= now) return null;
  const email = row.email.trim().toLowerCase();
  if (!emailAllowed(env.UI_ALLOWED_EMAILS, email)) return null;
  return email;
}

export async function revokeSession(db: D1Database, req: Request, env: AuthEnv, now = Date.now()): Promise<void> {
  const secret = sessionSecret(env);
  if (!secret) return;
  const sid = await sessionIdFromCookie(req, secret, Math.floor(now / 1000));
  if (!sid) return;
  await db.prepare("UPDATE ui_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, sid).run();
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
    if (!email || !emailAllowed(env.UI_ALLOWED_EMAILS, email)) return null;
    return email;
  } catch {
    return null;
  }
}
