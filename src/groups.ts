// Grouping and table sort. Order of the input is the order inside a group.
// Kanban passes minSize 2 so a lone task stays a plain card: a header on one
// card is taller than the card and a column of unrelated tasks would become a
// stack of headers. The table passes minSize 1 so every feature has the same
// tint and collapse control.

export const SORT_KEYS = [
  "code", "title", "project", "feature", "status", "assignee", "reviewer", "priority", "due", "time", "pr",
] as const;

export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

const STATUS_RANK: Record<string, number> = {
  pending_approval: 0,
  backlog: 1,
  assigned: 2,
  in_progress: 3,
  review: 4,
  blocked: 5,
  done: 6,
  cancelled: 7,
};

export interface SortableTask {
  code: string;
  title: string;
  project_code: string;
  feature_code: string;
  feature_title: string;
  status: string;
  assignee_id: string | null;
  reviewer_id: string | null;
  priority: string | null;
  due_at: number | null;
  pr_url: string | null;
  status_since: number | null;
  last_update_at: number;
}

export type Cluster<T> =
  | { kind: "group"; feature_code: string; feature_title: string; tasks: T[] }
  | { kind: "task"; task: T };

export function isSortKey(v: string): v is SortKey {
  return (SORT_KEYS as readonly string[]).includes(v);
}

export function clusterByFeature<T extends { feature_code: string; feature_title: string }>(
  tasks: T[],
  minSize = 2,
): Cluster<T>[] {
  const buckets = new Map<string, T[]>();
  for (const task of tasks) {
    const list = buckets.get(task.feature_code);
    if (list) list.push(task);
    else buckets.set(task.feature_code, [task]);
  }
  const seen = new Set<string>();
  const out: Cluster<T>[] = [];
  for (const task of tasks) {
    const list = buckets.get(task.feature_code)!;
    if (list.length >= minSize) {
      if (seen.has(task.feature_code)) continue;
      seen.add(task.feature_code);
      out.push({
        kind: "group",
        feature_code: task.feature_code,
        feature_title: list[0]!.feature_title,
        tasks: list,
      });
    } else {
      out.push({ kind: "task", task });
    }
  }
  return out;
}

function empty(v: string | number | null): boolean {
  return v == null || v === "";
}

function compareValues(a: string | number | null, b: string | number | null, dir: SortDir): number {
  if (empty(a) && empty(b)) return 0;
  if (empty(a)) return 1;
  if (empty(b)) return -1;
  const sign = dir === "desc" ? -1 : 1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * sign;
  const as = String(a);
  const bs = String(b);
  if (as === bs) return 0;
  return (as < bs ? -1 : 1) * sign;
}

function sortValue(task: SortableTask, key: SortKey, now: number): string | number | null {
  switch (key) {
    case "code": return task.code;
    case "title": return task.title;
    case "project": return task.project_code;
    case "feature": return task.feature_code;
    case "status": return STATUS_RANK[task.status] ?? 99;
    case "assignee": return task.assignee_id;
    case "reviewer": return task.reviewer_id;
    case "priority": return task.priority;
    case "due": return task.due_at;
    case "time": return Math.max(0, now - (task.status_since ?? task.last_update_at));
    case "pr": return task.pr_url;
  }
}

export function sortTasks<T extends SortableTask>(tasks: T[], key: SortKey, dir: SortDir, now: number): T[] {
  return [...tasks].sort((a, b) => {
    const primary = compareValues(sortValue(a, key, now), sortValue(b, key, now), dir);
    if (primary) return primary;
    return compareValues(a.code, b.code, "asc");
  });
}
