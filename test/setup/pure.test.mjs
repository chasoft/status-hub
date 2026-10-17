import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { databaseIdByName, parseD1List, parseD1Query } from "../../scripts/lib/d1.mjs";
import { planDeploy } from "../../scripts/lib/deploy-plan.mjs";
import { parseJsonc } from "../../scripts/lib/jsonc.mjs";
import { planAdminWrite, readHasToken, selectAdminSql, sqlLiteral, timezoneSettingSql, upsertAdminSql } from "../../scripts/lib/admin-sql.mjs";
import { timezoneOffsetMinutes } from "../../scripts/lib/timezone.mjs";
import { createMcpToken } from "../../scripts/lib/token.mjs";
import { createSessionSecret, createUiLoginToken, insertUiLoginSql, planUiLogin, readCount, secretNames, selectActiveUiLoginSql } from "../../scripts/lib/ui-login.mjs";

describe("parseJsonc", () => {
  it("strips comments, trailing commas, and keeps comment-like text in strings", () => {
    const value = parseJsonc(`
      {
        // line comment
        "note": "keep // this",
        "block": "/* no */",
        "n": 1,
      }
    `);
    expect(value).toEqual({ note: "keep // this", block: "/* no */", n: 1 });
  });
});

describe("timezoneOffsetMinutes", () => {
  const winter = new Date("2026-01-15T12:00:00Z");
  const summer = new Date("2026-07-15T12:00:00Z");

  it("accepts UTC, offsets, minutes, and IANA names", () => {
    expect(timezoneOffsetMinutes("UTC")).toBe(0);
    expect(timezoneOffsetMinutes("gmt")).toBe(0);
    expect(timezoneOffsetMinutes("+08:00")).toBe(480);
    expect(timezoneOffsetMinutes("-05:30")).toBe(-330);
    expect(timezoneOffsetMinutes("+5")).toBe(300);
    expect(timezoneOffsetMinutes("-300")).toBe(-300);
    expect(timezoneOffsetMinutes("Asia/Kolkata", winter)).toBe(330);
    expect(timezoneOffsetMinutes("America/Los_Angeles", winter)).toBe(-480);
    expect(timezoneOffsetMinutes("America/Los_Angeles", summer)).toBe(-420);
    expect(timezoneOffsetMinutes("Pacific/Chatham", winter)).toBe(13 * 60 + 45);
  });

  it("rejects unknown zones and out-of-range numbers", () => {
    expect(() => timezoneOffsetMinutes("Not/AZone")).toThrow(/timezone/i);
    expect(() => timezoneOffsetMinutes("2000")).toThrow(/range/i);
    expect(() => timezoneOffsetMinutes("")).toThrow(/required/i);
  });
});

describe("admin sql", () => {
  it("escapes quotes and plans an idempotent token write", () => {
    expect(sqlLiteral("O'Neil")).toBe("'O''Neil'");
    expect(selectAdminSql("ada")).toContain("WHERE id = 'ada'");
    expect(selectAdminSql("ada")).not.toContain("token_hash,");
    const insert = upsertAdminSql({
      exists: false,
      id: "ada",
      name: "O'Neil",
      tokenHash: "ab".repeat(32),
      createdAt: 100,
      rotate: false,
    });
    expect(insert).toContain("INSERT INTO members");
    expect(insert).toContain("'O''Neil'");
    expect(insert).toContain("'abababababababababababababababababababababababababababababababab'");
    const keep = upsertAdminSql({
      exists: true,
      id: "ada",
      name: "Ada",
      tokenHash: null,
      createdAt: 100,
      rotate: false,
    });
    expect(keep.startsWith("UPDATE")).toBe(true);
    expect(keep).not.toContain("token_hash");
    const rotate = upsertAdminSql({
      exists: true,
      id: "ada",
      name: "Ada",
      tokenHash: "cd".repeat(32),
      createdAt: 100,
      rotate: true,
    });
    expect(rotate).toContain("token_hash");
    expect(timezoneSettingSql(-420)).toContain("'-420'");
    expect(timezoneSettingSql(-420)).toContain("ON CONFLICT");
  });

  it("stores a token only when creating, filling, or rotating", () => {
    expect(planAdminWrite({ exists: false, hasToken: false, rotate: false })).toEqual({ action: "insert", storeToken: true });
    expect(planAdminWrite({ exists: true, hasToken: false, rotate: false })).toEqual({ action: "update", storeToken: true });
    expect(planAdminWrite({ exists: true, hasToken: true, rotate: false })).toEqual({ action: "update", storeToken: false });
    expect(planAdminWrite({ exists: true, hasToken: true, rotate: true })).toEqual({ action: "update", storeToken: true });
  });

  it("reads the has_token flag without needing the hash", () => {
    expect(readHasToken([{ results: [], success: true }])).toEqual({ exists: false, hasToken: false });
    expect(readHasToken([{ results: [{ has_token: 1 }], success: true }])).toEqual({ exists: true, hasToken: true });
    expect(readHasToken([{ results: [{ has_token: 0 }], success: true }])).toEqual({ exists: true, hasToken: false });
  });
});

describe("createMcpToken", () => {
  it("matches the bearer shape and hashes the raw token", () => {
    const { token, hash } = createMcpToken("ada", Buffer.alloc(32, 7));
    expect(token).toMatch(/^shk_ada_[A-Za-z0-9_-]{32,}$/);
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hash).toHaveLength(64);
  });
});

describe("d1 json", () => {
  it("finds a database by name and ignores log lines before the JSON", () => {
    const stdout = `banner\n[{"uuid":"11111111-1111-4111-8111-111111111111","name":"status-hub","created_at":"x"}]`;
    const rows = parseD1List(stdout);
    expect(databaseIdByName(rows, "status-hub")).toBe("11111111-1111-4111-8111-111111111111");
    expect(databaseIdByName(rows, "missing")).toBe(null);
  });

  it("parses a query payload", () => {
    const payload = parseD1Query('noise\n[{"results":[{"has_token":0}],"success":true}]');
    expect(readHasToken(payload).exists).toBe(true);
  });

  it("rejects duplicate names", () => {
    expect(() => databaseIdByName([
      { name: "status-hub", uuid: "11111111-1111-4111-8111-111111111111" },
      { name: "status-hub", uuid: "22222222-2222-4222-8222-222222222222" },
    ], "status-hub")).toThrow(/more than once/i);
  });
});

describe("ui login", () => {
  it("mints an shu token and stores only the hash in SQL", () => {
    const minted = createUiLoginToken("Ada@Acme.Test", Buffer.alloc(32, 9), "11111111-1111-4111-8111-111111111111");
    expect(minted.email).toBe("ada@acme.test");
    expect(minted.token).toMatch(/^shu_[A-Za-z0-9_-]{43,128}$/);
    expect(minted.hash).toBe(createHash("sha256").update(minted.token).digest("hex"));
    const sql = insertUiLoginSql({ id: minted.id, tokenHash: minted.hash, email: minted.email, createdAt: 100 });
    expect(sql).toContain("INSERT INTO ui_login_tokens");
    expect(sql).toContain("'ada@acme.test'");
    expect(sql).not.toContain(minted.token);
    expect(selectActiveUiLoginSql("ada@acme.test")).toContain("revoked_at IS NULL");
    expect(planUiLogin({ activeCount: 1, rotate: false })).toEqual({ store: false });
    expect(planUiLogin({ activeCount: 0, rotate: false })).toEqual({ store: true });
    expect(planUiLogin({ activeCount: 2, rotate: true })).toEqual({ store: true });
    expect(readCount([{ results: [{ n: 1 }], success: true }])).toBe(1);
    expect(secretNames('[{"name":"AUTH_SESSION_SECRET"},{"name":"OTHER"}]')).toEqual(["AUTH_SESSION_SECRET", "OTHER"]);
    expect(createSessionSecret(Buffer.alloc(32, 4)).length).toBeGreaterThanOrEqual(16);
  });
});

describe("planDeploy", () => {
  it("uses the local config when it exists and forwards extra args", () => {
    expect(planDeploy({ argv: ["--env", "staging"], localConfigExists: true })).toEqual({
      configPath: "wrangler.local.jsonc",
      args: ["deploy", "--config", "wrangler.local.jsonc", "--env", "staging"],
      warnMissingLocal: false,
    });
  });

  it("falls back to the template and keeps an explicit config", () => {
    expect(planDeploy({ argv: [], localConfigExists: false }).warnMissingLocal).toBe(true);
    expect(planDeploy({ argv: [], localConfigExists: false }).args).toEqual([
      "deploy",
      "--config",
      "wrangler.jsonc",
    ]);
    const explicit = planDeploy({ argv: ["--config", "custom.jsonc"], localConfigExists: false });
    expect(explicit.args).toEqual(["deploy", "--config", "custom.jsonc"]);
    expect(explicit.warnMissingLocal).toBe(false);
  });
});
