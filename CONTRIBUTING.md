# Contributing

Status Hub is maintained by Chasoft Labs. Issues and pull requests are welcome. The license is MIT. Copyright (c) 2026 Chasoft Labs. See [LICENSE](LICENSE).

## Development

Node.js 22 is required (see [.nvmrc](.nvmrc)). The package manager is pnpm 10 (`packageManager` in [package.json](package.json)).

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm test
```

`pnpm test` runs Vitest with `@cloudflare/vitest-plugin` and a local D1 database. It applies the SQL in [migrations/](migrations) and does not need a Cloudflare account. That suite is how the board and the MCP route are exercised without a live Access application. The test file injects its own Access keys. Do not commit those keys, a real `database_id`, or a bot token.

`pnpm dev` starts Wrangler against the local D1 database after `pnpm db:migrate:local`. The fetch handler only serves `UI_HOST` and `MCP_HOST`. The committed values are `status.example.com` and `mcp.example.com`, and `ACCESS_AUD` is empty, so a browser on `localhost` receives 403 until those values match the request and Access verification can succeed.

CI on pull requests and on pushes to `main` runs `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, and gitleaks. A docs-only change still has to pass that workflow.

## Migrations

D1 applies each file in [migrations/](migrations) once and records the filename. Do not rename `0001` through `0007`. Put a new schema change in the next number (`0008` or later) and make it additive, so a database that already applied the earlier files can move forward.

`0002_seed.sql` is intentionally a no-op. Production does not ship sample members or projects.

## Code map

| Path | Role |
|---|---|
| `src/index.ts` | Fetch and cron entry. Host routing, Access check, MCP route. |
| `src/mcp.ts` | MCP tool names, arguments, and permission notes. |
| `src/core.ts` | Status transitions, codes, alerts, and D1 writes. |
| `src/auth.ts` | Bearer tokens and the Access JWT check. |
| `src/config.ts` | Env parsing. |
| `src/ui.ts` | Server-rendered HTML. |
| `test/` | Vitest coverage for the rules above. |

Identity stays on the bot token or the verified UI email (`AUTH_MODE=access` or `AUTH_MODE=token`). Tool arguments and form fields do not choose the caller. Follow that in new tools.

## Pull requests

- Describe the behaviour change and which status or tool it affects.
- Add or update a test in `test/` when behaviour changes.
- Keep `pnpm-lock.yaml` in the commit when dependencies change.
- Leave secrets, raw tokens, and production database ids out of the diff. Gitleaks runs in CI.
- Keep the copyright and the MIT license with Chasoft Labs.

A `pnpm run setup` script is not on `main`. A pull request can add it. Until it merges, keep the manual deploy in the [README](README.md). `AUTH_MODE` is `access` or `token`. Document new auth behaviour in [docs/configuration.md](docs/configuration.md). `magic-link` needs an email provider and is not implemented.

## Security reports

Use the process in [SECURITY.md](SECURITY.md). Do not file a public issue for an authentication bypass or a leaked token.
