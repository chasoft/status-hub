# Workflow

A task is one row in D1. Status changes, notes, blockers, and approvals are rows in the history. Identity always comes from the bearer token or the verified UI email, never from a tool argument or a form field that names the caller. In `AUTH_MODE=access` that email is the Cloudflare Access JWT. In `AUTH_MODE=token` it is the email stored with the login token and carried by the signed session cookie. Both modes check `UI_ALLOWED_EMAILS`, then map the email with `UI_MEMBER_EMAILS`.

Codes, alert thresholds, and environment variables are in [configuration](configuration.md). Tool arguments are in [MCP](mcp.md).

## Codes

| Level | Who allocates it | Format | Example |
|---|---|---|---|
| Project | Admin, in `create_project` | `^[A-Z]{2,5}$` | `APP` |
| Module | Admin. `create_project` also inserts `<PROJECT>-CORE` | `^[A-Z]{2,5}-[A-Z]{2,6}$` | `APP-CORE` |
| Feature | A leader, in `create_feature` | `PRJ-MOD-` plus a number of at least three digits | `APP-CORE-001` |
| Task | Any member, in `create_task` or the UI form | feature code, a dot, then a number | `APP-CORE-001.1` |

The first feature in a module is `001`. The first task on a feature is `.1`. The counter increment and the insert run in one `db.batch()`.

## Statuses

| Status | Meaning |
|---|---|
| `pending_approval` | Waiting for an admin to approve or reject the request. |
| `backlog` | Accepted. An assignee may already be set. The status stays `backlog` until someone reports `assigned`. |
| `assigned` | Handed to the assignee. The not-started clock runs from `assigned_at`. |
| `in_progress` | Someone is actively working the task. |
| `review` | Waiting on the reviewer. |
| `blocked` | Waiting on a person named by an open blocker. |
| `done` | Finished. Terminal. |
| `cancelled` | Closed without shipping. Terminal. |

`done` and `cancelled` have no outgoing status transitions.

## Allowed transitions

`report_status` may make these moves. `blocked` is not one of them.

| From | Allowed `report_status` targets |
|---|---|
| `pending_approval` | `backlog`, `assigned`, `cancelled` |
| `backlog` | `assigned`, `pending_approval`, `cancelled` |
| `assigned` | `in_progress`, `pending_approval`, `cancelled` |
| `in_progress` | `review`, `assigned`, `cancelled` |
| `review` | `done`, `in_progress`, `cancelled` |
| `blocked` | `pending_approval`, `cancelled` |
| `done` | none |
| `cancelled` | none |

`set_blocker` and `resolve_blocker` move tasks as well:

| From | To | Call |
|---|---|---|
| `assigned` or `in_progress` | `blocked` | `set_blocker` |
| `blocked` | `blocked` | `set_blocker` adds another blocker and keeps the current status period |
| `blocked` | `in_progress` | `resolve_blocker` when no other blocker is still open. This lands on `in_progress` even when the task was `assigned` before the blocker. |
| `blocked` | `blocked` | `resolve_blocker` when another blocker is still open |

`report_status` with `status: "blocked"` is rejected. Use `set_blocker`.

A task in `backlog`, `review`, `pending_approval`, `done`, or `cancelled` cannot take a blocker. Leave `review` for `in_progress` first if the work has to stop for a dependency.

## Rules

**`in_progress` only while the task is actively worked.** When the bot or the person stops, `report_status` back to `assigned`. The server does not move it back on its own. A task left `in_progress` with no update raises `STALE` after the configured working-time threshold (seeded as four hours, 08:00 inclusive to 22:00 exclusive, UTC until you set an offset). `add_note` records progress without a status change and clears `STALE`. Call `report_status` when the status changes, not on a timer.

**`review` needs a reviewer.** `report_status` to `review` requires `reviewer` (an active member id) when `reviewer_id` is still empty. A later move may omit `reviewer` and keep the current one. Passing `reviewer` sets it. There is no direct move from `in_progress` to `done`. The path is `in_progress` → `review` → `done`.

**`done` needs a note.** The note is the result. The first link containing `/pull/` followed by digits is written into `pr_url` on that status change.

**Leaving `pending_approval` is admin-only.** Approval is `report_status` to `backlog` or `assigned`. Rejection is `report_status` to `cancelled` and needs a note. Both require `approved_by`, and that id must be a configured owner or approver. A leader who is not an admin cannot approve or reject.

**Entering `pending_approval` on an existing task is for a `pm` or an admin.** The source status must be `backlog`, `assigned`, or `blocked`. A `po` or `lead` who is not an admin is rejected. From `blocked`, open blockers of kind `need_approval` are closed on the way in. Any other open blocker kind rejects the move, and those blockers stay open.

**An assignee does not change status.** `assign_task` and the `assignee` field on create only store `assignee_id`. Reassigning a task that is already `assigned` resets the not-started clock. `assign_task` rejects `pending_approval` (approve first), and rejects `done` and `cancelled`.

**Create stays in `pending_approval` unless an admin sends a complete request.** A complete request has all three of `requested_by`, `requested_at` (epoch milliseconds), and `request_link` (`http` or `https`). `requested_by` must be a configured owner id, a configured approver id, or an active member whose role is `pm`. If any of the three is missing, the task is `pending_approval` and the requested status is ignored. When all three are present, a caller who is not an admin still lands in `pending_approval`. An admin defaults to `backlog`, or may pass `pending_approval`, `backlog`, or `assigned`. Setting an assignee does not select `assigned` by itself.

**Blockers name a kind and a person.** `kind` is `need_info`, `dependency`, `access`, or `bug`. `need_approval` is rejected. Waiting for approval is the `pending_approval` status. `waiting_on` is an existing member id or a configured owner or approver id. `detail` is required, up to 500 characters.

**`pr_url` and `links` are `http` or `https` only.** At most 10 links, each at most 500 characters. `update_task` edits them without changing status. An empty `pr_url` clears it. Omitting `pr_url` leaves it, unless `links` contains a `/pull/<digits>` URL, which is then stored.

**Terminal states stay terminal.** `done` and `cancelled` accept no further `report_status` move.

## Who can do what

Group is derived from the member row on the bot token or, for a UI write, from the email on the verified UI session (`AUTH_MODE=access` or `AUTH_MODE=token`).

| Group | Who | What they can change |
|---|---|---|
| Admin | `is_admin = 1` or role `admin` | Everything a leader can do, plus `create_project`, `create_module`, `set_token_hash`, and leaving `pending_approval`. |
| Leader | Role `pm`, `po`, `lead`, or admin | `create_feature`, `assign_task`, `list_alerts`, and status, notes, blockers, and link edits on tasks assigned to someone else. |
| `pm` or admin | Role `pm`, or admin | Moving an existing task into `pending_approval`. Other leaders cannot. |
| Assignee | `assignee_id` is the caller | `report_status`, `add_note`, `set_blocker`, `resolve_blocker`, and `update_task` on that task. |
| Any member | Any active bot or mapped UI member | `create_task`, `whoami`, `list_my_tasks`, `get_task`, `get_task_timeline`, `get_project_overview`. |

A reviewer is not granted `report_status` by `reviewer_id` alone. The reviewer needs to be the assignee or a leader. `list_my_tasks` with `role: "reviewer"` or `role: "any"` lists tasks where the caller is the reviewer.

`get_task` marks leadership feedback read when the caller is the current assignee. A later assignee sees the same notes as unread again.

## Alerts

The cron runs every five minutes and is safe to run twice. At most one open alert exists per task and rule.

| Rule | Condition |
|---|---|
| `NOT_STARTED` | Status is `assigned` and `assigned_at` is at least `not_started_minutes` ago (default 15). |
| `STALE` | Status is `in_progress` and working time since `last_update_at` is at least `stale_hours` (default 4). Working time is 08:00 inclusive to 22:00 exclusive in the configured offset. |
| `BLOCKED_LONG` | Status is `blocked` and an open blocker was opened at least `blocked_hours` ago (default 2), by the wall clock. |
| `OVERDUE` | `due_at` is in the past and the status is not `done`, `cancelled`, or `pending_approval`. |

An alert clears when its condition no longer holds. `add_note` and `report_status` clear `STALE` for that task. Reassigning an `assigned` task clears `NOT_STARTED`.

Thresholds and the timezone are in [configuration](configuration.md).

## Board

The board at `/` is a viewport dashboard. Columns are statuses from `pending_approval` through `done`. Rows are projects. The left sidebar lists projects with open-task counts and alert badges, including an All projects entry. `?project=CODE` shows that project's swimlane. All projects shows every swimlane. With more than three projects those lanes start collapsed and show a count in each status. The browser remembers the selected project and which lanes are open. Query parameters `member`, `status`, and `q` still filter the cards. Cancelled tasks sit in a list under the grid. The Done column shows the 10 newest matching tasks. `/done` lists every matching done task and keeps the project and member filters.

A click on a card opens the task in a drawer. `/t/:code` is still the full page, including when JavaScript is off. The task has four tabs: Overview, Timeline, History, and Blockers. `?tab=` deep-links a tab. Feedback notes are on Overview, and the composer stays at the bottom of that tab. A pencil swaps an editable value for an input; check saves and x cancels. `/new` is still the create-task page. The board also offers that form in a dialog, filters and alert summaries in popovers, and a project switcher. Links to another site open in a new tab.

`/new` creates a task through the same rules as `create_task`. The form has no member id of its own. The recorded creator is the first active member with `is_admin = 1`, ordered by id. If that member does not exist, the form returns an error.

In `token` mode a browser without a session is sent to `/login`, and the header includes Log out. In `access` mode there is no login page. The Worker expects the Access JWT. Writes from either session use the mapped member, not a name typed into the form.

`/t/:code` shows the request fields, reviewer, pull-request URL, links, due date, time in each status, blockers, feedback, and history, split across the four tabs. A mapped member (see `UI_MEMBER_EMAILS` in [configuration](configuration.md)) who is the assignee or a leader can edit the PR URL, links, reviewer, and due date in place. A leader can also edit the assignee and a feature's priority. A session listed in `LEADERSHIP_AUTHORS` can post feedback. The stored author is the configured display name. Feedback is not an MCP tool. Bots read it from `get_task` and see `unread_feedback_count` on `list_my_tasks`.

`GET /api/board` returns the same filtered cards as JSON. The signed-in page polls it every 60 seconds and updates the board in place. Timestamps are stored as epoch milliseconds UTC and shown as day/month and hour:minute in the configured offset.
