import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { WorklogStore } from "../server/store.ts";
import { WorkerStore } from "../server/worker-store.ts";
import { taskFieldsSchema, type AgentReport, type MutationResult, type Task } from "../shared/model.ts";
import { SYNC_PROTOCOL, syncConfigSchema, type ExchangeInput, type ReportOutcome } from "../shared/sync.ts";

function taskOf(result: MutationResult): Task { if (!result.ok) assert.fail(JSON.stringify(result)); return result.task; }

function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "worklog-worker-test-"));
  const workerPath = join(directory, "worker.sqlite");
  const centralPath = join(directory, "central.sqlite");
  const worker = new WorkerStore(workerPath);
  const central = new WorklogStore(centralPath);
  t.after(() => { worker.close(); central.close(); rmSync(directory, { recursive: true, force: true }); });
  const config = worker.configure(worker.readConfig().revision, syncConfigSchema.parse({ role: "satellite", centralServerId: "central" }));
  assert.equal(config.ok, true);
  const task = taskOf(central.mutate({ op: "create", requestId: randomUUID(), fields: taskFieldsSchema.parse({ title: "Remote task", status: "doing", evidence: "old-evidence.md", blockedReason: "known blocker" }),
    session: { hostId: "worker", hostLabel: "Worker", agentId: "agent", workspaceId: "ws", title: "Remote session", provider: "codex", cwd: "/repo", execution: "working", observedAt: "2026-11-12T00:00:00.000Z", parentAgentId: null } }));
  function input(overrides: Partial<ExchangeInput> = {}): ExchangeInput {
    return { protocol: SYNC_PROTOCOL, centralServerId: "central", boardId: central.boardId(), sequence: central.nextSequence(), tasks: central.tasksForHost("worker"), acknowledgements: [], ...overrides };
  }
  return { worker, central, task, input, workerPath, centralPath };
}

function report(task: Task, changes: Partial<AgentReport> = {}): AgentReport {
  return { requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision,
    summary: "Checked the source", doneText: "Reviewed twenty responses", nextAction: "Apply findings", ...changes };
}

test("worker defaults are central, enabled, 15 seconds and configuration uses revisions", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worklog-config-test-"));
  const worker = new WorkerStore(join(directory, "worker.sqlite"));
  t.after(() => { worker.close(); rmSync(directory, { recursive: true, force: true }); });
  const initial = worker.readConfig();
  assert.equal(initial.config.role, "central");
  assert.equal(initial.config.enabled, true);
  assert.equal(initial.config.pollIntervalSeconds, 15);
  assert.equal(worker.configure(initial.revision, syncConfigSchema.parse({ role: "satellite" })).ok, false);
  const changed = worker.configure(initial.revision, syncConfigSchema.parse({ role: "satellite", centralServerId: "central" }));
  assert.equal(changed.ok, true);
  assert.equal(worker.configure(initial.revision, syncConfigSchema.parse({ role: "central" })).ok, false);
  assert.equal(worker.readConfig().config.role, "satellite");
});

test("first valid exchange binds immutable central board and worker identities", (t) => {
  const { worker, central, task, input } = setup(t);
  assert.equal(worker.state().boardId, null);
  const invalidTask = { ...task, sessions: task.sessions.map((session) => ({ ...session, hostId: "foreign" })) };
  assert.throws(() => worker.exchange(input({ tasks: [invalidTask] }), "worker"), /작업 PC/);
  assert.equal(worker.state().boardId, null, "a rejected first exchange must not bind anything");
  const accepted = worker.exchange(input(), "worker");
  assert.equal(accepted.boardId, central.boardId());
  assert.equal(worker.state().workerHostId, "worker");
  assert.throws(() => worker.exchange(input({ centralServerId: "impostor" }), "worker"), /중앙 서버/);
  assert.throws(() => worker.exchange(input({ boardId: "different-board" }), "worker"), /보드 ID/);
  assert.throws(() => worker.exchange(input(), "different-worker"), /호스트 ID/);
  assert.equal(worker.getLinkedTask("worker", "agent").task!.id, task.id);
  assert.equal(worker.getLinkedTask("foreign", "agent").task, null);
});

test("stale and equal exchange sequences cannot roll back the task cache", (t) => {
  const { worker, task, input } = setup(t);
  worker.exchange(input({ sequence: 10 }), "worker");
  const cachedAt = worker.getLinkedTask("worker", "agent").cachedAt;
  const changed = { ...task, title: "stale title", revision: 99 };
  assert.throws(() => worker.exchange(input({ sequence: 9, tasks: [changed] }), "worker"), /sequence/);
  worker.exchange(input({ sequence: 10, tasks: [changed] }), "worker");
  assert.equal(worker.getLinkedTask("worker", "agent").task!.title, task.title);
  assert.equal(worker.getLinkedTask("worker", "agent").cachedAt, cachedAt);
  const queued = worker.enqueue("worker", "agent", report(task));
  assert.equal(queued.delivery, "queued");
  const retried = worker.exchange(input({ sequence: 10 }), "worker");
  assert.equal(retried.reports.length, 1, "same-sequence retry can return a newly queued report");
  worker.exchange(input({ sequence: 11, tasks: [] }), "worker");
  assert.equal(worker.getLinkedTask("worker", "agent").task, null);
  assert.equal(worker.state().queued, 1, "authoritative removal from cache cannot erase queued evidence");
});

test("enqueue is local-only, exact-payload idempotent, and survives a worker restart", (t) => {
  const { worker, task, input, workerPath } = setup(t);
  worker.exchange(input(), "worker");
  const body = report(task);
  const first = worker.enqueue("worker", "agent", body);
  assert.equal(first.delivery, "queued");
  assert.match(first.message, /아직 중앙 보드에는 적용되지/);
  assert.deepEqual(worker.enqueue("worker", "agent", body), first);
  assert.equal(worker.enqueue("worker", "agent", { ...body, nextAction: "changed" }).delivery, "blocked");
  assert.equal(worker.state().queued, 1);
  assert.equal(worker.getLinkedTask("worker", "agent").task!.revision, task.revision, "queueing must not fabricate a central revision");
  assert.ok(!Object.hasOwn(worker.state().deliveries[0]!.report, "evidence"));
  assert.ok(!Object.hasOwn(worker.state().deliveries[0]!.report, "blockedReason"));
  worker.close();
  const reopened = new WorkerStore(workerPath);
  try {
    assert.equal(reopened.readConfig().config.role, "satellite");
    assert.deepEqual(reopened.enqueue("worker", "agent", body), first);
    assert.equal(reopened.state().queued, 1);
    assert.equal(reopened.getLinkedTask("worker", "agent").task!.id, task.id);
  } finally { reopened.close(); }
});

test("new reports require the configured host, cached active link and exact cached revision", (t) => {
  const { worker, task, input } = setup(t);
  assert.equal(worker.enqueue("worker", "agent", report(task)).delivery, "blocked");
  worker.exchange(input(), "worker");
  for (const [host, agent, changes] of [
    ["other-host", "agent", {}], ["worker", "other-agent", {}],
    ["worker", "agent", { taskId: "unknown" }], ["worker", "agent", { expectedRevision: 99 }],
  ] as const) {
    const result = worker.enqueue(host, agent, report(task, changes));
    assert.equal(result.delivery, "blocked");
    assert.equal(result.deliveryId, null);
  }
  assert.equal(worker.enqueue("worker", "agent", { ...report(task), expectedRevision: 0 }).delivery, "blocked");
  assert.equal(worker.state().deliveries.length, 0);
});

test("pause retains pending reports and binding while preventing exchange and new enqueue", (t) => {
  const { worker, task, input } = setup(t);
  worker.exchange(input(), "worker");
  worker.enqueue("worker", "agent", report(task));
  let config = worker.readConfig();
  assert.equal(worker.configure(config.revision, { ...config.config, enabled: false }).ok, true);
  assert.throws(() => worker.exchange(input(), "worker"), /정지/);
  assert.equal(worker.enqueue("worker", "agent", report(task)).delivery, "blocked");
  assert.equal(worker.state().queued, 1);
  config = worker.readConfig();
  assert.equal(worker.configure(config.revision, { ...config.config, role: "central" }).ok, false);
  assert.equal(worker.configure(config.revision, { ...config.config, centralServerId: "another" }).ok, false);
  assert.equal(worker.configure(config.revision, { ...config.config, enabled: true }).ok, true);
  assert.equal(worker.exchange(input(), "worker").reports.length, 1);
});

test("a lost acknowledgement retries centrally exactly once and settles without a full task in the tool receipt", (t) => {
  const { worker, central, task, input } = setup(t);
  worker.exchange(input(), "worker");
  const body = report(task, { status: "done" });
  const enqueued = worker.enqueue("worker", "agent", body);
  const sent = worker.exchange(input(), "worker").reports[0]!;
  const applied = central.reportDelivery("worker", sent.agentId, sent.report);
  assert.equal(central.getLinkedTask("worker", "agent")!.status, "review");
  assert.equal(central.getLinkedTask("worker", "agent")!.evidence, "old-evidence.md", "omitted fields survive remote transport");
  assert.equal(central.getLinkedTask("worker", "agent")!.blockedReason, "known blocker");
  const sentAgain = worker.exchange(input(), "worker").reports[0]!;
  const replay = central.reportDelivery("worker", sentAgain.agentId, sentAgain.report);
  assert.ok(replay.ok && replay.replayed);
  const ack = { deliveryId: sent.deliveryId, requestId: body.requestId, result: replay };
  const exchange = input({ acknowledgements: [ack] });
  const settled = worker.exchange(exchange, "worker");
  assert.equal(settled.queued, 0);
  assert.equal(worker.state().applied, 1);
  const receipt = worker.enqueue("worker", "agent", body);
  assert.equal(receipt.delivery, "applied");
  assert.equal(receipt.deliveryId, enqueued.deliveryId);
  assert.ok(!("task" in receipt));
  assert.equal(central.readBoard().activities.filter((event) => event.kind === "reported").length, 1);
  worker.exchange({ ...exchange, acknowledgements: [{ ...ack, result: applied }] }, "worker");
  assert.deepEqual(worker.state().deliveries[0]!.result, replay, "a benign replay flag difference cannot overwrite the original receipt");
});

test("acknowledgements bind delivery, request, task and immutable outcome atomically", (t) => {
  const { worker, central, task, input } = setup(t);
  worker.exchange(input(), "worker");
  const body = report(task);
  worker.enqueue("worker", "agent", body);
  const sent = worker.exchange(input(), "worker").reports[0]!;
  const applied = central.reportDelivery("worker", "agent", body);
  const ack = { deliveryId: sent.deliveryId, requestId: body.requestId, result: applied };
  const before = worker.state();
  assert.throws(() => worker.exchange(input({ acknowledgements: [{ ...ack, deliveryId: "missing" }] }), "worker"), /수신 확인/);
  assert.throws(() => worker.exchange(input({ acknowledgements: [{ ...ack, requestId: "wrong-request" }] }), "worker"), /수신 확인/);
  assert.throws(() => worker.exchange(input({ acknowledgements: [{ ...ack, result: { ok: true, taskId: "different-task", appliedRevision: 2, replayed: false } }] }), "worker"), /작업/);
  const denied: ReportOutcome = { ok: false, taskId: task.id, code: "CONFLICT", message: "conflict" };
  assert.throws(() => worker.exchange(input({ acknowledgements: [ack, { ...ack, result: denied }] }), "worker"), /서로 다른/);
  assert.deepEqual(worker.state(), before, "one invalid acknowledgement rolls back the entire exchange");
  worker.exchange(input({ acknowledgements: [ack] }), "worker");
  const settled = worker.state();
  assert.throws(() => worker.exchange(input({ acknowledgements: [{ ...ack, result: denied }] }), "worker"), /덮어쓸/);
  assert.deepEqual(worker.state(), settled);
});

test("central conflicts are retained, and acknowledging one never erases its evidence or retargets it", (t) => {
  const { worker, central, task, input } = setup(t);
  worker.exchange(input(), "worker");
  const body = report(task);
  const local = worker.enqueue("worker", "agent", body);
  assert.throws(() => worker.dismiss(local.deliveryId!), /전송 대기/);
  taskOf(central.mutate({ op: "update", requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision, patch: { summary: "concurrent human update" } }));
  const outcome = central.reportDelivery("worker", "agent", body);
  assert.ok(!outcome.ok && outcome.code === "CONFLICT");
  worker.exchange(input({ acknowledgements: [{ deliveryId: local.deliveryId!, requestId: body.requestId, result: outcome }] }), "worker");
  const before = worker.state().deliveries[0]!;
  assert.equal(before.state, "blocked");
  assert.equal(before.report.expectedRevision, task.revision);
  assert.equal(worker.state().blocked, 1);
  let cfg = worker.readConfig();
  assert.equal(worker.configure(cfg.revision, { ...cfg.config, centralServerId: "new-central" }).ok, false);
  const dismissed = worker.dismiss(before.deliveryId);
  assert.equal(dismissed.blocked, 0);
  assert.ok(dismissed.deliveries[0]!.dismissedAt);
  assert.deepEqual(dismissed.deliveries[0]!.report, before.report);
  assert.deepEqual(dismissed.deliveries[0]!.result, before.result);
  assert.deepEqual(worker.dismiss(before.deliveryId), dismissed);
  cfg = worker.readConfig();
  assert.equal(worker.configure(cfg.revision, { ...cfg.config, centralServerId: "new-central" }).ok, true);
  assert.equal(worker.state().boardId, null);
  assert.equal(worker.getLinkedTask("worker", "agent").task, null);
  const newBoard = worker.exchange(input({ centralServerId: "new-central", boardId: "new-board", sequence: 1, tasks: [] }), "worker");
  assert.equal(newBoard.reports.length, 0);
  assert.equal(worker.state().deliveries.length, 1, "old settled history is retained, not retargeted");
});

test("one exchange returns at most fifty queued reports in durable insertion order", (t) => {
  const { worker, task, input } = setup(t);
  worker.exchange(input(), "worker");
  const ids: string[] = [];
  for (let index = 0; index < 55; index += 1) ids.push(worker.enqueue("worker", "agent", report(task, { summary: `report ${index}` })).deliveryId!);
  const response = worker.exchange(input(), "worker");
  assert.equal(response.queued, 55);
  assert.equal(response.reports.length, 50);
  assert.deepEqual(response.reports.map((item) => item.deliveryId), ids.slice(0, 50));
});

test("the 1000 unsettled report cap preserves prior queued reports", (t) => {
  const { worker, task, input } = setup(t);
  worker.exchange(input(), "worker");
  for (let index = 0; index < 1_000; index += 1) assert.equal(worker.enqueue("worker", "agent", report(task)).delivery, "queued");
  const result = worker.enqueue("worker", "agent", report(task));
  assert.equal(result.delivery, "blocked");
  assert.equal(result.deliveryId, null);
  assert.equal(worker.state().queued, 1_000);
  assert.equal(worker.state().deliveries.length, 1_000);
});

test("foreign, archived and ambiguous linked task snapshots are rejected without cache changes", (t) => {
  const { worker, task, input } = setup(t);
  worker.exchange(input(), "worker");
  const before = worker.state();
  assert.throws(() => worker.exchange(input({ tasks: [{ ...task, archivedAt: new Date().toISOString() }] }), "worker"), /보관된/);
  assert.throws(() => worker.exchange(input({ tasks: [task, { ...task, id: "another-task" }] }), "worker"), /여러 작업/);
  assert.throws(() => worker.exchange(input({ tasks: [task, task] }), "worker"), /중복/);
  assert.deepEqual(worker.state(), before);
  assert.equal(worker.getLinkedTask("worker", "agent").task!.id, task.id);
});

test("worker storage refuses the central database rather than changing its schema", (t) => {
  const { centralPath, central, task } = setup(t);
  const before = central.boardId();
  assert.throws(() => new WorkerStore(centralPath), /식별자|버전/);
  assert.equal(central.boardId(), before);
  assert.equal(central.readBoard().tasks[0]!.id, task.id);
});

test("an old unacknowledged conflict stays ahead of bounded recent settled history", (t) => {
  const { worker, central, task, input } = setup(t);
  worker.exchange(input(), "worker");
  const queued = Array.from({ length: 102 }, () => {
    const body = report(task);
    return { body, local: worker.enqueue("worker", "agent", body) };
  });
  taskOf(central.mutate({ op: "update", requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision, patch: { summary: "newer user decision" } }));
  const acknowledgements = queued.map(({ body, local }) => ({ deliveryId: local.deliveryId!, requestId: body.requestId, result: central.reportDelivery("worker", "agent", body) }));
  worker.exchange(input({ acknowledgements: acknowledgements.slice(0, 100) }), "worker");
  worker.exchange(input({ acknowledgements: acknowledgements.slice(100) }), "worker");
  for (const { local } of queued.slice(1)) worker.dismiss(local.deliveryId!);
  const state = worker.state();
  assert.equal(state.blocked, 1);
  assert.equal(state.deliveries[0]!.deliveryId, queued[0]!.local.deliveryId);
  assert.equal(state.deliveries.length, 101, "all unsettled plus latest 100 settled are returned");
  assert.equal(state.deliveries[0]!.dismissedAt, null);
});
