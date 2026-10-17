import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applySetup, buildLocalConfig, defaultsFromLocal, isPlaceholderDatabaseId } from "../../scripts/lib/config.mjs";
import { parseJsonc } from "../../scripts/lib/jsonc.mjs";

const template = {
  name: "status-hub",
  routes: [
    { pattern: "status.example.com", custom_domain: true },
    { pattern: "mcp.example.com", custom_domain: true },
  ],
  vars: {
    ENVIRONMENT: "production",
    UI_HOST: "status.example.com",
    MCP_HOST: "mcp.example.com",
    ORG_NAME: "Status Hub",
    MCP_SERVER_NAME: "status-hub",
    ACCESS_TEAM_DOMAIN: "your-team.cloudflareaccess.com",
    ACCESS_AUD: "",
    UI_ALLOWED_EMAILS: "you@example.com",
    OWNER_IDS: "",
    APPROVER_IDS: "",
    UI_MEMBER_EMAILS: "you@example.com=admin",
    LEADERSHIP_AUTHORS: "you@example.com=Owner",
  },
  d1_databases: [
    {
      binding: "DB",
      database_name: "status-hub",
      database_id: "00000000-0000-0000-0000-000000000000",
      migrations_dir: "migrations",
    },
  ],
  env: {
    staging: {
      name: "status-hub-staging",
      vars: {
        ENVIRONMENT: "staging",
        UI_HOST: "status-staging.example.com",
        MCP_HOST: "mcp-staging.example.com",
        ORG_NAME: "Status Hub",
        ACCESS_TEAM_DOMAIN: "your-team.cloudflareaccess.com",
        ACCESS_AUD: "",
        UI_ALLOWED_EMAILS: "you@example.com",
        OWNER_IDS: "",
        APPROVER_IDS: "",
        UI_MEMBER_EMAILS: "you@example.com=admin",
        LEADERSHIP_AUTHORS: "you@example.com=Owner",
      },
      d1_databases: [
        {
          binding: "DB",
          database_name: "status-hub-staging",
          database_id: "00000000-0000-0000-0000-000000000001",
          migrations_dir: "migrations",
        },
      ],
      routes: [
        { pattern: "status-staging.example.com", custom_domain: true },
        { pattern: "mcp-staging.example.com", custom_domain: true },
      ],
    },
  },
};

const setup = {
  orgName: "Acme",
  timezone: "America/Los_Angeles",
  tzOffsetMinutes: -420,
  uiHost: "status.acme.test",
  mcpHost: "mcp.acme.test",
  ownerIds: ["ada", "bob"],
  approverIds: ["cara"],
  adminId: "ada",
  adminName: "Ada Lovelace",
  adminEmail: "ada@acme.test",
  databaseName: "acme-hub",
  databaseId: "11111111-1111-4111-8111-111111111111",
  staging: false,
  stagingUiHost: null,
  stagingMcpHost: null,
  stagingDatabaseName: null,
  stagingDatabaseId: null,
  accessTeamDomain: null,
  accessAud: null,
};

describe("applySetup", () => {
  it("writes production fields and leaves staging untouched", () => {
    const next = applySetup(template, setup);
    expect(next.routes).toEqual([
      { pattern: "status.acme.test", custom_domain: true },
      { pattern: "mcp.acme.test", custom_domain: true },
    ]);
    expect(next.vars).toMatchObject({
      ENVIRONMENT: "production",
      ORG_NAME: "Acme",
      UI_HOST: "status.acme.test",
      MCP_HOST: "mcp.acme.test",
      OWNER_IDS: "ada,bob",
      APPROVER_IDS: "cara",
      TZ_OFFSET_MINUTES: "-420",
      UI_ALLOWED_EMAILS: "ada@acme.test",
      UI_MEMBER_EMAILS: "ada@acme.test=ada",
      LEADERSHIP_AUTHORS: "ada@acme.test=Ada Lovelace",
      ACCESS_TEAM_DOMAIN: "your-team.cloudflareaccess.com",
      ACCESS_AUD: "",
      MCP_SERVER_NAME: "status-hub",
    });
    expect(next.d1_databases[0]).toMatchObject({
      binding: "DB",
      database_name: "acme-hub",
      database_id: "11111111-1111-4111-8111-111111111111",
      migrations_dir: "migrations",
    });
    expect(next.env.staging.d1_databases[0].database_id).toBe("00000000-0000-0000-0000-000000000001");
    expect(next.env.staging.vars.UI_HOST).toBe("status-staging.example.com");
    expect(template.vars.ORG_NAME).toBe("Status Hub");
    expect(next.vars.AUTH_MODE).toBe("access");
    expect(next.vars.AUTH_SESSION_SECRET).toBeUndefined();
  });

  it("records token mode and drops a session secret from the config", () => {
    const base = structuredClone(template);
    base.vars.AUTH_SESSION_SECRET = "super-secret-value";
    const text = buildLocalConfig(JSON.stringify(base), { ...setup, authMode: "token" });
    expect(text).toContain('"AUTH_MODE": "token"');
    expect(text).not.toContain("super-secret-value");
    expect(text).not.toContain("AUTH_SESSION_SECRET");
  });

  it("merges extra allowlist entries and drops the placeholder address", () => {
    const base = structuredClone(template);
    base.vars.UI_ALLOWED_EMAILS = "you@example.com,ops@acme.test";
    base.vars.UI_MEMBER_EMAILS = "you@example.com=admin,ops@acme.test=ops";
    base.vars.LEADERSHIP_AUTHORS = "you@example.com=Owner,ops@acme.test=Ops";
    const next = applySetup(base, setup);
    expect(next.vars.UI_ALLOWED_EMAILS).toBe("ops@acme.test,ada@acme.test");
    expect(next.vars.UI_MEMBER_EMAILS).toBe("ops@acme.test=ops,ada@acme.test=ada");
    expect(next.vars.LEADERSHIP_AUTHORS).toBe("ops@acme.test=Ops,ada@acme.test=Ada Lovelace");
  });

  it("is idempotent, including a later run that does not restage", () => {
    const staged = applySetup(template, {
      ...setup,
      staging: true,
      stagingUiHost: "status-staging.acme.test",
      stagingMcpHost: "mcp-staging.acme.test",
      stagingDatabaseName: "acme-staging",
      stagingDatabaseId: "22222222-2222-4222-8222-222222222222",
      accessTeamDomain: "acme.cloudflareaccess.com",
      accessAud: "aud-tag",
    });
    expect(staged.env.staging.vars).toMatchObject({
      ENVIRONMENT: "staging",
      ORG_NAME: "Acme",
      UI_HOST: "status-staging.acme.test",
      MCP_HOST: "mcp-staging.acme.test",
      TZ_OFFSET_MINUTES: "-420",
      ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com",
      ACCESS_AUD: "aud-tag",
    });
    expect(staged.env.staging.d1_databases[0].database_id).toBe("22222222-2222-4222-8222-222222222222");
    const again = applySetup(staged, setup);
    expect(again).toEqual(applySetup(again, setup));
    expect(again.env.staging.d1_databases[0].database_id).toBe("22222222-2222-4222-8222-222222222222");
    expect(again.env.staging.vars.UI_HOST).toBe("status-staging.acme.test");
  });
});

describe("buildLocalConfig", () => {
  it("round-trips the committed wrangler.jsonc without keeping placeholder comments as data", () => {
    const source = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    const parsed = parseJsonc(source);
    expect(isPlaceholderDatabaseId(parsed.d1_databases[0].database_id)).toBe(true);
    expect(isPlaceholderDatabaseId(parsed.env.staging.d1_databases[0].database_id)).toBe(true);
    const once = buildLocalConfig(source, setup);
    const twice = buildLocalConfig(once, setup);
    expect(twice).toBe(once);
    expect(once).toContain("Generated by `pnpm run setup`");
    expect(once).toContain("Timezone: America/Los_Angeles (-420 minutes east of UTC)");
    expect(once).toContain("11111111-1111-4111-8111-111111111111");
    expect(parseJsonc(once).vars.ORG_NAME).toBe("Acme");
  });

  it("reads prompt defaults back from a generated file", () => {
    const text = buildLocalConfig(JSON.stringify(template), {
      ...setup,
      staging: true,
      stagingUiHost: "status-staging.acme.test",
      stagingMcpHost: "mcp-staging.acme.test",
      stagingDatabaseName: "acme-staging",
      stagingDatabaseId: "22222222-2222-4222-8222-222222222222",
      accessAud: "aud-tag",
    });
    expect(defaultsFromLocal(text)).toMatchObject({
      orgName: "Acme",
      timezone: "America/Los_Angeles",
      uiHost: "status.acme.test",
      mcpHost: "mcp.acme.test",
      ownerIds: "ada,bob",
      approverIds: "cara",
      adminId: "ada",
      adminName: "Ada Lovelace",
      adminEmail: "ada@acme.test",
      databaseName: "acme-hub",
      stagingUiHost: "status-staging.acme.test",
      stagingMcpHost: "mcp-staging.acme.test",
      stagingDatabaseName: "acme-staging",
      accessAud: "aud-tag",
      stagingConfigured: true,
    });
  });
});
