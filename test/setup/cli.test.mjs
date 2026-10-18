import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const setup = resolve(root, "scripts/setup.mjs");
const localConfig = resolve(root, "wrangler.local.jsonc");

// An operator may already have a wrangler.local.jsonc (after `pnpm run setup`, or a
// deploy pipeline that writes one before testing). The CLI must not create, change,
// or remove it, so compare against the state before the run.
function localConfigState() {
  return existsSync(localConfig) ? readFileSync(localConfig, "utf8") : null;
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [setup, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env, CI: "", STATUS_HUB_NONINTERACTIVE: "" },
  });
}

describe("setup cli", () => {
  it("prints help and is wired from package.json", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(pkg.scripts.setup).toBe("node scripts/setup.mjs");
    expect(pkg.scripts.deploy).toBe("node scripts/deploy.mjs");
    expect(readFileSync(resolve(root, ".gitignore"), "utf8")).toContain("wrangler.local.jsonc");
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--org");
    expect(help.stdout).toContain("STATUS_HUB_ORG_NAME");
    expect(help.stdout).toContain("--rotate-token");
    expect(help.stdout).toContain("--auth-mode");
  });

  it("exits non-zero when non-interactive values are missing", () => {
    const before = localConfigState();
    const result = run(["--yes"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("STATUS_HUB_ORG_NAME");
    expect(localConfigState()).toBe(before);
  });

  it("dry-run prints config and does not write or call wrangler", () => {
    const before = localConfigState();
    const result = run([
      "--yes",
      "--dry-run",
      "--org",
      "Acme",
      "--timezone",
      "-300",
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
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Dry run");
    expect(result.stdout).toContain("Acme");
    expect(result.stdout).toContain("status.acme.test");
    expect(result.stdout).toContain('"-300"');
    expect(result.stdout).toContain('"AUTH_MODE": "access"');
    expect(localConfigState()).toBe(before);
    const tokenMode = run([...resultArgs(), "--auth-mode", "token"]);
    expect(tokenMode.status, tokenMode.stderr).toBe(0);
    expect(tokenMode.stderr).toContain("would upload AUTH_SESSION_SECRET");
    expect(tokenMode.stdout).toContain('"AUTH_MODE": "token"');
    expect(tokenMode.stdout).not.toContain("AUTH_SESSION_SECRET");
    expect(tokenMode.stdout).not.toMatch(/shu_[A-Za-z0-9_-]{43,}/);
    expect(localConfigState()).toBe(before);
  });
});

function resultArgs() {
  return [
    "--yes",
    "--dry-run",
    "--org",
    "Acme",
    "--timezone",
    "-300",
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
}
