import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

// Throwaway RSA key so tests can mint Cloudflare-Access-shaped JWTs.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pub = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256" };
const priv = { ...privateKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256" };

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ENVIRONMENT: "test",
          AUTH_MODE: "access",
          AUTH_SESSION_SECRET: "test-only-session-secret",
          AUTH_SESSION_TTL_SECONDS: "43200",
          ACCESS_AUD: "test-aud",
          ACCESS_TEAM_DOMAIN: "",
          UI_ALLOWED_EMAILS: "owner@example.com,approver@example.com,harry@example.com,peter@example.com,jane@example.com,viewer@example.com",
          OWNER_IDS: "owner",
          APPROVER_IDS: "approver",
          ORG_NAME: "Status Hub",
          MCP_SERVER_NAME: "status-hub",
          UI_MEMBER_EMAILS: "owner@example.com=harry,approver@example.com=lily",
          LEADERSHIP_AUTHORS: "owner@example.com=Owner,approver@example.com=Approver",
          TEST_ACCESS_JWKS: JSON.stringify({ keys: [pub] }),
          TEST_PRIVATE_JWK: JSON.stringify(priv),
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    // Node script tests use vitest.node.config.mjs. The Workers pool has no filesystem.
    exclude: [...configDefaults.exclude, "test/setup/**"],
  },
});
