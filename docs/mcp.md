# MCP

Bots report status to Status Hub over the [Model Context Protocol](https://modelcontextprotocol.io/). Any client that can call an MCP server over streamable HTTP can use this endpoint. The server name is `MCP_SERVER_NAME` (default `status-hub`) and the server version is `0.1.0`.

The caller is always the member on the bearer token. Tool arguments do not select a different caller.

## Endpoint

```text
POST https://<MCP_HOST>/mcp
```

`MCP_HOST` is the MCP custom domain in [wrangler.jsonc](../wrangler.jsonc). The default placeholder is `mcp.example.com`. The UI hostname does not serve MCP. Any other hostname returns 403. On the MCP hostname, `/mcp` and `POST /attachment-uploads/:token` are served. Any other path returns 404. The upload path finishes an `add_attachment` call that used `upload: true`. It still requires the bearer token. It is not a public object URL.

The Worker strips CORS headers (`corsOptions: false` on the MCP handler). Call it from the bot's HTTP client. The `Host` header must be `MCP_HOST`, which is what you get by using that hostname in the URL. Omit `Origin`. A request with `Origin` is accepted only for `localhost`, `127.0.0.1`, and `[::1]`. Any other origin is HTTP 403.

## Authentication

```http
Authorization: Bearer shk_<memberId>_<secret>
```

`pnpm run setup` prints the first admin token. Mint another with `pnpm run token <member-id>` after that member exists. Details, storage, and revocation are in [Security](../SECURITY.md) and [Configuration](configuration.md).

This bearer token is for `/mcp` and for `POST /attachment-uploads/:token`. UI sign-in is `AUTH_MODE` in [Configuration](configuration.md): `access` (Cloudflare Access) or `token` (a login token from `pnpm run ui-login <email>`). A UI login token starts with `shu_` and is stored as a SHA-256 in `ui_login_tokens`. It is not accepted on `/mcp` or on the upload path. A bot token starts with `shk_` and is not a UI login token. `magic-link` is not available, because sending a link needs an email provider.

A missing or invalid token returns HTTP 401:

```json
{ "error": "unauthorized" }
```

The response includes `WWW-Authenticate: Bearer realm="status-hub"`.

## JSON-RPC

The body is [JSON-RPC 2.0](https://www.jsonrpc.org/specification). The tests call `tools/call` directly. A full MCP client should still send `initialize` first. Use protocol version `2025-06-18`, which is the version the tests send.

Headers on every POST:

| Header | Value |
|---|---|
| `content-type` | `application/json` |
| `accept` | `application/json, text/event-stream` |
| `mcp-protocol-version` | `2025-06-18` |
| `authorization` | `Bearer <token>` |

Initialize:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "status-hub-client", "version": "0.1.0" }
  }
}
```

After a successful initialize, a client that follows the MCP lifecycle sends a notification (no `id`):

```json
{ "jsonrpc": "2.0", "method": "notifications/initialized" }
```

A tool call:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "whoami",
    "arguments": {}
  }
}
```

The Worker may answer with a single JSON object or with a server-sent event whose `data:` line is that object. The tool payload is a JSON string on `result.content[0].text`.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      { "type": "text", "text": "{\"id\":\"admin\",\"name\":\"Board admin\",\"role\":\"admin\",\"admin\":true,\"leader\":true,\"open_tasks\":0,\"alerts\":0}" }
    ]
  }
}
```

A rejected tool call is still HTTP 200. `result.isError` is true, and the text is JSON:

```json
{ "error": "FORBIDDEN", "status": 403, "message": "..." }
```

| `error` | `status` | When |
|---|---|---|
| `BAD_REQUEST` | 400 | Invalid argument, or a status move the lifecycle does not allow. |
| `FORBIDDEN` | 403 | The token's member is not allowed to do that. |
| `NOT_FOUND` | 404 | Unknown task, feature, project, member, or blocker. |
| `CONFLICT` | 409 | Duplicate code, closed blocker, or a change on a finished task. |
| `INTERNAL` | 500 | Unexpected failure. The text has no `message`. |

Status names and who may move them are in [workflow](workflow.md).

## Generic client

Point the client at the MCP URL and send the bearer token on every request. The header name is `Authorization`. The value is `Bearer` plus the raw token. Clients differ on the JSON keys around that URL. This shape is the one most streamable-HTTP clients accept:

```json
{
  "mcpServers": {
    "status-hub": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer shk_<member-id>_<secret>"
      }
    }
  }
}
```

Replace the host with `MCP_HOST`. Keep the token in the client's secret store. If your client uses a different key for remote HTTP (`url`, `serverUrl`, or `httpUrl`), the URL and the `Authorization` header are the parts that have to match this server.

Stdio transports do not speak to this Worker. The bot needs an HTTP MCP client.

## curl

```bash
export STATUS_HUB_TOKEN='shk_<member-id>_<secret>'
export MCP_URL='https://mcp.example.com/mcp'

curl -sS "$MCP_URL" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  -H "authorization: Bearer $STATUS_HUB_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
```

If the response is an event stream, the JSON-RPC message is the line that starts with `data:`.

The examples below are the `tools/call` body. Send them with the same headers. Codes use the `APP` project from the [README](../README.md). Timestamps are epoch milliseconds UTC.

## Tools

### whoami

Bot id, role, and whether the member is an admin or a leader. `open_tasks` counts tasks in `assigned`, `in_progress`, `review`, or `blocked` where this member is the assignee. `alerts` counts open alerts on tasks assigned to this member.

Any authenticated member. No arguments.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": { "name": "whoami", "arguments": {} }
}
```

Result fields: `id`, `name`, `role`, `admin`, `leader`, `open_tasks`, `alerts`.

### list_my_tasks

Tasks for the caller, plus open alerts. Each task includes `role` (`assignee`, `reviewer`, or `both`), `in_status`, `unread_feedback_count`, `agent_url`, `agent_status`, and `agent_updated_at` (epoch milliseconds, or null).

A task the caller is assigned to, with unread leadership feedback, is included even when its status is outside the filter. That covers `pending_approval`, `backlog`, and any other status you did not ask for.

| Argument | Required | Rule |
|---|---|---|
| `status` | no | One status, or an array of statuses. Omitted means `assigned`, `in_progress`, `review`, and `blocked`. Unread feedback for the assignee is still returned. |
| `role` | no | `assignee` (default), `reviewer`, or `any`. |
| `limit` | no | Integer 1–200. Default 50. |
| `offset` | no | Integer ≥ 0. Default 0. |

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "list_my_tasks",
    "arguments": {
      "status": ["assigned", "in_progress"],
      "role": "any",
      "limit": 50,
      "offset": 0
    }
  }
}
```

### report_status

Change a task's status and record an update. Call it when the status changes, not on a timer.

The assignee or a leader. The task's reviewer may only move `review` to `done` (pass) or `assigned` (fail) and may not pass `reviewer`. Entering `pending_approval` is `pm` or admin only. Leaving `pending_approval` is admin only.

| Argument | Required | Rule |
|---|---|---|
| `task` | yes | Task code, for example `APP-CORE-001.1`. |
| `status` | yes | `pending_approval`, `backlog`, `assigned`, `in_progress`, `review`, `blocked`, `done`, or `cancelled`. `blocked` is rejected here. |
| `note` | when finishing, failing a review, or rejecting | Up to 500 characters. Required for `done`, for `review` → `assigned` (failed review), and when rejecting `pending_approval` to `cancelled`. |
| `links` | no | Up to 10 `http` or `https` URLs. The first URL containing `/pull/` followed by digits is written into `pr_url`. On a move to `review`, these URLs also count as output links when the task has no Output file and no output link yet. |
| `reviewer` | when moving to `review` with no reviewer yet | Active member id. |
| `approved_by` | when leaving `pending_approval` | Configured owner or approver id. |

A move to `review` requires an Output attachment (the latest version of a file in the Output group) or an output link. A Requirement file does not satisfy this. Links on this call count. The update stores `request_version` (the latest request version, or null) and `output_ref` (`{"attachments":[{"id","name","version"}],"links":[...]}`). The reviewer check runs first.

Move to `assigned` when work stops. `in_progress` is only for the time someone is actually working. See [workflow](workflow.md).

A failed review moves `review` to `assigned` with a note saying what failed. The assignee's webhook gets `task.assigned` with `reason: "review_failed"`, `note`, and `assigned_by`.

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "report_status",
    "arguments": {
      "task": "APP-CORE-001.1",
      "status": "in_progress",
      "note": "Started the API handler."
    }
  }
}
```

Send to review once a reviewer is known:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "report_status",
    "arguments": {
      "task": "APP-CORE-001.1",
      "status": "review",
      "reviewer": "ada",
      "note": "Ready for review.",
      "links": ["https://example.com/acme/app/pull/18"]
    }
  }
}
```

An admin approves a pending task:

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "report_status",
    "arguments": {
      "task": "APP-CORE-001.1",
      "status": "backlog",
      "approved_by": "owner"
    }
  }
}
```

Result fields: `code`, `from`, `to`, `approved_by`, `reviewer_id`, `alerts`.

### add_note

Record progress without changing status. This refreshes `last_update_at` and clears `STALE`.

The assignee, the task's reviewer, or a leader.

| Argument | Required | Rule |
|---|---|---|
| `task` | yes | Task code. |
| `note` | yes | 1–500 characters after trimming. |
| `links` | no | Up to 10 `http` or `https` URLs. |

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "add_note",
    "arguments": {
      "task": "APP-CORE-001.1",
      "note": "Handler compiles. Wiring tests next.",
      "links": ["https://example.com/acme/app/commit/abc"]
    }
  }
}
```

Result fields: `code`, `status`.

### set_agent

Attach or clear the cloud agent working on a task. This does not change the task status.

The assignee, the reviewer, or a leader (`pm`, `po`, `lead`, or admin). Anyone else receives 403.

| Argument | Required | Rule |
|---|---|---|
| `task` | yes | Task code. |
| `agent_url` | one of `agent_url` or `status` | https URL, at most 500 characters. `null` or `""` clears it. Any other scheme is `BAD_REQUEST`. A Cursor cloud agent uses `https://cursor.com/agents/bc-…` so the task page can load live status. |
| `status` | one of `agent_url` or `status` | Status string reported by the bot, at most 64 characters. `null` or `""` clears it. |

Omit a field to leave it unchanged. Call this when the agent is opened, and call it with both fields null when the agent stops.

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "set_agent",
    "arguments": {
      "task": "APP-CORE-001.1",
      "agent_url": "https://cursor.com/agents/bc-11111111-2222-3333-4444-555555555555",
      "status": "RUNNING"
    }
  }
}
```

Result fields: `code`, `agent_url`, `agent_status`, `agent_updated_at`.

### set_blocker

Open a blocker and move the task to `blocked`. Allowed from `assigned`, `in_progress`, or `blocked`.

The assignee or a leader.

| Argument | Required | Rule |
|---|---|---|
| `task` | yes | Task code. |
| `kind` | yes | `need_info`, `dependency`, `access`, or `bug`. `need_approval` is rejected. |
| `waiting_on` | yes | An existing member id, or a configured owner or approver id. At most 32 characters. |
| `detail` | yes | 1–500 characters. |

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "set_blocker",
    "arguments": {
      "task": "APP-CORE-001.1",
      "kind": "need_info",
      "waiting_on": "ada",
      "detail": "Need the expected response body for an empty cart."
    }
  }
}
```

Result fields: `blocker_id`, `code`, `status` (`blocked`).

### resolve_blocker

Close one blocker. When none remain, a `blocked` task moves to `in_progress`, including when it was `assigned` before the blocker. It stays `blocked` when another blocker is open. A task that is not `blocked` (for example a `cancelled` or `done` task with a leftover blocker) keeps its status; only the blocker is closed. When someone other than the assignee resolves it, the assignee's webhook gets `blocker.resolved` (see [Webhooks](configuration.md#webhooks)).

The assignee or a leader.

| Argument | Required | Rule |
|---|---|---|
| `id` | yes | Integer blocker id from `set_blocker` or `get_task`. |
| `note` | no | Up to 500 characters. |

```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "tools/call",
  "params": {
    "name": "resolve_blocker",
    "arguments": { "id": 1, "note": "Response body is documented." }
  }
}
```

Result fields: `code`, `status`.

### get_task

Task detail, the 10 latest updates, blockers, open alerts, leadership feedback, and time in each status. Periods use epoch milliseconds UTC. `task` includes `agent_url`, `agent_status`, and `agent_updated_at`. When the assignee calls this, unread feedback is marked read and the open `LEADERSHIP_FEEDBACK` alert is cleared. The returned `feedback[].unread` is the value from before that write.

Any authenticated member.

| Argument | Required | Rule |
|---|---|---|
| `code` | yes | Task code. |

```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "method": "tools/call",
  "params": {
    "name": "get_task",
    "arguments": { "code": "APP-CORE-001.1" }
  }
}
```

Result fields: `task` (including `reviewer_id`, `agent_url`, `agent_status`, `agent_updated_at`, and the request columns), `request` (latest version, or `version: null` when none exists), `attachments` (`requirement`, `output`, `output_links`), `attachments_configured`, `current_status`, `time_in_status`, `periods`, `updates`, `blockers`, `alerts`, `feedback`.

`request` has `version`, `author_id`, `at`, `note`, and `markdown`. `attachments` lists each file's id, name, version count, latest version, MIME type, and size. `attachments_configured` is false when the R2 binding is absent. Each update and each feedback entry includes `request_version` and `output_ref` (parsed). `output_ref` is null when that row did not record one.

### get_task_timeline

Start, end, and duration of each status period, plus totals per status.

Any authenticated member.

| Argument | Required | Rule |
|---|---|---|
| `code` | yes | Task code. |

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "tools/call",
  "params": {
    "name": "get_task_timeline",
    "arguments": { "code": "APP-CORE-001.1" }
  }
}
```

Result fields: `code`, `status`, `current`, `timeline`, `totals`.

### get_project_overview

Task counts by status, plus open blockers and open alerts for one project.

Any authenticated member.

| Argument | Required | Rule |
|---|---|---|
| `project` | yes | Project code, `^[A-Z]{2,5}$`. |

```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "method": "tools/call",
  "params": {
    "name": "get_project_overview",
    "arguments": { "project": "APP" }
  }
}
```

Result fields: `project`, `tasks_by_status`, `open_blockers`, `open_alerts`.

### list_alerts

Open alerts. Leader only (`pm`, `po`, `lead`, or admin).

| Argument | Required | Rule |
|---|---|---|
| `scope` | no | A project code or a member id. Omit it for every open alert. At most 32 characters. The result is capped at 50. |

```json
{
  "jsonrpc": "2.0",
  "id": 12,
  "method": "tools/call",
  "params": {
    "name": "list_alerts",
    "arguments": { "scope": "APP" }
  }
}
```

Each alert has `task_code`, `rule`, `fired_at`, and `assignee_id`.

### create_feature

Allocate the next feature code on a module (`APP-CORE-001`). Leader only. Priority defaults to `P2`. The owner defaults to the caller.

| Argument | Required | Rule |
|---|---|---|
| `module` | yes | Module code, `^[A-Z]{2,5}-[A-Z]{2,6}$`. |
| `title` | yes | 3–200 characters. |
| `spec_url` | no | Absolute URL. |
| `priority` | no | `P0`, `P1`, `P2`, or `P3`. |
| `owner` | no | Existing member id. At most 32 characters. |
| `due_at` | no | Epoch milliseconds UTC. |

```json
{
  "jsonrpc": "2.0",
  "id": 13,
  "method": "tools/call",
  "params": {
    "name": "create_feature",
    "arguments": {
      "module": "APP-CORE",
      "title": "Public status board",
      "priority": "P1",
      "spec_url": "https://example.com/specs/board"
    }
  }
}
```

Result field: `code`.

### create_task

Allocate the next task code on a feature (`APP-CORE-001.1`). Any member. The status rules are in [workflow](workflow.md). Short version: without a complete request, or when the caller is not an admin, the status is `pending_approval`.

| Argument | Required | Rule |
|---|---|---|
| `feature` | yes | Feature code, `^[A-Z]{2,5}-[A-Z]{2,6}-\d{3,}`. |
| `title` | yes | 3–200 characters. |
| `assignee` | no | Existing member id. Does not change the chosen status. |
| `due_at` | no | Epoch milliseconds UTC. |
| `status` | no | `pending_approval`, `backlog`, or `assigned`. An admin may set this when the request is complete. Default for that admin is `backlog`. |
| `pr_url` | no | `http` or `https`, at most 500 characters. |
| `links` | no | Up to 10 `http` or `https` URLs. A `/pull/<digits>` link fills `pr_url` when `pr_url` is omitted. |
| `requested_by` | for a complete request | Configured owner id, approver id, or an active `pm`. At most 64 characters. |
| `requested_at` | for a complete request | Epoch milliseconds UTC. |
| `request_link` | for a complete request | `http` or `https`, at most 500 characters. |
| `request` | no | Markdown, 1–50000 characters. Stored as request version 1 in the same batch. Bots should include who requested the work, what, why, acceptance criteria, and impacted areas. It does not change the pending-approval rule. |

```json
{
  "jsonrpc": "2.0",
  "id": 14,
  "method": "tools/call",
  "params": {
    "name": "create_task",
    "arguments": {
      "feature": "APP-CORE-001",
      "title": "Render the Kanban columns",
      "assignee": "ada",
      "requested_by": "owner",
      "requested_at": 1760745600000,
      "request_link": "https://example.com/requests/42"
    }
  }
}
```

Result fields: `code`, `status`, `pr_url`, `request_version` (`1` when `request` was sent, otherwise null).

### update_task

Edit `pr_url` and `links` without changing status. The assignee or a leader. At least one of the two arguments is required.

| Argument | Required | Rule |
|---|---|---|
| `task` | yes | Task code. |
| `pr_url` | one of these | `http` or `https`. An empty string clears it. Omit it to leave the column, unless `links` contains a pull link. |
| `links` | one of these | Up to 10 `http` or `https` URLs, each at most 500 characters. |

```json
{
  "jsonrpc": "2.0",
  "id": 15,
  "method": "tools/call",
  "params": {
    "name": "update_task",
    "arguments": {
      "task": "APP-CORE-001.1",
      "pr_url": "https://example.com/acme/app/pull/18"
    }
  }
}
```

Result fields: `code`, `pr_url`.

### assign_task

Change the assignee and keep the status. Leader only. Reassigning a task that is already `assigned` resets the not-started clock. `pending_approval` has to be approved first. `done` and `cancelled` are rejected.

| Argument | Required | Rule |
|---|---|---|
| `task` | yes | Task code. |
| `assignee` | yes | Existing member id. At most 32 characters. |

```json
{
  "jsonrpc": "2.0",
  "id": 16,
  "method": "tools/call",
  "params": {
    "name": "assign_task",
    "arguments": { "task": "APP-CORE-001.1", "assignee": "ada" }
  }
}
```

Result fields: `code`, `status`, `assignee`.

### create_project

Register a project and a Core module (`APP` and `APP-CORE`). Admin only.

| Argument | Required | Rule |
|---|---|---|
| `code` | yes | `^[A-Z]{2,5}$`. |
| `name` | yes | 2–100 characters. |
| `owner` | no | Existing member id. |
| `repo_url` | no | Absolute URL. |

```json
{
  "jsonrpc": "2.0",
  "id": 17,
  "method": "tools/call",
  "params": {
    "name": "create_project",
    "arguments": {
      "code": "APP",
      "name": "Example app",
      "repo_url": "https://example.com/acme/app"
    }
  }
}
```

Result fields: `code`, `modules` (for example `["APP-CORE"]`).

### create_module

Register a module in a project. Admin only. `code` is the module part only. The stored code is `<project>-<code>`.

| Argument | Required | Rule |
|---|---|---|
| `project` | yes | Existing project code. |
| `code` | yes | `^[A-Z]{2,6}$`. |
| `name` | yes | 2–100 characters. |
| `owner` | no | Existing member id. |

```json
{
  "jsonrpc": "2.0",
  "id": 18,
  "method": "tools/call",
  "params": {
    "name": "create_module",
    "arguments": { "project": "APP", "code": "API", "name": "HTTP API" }
  }
}
```

Result field: `code` (`APP-API`).

### set_token_hash

Store the SHA-256 of a new token, or `null` to revoke. Admin only. Never send the raw token.

| Argument | Required | Rule |
|---|---|---|
| `member` | yes | Existing member id. At most 32 characters. |
| `sha256` | yes | 64 lowercase hex characters, or `null`. |

```json
{
  "jsonrpc": "2.0",
  "id": 19,
  "method": "tools/call",
  "params": {
    "name": "set_token_hash",
    "arguments": {
      "member": "ada",
      "sha256": null
    }
  }
}
```

Result fields: `member`, `token` (`set` or `revoked`).

Compute the hash locally and keep the raw token off the wire. `printf` does not add a newline, which matches the hash the Worker stores:

```bash
printf '%s' "$STATUS_HUB_TOKEN" | sha256sum
```

`pnpm run token <member-id>` prints a ready-to-run Wrangler statement for the same hash.

### set_reviewer

Set or change a task's reviewer without changing its status. Admin only. Use it to move a self-reviewed task to another member.

| Argument | Required | Rule |
|---|---|---|
| `task` | yes | Task code. |
| `reviewer` | yes | Active member id. An empty string clears the reviewer. |

Result fields: `code`, `reviewer_id`.

### set_member_webhook

Set or clear a member's outbound webhook. Admin only. See [Webhooks](configuration.md#webhooks) for the events and the request format.

| Argument | Required | Rule |
|---|---|---|
| `member` | yes | Active member id. |
| `url` | no | `https` URL without credentials, up to 500 characters. `null` or `""` removes the webhook, its header, and its secret. |
| `header_name` | no | HTTP header that carries the secret, for example `X-Api-Key`. Omitted keeps it; `""` clears it. Required when a secret is set. |
| `secret` | no | Up to 1024 characters, no control characters. Write-only. Omitted keeps it; `""` clears it. |

Result fields: `member`, `webhook_url`, `header_name`, `secret` (`set` or `none`). The secret itself is never returned.

### list_webhooks

Admin only. No arguments. Returns `webhooks[]` with `member`, `webhook_url`, `header_name`, `secret` (`set` or `none`), `pending`, `failed`, `last_delivered_at`, and `last_error`.

### test_member_webhook

Admin only. Sends one `webhook.test` event to the member's webhook now. It is not retried.

| Argument | Required | Rule |
|---|---|---|
| `member` | yes | Member id with a webhook. |

Result fields: `member`, `delivery_id`, `ok`, `status` (HTTP status or `null`), `error`.

### set_request

Store a new markdown request version. The assignee or a leader. Older versions stay. The caller is the author.

| Argument | Required | Rule |
|---|---|---|
| `task` | yes | Task code. |
| `markdown` | yes | 1–50000 characters after trimming. |
| `note` | no | Change note, up to 500 characters. |

```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "method": "tools/call",
  "params": {
    "name": "set_request",
    "arguments": {
      "task": "APP-CORE-001.1",
      "markdown": "## Who requested\n\nAda\n\n## What\n\nRender the columns.\n\n## Why\n\nThe board is empty.\n\n## Acceptance criteria\n\n- Columns match statuses.\n\n## Impacted areas\n\nOverview.",
      "note": "Filled the template."
    }
  }
}
```

Result fields: `task`, `version`, `author_id`, `at`, `note`, `markdown`.

### get_request

Read one request version. Any authenticated member. Omit `version` for the latest. `versions` lists every version without the markdown body. A task with no request returns `version: null`. A missing version number is 404.

| Argument | Required | Rule |
|---|---|---|
| `task` | yes | Task code. |
| `version` | no | Integer ≥ 1. |

```json
{
  "jsonrpc": "2.0",
  "id": 21,
  "method": "tools/call",
  "params": {
    "name": "get_request",
    "arguments": { "task": "APP-CORE-001.1", "version": 1 }
  }
}
```

Result fields: `task`, `version`, `latest`, `markdown`, `author_id`, `at`, `note`, `versions`.

### add_attachment

Create or version a Requirement or Output file. The assignee or a leader. The same task, group, and name inserts a new version and keeps the previous R2 object. Provide exactly one of `content_base64`, `source_url`, or `upload: true`.

If the `ATTACHMENTS` binding is missing, the tool returns `BAD_REQUEST` with: `Attachments are not configured. Add an R2 bucket binding named ATTACHMENTS. See docs/configuration.md.`

| Argument | Required | Rule |
|---|---|---|
| `task` | yes | Task code. |
| `group` | yes | `requirement` or `output`. |
| `name` | yes | 1–200 characters. No slashes or control characters. |
| `mime` | yes | Allowlisted type. Default list is in [configuration](configuration.md). |
| `note` | no | Up to 500 characters. |
| `content_base64` | one of three | Standard base64 of the file bytes. |
| `source_url` | one of three | Public `http` or `https` URL. The Worker fetches it. Loopback, link-local, and private addresses are rejected. |
| `upload` | one of three | `true`. Returns a one-time path. Does not store bytes yet. |

`upload: true` returns `pending`, `upload_path` (`/attachment-uploads/<token>`), `method` (`POST`), `expires_at` (15 minutes), `task`, `group`, `name`, and `mime`. Finish it with `POST https://<MCP_HOST><upload_path>`, the same bearer token, and the raw bytes as the body (or multipart field `file`). The token is one-time and the author must be the caller. A missing bearer token is HTTP 401.

A stored result omits the R2 key. Fields: `id`, `task`, `group`, `name`, `version`, `mime`, `bytes`, `author_id`, `at`, `note`.

```json
{
  "jsonrpc": "2.0",
  "id": 22,
  "method": "tools/call",
  "params": {
    "name": "add_attachment",
    "arguments": {
      "task": "APP-CORE-001.1",
      "group": "output",
      "name": "board.png",
      "mime": "image/png",
      "content_base64": "<base64>"
    }
  }
}
```

Downloads are `GET /t/<task>/attachments/<id>` on the UI host, with the same sign-in as the board. `?v=` selects an older version. Previews are `GET /t/<task>/attachments/<id>/preview` on that same host. The bucket is not public.

### list_attachments

List Requirement and Output files for a task, newest version first, plus output links. Any authenticated member. Bytes are not included.

| Argument | Required | Rule |
|---|---|---|
| `task` | yes | Task code. |

```json
{
  "jsonrpc": "2.0",
  "id": 23,
  "method": "tools/call",
  "params": {
    "name": "list_attachments",
    "arguments": { "task": "APP-CORE-001.1" }
  }
}
```

Result fields: `task`, `configured`, `requirement`, `output`, `output_links`. Each file has `id`, `name`, `latest`, and `versions`. `configured` is false when R2 is not bound. The lists are still returned.
