import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AutoLinkRules, groupProject } from "../server/autolink.ts";
import { WorklogStore } from "../server/store.ts";
import type { SessionSnapshot } from "../shared/model.ts";

function harness(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "worklog-autolink-"));
  const store = new WorklogStore(join(directory, "worklog.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const rules = new AutoLinkRules(join(directory, "autolink-rules.json"));
  const collect = (hostId: string, sessions: SessionSnapshot[]) =>
    store.recordHostResult({ hostId, label: hostId, sequence: store.nextSequence(), status: "online", sessions });
  return { store, rules, collect, directory };
}

const session = (agentId: string, cwd: string, activityAt: string, changes: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  hostId: "pc-a", hostLabel: "pc-a", agentId, workspaceId: null, title: agentId, provider: "claude", cwd,
  execution: "idle", observedAt: activityAt, parentAgentId: null, activityAt, ...changes,
});

test("grouping creates a folder task, links only that folder's recent open sessions once, and records a rule", (t) => {
  const { store, rules } = harness(t);
  const at = new Date().toISOString();
  const result = groupProject(store, rules, { requestId: "request-group-1", folder: "imaging", autoLink: true, sessions: [
    session("a1", "C:/PROJECT/imaging", at),
    session("a2", "/home/k/Imaging", at, { hostId: "pc-b" }),
    session("other", "C:/PROJECT/bun", at),
    session("child", "C:/PROJECT/imaging", at, { parentAgentId: "a1" }),
    session("closed", "C:/PROJECT/imaging", at, { execution: "closed" }),
  ] });
  assert.equal(result.task.title, "imaging");
  assert.equal(result.task.status, "doing");
  assert.deepEqual(result.task.sessions.map((entry) => entry.agentId).sort(), ["a1", "a2"]);
  assert.equal(result.linked, 2);
  assert.equal(result.rule?.folder, "imaging");
  assert.deepEqual(rules.list().rules.map((rule) => rule.taskId), [result.task.id]);
  const again = groupProject(store, rules, { requestId: "request-group-2", folder: "imaging", taskId: result.task.id, autoLink: false,
    sessions: [session("a1", "C:/PROJECT/imaging", at)] });
  assert.equal(again.linked, 0, "already linked sessions are skipped, not duplicated");
  assert.equal(again.rule, null);
});

test("auto-link attaches new sessions of the folder from any PC, skips older ones, and pauses for done tasks", (t) => {
  const { store, rules, collect } = harness(t);
  const before = new Date(Date.now() - 60_000).toISOString();
  const { task } = groupProject(store, rules, { requestId: "request-group-3", folder: "imaging", autoLink: true, sessions: [] });
  const after = new Date(Date.now() + 1_000).toISOString();
  collect("pc-a", [session("old", "C:/PROJECT/imaging", before), session("new", "C:/PROJECT/imaging", after),
    session("elsewhere", "C:/PROJECT/bun", after)]);
  collect("pc-b", [session("remote", "/home/k/imaging", after, { hostId: "pc-b" })]);
  assert.equal(rules.apply(store), 2);
  const linked = store.readBoard().tasks.find((entry) => entry.id === task.id)!;
  assert.deepEqual(linked.sessions.map((entry) => entry.agentId).sort(), ["new", "remote"]);
  assert.ok(store.readBoard().activities.some((activity) => activity.actor === "system" && activity.message.startsWith("자동 연결:")));
  assert.equal(rules.apply(store), 0, "a second pass changes nothing");

  const current = store.readBoard().tasks.find((entry) => entry.id === task.id)!;
  const done = store.mutate({ op: "update", requestId: "request-done-1", taskId: task.id, expectedRevision: current.revision, patch: { status: "done" } });
  assert.ok(done.ok);
  collect("pc-a", [session("later", "C:/PROJECT/imaging", new Date(Date.now() + 2_000).toISOString())]);
  assert.equal(rules.apply(store), 0, "a done task pauses its rule");
  assert.equal(rules.list().rules.length, 1, "but keeps it");
});

test("a rule whose task no longer exists is dropped; removing a rule stops linking", (t) => {
  const { store, rules, collect } = harness(t);
  rules.set({ folder: "ghost", label: "ghost", taskId: "missing-task", createdAt: new Date(0).toISOString() });
  const { task } = groupProject(store, rules, { requestId: "request-group-4", folder: "bun", autoLink: true, sessions: [] });
  rules.apply(store);
  assert.deepEqual(rules.list().rules.map((rule) => rule.folder), ["bun"]);
  rules.remove("BUN");
  collect("pc-a", [session("fresh", "C:/PROJECT/bun", new Date(Date.now() + 1_000).toISOString())]);
  assert.equal(rules.apply(store), 0);
  assert.equal(store.readBoard().tasks.find((entry) => entry.id === task.id)!.sessions.length, 0);
});
