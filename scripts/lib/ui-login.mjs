import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sqlLiteral } from "./admin-sql.mjs";
import { parseJsonFromOutput } from "./d1.mjs";

// Same shape the Worker accepts: shu_ plus base64url of 32 bytes. Only the hash is stored.
export function createUiLoginToken(email, bytes = randomBytes(32), id = randomUUID()) {
  const normalized = String(email ?? "").trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(normalized)) throw new Error(`invalid email: ${email}`);
  if (!Buffer.isBuffer(bytes) || bytes.length < 32) throw new Error("login token bytes must be at least 32 bytes");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("invalid login token id");
  const token = `shu_${Buffer.from(bytes).toString("base64url")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  return { token, hash, id, email: normalized };
}

// Wrangler rejects AUTH_SESSION_SECRET shorter than 16 characters. This is never written to wrangler.local.jsonc.
export function createSessionSecret(bytes = randomBytes(32)) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16) throw new Error("session secret bytes must be at least 16 bytes");
  const secret = Buffer.from(bytes).toString("base64url");
  if (secret.length < 16) throw new Error("session secret must be at least 16 characters");
  return secret;
}

export function planUiLogin({ activeCount, rotate }) {
  return { store: !(activeCount > 0 && !rotate) };
}

export function selectActiveUiLoginSql(email) {
  return `SELECT COUNT(*) AS n FROM ui_login_tokens WHERE email = ${sqlLiteral(email)} AND revoked_at IS NULL`;
}

export function insertUiLoginSql({ id, tokenHash, email, createdAt }) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("invalid login token id");
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error("token hash must be 64 hex characters");
  if (!Number.isSafeInteger(createdAt)) throw new Error("createdAt must be an integer");
  return `INSERT INTO ui_login_tokens (id, token_hash, email, created_at) VALUES (${sqlLiteral(id)}, ${sqlLiteral(tokenHash)}, ${sqlLiteral(email)}, ${createdAt})`;
}

export function readCount(payload) {
  const rows = payload?.[0]?.results;
  if (!Array.isArray(rows)) throw new Error("D1 query did not return results");
  if (rows.length === 0) return 0;
  const n = Number(rows[0].n ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function secretNames(stdout) {
  const payload = parseJsonFromOutput(stdout);
  if (!Array.isArray(payload)) throw new Error("secret list was not a JSON array");
  return payload.map((row) => (typeof row === "string" ? row : row?.name)).filter((name) => typeof name === "string" && name);
}
