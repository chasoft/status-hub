export interface DiffLine {
  kind: "ctx" | "add" | "del";
  text: string;
}

/** Line diff. Shared prefix and suffix stay; the middle is a delete plus an insert. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: "ctx", text: a[i] ?? "" });
  for (let i = start; i <= endA; i++) out.push({ kind: "del", text: a[i] ?? "" });
  for (let i = start; i <= endB; i++) out.push({ kind: "add", text: b[i] ?? "" });
  for (let i = endA + 1; i < a.length; i++) out.push({ kind: "ctx", text: a[i] ?? "" });
  return out;
}
