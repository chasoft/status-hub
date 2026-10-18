import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  addAttachmentBytes, addAttachmentFromSource, attachmentPolicy, decodeBase64,
  listAttachments, prepareAttachmentUpload, type AttachmentEnv,
} from "./attachments";
import { getHubConfig } from "./config";
import * as core from "./core";
import type { Member } from "./core";

export interface McpFiles {
  bucket?: R2Bucket;
  env?: AttachmentEnv;
}

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
export function createServer(db: D1Database, me: Member, files?: McpFiles) {
  const server = new McpServer({ name: getHubConfig().mcpServerName, version: "0.1.0" });
  const policy = attachmentPolicy(files?.env ?? {});
  const bucket = files?.bucket;
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
    "Change a task's status and record an update. Call only when the status changes. done requires a note; put a PR link in links. Moving to review requires reviewer (an active member id) when the task has no reviewer_id, and at least one Output attachment or an output link (a stored output link, or links on this call). The update records the request version and the output versions it refers to. in_progress returns to assigned when the agent stops. A pm or admin may move backlog, assigned, or blocked to pending_approval (anyone else gets 403). From blocked, open need_approval blockers are closed; any other open blocker kind returns 400. Leaving pending_approval (to backlog or assigned, or rejecting to cancelled) is admin-only and requires approved_by to be a configured owner or approver id. Rejection requires a note.",
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
  tool("get_task", "Task detail (including reviewer_id), the latest request version, an attachment summary (requirement and output, plus output links), the 10 latest updates, leadership feedback (feedback[].unread, request_version, output_ref), and time in each status (periods, epoch ms UTC). When the assignee calls this, feedback is marked read. attachments_configured is false when the R2 binding is absent.", { code: taskCode },
    async (a) => ({ ...await core.getTask(db, a.code, Date.now(), me), attachments_configured: !!bucket }));
  tool("set_request",
    "Store a new markdown request version (v1, v2, …). Does not overwrite older versions. The caller is the author. note is an optional change note, up to 500 characters. The markdown should cover who requested the work, what, why, acceptance criteria, and impacted areas.",
    { task: taskCode, markdown: z.string().min(1).max(core.REQUEST_MAX), note: z.string().max(core.NOTE_MAX).optional() },
    (a) => core.setRequestDocument(db, me, a));
  tool("get_request",
    "Read one request version. Omit version for the latest. versions lists every version without the markdown body. A missing version number is 404. A task with no request returns version null.",
    { task: taskCode, version: z.number().int().min(1).optional() },
    (a) => core.getRequestDocument(db, a.task, a.version));
  tool("add_attachment",
    "Create or version a Requirement or Output file in R2. The same name and group inserts a new version and keeps the previous object. Provide exactly one of content_base64, source_url (public http(s) fetched by the Worker), or upload:true (returns a one-time upload_path). Finish upload with POST /attachment-uploads/<token> on the MCP host, Authorization bearer, raw bytes. Downloads are not public: GET /t/<task>/attachments/<id> on the UI host. If R2 is not bound, this returns a clear error.",
    { task: taskCode, group: z.enum(["requirement", "output"]), name: z.string().min(1).max(200),
      mime: z.string().min(1).max(200), note: z.string().max(core.NOTE_MAX).optional(),
      content_base64: z.string().max(40_000_000).optional(),
      source_url: z.string().max(2000).optional(),
      upload: z.boolean().optional() },
    async (a) => {
      const modes = [a.content_base64 != null, a.source_url != null && a.source_url !== "", a.upload === true].filter(Boolean).length;
      if (modes !== 1) throw new core.AppError("BAD_REQUEST", "provide exactly one of content_base64, source_url, or upload");
      if (a.upload) {
        const pending = await prepareAttachmentUpload(db, bucket, me, a, policy);
        return { pending: true, upload_path: `/attachment-uploads/${pending.token}`, method: "POST", expires_at: pending.expires_at, task: pending.task, group: pending.group, name: pending.name, mime: pending.mime };
      }
      const stored = a.source_url
        ? await addAttachmentFromSource(db, bucket, me, { ...a, sourceUrl: a.source_url }, policy)
        : await addAttachmentBytes(db, bucket, me, { ...a, bytes: decodeBase64(a.content_base64 ?? "") }, policy);
      const { r2_key: _key, ...pub } = stored;
      return pub;
    });
  tool("list_attachments",
    "List Requirement and Output attachments for a task, newest version first, plus output links. configured is false when R2 is not bound. Bytes are not included; download through the UI host.",
    { task: taskCode },
    async (a) => ({ task: a.task, configured: !!bucket, ...await listAttachments(db, a.task), output_links: (await core.attachmentSummary(db, a.task)).output_links }));
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
    "Allocate a task code PRJ-MOD-NNN.T. Any member may create one. pr_url and links accept only http/https. If requested_by, requested_at, or request_link is missing, status is pending_approval and the requested status is ignored. When all three are present, a non-admin still lands in pending_approval; an admin defaults to backlog (an assignee does not change status) or uses the status argument. requested_by must be a configured owner id, approver id, or an active pm member. Optional request is markdown stored as request version 1; bots should include who requested it, what, why, acceptance criteria, and impacted areas. Leaving pending_approval is admin-only and requires approved_by to be a configured owner or approver id.",
    { feature: z.string().regex(core.FEATURE_RE), title: z.string().min(3).max(200), assignee: z.string().max(32).optional(),
      due_at: z.number().int().optional().describe("epoch ms UTC"),
      status: z.enum(["pending_approval", "backlog", "assigned"]).optional(),
      pr_url: z.string().max(500).optional().describe("http or https URL"),
      links: z.array(z.string().max(500)).max(10).optional(),
      requested_by: z.string().max(64).optional().describe("Configured owner id, approver id, or an active pm member id"),
      requested_at: z.number().int().optional().describe("epoch ms UTC"),
      request_link: z.string().max(500).optional().describe("http(s) URL of the request"),
      request: z.string().max(core.REQUEST_MAX).optional().describe("Markdown request document. Stored as version 1. Bots should send who, what, why, acceptance criteria, and impacted areas.") },
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
