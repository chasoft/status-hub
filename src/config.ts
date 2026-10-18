// Deployment settings. Values come from Worker env vars, not from request data.
// The active config is deployment-wide: every request in an isolate sees the same env.

export interface HubConfig {
  /** Ids that may be waiting_on, requested_by, and approved_by. Not necessarily member ids. */
  ownerIds: string[];
  /** Ids that may be waiting_on, requested_by, and approved_by. Not necessarily member ids. */
  approverIds: string[];
  /** Name advertised by the MCP server. */
  mcpServerName: string;
  /** Name shown in the UI header. */
  orgName: string;
  /** Lowercase email → members.id for UI sessions whose local-part is not the member id. */
  emailMembers: Record<string, string>;
  /** Lowercase email → display name stored on leadership feedback. */
  leadershipAuthors: Record<string, string>;
  /** When set, overrides the settings table. */
  notStartedMinutes?: number;
  staleHours?: number;
  staleWorkStartHour?: number;
  staleWorkEndHour?: number;
  blockedHours?: number;
  /** Minutes east of UTC. 0 is UTC. When unset, the settings table (default 0) is used. */
  tzOffsetMinutes?: number;
  /** UI auth. Only "token" changes the pages; every other mode stays on the Access chrome. */
  authMode: "access" | "token";
  /** Release label shown in the sidebar, for example 1.0.123. "dev" when unset. */
  appVersion: string;
}

export interface ConfigEnv {
  OWNER_IDS?: string;
  APPROVER_IDS?: string;
  MCP_SERVER_NAME?: string;
  ORG_NAME?: string;
  UI_MEMBER_EMAILS?: string;
  LEADERSHIP_AUTHORS?: string;
  NOT_STARTED_MINUTES?: string;
  STALE_HOURS?: string;
  STALE_WORK_START_HOUR?: string;
  STALE_WORK_END_HOUR?: string;
  BLOCKED_HOURS?: string;
  TZ_OFFSET_MINUTES?: string;
  AUTH_MODE?: string;
  APP_VERSION?: string;
}

const DEFAULTS: HubConfig = {
  ownerIds: [],
  approverIds: [],
  mcpServerName: "status-hub",
  orgName: "Status Hub",
  emailMembers: {},
  leadershipAuthors: {},
  authMode: "access",
  appVersion: "dev",
};

let active: HubConfig = DEFAULTS;

export function useHubConfig(cfg: HubConfig) {
  active = cfg;
}

export function getHubConfig(): HubConfig {
  return active;
}

export function parseCsv(value: string | undefined): string[] {
  const seen = new Set<string>();
  for (const part of (value ?? "").split(",")) {
    const id = part.trim();
    if (id) seen.add(id);
  }
  return [...seen];
}

/** Parse `email=value,email2=value2`. Emails are lowercased. */
export function parsePairs(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (value ?? "").split(",")) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    const email = item.slice(0, eq).trim().toLowerCase();
    const mapped = item.slice(eq + 1).trim();
    if (email && mapped) out[email] = mapped;
  }
  return out;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Keep a short, URL-safe label. Anything else falls back to "dev". */
function cleanVersion(value: string | undefined): string {
  const v = value?.trim().replace(/^v/i, "") ?? "";
  return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/.test(v) ? v : DEFAULTS.appVersion;
}

export function configFromEnv(env: ConfigEnv): HubConfig {
  const mcpServerName = env.MCP_SERVER_NAME?.trim() || DEFAULTS.mcpServerName;
  const orgName = env.ORG_NAME?.trim() || DEFAULTS.orgName;
  return {
    ownerIds: parseCsv(env.OWNER_IDS),
    approverIds: parseCsv(env.APPROVER_IDS),
    mcpServerName,
    orgName,
    emailMembers: parsePairs(env.UI_MEMBER_EMAILS),
    leadershipAuthors: parsePairs(env.LEADERSHIP_AUTHORS),
    notStartedMinutes: optionalNumber(env.NOT_STARTED_MINUTES),
    staleHours: optionalNumber(env.STALE_HOURS),
    staleWorkStartHour: optionalNumber(env.STALE_WORK_START_HOUR),
    staleWorkEndHour: optionalNumber(env.STALE_WORK_END_HOUR),
    blockedHours: optionalNumber(env.BLOCKED_HOURS),
    tzOffsetMinutes: optionalNumber(env.TZ_OFFSET_MINUTES),
    authMode: env.AUTH_MODE?.trim().toLowerCase() === "token" ? "token" : "access",
    appVersion: cleanVersion(env.APP_VERSION),
  };
}

export function isOwnerId(id: string, cfg: HubConfig = active): boolean {
  return cfg.ownerIds.includes(id);
}

export function isApproverId(id: string, cfg: HubConfig = active): boolean {
  return cfg.approverIds.includes(id);
}

/** Owner or approver id configured for this deployment. */
export function isPrivilegedId(id: string, cfg: HubConfig = active): boolean {
  return isOwnerId(id, cfg) || isApproverId(id, cfg);
}

/** 0 for owners, 1 for approvers, 2 for everyone else. Owners win when an id is in both lists. */
export function waitingRank(id: string, cfg: HubConfig = active): number {
  if (isOwnerId(id, cfg)) return 0;
  if (isApproverId(id, cfg)) return 1;
  return 2;
}
