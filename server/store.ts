import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  mutationResultSchema,
  mutationSchema,
  reportSchema,
  sessionKey,
  sessionSchema,
  taskFieldsSchema,
  STATUS_LABELS,
  PRIORITY_LABELS,
  type Activity,
  type AgentReport,
  type BoardSnapshot,
  type Mutation,
  type MutationResult,
  type SessionSnapshot,
  type Task,
  type TaskFields,
} from "../shared/model.ts";
import { hostHealthSchema, type HostHealth, type ReportOutcome, type RosterSnapshot } from "../shared/sync.ts";

const SCHEMA_VERSION = 2;
const APPLICATION_ID = 0x574c4f47; // WLOG; refuse unrelated SQLite databases.
const TASK_LIMIT = 2_000;
const FIELD_NAMES = Object.keys(taskFieldsSchema.shape) as (keyof TaskFields)[];
const FIELD_LABELS: Record<keyof TaskFields, string> = {
  title: "제목", project: "프로젝트", description: "설명", status: "상태", priority: "우선순위",
  summary: "현재 요약", doneText: "한 일", nextAction: "다음 행동", blockedReason: "막힌 이유", evidence: "결과 근거",
};
const EXECUTION_LABELS: Record<SessionSnapshot["execution"], string> = {
  working: "실행 중", waiting: "권한·답변 필요", error: "실행 오류", idle: "응답 완료 · 지시 대기", closed: "종료", unknown: "상태 미확인",
};

type TaskRow = {
  id: string; revision: number; created_at: string; updated_at: string;
  archived_at: string | null; fields_json: string;
};
type SessionRow = { snapshot_json: string; observed_ms: number };
type ReceiptRow = { fingerprint: string; result_json: string };
type HostRow = { sequence: number; data_json: string };
type ActivityRow = {
  id: number; task_id: string; kind: Activity["kind"];
  message: string; actor: Activity["actor"]; created_at: string;
};

function failure(code: Extract<MutationResult, { ok: false }>["code"], message: string, current?: Task): MutationResult {
  return current ? { ok: false, code, message, current } : { ok: false, code, message };
}

/** Canonical JSON makes field order irrelevant to retry identity. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function normalizedSession(value: SessionSnapshot): SessionSnapshot {
  const session = sessionSchema.parse(value);
  const timestamp = Date.parse(session.observedAt);
  if (!Number.isFinite(timestamp)) throw new Error("세션 관측 시각이 올바르지 않습니다.");
  return { ...session, observedAt: new Date(timestamp).toISOString() };
}

function changedFields(previous: TaskFields, next: TaskFields): (keyof TaskFields)[] {
  return FIELD_NAMES.filter((name) => previous[name] !== next[name]);
}

function fieldsOf(task: Task): TaskFields {
  return taskFieldsSchema.parse(Object.fromEntries(FIELD_NAMES.map((name) => [name, task[name]])));
}

function activityOf(row: ActivityRow): Activity {
  return { id: row.id, taskId: row.task_id, kind: row.kind, message: row.message, actor: row.actor, createdAt: row.created_at };
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

/**
 * The central daemon is the only board writer. Agent runtime observations are
 * deliberately separate from task revisions and can never complete a task.
 * All mutation results, including conflicts, have durable retry receipts.
 */
export class WorklogStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      let version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version > SCHEMA_VERSION) throw new Error(`Worklog 데이터 버전 ${version}은 이 플러그인이 지원하는 버전 ${SCHEMA_VERSION}보다 새 버전입니다.`);
      if (![0, 1, SCHEMA_VERSION].includes(version)) throw new Error(`지원하지 않는 Worklog 데이터 버전입니다: ${version}`);
      const integrity = this.db.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
      if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") {
        throw new Error("Worklog 데이터베이스 검사에 실패했습니다. 파일을 보존한 채 복구가 필요합니다.");
      }
      const originalApplicationId = (this.db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id;
      if ((version !== 0 || originalApplicationId !== 0) && originalApplicationId !== APPLICATION_ID) {
        throw new Error("Worklog 데이터베이스 식별자가 올바르지 않습니다. 파일을 보존했습니다.");
      }
      if (version === 0) {
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        if (tables.length > 0) throw new Error("Worklog 형식이 아닌 기존 데이터베이스입니다. 초기화하지 않았습니다.");
        this.initialize();
        version = 1;
      }
      const applicationId = (this.db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id;
      if (applicationId !== APPLICATION_ID) throw new Error("Worklog 데이터베이스 식별자가 올바르지 않습니다. 파일을 보존했습니다.");
      // Preparing these reads detects incomplete/foreign schemas before any write.
      this.db.prepare("SELECT id, revision, fields_json, created_at, updated_at, archived_at FROM tasks LIMIT 0").all();
      this.db.prepare("SELECT session_key, host_id, agent_id, observed_ms, snapshot_json FROM sessions LIMIT 0").all();
      this.db.prepare("SELECT session_key, task_id, linked_at FROM task_sessions LIMIT 0").all();
      this.db.prepare("SELECT id, task_id, kind, message, actor, created_at FROM activities LIMIT 0").all();
      this.db.prepare("SELECT request_id, fingerprint, result_json, created_at FROM receipts LIMIT 0").all();
      if (version === 1) this.migrateV2();
      this.db.prepare("SELECT key, value FROM metadata LIMIT 0").all();
      this.db.prepare("SELECT host_id, sequence, data_json FROM host_health LIMIT 0").all();
      this.db.prepare("SELECT session_key, host_id FROM roster_members LIMIT 0").all();
      if (!this.metadata("board_id") || !/^\d+$/.test(this.metadata("sequence") ?? "")) throw new Error("Worklog 동기화 메타데이터가 올바르지 않습니다.");
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  private initialize(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision > 0),
          fields_json TEXT NOT NULL CHECK (json_valid(fields_json)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT
        );
        CREATE TABLE sessions (
          session_key TEXT PRIMARY KEY,
          host_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          observed_ms INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
          UNIQUE (host_id, agent_id)
        );
        CREATE TABLE task_sessions (
          session_key TEXT PRIMARY KEY REFERENCES sessions(session_key),
          task_id TEXT NOT NULL REFERENCES tasks(id),
          linked_at TEXT NOT NULL
        );
        CREATE INDEX task_sessions_task ON task_sessions(task_id);
        CREATE TABLE activities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          kind TEXT NOT NULL,
          message TEXT NOT NULL,
          actor TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX activities_task_id ON activities(task_id, id DESC);
        CREATE TABLE receipts (
          request_id TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL,
          result_json TEXT NOT NULL CHECK (json_valid(result_json)),
          created_at TEXT NOT NULL
        );
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = 1;
      `);
    });
  }

  private migrateV2(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE host_health (host_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json)));
        CREATE TABLE roster_members (session_key TEXT PRIMARY KEY REFERENCES sessions(session_key), host_id TEXT NOT NULL);
        CREATE INDEX roster_members_host ON roster_members(host_id);
        INSERT INTO roster_members (session_key, host_id) SELECT session_key, host_id FROM sessions;
      `);
      this.db.prepare("INSERT INTO metadata (key, value) VALUES ('board_id', ?), ('sequence', '0')").run(randomUUID());
      const rows = this.db.prepare("SELECT host_id, COUNT(*) AS count, MIN(snapshot_json) AS snapshot_json FROM sessions GROUP BY host_id").all() as { host_id: string; count: number; snapshot_json: string }[];
      for (const row of rows) {
        const snapshot = sessionSchema.parse(JSON.parse(row.snapshot_json));
        const health = this.emptyHealth(row.host_id, snapshot.hostLabel);
        health.sessionCount = row.count;
        this.db.prepare("INSERT INTO host_health (host_id, sequence, data_json) VALUES (?, 0, ?)").run(row.host_id, JSON.stringify(health));
      }
      this.db.exec("PRAGMA user_version = 2");
    });
  }

  private metadata(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  boardId(): string { return this.metadata("board_id")!; }

  nextSequence(): number {
    return this.transaction(() => {
      const next = Number(this.metadata("sequence")) + 1;
      if (!Number.isSafeInteger(next)) throw new Error("동기화 순번의 안전한 범위를 초과했습니다.");
      this.db.prepare("UPDATE metadata SET value = ? WHERE key = 'sequence'").run(String(next));
      return next;
    });
  }

  private emptyHealth(hostId: string, label: string): HostHealth {
    return { hostId, label, status: "stale", lastAttemptAt: null, lastSuccessAt: null, error: null, truncated: false,
      sessionCount: 0, bridgeState: "unconfigured", queuedReports: 0, blockedReports: 0 };
  }

  getLinkedTask(hostId: string, agentId: string): Task | null {
    const id = this.sessionOwner(sessionKey({ hostId, agentId }));
    const task = id ? this.getTask(id) : undefined;
    return task && !task.archivedAt ? task : null;
  }

  tasksForHost(hostId: string): Task[] {
    const rows = this.db.prepare(`SELECT DISTINCT t.* FROM tasks t JOIN task_sessions l ON l.task_id=t.id
      JOIN sessions s ON s.session_key=l.session_key WHERE s.host_id=? AND t.archived_at IS NULL ORDER BY t.id`).all(hostId) as TaskRow[];
    return rows.map((row) => this.taskFromRow(row));
  }

  recordHostResult(input: {
    hostId: string; label: string; sequence: number; status: HostHealth["status"];
    sessions?: SessionSnapshot[]; truncated?: boolean; error?: string | null;
    bridgeState?: HostHealth["bridgeState"]; queuedReports?: number; blockedReports?: number;
  }): void {
    if (!input.hostId || input.hostId.length > 256 || !Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new Error("호스트 또는 동기화 순번이 올바르지 않습니다.");
    if (input.sessions && input.sessions.length > 2_000) throw new Error("한 번에 수집할 수 있는 세션은 2,000개입니다.");
    const at = new Date().toISOString();
    const snapshots = input.sessions?.map((value) => {
      const snapshot = sessionSchema.parse(value);
      if (snapshot.hostId !== input.hostId) throw new Error("수집한 세션의 호스트가 요청한 호스트와 다릅니다.");
      return { ...snapshot, hostLabel: input.label.slice(0, 256), observedAt: at };
    });
    this.transaction(() => {
      const row = this.db.prepare("SELECT sequence, data_json FROM host_health WHERE host_id=?").get(input.hostId) as HostRow | undefined;
      if (row && input.sequence <= row.sequence) return;
      const previous = row ? hostHealthSchema.parse(JSON.parse(row.data_json)) : this.emptyHealth(input.hostId, input.label);
      if (snapshots !== undefined) {
        if (!input.truncated) this.db.prepare("DELETE FROM roster_members WHERE host_id=?").run(input.hostId);
        for (const snapshot of snapshots) {
          // A daemon collection is authoritative: old client clocks cannot suppress it.
          this.upsertSession(snapshot, true);
          this.db.prepare("INSERT INTO roster_members (session_key, host_id) VALUES (?, ?) ON CONFLICT(session_key) DO NOTHING").run(sessionKey(snapshot), input.hostId);
        }
      }
      const count = (this.db.prepare("SELECT COUNT(*) AS count FROM roster_members WHERE host_id=?").get(input.hostId) as { count: number }).count;
      const health = hostHealthSchema.parse({
        ...previous, hostId: input.hostId, label: input.label, status: input.status, lastAttemptAt: at,
        lastSuccessAt: snapshots === undefined ? previous.lastSuccessAt : at,
        error: input.error ?? null, truncated: snapshots === undefined ? previous.truncated : input.truncated ?? false,
        sessionCount: count, bridgeState: input.bridgeState ?? previous.bridgeState,
        queuedReports: input.queuedReports ?? previous.queuedReports, blockedReports: input.blockedReports ?? previous.blockedReports,
      });
      this.db.prepare(`INSERT INTO host_health (host_id, sequence, data_json) VALUES (?, ?, ?)
        ON CONFLICT(host_id) DO UPDATE SET sequence=excluded.sequence,data_json=excluded.data_json`).run(input.hostId, input.sequence, JSON.stringify(health));
      const current = Number(this.metadata("sequence"));
      if (input.sequence > current) this.db.prepare("UPDATE metadata SET value=? WHERE key='sequence'").run(String(input.sequence));
    });
  }

  readRoster(staleAfterMs = 60_000): RosterSnapshot {
    if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) throw new Error("오래된 상태의 기준 시간이 올바르지 않습니다.");
    const now = Date.now();
    const hosts = (this.db.prepare("SELECT data_json FROM host_health ORDER BY host_id").all() as { data_json: string }[]).map((row) => {
      const host = hostHealthSchema.parse(JSON.parse(row.data_json));
      if (host.status === "online" && (!host.lastSuccessAt || now - Date.parse(host.lastSuccessAt) > staleAfterMs)) return { ...host, status: "stale" as const };
      return host;
    });
    const sessions = (this.db.prepare(`SELECT s.snapshot_json FROM sessions s JOIN roster_members r ON r.session_key=s.session_key
      ORDER BY r.host_id,s.agent_id`).all() as { snapshot_json: string }[]).map((row) => sessionSchema.parse(JSON.parse(row.snapshot_json)));
    return { sessions, hosts, generatedAt: new Date(now).toISOString() };
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private taskFromRow(row: TaskRow, sessions?: SessionSnapshot[]): Task {
    const raw: unknown = JSON.parse(row.fields_json);
    if (!raw || typeof raw !== "object" || FIELD_NAMES.some((field) => !Object.hasOwn(raw, field))) {
      throw new Error(`작업 ${row.id}의 저장 필드가 불완전합니다. 데이터를 초기화하지 않았습니다.`);
    }
    const fields = taskFieldsSchema.parse(raw);
    return {
      ...fields, id: row.id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
      archivedAt: row.archived_at,
      sessions: sessions ?? (this.db.prepare(`
        SELECT s.snapshot_json FROM task_sessions l
        JOIN sessions s ON s.session_key = l.session_key
        WHERE l.task_id = ? ORDER BY l.linked_at, l.session_key
      `).all(row.id) as { snapshot_json: string }[]).map((entry) => sessionSchema.parse(JSON.parse(entry.snapshot_json))),
    };
  }

  private getTask(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? this.taskFromRow(row) : undefined;
  }

  private tasks(): Task[] {
    const sessions = new Map<string, SessionSnapshot[]>();
    const links = this.db.prepare(`
      SELECT l.task_id, s.snapshot_json FROM task_sessions l
      JOIN sessions s ON s.session_key = l.session_key ORDER BY l.linked_at, l.session_key
    `).all() as { task_id: string; snapshot_json: string }[];
    for (const link of links) {
      const rows = sessions.get(link.task_id) ?? [];
      rows.push(sessionSchema.parse(JSON.parse(link.snapshot_json)));
      sessions.set(link.task_id, rows);
    }
    return (this.db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC, created_at DESC, id").all() as TaskRow[])
      .map((row) => this.taskFromRow(row, sessions.get(row.id) ?? []));
  }

  readBoard(): BoardSnapshot {
    return { tasks: this.tasks(), activities: this.listActivities({ limit: 200 }).activities, generatedAt: new Date().toISOString() };
  }

  private record(taskId: string, kind: Activity["kind"], message: string, actor: Activity["actor"], at: string): void {
    this.db.prepare("INSERT INTO activities (task_id, kind, message, actor, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(taskId, kind, message, actor, at);
  }

  private withReceipt(requestId: string, payload: unknown, operation: () => MutationResult, authorize?: () => MutationResult | undefined): MutationResult {
    const fingerprint = createHash("sha256").update(canonical(payload)).digest("hex");
    return this.transaction(() => {
      // Retry identity never grants access after the session's task link is
      // revoked. This check shares the write transaction with receipt replay.
      const denied = authorize?.();
      if (denied) return denied;
      const previous = this.db.prepare("SELECT fingerprint, result_json FROM receipts WHERE request_id = ?").get(requestId) as ReceiptRow | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint) return failure("REQUEST_ID_REUSED", "같은 요청 ID가 다른 내용에 재사용되었습니다. 새 요청 ID로 다시 시도하세요.");
        const result = mutationResultSchema.parse(JSON.parse(previous.result_json));
        return result.ok ? { ...result, replayed: true } : result;
      }
      const result = operation();
      this.db.prepare("INSERT INTO receipts (request_id, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?)")
        .run(requestId, fingerprint, JSON.stringify(result), new Date().toISOString());
      return result;
    });
  }

  private sessionOwner(key: string): string | undefined {
    return (this.db.prepare("SELECT task_id FROM task_sessions WHERE session_key = ?").get(key) as { task_id: string } | undefined)?.task_id;
  }

  /** Caller holds the SQLite transaction. Older/equal observations never win. */
  private upsertSession(session: SessionSnapshot, authoritative = false): boolean {
    const key = sessionKey(session);
    const observedMs = Date.parse(session.observedAt);
    const previous = this.db.prepare("SELECT snapshot_json, observed_ms FROM sessions WHERE session_key = ?").get(key) as SessionRow | undefined;
    const managed = (this.db.prepare("SELECT sequence, data_json FROM host_health WHERE host_id=?").get(session.hostId) as HostRow | undefined)?.sequence;
    if (!authoritative && (((managed ?? 0) > 0 && previous) || (previous && previous.observed_ms >= observedMs))) return false;
    this.db.prepare(`
      INSERT INTO sessions (session_key, host_id, agent_id, observed_ms, snapshot_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET observed_ms = excluded.observed_ms, snapshot_json = excluded.snapshot_json
    `).run(key, session.hostId, session.agentId, observedMs, JSON.stringify(session));
    if (!authoritative && !(managed && managed > 0)) {
      this.db.prepare("INSERT INTO roster_members (session_key, host_id) VALUES (?, ?) ON CONFLICT(session_key) DO NOTHING").run(key, session.hostId);
      const health = this.emptyHealth(session.hostId, session.hostLabel);
      health.sessionCount = (this.db.prepare("SELECT COUNT(*) AS count FROM roster_members WHERE host_id=?").get(session.hostId) as { count: number }).count;
      this.db.prepare("INSERT INTO host_health (host_id, sequence, data_json) VALUES (?, 0, ?) ON CONFLICT(host_id) DO NOTHING").run(session.hostId, JSON.stringify(health));
      this.db.prepare("UPDATE host_health SET data_json=? WHERE host_id=? AND sequence=0").run(JSON.stringify(health), session.hostId);
    }
    if (previous) {
      const old = sessionSchema.parse(JSON.parse(previous.snapshot_json));
      const taskId = this.sessionOwner(key);
      if (taskId && old.execution !== session.execution) {
        this.record(taskId, "session", `${session.hostLabel || session.hostId} · ${oneLine(session.title)}: ${EXECUTION_LABELS[old.execution]} → ${EXECUTION_LABELS[session.execution]}`, "system", new Date().toISOString());
      }
    }
    return true;
  }

  observe(sessions: SessionSnapshot[]): { changed: number } {
    if (sessions.length > 2_000) throw new Error("한 번에 관측할 수 있는 세션은 2,000개입니다.");
    // Validate the entire batch before writing any row.
    const normalized = sessions.map(normalizedSession);
    return this.transaction(() => ({ changed: normalized.reduce((count, session) => count + Number(this.upsertSession(session)), 0) }));
  }

  private saveTask(task: Task, fields: TaskFields, at: string, archivedAt = task.archivedAt): Task {
    this.db.prepare("UPDATE tasks SET fields_json = ?, revision = revision + 1, updated_at = ?, archived_at = ? WHERE id = ?")
      .run(JSON.stringify(fields), at, archivedAt, task.id);
    return this.getTask(task.id)!;
  }

  /**
   * Link several sessions to one task at once (project grouping and folder
   * auto-link). Sessions already linked anywhere are skipped, never moved.
   * One revision bump for the whole batch; one activity line per session.
   */
  linkMany(taskId: string, sessions: SessionSnapshot[], actor: "user" | "system"): { task: Task; linked: number } | undefined {
    return this.transaction(() => {
      const current = this.getTask(taskId);
      if (!current || current.archivedAt) return undefined;
      const at = new Date().toISOString();
      let linked = 0;
      for (const raw of sessions) {
        const session = normalizedSession(raw);
        const key = sessionKey(session);
        if (this.sessionOwner(key)) continue;
        this.upsertSession(session);
        this.db.prepare("INSERT INTO task_sessions (session_key, task_id, linked_at) VALUES (?, ?, ?)").run(key, current.id, at);
        const label = `${session.hostLabel || session.hostId} · ${session.title}`;
        this.record(current.id, "linked", actor === "system" ? `자동 연결: ${label}` : `세션 연결: ${label}`, actor, at);
        linked += 1;
      }
      const task = linked ? this.saveTask(current, fieldsOf(current), at) : current;
      return { task, linked };
    });
  }

  /** Read-only lookup for the auto-link rules. */
  taskById(id: string): Task | undefined { return this.getTask(id); }

  mutate(input: Mutation): MutationResult {
    const parsed = mutationSchema.safeParse(input);
    if (!parsed.success) return failure("VALIDATION", parsed.error.issues.map((issue) => issue.message).join("; "));
    const mutation = parsed.data;
    if ((mutation.op === "create" && mutation.session) || mutation.op === "link") {
      try {
        mutation.session = normalizedSession(mutation.session!);
      } catch (error) {
        return failure("VALIDATION", error instanceof Error ? error.message : String(error));
      }
    }
    return this.withReceipt(mutation.requestId, { type: "mutation", input: mutation }, () => this.applyMutation(mutation));
  }

  private applyMutation(mutation: Mutation): MutationResult {
    const at = new Date().toISOString();
    if (mutation.op === "create") {
      const count = (this.db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }).count;
      if (count >= TASK_LIMIT) return failure("LIMIT", "작업은 보관한 작업을 포함해 최대 2,000개입니다. 기존 데이터는 그대로 보존됩니다.");
      if (mutation.session) {
        const owner = this.sessionOwner(sessionKey(mutation.session));
        if (owner) return failure("ALREADY_LINKED", "이 세션은 이미 다른 작업에 연결되어 있습니다.", this.getTask(owner));
      }
      const id = randomUUID();
      this.db.prepare("INSERT INTO tasks (id, revision, fields_json, created_at, updated_at, archived_at) VALUES (?, 1, ?, ?, ?, NULL)")
        .run(id, JSON.stringify(mutation.fields), at, at);
      this.record(id, "created", `작업 등록: ${mutation.fields.title}`, "user", at);
      if (mutation.session) {
        this.upsertSession(mutation.session);
        this.db.prepare("INSERT INTO task_sessions (session_key, task_id, linked_at) VALUES (?, ?, ?)").run(sessionKey(mutation.session), id, at);
        this.record(id, "linked", `세션 연결: ${mutation.session.hostLabel || mutation.session.hostId} · ${mutation.session.title}`, "user", at);
      }
      return { ok: true, task: this.getTask(id)!, replayed: false };
    }

    const current = this.getTask(mutation.taskId);
    if (!current) return failure("NOT_FOUND", "작업을 찾을 수 없습니다.");
    if (current.revision !== mutation.expectedRevision) return failure("CONFLICT", "다른 화면에서 작업이 변경되었습니다. 최신 내용을 확인한 뒤 다시 저장하세요.", current);
    const fields = fieldsOf(current);

    switch (mutation.op) {
      case "update": {
        const next = taskFieldsSchema.parse({ ...fields, ...mutation.patch });
        const changed = changedFields(fields, next);
        if (changed.length === 0) return { ok: true, task: current, replayed: false };
        const task = this.saveTask(current, next, at);
        if (changed.includes("status")) this.record(task.id, "status", `${STATUS_LABELS[current.status]} → ${STATUS_LABELS[next.status]}`, "user", at);
        const other = changed.filter((field) => field !== "status");
        if (other.length > 0) this.record(task.id, "edited", other.map((field) => `${FIELD_LABELS[field]}: ${next[field] || "(비움)"}`).join("\n\n"), "user", at);
        return { ok: true, task, replayed: false };
      }
      case "link": {
        const key = sessionKey(mutation.session);
        const owner = this.sessionOwner(key);
        if (owner && owner !== current.id) return failure("ALREADY_LINKED", "이 세션은 이미 다른 작업에 연결되어 있습니다.", this.getTask(owner));
        this.upsertSession(mutation.session);
        if (owner === current.id) return { ok: true, task: this.getTask(current.id)!, replayed: false };
        this.db.prepare("INSERT INTO task_sessions (session_key, task_id, linked_at) VALUES (?, ?, ?)").run(key, current.id, at);
        const task = this.saveTask(current, fields, at);
        this.record(task.id, "linked", `세션 연결: ${mutation.session.hostLabel || mutation.session.hostId} · ${mutation.session.title}`, "user", at);
        return { ok: true, task, replayed: false };
      }
      case "unlink": {
        const key = sessionKey(mutation);
        if (this.sessionOwner(key) !== current.id) return { ok: true, task: current, replayed: false };
        const session = current.sessions.find((entry) => sessionKey(entry) === key)!;
        this.db.prepare("DELETE FROM task_sessions WHERE session_key = ? AND task_id = ?").run(key, current.id);
        const task = this.saveTask(current, fields, at);
        this.record(task.id, "unlinked", `세션 연결 해제: ${session.hostLabel || session.hostId} · ${session.title}`, "user", at);
        return { ok: true, task, replayed: false };
      }
      case "note": {
        const task = this.saveTask(current, fields, at);
        this.record(task.id, "note", mutation.message, "user", at);
        return { ok: true, task, replayed: false };
      }
      case "archive": {
        if (current.archivedAt) return { ok: true, task: current, replayed: false };
        const task = this.saveTask(current, fields, at, at);
        this.record(task.id, "archived", "작업을 보관했습니다. 기록과 세션 연결은 유지됩니다.", "user", at);
        return { ok: true, task, replayed: false };
      }
      case "restore": {
        if (!current.archivedAt) return { ok: true, task: current, replayed: false };
        const task = this.saveTask(current, fields, at, null);
        this.record(task.id, "restored", "보관한 작업을 보드로 복원했습니다.", "user", at);
        return { ok: true, task, replayed: false };
      }
    }
  }

  report(hostId: string, agentId: string, input: AgentReport): MutationResult {
    const parsed = reportSchema.safeParse(input);
    if (!parsed.success) return failure("VALIDATION", parsed.error.issues.map((issue) => issue.message).join("; "));
    if (!hostId || !agentId || hostId.length > 256 || agentId.length > 256) return failure("VALIDATION", "보고한 호스트와 에이전트를 확인할 수 없습니다.");
    const report = parsed.data;
    return this.withReceipt(report.requestId, { type: "report", hostId, agentId, input: report }, () => {
      const current = this.getTask(report.taskId)!; // Authorized inside this transaction below.
      if (current.revision !== report.expectedRevision) return failure("CONFLICT", "작업이 변경되었습니다. 최신 작업을 읽고 다시 보고하세요.", current);
      // An agent's completion claim is a review submission, never human-confirmed Done.
      const status = report.status === "done" ? "review" : report.status ?? current.status;
      const next = taskFieldsSchema.parse({
        ...fieldsOf(current), status, summary: report.summary, doneText: report.doneText,
        nextAction: report.nextAction,
        blockedReason: report.blockedReason ?? current.blockedReason,
        evidence: report.evidence ?? current.evidence,
      });
      const at = new Date().toISOString();
      const task = this.saveTask(current, next, at);
      const sections = [
        `에이전트 보고: ${hostId} · ${agentId}`,
        ...(report.status === "done" ? ["완료 요청을 검토 상태로 기록했습니다."] : []),
        `상태: ${STATUS_LABELS[status]}`,
        `현재 요약: ${report.summary || "(없음)"}`,
        `한 일: ${report.doneText || "(없음)"}`,
        `다음 행동: ${report.nextAction || "(없음)"}`,
        `막힌 이유: ${next.blockedReason || "(없음)"}`,
        `결과 근거: ${next.evidence || "(없음)"}`,
      ];
      this.record(task.id, "reported", sections.join("\n\n"), "agent", at);
      return { ok: true, task, replayed: false };
    }, () => {
      const current = this.getTask(report.taskId);
      if (!current) return failure("NOT_FOUND", "보고할 작업을 찾을 수 없습니다. 보고로 새 작업을 만들지는 않습니다.");
      if (this.sessionOwner(sessionKey({ hostId, agentId })) !== current.id) return failure("VALIDATION", "이 호스트의 에이전트가 해당 작업에 연결되어 있지 않습니다.");
      if (current.archivedAt) return failure("VALIDATION", "보관한 작업에는 보고할 수 없습니다. 먼저 작업을 복원하세요.");
      return undefined;
    });
  }

  /**
   * The transport can settle a previously applied delivery after unlink/archive,
   * but receives only outcome metadata. Agent-facing report() still reauthorizes
   * before returning any cached task contents.
   */
  reportDelivery(hostId: string, agentId: string, value: AgentReport): ReportOutcome {
    const parsed = reportSchema.safeParse(value);
    const taskId = typeof value?.taskId === "string" ? value.taskId : "";
    if (!parsed.success || !hostId || !agentId || hostId.length > 256 || agentId.length > 256) {
      return { ok: false, taskId, code: "VALIDATION", message: "보고 형식 또는 보고한 호스트와 에이전트를 확인할 수 없습니다." };
    }
    const input = parsed.data;
    const fingerprint = createHash("sha256").update(canonical({ type: "report", hostId, agentId, input })).digest("hex");
    const outcome = (result: MutationResult, replayed: boolean): ReportOutcome => result.ok
      ? { ok: true, taskId: result.task.id, appliedRevision: result.task.revision, replayed }
      : { ok: false, taskId: input.taskId, code: result.code, message: result.message };
    const existing = (): ReportOutcome | undefined => {
      const row = this.db.prepare("SELECT fingerprint,result_json FROM receipts WHERE request_id=?").get(input.requestId) as ReceiptRow | undefined;
      if (!row) return undefined;
      if (row.fingerprint !== fingerprint) return { ok: false, taskId: input.taskId, code: "REQUEST_ID_REUSED", message: "같은 요청 ID가 다른 보고에 재사용되었습니다." };
      return outcome(mutationResultSchema.parse(JSON.parse(row.result_json)), true);
    };
    const saved = existing();
    if (saved) return saved;
    const result = this.report(hostId, agentId, input);
    // Another SQLite writer may have committed between the first lookup and the
    // report transaction. Recheck only on failure; never return a task body.
    if (!result.ok) return existing() ?? outcome(result, false);
    return outcome(result, result.replayed);
  }

  listActivities(input: { taskId?: string; before?: number; limit: number }): { activities: Activity[]; hasMore: boolean } {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) throw new Error("활동 조회 개수는 1~500 사이의 정수여야 합니다.");
    if (input.before !== undefined && (!Number.isSafeInteger(input.before) || input.before < 1)) throw new Error("활동 커서가 올바르지 않습니다.");
    const clauses: string[] = [];
    const values: (string | number)[] = [];
    if (input.taskId !== undefined) { clauses.push("task_id = ?"); values.push(input.taskId); }
    if (input.before !== undefined) { clauses.push("id < ?"); values.push(input.before); }
    const rows = this.db.prepare(`SELECT * FROM activities ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .all(...values, input.limit + 1) as ActivityRow[];
    return { activities: rows.slice(0, input.limit).map(activityOf), hasMore: rows.length > input.limit };
  }

  private allActivities(): Activity[] {
    return (this.db.prepare("SELECT * FROM activities ORDER BY id").all() as ActivityRow[]).map(activityOf);
  }

  exportJson(): string {
    const sessions = (this.db.prepare("SELECT snapshot_json FROM sessions ORDER BY host_id, agent_id").all() as { snapshot_json: string }[])
      .map((row) => sessionSchema.parse(JSON.parse(row.snapshot_json)));
    return JSON.stringify({
      format: "paseo-worklog", schemaVersion: SCHEMA_VERSION, boardId: this.boardId(), exportedAt: new Date().toISOString(),
      tasks: this.tasks(), sessions, roster: this.readRoster(), activities: this.allActivities(),
    }, null, 2);
  }

  exportMarkdown(): string {
    const tasks = this.tasks();
    const activities = this.allActivities();
    const lines = ["# Paseo Worklog", "", `내보낸 시각: ${new Date().toISOString()}`, "", `작업 ${tasks.length}개 · 활동 ${activities.length}개`, ""];
    for (const task of tasks) {
      lines.push(`## ${oneLine(task.title)}`, "", `- ID: ${task.id}`, `- 상태: ${STATUS_LABELS[task.status]}${task.archivedAt ? " · 보관됨" : ""}`,
        `- 프로젝트: ${oneLine(task.project) || "(없음)"}`, `- 우선순위: ${PRIORITY_LABELS[task.priority]}`, `- 수정 버전: ${task.revision}`,
        `- 생성: ${task.createdAt}`, `- 수정: ${task.updatedAt}`, "");
      for (const [label, value] of [["설명", task.description], ["현재 요약", task.summary], ["한 일", task.doneText], ["다음 행동", task.nextAction], ["막힌 이유", task.blockedReason], ["결과 근거", task.evidence]]) {
        if (value) lines.push(`### ${label}`, "", value!, "");
      }
      if (task.sessions.length) {
        lines.push("### 연결된 세션", "");
        for (const session of task.sessions) lines.push(`- ${oneLine(session.hostLabel || session.hostId)} · ${oneLine(session.title)} · ${EXECUTION_LABELS[session.execution]} (${session.agentId}) · 마지막 관측 ${session.observedAt}`);
        lines.push("");
      }
      const history = activities.filter((activity) => activity.taskId === task.id);
      if (history.length) {
        lines.push("### 작업 기록", "");
        for (const activity of history) lines.push(`#### ${activity.createdAt} · ${activity.actor} · ${activity.kind}`, "", activity.message, "");
      }
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  close(): void {
    if (!this.closed) { this.db.close(); this.closed = true; }
  }
}
