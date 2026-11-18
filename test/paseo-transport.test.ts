import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPaseoTransport,
  readLocalDaemonTarget,
  readOwnLocalCredential,
  type LocalDaemonTarget,
  type PaseoApi,
  type PaseoTransportRuntime,
} from "../server/paseo-transport.ts";

type NativeClient = ReturnType<PaseoTransportRuntime["createLocal"]>;
const target: LocalDaemonTarget = { listen: "127.0.0.1:6789", serverId: "central", pid: process.pid, startedAt: "2026-11-12T00:00:00Z" };
const credential = "A".repeat(43);
const hasCode = (code: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === code;

class FakeClient implements NativeClient {
  id: string;
  isConnected = false;
  disposed = false;
  connectCalls = 0;
  closeCalls = 0;
  disposeApiCalls = 0;
  reconnect = false;
  blocked = false;
  directoryId: string | null = null;
  rejectConnect: ((reason: Error) => void) | null = null;
  calls: Array<{ pluginId: string; method: string; input: unknown }> = [];

  constructor(id: string) { this.id = id; }
  async connect(): Promise<void> {
    if (this.disposed) throw new Error("disposed");
    if (this.isConnected) return;
    this.connectCalls += 1;
    if (this.blocked) await new Promise<void>((_resolve, reject) => { this.rejectConnect = reject; });
    if (this.disposed) throw new Error("disposed");
    this.isConnected = true;
  }
  async close(): Promise<void> {
    if (this.disposed) return;
    this.closeCalls += 1;
    this.disposed = true;
    this.isConnected = false;
    this.rejectConnect?.(new Error("closed"));
  }
  setReconnectEnabled(value: boolean): void { this.reconnect = value; }
  requireConnectedHosts(): void { if (!this.isConnected) throw new Error("origin offline"); }
  getLastServerInfoMessage() { return this.isConnected ? { serverId: this.id } : null; }
  async invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown> {
    const request = { pluginId, method, input };
    this.calls.push(request);
    return request;
  }
  updateCalls: Array<{ kind: "preview" | "apply"; input: unknown }> = [];
  async previewPluginUpdates(options?: { pluginId?: string }): Promise<unknown> {
    this.updateCalls.push({ kind: "preview", input: options });
    return [];
  }
  async applyPluginUpdates(proposals: unknown[]): Promise<unknown> {
    this.updateCalls.push({ kind: "apply", input: proposals });
    return [];
  }
}

function harness() {
  const locals: FakeClient[] = [];
  const remotes: FakeClient[] = [];
  const routes: string[] = [];
  const remoteIdentities: string[] = [];
  let prepareLocal: (client: FakeClient) => void = () => {};
  let prepareRemote: (client: FakeClient) => void = () => {};
  const runtime: PaseoTransportRuntime = {
    readTarget: async () => target,
    readCredential: async () => credential,
    createLocal(_connection, _config) {
      const client = new FakeClient("central");
      locals.push(client);
      prepareLocal(client);
      return client;
    },
    route(_origin, serverId) { routes.push(serverId); return { serverId }; },
    createRemote(config) {
      const { serverId } = config.transportFactory as { serverId: string };
      const client = new FakeClient(remoteIdentities.shift() ?? serverId);
      remotes.push(client);
      prepareRemote(client);
      return client;
    },
    api(native) {
      const client = native as FakeClient;
      return {
        hosts: { list: async () => ({ self: { serverId: client.directoryId ?? client.id, label: `Host ${client.id}` }, hosts: [] }) },
        dispose: async () => { client.disposeApiCalls += 1; },
      } as unknown as PaseoApi;
    },
  };
  return {
    runtime, locals, remotes, routes, remoteIdentities,
    prepareLocal(callback: typeof prepareLocal) { prepareLocal = callback; },
    prepareRemote(callback: typeof prepareRemote) { prepareRemote = callback; },
  };
}

test("reads only the selected home's running instance and rotates its own credential", async () => {
  const home = await mkdtemp(join(tmpdir(), "worklog-transport-home-"));
  try {
    await writeFile(join(home, "paseo.pid"), JSON.stringify(target));
    await writeFile(join(home, "local-credential"), `${credential}\n`, { mode: 0o600 });
    assert.deepEqual(await readLocalDaemonTarget(home), target);
    assert.equal(await readOwnLocalCredential(home, target), credential);
    const rotated = "B".repeat(43);
    await writeFile(join(home, "local-credential"), rotated);
    assert.equal(await readOwnLocalCredential(home, target), rotated);
    await writeFile(join(home, "paseo.pid"), JSON.stringify({ ...target, serverId: "replacement" }));
    await assert.rejects(readOwnLocalCredential(home, target), hasCode("LOCAL_INSTANCE_CHANGED"));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("missing or malformed local state never leaks credential contents in errors", async () => {
  const home = await mkdtemp(join(tmpdir(), "worklog-transport-invalid-"));
  try {
    await assert.rejects(readLocalDaemonTarget(home), hasCode("LOCAL_DAEMON_NOT_READY"));
    await writeFile(join(home, "paseo.pid"), JSON.stringify({ ...target, listen: null }));
    await assert.rejects(readLocalDaemonTarget(home), hasCode("LOCAL_DAEMON_NOT_READY"));
    await writeFile(join(home, "paseo.pid"), JSON.stringify(target));
    await writeFile(join(home, "local-credential"), "PRIVATE_BAD_VALUE_DO_NOT_PRINT");
    await assert.rejects(readOwnLocalCredential(home, target), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("PRIVATE_BAD_VALUE"), false);
      return hasCode("LOCAL_CREDENTIAL_UNAVAILABLE")(error);
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("coalesces callers, routes through the local daemon, and restricts RPC to Worklog", async () => {
  const h = harness();
  const transport = createPaseoTransport({}, h.runtime);
  try {
    const [first, second, local] = await Promise.all([transport.remote("worker"), transport.remote("worker"), transport.local()]);
    assert.equal(first, second);
    assert.equal(h.locals.length, 1);
    assert.equal(h.remotes.length, 1);
    assert.deepEqual(h.routes, ["worker"]);
    assert.equal(first.serverId, "worker");
    assert.equal(first.label, "Host worker");
    assert.equal(await transport.remote("central"), local);
    const result = await first.rpc("bridge.exchange", { centralServerId: "central" });
    assert.deepEqual(result, { pluginId: "worklog-board", method: "bridge.exchange", input: { centralServerId: "central" } });
    await assert.rejects(first.rpc("other:method", {}), hasCode("INVALID_RPC_METHOD"));
    assert.equal(h.remotes[0].calls.length, 1);
  } finally { await transport.close(); }
});

test("plugin updates are scoped to Worklog on the verified host and stop after close", async () => {
  const h = harness();
  const transport = createPaseoTransport({}, h.runtime);
  const local = await transport.local();
  await local.updates.preview();
  await local.updates.apply([{ proposal: 1 }]);
  assert.deepEqual(h.locals[0].updateCalls, [
    { kind: "preview", input: { pluginId: "worklog-board" } },
    { kind: "apply", input: [{ proposal: 1 }] },
  ]);
  await transport.close();
  await assert.rejects(local.updates.apply([]), hasCode("TRANSPORT_CLOSED"));
  assert.equal(h.locals[0].updateCalls.length, 2);
});

test("rejects a mismatched authenticated remote identity and can retry cleanly", async () => {
  const h = harness();
  h.remoteIdentities.push("different-host", "worker");
  const transport = createPaseoTransport({}, h.runtime);
  try {
    await assert.rejects(transport.remote("worker"), hasCode("SERVER_ID_MISMATCH"));
    assert.equal(h.remotes[0].closeCalls, 1);
    assert.equal(h.remotes[0].calls.length, 0);
    const good = await transport.remote("worker");
    assert.equal(good.serverId, "worker");
    assert.equal(h.locals.length, 1);
    assert.equal(h.remotes.length, 2);
  } finally { await transport.close(); }
});

test("validates the local handshake and directory identity before exposing an API", async () => {
  const h = harness();
  h.prepareLocal((client) => { client.directoryId = "other-home"; });
  const transport = createPaseoTransport({}, h.runtime);
  try {
    await assert.rejects(transport.local(), hasCode("SERVER_ID_MISMATCH"));
    assert.equal(h.locals[0].closeCalls, 1);
    assert.equal(h.locals[0].disposeApiCalls, 1);
  } finally { await transport.close(); }
});

test("invalidating one host closes its API and prevents old handles from reporting", async () => {
  const h = harness();
  const transport = createPaseoTransport({}, h.runtime);
  try {
    const worker = await transport.remote("worker");
    const other = await transport.remote("other");
    await transport.invalidate("worker");
    await assert.rejects(worker.rpc("bridge.exchange", {}), hasCode("TRANSPORT_CLOSED"));
    assert.equal(h.remotes[0].closeCalls, 1);
    assert.equal(h.remotes[0].disposeApiCalls, 1);
    assert.equal(h.locals[0].closeCalls, 0);
    assert.equal(await transport.remote("other"), other);
    assert.notEqual(await transport.remote("worker"), worker);
  } finally { await transport.close(); }
});

test("a disconnected origin is replaced with its routes without leaking earlier clients", async () => {
  const h = harness();
  const transport = createPaseoTransport({}, h.runtime);
  try {
    const oldWorker = await transport.remote("worker");
    h.locals[0].isConnected = false;
    const newWorker = await transport.remote("worker");
    assert.notEqual(newWorker, oldWorker);
    assert.equal(h.locals.length, 2);
    assert.equal(h.remotes.length, 2);
    assert.equal(h.locals[0].closeCalls, 1);
    assert.equal(h.remotes[0].closeCalls, 1);
    await assert.rejects(oldWorker.rpc("bridge.exchange", {}), hasCode("TRANSPORT_CLOSED"));
  } finally { await transport.close(); }
});

test("closing an in-flight connection cancels it and permanently closes the adapter", async () => {
  const h = harness();
  let created!: (client: FakeClient) => void;
  const ready = new Promise<FakeClient>((resolve) => { created = resolve; });
  h.prepareLocal((client) => { client.blocked = true; created(client); });
  const transport = createPaseoTransport({}, h.runtime);
  const pending = transport.local();
  const rejected = assert.rejects(pending);
  const client = await ready;
  await transport.close();
  await rejected;
  await transport.close();
  assert.equal(client.closeCalls, 1);
  await assert.rejects(transport.local(), hasCode("TRANSPORT_CLOSED"));
  await assert.rejects(transport.remote("worker"), hasCode("TRANSPORT_CLOSED"));
});

test("does not construct a socket when the local credential is unavailable", async () => {
  const h = harness();
  h.runtime.readCredential = async () => { throw new Error("credential unavailable"); };
  const transport = createPaseoTransport({}, h.runtime);
  try {
    await assert.rejects(transport.local(), /credential unavailable/);
    assert.equal(h.locals.length, 0);
  } finally { await transport.close(); }
});
