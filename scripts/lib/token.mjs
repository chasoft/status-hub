import { createHash, randomBytes } from "node:crypto";

// Same shape auth accepts: shk_<memberId>_<base64url>. Callers store only the hash.
export function createMcpToken(memberId, bytes = randomBytes(32)) {
  if (!/^[a-z0-9-]{1,32}$/.test(memberId)) throw new Error(`invalid member id: ${memberId}`);
  if (!Buffer.isBuffer(bytes) || bytes.length < 32) throw new Error("token bytes must be at least 32 bytes");
  const token = `shk_${memberId}_${Buffer.from(bytes).toString("base64url")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  return { token, hash };
}
