import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getHubConfig } from "./config";
import * as core from "./core";
import type { Member } from "./core";

type Handler = (args: any) => Promise<unknown>;

function wrap(fn: Handler) {
  return async (args: any) => {
    try {
      const out = await fn(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
    } catch (e) {
      if (e instanceof core.AppError) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify({ error: e.code, status: e.httpStatus, message: e.message }) }],
        };
      }
      console.error("tool_error", String(e));
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: "INTERNAL", status: 500 }) }] };
    }
  };
}

const status = z.enum(["pending_approval", "backlog", "assigned", "in_progress", "review", "blocked", "done", "cancelled"]);
const approver = z.string().max(64).describe("Configured owner or approver id. Required when leaving pending_approval.");
const taskCode = z.string().regex(core.TASK_RE).describe("Task code, for example PRJ-MOD-012.3");

/** One server per request; `me` is resolved from the bearer token before this is called. */
export function createServer(db: D1Database, me: Member) {
  const server = new McpServer({ name: getHubConfig().mcpServerName, version: "0.1.0" });
  const tool = (name: string, description: string, inputSchema: Record<string, z.ZodType>, fn: Handler) =>
    server.registerTool(name, { description, inputSchema }, wrap(fn));

  tool("whoami", "Bot id, role, open task count, and open alert count.", {}, () => core.whoami(db, me));
  tool("list_my_tasks",
    "Tasks for the caller, with open alerts and unread_feedback_count. status: one status or an array; omitted = assigned/in_progress/review/blocked. role: assignee (default), reviewer, or any. Each row includes role (assignee, reviewer, both). limit defaults to 50, max 200; offset.",
    { status: z.union([status, z.array(status).min(1)]).optional(),
      role: z.enum(["assignee", "reviewer", "any"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional() },
    (a) => core.listMyTasks(db, me, a));
  tool("report_status",
    "Change a task's status and record an update. Call only when the status changes. done requires a note; put a PR link in links. Moving to review requires reviewer (an active member id) when the task has no reviewer_id. in_progress returns to assigned when the agent stops. A pm or admin may move backlog, assigned, or blocked to pending_approval (anyone else gets 403). From blocked, open need_approval blockers are closed; any other open blocker kind returns 400. Leaving pending_approval (to backlog or assigned, or rejecting to cancelled) is admin-only and requires approved_by to be a configured owner or approver id. Rejection requires a note.",
    { task: taskCode, status, note: z.string().max(core.NOTE_MAX).optional(), links: z.array(z.string()).max(10).optional(),
      reviewer: z.string().max(32).optional().describe("Active member id. Required when moving to review if the task has no reviewer yet."),
      approved_by: approver.optional() },
    (a) => core.reportStatus(db, me, a));
  tool("add_note", "Record progress without changing status (clears STALE).",
    { task: taskCode, note: z.string().max(core.NOTE_MAX), links: z.array(z.string()).max(10).optional() },
    (a) => core.addNote(db, me, a));
  tool("set_blocker", "Open a blocker and move the task to blocked. waiting_on is an existing member id or a configured owner/approver id. kind: need_info, dependency, access, bug. need_approval is rejected; waiting for approval is the pending_approval status. A pending_approval task cannot take a blocker.",
    { task: taskCode, kind: z.string().max(32).describe("need_info | dependency | access | bug"), waiting_on: z.string().max(32), detail: z.string().max(core.NOTE_MAX) },
    (a) => core.setBlocker(db, me, a));
  tool("resolve_blocker", "Close a blocker. The task returns to in_progress when none remain.", { id: z.number().int(), note: z.string().max(core.NOTE_MAX).optional() },
    (a) => core.resolveBlocker(db, me, a));
  tool("get_task", "Task detail (including reviewer_id), the 10 latest updates, leadership feedback (feedback[].unread), and time in each status (periods, epoch ms UTC). When the assignee calls this, feedback is marked read.", { code: taskCode },
    (a) => core.getTask(db, a.code, Date.now(), me));
  tool("get_task_timeline", "Status timeline: start, end, and duration of each period, plus totals per status.", { code: taskCode },
    (a) => core.getTaskTimeline(db, a.code));
  tool("get_project_overview", "Task counts by status, plus open blockers and alerts for a project.", { project: z.string().regex(core.PROJECT_RE) },
    (a) => core.projectOverview(db, a.project));
  tool("list_alerts", "(pm/po/lead/admin) Open alerts, optionally filtered by project code or member id.", { scope: z.string().max(32).optional() },
    (a) => core.listAlerts(db, me, a.scope));
  tool("create_feature", "(pm/po/lead/admin) Allocate a feature code PRJ-MOD-NNN.",
    { module: z.string().regex(core.MODULE_RE), title: z.string().min(3).max(200), spec_url: z.string().url().optional(),
      priority: z.enum(["P0", "P1", "P2", "P3"]).optional(), owner: z.string().max(32).optional(), due_at: z.number().int().optional().describe("epoch ms UTC") },
    (a) => core.createFeature(db, me, a));
  tool("create_task",
    "Allocate a task code PRJ-MOD-NNN.T. Any member may create one. pr_url and links accept only http/https. If requested_by, requested_at, or request_link is missing, status is pending_approval and the requested status is ignored. When all three are present, a non-admin still lands in pending_approval; an admin defaults to backlog (an assignee does not change status) or uses the status argument. requested_by must be a configured owner id, approver id, or an active pm member. Leaving pending_approval is admin-only and requires approved_by to be a configured owner or approver id.",
    { feature: z.string().regex(core.FEATURE_RE), title: z.string().min(3).max(200), assignee: z.string().max(32).optional(),
      due_at: z.number().int().optional().describe("epoch ms UTC"),
      status: z.enum(["pending_approval", "backlog", "assigned"]).optional(),
      pr_url: z.string().max(500).optional().describe("http or https URL"),
      links: z.array(z.string().max(500)).max(10).optional(),
      requested_by: z.string().max(64).optional().describe("Configured owner id, approver id, or an active pm member id"),
      requested_at: z.number().int().optional().describe("epoch ms UTC"),
      request_link: z.string().max(500).optional().describe("http(s) URL of the request") },
    (a) => core.createTask(db, me, a));
  tool("update_task", "(assignee or pm/po/lead/admin) Edit pr_url and links without changing status. Only http/https URLs.",
    { task: taskCode,
      pr_url: z.string().max(500).optional().describe("http or https URL; empty string clears it"),
      links: z.array(z.string().max(500)).max(10).optional() },
    (a) => core.updateTask(db, me, a));
  tool("assign_task", "(pm/po/lead/admin) Change the assignee and keep the status. Reassigning an assigned task resets the NOT_STARTED clock.", { task: taskCode, assignee: z.string().max(32) },
    (a) => core.assignTask(db, me, a));
  tool("create_project", "(admin) Register a project code matching ^[A-Z]{2,5}$ (also creates a CORE module).",
    { code: z.string().regex(core.PROJECT_RE), name: z.string().min(2).max(100), owner: z.string().max(32).optional(), repo_url: z.string().url().optional() },
    (a) => core.createProject(db, me, a));
  tool("create_module", "(admin) Register a module in a project.",
    { project: z.string().regex(core.PROJECT_RE), code: z.string().regex(core.MODULE_PART_RE), name: z.string().min(2).max(100), owner: z.string().max(32).optional() },
    (a) => core.createModule(db, me, a));
  tool("set_token_hash", "(admin) Store the SHA-256 of a new token for a member, or null to revoke it. Never send the raw token.",
    { member: z.string().max(32), sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable() },
    (a) => core.setTokenHash(db, me, a));
  return server;
}
