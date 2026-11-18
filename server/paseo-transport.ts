import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import sdk from "./vendor/paseo-sdk.cjs";

export type PaseoApi = PluginHandlerContext["paseo"];
type NativeClient = ReturnType<typeof sdk.createHostClient>;
type NativeClientConfig = Parameters<typeof sdk.createHostClient>[1];
const PLUGIN_ID = "worklog-board";

export interface PaseoConnection {
  serverId: string;
  label: string;
  paseo: PaseoApi;
  /** Only this plugin's RPC namespace is exposed. */
  rpc(method: string, input: unknown): Promise<unknown>;
}

export interface PaseoTransport {
  local(): Promise<PaseoConnection>;
  remote(serverId: string): Promise<PaseoConnection>;
  /** No ID, or the local ID, invalidates the origin and all routes. */
  invalidate(serverId?: string): Promise<void>;
  close(): Promise<void>;
}

export interface PaseoTransportOptions {
  home?: string;
  connectTimeoutMs?: number;
}

export class PaseoTransportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PaseoTransportError";
    this.code = code;
  }
}

export interface LocalDaemonTarget {
  listen: string;
  serverId: string;
  pid: number;
  startedAt: string;
}

export function resolveTransportHome(home?: string): string {
  const value = home?.trim() || process.env.PASEO_HOME?.trim();
  if (!value) return join(homedir(), ".paseo");
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return resolve(value);
}

/** Reads the running instance's own published endpoint; never opens a new listener. */
export async function readLocalDaemonTarget(home: string): Promise<LocalDaemonTarget> {
  let value: unknown;
  try { value = JSON.parse(await readFile(join(home, "paseo.pid"), "utf8")); }
  catch { throw new PaseoTransportError("LOCAL_DAEMON_NOT_READY", "로컬 Paseo 데몬의 실행 정보를 아직 읽을 수 없습니다."); }
  if (!value || typeof value !== "object") throw invalidLocalState();
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.pid) || Number(record.pid) <= 0
    || typeof record.startedAt !== "string" || !record.startedAt.trim()
    || typeof record.listen !== "string" || !record.listen.trim()
    || typeof record.serverId !== "string" || !record.serverId.trim()) throw invalidLocalState();
  try { process.kill(Number(record.pid), 0); }
  catch (cause) {
    // Like Paseo's PID reader, EPERM proves that a process exists.
    if (!(cause instanceof Error && "code" in cause && cause.code === "EPERM")) throw invalidLocalState();
  }
  return { listen: record.listen, serverId: record.serverId, pid: Number(record.pid), startedAt: record.startedAt };
}

function invalidLocalState(): PaseoTransportError {
  return new PaseoTransportError("LOCAL_DAEMON_NOT_READY", "로컬 Paseo 데몬이 아직 연결 주소와 호스트 ID를 게시하지 않았습니다.");
}

/** Read again on every authentication attempt so rotating local credentials work. */
export async function readOwnLocalCredential(home: string, expected: LocalDaemonTarget): Promise<string> {
  const current = await readLocalDaemonTarget(home);
  if (current.listen !== expected.listen || current.serverId !== expected.serverId
    || current.pid !== expected.pid || current.startedAt !== expected.startedAt) {
    throw new PaseoTransportError("LOCAL_INSTANCE_CHANGED", "로컬 Paseo 인스턴스가 바뀌었습니다. 연결을 다시 초기화하세요.");
  }
  let token: string;
  try { token = (await readFile(join(home, "local-credential"), "utf8")).trim(); }
  catch { throw new PaseoTransportError("LOCAL_CREDENTIAL_UNAVAILABLE", "이 Paseo 홈의 로컬 연결 자격 증명을 읽을 수 없습니다."); }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new PaseoTransportError("LOCAL_CREDENTIAL_UNAVAILABLE", "이 Paseo 홈의 로컬 연결 자격 증명이 유효하지 않습니다.");
  }
  return token;
}

/** The injected boundary is for deterministic transport lifecycle tests. */
export interface PaseoTransportRuntime {
  readTarget(home: string): Promise<LocalDaemonTarget>;
  readCredential(home: string, expected: LocalDaemonTarget): Promise<string>;
  createLocal(connection: string, config: NativeClientConfig): NativeClient;
  createRemote(config: NativeClientConfig): NativeClient;
  route(origin: NativeClient, serverId: string, scopeId: string): unknown;
  api(client: NativeClient): PaseoApi;
}

const nativeRuntime: PaseoTransportRuntime = {
  readTarget: readLocalDaemonTarget,
  readCredential: readOwnLocalCredential,
  createLocal: (connection, config) => sdk.createHostClient(connection, config),
  createRemote: (config) => new sdk.DaemonClient(config),
  route: (origin, serverId, scopeId) => sdk.createHostChannelTransport(origin, serverId, scopeId, null),
  api: (client) => sdk.createPaseoApi(client),
};
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

interface ManagedConnection {
  handle: PaseoConnection;
  client: NativeClient;
}
interface Entry {
  cancelled: boolean;
  ready: boolean;
  client?: NativeClient;
  api?: PaseoApi;
  expectedId?: string;
  promise: Promise<ManagedConnection>;
  cleanup?: Promise<void>;
}

/**
 * Native Paseo 0.15.4 transport. The SDK is vendored so loading a ZIP does not
 * require a separate npm install. Routes reuse the daemon's authenticated,
 * identity-pinned Connected Hosts; this module never reads hosts.json secrets.
 */
export function createPaseoTransport(
  options: PaseoTransportOptions = {},
  runtime: PaseoTransportRuntime = nativeRuntime,
): PaseoTransport {
  const home = resolveTransportHome(options.home);
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0 || connectTimeoutMs > 120_000) {
    throw new PaseoTransportError("INVALID_TIMEOUT", "연결 제한 시간은 0초 초과, 120초 이하여야 합니다.");
  }
  let stopped = false;
  let origin: Entry | null = null;
  let closing: Promise<void> | null = null;
  const remotes = new Map<string, Entry>();

  function assertActive(entry?: Entry): void {
    if (stopped || entry?.cancelled) throw new PaseoTransportError("TRANSPORT_CLOSED", "Paseo 연결이 닫혔거나 다시 초기화되었습니다.");
  }

  function verifyIdentity(client: NativeClient, expectedId: string): void {
    if (client.getLastServerInfoMessage()?.serverId !== expectedId) {
      throw new PaseoTransportError("SERVER_ID_MISMATCH", "연결한 Paseo 호스트의 실제 ID가 요청한 호스트와 다릅니다.");
    }
  }

  function cleanupEntry(entry: Entry): Promise<void> {
    entry.cancelled = true;
    if (entry.cleanup) return entry.cleanup;
    entry.client?.setReconnectEnabled(false);
    // Close sockets concurrently with API scopes: pending RPCs must reject so
    // subscription teardown cannot hold plugin shutdown open indefinitely.
    entry.cleanup = Promise.allSettled([
      entry.api?.dispose(), entry.client?.close(),
    ]).then(() => undefined);
    return entry.cleanup;
  }

  async function finish(entry: Entry, client: NativeClient, expectedId: string): Promise<ManagedConnection> {
    await client.connect();
    assertActive(entry);
    verifyIdentity(client, expectedId);
    const api = runtime.api(client);
    entry.api = api;
    const directory = await api.hosts.list();
    assertActive(entry);
    if (directory.self.serverId !== expectedId) {
      throw new PaseoTransportError("SERVER_ID_MISMATCH", "Paseo 호스트 목록의 ID가 연결된 호스트와 다릅니다.");
    }
    entry.ready = true;
    client.setReconnectEnabled(true);
    return {
      client,
      handle: {
        serverId: expectedId,
        label: directory.self.label || expectedId,
        paseo: api,
        async rpc(method, input) {
          assertActive(entry);
          if (!/^[a-z][a-z0-9._-]*$/.test(method)) throw new PaseoTransportError("INVALID_RPC_METHOD", "유효하지 않은 Worklog RPC 이름입니다.");
          await client.connect();
          assertActive(entry);
          verifyIdentity(client, expectedId);
          return client.invokePluginRpc(PLUGIN_ID, method, input);
        },
      },
    };
  }

  function makeEntry(connect: (entry: Entry) => Promise<ManagedConnection>, failed: (entry: Entry) => void): Entry {
    const entry = { cancelled: false, ready: false } as Entry;
    entry.promise = Promise.resolve().then(() => connect(entry)).catch(async (error: unknown) => {
      failed(entry);
      await cleanupEntry(entry);
      throw error;
    });
    return entry;
  }

  async function invalidateOrigin(expected?: Entry): Promise<void> {
    if (expected && origin !== expected) return;
    const entries = [...remotes.values(), ...(origin ? [origin] : [])];
    remotes.clear();
    origin = null;
    await Promise.all(entries.map(cleanupEntry));
  }

  async function invalidateRemote(serverId: string, expected?: Entry): Promise<void> {
    const entry = remotes.get(serverId);
    if (!entry || (expected && entry !== expected)) return;
    remotes.delete(serverId);
    await cleanupEntry(entry);
  }

  async function localManaged(): Promise<ManagedConnection> {
    assertActive();
    if (origin?.ready && !origin.client?.isConnected) await invalidateOrigin(origin);
    assertActive();
    if (!origin) {
      origin = makeEntry(async (entry) => {
        const target = await runtime.readTarget(home);
        assertActive(entry);
        // Fail before constructing a transport if this home cannot authenticate.
        await runtime.readCredential(home, target);
        assertActive(entry);
        const client = runtime.createLocal(target.listen, {
          clientId: `worklog-board-background-${randomUUID()}`,
          clientType: "cli", appVersion: "0.15.4", connectTimeoutMs,
          localCredential: () => runtime.readCredential(home, target),
          reconnect: { enabled: false }, logger: silentLogger,
        });
        entry.client = client;
        entry.expectedId = target.serverId;
        return finish(entry, client, target.serverId);
      }, (entry) => { if (origin === entry) origin = null; });
    }
    const entry = origin;
    const connection = await entry.promise;
    assertActive(entry);
    return connection;
  }

  async function remoteManaged(serverId: string): Promise<ManagedConnection> {
    assertActive();
    if (typeof serverId !== "string" || !serverId.trim() || serverId.length > 256) {
      throw new PaseoTransportError("INVALID_HOST_ID", "연결할 Paseo 호스트 ID를 지정하세요.");
    }
    const local = await localManaged();
    if (serverId === local.handle.serverId) return local;
    const previous = remotes.get(serverId);
    if (previous?.ready && !previous.client?.isConnected) await invalidateRemote(serverId, previous);
    assertActive();
    let entry = remotes.get(serverId);
    if (!entry) {
      const originEntry = origin;
      entry = makeEntry(async (opening) => {
        assertActive(opening);
        if (origin !== originEntry || originEntry?.cancelled) {
          throw new PaseoTransportError("TRANSPORT_CLOSED", "원본 Paseo 연결이 바뀌었습니다. 다시 연결하세요.");
        }
        local.client.requireConnectedHosts();
        const scopeId = randomUUID();
        const client = runtime.createRemote({
          url: "ws://routed-host/ws", clientId: scopeId,
          transportFactory: runtime.route(local.client, serverId, scopeId),
          connectTimeoutMs, reconnect: { enabled: false }, logger: silentLogger,
        });
        opening.client = client;
        opening.expectedId = serverId;
        return finish(opening, client, serverId);
      }, (failedEntry) => { if (remotes.get(serverId) === failedEntry) remotes.delete(serverId); });
      remotes.set(serverId, entry);
    }
    const connection = await entry.promise;
    assertActive(entry);
    return connection;
  }

  return {
    local: async () => (await localManaged()).handle,
    remote: async (serverId) => (await remoteManaged(serverId)).handle,
    async invalidate(serverId) {
      if (!serverId || serverId === origin?.expectedId) await invalidateOrigin();
      else await invalidateRemote(serverId);
    },
    close() {
      if (closing) return closing;
      stopped = true;
      const entries = [...remotes.values(), ...(origin ? [origin] : [])];
      closing = invalidateOrigin().then(async () => {
        await Promise.allSettled(entries.map((entry) => entry.promise));
      });
      return closing;
    },
  };
}
