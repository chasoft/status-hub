# MCP

Bots report status to Status Hub over the [Model Context Protocol](https://modelcontextprotocol.io/). Any client that can call an MCP server over streamable HTTP can use this endpoint. The server name is `MCP_SERVER_NAME` (default `status-hub`) and the server version is `0.1.0`.

The caller is always the member on the bearer token. Tool arguments do not select a different caller.

## Endpoint

```text
POST https://<MCP_HOST>/mcp
```

`MCP_HOST` is the MCP custom domain in [wrangler.jsonc](../wrangler.jsonc). The default placeholder is `mcp.example.com`. The UI hostname does not serve MCP. Any other hostname returns 403. Any path other than `/mcp` on the MCP hostname returns 404.

The Worker strips CORS headers (`corsOptions: false` on the MCP handler). Call it from the bot's HTTP client. The `Host` header must be `MCP_HOST`, which is what you get by using that hostname in the URL. Omit `Origin`. A request with `Origin` is accepted only for `localhost`, `127.0.0.1`, and `[::1]`. Any other origin is HTTP 403.

## Authentication

```http
Authorization: Bearer shk_<memberId>_<secret>
```

Mint the token with `pnpm run token <member-id>` after that member exists. Details, storage, and revocation are in [Security](../SECURITY.md) and [Configuration](configuration.md).

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

Tasks for the caller, plus open alerts. Each task includes `role` (`assignee`, `reviewer`, or `both`), `in_status`, and `unread_feedback_count`.

| Argument | Required | Rule |
|---|---|---|
| `status` | no | One status, or an array of statuses. Omitted means `assigned`, `in_progress`, `review`, and `blocked`. |
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

The assignee or a leader. Entering `pending_approval` is `pm` or admin only. Leaving `pending_approval` is admin only.

| Argument | Required | Rule |
|---|---|---|
| `task` | yes | Task code, for example `APP-CORE-001.1`. |
| `status` | yes | `pending_approval`, `backlog`, `assigned`, `in_progress`, `review`, `blocked`, `done`, or `cancelled`. `blocked` is rejected here. |
| `note` | when finishing or rejecting | Up to 500 characters. Required for `done`, and required when rejecting `pending_approval` to `cancelled`. |
| `links` | no | Up to 10 `http` or `https` URLs. The first URL containing `/pull/` followed by digits is written into `pr_url`. |
| `reviewer` | when moving to `review` with no reviewer yet | Active member id. |
| `approved_by` | when leaving `pending_approval` | Configured owner or approver id. |

Move to `assigned` when work stops. `in_progress` is only for the time someone is actually working. See [workflow](workflow.md).

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

The assignee or a leader.

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

Close one blocker. When none remain, the task moves to `in_progress`, including when it was `assigned` before the blocker. It stays `blocked` when another blocker is open.

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

Task detail, the 10 latest updates, blockers, open alerts, leadership feedback, and time in each status. Periods use epoch milliseconds UTC. When the assignee calls this, unread feedback is marked read. The returned `feedback[].unread` is the value from before that write.

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

Result fields: `task` (including `reviewer_id` and the request columns), `current_status`, `time_in_status`, `periods`, `updates`, `blockers`, `alerts`, `feedback`.

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

Result fields: `code`, `status`, `pr_url`.

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
