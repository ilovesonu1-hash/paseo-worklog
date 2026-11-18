import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { WorklogStore } from "../server/store.ts";
import {
  taskFieldsSchema,
  type AgentReport,
  type MutationResult,
  type SessionSnapshot,
  type Task,
  type TaskFields,
} from "../shared/model.ts";

function setup(t: TestContext): { store: WorklogStore; path: string; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "paseo-worklog-test-"));
  const path = join(directory, "board.db");
  const store = new WorklogStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, path, directory };
}

function success(result: MutationResult): Task {
  if (!result.ok) assert.fail(JSON.stringify(result));
  return result.task;
}

function denied(result: MutationResult, code: string): void {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("Expected mutation failure");
  assert.equal(result.code, code);
}

function session(hostId = "pc-home", agentId = "agent-1", changes: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    hostId, hostLabel: hostId, agentId, workspaceId: "workspace-1", title: "CPX 검토",
    provider: "codex", cwd: "/project/cpx", execution: "working",
    observedAt: "2026-11-12T00:00:01.000Z", parentAgentId: null, ...changes,
  };
}

function create(store: WorklogStore, changes: Partial<TaskFields> = {}, source?: SessionSnapshot): Task {
  return success(store.mutate({
    op: "create", requestId: randomUUID(),
    fields: taskFieldsSchema.parse({ title: "CPX case review", ...changes }),
    ...(source ? { session: source } : {}),
  }));
}

function reportFor(task: Task, changes: Partial<AgentReport> = {}): AgentReport {
  return {
    requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision,
    summary: "환자 응답 검토를 마쳤습니다.", doneText: "20개 학생 질문의 응답을 확인했습니다.",
    nextAction: "교수자 검토 결과 반영", blockedReason: "", evidence: "review.md: 20 responses checked",
    ...changes,
  };
}

test("tasks, multiple session links and the work journal survive daemon restart", (t) => {
  const { store, path } = setup(t);
  let task = create(store, { project: "project_CPX", status: "doing", doneText: "원문 분석", nextAction: "문진 검토" }, session());
  task = success(store.mutate({ op: "link", requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision, session: session("pc-dorm", "agent-2") }));
  task = success(store.mutate({ op: "note", requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision, message: "채점 항목과 임상 권고를 분리하기로 결정" }));
  const before = store.readBoard();
  store.close();
  const reopened = new WorklogStore(path);
  try {
    const after = reopened.readBoard();
    assert.deepEqual(after.tasks, before.tasks);
    assert.deepEqual(after.activities, before.activities);
    assert.equal(after.tasks[0]!.sessions.length, 2);
    assert.equal(after.tasks[0]!.nextAction, "문진 검토");
    assert.equal(after.activities[0]!.message, "채점 항목과 임상 권고를 분리하기로 결정");
  } finally { reopened.close(); }
});

test("long daemon labels remain readable in persisted roster and linked task snapshots", (t) => {
  const { store, path } = setup(t);
  const source = session();
  const task = create(store, {}, source);
  const label = "Long workstation ".repeat(30);
  const expected = label.slice(0, 256);
  store.recordHostResult({
    hostId: source.hostId, label, sequence: store.nextSequence(), status: "online",
    sessions: [{ ...source, hostLabel: expected, execution: "idle" }],
  });
  assert.equal(store.readRoster().sessions[0]!.hostLabel, expected);
  assert.equal(store.readBoard().tasks[0]!.sessions[0]!.hostLabel, expected);
  assert.equal(store.readBoard().tasks[0]!.revision, task.revision);
  store.close();
  const reopened = new WorklogStore(path);
  try {
    assert.equal(reopened.readRoster().sessions[0]!.hostLabel, expected);
    assert.equal(reopened.getLinkedTask(source.hostId, source.agentId)!.sessions[0]!.hostLabel, expected);
    assert.equal(JSON.parse(reopened.exportJson()).roster.sessions[0].hostLabel, expected);
  } finally { reopened.close(); }
});

test("two clients cannot overwrite one another with an outdated task revision", (t) => {
  const { store, path } = setup(t);
  const task = create(store, { status: "doing" });
  const other = new WorklogStore(path);
  try {
    const updated = success(store.mutate({ op: "update", requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision, patch: { summary: "새로운 결정" } }));
    const stale = other.mutate({ op: "update", requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision, patch: { status: "done" } });
    denied(stale, "CONFLICT");
    assert.ok(!stale.ok && stale.current);
    assert.equal(stale.current.revision, updated.revision);
    assert.equal(stale.current.summary, "새로운 결정");
    assert.equal(other.readBoard().tasks[0]!.status, "doing");
    assert.equal(other.readBoard().activities.length, 2);
  } finally { other.close(); }
});

test("a sparse patch preserves every omitted field despite Zod default values", (t) => {
  const { store } = setup(t);
  const task = create(store, {
    title: "원래 제목", project: "CPX", description: "중요한 설명", status: "blocked", priority: "high",
    summary: "이전 상황", doneText: "기존 수행 내역", nextAction: "원래 다음 단계", blockedReason: "외부 자료 대기", evidence: "evidence.md",
  });
  const updated = success(store.mutate({ op: "update", requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision, patch: { summary: "새 상황" } }));
  for (const field of Object.keys(taskFieldsSchema.shape) as (keyof TaskFields)[]) {
    assert.equal(updated[field], field === "summary" ? "새 상황" : task[field], `${field} was unexpectedly replaced`);
  }
});

test("retry receipts persist and prevent duplicate creates and request-ID reuse", (t) => {
  const { store, path } = setup(t);
  const request = { op: "create" as const, requestId: randomUUID(), fields: taskFieldsSchema.parse({ title: "정확히 한 번" }) };
  const first = store.mutate(request);
  const created = success(first);
  const again = store.mutate(request);
  assert.ok(again.ok && again.replayed);
  assert.deepEqual(success(again), created);
  assert.equal(store.readBoard().tasks.length, 1);
  assert.equal(store.readBoard().activities.length, 1);
  denied(store.mutate({ ...request, fields: { ...request.fields, title: "다른 요청" } }), "REQUEST_ID_REUSED");
  store.close();
  const reopened = new WorklogStore(path);
  try {
    const replayed = reopened.mutate(request);
    assert.ok(replayed.ok && replayed.replayed);
    assert.equal(success(replayed).id, created.id);
    assert.equal(reopened.readBoard().activities.length, 1);
  } finally { reopened.close(); }
});

test("a note retry cannot append a second journal entry", (t) => {
  const { store } = setup(t);
  const task = create(store);
  const request = { op: "note" as const, requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision, message: "이 결정을 보존" };
  const first = success(store.mutate(request));
  const retry = store.mutate(request);
  assert.ok(retry.ok && retry.replayed);
  assert.equal(success(retry).revision, first.revision);
  assert.equal(store.readBoard().activities.filter((item) => item.kind === "note").length, 1);
});

test("composite host and agent identities avoid collisions and enforce one task per session", (t) => {
  const { store } = setup(t);
  const a = create(store, { title: "집 PC" }, session("home", "same-agent"));
  let b = create(store, { title: "기숙사 PC" }, session("dorm", "same-agent"));
  denied(store.mutate({ op: "link", requestId: randomUUID(), taskId: b.id, expectedRevision: b.revision, session: session("home", "same-agent") }), "ALREADY_LINKED");
  assert.equal(store.readBoard().tasks.find((task) => task.id === b.id)!.sessions[0]!.hostId, "dorm");
  success(store.mutate({ op: "unlink", requestId: randomUUID(), taskId: a.id, expectedRevision: a.revision, hostId: "home", agentId: "same-agent" }));
  b = success(store.mutate({ op: "link", requestId: randomUUID(), taskId: b.id, expectedRevision: b.revision, session: session("home", "same-agent") }));
  assert.equal(b.sessions.length, 2);
  // A naive colon-concatenated identifier would collide for these two pairs.
  create(store, { title: "첫 번째 키" }, session("a:b", "c"));
  create(store, { title: "두 번째 키" }, session("a", "b:c"));
  assert.equal(store.readBoard().tasks.length, 4);
});

test("fresh runtime observations neither complete a task nor conflict with a user edit", (t) => {
  const { store } = setup(t);
  const source = session();
  const task = create(store, { status: "doing" }, source);
  const beforeActivities = store.readBoard().activities.length;
  assert.deepEqual(store.observe([{ ...source, execution: "idle", observedAt: "2026-11-12T00:01:00.000Z" }]), { changed: 1 });
  let observed = store.readBoard().tasks[0]!;
  assert.equal(observed.revision, task.revision);
  assert.equal(observed.updatedAt, task.updatedAt);
  assert.equal(observed.status, "doing");
  assert.equal(observed.sessions[0]!.execution, "idle");
  assert.equal(store.readBoard().activities.length, beforeActivities + 1);
  store.observe([{ ...source, execution: "idle", observedAt: "2026-11-12T00:02:00.000Z" }]);
  assert.equal(store.readBoard().activities.length, beforeActivities + 1, "unchanged runtime polls must not flood history");
  assert.deepEqual(store.observe([{ ...source, execution: "working", observedAt: "2026-11-12T00:01:30.000Z" }]), { changed: 0 });
  assert.deepEqual(store.observe([]), { changed: 0 });
  observed = store.readBoard().tasks[0]!;
  assert.equal(observed.sessions[0]!.observedAt, "2026-11-12T00:02:00.000Z");
  assert.equal(observed.sessions[0]!.execution, "idle");
  assert.equal(success(store.mutate({ op: "update", requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision, patch: { nextAction: "다음 검토" } })).nextAction, "다음 검토");
});

test("an invalid observation batch writes nothing and an offline/missing host erases nothing", (t) => {
  const { store } = setup(t);
  const source = session();
  const task = create(store, { status: "doing" }, source);
  const before = store.readBoard();
  assert.throws(() => store.observe([
    { ...source, execution: "closed", observedAt: "2026-11-12T00:05:00.000Z" },
    session("other", "bad", { observedAt: "not-a-date" }),
  ]));
  assert.deepEqual(store.readBoard().tasks, before.tasks);
  assert.deepEqual(store.readBoard().activities, before.activities);
  store.observe([session("unrelated", "another-agent")]);
  assert.deepEqual(store.readBoard().tasks.find((item) => item.id === task.id), task);
});

test("a linked agent report records durable evidence and maps done to review", (t) => {
  const { store } = setup(t);
  const source = session();
  const task = create(store, { status: "doing" }, source);
  const report = reportFor(task, { status: "done" });
  const result = store.report(source.hostId, source.agentId, report);
  const updated = success(result);
  assert.equal(updated.status, "review");
  assert.equal(updated.evidence, report.evidence);
  assert.equal(updated.doneText, report.doneText);
  assert.equal(updated.nextAction, report.nextAction);
  assert.equal(updated.revision, task.revision + 1);
  const event = store.readBoard().activities[0]!;
  assert.equal(event.kind, "reported");
  assert.equal(event.actor, "agent");
  assert.match(event.message, /review\.md/);
  assert.match(event.message, /검토 상태/);
  const replay = store.report(source.hostId, source.agentId, report);
  assert.ok(replay.ok && replay.replayed);
  assert.equal(store.readBoard().activities.filter((item) => item.kind === "reported").length, 1);
  const completed = success(store.mutate({ op: "update", requestId: randomUUID(), taskId: task.id, expectedRevision: updated.revision, patch: { status: "done" } }));
  assert.equal(completed.status, "done", "an explicit user action may complete the task");
});

test("unlinked or wrong-host agents cannot report, create tasks, or overwrite a newer revision", (t) => {
  const { store } = setup(t);
  const source = session();
  const task = create(store, {}, source);
  const initial = store.readBoard();
  denied(store.report("another-host", source.agentId, reportFor(task)), "VALIDATION");
  denied(store.report(source.hostId, "another-agent", reportFor(task)), "VALIDATION");
  denied(store.report(source.hostId, source.agentId, reportFor(task, { taskId: "missing-task" })), "NOT_FOUND");
  assert.deepEqual(store.readBoard().tasks, initial.tasks);
  assert.deepEqual(store.readBoard().activities, initial.activities);
  const updated = success(store.mutate({ op: "update", requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision, patch: { summary: "사람의 새 지시" } }));
  denied(store.report(source.hostId, source.agentId, reportFor(task)), "CONFLICT");
  assert.equal(store.readBoard().tasks[0]!.summary, updated.summary);
  success(store.mutate({ op: "unlink", requestId: randomUUID(), taskId: task.id, expectedRevision: updated.revision, hostId: source.hostId, agentId: source.agentId }));
  denied(store.report(source.hostId, source.agentId, reportFor(store.readBoard().tasks[0]!)), "VALIDATION");
});

test("archive and restore preserve links and history and enforce revisions", (t) => {
  const { store } = setup(t);
  const source = session();
  const task = create(store, { status: "done", doneText: "완료한 작업" }, source);
  const archived = success(store.mutate({ op: "archive", requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision }));
  assert.ok(archived.archivedAt);
  assert.equal(archived.status, "done");
  assert.equal(archived.sessions.length, 1);
  denied(store.report(source.hostId, source.agentId, reportFor(archived)), "VALIDATION");
  denied(store.mutate({ op: "restore", requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision }), "CONFLICT");
  const restored = success(store.mutate({ op: "restore", requestId: randomUUID(), taskId: task.id, expectedRevision: archived.revision }));
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.doneText, "완료한 작업");
  assert.deepEqual(restored.sessions, task.sessions);
  assert.deepEqual(store.readBoard().activities.slice(0, 2).map((item) => item.kind), ["restored", "archived"]);
});

test("history pagination and both exports preserve records beyond the board's latest 200", (t) => {
  const { store } = setup(t);
  let task = create(store);
  for (let index = 0; index < 215; index += 1) {
    task = success(store.mutate({ op: "note", requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision, message: `기록 ${index}` }));
  }
  const other = create(store, { title: "별도 작업" });
  assert.equal(store.readBoard().activities.length, 200);
  const ids: number[] = [];
  let before: number | undefined;
  for (;;) {
    const page = store.listActivities({ taskId: task.id, before, limit: 50 });
    ids.push(...page.activities.map((activity) => activity.id));
    if (!page.hasMore) break;
    before = page.activities.at(-1)!.id;
  }
  assert.equal(ids.length, 216);
  assert.equal(new Set(ids).size, 216);
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
  assert.equal(store.listActivities({ taskId: other.id, limit: 50 }).activities.length, 1);
  const exported = JSON.parse(store.exportJson());
  assert.equal(exported.schemaVersion, 2);
  assert.equal(exported.tasks.length, 2);
  assert.equal(exported.activities.length, 217);
  const markdown = store.exportMarkdown();
  assert.match(markdown, /기록 0/);
  assert.match(markdown, /기록 214/);
  assert.match(markdown, /별도 작업/);
});

test("a journal write failure rolls back task mutation and receipt together", (t) => {
  const { store, path } = setup(t);
  const task = create(store);
  const admin = new DatabaseSync(path);
  try {
    admin.exec("CREATE TRIGGER reject_note BEFORE INSERT ON activities WHEN NEW.kind = 'note' BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END;");
    const request = { op: "note" as const, requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision, message: "원자적 저장" };
    assert.throws(() => store.mutate(request), /injected journal failure/);
    assert.deepEqual(store.readBoard().tasks[0], task);
    assert.equal(store.readBoard().activities.length, 1);
    admin.exec("DROP TRIGGER reject_note");
    const retry = store.mutate(request);
    assert.ok(retry.ok && !retry.replayed, "the failed transaction must not leave a successful receipt");
    assert.equal(success(retry).revision, task.revision + 1);
    assert.equal(store.readBoard().activities.length, 2);
  } finally { admin.close(); }
});

test("the task cap includes archived tasks and never silently deletes existing data", (t) => {
  const { store, path } = setup(t);
  const task = create(store);
  const admin = new DatabaseSync(path);
  try {
    admin.exec("BEGIN");
    const insert = admin.prepare("INSERT INTO tasks (id, revision, fields_json, created_at, updated_at, archived_at) SELECT ?, revision, fields_json, created_at, updated_at, created_at FROM tasks WHERE id = ?");
    for (let index = 1; index < 2_000; index += 1) insert.run(`fixture-${index}`, task.id);
    admin.exec("COMMIT");
    denied(store.mutate({ op: "create", requestId: randomUUID(), fields: taskFieldsSchema.parse({ title: "2001번째 작업" }) }), "LIMIT");
    assert.equal(store.readBoard().tasks.length, 2_000);
    assert.equal(store.readBoard().tasks.filter((item) => item.archivedAt).length, 1_999);
  } finally { admin.close(); }
});

test("corrupt, unrelated, and newer database files are rejected without resetting them", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-worklog-corrupt-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const corrupt = join(directory, "corrupt.db");
  const content = Buffer.from("this is existing data, not a SQLite database");
  writeFileSync(corrupt, content);
  assert.throws(() => new WorklogStore(corrupt));
  assert.deepEqual(readFileSync(corrupt), content);

  const unrelatedPath = join(directory, "unrelated.db");
  const unrelated = new DatabaseSync(unrelatedPath);
  unrelated.exec("CREATE TABLE precious (value TEXT); INSERT INTO precious VALUES ('keep me');");
  unrelated.close();
  assert.throws(() => new WorklogStore(unrelatedPath), /기존 데이터베이스/);
  const check = new DatabaseSync(unrelatedPath);
  assert.equal((check.prepare("SELECT value FROM precious").get() as { value: string }).value, "keep me");
  check.close();

  const futurePath = join(directory, "future.db");
  const original = new WorklogStore(futurePath);
  const task = create(original);
  original.close();
  const future = new DatabaseSync(futurePath);
  future.exec("PRAGMA user_version = 999");
  future.close();
  assert.throws(() => new WorklogStore(futurePath), /새 버전/);
  const verify = new DatabaseSync(futurePath);
  assert.equal((verify.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 999);
  assert.equal((verify.prepare("SELECT id FROM tasks").get() as { id: string }).id, task.id);
  verify.close();
});

test("v1 migration preserves task IDs, revisions, receipts, links and full activity history", (t) => {
  const { store, path } = setup(t);
  const request = { op: "create" as const, requestId: randomUUID(), fields: taskFieldsSchema.parse({ title: "v1 원본", doneText: "기존 완료 기록" }), session: session() };
  const created = success(store.mutate(request));
  const before = store.readBoard();
  store.close();
  // Remove only v2 additions to recreate the exact legacy v1 tables.
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE roster_members; DROP TABLE host_health; DROP TABLE metadata; PRAGMA user_version=1;");
  legacy.close();
  const migrated = new WorklogStore(path);
  try {
    assert.deepEqual(migrated.readBoard().tasks, before.tasks);
    assert.deepEqual(migrated.readBoard().activities, before.activities);
    const replay = migrated.mutate(request);
    assert.ok(replay.ok && replay.replayed);
    assert.equal(success(replay).id, created.id);
    assert.equal(migrated.readRoster().sessions.length, 1);
    assert.equal(migrated.readRoster().hosts[0]!.status, "stale");
    assert.equal(migrated.readRoster().hosts[0]!.lastSuccessAt, null);
    assert.ok(migrated.boardId());
    assert.equal(migrated.nextSequence(), 1);
    const boardId = migrated.boardId();
    migrated.close();
    const reopened = new WorklogStore(path);
    try { assert.equal(reopened.boardId(), boardId); assert.equal(reopened.nextSequence(), 2); }
    finally { reopened.close(); }
  } finally { migrated.close(); }
});

test("migration verifies the application ID before changing a v1 database", (t) => {
  const { store, path } = setup(t);
  const task = create(store);
  store.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE roster_members; DROP TABLE host_health; DROP TABLE metadata; PRAGMA user_version=1; PRAGMA application_id=123;");
  legacy.close();
  assert.throws(() => new WorklogStore(path), /식별자/);
  const verify = new DatabaseSync(path);
  try {
    assert.equal((verify.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
    assert.equal(verify.prepare("SELECT name FROM sqlite_master WHERE name='metadata'").get(), undefined);
    assert.equal((verify.prepare("SELECT id FROM tasks").get() as { id: string }).id, task.id);
  } finally { verify.close(); }
});

test("authoritative inventories defeat legacy clock skew, merge truncation and retain historical links", (t) => {
  const { store } = setup(t);
  const source = session("worker", "a", { observedAt: "2050-01-01T00:00:00.000Z" });
  const task = create(store, { status: "doing" }, source);
  store.recordHostResult({ hostId: "worker", label: "작업 PC", sequence: 1, status: "online", sessions: [{ ...source, execution: "idle" }], bridgeState: "ready" });
  const first = store.readRoster();
  assert.equal(first.sessions[0]!.execution, "idle");
  assert.ok(Date.parse(first.sessions[0]!.observedAt) < Date.parse(source.observedAt));
  assert.equal(store.readBoard().tasks[0]!.revision, task.revision);
  assert.equal(store.readBoard().tasks[0]!.status, "doing");
  const sourceB = session("worker", "b");
  store.recordHostResult({ hostId: "worker", label: "작업 PC", sequence: 2, status: "online", sessions: [sourceB], truncated: true });
  assert.equal(store.readRoster().sessions.length, 2);
  assert.equal(store.readRoster().hosts[0]!.truncated, true);
  const latestSuccess = store.readRoster().hosts[0]!.lastSuccessAt;
  store.recordHostResult({ hostId: "worker", label: "stale answer", sequence: 1, status: "online", sessions: [] });
  assert.equal(store.readRoster().sessions.length, 2);
  store.recordHostResult({ hostId: "worker", label: "작업 PC", sequence: 3, status: "offline", error: "connection lost" });
  assert.equal(store.readRoster().sessions.length, 2);
  assert.equal(store.readRoster().hosts[0]!.lastSuccessAt, latestSuccess);
  assert.equal(store.readRoster().hosts[0]!.status, "offline");
  store.recordHostResult({ hostId: "worker", label: "작업 PC", sequence: 4, status: "online", sessions: [] });
  assert.equal(store.readRoster().sessions.length, 0);
  assert.equal(store.readRoster().hosts[0]!.sessionCount, 0);
  assert.ok(store.readRoster().hosts[0]!.lastSuccessAt);
  const retained = store.readBoard().tasks[0]!;
  assert.equal(retained.sessions.length, 1);
  assert.equal(retained.sessions[0]!.execution, "idle");
  assert.equal(retained.status, "doing");
  assert.deepEqual(store.observe([{ ...source, execution: "working" }]), { changed: 0 });
  assert.equal(store.readRoster().sessions.length, 0, "a legacy UI poll must not revive an authoritative missing member");
  assert.equal(JSON.parse(store.exportJson()).sessions.length, 2, "history remains available after roster membership is removed");
  assert.equal(store.nextSequence(), 5);
});

test("a failed or foreign host inventory cannot partially overwrite persisted state", (t) => {
  const { store } = setup(t);
  store.recordHostResult({ hostId: "home", label: "Home", sequence: 1, status: "online", sessions: [session("home")] });
  const before = store.readRoster();
  assert.throws(() => store.recordHostResult({ hostId: "home", label: "Home", sequence: 2, status: "online", sessions: [session("home", "new"), session("dorm", "foreign")] }), /호스트/);
  assert.deepEqual(store.readRoster().sessions, before.sessions);
  assert.deepEqual(store.readRoster().hosts, before.hosts);
  store.recordHostResult({ hostId: "home", label: "Home", sequence: 2, status: "error", error: "read failed", queuedReports: 3, blockedReports: 1 });
  assert.deepEqual(store.readRoster().sessions, before.sessions);
  assert.equal(store.readRoster().hosts[0]!.lastSuccessAt, before.hosts[0]!.lastSuccessAt);
  assert.equal(store.readRoster().hosts[0]!.queuedReports, 3);
});

test("narrow host task lookup excludes archived tasks and disambiguates identical agent IDs", (t) => {
  const { store } = setup(t);
  const home = create(store, { title: "Home" }, session("home", "same"));
  const dorm = create(store, { title: "Dorm" }, session("dorm", "same"));
  assert.equal(store.getLinkedTask("home", "same")!.id, home.id);
  assert.equal(store.getLinkedTask("dorm", "same")!.id, dorm.id);
  assert.equal(store.getLinkedTask("other", "same"), null);
  assert.deepEqual(store.tasksForHost("home").map((task) => task.id), [home.id]);
  success(store.mutate({ op: "archive", requestId: randomUUID(), taskId: home.id, expectedRevision: home.revision }));
  assert.equal(store.getLinkedTask("home", "same"), null);
  assert.equal(store.tasksForHost("home").length, 0);
  assert.equal(store.tasksForHost("dorm").length, 1);
});

test("delivery receipts settle lost acknowledgements after unlink without exposing revoked task contents", (t) => {
  const { store } = setup(t);
  const source = session();
  const task = create(store, { description: "must not leak after unlink" }, source);
  const body = reportFor(task);
  const first = store.reportDelivery(source.hostId, source.agentId, body);
  assert.ok(first.ok && !first.replayed);
  success(store.mutate({ op: "unlink", requestId: randomUUID(), taskId: task.id, expectedRevision: first.appliedRevision, hostId: source.hostId, agentId: source.agentId }));
  const replay = store.reportDelivery(source.hostId, source.agentId, body);
  assert.deepEqual(replay, { ...first, replayed: true });
  assert.deepEqual(Object.keys(replay).sort(), ["appliedRevision", "ok", "replayed", "taskId"]);
  assert.ok(!JSON.stringify(replay).includes("must not leak"));
  denied(store.report(source.hostId, source.agentId, body), "VALIDATION");
  const spoof = store.reportDelivery("other-host", source.agentId, body);
  assert.ok(!spoof.ok && spoof.code === "REQUEST_ID_REUSED");
  const altered = store.reportDelivery(source.hostId, source.agentId, { ...body, nextAction: "altered payload" });
  assert.ok(!altered.ok && altered.code === "REQUEST_ID_REUSED");
  assert.equal(store.readBoard().activities.filter((event) => event.kind === "reported").length, 1);
});

test("delivery proof remains available after archive while fresh unauthorized reports are rejected", (t) => {
  const { store } = setup(t);
  const source = session();
  const task = create(store, {}, source);
  const body = reportFor(task);
  const applied = store.reportDelivery(source.hostId, source.agentId, body);
  assert.ok(applied.ok);
  const archived = success(store.mutate({ op: "archive", requestId: randomUUID(), taskId: task.id, expectedRevision: applied.appliedRevision }));
  const proof = store.reportDelivery(source.hostId, source.agentId, body);
  assert.ok(proof.ok && proof.replayed);
  assert.ok(!("task" in proof) && !("current" in proof));
  const fresh = store.reportDelivery(source.hostId, source.agentId, reportFor(archived));
  assert.ok(!fresh.ok && fresh.code === "VALIDATION");
  denied(store.report(source.hostId, source.agentId, body), "VALIDATION");
});
