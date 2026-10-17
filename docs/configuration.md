# Configuration

Status Hub reads deployment settings from Worker environment variables. The active config is deployment-wide: every request in an isolate sees the same values. Request data cannot change them.

Committed defaults live in [wrangler.jsonc](../wrangler.jsonc). Replace the `example.com` placeholders, the Access application values, and the D1 `database_id` before you deploy. Do not commit a real account id, API token, or bot token.

Pluggable UI authentication (`AUTH_MODE`) is coming and is not a variable in this release. The UI hostname always requires a Cloudflare Access JWT. MCP always requires a bearer token. See [Security](../SECURITY.md).

## Variables

| Variable | Default in `wrangler.jsonc` | When unset in code | Purpose |
|---|---|---|---|
| `ENVIRONMENT` | `production` | The test suite sets `test`. Any other value uses the live Access certificate endpoint. | Selects production behaviour. `staging` is set on the staging Worker. |
| `UI_HOST` | `status.example.com` | Required. Routing compares the request hostname to this value. | Hostname of the Kanban UI. Must match the UI custom domain. |
| `MCP_HOST` | `mcp.example.com` | Required. Routing compares the request hostname to this value. | Hostname of the MCP server. Must match the MCP custom domain. Only `/mcp` is served. |
| `ORG_NAME` | `Status Hub` | `Status Hub` | Text in the UI header. A blank value uses `Status Hub`. |
| `MCP_SERVER_NAME` | `status-hub` | `status-hub` | Name advertised to MCP clients. A blank value uses `status-hub`. |
| `ACCESS_TEAM_DOMAIN` | `your-team.cloudflareaccess.com` | The UI is denied, except in the test suite. | Access team domain, without `https://`. The JWT `iss` must be `https://` plus this domain. |
| `ACCESS_AUD` | empty | Every UI request is denied. | Access application AUD tag for the UI hostname. |
| `UI_ALLOWED_EMAILS` | `you@example.com` | No email is allowed, so the UI is denied. | Comma-separated emails allowed to open the UI, in addition to the Access policy. |
| `OWNER_IDS` | empty | No owner ids. | Comma-separated ids that may be `waiting_on`, `requested_by`, and `approved_by`. They do not have to be members. |
| `APPROVER_IDS` | empty | No approver ids. | Comma-separated ids with the same request and approval privileges as owners. They do not have to be members. |
| `UI_MEMBER_EMAILS` | `you@example.com=admin` | No explicit map. The email's local-part is used when it is an active member id. | Comma-separated `email=memberId` pairs for UI sessions. |
| `LEADERSHIP_AUTHORS` | `you@example.com=Owner` | Nobody can post leadership feedback. | Comma-separated `email=Display Name` pairs. The display name is what gets stored. |
| `NOT_STARTED_MINUTES` | unset | `settings.not_started_minutes`, seeded as `15` | Optional alert override. |
| `STALE_HOURS` | unset | `settings.stale_hours`, seeded as `4` | Optional alert override. |
| `STALE_WORK_START_HOUR` | unset | `settings.stale_work_start_hour`, seeded as `8` | Optional alert override. Hour is inclusive, in the configured timezone. |
| `STALE_WORK_END_HOUR` | unset | `settings.stale_work_end_hour`, seeded as `22` | Optional alert override. Hour is exclusive. |
| `BLOCKED_HOURS` | unset | `settings.blocked_hours`, seeded as `2` | Optional alert override. |
| `TZ_OFFSET_MINUTES` | unset | `settings.tz_offset_minutes`, seeded as `0` | Optional timezone override, in minutes east of UTC. `0` is UTC. A set value of `0` still overrides the table. |

Lists are comma-separated. Whitespace around each item is ignored. Empty items are dropped. A repeated id in `OWNER_IDS` or `APPROVER_IDS` is kept once, at its first position. In `UI_MEMBER_EMAILS` and `LEADERSHIP_AUTHORS`, emails are lowercased, and a repeated email keeps the last value. An item without `=` is ignored.

An alert override applies when the variable is set to a finite number, including `0`. A blank or non-numeric value leaves the `settings` row in effect. Overrides replace the table for the whole deployment. They do not write the row back.

`OWNER_IDS` and `APPROVER_IDS` are the ids your deployment already uses for approval and blockers. An existing board keeps its previous approval and blocker behaviour when those lists name the same ids it used before. An id in both lists is treated as an owner when blockers are sorted on the alerts page (owners first, then approvers, then everyone else).

`UI_MEMBER_EMAILS` wins over the local-part rule. For `person@example.com` with no pair, the Worker looks up member id `person` when that id matches `^[a-z0-9-]{1,32}$`.

## Staging

`env.staging` is a separate Worker named `status-hub-staging`. It does not inherit production vars.

| Variable | Staging default |
|---|---|
| `ENVIRONMENT` | `staging` |
| `UI_HOST` | `status-staging.example.com` |
| `MCP_HOST` | `mcp-staging.example.com` |
| `ORG_NAME` | `Status Hub` |
| `MCP_SERVER_NAME` | `status-hub` |
| `ACCESS_TEAM_DOMAIN` | `your-team.cloudflareaccess.com` |
| `ACCESS_AUD` | empty |
| `UI_ALLOWED_EMAILS` | `you@example.com` |
| `OWNER_IDS` | empty |
| `APPROVER_IDS` | empty |
| `UI_MEMBER_EMAILS` | `you@example.com=admin` |
| `LEADERSHIP_AUTHORS` | `you@example.com=Owner` |

The alert variables are unset in staging as well, so staging uses its own `settings` table after migrations. Custom domains, `workers_dev: false`, `preview_urls: false`, and the `*/5 * * * *` cron are set again on the staging env.

```bash
pnpm db:migrate:staging
pnpm deploy:staging
```

`pnpm run token <member-id> staging` prints a hash command for the staging database.

## Other `wrangler.jsonc` settings

These are Wrangler settings, not Worker env vars.

| Setting | Committed value | What to change |
|---|---|---|
| `name` | `status-hub` | Leave it unless you want a different Worker name. |
| `main` | `src/index.ts` | Worker entry. |
| `compatibility_date` | `2026-10-17` | Keep the date the code was written for unless you review compatibility changes. |
| `compatibility_flags` | `nodejs_compat` | Required by the Worker. |
| `workers_dev` | `false` | Leave off. The fetch handler also returns 403 for any hostname other than `UI_HOST` and `MCP_HOST`. |
| `preview_urls` | `false` | Leave off, for the same reason. |
| `routes` | `status.example.com`, `mcp.example.com`, both `custom_domain: true` | Your two hostnames. Each must match `UI_HOST` or `MCP_HOST`. |
| `d1_databases[0].binding` | `DB` | The code reads `env.DB`. |
| `d1_databases[0].database_name` | `status-hub` | The name you passed to `wrangler d1 create`. |
| `d1_databases[0].database_id` | `00000000-0000-0000-0000-000000000000` | Placeholder. Replace it with the id from `wrangler d1 create status-hub`. |
| `d1_databases[0].migrations_dir` | `migrations` | Leave it. |
| `triggers.crons` | `*/5 * * * *` | Alert cron. Running it twice does not duplicate an open alert. |
| `observability` | logs, invocation logs, and traces enabled | Worker logs and traces for this script. |
| Staging `database_name` | `status-hub-staging` | Create this database before `pnpm db:migrate:staging`. |
| Staging `database_id` | `00000000-0000-0000-0000-000000000001` | Placeholder. Replace it with the staging database id. |

## Settings table

Migration `0001_init.sql` inserts the alert defaults. Change a row with D1 when you want a durable value and the matching env var is unset:

```sql
UPDATE settings SET value = '30' WHERE key = 'not_started_minutes';
```

| Key | Seeded value | Meaning |
|---|---|---|
| `not_started_minutes` | `15` | `assigned` for at least this many minutes raises `NOT_STARTED`. |
| `stale_hours` | `4` | `in_progress` with no update for this many working hours raises `STALE`. |
| `stale_work_start_hour` | `8` | First hour that counts toward `STALE` (inclusive). |
| `stale_work_end_hour` | `22` | Hour at which `STALE` stops counting (exclusive). |
| `blocked_hours` | `2` | An open blocker at least this old, on a `blocked` task, raises `BLOCKED_LONG`. Wall clock. |
| `tz_offset_minutes` | `0` | Minutes east of UTC. The UI uses it to format timestamps. `STALE` uses it to decide which hours count. |

`OVERDUE` has no threshold variable. It opens when `due_at` is in the past and the status is not `done`, `cancelled`, or `pending_approval`.

## Migrations

`wrangler d1 migrations apply` runs files in [migrations/](../migrations) in order. D1 records applied files by filename.

| File | What it does |
|---|---|
| `0001_init.sql` | Tables, indexes, and the `settings` seeds above. |
| `0002_seed.sql` | No rows. The file must keep this name so an existing database does not apply a renamed file. |
| `0003_status_periods.sql` | Time-in-status history. |
| `0004_pending_approval.sql` | `pending_approval` and the request columns. |
| `0005_leadership_feedback.sql` | Leadership feedback. |
| `0006_task_reviewer.sql` | `reviewer_id`. |
| `0007_configurable_roles.sql` | Drops fixed requester, approver, and feedback-author checks so those lists come from env. |

Do not rename `0001` through `0007`. Add a new schema change as the next number, `0008` or later, and make it additive.

## Members and tokens

There is no MCP tool that creates a member. Insert one after migrate. Member ids used by bot tokens match `^[a-z0-9-]{1,32}$`. Roles allowed by the schema are `admin`, `pm`, `po`, `lead`, `dev`, `qa`, `design`, `content`, `seo`, `sales`, `social`, and `data`. `is_admin = 1` grants admin authority even when `role` is something else.

```bash
NOW=$(node -e 'console.log(Date.now())')
npx wrangler d1 execute status-hub --remote --command \
  "INSERT INTO members (id, name, role, is_admin, created_at) VALUES ('admin', 'Board admin', 'admin', 1, $NOW)"
pnpm run token admin
```

`pnpm run token` runs `node scripts/gen-token.mjs`. Use `run`. Plain `pnpm token` is a different command and does not mint a Status Hub token. The script prints the raw token on stdout and, on stderr, a `wrangler d1 execute` statement that stores the SHA-256 in `members.token_hash`. Run that statement. A later hash replaces the previous one. There is one hash column per member.

Revoke from an admin bot with `set_token_hash` and `"sha256": null`, or set `token_hash` to `NULL` in SQL. Never send the raw token to `set_token_hash`.
