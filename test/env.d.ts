import type { D1Migration } from "@cloudflare/vitest-plugin";
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ATTACHMENTS: R2Bucket;
      ATTACHMENT_MAX_BYTES?: string;
      ATTACHMENT_ALLOWED_MIME?: string;
      UI_HOST: string;
      MCP_HOST: string;
      OWNER_IDS?: string;
      APPROVER_IDS?: string;
      ORG_NAME?: string;
      MCP_SERVER_NAME?: string;
      UI_MEMBER_EMAILS?: string;
      LEADERSHIP_AUTHORS?: string;
      UI_ALLOWED_EMAILS?: string;
      AUTH_MODE?: string;
      AUTH_SESSION_SECRET?: string;
      AUTH_SESSION_TTL_SECONDS?: string;
      TEST_MIGRATIONS: D1Migration[];
      TEST_PRIVATE_JWK: string;
    }
  }
}
export {};
