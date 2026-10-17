#!/usr/bin/env node
// pnpm run deploy. Uses wrangler.local.jsonc when setup has written it.
// Extra arguments are passed through: pnpm run deploy -- --env staging

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planDeploy } from "./lib/deploy-plan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plan = planDeploy({
  argv: process.argv.slice(2),
  localConfigExists: existsSync(resolve(root, "wrangler.local.jsonc")),
});
if (plan.warnMissingLocal) {
  console.error("wrangler.local.jsonc not found. Deploying wrangler.jsonc, which still has placeholder database ids. Run `pnpm run setup` first.");
}
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const child = spawn(process.execPath, [wrangler, ...plan.args], {
  cwd: root,
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
