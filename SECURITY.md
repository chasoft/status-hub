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
| `UI_HOST` | Browsers | `AUTH_MODE=access`: Cloudflare Access in front of the hostname, then the Worker verifies `Cf-Access-Jwt-Assertion` again. `AUTH_MODE=token`: a login token checked against a SHA-256 in D1, then a signed session cookie. |
| `MCP_HOST` | Bots | `POST /mcp` with `Authorization: Bearer <token>`. Leave this hostname off Access. `AUTH_MODE` does not apply. |

`workers_dev` and `preview_urls` are false. The fetch handler returns 403 for every other hostname, including a `workers.dev` host and a preview URL. The MCP host returns 404 for every path other than `/mcp` and `POST /attachment-uploads/:token`. That upload path uses the same bearer token as `/mcp`. The token is one-time, expires in 15 minutes, and the author must be the caller. It does not make the bucket public.

An empty `ACCESS_AUD` denies every UI request when `AUTH_MODE=access`. Keep that default until the Access application exists, then set `ACCESS_AUD` to that application's AUD tag and `ACCESS_TEAM_DOMAIN` to the team domain without a scheme. `AUTH_MODE=token` does not read `ACCESS_AUD`.

## Access JWT

When `AUTH_MODE` is `access` (the default), the UI check requires all of the following:

- Header `Cf-Access-Jwt-Assertion` with three segments.
- Algorithm `RS256`, and a matching key from `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`. Keys are cached for one hour.
- A valid signature, an `exp` in the future, and `nbf` no more than 60 seconds ahead.
- `aud` containing `ACCESS_AUD`.
- `iss` equal to `https://<ACCESS_TEAM_DOMAIN>`.
- An `email` that appears in `UI_ALLOWED_EMAILS`.

The Access policy and this check both have to pass. The email is lowercased. Role and admin rights then come from the `members` row, not from the JWT. `AUTH_MODE=token` does not accept this JWT.

## Login tokens

When `AUTH_MODE` is `token`, the UI uses a login token instead of Access.

- Format `shu_` plus 43 to 128 characters from `[A-Za-z0-9_-]`. `scripts/gen-ui-login.mjs` uses 32 random bytes, base64url-encoded.
- D1 stores hex SHA-256 in `ui_login_tokens.token_hash`, plus the email. The raw token is not stored. The compare uses `crypto.subtle.timingSafeEqual`.
- The email must be in `UI_ALLOWED_EMAILS`. A revoked row (`revoked_at`) or an `expires_at` in the past cannot open a session.
- `AUTH_SESSION_SECRET` (at least 16 characters) signs cookie `sh_session` with HMAC-SHA256. The cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/`. A missing or short secret makes login return 500 and sets no cookie.
- `ui_sessions` stores the email and expiry. `POST /logout` sets `revoked_at`. Replaying the cookie after logout fails. Login and logout use the same `Sec-Fetch-Site` rule as other UI form posts.
- `pnpm run setup -- --auth-mode token` generates `AUTH_SESSION_SECRET`, uploads it with `wrangler secret put` (the value is not printed), and prints the first admin UI login token once on stdout. It does not write either value to disk. Further tokens use `pnpm run ui-login <email>`. For that command, stdout is the token and stderr is the SQL that writes the hash. Deliver the raw token through a secret channel. Do not put it in the repository, and do not log the raw token, the cookie, or `AUTH_SESSION_SECRET`.

`magic-link` is rejected. Sending a link needs an email provider, which this Worker does not include.

## Bot tokens

Format: `shk_<memberId>_<secret>`.

- `memberId` matches `^[a-z0-9-]{1,32}$` and is only a lookup key.
- The secret is at least 32 characters from `[A-Za-z0-9_-]`. `scripts/gen-token.mjs` uses 32 random bytes, base64url-encoded.
- D1 stores hex SHA-256 of the whole token in `members.token_hash`. The compare uses `crypto.subtle.timingSafeEqual`.
- A missing hash or a bad token returns HTTP 401 and `{ "error": "unauthorized" }` with `WWW-Authenticate: Bearer realm="status-hub"`.
- One hash per member. Storing a new hash replaces the old token. `set_token_hash` with `sha256: null` revokes it. That tool is admin-only and accepts the hash, never the raw token.
- `pnpm run setup` prints the first admin token once on stdout and stores only the SHA-256. It does not write the raw token to disk. Further tokens use `pnpm run token <member-id>` (`node scripts/gen-token.mjs`). Stdout is the secret. Stderr is the command that writes the hash. Deliver the raw token through a secret channel. Do not put it in chat, shell history you keep, the repository, or a prompt log.
- The members page shows whether a hash is present. It does not show the hash.

## UI writes

HTML responses send:

- `content-security-policy: default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
- `img-src` allows same-origin attachment thumbnails and `https:` images referenced in request markdown. Those images are thumbnails; a click opens them in a dialog. `javascript:` image URLs are not rendered.
- The dashboard script is `/assets/dashboard.js` on the UI host. Pages do not use inline event handlers. `connect-src 'self'` allows the board poll.
- `x-content-type-options: nosniff`
- `referrer-policy: no-referrer`
- `cache-control: no-store`

Form posts are accepted when `Sec-Fetch-Site` is `same-origin`. If that header is absent, a missing `Origin` is accepted, and any other `Origin` must have host `UI_HOST`. The origin value `null` is rejected. Leadership feedback stores the display name from `LEADERSHIP_AUTHORS` for the verified email. The form cannot choose a different author.

The create-task form records the first active `is_admin` member as the creator. It does not trust a member id typed into the page as the caller.

## Request markdown

The request document is stored as text. The page renders it with a sanitizer that escapes raw HTML, so a `<script>` or an event handler is text. Links are `http` or `https` only. A `javascript:` URL is dropped and the label is kept. Rendered links use `target="_blank"` and `rel="noopener noreferrer"`. The editor preview is a same-origin POST that returns that same HTML.

## Linked agent

`set_agent` accepts an https URL only. The task page renders that URL with `target="_blank"` and `rel="noopener noreferrer"`. `CURSOR_API_KEY`, when set, is a Worker secret. The page calls `GET https://api.cursor.com/v0/agents/{id}` with the key as the Basic username and does not follow redirects. The response read is capped at 64 KB and the call times out after 6 seconds. A failure is cached for 30 seconds and the page shows the status already stored on the task. The key is not placed in HTML, logs, or the MCP response.

## Attachments

File bytes live in an optional R2 bucket bound as `ATTACHMENTS`. The binding is commented out in `wrangler.jsonc`. The bucket is not a public bucket and has no public custom domain. Downloads are `GET /t/:code/attachments/:id` on `UI_HOST` after the same UI sign-in as the board. The MCP host does not serve those bytes. A download sets `Content-Disposition` (`inline` for png, jpeg, gif, and webp; `attachment` otherwise), `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, and `Content-Security-Policy: default-src 'none'; sandbox`.

Each upload inserts a new version and a new R2 key. Keys are not overwritten. The size limit defaults to 10 MiB and is capped at 25 MiB. The MIME allowlist rejects types that are not listed. Declared images must match their magic bytes. `add_attachment` with `source_url` fetches only public `http` or `https` URLs. Hosts that are loopback, `.local`, link-local, or private (including cloud metadata addresses) are rejected, and redirects are checked the same way.

## Data to keep out of git

- Raw bot tokens, raw UI login tokens, and production hash values from `members.token_hash` or `ui_login_tokens`.
- `AUTH_SESSION_SECRET`. Set it with `wrangler secret put`, not in `wrangler.jsonc`.
- `CURSOR_API_KEY`. Set it with `wrangler secret put`, not in `wrangler.jsonc`. The task page uses it only for a server-side request to `api.cursor.com`. The HTML does not include the key.
- Cloudflare API tokens and account ids.
- A real D1 `database_id`. The ids in `wrangler.jsonc` are placeholders. `pnpm run setup` writes real ids to gitignored `wrangler.local.jsonc`.
- `.dev.vars` and other local secret files. `.dev.vars*` is gitignored.

CI runs gitleaks on the tree. `database_id` placeholders and the example emails in `wrangler.jsonc` are intentional.

## Cron and logs

The scheduled handler writes a JSON log line with the open alert counts. Observability logs and traces are enabled in `wrangler.jsonc`. Tool failures log `tool_error` plus the error text. Do not log raw tokens or Access JWTs from a fork of this Worker.
