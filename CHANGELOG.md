# Changelog

All notable changes to Status Hub are documented in this file. The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers match [package.json](package.json). The license is MIT. Copyright (c) 2026 Chasoft Labs.

## Unreleased

### Added

- Kanban columns group tasks that share a feature (two or more in that column) in a pale tint with a 1px outline and a colored header accent. Expand groups and Collapse groups remember each group in the browser. A single task stays a plain card.
- Table view on the same board (`?view=table`, or Board | Table). One row per task, grouped by feature, sortable, using the project, member, status, and search filters. A row opens the task drawer. Editable cells use the inline editor; the pencil shows on row hover, keyboard focus, and touch. A pull request shows as `#N` with the full URL on the link. Times use the configured timezone.
- Versioned task request documents. `set_request` and `get_request` append markdown versions (author, time, optional note) and never overwrite. Overview renders the latest version, with a version picker and a diff. `create_task` accepts optional `request` markdown as version 1. HTML is sanitized and links open in a new tab.
- Optional R2 attachments in two groups, Requirement and Output. Each upload of the same name adds a version and keeps the previous object. `add_attachment` takes base64, a public source URL, or a one-time upload path. `list_attachments` and `get_task` summarize them. Downloads use the UI host and the same sign-in as the board. Images are small thumbnails in the file list and in request markdown; opening one shows a lightbox with download, previous and next, a before/after splitter, and a side-by-side view. Without the `ATTACHMENTS` binding the file UI is hidden and `add_attachment` returns a clear error.
- A move to `review` requires an Output attachment or an output link. The status update and later feedback record the request version and the output versions they refer to. Feedback shows that set as `req v2 · name vN`.
- Migrations `0009_request_versions.sql` and `0010_attachments.sql`.
- Dashboard UI: viewport shell, project navigator, collapsible swimlanes, task drawer, create-task dialog, and filter popovers. `GET /api/board` polls the board in place. External links open in a new tab. Task detail uses Overview, Timeline, History, and Blockers (`?tab=`). Feedback stays on Overview with the composer pinned to that tab. Editable values use one inline editor. Buttons, inputs, and badges use a 5px radius.
- `AUTH_MODE=token`: a login page, SHA-256 login tokens in D1 (`ui_login_tokens`), and a signed `HttpOnly` `Secure` `SameSite=Lax` session cookie with logout. `AUTH_MODE=access` is unchanged. `magic-link` is not available.
- `pnpm run ui-login` (`scripts/gen-ui-login.mjs`) mints a UI login token locally and prints the SQL for the hash.
- Migration `0008_ui_login.sql`.
- `pnpm run setup` creates or reuses the D1 database (and optional staging), writes gitignored `wrangler.local.jsonc`, applies migrations, creates the first admin, and prints a one-time MCP token. `pnpm run deploy` deploys that local config. Flags and `STATUS_HUB_*` variables cover the same prompts for CI. With `--auth-mode token`, setup runs `wrangler secret put AUTH_SESSION_SECRET` using a generated value and prints a one-time UI login token for the admin email. Only the SHA-256 is stored.

## 0.1.0 - 2026-10-17

First open-source release. One Cloudflare Worker, one D1 database, an MCP server for bots, and a server-rendered Kanban board for people.

### Added

- Kanban at `/` with a column per status, a row per project, and filters for project, member, and status. The Done column shows the 10 newest tasks and links to `/done`.
- Task pages with request fields, reviewer, blockers, time in status, history, leadership feedback, and a pull-request URL.
- Project, module, feature, and task codes. Feature and task numbers are allocated in one D1 batch.
- Status lifecycle: `pending_approval`, `backlog`, `assigned`, `in_progress`, `review`, `blocked`, `done`, `cancelled`, with the transitions enforced in `src/core.ts`.
- Pending approval. A missing request field, or a caller who is not an admin, creates the task in `pending_approval`. Leaving that status is admin-only and records `approved_by`.
- Reviewer required when a task first moves to `review`.
- Blockers (`need_info`, `dependency`, `access`, `bug`) that move a task to `blocked` until the last one is resolved.
- Leadership feedback from allowlisted UI sessions, with an unread flag for the assignee.
- Alerts `NOT_STARTED`, `STALE`, `BLOCKED_LONG`, and `OVERDUE`, raised by a cron every five minutes. Thresholds live in the `settings` table and can be overridden by env vars.
- MCP tools on `POST /mcp`: `whoami`, `list_my_tasks`, `report_status`, `add_note`, `set_blocker`, `resolve_blocker`, `get_task`, `get_task_timeline`, `get_project_overview`, `list_alerts`, `create_feature`, `create_task`, `update_task`, `assign_task`, `create_project`, `create_module`, `set_token_hash`.
- Bearer tokens of the form `shk_<memberId>_<secret>`. D1 stores the SHA-256. `scripts/gen-token.mjs` mints a token locally.
- UI authentication with a Cloudflare Access JWT, checked again in the Worker, plus `UI_ALLOWED_EMAILS`.
- Hostname lock: only `UI_HOST` and `MCP_HOST` respond. `workers.dev` and preview URLs are disabled.
- Migrations `0001` through `0007`, including a no-op seed file.
- Vitest suite, TypeScript check, and gitleaks in CI.
- Public docs: README, configuration, MCP, workflow, contributing, and this changelog.
