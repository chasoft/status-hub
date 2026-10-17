#!/usr/bin/env node
// Generate a bot token LOCALLY. Prints:
//   - the raw token -> deliver ONLY via a secret request to that bot (never chat/memory/repo)
//   - the SQL to store its SHA-256 hash in D1
// Usage: node scripts/gen-token.mjs <member-id> [--env staging]
import { createHash, randomBytes } from "node:crypto";

const id = process.argv[2];
if (!id || !/^[a-z0-9-]{1,32}$/.test(id)) {
  console.error("usage: node scripts/gen-token.mjs <member-id>");
  process.exit(1);
}
const token = `shk_${id}_${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(token).digest("hex");
const db = process.argv.includes("staging") ? "status-hub-staging --env staging" : "status-hub";
console.error(`# RAW TOKEN for ${id} (deliver via secret request ONLY, then clear your terminal):`);
console.log(token);
console.error(`\n# Store the hash:`);
console.error(`npx wrangler d1 execute ${db} --remote --command "UPDATE members SET token_hash = '${hash}' WHERE id = '${id}'"`);
