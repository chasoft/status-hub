export function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function assertMemberId(id) {
  if (!/^[a-z0-9-]{1,32}$/.test(id)) throw new Error(`invalid member id: ${id}`);
}

function assertHash(hash) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("token hash must be 64 hex characters");
}

export function selectAdminSql(id) {
  assertMemberId(id);
  return `SELECT CASE WHEN token_hash IS NULL THEN 0 ELSE 1 END AS has_token FROM members WHERE id = ${sqlLiteral(id)}`;
}

export function planAdminWrite({ exists, hasToken, rotate }) {
  if (!exists) return { action: "insert", storeToken: true };
  if (rotate || !hasToken) return { action: "update", storeToken: true };
  return { action: "update", storeToken: false };
}

export function upsertAdminSql({ exists, id, name, tokenHash, createdAt, rotate }) {
  assertMemberId(id);
  if (!Number.isSafeInteger(createdAt)) throw new Error("createdAt must be an integer");
  const storeToken = !exists || rotate || tokenHash != null;
  if (storeToken) assertHash(tokenHash);
  const nameSql = sqlLiteral(name);
  const idSql = sqlLiteral(id);
  if (!exists) {
    return `INSERT INTO members (id, name, role, is_admin, token_hash, active, created_at) VALUES (${idSql}, ${nameSql}, 'admin', 1, ${sqlLiteral(tokenHash)}, 1, ${createdAt})`;
  }
  const tokenSet = storeToken ? `, token_hash = ${sqlLiteral(tokenHash)}` : "";
  return `UPDATE members SET name = ${nameSql}, role = 'admin', is_admin = 1, active = 1${tokenSet} WHERE id = ${idSql}`;
}

export function timezoneSettingSql(minutes) {
  if (!Number.isInteger(minutes)) throw new Error("timezone offset must be an integer");
  return `INSERT INTO settings (key, value) VALUES ('tz_offset_minutes', ${sqlLiteral(String(minutes))}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
}

export function readHasToken(payload) {
  const rows = payload?.[0]?.results;
  if (!Array.isArray(rows)) throw new Error("D1 query did not return results");
  if (rows.length === 0) return { exists: false, hasToken: false };
  const value = rows[0].has_token;
  return { exists: true, hasToken: value === 1 || value === true || value === "1" };
}
