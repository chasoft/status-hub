import { parseArgs as nodeParseArgs } from "node:util";
import { timezoneOffsetMinutes } from "./timezone.mjs";

export const SETUP_HELP = `Usage: pnpm run setup -- [options]

Guided, idempotent bootstrap. Checks wrangler login, creates or reuses the D1
database by name (and an optional staging database), writes gitignored
wrangler.local.jsonc, applies migrations, upserts the first admin member, and
prints a one-time MCP token. Only the token's SHA-256 is stored.

pnpm run deploy uses wrangler.local.jsonc when that file exists.

Options:
  --yes, --non-interactive   Do not prompt. Required values come from flags or env.
  --dry-run                  Print the local config. Do not call Cloudflare or write a file.
  --skip-login-check         Skip \`wrangler whoami\`.
  --rotate-token             Replace the admin MCP token if one is already stored.
  --auth-mode <access|token> UI auth. Default: access. token uploads a session secret and
                             prints a one-time UI login token for the admin email.
  --rotate-ui-token          Mint another UI login token when one already exists.
  --rotate-session-secret    Replace AUTH_SESSION_SECRET. This signs out existing browsers.
  --staging                  Also create or reuse the staging database.
  --no-staging               Do not change the staging section.
  --org <name>               Org name shown in the UI.
  --timezone <zone>          IANA name (America/Los_Angeles), UTC, +08:00, or minutes east of UTC.
  --ui-host <host>           UI hostname. No scheme, port, or path.
  --mcp-host <host>          MCP hostname. Must differ from the UI host.
  --owner-ids <ids>          Comma-separated owner ids. May be empty.
  --approver-ids <ids>       Comma-separated approver ids. May be empty.
  --admin-id <id>            First admin member id. Lowercase letters, digits, hyphens.
  --admin-name <name>        First admin display name.
  --admin-email <email>      First admin email. Added to the UI allowlists.
  --database-name <name>     Production D1 name. Default: status-hub, or the current local file.
  --staging-ui-host <host>   Required with --staging.
  --staging-mcp-host <host>  Required with --staging.
  --staging-database-name <name>
                             Staging D1 name. Default: status-hub-staging.
  --access-team-domain <host>
                             Optional Cloudflare Access team domain.
  --access-aud <tag>         Optional Access application AUD tag. Empty denies the UI.
  --config <path>            Template wrangler config. Default: wrangler.jsonc.
  --out <path>               Generated config. Default: wrangler.local.jsonc.
  -h, --help                 Show this help.

Environment (flags win):
  STATUS_HUB_ORG_NAME STATUS_HUB_TIMEZONE STATUS_HUB_UI_HOST STATUS_HUB_MCP_HOST
  STATUS_HUB_OWNER_IDS STATUS_HUB_APPROVER_IDS
  STATUS_HUB_ADMIN_ID STATUS_HUB_ADMIN_NAME STATUS_HUB_ADMIN_EMAIL
  STATUS_HUB_DATABASE_NAME STATUS_HUB_STAGING STATUS_HUB_STAGING_UI_HOST
  STATUS_HUB_STAGING_MCP_HOST STATUS_HUB_STAGING_DATABASE_NAME
  STATUS_HUB_ACCESS_TEAM_DOMAIN STATUS_HUB_ACCESS_AUD
  STATUS_HUB_AUTH_MODE STATUS_HUB_ROTATE_UI_TOKEN STATUS_HUB_ROTATE_SESSION_SECRET
  STATUS_HUB_NONINTERACTIVE STATUS_HUB_DRY_RUN STATUS_HUB_ROTATE_TOKEN
  STATUS_HUB_SKIP_LOGIN STATUS_HUB_CONFIG STATUS_HUB_OUT
  CI                     When set, setup does not prompt.
  CLOUDFLARE_API_TOKEN   Wrangler API token for CI.
  CLOUDFLARE_ACCOUNT_ID  Account, required when the token can see more than one.

Re-running keeps an existing admin token unless --rotate-token is set.
A run without --staging leaves an existing staging section in wrangler.local.jsonc as it is.
`;

const REQUIRED = [
  ["timezone", "--timezone / STATUS_HUB_TIMEZONE"],
  ["uiHost", "--ui-host / STATUS_HUB_UI_HOST"],
  ["mcpHost", "--mcp-host / STATUS_HUB_MCP_HOST"],
  ["adminId", "--admin-id / STATUS_HUB_ADMIN_ID"],
  ["adminName", "--admin-name / STATUS_HUB_ADMIN_NAME"],
  ["adminEmail", "--admin-email / STATUS_HUB_ADMIN_EMAIL"],
];

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  yes: { type: "boolean" },
  "non-interactive": { type: "boolean" },
  "dry-run": { type: "boolean" },
  "skip-login-check": { type: "boolean" },
  "rotate-token": { type: "boolean" },
  "auth-mode": { type: "string" },
  "rotate-ui-token": { type: "boolean" },
  "rotate-session-secret": { type: "boolean" },
  staging: { type: "boolean" },
  "no-staging": { type: "boolean" },
  org: { type: "string" },
  timezone: { type: "string" },
  "ui-host": { type: "string" },
  "mcp-host": { type: "string" },
  "owner-ids": { type: "string" },
  "approver-ids": { type: "string" },
  "admin-id": { type: "string" },
  "admin-name": { type: "string" },
  "admin-email": { type: "string" },
  "database-name": { type: "string" },
  "staging-ui-host": { type: "string" },
  "staging-mcp-host": { type: "string" },
  "staging-database-name": { type: "string" },
  "access-team-domain": { type: "string" },
  "access-aud": { type: "string" },
  config: { type: "string" },
  out: { type: "string" },
};

const STRING_FLAGS = new Set(Object.entries(OPTIONS).filter(([, spec]) => spec.type === "string").map(([name]) => `--${name}`));

export function parseSetupArgs(argv, env = {}) {
  let values;
  try {
    ({ values } = nodeParseArgs({
      args: bindNegativeValues(argv),
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
  if (values.help) return { ok: true, help: true, values: null };
  if (values.staging && values["no-staging"]) {
    return { ok: false, error: "pass only one of --staging or --no-staging" };
  }

  const nonInteractive = boolOrError(values.yes || values["non-interactive"], env, "STATUS_HUB_NONINTERACTIVE")
    || ciEnabled(env);
  if (nonInteractive instanceof Error) return { ok: false, error: nonInteractive.message };

  const dryRun = boolOrError(values["dry-run"], env, "STATUS_HUB_DRY_RUN");
  const rotateToken = boolOrError(values["rotate-token"], env, "STATUS_HUB_ROTATE_TOKEN");
  const rotateUiToken = boolOrError(values["rotate-ui-token"], env, "STATUS_HUB_ROTATE_UI_TOKEN");
  const rotateSessionSecret = boolOrError(values["rotate-session-secret"], env, "STATUS_HUB_ROTATE_SESSION_SECRET");
  const skipLoginCheck = boolOrError(values["skip-login-check"], env, "STATUS_HUB_SKIP_LOGIN");
  for (const flag of [dryRun, rotateToken, rotateUiToken, rotateSessionSecret, skipLoginCheck]) {
    if (flag instanceof Error) return { ok: false, error: flag.message };
  }

  let stagingSpecified = false;
  let staging = false;
  if (values.staging) {
    stagingSpecified = true;
    staging = true;
  } else if (values["no-staging"]) {
    stagingSpecified = true;
    staging = false;
  } else {
    const fromEnv = envFlag(env, "STATUS_HUB_STAGING");
    if (fromEnv instanceof Error) return { ok: false, error: fromEnv.message };
    if (fromEnv !== undefined) {
      stagingSpecified = true;
      staging = fromEnv;
    }
  }

  return {
    ok: true,
    help: false,
    values: {
      nonInteractive: Boolean(nonInteractive),
      dryRun: Boolean(dryRun),
      rotateToken: Boolean(rotateToken),
      rotateUiToken: Boolean(rotateUiToken),
      rotateSessionSecret: Boolean(rotateSessionSecret),
      skipLoginCheck: Boolean(skipLoginCheck),
      authMode: pick(values["auth-mode"], env.STATUS_HUB_AUTH_MODE),
      staging,
      stagingSpecified,
      orgName: pick(values.org, env.STATUS_HUB_ORG_NAME),
      timezone: pick(values.timezone, env.STATUS_HUB_TIMEZONE),
      uiHost: pick(values["ui-host"], env.STATUS_HUB_UI_HOST),
      mcpHost: pick(values["mcp-host"], env.STATUS_HUB_MCP_HOST),
      ownerIds: pick(values["owner-ids"], env.STATUS_HUB_OWNER_IDS),
      approverIds: pick(values["approver-ids"], env.STATUS_HUB_APPROVER_IDS),
      adminId: pick(values["admin-id"], env.STATUS_HUB_ADMIN_ID),
      adminName: pick(values["admin-name"], env.STATUS_HUB_ADMIN_NAME),
      adminEmail: pick(values["admin-email"], env.STATUS_HUB_ADMIN_EMAIL),
      databaseName: pick(values["database-name"], env.STATUS_HUB_DATABASE_NAME),
      stagingUiHost: pick(values["staging-ui-host"], env.STATUS_HUB_STAGING_UI_HOST),
      stagingMcpHost: pick(values["staging-mcp-host"], env.STATUS_HUB_STAGING_MCP_HOST),
      stagingDatabaseName: pick(values["staging-database-name"], env.STATUS_HUB_STAGING_DATABASE_NAME),
      accessTeamDomain: pick(values["access-team-domain"], env.STATUS_HUB_ACCESS_TEAM_DOMAIN),
      accessAud: pick(values["access-aud"], env.STATUS_HUB_ACCESS_AUD),
      configPath: pick(values.config, env.STATUS_HUB_CONFIG),
      outPath: pick(values.out, env.STATUS_HUB_OUT),
    },
  };
}

export function missingRequired(values) {
  const missing = [];
  if (!present(values.orgName)) missing.push("--org / STATUS_HUB_ORG_NAME");
  for (const [key, label] of REQUIRED) {
    if (!present(values[key])) missing.push(label);
  }
  if (values.staging) {
    if (!present(values.stagingUiHost)) missing.push("--staging-ui-host / STATUS_HUB_STAGING_UI_HOST");
    if (!present(values.stagingMcpHost)) missing.push("--staging-mcp-host / STATUS_HUB_STAGING_MCP_HOST");
  }
  return missing;
}

export function normalizeSetup(values) {
  const errors = [];
  const missing = missingRequired(values);
  if (missing.length) {
    return { ok: false, errors: missing.map((item) => `${item} is required`) };
  }

  const orgName = String(values.orgName).trim();
  if (!orgName || orgName.length > 80 || /[\r\n]/.test(orgName)) errors.push("--org must be 1-80 characters on one line");

  let tzOffsetMinutes;
  try {
    tzOffsetMinutes = timezoneOffsetMinutes(values.timezone);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const uiHost = normalizeHost(values.uiHost, "--ui-host", errors);
  const mcpHost = normalizeHost(values.mcpHost, "--mcp-host", errors);
  if (uiHost && mcpHost && uiHost === mcpHost) errors.push("--ui-host and --mcp-host must differ");

  const ownerIds = parseIdList(values.ownerIds ?? "", "--owner-ids", errors);
  const approverIds = parseIdList(values.approverIds ?? "", "--approver-ids", errors);
  const adminId = normalizeMemberId(values.adminId, errors);
  const adminName = normalizeAdminName(values.adminName, errors);
  const adminEmail = normalizeEmail(values.adminEmail, errors);

  const databaseName = normalizeDatabaseName(values.databaseName ?? "status-hub", "--database-name", errors);
  let stagingUiHost = null;
  let stagingMcpHost = null;
  let stagingDatabaseName = null;
  if (values.staging) {
    stagingUiHost = normalizeHost(values.stagingUiHost, "--staging-ui-host", errors);
    stagingMcpHost = normalizeHost(values.stagingMcpHost, "--staging-mcp-host", errors);
    stagingDatabaseName = normalizeDatabaseName(
      values.stagingDatabaseName ?? "status-hub-staging",
      "--staging-database-name",
      errors,
    );
    if (stagingUiHost && stagingMcpHost && stagingUiHost === stagingMcpHost) {
      errors.push("--staging-ui-host and --staging-mcp-host must differ");
    }
    const hosts = [uiHost, mcpHost, stagingUiHost, stagingMcpHost].filter(Boolean);
    if (new Set(hosts).size !== hosts.length) errors.push("production and staging hostnames must all differ");
  }

  const accessTeamDomain = values.accessTeamDomain == null
    ? null
    : normalizeHost(values.accessTeamDomain, "--access-team-domain", errors);
  const accessAud = values.accessAud == null ? null : String(values.accessAud).trim();
  const authMode = normalizeAuthMode(values.authMode, errors);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    setup: {
      nonInteractive: Boolean(values.nonInteractive),
      dryRun: Boolean(values.dryRun),
      rotateToken: Boolean(values.rotateToken),
      rotateUiToken: Boolean(values.rotateUiToken),
      rotateSessionSecret: Boolean(values.rotateSessionSecret),
      skipLoginCheck: Boolean(values.skipLoginCheck),
      authMode,
      staging: Boolean(values.staging),
      orgName,
      timezone: String(values.timezone).trim(),
      tzOffsetMinutes,
      uiHost,
      mcpHost,
      ownerIds,
      approverIds,
      adminId,
      adminName,
      adminEmail,
      databaseName,
      stagingUiHost,
      stagingMcpHost,
      stagingDatabaseName,
      accessTeamDomain,
      accessAud,
      configPath: values.configPath?.trim() || "wrangler.jsonc",
      outPath: values.outPath?.trim() || "wrangler.local.jsonc",
    },
  };
}

function bindNegativeValues(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (STRING_FLAGS.has(arg) && next != null && next.startsWith("-") && !next.startsWith("--")) {
      out.push(`${arg}=${next}`);
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function pick(flagValue, envValue) {
  if (flagValue != null) return flagValue;
  if (envValue != null && envValue !== "") return envValue;
  return undefined;
}

function present(value) {
  return value != null && String(value).trim() !== "";
}

function ciEnabled(env) {
  const value = env.CI;
  return value != null && value !== "" && value !== "0" && value !== "false";
}

function envFlag(env, name) {
  const value = env[name];
  if (value == null || value === "") return undefined;
  if (/^(1|true|yes|y)$/i.test(value)) return true;
  if (/^(0|false|no|n)$/i.test(value)) return false;
  return new Error(`${name} must be 1, 0, true, or false`);
}

function boolOrError(flag, env, name) {
  if (flag) return true;
  const fromEnv = envFlag(env, name);
  if (fromEnv instanceof Error) return fromEnv;
  return Boolean(fromEnv);
}

function normalizeAuthMode(value, errors) {
  if (value == null || String(value).trim() === "") return "access";
  const mode = String(value).trim().toLowerCase();
  if (mode === "access" || mode === "token") return mode;
  if (mode === "magic-link") {
    errors.push("--auth-mode magic-link is not available. This Worker does not send email. Use access or token.");
    return "access";
  }
  errors.push("--auth-mode must be access or token");
  return "access";
}

function normalizeHost(value, flag, errors) {
  const host = String(value ?? "").trim().toLowerCase();
  const ok = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host);
  if (!ok) {
    errors.push(`${flag} must be a hostname, without a scheme, port, or path`);
    return null;
  }
  return host;
}

function normalizeMemberId(value, errors) {
  const id = String(value ?? "").trim();
  if (!/^[a-z0-9-]{1,32}$/.test(id)) {
    errors.push("--admin-id must be 1-32 characters of lowercase letters, digits, or hyphens");
    return "";
  }
  return id;
}

function normalizeAdminName(value, errors) {
  const name = String(value ?? "").trim();
  if (!/^[\p{L}\p{N} .'-]{1,80}$/u.test(name)) {
    errors.push("--admin-name must be 1-80 letters, numbers, spaces, apostrophes, periods, or hyphens");
    return "";
  }
  return name;
}

function normalizeEmail(value, errors) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) {
    errors.push("--admin-email must be an email address");
    return "";
  }
  return email;
}

function parseIdList(raw, flag, errors) {
  const ids = [];
  const seen = new Set();
  for (const part of String(raw).split(",")) {
    const id = part.trim();
    if (!id) continue;
    if (!/^[a-z0-9-]{1,64}$/.test(id)) {
      errors.push(`${flag} entries must be lowercase letters, digits, or hyphens`);
      continue;
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function normalizeDatabaseName(value, flag, errors) {
  const name = String(value).trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    errors.push(`${flag} must be a lowercase D1 database name`);
    return name;
  }
  return name;
}
