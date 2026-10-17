import { applyD1Migrations, env } from "cloudflare:test";
import { configFromEnv, useHubConfig } from "../src/config";
import { FIXTURE_SQL } from "./fixtures";

useHubConfig(configFromEnv(env));
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
for (const sql of FIXTURE_SQL.split(";").map((s) => s.trim()).filter(Boolean)) {
  await env.DB.prepare(sql).run();
}
