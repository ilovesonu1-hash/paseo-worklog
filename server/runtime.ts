import { collectHostSessions } from "../shared/session-roster.ts";
import { exchangeInputSchema, exchangeResultSchema, SYNC_PROTOCOL } from "../shared/sync.ts";
import type { ConfigureResult, ExchangeInput, HostHealth, RuntimeStatus, SyncConfig } from "../shared/sync.ts";
import type { SessionSnapshot } from "../shared/model.ts";
import type { WorklogStore } from "./store.ts";
import type { WorkerStore } from "./worker-store.ts";
import type { PaseoConnection, PaseoTransport } from "./paseo-transport.ts";

type Directory = Awaited<ReturnType<PaseoConnection["paseo"]["hosts"]["list"]>>;

const MISSING_PLUGIN = /unknown.*plugin|plugin.*not.*found|method.*not.*found|not.*registered|no.*handler/i;

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // PaseoTransportError keeps its stable code apart from the translated message.
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
  return code && !message.includes(code) ? `${code} ${message}` : message;
}

/** Never return a raw connection URL, password, pairing link or credential to UI. */
export function safeSyncError(error: unknown): string {
  const message = errorText(error);
  const known = message.match(/WORKLOG_[A-Z_]+:\s*([^\n]+)/);
  // The native client appends " requestType=… code=…" to remote handler errors; that is not for people.
  if (known) return known[1].replace(/\s+requestType=\S+.*$/, "").trim().slice(0, 500);
  // Before the identity check: "…호스트 ID를 게시하지 않았습니다" is a local readiness error, not a mismatch.
  if (/LOCAL_|로컬 Paseo|자격 증명/.test(message)) return "이 Paseo 인스턴스의 실행 정보나 로컬 연결 자격 증명을 아직 읽을 수 없습니다.";
  if (/SERVER_ID_MISMATCH|호스트.*ID.*다|identity|identity_mismatch/i.test(message)) return "연결된 호스트의 ID가 등록된 대상과 다릅니다. Paseo 호스트 등록을 확인하세요.";
  if (/permission|forbidden|unauthori|denied|daemon\.manage|권한/i.test(message)) return "Paseo 호스트 연결 권한을 확인하세요. 원격 보고 동기화에는 플러그인 호출 권한이 필요합니다.";
  if (MISSING_PLUGIN.test(message)) return "대상 PC에 Worklog 0.2 이상을 설치하고 수집·보고 호스트로 설정하세요.";
  if (/timeout|timed out|deadline|시간.*초과/i.test(message)) return "호스트 응답 시간이 초과됐습니다. 다음 수집 때 다시 연결합니다.";
  return "호스트와 동기화하지 못했습니다. 연결 상태와 양쪽 Worklog 설정을 확인하세요.";
}

/**
 * Classify a failed exchange from stable WORKLOG_* codes, which every Worklog
 * version sends, never from the translated message (the generic fallback above
 * also says "설정" and used to mark every unknown failure as "설정 필요").
 */
export function bridgeStateForError(error: unknown): HostHealth["bridgeState"] {
  const message = errorText(error);
  const code = message.match(/WORKLOG_([A-Z_]+):/)?.[1];
  if (code === "PAUSED") return "paused";
  if (code === "ROLE" || code === "CENTRAL_ID" || code === "BOARD_ID" || code === "IDENTITY_MISMATCH") return "unconfigured";
  if (!code && MISSING_PLUGIN.test(message)) return "unconfigured";
  return "error";
}

/**
 * Runs in the plugin server process, independently of the app or board screen.
 * The central daemon pulls from its native Connected Hosts. A report's host ID
 * always comes from a verified route, never from a report body.
 */
export class WorklogRuntime {
  private started = false;
  private stopped = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flight: Promise<void> | null = null;
  private rerun = false;
  private self: RuntimeStatus["self"] = null;
  private directory: Directory | null = null;
  private lastCycleAt: string | null = null;
  private error: string | null = null;
  private readonly store: WorklogStore;
  private readonly worker: WorkerStore;
  private readonly transport: PaseoTransport;

  constructor(store: WorklogStore, worker: WorkerStore, transport: PaseoTransport) {
    this.store = store; this.worker = worker; this.transport = transport;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(0);
  }

  refresh(): { scheduled: boolean } {
    const config = this.worker.readConfig().config;
    if (this.stopped || !config.enabled || config.role !== "central") return { scheduled: false };
    this.schedule(0);
    return { scheduled: true };
  }

  configure(expectedRevision: number, config: SyncConfig): ConfigureResult {
    const previous = this.worker.readConfig().config;
    const result = this.worker.configure(expectedRevision, config);
    if (result.ok) {
      this.generation += 1;
      this.error = null;
      const keep = result.snapshot.config.enabled && result.snapshot.config.role === "central"
        ? new Set(result.snapshot.config.remoteHostIds) : new Set<string>();
      for (const id of previous.remoteHostIds) {
        if (!keep.has(id)) void this.transport.invalidate(id).catch(() => {});
      }
      if (!result.snapshot.config.enabled || result.snapshot.config.role !== "central") {
        for (const host of this.store.readRoster().hosts) this.store.recordHostResult({
          hostId: host.hostId, label: host.label, sequence: this.store.nextSequence(),
          status: "disabled", bridgeState: "paused", error: null,
        });
      }
      this.schedule(0);
    }
    return result;
  }

  status(): RuntimeStatus {
    const snapshot = this.worker.readConfig();
    return {
      snapshot, self: this.self, boardId: this.store.boardId(),
      running: this.started && !this.stopped && snapshot.config.enabled && !!this.self,
      inFlight: !!this.flight, lastCycleAt: this.lastCycleAt, error: this.error,
      knownHosts: (this.directory?.hosts ?? []).map((host) => ({
        registrationId: host.registrationId, serverId: host.serverId,
        label: host.label || host.serverId || "연결 확인 중인 호스트",
        status: host.status, enabled: host.enabled,
        error: host.error ? safeSyncError(new Error(host.error.code)) : null,
      })),
      roster: this.store.readRoster(snapshot.config.pollIntervalSeconds * 3000),
      worker: this.worker.state(), localTaskCount: this.store.readBoard().tasks.length,
    };
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.flight) { this.rerun = true; return; }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.runOnce(); }, delay);
    this.timer.unref?.();
  }

  /** Public for deterministic lifecycle integration tests, not an agent API. */
  runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.flight) { this.rerun = true; return this.flight; }
    const epoch = this.generation;
    const active = () => !this.stopped && this.generation === epoch;
    const config = this.worker.readConfig().config;
    const operation = this.collect(config, active).catch((cause: unknown) => {
      if (active()) this.error = safeSyncError(cause);
    }).finally(() => {
      this.flight = null;
      if (this.stopped) return;
      const next = this.worker.readConfig().config;
      const delay = this.rerun ? 0 : next.pollIntervalSeconds * 1000;
      this.rerun = false;
      // Keep a light identity/configuration refresh while paused or in satellite
      // mode; no session collection or remote calls happen in those modes.
      if (this.started) this.schedule(delay);
    });
    this.flight = operation;
    return operation;
  }

  private async collect(config: SyncConfig, active: () => boolean): Promise<void> {
    const local = await this.transport.local();
    if (!active()) return;
    this.self = { serverId: local.serverId, label: local.label };
    this.directory = await local.paseo.hosts.list();
    if (!active()) return;
    this.error = null;
    this.lastCycleAt = new Date().toISOString();
    if (!config.enabled || config.role !== "central") return;

    const ids = [...new Set(config.remoteHostIds)].filter((id) => id !== local.serverId);
    const selected = new Set([local.serverId, ...ids]);
    // Deselected hosts retain snapshots but must not look actively collected.
    for (const host of this.store.readRoster().hosts) {
      if (!selected.has(host.hostId)) {
        this.store.recordHostResult({ hostId: host.hostId, label: host.label, sequence: this.store.nextSequence(),
          status: "disabled", bridgeState: "paused", error: null });
        await this.transport.invalidate(host.hostId);
        if (!active()) return;
      }
    }
    const targets = [local.serverId, ...ids];
    let index = 0;
    const runner = async () => {
      while (active() && index < targets.length) {
        const hostId = targets[index++];
        await this.collectHost(hostId, local, config, active);
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(3, targets.length) }, runner));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  private async collectHost(hostId: string, local: PaseoConnection, config: SyncConfig, active: () => boolean): Promise<void> {
    const isLocal = hostId === local.serverId;
    const registration = this.directory?.hosts.find((host) => host.serverId === hostId);
    const label = isLocal ? local.label : registration?.label || hostId;
    const sequence = this.store.nextSequence();
    if (!isLocal && (!registration || !registration.enabled)) {
      if (active()) this.store.recordHostResult({ hostId, label, sequence, status: "disabled", bridgeState: "paused", error: "중앙 Paseo의 Connected Hosts 등록과 활성화 상태를 확인하세요." });
      await this.transport.invalidate(hostId);
      return;
    }

    let connection: PaseoConnection;
    try { connection = isLocal ? local : await this.transport.remote(hostId); }
    catch (cause) {
      if (active()) this.store.recordHostResult({ hostId, label, sequence, status: "offline", error: safeSyncError(cause), bridgeState: "unavailable" });
      return;
    }
    if (!active()) return;
    let sessions: SessionSnapshot[] | undefined;
    let truncated = false;
    const errors: string[] = [];
    try {
      const result = await collectHostSessions({
        agents: (page) => connection.paseo.agents.list({
          filter: { includeArchived: false }, sort: [{ key: "updated_at", direction: "desc" }], page, timeout: 10_000,
        }),
        workspaces: (page) => connection.paseo.workspaces.list({ page }),
      }, { hostId: connection.serverId, label }, new Date().toISOString());
      sessions = result.sessions;
      truncated = result.truncated;
    } catch (cause) { errors.push(safeSyncError(cause)); }
    if (!active()) return;

    let bridgeState: HostHealth["bridgeState"] = isLocal ? "local" : "unconfigured";
    // A failed exchange has no new delivery totals. Retain the last confirmed
    // counts rather than turning an unknown result into a misleading zero.
    let queuedReports: number | undefined = isLocal ? 0 : undefined;
    let blockedReports: number | undefined = isLocal ? 0 : undefined;
    if (!isLocal) {
      try {
        const sync = async (acknowledgements: ExchangeInput["acknowledgements"]) => {
          const input = exchangeInputSchema.parse({
            protocol: SYNC_PROTOCOL, centralServerId: local.serverId, boardId: this.store.boardId(),
            sequence: this.store.nextSequence(), tasks: this.store.tasksForHost(hostId), acknowledgements,
          });
          const response = exchangeResultSchema.parse(await connection.rpc("bridge.exchange", input));
          if (response.workerHostId !== connection.serverId || response.boardId !== this.store.boardId()) {
            throw new Error("WORKLOG_IDENTITY_MISMATCH: 수집·보고 호스트 또는 중앙 보드의 ID가 일치하지 않습니다.");
          }
          return response;
        };
        let exchange = await sync([]);
        if (!active()) return;
        const acknowledgements = exchange.reports.map((delivery) => ({
          deliveryId: delivery.deliveryId, requestId: delivery.report.requestId,
          result: this.store.reportDelivery(connection.serverId, delivery.agentId, delivery.report),
        }));
        if (acknowledgements.length) {
          exchange = await sync(acknowledgements);
          if (!active()) return;
        }
        queuedReports = exchange.queued;
        blockedReports = exchange.blocked;
        bridgeState = "ready";
      } catch (cause) {
        errors.push(safeSyncError(cause));
        bridgeState = bridgeStateForError(cause);
      }
    }
    if (active()) this.store.recordHostResult({
      hostId, label, sequence, status: sessions === undefined ? "error" : "online",
      sessions, truncated, error: errors.length ? [...new Set(errors)].join(" ") : null,
      bridgeState, queuedReports, blockedReports,
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.transport.close();
    // Close rejects in-flight native requests; generation checks prohibit late writes.
    await this.flight;
  }
}
