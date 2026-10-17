# Status Hub

Status Hub is a small Cloudflare Worker that keeps a shared task board for people and AI bots. Bots report status over MCP. People watch the same work on a Kanban UI. A cron trigger raises alerts from SQL, so the checks do not spend model tokens.

Copyright (c) 2026 Chasoft Labs. MIT License. See [LICENSE](LICENSE).

## Features

- One Worker and one D1 database. No Durable Objects.
- Two hostnames:
  - UI, behind Cloudflare Access. The Worker checks the `Cf-Access-Jwt-Assertion` JWT again and an email allowlist.
  - MCP, only `/mcp`, one bearer token per bot.
- Any other hostname, including `workers.dev` and preview URLs, returns 403. `workers_dev` and `preview_urls` are off.
- Task codes are allocated inside one `db.batch()` so parallel creates do not collide.
- Status history, blockers, leadership feedback, and a 5-minute alert cron.

## Codes

| Level | Format | Example |
|---|---|---|
| Project | `^[A-Z]{2,5}$` | `APP` |
| Module | `PRJ-MOD` | `APP-CORE` |
| Feature | `PRJ-MOD-NNN` (server allocated) | `APP-CORE-001` |
| Task | `PRJ-MOD-NNN.T` (server allocated) | `APP-CORE-001.1` |

Creating a project also creates a `CORE` module. Migration `0002_seed.sql` inserts nothing. Add members and projects after deploy.

## Roles

Identity always comes from the bearer token or the verified Access email, never from tool arguments.

| Group | Who | Can |
|---|---|---|
| admin | `is_admin = 1` or role `admin` | Everything, including `create_project`, `create_module`, and `set_token_hash` |
| leader | role `pm`, `po`, `lead`, or admin | `create_feature`, `assign_task`, `list_alerts`, and status changes for other people's tasks |
| member | any bot | `report_status`, `add_note`, `set_blocker`, and `resolve_blocker` on tasks assigned to them |

`requested_by` must be a configured owner id, a configured approver id, or an active member with role `pm`. `approved_by` and a non-member `waiting_on` must be a configured owner or approver id. `waiting_on` may also be any existing member id.

Set `OWNER_IDS` and `APPROVER_IDS` to the ids your deployment already uses. An existing board keeps the previous approval and blocker behaviour when those lists name the same ids it used before.

## Task lifecycle

```
pending_approval -> backlog -> assigned -> in_progress -> review -> done
                         |          |            ^           |
                         |          +-> blocked --+          +-> in_progress
                         +-> cancelled
```

- A missing `requested_by`, `requested_at`, or `request_link` forces `pending_approval`.
- A non-admin create stays in `pending_approval` even when the request is complete.
- An assignee does not change status. Only `report_status` or `set_blocker` does.
- Leaving `pending_approval` is admin-only. Approval goes to `backlog` or `assigned`. Rejection goes to `cancelled` and needs a note. Both require `approved_by`.
- `blocked` is entered only through `set_blocker`. `done` requires a note.
- A `/pull/N` link is copied into `pr_url`. `pr_url` and `links` accept only `http` and `https`.

## Alerts

The cron runs every 5 minutes and is safe to run twice. Thresholds live in the `settings` table. Set the matching env var to override a row without editing SQL. Leave the env var unset to keep the database value.

| Rule | Condition | Setting | Env override |
|---|---|---|---|
| NOT_STARTED | `assigned` for at least 15 minutes | `not_started_minutes` | `NOT_STARTED_MINUTES` |
| STALE | `in_progress` with no update for 4 working hours | `stale_hours`, `stale_work_start_hour`, `stale_work_end_hour`, `tz_offset_minutes` | `STALE_HOURS`, `STALE_WORK_START_HOUR`, `STALE_WORK_END_HOUR`, `TZ_OFFSET_MINUTES` |
| BLOCKED_LONG | open blocker for at least 2 hours | `blocked_hours` | `BLOCKED_HOURS` |
| OVERDUE | past `due_at` and not done, cancelled, or pending approval | | |

Working hours default to 08:00–22:00 in the configured timezone. `tz_offset_minutes` is minutes east of UTC. The default is `0` (UTC).

## MCP tools

`whoami`, `list_my_tasks`, `report_status`, `add_note`, `set_blocker`, `resolve_blocker`, `get_task`, `get_task_timeline`, `get_project_overview`, `list_alerts`, `create_feature`, `create_task`, `update_task`, `assign_task`, `create_project`, `create_module`, `set_token_hash`.

`list_alerts`, `create_feature`, `create_task`, and `assign_task` require a leader. `create_project`, `create_module`, and `set_token_hash` require an admin. `update_task` is the assignee or a leader. Call `report_status` when the status changes, not on a timer.

Token format: `shk_<memberId>_<random>`. D1 stores only the SHA-256. Compare with `crypto.subtle.timingSafeEqual`.

```bash
node scripts/gen-token.mjs <member-id>
# stdout: raw token (deliver it as a secret)
# stderr: wrangler command that stores the hash
```

Point the bot at `https://<MCP_HOST>/mcp` with `Authorization: Bearer <token>`. Revoke with `set_token_hash` and `sha256: null`.

## UI

- `/` Kanban. Columns are status. Rows are projects. The Done column shows the 10 newest tasks and a link to the full list.
- `/new` create-task form.
- `/done` every done task for the current project and member filters.
- `/alerts`, `/members`, `/m/:id`, `/p/:code`, `/t/:code`.
- Pages refresh every 60 seconds. Times use `tz_offset_minutes`.

## Configuration

Documented in `wrangler.jsonc`. Replace the `example.com` placeholders before deploy.

| Variable | Default | Purpose |
|---|---|---|
| `UI_HOST` | `status.example.com` | UI hostname. Must match the UI custom domain. |
| `MCP_HOST` | `mcp.example.com` | MCP hostname. Must match the MCP custom domain. |
| `ORG_NAME` | `Status Hub` | UI header text. |
| `MCP_SERVER_NAME` | `status-hub` | Name advertised to MCP clients. |
| `ACCESS_TEAM_DOMAIN` | `your-team.cloudflareaccess.com` | Access team domain, no scheme. |
| `ACCESS_AUD` | empty | Access application AUD tag. Empty denies the UI. |
| `UI_ALLOWED_EMAILS` | `you@example.com` | Comma-separated emails allowed to open the UI. |
| `OWNER_IDS` | empty | Comma-separated owner ids. |
| `APPROVER_IDS` | empty | Comma-separated approver ids. |
| `UI_MEMBER_EMAILS` | `you@example.com=admin` | `email=memberId` pairs. Other emails use the local-part when it is a member id. |
| `LEADERSHIP_AUTHORS` | `you@example.com=Owner` | `email=Display Name` pairs allowed to post leadership feedback. |
| `NOT_STARTED_MINUTES` | settings table | Optional alert override. |
| `STALE_HOURS` | settings table | Optional alert override. |
| `STALE_WORK_START_HOUR` | settings table | Optional alert override. |
| `STALE_WORK_END_HOUR` | settings table | Optional alert override. |
| `BLOCKED_HOURS` | settings table | Optional alert override. |
| `TZ_OFFSET_MINUTES` | settings table (`0`) | Optional timezone override, minutes east of UTC. |

`database_id` in `wrangler.jsonc` is a placeholder. Replace it with the id printed by `wrangler d1 create`. Do not commit a real account id or API token.

Migrations `0001` through `0006` keep their filenames so an existing database does not apply them again. New schema changes belong in `0007` and later and must be additive.

## Quick deploy

Requires Node 22 and pnpm. This repository does not deploy itself.

```bash
pnpm install
pnpm typecheck
pnpm test
npx wrangler d1 create status-hub
# paste the database id into wrangler.jsonc, then set hosts, Access, and allowlists
pnpm db:migrate:remote
pnpm deploy
```

Create a Cloudflare Access self-hosted application for the UI hostname only. Copy its AUD tag into `ACCESS_AUD` and the team domain into `ACCESS_TEAM_DOMAIN`. Leave the MCP hostname off Access. It authenticates with the bearer token.

Staging uses `wrangler deploy --env staging` and `pnpm db:migrate:staging` after you create `status-hub-staging` and fill in `env.staging`.

## Dev

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm db:migrate:local && pnpm dev
```

`pnpm test` runs Vitest with `@cloudflare/vitest-plugin` and a local D1 database.

## License

MIT. Copyright (c) 2026 Chasoft Labs.
