// Server-rendered dashboard. Behaviour lives in /assets/dashboard.js (no inline handlers).
import { leadershipAuthor, memberForAccessEmail } from "./auth";
import { getHubConfig, waitingRank } from "./config";
import { isLeader, loadSettings, STATUSES, formatDuration, summarizePeriods, type PeriodRow, type Status } from "./core";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function fmt(ms: number | null | undefined, offsetMinutes = 0): string {
  if (!ms) return "—";
  const d = new Date(ms + offsetMinutes * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "—";
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 60) return `${m}'`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, "0")}'`;
  return `${Math.floor(h / 24)}d`;
}

function tzLabel(offsetMinutes: number): string {
  if (!offsetMinutes) return "UTC";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m ? `UTC${sign}${h}:${String(m).padStart(2, "0")}` : `UTC${sign}${h}`;
}

const STATUS_LABEL: Record<Status, string> = {
  pending_approval: "Pending approval", backlog: "Backlog", assigned: "Assigned", in_progress: "In progress", review: "Review",
  blocked: "Blocked", done: "Done", cancelled: "Cancelled",
};
const BOARD_COLS: Status[] = ["pending_approval", "backlog", "assigned", "in_progress", "review", "blocked", "done"];
const RULE_LABEL: Record<string, string> = {
  NOT_STARTED: "Not started", STALE: "Stale", BLOCKED_LONG: "Blocked too long", OVERDUE: "Overdue",
};
const AVATAR_COLORS = ["#0e6b4f", "#1d4e89", "#6b3fa0", "#8a5a12", "#a33b32", "#0f6e6e", "#3d5a80"];
const DONE_PREVIEW = 10;

const EXT_ICON = `<svg class="ext" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" d="M4.5 2.5H2.5v7h7V7.5M6.5 2.5h3v3M9.5 2.5 5.5 6.5"/></svg>`;

/** Absolute http(s) links leave the UI host. Internal paths stay in this tab. */
export function externalAnchor(href: string, label?: string): string {
  return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label ?? href)}<span class="ext-icon">${EXT_ICON}<span class="sr"> (opens in a new tab)</span></span></a>`;
}

function linkList(json: string | null): string {
  if (!json) return "";
  let urls: unknown;
  try { urls = JSON.parse(json); } catch { return ""; }
  if (!Array.isArray(urls)) return "";
  return urls.filter((u): u is string => typeof u === "string" && u.length > 0).map((u) => externalAnchor(u)).join("<br>");
}

const CSS = `
:root {
  color-scheme: light;
  --bg:#efece4; --top:#1c2430; --top-ink:#f6f3ec; --card:#fffcf7; --sidebar:#f7f4ee;
  --bd:#ddd6c8; --tx:#1c1915; --mut:#6d675e; --accent:#0e6b4f; --accent-ink:#f4fffb;
  --cell:#e7e2d6; --shadow:0 10px 28px #1c19151a; --scrollbar:#c4bbaa; --danger:#a33b32;
  --warn:#8a5a12; --pill:#f4efe4; --focus:#0e6b4f; --label:168px; --radius:5px;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg:#10141b; --top:#0c1016; --top-ink:#f3eee4; --card:#1a212c; --sidebar:#141a23;
    --bd:#2c3544; --tx:#ece7dc; --mut:#a39c90; --accent:#3dbe96; --accent-ink:#06281c;
    --cell:#151b24; --shadow:0 12px 32px #000a; --scrollbar:#3d4756; --danger:#f07167;
    --warn:#e6b15c; --pill:#243041; --focus:#3dbe96;
  }
}
*{box-sizing:border-box}
html,body{margin:0}
body{font:14px/1.45 ui-sans-serif,system-ui,"Segoe UI",sans-serif;background:var(--bg);color:var(--tx)}
body.app{height:100dvh;overflow:hidden}
.shell{height:100%;display:flex;flex-direction:column;min-height:0}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
button,input,select,textarea{font:inherit;color:inherit;background:var(--card);border:1px solid var(--bd);border-radius:var(--radius)}
button{cursor:pointer}
button:hover,summary:hover{border-color:var(--accent)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip{position:absolute;left:8px;top:-40px;background:var(--card);padding:6px 10px;z-index:5;border-radius:8px}
.skip:focus{top:8px}
.topbar{flex:0 0 auto;display:flex;gap:8px;align-items:center;padding:8px 12px;background:var(--top);color:var(--top-ink);min-height:52px}
.topbar a{color:var(--top-ink)}
.org{font-weight:750;letter-spacing:-.02em;font-size:16px;text-decoration:none;margin-right:4px}
.chip,.user-btn,.btn,.nav-open{display:inline-flex;align-items:center;gap:6px;border-radius:var(--radius);padding:5px 10px;background:#ffffff14;color:var(--top-ink);border:1px solid #ffffff24;text-decoration:none}
.btn.primary{background:var(--accent);color:var(--accent-ink);border-color:transparent;font-weight:650}
.topbar .btn.primary{color:var(--accent-ink)}
.search{flex:1;min-width:120px;max-width:340px;display:flex}
.search input{width:100%;border:0;background:#ffffff14;color:var(--top-ink);border-radius:var(--radius);padding:6px 12px}
.search input::placeholder{color:#ffffff99}
.user-btn{margin-left:auto}
.avatar{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--accent);color:#fff;font-size:10px;font-weight:700;flex:none}
.user-btn .avatar{width:22px;height:22px}
.count,.proj-alert{display:none;min-width:18px;height:18px;padding:0 5px;border-radius:var(--radius);background:var(--danger);color:#fff;font-size:11px;font-weight:700;align-items:center;justify-content:center}
.count.is-on,.proj-alert.is-on{display:inline-flex}
kbd{font:11px ui-monospace,monospace;border:1px solid #ffffff40;border-radius:var(--radius);padding:0 4px;opacity:.8}
.body{flex:1;display:flex;min-height:0;min-width:0}
.sidebar{width:232px;flex:none;overflow:auto;background:var(--sidebar);border-right:1px solid var(--bd);padding:10px 8px 16px;min-height:0}
.nav-links,.proj-nav{display:flex;flex-direction:column;gap:2px}
.nav-label{margin:14px 8px 4px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut)}
.nav-link,.proj{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--radius);color:var(--tx);text-decoration:none}
.nav-link.is-current,.proj.is-current{background:var(--cell);font-weight:650}
.proj-code{font:12px ui-monospace,monospace;width:42px;flex:none}
.proj-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.proj-open{color:var(--mut);font-size:12px}
main{flex:1;min-width:0;min-height:0}
.page-scroll{overflow:auto;padding:16px 18px 32px}
.board-main{display:flex;flex-direction:column;overflow:hidden}
.board-tools{flex:0 0 auto;display:flex;gap:8px;align-items:center;padding:8px 12px 0}
.board-tools button,.page-scroll button,.dialog-body button,.drawer-body button,.feedback-dock button{padding:5px 10px;border-radius:var(--radius)}
.stamp{margin-left:auto;color:var(--mut);font-size:12px}
#board{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column;overflow-x:auto;overflow-y:hidden}
.colheads,.summary,details.lane>summary,.lane-grid{display:grid;grid-template-columns:var(--label) repeat(var(--cols),minmax(160px,1fr));gap:8px;align-items:stretch}
.colheads{position:sticky;top:0;z-index:1;padding:8px 12px 4px;background:var(--bg)}
.colh{font-weight:650;padding:6px 8px;border-radius:var(--radius);background:var(--cell);display:flex;gap:6px;align-items:center;flex-wrap:wrap;position:sticky;top:0}
.colhead-label{color:var(--mut);font-size:12px;align-self:center}
.lanes{flex:1;min-height:0;display:flex;flex-direction:column;overflow-x:hidden;overflow-y:auto;padding:0 12px 12px}
details.lane,section.lane{min-height:0;display:flex;flex-direction:column;flex:0 0 auto}
details.lane[open]{flex:0 1 auto;max-height:100%;overflow:hidden}
section.lane{flex:1 1 auto;min-height:0;overflow:hidden}
details.lane>summary,.summary{flex:none;align-items:center;padding:6px 0;cursor:pointer;list-style:none}
details.lane>summary::-webkit-details-marker{display:none}
.lane-label{display:flex;align-items:center;gap:6px;min-width:0}
.lane-id{font-weight:750}
.lane-name{color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lane-count{text-align:center;color:var(--mut);font-size:12px;font-variant-numeric:tabular-nums}
.chev{width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid var(--mut);flex:none}
details.lane:not([open]) .chev{transform:rotate(-90deg)}
.lane-grid{flex:1 1 auto;min-height:0;min-width:0;overflow:hidden;grid-template-rows:minmax(0,1fr);padding-bottom:8px}
.cell{background:var(--cell);border-radius:var(--radius);padding:6px;min-width:0;min-height:0;overflow-x:hidden;overflow-y:auto}
.cell-label{display:none;position:sticky;top:0;z-index:1;background:var(--cell);font-weight:700;margin:-2px -2px 6px;padding:2px}
.lane-side{display:flex;align-items:flex-start;padding-top:4px}
.card{display:block;min-width:0;max-width:100%;background:var(--card);border:1px solid var(--bd);border-left:4px solid var(--s);border-radius:var(--radius);padding:8px;margin:0 0 8px;color:inherit;text-decoration:none;box-shadow:0 1px 0 #0000000a;overflow-wrap:anywhere}
.card:hover{box-shadow:var(--shadow);text-decoration:none}
.card-top{display:flex;justify-content:space-between;align-items:center;gap:6px;min-width:0}
.code{min-width:0;font:12px ui-monospace,monospace;color:var(--mut);overflow-wrap:anywhere}
.title{display:block;min-width:0;font-weight:650;margin-top:4px;overflow-wrap:anywhere}
.meta{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;color:var(--mut);font-size:12px;margin-top:6px;min-width:0}
.who{min-width:0;overflow-wrap:anywhere}
.dur{white-space:normal;overflow-wrap:anywhere}
.pills{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.pill{display:inline-block;padding:1px 6px;border-radius:var(--radius);font-size:11px;font-weight:650;background:var(--pill)}
.pill-blocker{color:var(--danger)}.pill-alert{color:var(--warn)}.pill-unread{color:#1d4e89}.pill-pr{color:var(--accent)}
.s-pending_approval{--s:#e07a2f}.s-backlog{--s:#8b93a7}.s-assigned{--s:#5b6ee1}.s-in_progress{--s:#2f7de1}.s-review{--s:#8d4fd6}.s-blocked{--s:#d64545}.s-done{--s:#2f9e62}.s-cancelled{--s:#757575}
.badge{display:inline-block;padding:1px 6px;border-radius:var(--radius);font-size:11px;color:#fff;background:var(--s)}
.cancelled{margin-top:8px}
.cancelled-list{max-height:180px;overflow:auto}
table{border-collapse:separate;border-spacing:0;width:100%;background:var(--card)}
td,th{border-bottom:1px solid var(--bd);padding:6px 8px;text-align:left;vertical-align:top}
.sheet-scroll thead th,.tab-scroll thead th,.page-scroll thead th{position:sticky;top:0;background:var(--card);z-index:1}
.page-scroll h2,.page-scroll h3{position:sticky;top:0;background:var(--bg);z-index:2;margin:0;padding:8px 0}
.page-scroll thead th{top:2.4rem}
.fields th{width:9.5rem;color:var(--mut);font-weight:650;white-space:nowrap}
.lead{background:#fff6ea;box-shadow:inset 3px 0 var(--warn)}
.flag{color:var(--danger);font-weight:700}
.muted,.empty{color:var(--mut)}
.stack p{margin:0 0 10px}
.stack input,.stack select,.stack textarea,.dialog-body input,.drawer-body textarea{width:100%;max-width:640px;padding:6px 8px}
.inline{display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-top:6px}
.ext{vertical-align:-1px;margin-left:3px}
dialog{border:1px solid var(--bd);border-radius:14px;background:var(--card);color:var(--tx);padding:0;box-shadow:var(--shadow);max-width:min(560px,calc(100vw - 32px))}
dialog::backdrop{background:#0007}
dialog.drawer{margin:0 0 0 auto;height:100dvh;max-height:100dvh;width:min(520px,100vw);border-radius:0;border-width:0 0 0 1px;max-width:none}
.dialog-bar,.drawer-bar{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--bd)}
.dialog-bar h2,.drawer-bar h2{margin:0;font-size:16px;flex:1}
.dialog-body{padding:14px;overflow:auto;max-height:min(70dvh,640px)}
.drawer-body{overflow:hidden;display:flex;flex-direction:column;height:calc(100dvh - 54px);padding:0}
.page-fill,.task-main{display:flex;flex-direction:column;min-height:0;overflow:hidden;padding:12px 16px 16px}
.task-main{padding-bottom:0}
.page-fill>.back,.task-main>.back{flex:none;margin:0 0 8px}
.sheets{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px}
.sheet{display:flex;flex-direction:column;min-height:0;flex:1 1 0}
.sheet-fit{flex:0 1 auto;max-height:42%}
.sheet-h{flex:none;margin:0 0 6px}
.sheet-scroll{flex:1;min-height:0;overflow:auto}
.task{display:flex;flex-direction:column;flex:1;min-height:0}
.task-tabs{display:flex;flex:none;gap:4px;padding:8px 12px 0;border-bottom:1px solid var(--bd)}
.task-tabs [role="tab"]{display:inline-flex;align-items:center;gap:6px;border:1px solid transparent;border-bottom:0;border-radius:var(--radius) var(--radius) 0 0;background:transparent;color:var(--mut);text-decoration:none;padding:6px 10px}
.task-tabs [role="tab"][aria-selected="true"]{background:var(--card);color:var(--tx);border-color:var(--bd);font-weight:650}
.task-panel{display:none;flex:1;min-height:0;flex-direction:column}
.task-panel.is-on{display:flex}
.tab-scroll{flex:1 1 auto;min-height:0;overflow:auto;padding:12px 14px}
.feedback-pane{flex:0 0 auto;display:flex;flex-direction:column;min-height:10.5rem;max-height:40%;border-top:1px solid var(--bd);background:var(--card)}
.feedback-pane .sheet-h{margin:8px 14px 4px}
.feedback-pane .sheet-scroll{flex:1;min-height:6.5rem;overflow:auto;padding:0 14px 8px}
.feedback-dock{flex:none;display:flex;gap:8px;align-items:flex-end;padding:8px 12px;border-top:1px solid var(--bd);background:var(--card);position:sticky;bottom:0;z-index:2}
.feedback-dock textarea{flex:1;width:auto;max-width:none;min-height:2.25rem;max-height:8rem;resize:vertical;line-height:1.4}
.feedback-dock textarea:focus{min-height:4.75rem}
.inline-edit{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.ie-view,.ie-form{display:flex;align-items:center;gap:6px;min-width:0;max-width:100%}
.ie-form[hidden],.ie-view[hidden]{display:none}
.inline-edit.is-editing .ie-view{display:none}
.inline-edit.is-editing .ie-form{display:flex}
.ie-pen,.ie-save,.ie-cancel{padding:2px 6px;line-height:0;background:transparent}
.ie-icon{width:14px;height:14px;display:block}
.ie-form input,.ie-form select{width:auto;min-width:10rem;max-width:100%;flex:1}
.ie-msg{flex-basis:100%;color:var(--danger);font-size:12px;min-height:0}
.ie-msg:empty{display:none}
.inline-edit.is-saving .ie-msg{color:var(--mut)}
.ie-value{min-width:0;overflow-wrap:anywhere}
[popover]{border:1px solid var(--bd);border-radius:12px;background:var(--card);color:var(--tx);padding:12px;box-shadow:var(--shadow);max-width:min(360px,calc(100vw - 24px));max-height:min(70dvh,520px);overflow:auto}
.quick{list-style:none;margin:8px 0;padding:0}
.quick a{display:flex;justify-content:space-between;gap:8px;padding:4px 0;color:var(--tx)}
.row{display:flex;gap:8px;justify-content:flex-end}
.switcher-list,#switcher-list{list-style:none;margin:8px 0 0;padding:0;max-height:50dvh;overflow:auto}
#switcher-list a{display:flex;gap:8px;padding:6px 8px;border-radius:8px;color:var(--tx)}
#switcher-list a.is-active{background:var(--cell)}
.login-body{min-height:100dvh;overflow:auto;display:grid;place-items:center;padding:24px}
.login-card{width:min(420px,100%);background:var(--card);border:1px solid var(--bd);border-radius:16px;padding:22px;box-shadow:var(--shadow)}
.login-card h1{margin:0 0 8px;font-size:22px}
* {scrollbar-width:thin;scrollbar-color:var(--scrollbar) transparent}
*::-webkit-scrollbar{width:8px;height:8px}
*::-webkit-scrollbar-thumb{background:var(--scrollbar);border-radius:8px}
@media (prefers-reduced-motion: reduce){*{transition:none !important;scroll-behavior:auto !important}}
@media (max-width:800px){
  body.app{height:auto;min-height:100dvh;overflow:auto}
  .shell{height:auto;min-height:100dvh}
  .body{display:block}
  .sidebar{width:auto;max-height:none;border-right:0;border-bottom:1px solid var(--bd);overflow:auto}
  .nav-links{flex-direction:row;flex-wrap:wrap}
  main,.board-main,#board,.lanes,details.lane,details.lane[open],section.lane,.lane-grid,.cell,.task-main,.page-fill,.task,.task-panel,.tab-scroll,.sheet,.sheet-scroll,.feedback-pane{height:auto;max-height:none;overflow:visible;flex:none}
  .cell-label{display:block}
  .colheads{display:none}
  .summary,details.lane>summary{display:flex;flex-wrap:wrap}
  .lane-grid{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;grid-template-columns:none;padding-bottom:12px}
  .cell{min-width:78vw;scroll-snap-align:start;flex:none;overflow-x:hidden;overflow-y:visible}
  .feedback-dock{position:sticky;bottom:0}
  .lane-side{display:none}
  dialog.drawer{width:100vw}
}
@media (prefers-color-scheme: dark){
  .lead{background:#2a2418}
  .pill-unread{color:#9ec1ff}
}
`;

type PageId = "board" | "done" | "alerts" | "members" | "member" | "project" | "task" | "new";

interface Filters {
  project: string;
  member: string;
  status: Status | "";
  q: string;
}

interface ProjectNav { code: string; name: string; open_n: number; alert_n: number }
interface MemberNav { id: string; name: string; open_n: number }
interface AlertNav { rule: string; n: number }
interface Chrome {
  tz: number;
  projects: ProjectNav[];
  members: MemberNav[];
  alerts: AlertNav[];
  requesters: string[];
  filters: Filters;
}

interface CardRow {
  code: string; title: string; status: Status; project_code: string; feature_code: string; feature_title: string;
  assignee_id: string | null; assignee_name: string | null; reviewer_id: string | null; last_update_at: number;
  pr_url: string | null; alerts: string | null; open_blockers: number; waiting_on: string | null;
  status_since: number | null; unread_feedback: number;
}

export interface BoardJson {
  project: string;
  member: string;
  status: string;
  q: string;
  doneTotal: number;
  alertTotal: number;
  alerts: { rule: string; label: string; n: number }[];
  projects: { code: string; name: string; open: number; alerts: number }[];
  cards: { code: string; project_code: string; status: string; rev: string; html: string }[];
}

function readFilters(url: URL): Filters {
  const raw = url.searchParams.get("status") || "";
  const status = (STATUSES as string[]).includes(raw) ? raw as Status : "";
  return {
    project: url.searchParams.get("project") || "",
    member: url.searchParams.get("member") || "",
    status,
    q: (url.searchParams.get("q") || "").trim().slice(0, 80),
  };
}

function withQuery(path: string, pairs: [string, string][]): string {
  const q = new URLSearchParams();
  for (const [k, v] of pairs) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

function boardHref(f: Filters, project = f.project): string {
  return withQuery("/", [["project", project], ["member", f.member], ["status", f.status], ["q", f.q]]);
}

function doneHref(f: Filters): string {
  return withQuery("/done", [["project", f.project], ["member", f.member]]);
}

function pendingHref(project: string): string {
  return project ? `/?status=pending_approval&project=${project}` : "/?status=pending_approval";
}

function hidden(name: string, value: string): string {
  return value ? `<input type="hidden" name="${name}" value="${esc(value)}">` : "";
}

function initials(name: string | null, id: string | null): string {
  const src = (name || id || "?").trim();
  const parts = src.split(/[\s._-]+/).filter(Boolean);
  const raw = parts.length >= 2 ? `${parts[0]![0]!}${parts[1]![0]!}` : src.slice(0, 2);
  return raw.toUpperCase();
}

function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

function cardRev(c: CardRow): string {
  let h = 0;
  const src = `${c.title}\0${c.alerts ?? ""}\0${c.waiting_on ?? ""}\0${c.pr_url ?? ""}`;
  for (let i = 0; i < src.length; i++) h = (Math.imul(h, 33) + src.charCodeAt(i)) >>> 0;
  return [c.status, c.last_update_at, c.status_since ?? 0, c.assignee_id ?? "", c.reviewer_id ?? "", c.open_blockers, c.unread_feedback, h].join(".");
}

function asCards(rows: unknown[]): CardRow[] {
  return rows.map((raw) => {
    const r = raw as CardRow;
    return {
      ...r,
      open_blockers: Number(r.open_blockers) || 0,
      unread_feedback: Number(r.unread_feedback) || 0,
      last_update_at: Number(r.last_update_at),
      status_since: r.status_since == null ? null : Number(r.status_since),
    };
  });
}

const CARD_SQL = `
SELECT t.code, t.title, t.status, t.project_code, t.feature_code, f.title AS feature_title,
  t.assignee_id, am.name AS assignee_name, t.reviewer_id, t.last_update_at, t.pr_url,
  (SELECT group_concat(a.rule) FROM alerts a WHERE a.task_code = t.code AND a.cleared_at IS NULL) AS alerts,
  (SELECT COUNT(*) FROM blockers b WHERE b.task_code = t.code AND b.resolved_at IS NULL) AS open_blockers,
  (SELECT b.waiting_on FROM blockers b WHERE b.task_code = t.code AND b.resolved_at IS NULL ORDER BY b.opened_at LIMIT 1) AS waiting_on,
  (SELECT p.started_at FROM status_periods p WHERE p.task_code = t.code AND p.ended_at IS NULL) AS status_since,
  (SELECT COUNT(*) FROM feedback fb WHERE fb.task_code = t.code AND (fb.read_by IS NULL OR fb.read_by != IFNULL(t.assignee_id, ''))) AS unread_feedback
FROM tasks t
JOIN features f ON f.code = t.feature_code
LEFT JOIN members am ON am.id = t.assignee_id`;

function applyScope(filters: Filters, where: string[], binds: unknown[], withStatus: boolean) {
  if (filters.project) { where.push("t.project_code = ?"); binds.push(filters.project); }
  if (filters.member) { where.push("t.assignee_id = ?"); binds.push(filters.member); }
  if (filters.q) {
    const like = `%${filters.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push("(t.code LIKE ? ESCAPE '\\' OR t.title LIKE ? ESCAPE '\\' OR f.title LIKE ? ESCAPE '\\')");
    binds.push(like, like, like);
  }
  if (withStatus && filters.status) { where.push("t.status = ?"); binds.push(filters.status); }
}

async function loadChrome(db: D1Database, url: URL): Promise<Chrome> {
  const filters = readFilters(url);
  const [projects, members, alerts, pms] = await db.batch([
    db.prepare(`SELECT p.code, p.name,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_code = p.code AND t.status NOT IN ('done','cancelled')) AS open_n,
      (SELECT COUNT(*) FROM alerts a JOIN tasks t ON t.code = a.task_code WHERE t.project_code = p.code AND a.cleared_at IS NULL) AS alert_n
      FROM projects p WHERE p.status != 'archived' ORDER BY p.code`),
    db.prepare(`SELECT m.id, m.name,
      (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = m.id AND t.status NOT IN ('done','cancelled')) AS open_n
      FROM members m WHERE m.active = 1 ORDER BY m.name, m.id`),
    db.prepare("SELECT rule, COUNT(*) AS n FROM alerts WHERE cleared_at IS NULL GROUP BY rule"),
    db.prepare("SELECT id FROM members WHERE active = 1 AND role = 'pm' ORDER BY id"),
  ]);
  const tz = (await loadSettings(db)).tz_offset_minutes;
  const cfg = getHubConfig();
  const requesters = [...new Set([...cfg.ownerIds, ...cfg.approverIds, ...(pms.results as { id: string }[]).map((m) => m.id)])];
  return {
    tz,
    filters,
    requesters,
    projects: (projects.results as ProjectNav[]).map((p) => ({ ...p, open_n: Number(p.open_n) || 0, alert_n: Number(p.alert_n) || 0 })),
    members: (members.results as MemberNav[]).map((m) => ({ ...m, open_n: Number(m.open_n) || 0 })),
    alerts: (alerts.results as AlertNav[]).map((a) => ({ rule: a.rule, n: Number(a.n) || 0 })),
  };
}

async function loadCards(db: D1Database, filters: Filters): Promise<{ rows: CardRow[]; doneTotal: number }> {
  const where = ["t.status != 'done'"];
  const binds: unknown[] = [];
  applyScope(filters, where, binds, true);
  const doneWhere = ["t.status = 'done'"];
  const doneBinds: unknown[] = [];
  applyScope(filters, doneWhere, doneBinds, false);
  const showDone = !filters.status || filters.status === "done";
  const [cards, doneCards, doneCount] = await db.batch([
    db.prepare(`${CARD_SQL} WHERE ${where.join(" AND ")} ORDER BY t.last_update_at DESC LIMIT 1000`).bind(...binds),
    db.prepare(`${CARD_SQL} WHERE ${doneWhere.join(" AND ")} ORDER BY t.done_at DESC, t.code DESC LIMIT ?`).bind(...doneBinds, DONE_PREVIEW),
    db.prepare(`SELECT COUNT(*) AS n FROM tasks t JOIN features f ON f.code = t.feature_code WHERE ${doneWhere.join(" AND ")}`).bind(...doneBinds),
  ]);
  const rows = asCards(cards.results);
  if (showDone) rows.push(...asCards(doneCards.results));
  return { rows, doneTotal: Number((doneCount.results[0] as { n: number }).n) };
}

function card(c: CardRow, now: number, tz: number): string {
  const since = c.status_since ?? c.last_update_at;
  const who = `👤 ${esc(c.assignee_id ?? "unassigned")}${c.reviewer_id ? ` · reviewer ${esc(c.reviewer_id)}` : ""}`;
  const pills: string[] = [];
  if (c.open_blockers) pills.push(`<span class="pill pill-blocker">Blocker${c.waiting_on ? ` · ${esc(c.waiting_on)}` : ""}</span>`);
  for (const rule of (c.alerts ?? "").split(",").filter(Boolean)) pills.push(`<span class="pill pill-alert">${esc(RULE_LABEL[rule] ?? rule)}</span>`);
  if (c.unread_feedback) pills.push(`<span class="pill pill-unread">Feedback${c.unread_feedback > 1 ? ` ${c.unread_feedback}` : ""}</span>`);
  if (c.pr_url) pills.push(`<span class="pill pill-pr">PR</span>`);
  return `<a class="card s-${c.status}" href="/t/${encodeURIComponent(c.code)}" data-code="${esc(c.code)}" data-rev="${esc(cardRev(c))}" title="${esc(c.feature_code)} · ${esc(c.feature_title)}"><span class="card-top"><span class="code">${esc(c.code)}</span><span class="avatar" style="background:${avatarColor(c.assignee_id || c.assignee_name || "?")}" title="${esc(c.assignee_name || c.assignee_id || "Unassigned")}" aria-hidden="true">${esc(initials(c.assignee_name, c.assignee_id))}</span></span><span class="title">${esc(c.title)}</span><span class="meta"><span class="dur" title="in this status since ${fmt(since, tz)}">${esc(c.status)} · ${formatDuration(Math.max(0, now - since))}</span><span class="who">${who}</span></span>${pills.length ? `<span class="pills">${pills.join("")}</span>` : ""}</a>`;
}

function newTaskForm(requesters: string[]): string {
  return `<form method="post" action="/new" class="stack">
<p><label>Feature<br><input name="feature" required placeholder="PRJ-CORE-001"></label></p>
<p><label>Title<br><input name="title" required minlength="3"></label></p>
<p><label>Assignee<br><input name="assignee" placeholder="member id"></label></p>
<p><label>Status<br><select name="status"><option value="">default</option><option>pending_approval</option><option>backlog</option><option>assigned</option></select></label></p>
<p><label>Requested by<br><select name="requested_by"><option value=""></option>${requesters.map((id) => `<option>${esc(id)}</option>`).join("")}</select></label></p>
<p><label>Requested at (epoch ms)<br><input name="requested_at" inputmode="numeric"></label></p>
<p><label>Request link<br><input name="request_link" type="url" placeholder="https://"></label></p>
<button>Create</button></form>
<p class="muted">If requester, time, or link is missing, the task stays in Pending approval. An assignee does not change status by itself.</p>`;
}

function shell(title: string, main: string, email: string, chrome: Chrome, page: PageId, board: boolean): string {
  const org = getHubConfig().orgName;
  const f = chrome.filters;
  const alertTotal = chrome.alerts.reduce((sum, a) => sum + a.n, 0);
  const openTotal = chrome.projects.reduce((sum, p) => sum + p.open_n, 0);
  const alertTotalN = chrome.projects.reduce((sum, p) => sum + p.alert_n, 0);
  const tokenMode = getHubConfig().authMode === "token";
  const logout = tokenMode ? `<form method="post" action="/logout" class="logout"><button type="submit">Log out</button></form>` : "";
  const memberLabel = f.member ? (chrome.members.find((m) => m.id === f.member)?.name || f.member) : "All";
  const statusLabel = f.status ? STATUS_LABEL[f.status] : "All";
  const projectLabel = f.project || "All";
  const nav = (id: PageId | "member", href: string, label: string) => {
    const on = page === id || (id === "members" && page === "member");
    return `<a class="nav-link${on ? " is-current" : ""}" href="${esc(href)}"${on ? ' aria-current="page"' : ""}>${label}</a>`;
  };
  const allOn = page === "board" && !f.project;
  const projects = `<div class="proj-nav" role="group" aria-label="Projects">
<p class="nav-label">Projects</p>
<a class="proj${allOn ? " is-current" : ""}" href="${esc(boardHref({ ...f, project: "" }, ""))}" data-project-link="" data-nav-project="*"${allOn ? ' aria-current="page"' : ""}><span class="proj-code">All</span><span class="proj-name">All projects</span><span class="proj-open" data-open>${openTotal}</span><span class="proj-alert${alertTotalN ? " is-on" : ""}" data-alerts>${alertTotalN}</span></a>
${chrome.projects.map((p) => {
    const on = p.code === f.project;
    return `<a class="proj${on ? " is-current" : ""}" href="${esc(boardHref(f, p.code))}" data-project-link="${esc(p.code)}" data-nav-project="${esc(p.code)}"${on ? ' aria-current="page"' : ""}><span class="proj-code">${esc(p.code)}</span><span class="proj-name">${esc(p.name)}</span><span class="proj-open" data-open>${p.open_n}</span><span class="proj-alert${p.alert_n ? " is-on" : ""}" data-alerts>${p.alert_n}</span></a>`;
  }).join("")}
</div>`;
  const memberOpts = [`<option value="">All members</option>`, ...chrome.members.map((m) => `<option value="${esc(m.id)}"${m.id === f.member ? " selected" : ""}>${esc(m.name)}</option>`)].join("");
  const statusOpts = [`<option value="">All statuses</option>`, ...STATUSES.map((s) => `<option value="${s}"${s === f.status ? " selected" : ""}>${esc(STATUS_LABEL[s])}</option>`)].join("");
  const search = boardSearch(f);
  const dialogs = `${page === "new" ? "" : `<dialog id="new-task" aria-labelledby="new-task-title"><div class="dialog-bar"><h2 id="new-task-title">New task</h2><button type="button" data-close-dialog>Close</button></div><div class="dialog-body">${newTaskForm(chrome.requesters)}</div></dialog>`}
<dialog id="switcher" aria-labelledby="switcher-title"><div class="dialog-bar"><h2 id="switcher-title">Switch project</h2><button type="button" data-close-dialog>Close</button></div><div class="dialog-body"><input id="switcher-input" type="search" placeholder="Project code or name" aria-label="Filter projects" autocomplete="off"><ul id="switcher-list" role="listbox" aria-label="Projects"></ul><p class="muted">Arrow keys move. Enter opens. Esc closes.</p></div></dialog>
<dialog id="drawer" class="drawer" aria-labelledby="drawer-title"><div class="drawer-bar"><h2 id="drawer-title">Task</h2><a id="drawer-full" href="/">Open page</a><button type="button" data-close-dialog>Close</button></div><div id="drawer-body" class="drawer-body" tabindex="-1"></div></dialog>
${tokenMode ? `<dialog id="confirm" aria-labelledby="confirm-title"><form method="dialog"><h2 id="confirm-title">Log out?</h2><p>End this session in this browser.</p><div class="row"><button value="cancel">Cancel</button><button value="confirm">Log out</button></div></form></dialog>` : ""}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Status Hub</title><style>${CSS}</style></head>
<body class="app" data-page="${page}" data-board-search="${esc(board ? search : "")}">
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
<header class="topbar">
<a class="org" href="${esc(boardHref(f))}">${esc(org)}</a>
<button type="button" class="chip" data-dialog-open="switcher" aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K" title="Switch project">Project <strong>${esc(projectLabel)}</strong> <kbd>⌘K</kbd></button>
<button type="button" class="chip" popovertarget="pop-member" aria-haspopup="dialog">Member <strong>${esc(memberLabel)}</strong></button>
<button type="button" class="chip" popovertarget="pop-status" aria-haspopup="dialog">Status <strong>${esc(statusLabel)}</strong></button>
<form class="search" method="get" action="/" role="search">${hidden("project", f.project)}${hidden("member", f.member)}${hidden("status", f.status)}<input type="search" name="q" value="${esc(f.q)}" placeholder="Search code or title" aria-label="Search tasks"></form>
<a class="btn primary" href="/new"${page === "new" ? "" : ' data-dialog-open="new-task"'}>New task</a>
<button type="button" class="chip alerts-btn" popovertarget="pop-alerts" aria-haspopup="dialog">Alerts <span class="count${alertTotal ? " is-on" : ""}" data-alert-total>${alertTotal}</span></button>
<button type="button" class="user-btn" popovertarget="user-menu" aria-haspopup="dialog"><span class="avatar" aria-hidden="true">${esc(initials(email, email))}</span><span class="uname">${esc(email)}</span></button>
</header>
<div class="body">
<nav class="sidebar" aria-label="Workspace">
<div class="nav-links">
${nav("board", boardHref(f), "Board")}
${nav("done", doneHref(f), "Done")}
${nav("alerts", "/alerts", "Alerts")}
${nav("members", "/members", "Members")}
</div>
${projects}
</nav>
<main id="main" class="${board ? "board-main" : page === "task" ? "task-main" : page === "done" || page === "alerts" || page === "members" ? "page-fill" : "page-scroll"}">${main}</main>
</div>
</div>
<div id="pop-member" popover><form method="get" action="/">${hidden("project", f.project)}${hidden("status", f.status)}${hidden("q", f.q)}<label>Member<br><select name="member">${memberOpts}</select></label><p><button>Apply</button></p></form>
<ul class="quick">${chrome.members.map((m) => `<li><a href="/m/${esc(m.id)}">${esc(m.name)} <span class="muted">${m.open_n}</span></a></li>`).join("")}</ul>
<a href="/members">All members</a></div>
<div id="pop-status" popover><form method="get" action="/">${hidden("project", f.project)}${hidden("member", f.member)}${hidden("q", f.q)}<label>Status<br><select name="status">${statusOpts}</select></label><p><button>Apply</button> <a href="${esc(pendingHref(f.project))}">Pending approval</a> <a href="/">Clear</a></p></form></div>
<div id="pop-alerts" popover><p><strong>Open alerts</strong></p><ul class="quick">${chrome.alerts.map((a) => `<li><a href="/alerts">${esc(RULE_LABEL[a.rule] ?? a.rule)} <b>${a.n}</b></a></li>`).join("") || "<li>No open alerts</li>"}</ul><a href="/alerts">View alerts</a></div>
<div id="user-menu" popover><p class="user-email">${esc(email)}</p><p class="muted">${esc(tzLabel(chrome.tz))}</p>${logout}</div>
${dialogs}
<noscript><style>.ie-form[hidden]{display:flex !important}.ie-view{display:none !important}</style></noscript>
<script src="/assets/dashboard.js" defer></script>
</body></html>`;
}

function boardSearch(f: Filters): string {
  return withQuery("", [["project", f.project], ["member", f.member], ["status", f.status], ["q", f.q]]).replace(/^\?/, "");
}

function renderBoardMain(chrome: Chrome, rows: CardRow[], doneTotal: number, now: number): string {
  const f = chrome.filters;
  const cols: Status[] = f.status && f.status !== "cancelled" ? [f.status] : BOARD_COLS;
  const lanes = f.project ? chrome.projects.filter((p) => p.code === f.project) : chrome.projects;
  const single = lanes.length === 1;
  const collapsed = !single && lanes.length > 3;
  const see = `<a href="${esc(doneHref(f))}">See all (${doneTotal})</a>`;
  const heads = `<div class="colheads"><div class="colhead-label">Project</div>${cols.map((s) => `<div class="colh s-${s}" data-status="${s}"><span class="badge">${esc(STATUS_LABEL[s])}</span> <span data-col-count>${rows.filter((r) => r.status === s).length}</span>${s === "done" ? ` ${see}` : ""}</div>`).join("")}</div>`;
  const laneHtml = lanes.map((p) => {
    const counts = cols.map((s) => `<span class="lane-count" data-count-for="${esc(p.code)}" data-status="${s}" title="${esc(STATUS_LABEL[s])}">${rows.filter((r) => r.project_code === p.code && r.status === s).length}</span>`).join("");
    const label = `<span class="lane-label"><span class="chev" aria-hidden="true"></span><span class="lane-id">${esc(p.code)}</span><span class="lane-name">${esc(p.name)}</span></span>`;
    const grid = `<div class="lane-grid"><div class="lane-side"><a href="/p/${esc(p.code)}">Project</a></div>${cols.map((s) => `<div class="cell" data-project="${esc(p.code)}" data-status="${s}"><div class="cell-label s-${s}">${esc(STATUS_LABEL[s])}</div>${rows.filter((r) => r.project_code === p.code && r.status === s).map((r) => card(r, now, chrome.tz)).join("")}</div>`).join("")}</div>`;
    if (single) return `<section class="lane is-fill" data-lane="${esc(p.code)}" data-lock-open="1"><div class="summary">${label}${counts}</div>${grid}</section>`;
    return `<details class="lane" data-lane="${esc(p.code)}"${collapsed ? "" : " open"}><summary>${label}${counts}</summary>${grid}</details>`;
  }).join("");
  const showCancelled = !f.status || f.status === "cancelled";
  const cancelled = rows.filter((r) => r.status === "cancelled");
  const cancelledBox = showCancelled ? `<details class="cancelled"${f.status === "cancelled" ? " open" : ""}><summary>Cancelled (${cancelled.length})</summary><div class="cancelled-list">${lanes.map((p) => `<div class="cell" data-project="${esc(p.code)}" data-status="cancelled">${cancelled.filter((r) => r.project_code === p.code).map((r) => card(r, now, chrome.tz)).join("")}</div>`).join("")}</div></details>` : "";
  const tools = `<div class="board-tools">${lanes.length > 1 ? `<button type="button" data-lanes="open">Expand all</button><button type="button" data-lanes="close">Collapse all</button>` : ""}<span class="stamp" data-poll-stamp></span></div>`;
  const empty = lanes.length ? "" : `<p class="empty">No project matches this filter.</p>`;
  return `${tools}<div id="board" class="board${single ? " is-single" : ""}" style="--cols:${cols.length}">${heads}<div class="lanes">${laneHtml}${empty}${cancelledBox}</div></div>`;
}

function doc(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Status Hub</title><style>${CSS}</style></head>${body}</html>`;
}

export function renderLogin(error?: string, next?: string): string {
  const org = getHubConfig().orgName;
  const nextField = next ? `<input type="hidden" name="next" value="${esc(next)}">` : "";
  const err = error ? `<p class="flag">${esc(error)}</p>` : "";
  return doc("Log in", `<body class="login-body"><main class="login-card"><p class="muted">${esc(org)}</p><h1>Log in</h1>${err}
<form method="post" action="/login">${nextField}
<p><label>Login token<br><input type="password" name="token" autocomplete="current-password" required></label></p>
<button type="submit">Log in</button></form>
<p class="muted">Ask an operator for a login token. The token is stored only as a hash.</p>
</main></body>`);
}

export async function renderBoard(db: D1Database, url: URL, email: string, now = Date.now()) {
  const chrome = await loadChrome(db, url);
  const { rows, doneTotal } = await loadCards(db, chrome.filters);
  return shell("Board", renderBoardMain(chrome, rows, doneTotal, now), email, chrome, "board", true);
}

export async function boardJson(db: D1Database, url: URL, now = Date.now()): Promise<BoardJson> {
  const chrome = await loadChrome(db, url);
  const { rows, doneTotal } = await loadCards(db, chrome.filters);
  const f = chrome.filters;
  return {
    project: f.project,
    member: f.member,
    status: f.status,
    q: f.q,
    doneTotal,
    alertTotal: chrome.alerts.reduce((sum, a) => sum + a.n, 0),
    alerts: chrome.alerts.map((a) => ({ rule: a.rule, label: RULE_LABEL[a.rule] ?? a.rule, n: a.n })),
    projects: chrome.projects.map((p) => ({ code: p.code, name: p.name, open: p.open_n, alerts: p.alert_n })),
    cards: rows.map((c) => ({ code: c.code, project_code: c.project_code, status: c.status, rev: cardRev(c), html: card(c, now, chrome.tz) })),
  };
}

export async function renderNewTask(db: D1Database, email: string, url = new URL("https://local/")) {
  const chrome = await loadChrome(db, url);
  return shell("New task", `<h2>New task</h2>${newTaskForm(chrome.requesters)}`, email, chrome, "new", false);
}

export async function renderDone(db: D1Database, url: URL, email: string, now = Date.now()) {
  const chrome = await loadChrome(db, url);
  const where = ["t.status = 'done'"];
  const binds: unknown[] = [];
  applyScope(chrome.filters, where, binds, false);
  const { results } = await db.prepare(`${CARD_SQL} WHERE ${where.join(" AND ")} ORDER BY t.done_at DESC, t.code DESC`).bind(...binds).all();
  const rows = asCards(results);
  const title = chrome.filters.project ? `Done · ${chrome.filters.project}` : "Done";
  const cards = rows.map((c) => card(c, now, chrome.tz)).join("") || `<p class="empty">No done tasks.</p>`;
  const body = `<p class="back"><a href="${esc(boardHref(chrome.filters))}">Back to board</a></p><div class="sheets"><section class="sheet"><h2 class="sheet-h">${esc(title)} (${rows.length})</h2><div class="sheet-scroll">${cards}</div></section></div>`;
  return shell(title, body, email, chrome, "done", false);
}

function reqCell(v: unknown): string {
  return v ? esc(v) : "Not set";
}

const TASK_TABS = ["overview", "timeline", "history", "blockers"] as const;
type TaskTab = (typeof TASK_TABS)[number];
export interface TaskNotice { error?: string; field?: string; value?: string; pr_url?: string }

function taskTabOf(raw?: string | null): TaskTab {
  return (TASK_TABS as readonly string[]).includes(raw ?? "") ? raw as TaskTab : "overview";
}

const ICON_PEN = `<svg class="ie-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M11.2 2.8l2 2L5.5 12.5 3 13l.5-2.5 7.7-7.7z"/></svg>`;
const ICON_OK = `<svg class="ie-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M3 8.5 6.5 12 13 4"/></svg>`;
const ICON_X = `<svg class="ie-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8"/></svg>`;

function dueInputValue(ms: number | null | undefined, offsetMinutes: number): string {
  if (!ms) return "";
  const d = new Date(ms + offsetMinutes * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** Value with a pencil. The editor (input, check, x) replaces the value in place. */
function inlineEdit(opts: {
  action: string; name: string; label: string; kind: "url" | "links" | "text" | "time";
  value: string; display: string; editable: boolean; error?: string; draft?: string;
  inputType?: string; options?: { value: string; label: string }[];
}): string {
  const shown = opts.display || `<span class="muted">—</span>`;
  if (!opts.editable) return `<span class="ie-value">${shown}</span>`;
  const open = !!opts.error;
  const draft = opts.draft ?? opts.value;
  const control = opts.options
    ? `<select name="${esc(opts.name)}" aria-label="${esc(opts.label)}" data-original="${esc(opts.value)}">${opts.options.map((o) => `<option value="${esc(o.value)}"${o.value === draft ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`
    : `<input name="${esc(opts.name)}" type="${opts.inputType || "text"}" value="${esc(draft)}" data-original="${esc(opts.value)}" aria-label="${esc(opts.label)}">`;
  return `<form class="inline-edit${open ? " is-editing" : ""}" method="post" action="${esc(opts.action)}" data-inline-edit data-inline-kind="${opts.kind}" novalidate>
<span class="ie-view"${open ? " hidden" : ""}><span class="ie-value">${shown}</span><button type="button" class="ie-pen" data-inline-open aria-label="Edit ${esc(opts.label)}">${ICON_PEN}</button></span>
<span class="ie-form"${open ? "" : " hidden"}>${control}<button type="submit" class="ie-save" aria-label="Save ${esc(opts.label)}">${ICON_OK}</button><button type="button" class="ie-cancel" data-inline-cancel aria-label="Cancel ${esc(opts.label)}">${ICON_X}</button></span>
<span class="ie-msg" role="status">${opts.error ? esc(opts.error) : ""}</span></form>`;
}

function sheet(tag: "h2" | "h3", title: string, inner: string, fit = false): string {
  return `<section class="sheet${fit ? " sheet-fit" : ""}"><${tag} class="sheet-h">${title}</${tag}><div class="sheet-scroll">${inner}</div></section>`;
}

function taskTabBtn(id: TaskTab, label: string, active: TaskTab): string {
  const on = id === active;
  return `<a role="tab" id="tab-${id}" href="?tab=${id}" data-tab="${id}" aria-selected="${on ? "true" : "false"}" aria-controls="panel-${id}" tabindex="${on ? "0" : "-1"}">${label}</a>`;
}

function taskPanel(id: TaskTab, active: TaskTab, body: string): string {
  const on = id === active;
  return `<section role="tabpanel" id="panel-${id}" class="task-panel${on ? " is-on" : ""}" data-tab-panel="${id}" aria-labelledby="tab-${id}"${on ? "" : " hidden"}>${body}</section>`;
}

async function taskDetail(db: D1Database, code: string, email: string, now: number, notice?: TaskNotice, tab?: string | null): Promise<string | null> {
  const t = await db.prepare(`${CARD_SQL} WHERE t.code = ?`).bind(code).first<CardRow>();
  if (!t) return null;
  const full = await db.prepare("SELECT * FROM tasks WHERE code = ?").bind(code).first<Record<string, unknown>>();
  if (!full) return null;
  const [u, b, sp, fb, mem] = await db.batch([
    db.prepare("SELECT * FROM updates WHERE task_code = ? ORDER BY at DESC, id DESC LIMIT 100").bind(code),
    db.prepare("SELECT * FROM blockers WHERE task_code = ? ORDER BY opened_at DESC").bind(code),
    db.prepare("SELECT id, status, started_at, ended_at, member_id FROM status_periods WHERE task_code = ? ORDER BY started_at, id").bind(code),
    db.prepare("SELECT id, author, note, at, read_by FROM feedback WHERE task_code = ? ORDER BY at DESC, id DESC LIMIT 100").bind(code),
    db.prepare("SELECT id FROM members WHERE active = 1 ORDER BY id"),
  ]);
  const tz = (await loadSettings(db)).tz_offset_minutes;
  const row = asCards([t])[0]!;
  const actor = await memberForAccessEmail(db, email);
  const canEdit = !!actor && (isLeader(actor) || actor.id === row.assignee_id);
  const canAssign = !!actor && isLeader(actor) && row.status !== "done" && row.status !== "cancelled" && row.status !== "pending_approval";
  const memberIds = (mem.results as { id: string }[]).map((m) => m.id);
  const memberOptions = memberIds.map((id) => ({ value: id, label: id }));
  const action = `/t/${encodeURIComponent(code)}`;
  const errField = notice?.field ?? (notice?.error && notice.pr_url !== undefined ? "pr_url" : "");
  const errValue = notice?.value ?? notice?.pr_url ?? "";
  const fieldError = (name: string) => (errField === name ? notice?.error : undefined);
  const fieldDraft = (name: string, saved: string) => (errField === name ? errValue : saved);
  const per = summarizePeriods(sp.results as unknown as PeriodRow[], now);
  const badge = (st: Status) => `<span class="s-${st}"><span class="badge">${esc(STATUS_LABEL[st] ?? st)}</span></span>`;
  const periodRows = per.timeline.map((p) => `<tr><td>${badge(p.status)}</td><td>${fmt(p.started_at, tz)}</td><td>${p.open ? "<i>current</i>" : fmt(p.ended_at, tz)}</td><td>${p.duration}</td><td>${esc(p.member_id ?? "")}</td></tr>`).join("") || `<tr><td colspan="5">—</td></tr>`;
  const periodsTable = `<table class="periods"><thead><tr><th>Status</th><th>Started</th><th>Ended</th><th>Duration</th><th>By</th></tr></thead><tbody>${periodRows}</tbody></table>`;
  const totalHeads = STATUSES.filter((st) => per.totals[st]);
  const totalsTable = `<table class="totals"><thead><tr><th>Totals by status</th>${totalHeads.map((st) => `<th>${badge(st)}</th>`).join("")}</tr></thead><tbody><tr><td></td>${totalHeads.map((st) => `<td>${per.totals[st].duration}${per.totals[st].periods > 1 ? ` <small>(${per.totals[st].periods} times)</small>` : ""}</td>`).join("")}</tr></tbody></table>`;
  const updates = (u.results as Record<string, unknown>[]).map((x) => ({
    at: Number(x.at), id: Number(x.id), who: String(x.member_id),
    status: `${x.status_from ?? ""} → ${x.status_to ?? ""}`,
    note: `${esc(x.note)}${x.approved_by ? ` · approved by ${esc(x.approved_by)}` : ""}${x.links ? `<br>${linkList(String(x.links))}` : ""}`,
    links: x.links,
  }));
  let linkValue = "";
  for (const x of u.results as Record<string, unknown>[]) {
    if (!x.links) continue;
    try {
      const parsed = JSON.parse(String(x.links));
      if (Array.isArray(parsed)) {
        linkValue = parsed.filter((item): item is string => typeof item === "string").join(" ");
        break;
      }
    } catch { /* keep looking */ }
  }
  const linkDisplay = linkValue.split(/\s+/).filter(Boolean).map((href) => externalAnchor(href)).join("<br>") || "";
  const feedback = (fb.results as Record<string, unknown>[]).map((x) => ({
    at: Number(x.at), who: String(x.author), note: esc(x.note),
    unread: x.read_by == null || String(x.read_by) === "" || String(x.read_by) !== (row.assignee_id ?? ""),
  }));
  const unread = feedback.filter((x) => x.unread).length;
  const author = leadershipAuthor(email);
  const feedbackForm = author ? `<form method="post" action="/t/${esc(code)}/feedback" class="feedback-dock"><textarea name="note" maxlength="500" required rows="1" aria-label="Leadership feedback"></textarea><button type="submit">Send</button></form>` : "";
  const feedbackTable = `<table><thead><tr><th>When</th><th>Who</th><th>Note</th></tr></thead><tbody>${feedback.map((x) => `<tr class="lead"><td>${fmt(x.at, tz)}</td><td>${esc(x.who)}</td><td>${x.note}</td></tr>`).join("") || `<tr><td colspan="3">—</td></tr>`}</tbody></table>`;
  const reqLink = full.request_link ? externalAnchor(String(full.request_link)) : "Not set";
  const prValue = full.pr_url ? String(full.pr_url) : "";
  const dueValue = dueInputValue(full.due_at as number | null, tz);
  const reviewerValue = full.reviewer_id ? String(full.reviewer_id) : "";
  const assigneeValue = row.assignee_id ?? "";
  const active = taskTabOf(tab);
  const overviewBadge = unread ? ` <span class="count is-on">${unread}</span>` : "";
  const fieldRow = (label: string, value: string) => `<tr><th scope="row">${label}</th><td>${value}</td></tr>`;
  const overview = `<div class="tab-scroll"><h2>${esc(code)}</h2>
<table class="fields"><tbody>
${fieldRow("Title", esc(row.title))}
${fieldRow("Status", badge(row.status))}
${fieldRow("Feature", `${esc(row.feature_code)} · ${esc(row.feature_title)}`)}
${fieldRow("Requested by", reqCell(full.requested_by))}
${fieldRow("Requested at", full.requested_at ? fmt(Number(full.requested_at), tz) : "Not set")}
${fieldRow("Request link", reqLink)}
${fieldRow("Assignee", inlineEdit({ action, name: "assignee", label: "Assignee", kind: "text", value: fieldDraft("assignee", assigneeValue), display: assigneeValue ? esc(assigneeValue) : "", editable: canAssign, error: fieldError("assignee"), draft: fieldDraft("assignee", assigneeValue), options: memberOptions }))}
${fieldRow("Reviewer", inlineEdit({ action, name: "reviewer", label: "Reviewer", kind: "text", value: fieldDraft("reviewer", reviewerValue), display: reviewerValue ? esc(reviewerValue) : "", editable: canEdit, error: fieldError("reviewer"), draft: fieldDraft("reviewer", reviewerValue), options: [{ value: "", label: "—" }, ...memberOptions] }))}
${fieldRow("Assigned at", fmt(full.assigned_at as number | null, tz))}
${fieldRow("Started", fmt(full.started_at as number | null, tz))}
${fieldRow("Due", inlineEdit({ action, name: "due_at", label: "Due", kind: "time", value: fieldDraft("due_at", dueValue), display: fmt(full.due_at as number | null, tz) === "—" ? "" : fmt(full.due_at as number | null, tz), editable: canEdit, error: fieldError("due_at"), draft: fieldDraft("due_at", dueValue), inputType: "datetime-local" }))}
${fieldRow("Done at", fmt(full.done_at as number | null, tz))}
${fieldRow("PR", inlineEdit({ action, name: "pr_url", label: "PR URL", kind: "url", value: prValue, display: prValue ? externalAnchor(prValue) : "", editable: canEdit, error: fieldError("pr_url"), draft: fieldDraft("pr_url", prValue), inputType: "url" }))}
${fieldRow("Links", inlineEdit({ action, name: "links", label: "Links", kind: "links", value: linkValue, display: linkDisplay, editable: canEdit, error: fieldError("links"), draft: fieldDraft("links", linkValue) }))}
</tbody></table></div>
<section class="feedback-pane"><h3 class="sheet-h">Feedback</h3><div class="sheet-scroll">${feedbackTable}</div></section>
${feedbackForm}`;
  const historyTable = `<table><thead><tr><th>When</th><th>Who</th><th>Status</th><th>Note</th></tr></thead><tbody>${updates.map((x) => `<tr><td>${fmt(x.at, tz)}</td><td>${esc(x.who)}</td><td>${esc(x.status)}</td><td>${x.note}</td></tr>`).join("") || `<tr><td colspan="4">—</td></tr>`}</tbody></table>`;
  const blockerTable = `<table><thead><tr><th>#</th><th>Kind</th><th>Waiting on</th><th>Detail</th><th>Opened</th><th>Closed</th></tr></thead><tbody>${(b.results as Record<string, unknown>[]).map((x) => `<tr><td>${esc(x.id)}</td><td>${esc(x.kind)}</td><td>${esc(x.waiting_on)}</td><td>${esc(x.detail)}</td><td>${fmt(Number(x.opened_at), tz)} (${ago(Number(x.opened_at), now)})</td><td>${fmt(x.resolved_at as number | null, tz)}</td></tr>`).join("") || `<tr><td colspan="6">—</td></tr>`}</tbody></table>`;
  return `<div id="task-detail" class="task" data-task-tabs>
<div class="task-tabs" role="tablist" aria-label="Task sections">${taskTabBtn("overview", `Overview${overviewBadge}`, active)}${taskTabBtn("timeline", "Timeline", active)}${taskTabBtn("history", "History", active)}${taskTabBtn("blockers", "Blockers", active)}</div>
${taskPanel("overview", active, overview)}
${taskPanel("timeline", active, `${sheet("h3", "Time in status", periodsTable)}${sheet("h3", "Totals", totalsTable, true)}`)}
${taskPanel("history", active, sheet("h3", "History", historyTable))}
${taskPanel("blockers", active, sheet("h3", "Blockers", blockerTable))}
</div>`;
}

export async function renderTask(db: D1Database, code: string, email: string, now = Date.now(), notice?: TaskNotice, tab?: string | null) {
  const detail = await taskDetail(db, code, email, now, notice, tab);
  if (!detail) return null;
  const task = await db.prepare("SELECT project_code FROM tasks WHERE code = ?").bind(code).first<{ project_code: string }>();
  const url = new URL(`https://local/?project=${encodeURIComponent(task?.project_code ?? "")}`);
  const chrome = await loadChrome(db, url);
  const back = boardHref(chrome.filters);
  return shell(code, `<p class="back"><a href="${esc(back)}">Back to board</a></p>${detail}`, email, chrome, "task", false);
}

export async function renderTaskFragment(db: D1Database, code: string, email: string, now = Date.now(), notice?: TaskNotice, tab?: string | null) {
  return taskDetail(db, code, email, now, notice, tab);
}

export async function renderProject(db: D1Database, code: string, email: string) {
  const p = await db.prepare("SELECT * FROM projects WHERE code = ?").bind(code).first<Record<string, unknown>>();
  if (!p) return null;
  const [mods, feats] = await db.batch([
    db.prepare("SELECT * FROM modules WHERE project_code = ? ORDER BY code").bind(code),
    db.prepare(`SELECT f.code, f.module_code, f.title, f.priority, f.owner_id,
      (SELECT COUNT(*) FROM tasks t WHERE t.feature_code = f.code AND t.status != 'cancelled') AS total,
      (SELECT COUNT(*) FROM tasks t WHERE t.feature_code = f.code AND t.status = 'done') AS done
      FROM features f WHERE f.project_code = ? ORDER BY f.code`).bind(code),
  ]);
  const fs = feats.results as Record<string, unknown>[];
  const chrome = await loadChrome(db, new URL(`https://local/?project=${encodeURIComponent(code)}`));
  const actor = await memberForAccessEmail(db, email);
  const leader = !!actor && isLeader(actor);
  const priorities = ["P0", "P1", "P2", "P3"].map((id) => ({ value: id, label: id }));
  const repo = p.repo_url ? externalAnchor(String(p.repo_url), "repo") : "";
  const body = `<h2>${esc(p.code)} · ${esc(p.name)}</h2><p>Owner: ${esc(p.owner_id)} ${repo ? `· ${repo}` : ""} · <a href="${esc(boardHref(chrome.filters))}">Board</a></p>
${(mods.results as Record<string, unknown>[]).map((m) => `<h3>${esc(m.code)} · ${esc(m.name)}</h3><div class="sheet-scroll"><table><thead><tr><th>Feature</th><th>Priority</th><th>Owner</th><th>Progress</th></tr></thead><tbody>
${fs.filter((f) => f.module_code === m.code).map((f) => `<tr><td><a href="${esc(boardHref(chrome.filters))}">${esc(f.code)}</a> ${esc(f.title)}</td><td>${inlineEdit({ action: `/f/${encodeURIComponent(String(f.code))}`, name: "priority", label: "Priority", kind: "text", value: String(f.priority), display: esc(f.priority), editable: leader, options: priorities })}</td><td>${esc(f.owner_id)}</td><td>${Number(f.total) ? Math.round((100 * Number(f.done)) / Number(f.total)) : 0}% (${esc(f.done)}/${esc(f.total)})</td></tr>`).join("") || "<tr><td colspan=4>—</td></tr>"}</tbody></table></div>`).join("")}`;
  return shell(code, body, email, chrome, "project", false);
}

export async function renderAlerts(db: D1Database, email: string, now = Date.now()) {
  const tz = (await loadSettings(db)).tz_offset_minutes;
  const cfg = getHubConfig();
  const [a, b] = await db.batch([
    db.prepare(`SELECT a.rule, a.fired_at, t.code, t.title, t.assignee_id, t.assigned_at, t.last_update_at FROM alerts a
      JOIN tasks t ON t.code = a.task_code WHERE a.cleared_at IS NULL ORDER BY a.rule, a.fired_at`),
    db.prepare(`SELECT b.*, t.title FROM blockers b JOIN tasks t ON t.code = b.task_code WHERE b.resolved_at IS NULL ORDER BY b.opened_at`),
  ]);
  const blockers = (b.results as Record<string, unknown>[]).slice().sort((x, y) => {
    const rank = waitingRank(String(x.waiting_on), cfg) - waitingRank(String(y.waiting_on), cfg);
    return rank || Number(x.opened_at) - Number(y.opened_at);
  });
  const chrome = await loadChrome(db, new URL("https://local/"));
  const blockerTable = `<table><thead><tr><th>Task</th><th>Waiting on</th><th>Detail</th><th>Opened</th></tr></thead><tbody>${blockers.map((x) => `<tr><td><a href="/t/${esc(x.task_code)}">${esc(x.task_code)}</a> ${esc(x.title)}</td><td><b>${esc(x.waiting_on)}</b></td><td>${esc(x.detail)}</td><td>${fmt(Number(x.opened_at), tz)} (${ago(Number(x.opened_at), now)})</td></tr>`).join("") || `<tr><td colspan="4">—</td></tr>`}</tbody></table>`;
  const alertTable = `<table><thead><tr><th>Rule</th><th>Task</th><th>Member</th><th>Assigned</th><th>Last update</th></tr></thead><tbody>${(a.results as Record<string, unknown>[]).map((x) => `<tr><td>${esc(RULE_LABEL[String(x.rule)] ?? String(x.rule))}</td><td><a href="/t/${esc(x.code)}">${esc(x.code)}</a> ${esc(x.title)}</td><td><a href="/m/${esc(x.assignee_id)}">${esc(x.assignee_id)}</a></td><td>${fmt(x.assigned_at as number | null, tz)} (${ago(x.assigned_at as number | null, now)})</td><td>${fmt(Number(x.last_update_at), tz)}</td></tr>`).join("") || `<tr><td colspan="5">—</td></tr>`}</tbody></table>`;
  const body = `<div class="sheets">${sheet("h2", "Open blockers", blockerTable)}${sheet("h2", "Alerts", alertTable)}</div>`;
  return shell("Alerts", body, email, chrome, "alerts", false);
}

export async function renderMembers(db: D1Database, email: string) {
  const { results } = await db.prepare(`SELECT m.id, m.name, m.role, m.is_admin, (m.token_hash IS NOT NULL) AS has_token,
    (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = m.id AND t.status IN ('assigned','in_progress','review','blocked')) AS open,
    (SELECT COUNT(*) FROM alerts a JOIN tasks t ON t.code = a.task_code WHERE t.assignee_id = m.id AND a.cleared_at IS NULL) AS alerts
    FROM members m WHERE m.active = 1 ORDER BY m.is_admin DESC, m.id`).all<Record<string, unknown>>();
  const chrome = await loadChrome(db, new URL("https://local/"));
  const table = `<table><thead><tr><th>Member</th><th>Role</th><th>Token</th><th>Open tasks</th><th>Alerts</th></tr></thead><tbody>${results.map((m) => `<tr><td><a href="/m/${esc(m.id)}">${esc(m.name)}</a></td><td>${esc(m.role)}${m.is_admin ? " · admin" : ""}</td><td>${m.has_token ? "yes" : "none"}</td><td>${esc(m.open)}</td><td>${esc(m.alerts)}</td></tr>`).join("")}</tbody></table>`;
  const body = `<div class="sheets">${sheet("h2", "Members", table)}</div>`;
  return shell("Members", body, email, chrome, "members", false);
}

export async function renderMember(db: D1Database, id: string, email: string, now = Date.now()) {
  const m = await db.prepare("SELECT * FROM members WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!m) return null;
  const [cards, ups, ns] = await db.batch([
    db.prepare(`${CARD_SQL} WHERE t.assignee_id = ? AND t.status IN ('assigned','in_progress','review','blocked') ORDER BY t.last_update_at DESC`).bind(id),
    db.prepare("SELECT * FROM updates WHERE member_id = ? ORDER BY at DESC LIMIT 30").bind(id),
    db.prepare(`SELECT COUNT(*) AS n FROM alerts a JOIN tasks t ON t.code = a.task_code WHERE a.rule = 'NOT_STARTED' AND t.assignee_id = ? AND a.fired_at >= ?`).bind(id, now - 7 * 86_400_000),
  ]);
  const chrome = await loadChrome(db, new URL(`https://local/?member=${encodeURIComponent(id)}`));
  const rows = asCards(cards.results);
  const body = `<h2>${esc(m.name)} <small>(${esc(m.role)})</small></h2><p>Not-started alerts in the last 7 days: <b>${esc((ns.results[0] as { n: number }).n)}</b></p>
${rows.map((c) => card(c, now, chrome.tz)).join("") || `<p class="empty">No open tasks.</p>`}
<h3>Timeline</h3><div class="sheet-scroll"><table><thead><tr><th>When</th><th>Task</th><th>Status</th><th>Note</th></tr></thead><tbody>${(ups.results as Record<string, unknown>[]).map((x) => `<tr><td>${fmt(Number(x.at), chrome.tz)}</td><td><a href="/t/${esc(x.task_code)}">${esc(x.task_code)}</a></td><td>${esc(x.status_from ?? "")} → ${esc(x.status_to ?? "")}</td><td>${esc(x.note)}</td></tr>`).join("")}</tbody></table></div>`;
  return shell(String(m.name), body, email, chrome, "member", false);
}
