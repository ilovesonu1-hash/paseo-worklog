import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { WorklogRuntime } from "../server/runtime.ts";
import { WorklogStore } from "../server/store.ts";
import { WorkerStore } from "../server/worker-store.ts";
import type { PaseoApi, PaseoConnection, PaseoTransport } from "../server/paseo-transport.ts";
import { taskFieldsSchema, type AgentReport, type MutationResult, type SessionSnapshot, type Task } from "../shared/model.ts";
import { exchangeInputSchema, syncConfigSchema, type ExchangeInput, type ExchangeResult, type SyncConfig } from "../shared/sync.ts";
import type { RosterAgentEntry, RosterPage, RosterWorkspace } from "../shared/session-roster.ts";

type AgentPage = RosterPage<RosterAgentEntry>;
type WorkspacePage = RosterPage<RosterWorkspace>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function page<T>(entries: T[]): RosterPage<T> {
  return { entries, pageInfo: { hasMore: false, nextCursor: null } };
}

function agent(id: string, changes: Partial<RosterAgentEntry["agent"]> = {}): RosterAgentEntry {
  return { agent: { id, title: `Session ${id}`, provider: "codex", cwd: "/project", status: "idle", ...changes } };
}

function session(hostId: string, agentId = "same-agent"): SessionSnapshot {
  return {
    hostId, hostLabel: hostId, agentId, workspaceId: null, title: `Session ${agentId}`,
    provider: "codex", cwd: "/project", execution: "idle", parentAgentId: null,
    observedAt: "2026-11-12T00:00:00.000Z",
  };
}

function success(result: MutationResult): Task {
  if (!result.ok) assert.fail(JSON.stringify(result));
  return result.task;
}

function createTask(store: WorklogStore, source: SessionSnapshot, title = "작업"): Task {
  return success(store.mutate({
    op: "create", requestId: randomUUID(), fields: taskFieldsSchema.parse({ title, status: "doing", summary: "처음 상태" }), session: source,
  }));
}

function report(task: Task, changes: Partial<AgentReport> = {}): AgentReport {
  return {
    requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision,
    summary: "실제로 수행한 결과", doneText: "검증을 실행했습니다.", nextAction: "사용자 검토",
    evidence: "result.txt", ...changes,
  };
}

interface FakeHost {
  id: string;
  label: string;
  enabled: boolean;
  agents: RosterAgentEntry[];
  workspaces: RosterWorkspace[];
  agentReads: number;
  workspaceReads: number;
  connectError: Error | null;
  readAgents?: () => Promise<AgentPage>;
  readWorkspaces?: () => Promise<WorkspacePage>;
  worker: WorkerStore;
  exchanges: ExchangeInput[];
  exchange?: (input: ExchangeInput, perform: () => ExchangeResult) => unknown | Promise<unknown>;
}

/** Real SQLite stores; only native host discovery, inventory and transport are fake. */
function fixture(t: TestContext, remoteIds: string[] = []) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new WorklogStore(":memory:");
  const control = new WorkerStore(":memory:");
  const peers = new Map<string, FakeHost>();
  const host = (id: string): FakeHost => ({
    id, label: `Host ${id}`, enabled: true, agents: [agent("same-agent")], workspaces: [],
    agentReads: 0, workspaceReads: 0, connectError: null,
    worker: id === "central" ? control : new WorkerStore(":memory:"), exchanges: [],
  });
  const local = host("central");
  for (const id of remoteIds) {
    const peer = host(id);
    const configured = peer.worker.configure(1, syncConfigSchema.parse({ role: "satellite", centralServerId: "central" }));
    assert.equal(configured.ok, true);
    peers.set(id, peer);
  }
  assert.equal(control.configure(1, syncConfigSchema.parse({ remoteHostIds: remoteIds })).ok, true);
  const connections = new Map<string, PaseoConnection>();
  const remoteCalls: string[] = [];
  const invalidated: Array<string | undefined> = [];
  let closeCalls = 0;
  let closed = false;
  const directory = () => ({
    self: { serverId: "central", label: local.label },
    hosts: [...peers.values()].map((peer) => ({
      registrationId: `registration-${peer.id}`, serverId: peer.id, label: peer.label,
      source: { id: "test", key: peer.id }, metadata: {}, enabled: peer.enabled,
      status: peer.enabled ? "online" : "disabled", targetDescription: "test native host",
      lastOnlineAt: null, nextRetryAt: null, error: null,
    })),
  });
  function connection(peer: FakeHost): PaseoConnection {
    let current = connections.get(peer.id);
    if (current) return current;
    const api = {
      hosts: { list: async () => peer.id === "central" ? directory() : ({ self: { serverId: peer.id, label: peer.label }, hosts: [] }) },
      agents: { list: async () => { peer.agentReads += 1; return peer.readAgents ? peer.readAgents() : page(peer.agents); } },
      workspaces: { list: async () => { peer.workspaceReads += 1; return peer.readWorkspaces ? peer.readWorkspaces() : page(peer.workspaces); } },
      dispose: async () => {},
    } as unknown as PaseoApi;
    current = {
      serverId: peer.id, label: peer.label, paseo: api,
      async rpc(method, value) {
        assert.equal(method, "bridge.exchange");
        const input = exchangeInputSchema.parse(value);
        peer.exchanges.push(structuredClone(input));
        const perform = () => peer.worker.exchange(input, peer.id);
        return peer.exchange ? peer.exchange(input, perform) : perform();
      },
    };
    connections.set(peer.id, current);
    return current;
  }
  const transport: PaseoTransport = {
    async local() {
      if (closed) throw new Error("transport closed");
      return connection(local);
    },
    async remote(id) {
      if (closed) throw new Error("transport closed");
      remoteCalls.push(id);
      const peer = peers.get(id);
      if (!peer) throw new Error("host unknown");
      if (peer.connectError) throw peer.connectError;
      return connection(peer);
    },
    async invalidate(id) { invalidated.push(id); },
    async close() { if (!closed) closeCalls += 1; closed = true; },
  };
  const runtime = new WorklogRuntime(store, control, transport);
  const configure = (patch: Partial<SyncConfig>) => {
    const previous = control.readConfig();
    const result = runtime.configure(previous.revision, syncConfigSchema.parse({ ...previous.config, ...patch }));
    assert.equal(result.ok, true, result.ok ? undefined : result.message);
    return result;
  };
  t.after(async () => {
    await runtime.stop();
    for (const peer of peers.values()) peer.worker.close();
    control.close();
    store.close();
  });
  return { store, control, peers, local, runtime, configure, remoteCalls, invalidated, closeCalls: () => closeCalls };
}

test("startup collects existing sessions on its server timer without a board UI", async (t) => {
  const h = fixture(t, ["worker"]);
  const entered = deferred<void>();
  h.local.readAgents = async () => { entered.resolve(); return page(h.local.agents); };
  h.runtime.start();
  t.mock.timers.tick(0);
  await entered.promise;
  assert.equal(h.local.agentReads, 1); // Started before any explicit runOnce or UI request.
  await h.runtime.runOnce(); // Join the already active cycle.
  assert.deepEqual(h.store.readRoster().sessions.map((item) => item.hostId).sort(), ["central", "worker"]);
  assert.equal(h.peers.get("worker")!.exchanges.length, 1);
  assert.equal(h.runtime.status().running, true);
  assert.equal(h.runtime.status().error, null);
});

test("a successful empty inventory clears that inbox while retaining linked session history", async (t) => {
  const h = fixture(t, ["worker"]);
  const peer = h.peers.get("worker")!;
  const task = createTask(h.store, session("worker"));
  await h.runtime.runOnce();
  const saved = h.store.readBoard().tasks.find((item) => item.id === task.id)!;
  peer.agents = [];
  peer.workspaces = [];
  await h.runtime.runOnce();
  assert.deepEqual(h.store.readRoster().sessions.map((item) => item.hostId), ["central"]);
  const health = h.store.readRoster().hosts.find((item) => item.hostId === "worker")!;
  assert.equal(health.status, "online");
  assert.equal(health.sessionCount, 0);
  assert.ok(health.lastSuccessAt);
  const after = h.store.readBoard().tasks.find((item) => item.id === task.id)!;
  assert.deepEqual(after.sessions, saved.sessions);
  assert.equal(after.status, "doing");
  assert.equal(after.revision, task.revision);
});

test("one unreachable host keeps its last snapshot while other hosts continue updating", async (t) => {
  const h = fixture(t, ["worker-a", "worker-b"]);
  await h.runtime.runOnce();
  const before = h.store.readRoster().sessions.find((item) => item.hostId === "worker-a")!;
  h.peers.get("worker-a")!.connectError = new Error("Cannot connect tcp://user:PRIVATE_PASSWORD@host:7777?password=PRIVATE_PASSWORD");
  h.peers.get("worker-b")!.agents = [agent("new-agent", { status: "running" })];
  await h.runtime.runOnce();
  const roster = h.store.readRoster();
  assert.deepEqual(roster.sessions.find((item) => item.hostId === "worker-a"), before);
  assert.equal(roster.hosts.find((item) => item.hostId === "worker-a")!.status, "offline");
  assert.equal(roster.sessions.find((item) => item.hostId === "worker-b")!.agentId, "new-agent");
  assert.equal(roster.sessions.find((item) => item.hostId === "worker-b")!.execution, "working");
  assert.equal(roster.hosts.find((item) => item.hostId === "worker-b")!.bridgeState, "ready");
  assert.equal(JSON.stringify(h.runtime.status()).includes("PRIVATE_PASSWORD"), false);
});

test("a bridge failure preserves last confirmed report counts while a fresh inventory succeeds", async (t) => {
  const h = fixture(t, ["worker"]);
  const peer = h.peers.get("worker")!;
  // Report counts come from the independent remote bridge response.
  peer.exchange = (_input, perform) => ({ ...perform(), queued: 3, blocked: 2 });
  await h.runtime.runOnce();
  const confirmed = h.store.readRoster().hosts.find((item) => item.hostId === "worker")!;
  assert.equal(confirmed.queuedReports, 3);
  assert.equal(confirmed.blockedReports, 2);
  assert.equal(confirmed.bridgeState, "ready");

  peer.agents = [agent("new-session", { status: "running" })];
  peer.exchange = () => { throw new Error("bridge timeout"); };
  await h.runtime.runOnce();
  const roster = h.store.readRoster();
  const health = roster.hosts.find((item) => item.hostId === "worker")!;
  assert.equal(health.status, "online");
  assert.equal(health.bridgeState, "error");
  assert.ok(health.error);
  assert.equal(health.queuedReports, 3);
  assert.equal(health.blockedReports, 2);
  assert.equal(roster.sessions.find((item) => item.hostId === "worker")!.agentId, "new-session");
  assert.equal(roster.sessions.find((item) => item.hostId === "worker")!.execution, "working");
});

test("deselecting a host during an awaited inventory cannot commit its late response", async (t) => {
  const h = fixture(t, ["worker"]);
  const peer = h.peers.get("worker")!;
  await h.runtime.runOnce();
  const before = h.store.readRoster().sessions.find((item) => item.hostId === "worker")!;
  const entered = deferred<void>();
  const reply = deferred<AgentPage>();
  peer.readAgents = async () => { entered.resolve(); return reply.promise; };
  const exchangeCount = peer.exchanges.length;
  const flight = h.runtime.runOnce();
  try {
    await entered.promise;
    h.configure({ remoteHostIds: [] });
    reply.resolve(page([agent("late-result")]));
    await flight;
    assert.deepEqual(h.store.readRoster().sessions.find((item) => item.hostId === "worker"), before);
    assert.equal(peer.exchanges.length, exchangeCount);
    assert.ok(h.invalidated.includes("worker"));
  } finally { reply.resolve(page([])); await flight; }
});

test("pausing while reports are in flight applies neither stale reports nor their acknowledgements", async (t) => {
  const h = fixture(t, ["worker"]);
  const peer = h.peers.get("worker")!;
  const task = createTask(h.store, session("worker"));
  await h.runtime.runOnce();
  const request = report(task);
  assert.equal(peer.worker.enqueue("worker", "same-agent", request).delivery, "queued");
  const entered = deferred<void>();
  const reply = deferred<void>();
  peer.exchange = async (_input, perform) => { const result = perform(); entered.resolve(); await reply.promise; return result; };
  const callCount = peer.exchanges.length;
  const flight = h.runtime.runOnce();
  try {
    await entered.promise;
    h.configure({ enabled: false });
    reply.resolve();
    await flight;
    assert.equal(h.store.readBoard().tasks[0].revision, task.revision);
    assert.equal(h.store.readBoard().tasks[0].summary, "처음 상태");
    assert.equal(peer.worker.state().queued, 1);
    assert.equal(peer.exchanges.slice(callCount).filter((item) => item.acknowledgements.length > 0).length, 0);
    assert.equal(h.store.readRoster().hosts.find((item) => item.hostId === "worker")!.bridgeState, "paused");
    peer.exchange = undefined;
    h.configure({ enabled: true });
    await h.runtime.runOnce();
    assert.equal(peer.worker.state().applied, 1);
    assert.equal(h.store.readBoard().tasks[0].revision, task.revision + 1);
  } finally { reply.resolve(); await flight; }
});

test("deselection, pause and satellite mode release remote routes and stop collection", async (t) => {
  const h = fixture(t, ["worker-a", "worker-b"]);
  await h.runtime.runOnce();
  h.configure({ remoteHostIds: ["worker-b"] });
  assert.ok(h.invalidated.includes("worker-a"));
  const calls = h.remoteCalls.length;
  await h.runtime.runOnce();
  assert.deepEqual(h.remoteCalls.slice(calls), ["worker-b"]);
  assert.equal(h.store.readRoster().hosts.find((item) => item.hostId === "worker-a")!.status, "disabled");
  h.configure({ enabled: false });
  assert.ok(h.invalidated.includes("worker-b"));
  const reads = h.local.agentReads + [...h.peers.values()].reduce((sum, peer) => sum + peer.agentReads, 0);
  await h.runtime.runOnce();
  assert.equal(h.local.agentReads + [...h.peers.values()].reduce((sum, peer) => sum + peer.agentReads, 0), reads);
  assert.equal(h.runtime.refresh().scheduled, false);
  h.configure({ enabled: true, role: "satellite", centralServerId: "another-central" });
  await h.runtime.runOnce();
  assert.equal(h.local.agentReads + [...h.peers.values()].reduce((sum, peer) => sum + peer.agentReads, 0), reads);
  assert.equal(h.runtime.refresh().scheduled, false);
});

test("concurrent refresh requests share the active collection instead of overlapping inventories", async (t) => {
  const h = fixture(t);
  const entered = deferred<void>();
  const reply = deferred<AgentPage>();
  h.local.readAgents = async () => { entered.resolve(); return reply.promise; };
  const first = h.runtime.runOnce();
  try {
    await entered.promise;
    assert.equal(h.runtime.runOnce(), first);
    h.runtime.refresh();
    assert.equal(h.local.agentReads, 1);
    reply.resolve(page([agent("collected-once")]));
    await first;
    assert.equal(h.local.agentReads, 1);
    assert.deepEqual(h.store.readRoster().sessions.map((item) => item.agentId), ["collected-once"]);
  } finally { reply.resolve(page([])); await first; }
});

test("report identity comes from the verified route even if a body claims another host", async (t) => {
  const h = fixture(t, ["worker", "other"]);
  const peer = h.peers.get("worker")!;
  const own = createTask(h.store, session("worker"), "Worker task");
  const other = createTask(h.store, session("other"), "Other task");
  await h.runtime.runOnce();
  assert.equal(peer.worker.enqueue("worker", "same-agent", report(own, { status: "done" })).delivery, "queued");
  peer.exchange = (_input, perform) => {
    const response = perform();
    return { ...response, reports: response.reports.map((item) => ({ ...item, hostId: "other", report: { ...item.report, hostId: "other" } })) };
  };
  await h.runtime.runOnce();
  const tasks = h.store.readBoard().tasks;
  assert.equal(tasks.find((item) => item.id === own.id)!.status, "review");
  assert.equal(tasks.find((item) => item.id === other.id)!.revision, other.revision);
  const recorded = h.store.readBoard().activities.filter((item) => item.kind === "reported");
  assert.equal(recorded.length, 1);
  assert.match(recorded[0].message, /worker · same-agent/);
  assert.doesNotMatch(recorded[0].message, /other · same-agent/);
  assert.equal(peer.worker.state().applied, 1);
});

test("a bridge response with the wrong worker identity cannot apply or acknowledge reports", async (t) => {
  const h = fixture(t, ["worker"]);
  const peer = h.peers.get("worker")!;
  const task = createTask(h.store, session("worker"));
  await h.runtime.runOnce();
  peer.worker.enqueue("worker", "same-agent", report(task));
  const beforeCalls = peer.exchanges.length;
  peer.exchange = (_input, perform) => ({ ...perform(), workerHostId: "another-worker" });
  await h.runtime.runOnce();
  assert.equal(h.store.readBoard().tasks[0].revision, task.revision);
  assert.equal(peer.worker.state().queued, 1);
  assert.equal(peer.exchanges.slice(beforeCalls).some((item) => item.acknowledgements.length > 0), false);
  assert.notEqual(h.store.readRoster().hosts.find((item) => item.hostId === "worker")!.bridgeState, "ready");
});

for (const lossPoint of ["before-delivery", "after-delivery"] as const) {
  test(`lost acknowledgement ${lossPoint} converges without a duplicate report or revision`, async (t) => {
    const h = fixture(t, ["worker"]);
    const peer = h.peers.get("worker")!;
    const task = createTask(h.store, session("worker"));
    await h.runtime.runOnce();
    peer.worker.enqueue("worker", "same-agent", report(task));
    let lost = false;
    peer.exchange = (input, perform) => {
      if (input.acknowledgements.length && !lost) {
        lost = true;
        if (lossPoint === "after-delivery") perform();
        throw new Error("acknowledgement timeout");
      }
      return perform();
    };
    await h.runtime.runOnce();
    assert.equal(lost, true);
    assert.equal(h.store.readBoard().tasks[0].revision, task.revision + 1);
    assert.equal(peer.worker.state().queued, lossPoint === "before-delivery" ? 1 : 0);
    await h.runtime.runOnce();
    await h.runtime.runOnce();
    assert.equal(h.store.readBoard().tasks[0].revision, task.revision + 1);
    assert.equal(h.store.readBoard().activities.filter((item) => item.kind === "reported").length, 1);
    assert.equal(peer.worker.state().queued, 0);
    assert.equal(peer.worker.state().applied, 1);
    assert.equal(peer.worker.state().blocked, 0);
    const acknowledgement = peer.worker.state().deliveries[0].result!;
    assert.equal(acknowledgement.ok, true);
    assert.equal("task" in acknowledgement, false);
  });
}

test("a lost ACK followed by unlink replays the original applied receipt without another mutation", async (t) => {
  const h = fixture(t, ["worker"]);
  const peer = h.peers.get("worker")!;
  const task = createTask(h.store, session("worker"));
  await h.runtime.runOnce();
  peer.worker.enqueue("worker", "same-agent", report(task));
  let lost = false;
  peer.exchange = (input, perform) => {
    if (input.acknowledgements.length && !lost) { lost = true; throw new Error("acknowledgement timeout"); }
    return perform();
  };
  await h.runtime.runOnce();
  const applied = h.store.readBoard().tasks[0];
  assert.equal(applied.revision, task.revision + 1);
  const unlinked = success(h.store.mutate({ op: "unlink", requestId: randomUUID(), taskId: task.id, expectedRevision: applied.revision, hostId: "worker", agentId: "same-agent" }));
  await h.runtime.runOnce();
  assert.equal(h.store.readBoard().tasks[0].revision, unlinked.revision);
  assert.equal(h.store.readBoard().activities.filter((item) => item.kind === "reported").length, 1);
  assert.equal(peer.worker.state().applied, 1);
  assert.equal(peer.worker.state().queued, 0);
  assert.equal(peer.worker.state().blocked, 0);
  assert.equal(peer.worker.getLinkedTask("worker", "same-agent").task, null);
});

test("a queued report with an outdated revision is preserved as blocked and cannot overwrite a user edit", async (t) => {
  const h = fixture(t, ["worker"]);
  const peer = h.peers.get("worker")!;
  const task = createTask(h.store, session("worker"));
  await h.runtime.runOnce();
  peer.worker.enqueue("worker", "same-agent", report(task));
  const edited = success(h.store.mutate({ op: "update", requestId: randomUUID(), taskId: task.id, expectedRevision: task.revision, patch: { summary: "사용자의 새로운 지시" } }));
  await h.runtime.runOnce();
  assert.equal(h.store.readBoard().tasks[0].revision, edited.revision);
  assert.equal(h.store.readBoard().tasks[0].summary, "사용자의 새로운 지시");
  assert.equal(peer.worker.state().queued, 0);
  assert.equal(peer.worker.state().blocked, 1);
  const outcome = peer.worker.state().deliveries[0].result;
  assert.ok(outcome && !outcome.ok);
  assert.equal(outcome.code, "CONFLICT");
  assert.equal(peer.worker.getLinkedTask("worker", "same-agent").task!.revision, edited.revision);
});

test("stop discards a late inventory response and does not schedule any future collection", async (t) => {
  const h = fixture(t);
  const entered = deferred<void>();
  const reply = deferred<AgentPage>();
  h.local.readAgents = async () => { entered.resolve(); return reply.promise; };
  const flight = h.runtime.runOnce();
  try {
    await entered.promise;
    const stopping = h.runtime.stop();
    reply.resolve(page([agent("arrived-after-stop")]));
    await stopping;
    await flight;
    assert.equal(h.store.readRoster().sessions.length, 0);
    assert.equal(h.closeCalls(), 1);
    assert.equal(h.runtime.refresh().scheduled, false);
    await h.runtime.runOnce();
    t.mock.timers.tick(60_000);
    assert.equal(h.local.agentReads, 1);
  } finally { reply.resolve(page([])); await flight; }
});

test("an unexpected storage error in a host runner is surfaced instead of swallowed", async (t) => {
  const h = fixture(t);
  t.mock.method(h.store, "recordHostResult", () => { throw new Error("simulated database write failure"); });
  await h.runtime.runOnce();
  assert.ok(h.runtime.status().error);
  assert.equal(h.store.readRoster().sessions.length, 0);
});
