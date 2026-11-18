import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { reportSchema, taskSchema, type AgentReport, type Task } from "../shared/model.ts";
import {
  SYNC_PROTOCOL, deliverySchema, exchangeInputSchema, reportOutcomeSchema, syncConfigSchema,
  type ConfigSnapshot, type ConfigureResult, type Delivery, type ExchangeInput,
  type ExchangeResult, type QueueResult, type ReportOutcome, type SyncConfig, type WorkerState,
} from "../shared/sync.ts";

const APPLICATION_ID = 0x574c5752; // WLWR: deliberately different from the central board.
const MAX_UNSETTLED = 1_000;
type Binding = {
  central_server_id: string | null; board_id: string | null; worker_host_id: string | null;
  last_sync_at: string | null; last_sequence: number;
};
type DeliveryRow = {
  delivery_id: string; central_server_id: string; board_id: string; worker_host_id: string;
  agent_id: string; request_id: string; payload_hash: string; report_json: string;
  state: Delivery["state"]; created_at: string; settled_at: string | null;
  dismissed_at: string | null; result_json: string | null;
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

function delivery(row: DeliveryRow): Delivery {
  return deliverySchema.parse({
    deliveryId: row.delivery_id, agentId: row.agent_id, report: JSON.parse(row.report_json), state: row.state,
    createdAt: row.created_at, settledAt: row.settled_at, dismissedAt: row.dismissed_at,
    result: row.result_json ? JSON.parse(row.result_json) : null,
  });
}

function receiptIdentity(result: ReportOutcome): string {
  // Replay is transport metadata, not a change to the original outcome.
  return canonical(result.ok ? { ...result, replayed: false } : result);
}

/** Persistent reports are pulled by one explicitly configured central daemon. */
export class WorkerStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
      const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      const app = (this.db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id;
      if (![0, 1].includes(version)) throw new Error(`지원하지 않는 Worker 데이터 버전입니다: ${version}`);
      if ((version !== 0 || app !== 0) && app !== APPLICATION_ID) throw new Error("Worker 데이터베이스 식별자가 올바르지 않습니다. 파일을 보존했습니다.");
      const checks = this.db.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
      if (checks.length !== 1 || checks[0]?.quick_check !== "ok") throw new Error("Worker 데이터베이스 검사에 실패했습니다. 초기화하지 않았습니다.");
      if (version === 0) {
        if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) throw new Error("Worker 형식이 아닌 기존 데이터베이스입니다.");
        this.initialize();
      }
      this.db.prepare("SELECT revision, config_json FROM config WHERE id=1").get();
      this.db.prepare("SELECT central_server_id,board_id,worker_host_id,last_sync_at,last_sequence FROM binding WHERE id=1").get();
      this.db.prepare("SELECT task_id,task_json,cached_at FROM cached_tasks LIMIT 0").all();
      this.db.prepare("SELECT delivery_id,payload_hash,dismissed_at FROM outbox LIMIT 0").all();
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    } catch (error) { this.db.close(); this.closed = true; throw error; }
  }

  private initialize(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE config (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, config_json TEXT NOT NULL CHECK(json_valid(config_json)));
        CREATE TABLE binding (id INTEGER PRIMARY KEY CHECK(id=1), central_server_id TEXT, board_id TEXT, worker_host_id TEXT, last_sync_at TEXT, last_sequence INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE cached_tasks (task_id TEXT PRIMARY KEY, task_json TEXT NOT NULL CHECK(json_valid(task_json)), cached_at TEXT NOT NULL);
        CREATE TABLE outbox (
          delivery_id TEXT PRIMARY KEY, central_server_id TEXT NOT NULL, board_id TEXT NOT NULL, worker_host_id TEXT NOT NULL,
          agent_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
          report_json TEXT NOT NULL CHECK(json_valid(report_json)), state TEXT NOT NULL CHECK(state IN ('queued','applied','blocked')),
          created_at TEXT NOT NULL, settled_at TEXT, dismissed_at TEXT, result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
          UNIQUE(central_server_id,board_id,worker_host_id,agent_id,request_id)
        );
        CREATE INDEX outbox_pending ON outbox(state,created_at);
        INSERT INTO binding (id,last_sequence) VALUES (1,0);
        PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
      `);
      this.db.prepare("INSERT INTO config (id,revision,config_json) VALUES (1,1,?)").run(JSON.stringify(syncConfigSchema.parse({})));
    });
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private binding(): Binding { return this.db.prepare("SELECT * FROM binding WHERE id=1").get() as Binding; }

  readConfig(): ConfigSnapshot {
    const row = this.db.prepare("SELECT revision,config_json FROM config WHERE id=1").get() as { revision: number; config_json: string } | undefined;
    if (!row) throw new Error("Worker 설정이 손상되었습니다. 초기화하지 않았습니다.");
    return { revision: row.revision, config: syncConfigSchema.parse(JSON.parse(row.config_json)) };
  }

  private unsettledCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE state='queued' OR (state='blocked' AND dismissed_at IS NULL)").get() as { count: number }).count;
  }

  configure(expectedRevision: number, config: SyncConfig): ConfigureResult {
    const parsed = syncConfigSchema.safeParse(config);
    if (!parsed.success) return { ok: false, message: "동기화 설정이 올바르지 않습니다.", snapshot: this.readConfig() };
    const next = parsed.data;
    if (next.role === "satellite" && !next.centralServerId) return { ok: false, message: "수집·보고 호스트는 중앙 서버 ID가 필요합니다.", snapshot: this.readConfig() };
    return this.transaction(() => {
      const previous = this.readConfig();
      if (previous.revision !== expectedRevision) return { ok: false, message: "설정이 다른 화면에서 변경되었습니다. 새로 읽은 뒤 저장하세요.", snapshot: previous };
      const identityChanged = previous.config.role !== next.role || previous.config.centralServerId !== next.centralServerId;
      if (identityChanged && this.unsettledCount() > 0) return { ok: false, message: "전송 대기 보고나 확인하지 않은 보류 보고가 남아 있어 역할이나 중앙 서버 ID를 바꿀 수 없습니다.", snapshot: previous };
      if (canonical(previous.config) === canonical(next)) return { ok: true, snapshot: previous };
      this.db.prepare("UPDATE config SET revision=revision+1,config_json=? WHERE id=1").run(JSON.stringify(next));
      if (identityChanged) {
        this.db.prepare("DELETE FROM cached_tasks").run();
        this.db.prepare("UPDATE binding SET central_server_id=NULL,board_id=NULL,worker_host_id=NULL,last_sync_at=NULL,last_sequence=0 WHERE id=1").run();
      }
      return { ok: true, snapshot: this.readConfig() };
    });
  }

  private checkRoute(input: ExchangeInput, workerHostId: string): Binding {
    const config = this.readConfig().config;
    if (config.role !== "satellite") throw new Error("WORKLOG_ROLE: 이 호스트는 중앙 역할이라 수집·보고 교환 요청을 받지 않습니다.");
    if (!config.enabled) throw new Error("WORKLOG_PAUSED: 수집·보고 호스트의 백그라운드 연결이 일시 정지되어 있습니다.");
    if (config.centralServerId !== input.centralServerId) throw new Error("WORKLOG_CENTRAL_ID: 설정한 중앙 서버와 요청한 중앙 서버가 다릅니다.");
    if (!workerHostId || workerHostId.length > 256) throw new Error("수집·보고 호스트의 검증된 호스트 ID가 필요합니다.");
    const bound = this.binding();
    if (bound.central_server_id && bound.central_server_id !== input.centralServerId) throw new Error("WORKLOG_CENTRAL_ID: 이미 다른 중앙 서버에 연결되어 있습니다.");
    if (bound.board_id && bound.board_id !== input.boardId) throw new Error("WORKLOG_BOARD_ID: 중앙 보드 ID가 기존 연결과 다릅니다. 기존 보고를 다른 보드로 보내지 않았습니다.");
    if (bound.worker_host_id && bound.worker_host_id !== workerHostId) throw new Error("수집·보고 호스트 ID가 기존 연결과 다릅니다.");
    return bound;
  }

  exchange(value: ExchangeInput, workerHostId: string): ExchangeResult {
    const input = exchangeInputSchema.parse(value);
    if (!Number.isSafeInteger(input.sequence)) throw new Error("교환 순번(sequence)이 올바르지 않습니다.");
    return this.transaction(() => {
      const bound = this.checkRoute(input, workerHostId);
      if (input.sequence < bound.last_sequence) throw new Error("오래된 교환 순번(sequence)은 적용하지 않습니다.");
      const taskIds = new Set<string>();
      const agents = new Set<string>();
      for (const task of input.tasks) {
        if (task.archivedAt || !task.sessions.some((session) => session.hostId === workerHostId)) throw new Error("이 호스트에 연결되지 않았거나 보관된 작업은 캐시에 넣을 수 없습니다.");
        if (taskIds.has(task.id)) throw new Error("중복된 작업 ID를 보냈습니다.");
        taskIds.add(task.id);
        for (const session of task.sessions.filter((entry) => entry.hostId === workerHostId)) {
          if (agents.has(session.agentId)) throw new Error("한 세션을 여러 작업에 동시에 연결할 수 없습니다.");
          agents.add(session.agentId);
        }
      }
      // Validate all acknowledgements before applying any cache or outbox change.
      const acknowledged = new Map<string, string>();
      const acknowledgements = input.acknowledgements.map((ack) => {
        const row = this.db.prepare("SELECT * FROM outbox WHERE delivery_id=?").get(ack.deliveryId) as DeliveryRow | undefined;
        if (!row || row.request_id !== ack.requestId || row.central_server_id !== input.centralServerId || row.board_id !== input.boardId || row.worker_host_id !== workerHostId) throw new Error("보고 ID와 요청 ID가 일치하는 현재 연결의 수신 확인이 아닙니다.");
        const report = reportSchema.parse(JSON.parse(row.report_json));
        if (ack.result.taskId !== report.taskId) throw new Error("수신 확인 결과가 보고한 작업과 다릅니다.");
        if (row.result_json && receiptIdentity(reportOutcomeSchema.parse(JSON.parse(row.result_json))) !== receiptIdentity(ack.result)) throw new Error("이미 확정된 보고 결과를 다른 결과로 덮어쓸 수 없습니다.");
        const identity = receiptIdentity(ack.result);
        const duplicate = acknowledged.get(ack.deliveryId);
        if (duplicate && duplicate !== identity) throw new Error("같은 보고에 서로 다른 수신 확인을 보냈습니다.");
        acknowledged.set(ack.deliveryId, identity);
        return { ack, row };
      });
      const at = new Date().toISOString();
      if (input.sequence > bound.last_sequence) {
        this.db.prepare("DELETE FROM cached_tasks").run();
        const insert = this.db.prepare("INSERT INTO cached_tasks (task_id,task_json,cached_at) VALUES (?,?,?)");
        for (const task of input.tasks) insert.run(task.id, JSON.stringify(task), at);
        this.db.prepare("UPDATE binding SET central_server_id=?,board_id=?,worker_host_id=?,last_sync_at=?,last_sequence=? WHERE id=1")
          .run(input.centralServerId, input.boardId, workerHostId, at, input.sequence);
      }
      for (const { ack, row } of acknowledgements) {
        if (row.result_json) continue; // Same outcome, original receipt remains immutable.
        this.db.prepare("UPDATE outbox SET state=?,settled_at=?,result_json=? WHERE delivery_id=? AND result_json IS NULL")
          .run(ack.result.ok ? "applied" : "blocked", at, JSON.stringify(ack.result), ack.deliveryId);
      }
      const current = this.binding();
      const pending = this.db.prepare(`SELECT * FROM outbox WHERE state='queued' AND central_server_id=? AND board_id=? AND worker_host_id=? ORDER BY created_at,rowid LIMIT 50`)
        .all(input.centralServerId, input.boardId, workerHostId) as DeliveryRow[];
      const state = this.counts();
      return { protocol: SYNC_PROTOCOL, workerHostId, boardId: input.boardId, lastSequence: current.last_sequence, lastSyncAt: current.last_sync_at!,
        reports: pending.map((row) => ({ deliveryId: row.delivery_id, agentId: row.agent_id, report: reportSchema.parse(JSON.parse(row.report_json)), createdAt: row.created_at })),
        queued: state.queued, blocked: state.blocked };
    });
  }

  getLinkedTask(hostId: string, agentId: string): { task: Task | null; cachedAt: string | null } {
    const bound = this.binding();
    if (bound.worker_host_id !== hostId) return { task: null, cachedAt: null };
    const rows = this.db.prepare(`SELECT task_json,cached_at FROM cached_tasks WHERE EXISTS (
      SELECT 1 FROM json_each(task_json,'$.sessions') AS s
      WHERE json_extract(s.value,'$.hostId')=? AND json_extract(s.value,'$.agentId')=?)`).all(hostId, agentId) as { task_json: string; cached_at: string }[];
    for (const row of rows) {
      const task = taskSchema.parse(JSON.parse(row.task_json));
      if (!task.archivedAt) return { task, cachedAt: row.cached_at };
    }
    return { task: null, cachedAt: bound.last_sync_at };
  }

  private queuedResult(row: DeliveryRow): QueueResult {
    if (row.state === "applied") return { delivery: "applied", deliveryId: row.delivery_id, requestId: row.request_id, message: "이 보고는 중앙 보드에 이미 반영되었습니다." };
    if (row.state === "blocked") {
      const result = row.result_json ? reportOutcomeSchema.parse(JSON.parse(row.result_json)) : null;
      return { delivery: "blocked", deliveryId: row.delivery_id, requestId: row.request_id,
        message: result && !result.ok ? result.message : "보고가 보류 상태로 보존되어 있습니다. 현재 작업을 확인하고 새 요청으로 보고하세요." };
    }
    return { delivery: "queued", deliveryId: row.delivery_id, requestId: row.request_id, queuedAt: row.created_at,
      message: "이 PC에 보고를 저장했습니다. 아직 중앙 보드에는 반영되지 않았으며 다음 연결 때 전달됩니다." };
  }

  enqueue(hostId: string, agentId: string, value: AgentReport): QueueResult {
    const invalid = (message: string, deliveryId: string | null = null): QueueResult => ({ delivery: "blocked", deliveryId,
      requestId: typeof value?.requestId === "string" ? value.requestId : "invalid-request", message });
    const parsed = reportSchema.safeParse(value);
    if (!parsed.success) return invalid("보고 형식이 올바르지 않습니다. 로컬 대기열에 저장하지 않았습니다.");
    if (!hostId || !agentId || hostId.length > 256 || agentId.length > 256) return invalid("보고한 호스트와 세션을 확인할 수 없습니다.");
    const report = parsed.data;
    return this.transaction(() => {
      const config = this.readConfig().config;
      if (config.role !== "satellite" || !config.enabled) return invalid("이 호스트의 백그라운드 연결이 켜져 있어야 보고를 저장할 수 있습니다.");
      const bound = this.binding();
      if (!bound.board_id || bound.worker_host_id !== hostId || bound.central_server_id !== config.centralServerId) return invalid("중앙 보드와 이 PC의 첫 연결이 필요합니다.");
      const hash = createHash("sha256").update(canonical({ hostId, agentId, report })).digest("hex");
      const old = this.db.prepare(`SELECT * FROM outbox WHERE central_server_id=? AND board_id=? AND worker_host_id=? AND agent_id=? AND request_id=?`)
        .get(bound.central_server_id, bound.board_id, hostId, agentId, report.requestId) as DeliveryRow | undefined;
      if (old) return old.payload_hash === hash ? this.queuedResult(old) : invalid("같은 요청 ID를 다른 보고에 재사용할 수 없습니다.", old.delivery_id);
      const cached = this.getLinkedTask(hostId, agentId).task;
      if (!cached || cached.id !== report.taskId) return invalid("캐시 기준으로 이 세션에 연결된 작업이 아닙니다. 현재 연결된 작업을 먼저 읽으세요.");
      if (cached.revision !== report.expectedRevision) return invalid("캐시의 작업 수정 버전이 변경되었습니다. 현재 작업을 읽고 새 요청으로 보고하세요.");
      if (this.unsettledCount() >= MAX_UNSETTLED) return invalid("전송 대기·미확인 보류 보고가 한도(1,000개)에 도달했습니다. 기존 보고는 삭제하지 않았습니다.");
      const id = randomUUID();
      this.db.prepare(`INSERT INTO outbox (delivery_id,central_server_id,board_id,worker_host_id,agent_id,request_id,payload_hash,report_json,state,created_at)
        VALUES (?,?,?,?,?,?,?,?,'queued',?)`).run(id, bound.central_server_id, bound.board_id, hostId, agentId, report.requestId, hash, JSON.stringify(report), new Date().toISOString());
      return this.queuedResult(this.db.prepare("SELECT * FROM outbox WHERE delivery_id=?").get(id) as DeliveryRow);
    });
  }

  private counts(): { queued: number; applied: number; blocked: number } {
    const rows = this.db.prepare("SELECT state,dismissed_at,COUNT(*) AS count FROM outbox GROUP BY state,dismissed_at IS NULL").all() as { state: Delivery["state"]; dismissed_at: string | null; count: number }[];
    const result = { queued: 0, applied: 0, blocked: 0 };
    for (const row of rows) if (row.state !== "blocked" || !row.dismissed_at) result[row.state] += row.count;
    return result;
  }

  state(): WorkerState {
    const bound = this.binding();
    const config = this.readConfig().config;
    const unsettled = this.db.prepare(`SELECT * FROM outbox WHERE state='queued' OR (state='blocked' AND dismissed_at IS NULL)
      ORDER BY CASE WHEN state='blocked' THEN 0 ELSE 1 END,created_at DESC,rowid DESC`).all() as DeliveryRow[];
    const recent = this.db.prepare(`SELECT * FROM outbox WHERE state='applied' OR (state='blocked' AND dismissed_at IS NOT NULL)
      ORDER BY created_at DESC,rowid DESC LIMIT 100`).all() as DeliveryRow[];
    return {
      centralServerId: bound.central_server_id ?? (config.role === "satellite" ? config.centralServerId || null : null),
      boardId: bound.board_id, workerHostId: bound.worker_host_id, lastSyncAt: bound.last_sync_at, lastSequence: bound.last_sequence,
      // Full settled history stays in SQLite; status polling remains bounded.
      ...this.counts(), deliveries: [...unsettled, ...recent].map(delivery),
    };
  }

  dismiss(deliveryId: string): WorkerState {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM outbox WHERE delivery_id=?").get(deliveryId) as DeliveryRow | undefined;
      if (!row || row.state !== "blocked") throw new Error("보류된 보고만 확인 표시할 수 있습니다. 전송 대기 보고는 삭제하지 않습니다.");
      if (!row.dismissed_at) this.db.prepare("UPDATE outbox SET dismissed_at=? WHERE delivery_id=?").run(new Date().toISOString(), deliveryId);
      return this.state();
    });
  }

  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}
