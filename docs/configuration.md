# Configuration

Status Hub reads deployment settings from Worker environment variables. The active config is deployment-wide: every request in an isolate sees the same values. Request data cannot change them.

Committed defaults live in [wrangler.jsonc](../wrangler.jsonc). Replace the `example.com` placeholders, the Access application values, and the D1 `database_id` before you deploy. Do not commit a real account id, API token, or bot token.

UI authentication is `AUTH_MODE`, described in [UI authentication](#ui-authentication). MCP always requires a bearer token. See [Security](../SECURITY.md).

## Variables

| Variable | Default in `wrangler.jsonc` | When unset in code | Purpose |
|---|---|---|---|
| `ENVIRONMENT` | `production` | The test suite sets `test`. Any other value uses the live Access certificate endpoint. | Selects production behaviour. `staging` is set on the staging Worker. |
| `UI_HOST` | `status.example.com` | Required. Routing compares the request hostname to this value. | Hostname of the Kanban UI. Must match the UI custom domain. |
| `MCP_HOST` | `mcp.example.com` | Required. Routing compares the request hostname to this value. | Hostname of the MCP server. Must match the MCP custom domain. Only `/mcp` is served. |
| `ORG_NAME` | `Status Hub` | `Status Hub` | Text in the UI header. A blank value uses `Status Hub`. |
| `MCP_SERVER_NAME` | `status-hub` | `status-hub` | Name advertised to MCP clients. A blank value uses `status-hub`. |
| `AUTH_MODE` | `access` | `access`. A blank value is the same as `access`. | `access` verifies the Cloudflare Access JWT. `token` serves `/login`. Any other value, including `magic-link`, denies the UI. |
| `AUTH_SESSION_TTL_SECONDS` | `43200` | `43200` (12 hours). A non-numeric or non-positive value also uses `43200`. Values above `2592000` are capped at 30 days. | Session lifetime in seconds when `AUTH_MODE=token`. Ignored for `access`. |
| `AUTH_SESSION_SECRET` | not set in `wrangler.jsonc` | Token-mode login returns 500. `access` ignores it. A value shorter than 16 characters is treated as unset. | HMAC key for the session cookie. Set with `wrangler secret put AUTH_SESSION_SECRET`. Do not commit it. |
| `ACCESS_TEAM_DOMAIN` | `your-team.cloudflareaccess.com` | In `access` mode the UI is denied, except in the test suite. Ignored when `AUTH_MODE=token`. | Access team domain, without `https://`. Used only for `AUTH_MODE=access`. The JWT `iss` must be `https://` plus this domain. |
| `ACCESS_AUD` | empty | In `access` mode every UI request is denied. Ignored when `AUTH_MODE=token`. | Access application AUD tag for the UI hostname. Used only for `AUTH_MODE=access`. |
| `UI_ALLOWED_EMAILS` | `you@example.com` | No email is allowed, so the UI is denied in both modes. | Comma-separated emails allowed to open the UI. Checked on the Access JWT and on the login token's email. |
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

`UI_MEMBER_EMAILS` wins over the local-part rule. For `person@example.com` with no pair, the Worker looks up member id `person` when that id matches `^[a-z0-9-]{1,32}$`. The same rule applies to an Access email and to a token-mode session email.

## UI authentication

`AUTH_MODE` chooses how a browser signs in. It does not change `/mcp`.

| Mode | What the browser does |
|---|---|
| `access` | Sends `Cf-Access-Jwt-Assertion`. The Worker checks the signature, audience, issuer, expiry, and `UI_ALLOWED_EMAILS`. This is the committed default. |
| `token` | Opens `/login` and submits a login token. D1 stores only the SHA-256. A signed session cookie identifies later requests. |
| `magic-link` | Not available. The Worker returns 403. A magic link has to be emailed, and this Worker does not include an email provider. |
| anything else | 403, with the text `unknown AUTH_MODE`. |

`access` and `token` both lowercase the email, require it in `UI_ALLOWED_EMAILS`, then map it with `UI_MEMBER_EMAILS` (or the local-part rule) and `LEADERSHIP_AUTHORS`. An Access JWT is not accepted when the mode is `token`. A login token is not accepted when the mode is `access`.

### Session cookie

`POST /login` sets `sh_session` when the token matches a live row. The cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/`. `Max-Age` is `AUTH_SESSION_TTL_SECONDS`. The value is a session id and an expiry, signed with HMAC-SHA256 and `AUTH_SESSION_SECRET`. The email is stored on the `ui_sessions` row, not in the cookie. Each request checks the signature, that row, both expiries, and the allowlist again.

A browser GET without a session redirects to `/login`. Login and logout are POST and use the same `Sec-Fetch-Site` rule as the other UI forms. `POST /logout` sets `revoked_at` on that session and clears the cookie. The header in `token` mode includes Log out. `GET /logout` is 405.

`next` after login must be a same-site path. A value such as `https://evil.example` or `//evil.example` is ignored and the browser is sent to `/`.

### Create a login token

Apply migrations first so `ui_login_tokens` and `ui_sessions` exist (`pnpm db:migrate:remote` or the staging command). Put the email in `UI_ALLOWED_EMAILS`. Set the session secret, then mint the token on your machine:

```bash
npx wrangler secret put AUTH_SESSION_SECRET
pnpm run ui-login you@example.com
```

`pnpm run ui-login` runs `node scripts/gen-ui-login.mjs`. Use `run`. Plain `pnpm ui-login` is a different command. Stdout is the raw token: `shu_` plus 32 random bytes, base64url-encoded. Stderr is a `wrangler d1 execute` statement that inserts the id, the hex SHA-256, the lowercased email, and `created_at`. The SQL does not contain the raw token. Run that statement. Deliver the raw token as a secret. Do not commit it.

A second run inserts another row for the same email. Both tokens work until revoked or expired. The script leaves `expires_at` NULL, which means the login token does not expire. Set `expires_at` to epoch milliseconds if you want a deadline. That deadline blocks new sessions only. A session that already exists keeps the expiry it was given at login, until logout revokes it.

Staging:

```bash
npx wrangler secret put AUTH_SESSION_SECRET --env staging
pnpm run ui-login you@example.com staging
```

Revoke a login token so it cannot open new sessions. Use the current epoch milliseconds:

```sql
UPDATE ui_login_tokens SET revoked_at = 1710000000000 WHERE email = 'you@example.com' AND revoked_at IS NULL;
```

Sessions already issued for that email stay valid until they expire or the person logs out. End them immediately with:

```sql
UPDATE ui_sessions SET revoked_at = 1710000000000 WHERE email = 'you@example.com' AND revoked_at IS NULL;
```

## Staging

`env.staging` is a separate Worker named `status-hub-staging`. It does not inherit production vars.

| Variable | Staging default |
|---|---|
| `ENVIRONMENT` | `staging` |
| `UI_HOST` | `status-staging.example.com` |
| `MCP_HOST` | `mcp-staging.example.com` |
| `ORG_NAME` | `Status Hub` |
| `MCP_SERVER_NAME` | `status-hub` |
| `AUTH_MODE` | `access` |
| `AUTH_SESSION_TTL_SECONDS` | `43200` |
| `ACCESS_TEAM_DOMAIN` | `your-team.cloudflareaccess.com` |
| `ACCESS_AUD` | empty |
| `UI_ALLOWED_EMAILS` | `you@example.com` |
| `OWNER_IDS` | empty |
| `APPROVER_IDS` | empty |
| `UI_MEMBER_EMAILS` | `you@example.com=admin` |
| `LEADERSHIP_AUTHORS` | `you@example.com=Owner` |

The alert variables are unset in staging as well, so staging uses its own `settings` table after migrations. `AUTH_SESSION_SECRET` is not a var. Set it with `wrangler secret put AUTH_SESSION_SECRET --env staging` when staging uses `AUTH_MODE=token`. Custom domains, `workers_dev: false`, `preview_urls: false`, and the `*/5 * * * *` cron are set again on the staging env.

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
| `0008_ui_login.sql` | `ui_login_tokens` (SHA-256 of a UI login token) and `ui_sessions` (rows behind the session cookie). |

Do not rename `0001` through `0008`. Add a new schema change as the next number, `0009` or later, and make it additive.

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

A bot token is not a UI login token. Bot tokens start with `shk_` and live in `members.token_hash`. UI login tokens start with `shu_` and live in `ui_login_tokens`. Mint those with `pnpm run ui-login <email>`, described under [UI authentication](#ui-authentication).
