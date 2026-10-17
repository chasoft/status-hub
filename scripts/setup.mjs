#!/usr/bin/env node
// Guided bootstrap. Talks to Wrangler for D1, then writes gitignored wrangler.local.jsonc.
// The raw MCP token is printed once. D1 stores only its SHA-256.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { missingRequired, normalizeSetup, parseSetupArgs, SETUP_HELP } from "./lib/args.mjs";
import { planAdminWrite, readHasToken, selectAdminSql, timezoneSettingSql, upsertAdminSql } from "./lib/admin-sql.mjs";
import { buildLocalConfig, defaultsFromLocal } from "./lib/config.mjs";
import { databaseIdByName, parseD1List, parseD1Query } from "./lib/d1.mjs";
import { parseJsonc } from "./lib/jsonc.mjs";
import { createMcpToken } from "./lib/token.mjs";
import { createSessionSecret, createUiLoginToken, insertUiLoginSql, planUiLogin, readCount, secretNames, selectActiveUiLoginSql } from "./lib/ui-login.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function runWrangler(args, { input } = {}) {
  const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
  if (!existsSync(wrangler)) {
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "Wrangler is not installed. Run `pnpm install` in this repository.",
    });
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [wrangler, ...args], {
      cwd: root,
      env: process.env,
      stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (input != null) {
      child.stdin.write(input);
      child.stdin.end();
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

function commandError(result, what) {
  const detail = (result.stderr || result.stdout || "").trim();
  return `${what} failed.\n${detail}`;
}

async function ensureDatabase(name) {
  const listed = await runWrangler(["d1", "list", "--json"]);
  if (listed.code !== 0) throw new Error(commandError(listed, "wrangler d1 list"));
  const existing = databaseIdByName(parseD1List(listed.stdout), name);
  if (existing) {
    console.error(`D1 ${name}: reused ${existing}`);
    return existing;
  }
  console.error(`D1 ${name}: creating`);
  const created = await runWrangler(["d1", "create", name]);
  const already = /already exists/i.test(`${created.stderr}\n${created.stdout}`);
  if (created.code !== 0 && !already) throw new Error(commandError(created, `wrangler d1 create ${name}`));
  const again = await runWrangler(["d1", "list", "--json"]);
  if (again.code !== 0) throw new Error(commandError(again, "wrangler d1 list"));
  const id = databaseIdByName(parseD1List(again.stdout), name);
  if (!id) throw new Error(`D1 database ${name} was not created. \`wrangler d1 list\` does not show it.`);
  console.error(`D1 ${name}: created ${id}`);
  return id;
}

async function applyMigrations(databaseName, configPath, envName) {
  const args = ["d1", "migrations", "apply", databaseName, "--remote", "--config", configPath];
  if (envName) args.push("--env", envName);
  console.error(`Applying migrations to ${databaseName}${envName ? ` (--env ${envName})` : ""}`);
  const result = await runWrangler(args);
  if (result.stdout.trim()) console.error(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (result.code !== 0) throw new Error(commandError(result, `migrations for ${databaseName}`));
}

async function executeSql(databaseName, configPath, envName, sql) {
  const args = ["d1", "execute", databaseName, "--remote", "--json", "--yes", "--config", configPath, "--command", sql];
  if (envName) args.push("--env", envName);
  const result = await runWrangler(args);
  if (result.code !== 0) throw new Error(commandError(result, `D1 execute on ${databaseName}`));
  return parseD1Query(result.stdout);
}

async function ensureSessionSecret(configPath, envName, rotate) {
  const label = envName ?? "production";
  const listArgs = ["secret", "list", "--config", configPath];
  if (envName) listArgs.push("--env", envName);
  const listed = await runWrangler(listArgs);
  let present = false;
  if (listed.code === 0) {
    present = secretNames(listed.stdout).includes("AUTH_SESSION_SECRET");
  } else if (/not found/i.test(`${listed.stderr}\n${listed.stdout}`)) {
    present = false;
  } else {
    throw new Error(commandError(listed, "wrangler secret list"));
  }
  if (present && !rotate) {
    console.error(`${label}: AUTH_SESSION_SECRET already set. Not rotated.`);
    return;
  }
  const secret = createSessionSecret();
  const putArgs = ["secret", "put", "AUTH_SESSION_SECRET", "--config", configPath];
  if (envName) putArgs.push("--env", envName);
  const put = await runWrangler(putArgs, { input: `${secret}\n` });
  if (put.code !== 0) throw new Error(commandError(put, "wrangler secret put AUTH_SESSION_SECRET"));
  console.error(`${label}: uploaded AUTH_SESSION_SECRET. The value is not printed. Wrangler publishes the secret with the Worker.`);
}

async function ensureTokenMode(setup, databaseName, configPath, envName) {
  const label = envName ?? "production";
  await ensureSessionSecret(configPath, envName, setup.rotateSessionSecret);
  const current = readCount(await executeSql(databaseName, configPath, envName, selectActiveUiLoginSql(setup.adminEmail)));
  if (!planUiLogin({ activeCount: current, rotate: setup.rotateUiToken }).store) {
    console.error(`${label}: ${setup.adminEmail} already has a UI login token. Re-run with --rotate-ui-token to mint another.`);
    return null;
  }
  const created = createUiLoginToken(setup.adminEmail);
  await executeSql(databaseName, configPath, envName, insertUiLoginSql({
    id: created.id,
    tokenHash: created.hash,
    email: created.email,
    createdAt: Date.now(),
  }));
  return created.token;
}

async function ensureAdmin(setup, databaseName, configPath, envName) {
  const current = readHasToken(await executeSql(databaseName, configPath, envName, selectAdminSql(setup.adminId)));
  const plan = planAdminWrite({ exists: current.exists, hasToken: current.hasToken, rotate: setup.rotateToken });
  let token = null;
  let tokenHash = null;
  if (plan.storeToken) {
    const created = createMcpToken(setup.adminId);
    token = created.token;
    tokenHash = created.hash;
  }
  await executeSql(databaseName, configPath, envName, upsertAdminSql({
    exists: current.exists,
    id: setup.adminId,
    name: setup.adminName,
    tokenHash,
    createdAt: Date.now(),
    rotate: plan.storeToken,
  }));
  await executeSql(databaseName, configPath, envName, timezoneSettingSql(setup.tzOffsetMinutes));
  return token;
}

function databaseIds(text) {
  const config = parseJsonc(text);
  const prod = config.d1_databases?.find((db) => db.binding === "DB");
  const staging = config.env?.staging?.d1_databases?.find((db) => db.binding === "DB");
  return {
    databaseId: prod?.database_id ?? "00000000-0000-0000-0000-000000000000",
    stagingDatabaseId: staging?.database_id ?? "00000000-0000-0000-0000-000000000001",
  };
}

async function promptMissing(values, defaults) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ask = async (label, current) => {
    const shown = current == null || current === "" ? "" : ` [${current}]`;
    const answer = (await rl.question(`${label}${shown}: `)).trim();
    if (answer) return answer;
    return current ?? "";
  };
  try {
    const take = async (key, label) => {
      if (values[key] != null) return;
      values[key] = await ask(label, defaults[key] ?? "");
    };
    await take("orgName", "Org name");
    await take("timezone", "Timezone (IANA name, UTC, +08:00, or minutes east of UTC)");
    await take("uiHost", "UI hostname");
    await take("mcpHost", "MCP hostname");
    await take("ownerIds", "Owner ids (comma-separated, empty allowed)");
    await take("approverIds", "Approver ids (comma-separated, empty allowed)");
    await take("adminId", "First admin member id");
    await take("adminName", "First admin name");
    await take("adminEmail", "First admin email");
    if (!values.stagingSpecified) {
      const fallback = defaults.stagingConfigured ? "y" : "n";
      const answer = (await ask("Also set up staging? (y/n)", fallback)).toLowerCase();
      values.staging = answer === "y" || answer === "yes";
    }
    if (values.staging) {
      await take("stagingUiHost", "Staging UI hostname");
      await take("stagingMcpHost", "Staging MCP hostname");
    }
    if (values.authMode == null) {
      const answer = (await ask("UI auth mode (access or token)", defaults.authMode || "access")).toLowerCase();
      values.authMode = answer || "access";
    }
    if (String(values.authMode).trim().toLowerCase() === "token") return values;
    if (values.accessTeamDomain == null) {
      const answer = await ask("Access team domain (optional)", defaults.accessTeamDomain || "");
      if (answer) values.accessTeamDomain = answer;
    }
    if (values.accessAud == null) {
      const answer = await ask("Access AUD tag (optional, empty denies the UI)", defaults.accessAud || "");
      if (answer) values.accessAud = answer;
    }
  } finally {
    rl.close();
  }
  return values;
}

function applyDatabaseDefaults(values, defaults) {
  if (values.databaseName == null && defaults.databaseName) values.databaseName = defaults.databaseName;
  if (values.staging && values.stagingDatabaseName == null && defaults.stagingDatabaseName) {
    values.stagingDatabaseName = defaults.stagingDatabaseName;
  }
}

async function main() {
  const parsed = parseSetupArgs(process.argv.slice(2), process.env);
  if (!parsed.ok) fail(parsed.error);
  if (parsed.help) {
    console.log(SETUP_HELP);
    return;
  }

  const values = { ...parsed.values };
  const configPath = resolve(root, values.configPath ?? "wrangler.jsonc");
  const outPath = resolve(root, values.outPath ?? "wrangler.local.jsonc");
  if (!existsSync(configPath)) fail(`Config not found: ${configPath}`);
  if (configPath === outPath) fail("Refusing to overwrite the template config. The default output is wrangler.local.jsonc.");

  const templateText = readFileSync(configPath, "utf8");
  const baseText = existsSync(outPath) ? readFileSync(outPath, "utf8") : templateText;
  let defaults = {};
  try {
    defaults = defaultsFromLocal(baseText);
  } catch {
    defaults = {};
  }

  if (!values.nonInteractive) {
    if (!process.stdin.isTTY) {
      fail("Setup needs a terminal, or --yes with flags or STATUS_HUB_* variables. See `pnpm run setup -- --help`.");
    }
    await promptMissing(values, defaults);
  }
  applyDatabaseDefaults(values, defaults);

  const missing = missingRequired(values);
  if (missing.length) {
    fail(`Missing required settings:\n${missing.map((item) => `  ${item}`).join("\n")}\n\nSee \`pnpm run setup -- --help\`.`);
  }
  const normalized = normalizeSetup(values);
  if (!normalized.ok) fail(normalized.errors.join("\n"));
  const setup = normalized.setup;

  if (setup.dryRun || setup.skipLoginCheck) {
    if (setup.dryRun) {
      const ids = databaseIds(baseText);
      const rendered = buildLocalConfig(baseText, {
        ...setup,
        databaseId: ids.databaseId,
        stagingDatabaseId: setup.staging ? ids.stagingDatabaseId : null,
      });
      console.error("Dry run. No Cloudflare changes and no file written.");
      if (setup.authMode === "token") {
        console.error("Dry run: would upload AUTH_SESSION_SECRET and mint a UI login token. Neither value is generated.");
      }
      console.log(rendered);
      return;
    }
  } else {
    const who = await runWrangler(["whoami", "--json"]);
    if (who.code !== 0) {
      fail(`Wrangler is not logged in.\nRun \`pnpm exec wrangler login\`, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.\n${(who.stderr || who.stdout).trim()}`);
    }
    console.error("Wrangler login: ok");
  }

  const databaseId = await ensureDatabase(setup.databaseName);
  const stagingDatabaseId = setup.staging ? await ensureDatabase(setup.stagingDatabaseName) : null;
  const rendered = buildLocalConfig(baseText, { ...setup, databaseId, stagingDatabaseId });
  const tmp = `${outPath}.${process.pid}.tmp`;
  writeFileSync(tmp, rendered);
  renameSync(tmp, outPath);
  console.error(`Wrote ${outPath}`);

  await applyMigrations(setup.databaseName, outPath, null);
  if (setup.staging) await applyMigrations(setup.stagingDatabaseName, outPath, "staging");

  const tokens = [{ label: "production", token: await ensureAdmin(setup, setup.databaseName, outPath, null) }];
  if (setup.staging) {
    tokens.push({ label: "staging", token: await ensureAdmin(setup, setup.stagingDatabaseName, outPath, "staging") });
  }
  for (const item of tokens) {
    if (item.token) {
      console.error(`\n# ${item.label} MCP token for ${setup.adminId} (shown once; only the SHA-256 is stored):`);
      console.log(item.token);
    } else {
      console.error(`${item.label}: ${setup.adminId} already has an MCP token. Re-run with --rotate-token to replace it.`);
    }
  }
  if (setup.authMode === "token") {
    const uiTokens = [{ label: "production", token: await ensureTokenMode(setup, setup.databaseName, outPath, null) }];
    if (setup.staging) {
      uiTokens.push({ label: "staging", token: await ensureTokenMode(setup, setup.stagingDatabaseName, outPath, "staging") });
    }
    for (const item of uiTokens) {
      if (item.token) {
        console.error(`\n# ${item.label} UI login token for ${setup.adminEmail} (shown once; only the SHA-256 is stored):`);
        console.log(item.token);
      }
    }
    console.error(`\nOpen https://${setup.uiHost}/login and paste the UI login token.`);
  }
  console.error(`\nUI: https://${setup.uiHost}`);
  console.error(`MCP: https://${setup.mcpHost}/mcp`);
  if (setup.staging) {
    console.error(`Staging UI: https://${setup.stagingUiHost}`);
    console.error(`Staging MCP: https://${setup.stagingMcpHost}/mcp`);
  }
  console.error("Next: pnpm run deploy");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
