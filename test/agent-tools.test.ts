import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentToolContext, AgentToolDefinition, AgentToolResult } from "@getpaseo/plugin/server";
import { createWorklogTools } from "../server/agent-tools.ts";
import { WorklogStore } from "../server/store.ts";
import { WorkerStore } from "../server/worker-store.ts";
import { queueResultSchema, SYNC_PROTOCOL, syncConfigSchema, type ExchangeInput } from "../shared/sync.ts";
import { mutationResultSchema, taskFieldsSchema, type MutationResult, type Task, type TaskFields } from "../shared/model.ts";

function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "paseo-worklog-tools-"));
  const store = new WorklogStore(join(directory, "board.db"));
  const tools = createWorklogTools(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  function tool(name: string): AgentToolDefinition {
    const definition = tools.find((item) => item.name === name);
    assert.ok(definition, `The real exported ${name} definition must exist`);
    return definition;
  }
  return { store, getTask: tool("worklog_get_my_task"), report: tool("worklog_report") };
}

function context(hostId: string, agentId: string): AgentToolContext {
  return {
    agent: { id: agentId, workspaceId: "workspace", parentAgentId: null, provider: "codex", cwd: "/project", title: "Agent" },
    paseo: { hosts: { list: async () => ({ self: { serverId: hostId, label: hostId }, hosts: [] }) } } as unknown as AgentToolContext["paseo"],
    signal: new AbortController().signal,
  };
}

/** Exercise the actual exported SDK definition and its advertised input schema. */
async function invoke(tool: AgentToolDefinition, input: unknown, caller: AgentToolContext): Promise<AgentToolResult> {
  return tool.execute(tool.input.parse(input), caller);
}

function taskOf(result: MutationResult): Task {
  if (!result.ok) assert.fail(JSON.stringify(result));
  return result.task;
}

function createLinked(store: WorklogStore, hostId = "home", agentId = "agent", fields: Partial<TaskFields> = {}): Task {
  return taskOf(store.mutate({
    op: "create", requestId: randomUUID(), fields: taskFieldsSchema.parse({ title: `Task on ${hostId}`, status: "doing", ...fields }),
    session: { hostId, hostLabel: hostId, agentId, workspaceId: "workspace", title: `Session on ${hostId}`, provider: "codex", cwd: "/project", execution: "working", observedAt: "2026-11-12T09:00:00.000Z", parentAgentId: null },
  }));
}

function reportInput(task: Task, extras: Record<string, unknown> = {}) {
  return {
    requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision,
    summary: "핵심 문진 검토를 마쳤습니다.", doneText: "응답 20개를 점검했습니다.", nextAction: "검토 의견을 반영합니다.",
    ...extras,
  };
}

function reportResult(result: AgentToolResult): MutationResult {
  assert.deepEqual(JSON.parse(result.text!), result.structuredContent, "text and structured tool output must agree");
  return mutationResultSchema.parse(result.structuredContent);
}

test("get_my_task scopes identical agent IDs to the trusted caller host", async (t) => {
  const { store, getTask } = setup(t);
  const home = createLinked(store, "home", "same-agent", { description: "home-only-content" });
  const dorm = createLinked(store, "dorm", "same-agent", { description: "dorm-only-content" });
  const homeResult = await invoke(getTask, { taskId: dorm.id, hostId: "dorm", agentId: "same-agent" }, context("home", "same-agent"));
  const homeData = homeResult.structuredContent as { task: Task };
  assert.equal(homeData.task.id, home.id);
  assert.ok(!homeResult.text?.includes("dorm-only-content"));
  const dormResult = await invoke(getTask, {}, context("dorm", "same-agent"));
  assert.equal((dormResult.structuredContent as { task: Task }).task.id, dorm.id);
  assert.deepEqual(JSON.parse(homeResult.text!), homeResult.structuredContent);
});

test("an unlinked or archived session gets no task and cannot create one through tools", async (t) => {
  const { store, getTask, report } = setup(t);
  const task = createLinked(store);
  const before = store.readBoard();
  const absent = await invoke(getTask, {}, context("home", "unlinked-agent"));
  assert.equal((absent.structuredContent as { task: unknown }).task, null);
  const unauthorized = await invoke(report, reportInput(task), context("home", "unlinked-agent"));
  assert.equal(unauthorized.isError, true);
  const failure = reportResult(unauthorized);
  assert.ok(!failure.ok && failure.code === "VALIDATION");
  assert.ok(!("current" in failure), "unlinked callers must not receive task content");
  assert.deepEqual(store.readBoard().tasks, before.tasks);
  assert.deepEqual(store.readBoard().activities, before.activities);
  const archived = taskOf(store.mutate({ op: "archive", requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision }));
  const hidden = await invoke(getTask, {}, context("home", "agent"));
  assert.equal((hidden.structuredContent as { task: unknown }).task, null);
  assert.ok(store.readBoard().tasks[0]!.archivedAt);
  assert.equal(archived.sessions.length, 1);
});

test("report execute saves evidence and converts done to review without claiming verification", async (t) => {
  const { store, report } = setup(t);
  const task = createLinked(store);
  const result = await invoke(report, reportInput(task, { status: "done", evidence: "review.json: 20 responses checked" }), context("home", "agent"));
  assert.equal(result.isError, false);
  const updated = taskOf(reportResult(result));
  assert.equal(updated.status, "review");
  assert.equal(updated.evidence, "review.json: 20 responses checked");
  assert.equal(updated.doneText, "응답 20개를 점검했습니다.");
  assert.equal(updated.nextAction, "검토 의견을 반영합니다.");
  assert.equal(store.readBoard().activities[0]!.actor, "agent");
  assert.equal(store.readBoard().activities[0]!.kind, "reported");
  assert.match(report.description, /not verified/);
});

test("report tools cannot spoof host or agent using extra input fields", async (t) => {
  const { store, report } = setup(t);
  createLinked(store, "home", "same-agent");
  const dorm = createLinked(store, "dorm", "same-agent", { description: "dorm private contents" });
  const before = store.readBoard();
  const result = await invoke(report, reportInput(dorm, { hostId: "dorm", agentId: "same-agent" }), context("home", "same-agent"));
  assert.equal(result.isError, true);
  const failure = reportResult(result);
  assert.ok(!failure.ok && failure.code === "VALIDATION");
  assert.ok(!result.text?.includes("dorm private contents"));
  assert.deepEqual(store.readBoard().tasks, before.tasks);
  assert.deepEqual(store.readBoard().activities, before.activities);
});

test("an authorized uncertain-result retry is idempotent even after a newer user edit", async (t) => {
  const { store, report } = setup(t);
  const task = createLinked(store);
  const input = reportInput(task);
  const first = taskOf(reportResult(await invoke(report, input, context("home", "agent"))));
  const newer = taskOf(store.mutate({ op: "update", requestId: randomUUID(), taskId: task.id, expectedRevision: first.revision, patch: { nextAction: "사람이 새로 정한 다음 단계" } }));
  const retry = reportResult(await invoke(report, input, context("home", "agent")));
  assert.ok(retry.ok && retry.replayed);
  assert.deepEqual(taskOf(retry), first, "retry must return its original successful outcome");
  assert.equal(store.readBoard().tasks[0]!.nextAction, newer.nextAction, "replay must not reapply the old patch");
  assert.equal(store.readBoard().activities.filter((event) => event.kind === "reported").length, 1);
  const reused = reportResult(await invoke(report, { ...input, expectedRevision: newer.revision, nextAction: "different payload" }, context("home", "agent")));
  assert.ok(!reused.ok && reused.code === "REQUEST_ID_REUSED");
});

test("unlinking a session revokes access even to its cached successful report receipt", async (t) => {
  const { store, report } = setup(t);
  const task = createLinked(store);
  const input = reportInput(task);
  const reported = taskOf(reportResult(await invoke(report, input, context("home", "agent"))));
  const unlinked = taskOf(store.mutate({ op: "unlink", requestId: randomUUID(), taskId: task.id, expectedRevision: reported.revision, hostId: "home", agentId: "agent" }));
  const retry = await invoke(report, input, context("home", "agent"));
  assert.equal(retry.isError, true);
  const denied = reportResult(retry);
  assert.ok(!denied.ok && denied.code === "VALIDATION");
  assert.ok(!("current" in denied));
  assert.ok(!("task" in denied));
  assert.deepEqual(store.readBoard().tasks[0], unlinked);
  assert.equal(store.readBoard().activities.filter((event) => event.kind === "reported").length, 1);
});

test("archiving also revokes receipt replay; restoring permits a safe replay again", async (t) => {
  const { store, report } = setup(t);
  const task = createLinked(store);
  const input = reportInput(task);
  const reported = taskOf(reportResult(await invoke(report, input, context("home", "agent"))));
  const archived = taskOf(store.mutate({ op: "archive", requestId: randomUUID(), taskId: task.id, expectedRevision: reported.revision }));
  const blocked = await invoke(report, input, context("home", "agent"));
  assert.equal(blocked.isError, true);
  const denial = reportResult(blocked);
  assert.ok(!denial.ok && denial.code === "VALIDATION");
  const restored = taskOf(store.mutate({ op: "restore", requestId: randomUUID(), taskId: task.id, expectedRevision: archived.revision }));
  const retry = reportResult(await invoke(report, input, context("home", "agent")));
  assert.ok(retry.ok && retry.replayed);
  assert.deepEqual(store.readBoard().tasks[0], restored);
  assert.equal(store.readBoard().activities.filter((event) => event.kind === "reported").length, 1);
});

test("omitted report evidence and blockers preserve stored values; explicit empty strings clear them", async (t) => {
  const { store, report } = setup(t);
  const task = createLinked(store, "home", "agent", { evidence: "existing-proof.md", blockedReason: "외부 자료 대기", status: "blocked" });
  const input = reportInput(task);
  const parsed = report.input.parse(input) as Record<string, unknown>;
  assert.ok(!Object.hasOwn(parsed, "evidence"), "tool parsing must not manufacture an empty evidence default");
  assert.ok(!Object.hasOwn(parsed, "blockedReason"));
  const preserved = taskOf(reportResult(await invoke(report, input, context("home", "agent"))));
  assert.equal(preserved.evidence, "existing-proof.md");
  assert.equal(preserved.blockedReason, "외부 자료 대기");
  const event = store.readBoard().activities[0]!;
  assert.match(event.message, /existing-proof\.md/);
  assert.match(event.message, /외부 자료 대기/);
  const cleared = taskOf(reportResult(await invoke(report, reportInput(preserved, { evidence: "", blockedReason: "" }), context("home", "agent"))));
  assert.equal(cleared.evidence, "");
  assert.equal(cleared.blockedReason, "");
  assert.match(store.readBoard().activities[0]!.message, /근거: \(없음\)/);
});

test("a report revision conflict is returned as a tool error without overwriting newer work", async (t) => {
  const { store, report } = setup(t);
  const task = createLinked(store);
  const newer = taskOf(store.mutate({ op: "update", requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision, patch: { summary: "사람이 수정한 최신 상황" } }));
  const result = await invoke(report, reportInput(task), context("home", "agent"));
  assert.equal(result.isError, true);
  const failure = reportResult(result);
  assert.ok(!failure.ok && failure.code === "CONFLICT");
  assert.equal(failure.current?.revision, newer.revision);
  assert.equal(failure.current?.summary, "사람이 수정한 최신 상황");
  assert.deepEqual(store.readBoard().tasks[0], newer);
  assert.equal(store.readBoard().activities.filter((event) => event.kind === "reported").length, 0);
});

test("tool schema rejection and host lookup failure cannot mutate the board", async (t) => {
  const { store, report, getTask } = setup(t);
  const task = createLinked(store);
  const before = store.readBoard();
  await assert.rejects(invoke(report, reportInput(task, { expectedRevision: 0 }), context("home", "agent")));
  await assert.rejects(invoke(report, { requestId: randomUUID(), taskId: task.id, expectedRevision: 1 }, context("home", "agent")));
  const unavailable = context("home", "agent");
  unavailable.paseo = { hosts: { list: async () => { throw new Error("host connection unavailable"); } } } as unknown as AgentToolContext["paseo"];
  await assert.rejects(invoke(report, reportInput(task), unavailable), /host connection unavailable/);
  await assert.rejects(invoke(getTask, {}, unavailable), /host connection unavailable/);
  assert.deepEqual(store.readBoard().tasks, before.tasks);
  assert.deepEqual(store.readBoard().activities, before.activities);
});

function setupSatellite(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "paseo-satellite-tools-"));
  const central = new WorklogStore(join(directory, "central.sqlite"));
  const local = new WorklogStore(join(directory, "local.sqlite"));
  const worker = new WorkerStore(join(directory, "worker.sqlite"));
  t.after(() => { worker.close(); local.close(); central.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(worker.configure(1, syncConfigSchema.parse({ role: "satellite", centralServerId: "central" })).ok, true);
  const task = createLinked(central, "satellite", "agent", { description: "private central task body" });
  function exchange(acknowledgements: ExchangeInput["acknowledgements"] = []) {
    return worker.exchange({ protocol: SYNC_PROTOCOL, centralServerId: "central", boardId: central.boardId(), sequence: central.nextSequence(),
      tasks: central.tasksForHost("satellite"), acknowledgements }, "satellite");
  }
  exchange();
  const tools = createWorklogTools(local, { worker });
  return { central, local, worker, task, exchange,
    getTask: tools.find((tool) => tool.name === "worklog_get_my_task")!,
    report: tools.find((tool) => tool.name === "worklog_report")! };
}

test("the actual satellite report tool distinguishes locally queued from centrally applied", async (t) => {
  const { central, local, worker, task, exchange, report } = setupSatellite(t);
  const input = reportInput(task, { status: "done" });
  const queuedOutput = await invoke(report, input, context("satellite", "agent"));
  const queued = queueResultSchema.parse(queuedOutput.structuredContent);
  assert.equal(queued.delivery, "queued");
  assert.equal(queuedOutput.isError, false);
  assert.equal(central.readBoard().tasks[0]!.revision, task.revision);
  assert.equal(central.readBoard().tasks[0]!.status, "doing");
  assert.equal(local.readBoard().tasks.length, 0, "a satellite tool must not create or update a second local board");
  const pending = exchange().reports[0]!;
  const outcome = central.reportDelivery("satellite", pending.agentId, pending.report);
  exchange([{ deliveryId: pending.deliveryId, requestId: pending.report.requestId, result: outcome }]);
  const confirmedOutput = await invoke(report, input, context("satellite", "agent"));
  const confirmed = queueResultSchema.parse(confirmedOutput.structuredContent);
  assert.equal(confirmed.delivery, "applied");
  assert.equal(confirmed.deliveryId, queued.deliveryId);
  assert.ok(!("task" in confirmed));
  assert.equal(central.readBoard().tasks[0]!.status, "review");
  assert.equal(worker.state().applied, 1);
  assert.deepEqual(JSON.parse(confirmedOutput.text!), confirmedOutput.structuredContent);
});

test("satellite cached task reads mark age and scope both task and delivery metadata by host", async (t) => {
  const { worker, task, getTask, report } = setupSatellite(t);
  await invoke(report, reportInput(task), context("satellite", "agent"));
  const fresh = (await invoke(getTask, {}, context("satellite", "agent"))).structuredContent as { task: Task; source: string; cachedAt: string; stale: boolean; deliveries: unknown[] };
  assert.equal(fresh.source, "central_cache");
  assert.equal(fresh.task.id, task.id);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.deliveries.length, 1);
  const futureNow = Date.parse(worker.getLinkedTask("satellite", "agent").cachedAt!) + 60_000;
  t.mock.method(Date, "now", () => futureNow);
  const stale = (await invoke(getTask, {}, context("satellite", "agent"))).structuredContent as typeof fresh;
  assert.equal(stale.stale, true);
  const foreign = (await invoke(getTask, {}, context("different-host", "agent"))).structuredContent as { task: Task | null; deliveries: unknown[] };
  assert.equal(foreign.task, null);
  assert.deepEqual(foreign.deliveries, []);
});

test("satellite tools disclose only receipt metadata after a settled task link is revoked", async (t) => {
  const { central, task, exchange, getTask, report } = setupSatellite(t);
  const input = reportInput(task);
  await invoke(report, input, context("satellite", "agent"));
  const pending = exchange().reports[0]!;
  const applied = central.reportDelivery("satellite", "agent", pending.report);
  assert.ok(applied.ok);
  // Lose the first delivery response, then unlink before the next collection.
  taskOf(central.mutate({ op: "unlink", requestId: randomUUID(), taskId: task.id, expectedRevision: applied.appliedRevision, hostId: "satellite", agentId: "agent" }));
  const proof = central.reportDelivery("satellite", "agent", pending.report);
  assert.ok(proof.ok && proof.replayed);
  exchange([{ deliveryId: pending.deliveryId, requestId: pending.report.requestId, result: proof }]);
  const noTask = await invoke(getTask, {}, context("satellite", "agent"));
  assert.equal((noTask.structuredContent as { task: unknown }).task, null);
  assert.ok(!noTask.text!.includes("private central task body"));
  const retry = await invoke(report, input, context("satellite", "agent"));
  assert.equal(queueResultSchema.parse(retry.structuredContent).delivery, "applied");
  assert.ok(!retry.text!.includes("private central task body"));
  assert.ok(!("task" in (retry.structuredContent as object)));
  const newReport = await invoke(report, { ...input, requestId: randomUUID() }, context("satellite", "agent"));
  assert.equal(queueResultSchema.parse(newReport.structuredContent).delivery, "blocked");
  assert.equal(newReport.isError, true);
});
