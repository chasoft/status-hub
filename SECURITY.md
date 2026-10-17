# Security

Status Hub is maintained by Chasoft Labs. The current release is 0.1.0.

## Reporting

Report a vulnerability through the repository's private security advisories:

[https://github.com/chasoft/status-hub/security/advisories/new](https://github.com/chasoft/status-hub/security/advisories/new)

Include the version, the hostname type (UI or MCP), and enough detail to reproduce the issue. Do not include a raw bot token, a live Access JWT, or a production database id. A public issue is the wrong place for an authentication bypass or a leaked credential.

## Deployment model

Two hostnames are meant to be reachable.

| Hostname | Who calls it | Check |
|---|---|---|
| `UI_HOST` | Browsers | Cloudflare Access in front of the hostname, then the Worker verifies `Cf-Access-Jwt-Assertion` again. |
| `MCP_HOST` | Bots | `POST /mcp` with `Authorization: Bearer <token>`. Leave this hostname off Access. |

`workers_dev` and `preview_urls` are false. The fetch handler returns 403 for every other hostname, including a `workers.dev` host and a preview URL. The MCP host returns 404 for every path other than `/mcp`.

An empty `ACCESS_AUD` denies every UI request. Keep that default until the Access application exists, then set `ACCESS_AUD` to that application's AUD tag and `ACCESS_TEAM_DOMAIN` to the team domain without a scheme.

## Access JWT

The UI check requires all of the following:

- Header `Cf-Access-Jwt-Assertion` with three segments.
- Algorithm `RS256`, and a matching key from `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`. Keys are cached for one hour.
- A valid signature, an `exp` in the future, and `nbf` no more than 60 seconds ahead.
- `aud` containing `ACCESS_AUD`.
- `iss` equal to `https://<ACCESS_TEAM_DOMAIN>`.
- An `email` that appears in `UI_ALLOWED_EMAILS`.

The Access policy and this check both have to pass. The email is lowercased. Role and admin rights then come from the `members` row, not from the JWT.

## Bot tokens

Format: `shk_<memberId>_<secret>`.

- `memberId` matches `^[a-z0-9-]{1,32}$` and is only a lookup key.
- The secret is at least 32 characters from `[A-Za-z0-9_-]`. `scripts/gen-token.mjs` uses 32 random bytes, base64url-encoded.
- D1 stores hex SHA-256 of the whole token in `members.token_hash`. The compare uses `crypto.subtle.timingSafeEqual`.
- A missing hash or a bad token returns HTTP 401 and `{ "error": "unauthorized" }` with `WWW-Authenticate: Bearer realm="status-hub"`.
- One hash per member. Storing a new hash replaces the old token. `set_token_hash` with `sha256: null` revokes it. That tool is admin-only and accepts the hash, never the raw token.
- Mint tokens with `pnpm run token <member-id>` (`node scripts/gen-token.mjs`). Stdout is the secret. Stderr is the command that writes the hash. Deliver the raw token through a secret channel. Do not put it in chat, shell history you keep, the repository, or a prompt log.
- The members page shows whether a hash is present. It does not show the hash.

## UI writes

HTML responses send:

- `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
- `x-content-type-options: nosniff`
- `referrer-policy: no-referrer`
- `cache-control: no-store`

Form posts are accepted when `Sec-Fetch-Site` is `same-origin`. If that header is absent, a missing `Origin` is accepted, and any other `Origin` must have host `UI_HOST`. The origin value `null` is rejected. Leadership feedback stores the display name from `LEADERSHIP_AUTHORS` for the verified email. The form cannot choose a different author.

The create-task form records the first active `is_admin` member as the creator. It does not trust a member id typed into the page as the caller.

## Data to keep out of git

- Raw bot tokens and `members.token_hash` values from production.
- Cloudflare API tokens and account ids.
- A real D1 `database_id`. The ids in `wrangler.jsonc` are placeholders.
- `.dev.vars` and other local secret files. `.dev.vars*` is gitignored.

CI runs gitleaks on the tree. `database_id` placeholders and the example emails in `wrangler.jsonc` are intentional.

## Cron and logs

The scheduled handler writes a JSON log line with the open alert counts. Observability logs and traces are enabled in `wrangler.jsonc`. Tool failures log `tool_error` plus the error text. Do not log raw tokens or Access JWTs from a fork of this Worker.
