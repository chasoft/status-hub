#!/usr/bin/env node
// Issue a UI login token for AUTH_MODE=token. Prints:
//   - the raw token -> deliver it as a secret (never commit it)
//   - the SQL that stores only the SHA-256 hash
// Usage: node scripts/gen-ui-login.mjs <email> [--env staging]
import { createHash, randomBytes, randomUUID } from "node:crypto";

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("usage: node scripts/gen-ui-login.mjs <email> [--env staging]");
  process.exit(1);
}
const token = `shu_${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(token).digest("hex");
const id = randomUUID();
const db = process.argv.includes("staging") ? "status-hub-staging --env staging" : "status-hub";
const created = Date.now();
console.error(`# RAW LOGIN TOKEN for ${email} (deliver as a secret, then clear your terminal):`);
console.log(token);
console.error(`\n# Store only the hash. The email must also be listed in UI_ALLOWED_EMAILS.`);
console.error(`npx wrangler d1 execute ${db} --remote --command "INSERT INTO ui_login_tokens (id, token_hash, email, created_at) VALUES ('${id}', '${hash}', '${email}', ${created})"`);
