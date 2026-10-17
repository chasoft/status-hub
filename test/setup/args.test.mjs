import { describe, expect, it } from "vitest";
import { missingRequired, normalizeSetup, parseSetupArgs, SETUP_HELP } from "../../scripts/lib/args.mjs";

const required = [
  "--yes",
  "--org",
  "Acme",
  "--timezone",
  "UTC",
  "--ui-host",
  "status.acme.test",
  "--mcp-host",
  "mcp.acme.test",
  "--admin-id",
  "ada",
  "--admin-name",
  "Ada Lovelace",
  "--admin-email",
  "ada@acme.test",
];

describe("parseSetupArgs", () => {
  it("reads flags", () => {
    const parsed = parseSetupArgs([
      ...required,
      "--owner-ids",
      "ada,bob",
      "--approver-ids",
      "cara",
      "--database-name",
      "acme-hub",
      "--access-team-domain",
      "acme.cloudflareaccess.com",
      "--access-aud",
      "aud-tag",
    ]);
    expect(parsed.ok).toBe(true);
    expect(parsed.help).toBe(false);
    expect(parsed.values).toMatchObject({
      nonInteractive: true,
      dryRun: false,
      rotateToken: false,
      skipLoginCheck: false,
      staging: false,
      orgName: "Acme",
      timezone: "UTC",
      uiHost: "status.acme.test",
      mcpHost: "mcp.acme.test",
      ownerIds: "ada,bob",
      approverIds: "cara",
      adminId: "ada",
      adminName: "Ada Lovelace",
      adminEmail: "ada@acme.test",
      databaseName: "acme-hub",
      accessTeamDomain: "acme.cloudflareaccess.com",
      accessAud: "aud-tag",
    });
  });

  it("lets flags override env and fills the rest from env", () => {
    const parsed = parseSetupArgs(["--org", "FromFlag", "--yes"], {
      STATUS_HUB_ORG_NAME: "FromEnv",
      STATUS_HUB_TIMEZONE: "Asia/Kolkata",
      STATUS_HUB_UI_HOST: "status.env.test",
      STATUS_HUB_MCP_HOST: "mcp.env.test",
      STATUS_HUB_ADMIN_ID: "ada",
      STATUS_HUB_ADMIN_NAME: "Ada",
      STATUS_HUB_ADMIN_EMAIL: "ada@env.test",
      STATUS_HUB_OWNER_IDS: "owner",
      STATUS_HUB_STAGING: "yes",
      STATUS_HUB_DRY_RUN: "1",
      STATUS_HUB_ROTATE_TOKEN: "true",
      STATUS_HUB_SKIP_LOGIN: "1",
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.values.orgName).toBe("FromFlag");
    expect(parsed.values.timezone).toBe("Asia/Kolkata");
    expect(parsed.values.uiHost).toBe("status.env.test");
    expect(parsed.values.staging).toBe(true);
    expect(parsed.values.dryRun).toBe(true);
    expect(parsed.values.rotateToken).toBe(true);
    expect(parsed.values.skipLoginCheck).toBe(true);
    expect(parsed.values.ownerIds).toBe("owner");
  });

  it("defaults auth mode to access and accepts token", () => {
    const access = normalizeSetup(parseSetupArgs(required).values);
    expect(access.ok).toBe(true);
    expect(access.setup.authMode).toBe("access");
    const token = normalizeSetup(parseSetupArgs([...required, "--auth-mode", "Token"], {
      STATUS_HUB_ROTATE_UI_TOKEN: "1",
      STATUS_HUB_ROTATE_SESSION_SECRET: "yes",
    }).values);
    expect(token.ok).toBe(true);
    expect(token.setup.authMode).toBe("token");
    expect(token.setup.rotateUiToken).toBe(true);
    expect(token.setup.rotateSessionSecret).toBe(true);
    const magic = normalizeSetup(parseSetupArgs([...required, "--auth-mode", "magic-link"]).values);
    expect(magic.ok).toBe(false);
    expect(magic.errors.join("\n")).toMatch(/magic-link/);
    const unknown = normalizeSetup(parseSetupArgs([...required, "--auth-mode", "oauth"]).values);
    expect(unknown.ok).toBe(false);
  });

  it("treats CI as non-interactive and --no-staging as off", () => {
    const parsed = parseSetupArgs(["--no-staging"], { CI: "true", STATUS_HUB_STAGING: "1" });
    expect(parsed.ok).toBe(true);
    expect(parsed.values.nonInteractive).toBe(true);
    expect(parsed.values.staging).toBe(false);
  });

  it("rejects unknown flags and missing values", () => {
    expect(parseSetupArgs(["--nope"]).ok).toBe(false);
    expect(parseSetupArgs(["--nope"]).error).toMatch(/unknown option/i);
    expect(parseSetupArgs(["--org"]).ok).toBe(false);
    expect(parseSetupArgs(["--org"]).error).toMatch(/--org/);
  });

  it("returns help without requiring values", () => {
    const parsed = parseSetupArgs(["--help"]);
    expect(parsed).toEqual({ ok: true, help: true, values: null });
    expect(SETUP_HELP).toContain("STATUS_HUB_ORG_NAME");
    expect(SETUP_HELP).toContain("--rotate-token");
    expect(SETUP_HELP).toContain("wrangler.local.jsonc");
  });
});

describe("normalizeSetup", () => {
  it("normalizes a complete flag set", () => {
    const parsed = parseSetupArgs(required);
    const result = normalizeSetup(parsed.values);
    expect(result.ok).toBe(true);
    expect(result.setup).toMatchObject({
      orgName: "Acme",
      timezone: "UTC",
      tzOffsetMinutes: 0,
      uiHost: "status.acme.test",
      mcpHost: "mcp.acme.test",
      ownerIds: [],
      approverIds: [],
      adminId: "ada",
      adminName: "Ada Lovelace",
      adminEmail: "ada@acme.test",
      databaseName: "status-hub",
      staging: false,
      stagingDatabaseName: null,
      accessTeamDomain: null,
      accessAud: null,
      configPath: "wrangler.jsonc",
      outPath: "wrangler.local.jsonc",
    });
  });

  it("parses id lists, staging hosts, and a numeric timezone", () => {
    const parsed = parseSetupArgs([
      ...required,
      "--timezone",
      "-300",
      "--owner-ids",
      " ada, ada, bob ",
      "--approver-ids",
      "cara",
      "--staging",
      "--staging-ui-host",
      "Status-Staging.Acme.Test",
      "--staging-mcp-host",
      "mcp-staging.acme.test",
      "--staging-database-name",
      "acme-staging",
    ]);
    const result = normalizeSetup(parsed.values);
    expect(result.ok).toBe(true);
    expect(result.setup.tzOffsetMinutes).toBe(-300);
    expect(result.setup.ownerIds).toEqual(["ada", "bob"]);
    expect(result.setup.approverIds).toEqual(["cara"]);
    expect(result.setup.stagingUiHost).toBe("status-staging.acme.test");
    expect(result.setup.stagingDatabaseName).toBe("acme-staging");
  });

  it("lists missing required values for non-interactive runs", () => {
    const parsed = parseSetupArgs(["--yes", "--org", "Acme"]);
    expect(missingRequired(parsed.values)).toEqual([
      "--timezone / STATUS_HUB_TIMEZONE",
      "--ui-host / STATUS_HUB_UI_HOST",
      "--mcp-host / STATUS_HUB_MCP_HOST",
      "--admin-id / STATUS_HUB_ADMIN_ID",
      "--admin-name / STATUS_HUB_ADMIN_NAME",
      "--admin-email / STATUS_HUB_ADMIN_EMAIL",
    ]);
    const result = normalizeSetup(parsed.values);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("STATUS_HUB_TIMEZONE");
  });

  it("rejects bad hosts, ids, emails, and colliding hostnames", () => {
    const cases = [
      ["--ui-host", "https://status.acme.test"],
      ["--mcp-host", "mcp.acme.test/mcp"],
      ["--admin-id", "Ada"],
      ["--admin-email", "not-an-email"],
      ["--admin-name", "Ada, Lovelace"],
      ["--owner-ids", "ok, bad id"],
      ["--ui-host", "mcp.acme.test", "--mcp-host", "mcp.acme.test"],
    ];
    for (const extra of cases) {
      const args = required.filter((part, index) => {
        const flag = extra[0];
        if (part !== flag) return true;
        return false;
      });
      // required already contains each flag once; replace by appending overrides
      const parsed = parseSetupArgs([...required, ...extra]);
      const result = normalizeSetup(parsed.values);
      expect(result.ok, extra.join(" ")).toBe(false);
      expect(args.length).toBeGreaterThan(0);
    }
  });

  it("requires staging hostnames only when staging is on", () => {
    const parsed = parseSetupArgs([...required, "--staging"]);
    const result = normalizeSetup(parsed.values);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("STATUS_HUB_STAGING_UI_HOST");
  });
});
