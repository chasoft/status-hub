import type { D1Migration } from "@cloudflare/vitest-plugin";
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      UI_HOST: string;
      MCP_HOST: string;
      OWNER_IDS?: string;
      APPROVER_IDS?: string;
      ORG_NAME?: string;
      MCP_SERVER_NAME?: string;
      UI_MEMBER_EMAILS?: string;
      LEADERSHIP_AUTHORS?: string;
      UI_ALLOWED_EMAILS?: string;
      TEST_MIGRATIONS: D1Migration[];
      TEST_PRIVATE_JWK: string;
    }
  }
}
export {};
