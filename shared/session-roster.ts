import { sessionKey, type SessionSnapshot } from "./model.ts";

export const SESSION_PAGE_SIZE = 200;
export const SESSION_HOST_LIMIT = 2000;
const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

export interface RosterHost {
  hostId: string;
  label: string;
  status: string;
  error?: string;
  truncated?: boolean;
}

export interface ConfiguredRosterHost {
  serverId: string;
  label: string;
  status: string;
}

/** Only fields needed from the public Paseo directory snapshot. */
export interface RosterAgentEntry {
  agent: {
    id: string;
    title?: string | null;
    provider?: string;
    cwd?: string;
    workspaceId?: string | null;
    status?: string;
    pendingPermissions?: readonly unknown[];
    updatedAt?: string;
    archivedAt?: string | null;
    internal?: boolean;
    background?: boolean;
    labels?: Readonly<Record<string, string>>;
    parentAgentId?: string | null;
  };
}

export interface RosterWorkspace {
  id: string;
  archivingAt?: string | null;
  archivedAt?: string | null;
  internal?: boolean;
  background?: boolean;
}

export interface RosterPage<T> {
  entries: T[];
  pageInfo: { hasMore: boolean; nextCursor: string | null };
}

export interface RosterPageRequest {
  limit: number;
  cursor?: string;
}

export interface RosterReaders {
  agents(page: RosterPageRequest): Promise<RosterPage<RosterAgentEntry>>;
  workspaces(page: RosterPageRequest): Promise<RosterPage<RosterWorkspace>>;
}

export function executionForAgent(
  agent: RosterAgentEntry["agent"],
): SessionSnapshot["execution"] {
  if (agent.status === "error") return "error";
  if (agent.status === "closed") return "closed";
  if (agent.pendingPermissions?.length) return "waiting";
  if (agent.status === "running" || agent.status === "initializing") return "working";
  if (agent.status === "idle") return "idle";
  return "unknown";
}

function parentId(agent: RosterAgentEntry["agent"]): string | null {
  return agent.labels?.[PARENT_AGENT_ID_LABEL]?.trim() || agent.parentAgentId?.trim() || null;
}

function updatedAt(entry: RosterAgentEntry): number {
  const value = Date.parse(entry.agent.updatedAt ?? "");
  return Number.isFinite(value) ? value : 0;
}

/** Runtime status is deliberately separate from the board's task status. */
export function normalizeSessions(
  host: Pick<RosterHost, "hostId" | "label">,
  entries: readonly RosterAgentEntry[],
  observedAt: string,
  workspaces: readonly RosterWorkspace[] = [],
): SessionSnapshot[] {
  const excludedWorkspaces = new Set(
    workspaces
      .filter((workspace) => workspace.archivedAt || workspace.archivingAt || workspace.internal || workspace.background)
      .map((workspace) => workspace.id),
  );
  const newest = new Map<string, RosterAgentEntry>();
  for (const entry of entries) {
    const agent = entry.agent;
    if (!agent.id || agent.id.length > 256) continue;
    const previous = newest.get(agent.id);
    if (!previous || updatedAt(entry) >= updatedAt(previous)) newest.set(agent.id, entry);
  }

  const sessions: SessionSnapshot[] = [];
  for (const { agent } of newest.values()) {
    if (agent.archivedAt || agent.internal || agent.background || parentId(agent)) continue;
    if (agent.workspaceId && excludedWorkspaces.has(agent.workspaceId)) continue;
    sessions.push({
      hostId: host.hostId,
      hostLabel: host.label.slice(0, 256),
      agentId: agent.id,
      workspaceId: agent.workspaceId ?? null,
      title: (agent.title?.trim() || "제목 없는 세션").slice(0, 2000),
      provider: (agent.provider ?? "").slice(0, 256),
      cwd: (agent.cwd ?? "").slice(0, 8192),
      execution: executionForAgent(agent),
      observedAt,
      parentAgentId: null,
      ...(Number.isFinite(Date.parse(agent.updatedAt ?? "")) ? { activityAt: new Date(Date.parse(agent.updatedAt!)).toISOString() } : {}),
    });
  }
  return sessions;
}

/** Follow the server cursor, with a bounded page budget even for malformed empty pages. */
export async function readRosterPages<T>(
  read: (page: RosterPageRequest) => Promise<RosterPage<T>>,
  limit = SESSION_HOST_LIMIT,
): Promise<{ entries: T[]; truncated: boolean }> {
  const entries: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  const pageBudget = Math.ceil(limit / SESSION_PAGE_SIZE);
  for (let pageNumber = 0; pageNumber < pageBudget; pageNumber += 1) {
    const page = await read({ limit: Math.min(SESSION_PAGE_SIZE, limit - entries.length), ...(cursor ? { cursor } : {}) });
    const remaining = limit - entries.length;
    entries.push(...page.entries.slice(0, remaining));
    if (page.entries.length > remaining) return { entries, truncated: true };
    if (!page.pageInfo.hasMore) return { entries, truncated: false };
    if (entries.length >= limit) return { entries, truncated: true };
    const next = page.pageInfo.nextCursor;
    if (!next || cursors.has(next)) throw new Error("세션 목록의 페이지 정보가 올바르지 않습니다.");
    cursors.add(next);
    cursor = next;
  }
  return { entries, truncated: true };
}

export async function collectHostSessions(
  readers: RosterReaders,
  host: Pick<RosterHost, "hostId" | "label">,
  observedAt: string,
): Promise<{ sessions: SessionSnapshot[]; truncated: boolean }> {
  // Wait for both reads to settle before another refresh can start.
  const results = await Promise.allSettled([
    readRosterPages(readers.agents),
    readRosterPages(readers.workspaces),
  ]);
  const [agentResult, workspaceResult] = results;
  if (agentResult.status === "rejected") throw agentResult.reason;
  if (workspaceResult.status === "rejected") throw workspaceResult.reason;
  return {
    sessions: normalizeSessions(host, agentResult.value.entries, observedAt, workspaceResult.value.entries),
    truncated: agentResult.value.truncated || workspaceResult.value.truncated,
  };
}

export interface RosterRequest {
  hostId: string;
  startedAt: number;
  connectionEpoch: number;
}

interface HostRecord {
  label: string;
  connectionStatus: string;
  connectionEpoch: number;
  latestRequestAt: number;
  sessions: SessionSnapshot[];
  error?: string;
  truncated?: boolean;
}

/** Last successful data survives an offline host or a failed refresh. */
export class SessionRosterCache {
  private records = new Map<string, HostRecord>();
  private nextEpoch = 0;

  syncHosts(hosts: readonly ConfiguredRosterHost[]): void {
    const present = new Set(hosts.map((host) => host.serverId));
    for (const key of this.records.keys()) if (!present.has(key)) this.records.delete(key);
    for (const host of hosts) {
      const current = this.records.get(host.serverId);
      if (!current) {
        this.records.set(host.serverId, {
          label: host.label,
          connectionStatus: host.status,
          connectionEpoch: ++this.nextEpoch,
          latestRequestAt: 0,
          sessions: [],
        });
      } else {
        current.label = host.label;
        if (current.connectionStatus !== host.status) {
          current.connectionStatus = host.status;
          current.connectionEpoch = ++this.nextEpoch;
          current.error = undefined;
        }
      }
    }
  }

  begin(hostId: string, startedAt: number): RosterRequest | null {
    const record = this.records.get(hostId);
    if (!record || record.connectionStatus !== "online" || startedAt <= record.latestRequestAt) return null;
    record.latestRequestAt = startedAt;
    return { hostId, startedAt, connectionEpoch: record.connectionEpoch };
  }

  private current(request: RosterRequest): HostRecord | null {
    const record = this.records.get(request.hostId);
    return record && record.connectionStatus === "online"
      && record.connectionEpoch === request.connectionEpoch
      && record.latestRequestAt === request.startedAt ? record : null;
  }

  succeed(request: RosterRequest, sessions: SessionSnapshot[], truncated: boolean): boolean {
    const record = this.current(request);
    if (!record) return false;
    const byIdentity = new Map<string, SessionSnapshot>();
    for (const session of sessions) {
      if (session.hostId === request.hostId) byIdentity.set(sessionKey(session), session);
    }
    record.sessions = [...byIdentity.values()];
    record.truncated = truncated;
    record.error = undefined;
    return true;
  }

  fail(request: RosterRequest, error: string): boolean {
    const record = this.current(request);
    if (!record) return false;
    record.error = error;
    return true;
  }

  snapshot(): { sessions: SessionSnapshot[]; hosts: RosterHost[] } {
    const sessions: SessionSnapshot[] = [];
    const hosts: RosterHost[] = [];
    for (const [hostId, record] of this.records) {
      hosts.push({
        hostId,
        label: record.label,
        status: record.error && record.connectionStatus === "online" ? "error" : record.connectionStatus,
        ...(record.error ? { error: record.error } : {}),
        ...(record.truncated ? { truncated: true } : {}),
      });
      sessions.push(...record.sessions.map((session) => ({ ...session, hostLabel: record.label.slice(0, 256) })));
    }
    return { sessions, hosts };
  }
}

export function rosterError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1200);
}
