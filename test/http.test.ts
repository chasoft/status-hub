import { describe, expect, it } from "vitest";
import { accessJwt, fullRequest, issueToken, MCP, mcpCall, UI, worker } from "./helpers";

describe("MCP endpoint", () => {
  it("401 without a valid bearer token", async () => {
    expect((await mcpCall(null, "whoami")).http).toBe(401);
    expect((await mcpCall("shk_peter_" + "x".repeat(43), "whoami")).http).toBe(401);
  });

  it("identity comes from the token", async () => {
    const tok = await issueToken("peter");
    const r = await mcpCall(tok, "whoami");
    expect(r.http).toBe(200);
    expect(r.data).toMatchObject({ id: "peter", role: "dev", admin: false });
  });

  it("wrong-role token gets 403 FORBIDDEN", async () => {
    const tok = await issueToken("jane");
    for (const [name, args] of [
      ["create_project", { code: "ZZZ", name: "nope" }],
      ["create_feature", { module: "SCG-CORE", title: "nope nope" }],
      ["set_token_hash", { member: "jane", sha256: null }],
    ] as const) {
      const r = await mcpCall(tok, name, args);
      expect(r.isError, name).toBe(true);
      expect(r.data, name).toMatchObject({ error: "FORBIDDEN", status: 403 });
    }
    // leaders can create features but not projects
    const my = await issueToken("my");
    expect((await mcpCall(my, "create_feature", { module: "SCG-CORE", title: "Hero OG" })).data.code).toMatch(/^SCG-CORE-\d{3}$/);
    expect((await mcpCall(my, "create_project", { code: "ZZZ", name: "nope" })).data).toMatchObject({ status: 403 });
  });

  it("report_status allows in_progress -> assigned and rejects in_progress -> done", async () => {
    const harry = await issueToken("harry");
    const f = (await mcpCall(harry, "create_feature", { module: "SCOS-QLY", title: "pause work" })).data.code;
    const created = await mcpCall(harry, "create_task", { feature: f, title: "pause check", assignee: "ethan", ...fullRequest });
    expect(created.data.status).toBe("backlog");
    const t = created.data.code;
    const ethan = await issueToken("ethan");
    const moved = await mcpCall(harry, "report_status", { task: t, status: "assigned" });
    expect(moved.data).toMatchObject({ from: "backlog", to: "assigned" });
    const start = await mcpCall(ethan, "report_status", { task: t, status: "in_progress", note: "bắt đầu" });
    expect(start.data).toMatchObject({ from: "assigned", to: "in_progress" });
    const done = await mcpCall(ethan, "report_status", { task: t, status: "done", note: "xong" });
    expect(done.isError).toBe(true);
    expect(done.data.error).toBe("BAD_REQUEST");
    const back = await mcpCall(ethan, "report_status", { task: t, status: "assigned", note: "dừng" });
    expect(back.isError).toBe(false);
    expect(back.data).toMatchObject({ from: "in_progress", to: "assigned" });
  });

  it("end-to-end: leader assigns, bot reports, invalid transition rejected", async () => {
    const harry = await issueToken("harry");
    const f = (await mcpCall(harry, "create_feature", { module: "SCOS-QLY", title: "staging env" })).data.code;
    const created = await mcpCall(harry, "create_task", { feature: f, title: "cookie check", assignee: "ethan", ...fullRequest });
    expect(created.data.status).toBe("backlog");
    const t = created.data.code;
    const ethan = await issueToken("ethan");
    const bad = await mcpCall(ethan, "report_status", { task: t, status: "done", note: "x" });
    expect(bad.isError).toBe(true);
    expect(bad.data.error).toBe("BAD_REQUEST");
    const moved = await mcpCall(harry, "report_status", { task: t, status: "assigned" });
    expect(moved.data).toMatchObject({ from: "backlog", to: "assigned" });
    const ok = await mcpCall(ethan, "report_status", { task: t, status: "in_progress", note: "bắt đầu" });
    expect(ok.data).toMatchObject({ from: "assigned", to: "in_progress" });
    const mine = await mcpCall(ethan, "list_my_tasks");
    expect(mine.data.tasks.map((x: any) => x.code)).toContain(t);
  });

  it("MCP host serves only /mcp", async () => {
    const r = await worker.fetch(new URL("/", MCP));
    expect(r.status).toBe(404);
  });
});

describe("UI", () => {
  it("403 without Access JWT, on workers.dev, or for a non-allowed email", async () => {
    expect((await worker.fetch(`${UI}/`)).status).toBe(403);
    expect((await worker.fetch("https://status-hub.example.workers.dev/", {
      headers: { "Cf-Access-Jwt-Assertion": await accessJwt("owner@example.com") } })).status).toBe(403);
    expect((await worker.fetch(`${UI}/`, {
      headers: { "Cf-Access-Jwt-Assertion": await accessJwt("stranger@example.com") } })).status).toBe(403);
    expect((await worker.fetch(`${UI}/`, {
      headers: { "Cf-Access-Jwt-Assertion": await accessJwt("owner@example.com", "other-aud") } })).status).toBe(403);
    expect((await worker.fetch(`${UI}/`, {
      headers: { "Cf-Access-Jwt-Assertion": await accessJwt("owner@example.com", "test-aud", -10) } })).status).toBe(403);
  });

  it("renders the Kanban (status columns × project swimlanes) and task detail", async () => {
    const harry = await issueToken("harry");
    const f = (await mcpCall(harry, "create_feature", { module: "SCOS-MAIL", title: "Mail v1 UI" })).data.code;
    const t = (await mcpCall(harry, "create_task", { feature: f, title: "Review <PR> #27", assignee: "peter", ...fullRequest })).data.code;
    const h = { "Cf-Access-Jwt-Assertion": await accessJwt("approver@example.com") };
    const r = await worker.fetch(`${UI}/?project=SCOS`, { headers: h });
    expect(r.status).toBe(200);
    const body = await r.text();
    for (const col of ["Pending approval", "Backlog", "Assigned", "In progress", "Review", "Blocked", "Done"]) expect(body).toContain(col);
    expect(body).toContain("See all");
    expect(body).toContain(t);
    expect(body).toContain("Review &lt;PR&gt; #27"); // escaped
    expect(body).not.toContain(`href="/p/SCG"`);   // project filter applied
    const d = await worker.fetch(`${UI}/t/${t}`, { headers: h });
    expect(d.status).toBe(200);
    expect(await d.text()).toContain("giao cho peter");
    for (const p of ["/alerts", "/members", "/m/peter", "/p/SCOS"]) {
      expect((await worker.fetch(`${UI}${p}`, { headers: h })).status, p).toBe(200);
    }
  });
});
