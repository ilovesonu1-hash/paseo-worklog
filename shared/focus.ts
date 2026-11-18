import { sessionKey, STATUS_ORDER } from "./model.ts";
import type { SessionSnapshot, Task, TaskStatus } from "./model.ts";

/**
 * Cross-project attention model. Pure functions over the board snapshot and the
 * live roster, so the views stay presentation-only and the rules stay testable.
 * Only sessions observed on a currently healthy host count as live; a stale
 * observation never raises a "needs you" signal.
 *
 * Sessions that are not linked to a task are placed automatically by their
 * working-directory folder name. Placement is a view: nothing is written to
 * the board, and the session's run state never becomes a task status.
 */
export type FocusReason = "waiting" | "review" | "blocked" | "error" | "stalled" | "noNext";

/** Lower rank = more urgent. A task or session is listed once, under its most urgent reason. */
export const FOCUS_ORDER: FocusReason[] = ["waiting", "review", "blocked", "error", "stalled", "noNext"];

export const FOCUS_LABELS: Record<FocusReason, string> = {
  waiting: "권한·답변 필요",
  review: "검토 대기",
  blocked: "막힘",
  error: "세션 오류",
  stalled: "진행 멈춤",
  noNext: "다음 행동 없음",
};

export const FOCUS_HINTS: Record<FocusReason, string> = {
  waiting: "에이전트가 권한 승인이나 답변을 기다립니다.",
  review: "결과 확인을 기다립니다. 확인했으면 완료로 옮기세요.",
  blocked: "결정이나 자료가 필요합니다.",
  error: "세션이 오류 상태입니다.",
  stalled: "진행 중인데 한동안 기록이 없습니다.",
  noNext: "진행 중인데 다음 행동이 적혀 있지 않습니다.",
};

export const DEFAULT_STALL_DAYS = 3;
/** Finished (idle) unlinked sessions are placed only if they were active this recently. */
export const DEFAULT_RECENT_DAYS = 3;
const DAY_MS = 86_400_000;
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 } as const;

export interface FocusOptions {
  now?: number;
  stallDays?: number;
  recentDays?: number;
}

/** Board columns an unlinked session can be placed in, by run state. */
export type AutoColumn = "doing" | "review" | "blocked";
export const AUTO_COLUMN: Partial<Record<SessionSnapshot["execution"], AutoColumn>> = {
  working: "doing", idle: "review", waiting: "blocked", error: "blocked",
};

export interface AutoSession {
  session: SessionSnapshot;
  /** Matching task project name (case-insensitive), else the folder name. */
  project: string;
  /** "dormant" = finished and inactive past the recent window: the project still gets a lane, but no card. */
  column: AutoColumn | "dormant";
}

export function sessionFolder(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

export function sessionActivity(session: SessionSnapshot): string {
  return session.activityAt ?? session.observedAt;
}

function liveLinks(task: Task, live: ReadonlyMap<string, SessionSnapshot>): SessionSnapshot[] {
  return task.sessions.flatMap((saved) => {
    const current = live.get(sessionKey(saved));
    return current ? [current] : [];
  });
}

export function placeUnlinkedSessions(tasks: readonly Task[], live: ReadonlyMap<string, SessionSnapshot>, options: FocusOptions = {}): AutoSession[] {
  const now = options.now ?? Date.now();
  const recentMs = (options.recentDays ?? DEFAULT_RECENT_DAYS) * DAY_MS;
  // Archived tasks keep their links, so their sessions stay out of auto placement too.
  const linked = new Set(tasks.flatMap((task) => task.sessions.map(sessionKey)));
  const projects = new Map<string, string>();
  for (const task of [...tasks].sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt))) {
    if (task.project && !projects.has(task.project.toLocaleLowerCase())) projects.set(task.project.toLocaleLowerCase(), task.project);
  }
  const placed: AutoSession[] = [];
  for (const session of live.values()) {
    if (linked.has(sessionKey(session)) || session.parentAgentId) continue;
    let column: AutoSession["column"] | undefined = AUTO_COLUMN[session.execution];
    if (!column) continue;
    if (session.execution === "idle" && session.activityAt) {
      const active = Date.parse(session.activityAt);
      if (Number.isFinite(active) && now - active > recentMs) column = "dormant";
    }
    const folder = sessionFolder(session.cwd);
    placed.push({ session, column, project: projects.get(folder.toLocaleLowerCase()) ?? folder });
  }
  return placed.sort((a, b) => sessionActivity(b.session).localeCompare(sessionActivity(a.session)));
}

export function focusReasons(task: Task, live: ReadonlyMap<string, SessionSnapshot>, options: FocusOptions = {}): FocusReason[] {
  if (task.archivedAt || task.status === "done") return [];
  const now = options.now ?? Date.now();
  const stallMs = (options.stallDays ?? DEFAULT_STALL_DAYS) * DAY_MS;
  const sessions = liveLinks(task, live);
  const reasons = new Set<FocusReason>();
  if (sessions.some((session) => session.execution === "waiting")) reasons.add("waiting");
  if (task.status === "review") reasons.add("review");
  if (task.status === "blocked") reasons.add("blocked");
  if (sessions.some((session) => session.execution === "error")) reasons.add("error");
  if (task.status === "doing") {
    const updated = Date.parse(task.updatedAt);
    const working = sessions.some((session) => session.execution === "working");
    if (!working && Number.isFinite(updated) && now - updated > stallMs) reasons.add("stalled");
    if (!task.nextAction.trim()) reasons.add("noNext");
  }
  return FOCUS_ORDER.filter((reason) => reasons.has(reason));
}

export interface FocusItem {
  /** null for an unlinked session placed automatically. */
  task: Task | null;
  reason: FocusReason;
  /** Every reason that applies, most urgent first. */
  reasons: FocusReason[];
  /** Live sessions relevant to the primary reason (waiting/error), else all live links. */
  sessions: SessionSnapshot[];
  project: string;
  /** Last activity, used to put whatever has waited longest first. */
  at: string;
}

export function focusItemKey(item: FocusItem): string {
  return item.task ? `task:${item.task.id}` : `session:${sessionKey(item.sessions[0])}`;
}

export function buildFocusQueue(tasks: readonly Task[], live: ReadonlyMap<string, SessionSnapshot>, options: FocusOptions = {}): FocusItem[] {
  const items: FocusItem[] = [];
  for (const task of tasks) {
    const reasons = focusReasons(task, live, options);
    if (!reasons.length) continue;
    const reason = reasons[0];
    const linked = liveLinks(task, live);
    const sessions = reason === "waiting" || reason === "error"
      ? linked.filter((session) => session.execution === reason) : linked;
    items.push({ task, reason, reasons, sessions, project: task.project, at: task.updatedAt });
  }
  for (const auto of placeUnlinkedSessions(tasks, live, options)) {
    const reason = auto.session.execution === "waiting" ? "waiting" : auto.session.execution === "error" ? "error" : null;
    if (reason) items.push({ task: null, reason, reasons: [reason], sessions: [auto.session], project: auto.project, at: sessionActivity(auto.session) });
  }
  const priority = (item: FocusItem) => item.task ? PRIORITY_RANK[item.task.priority] : PRIORITY_RANK.normal;
  return items.sort((a, b) =>
    FOCUS_ORDER.indexOf(a.reason) - FOCUS_ORDER.indexOf(b.reason)
    || priority(a) - priority(b)
    // Within a reason, the item that has waited longest comes first.
    || a.at.localeCompare(b.at));
}

export interface ProjectLane {
  /** "" means tasks with no project. */
  project: string;
  tasks: Record<TaskStatus, Task[]>;
  /** Unlinked sessions placed automatically, by run state. */
  sessions: Record<AutoColumn, SessionSnapshot[]>;
  /** Unlinked finished sessions inactive past the recent window, newest first. Counted, not carded. */
  dormant: SessionSnapshot[];
  /** The task to resume: doing first, else todo; by priority, then most recent. */
  current: Task | null;
  attention: number;
  live: { working: number; waiting: number; error: number };
  lastUpdatedAt: string | null;
}

function pickCurrent(candidates: readonly Task[]): Task | null {
  return [...candidates].sort((a, b) =>
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

function latest(a: string | null, b: string): string {
  return !a || b > a ? b : a;
}

export function buildProjectLanes(tasks: readonly Task[], live: ReadonlyMap<string, SessionSnapshot>, options: FocusOptions = {}): ProjectLane[] {
  const groups = new Map<string, { tasks: Task[]; sessions: AutoSession[] }>();
  const group = (project: string) => {
    let entry = groups.get(project);
    if (!entry) { entry = { tasks: [], sessions: [] }; groups.set(project, entry); }
    return entry;
  };
  for (const task of tasks) if (!task.archivedAt) group(task.project).tasks.push(task);
  for (const auto of placeUnlinkedSessions(tasks, live, options)) group(auto.project).sessions.push(auto);

  const lanes: ProjectLane[] = [];
  for (const [project, entry] of groups) {
    const byStatus = Object.fromEntries(STATUS_ORDER.map((status) => [status, [] as Task[]])) as Record<TaskStatus, Task[]>;
    for (const task of entry.tasks) byStatus[task.status].push(task);
    for (const status of STATUS_ORDER) byStatus[status].sort((a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.updatedAt.localeCompare(a.updatedAt));
    const sessions: Record<AutoColumn, SessionSnapshot[]> = { doing: [], review: [], blocked: [] };
    const dormant: SessionSnapshot[] = [];
    for (const auto of entry.sessions) {
      if (auto.column === "dormant") dormant.push(auto.session);
      else sessions[auto.column].push(auto.session);
    }
    const counts = { working: 0, waiting: 0, error: 0 };
    const count = (session: SessionSnapshot) => {
      if (session.execution === "working") counts.working += 1;
      else if (session.execution === "waiting") counts.waiting += 1;
      else if (session.execution === "error") counts.error += 1;
    };
    for (const task of entry.tasks) if (task.status !== "done") liveLinks(task, live).forEach(count);
    entry.sessions.forEach((auto) => count(auto.session));
    let lastUpdatedAt: string | null = null;
    for (const task of entry.tasks) lastUpdatedAt = latest(lastUpdatedAt, task.updatedAt);
    for (const auto of entry.sessions) lastUpdatedAt = latest(lastUpdatedAt, sessionActivity(auto.session));
    lanes.push({
      project, tasks: byStatus, sessions, dormant,
      current: pickCurrent(byStatus.doing) ?? pickCurrent(byStatus.todo),
      attention: entry.tasks.filter((task) => focusReasons(task, live, options).length > 0).length
        + sessions.blocked.length,
      live: counts,
      lastUpdatedAt,
    });
  }
  // Projects that need you first, then the most recently touched; unassigned last.
  return lanes.sort((a, b) =>
    Number(a.project === "") - Number(b.project === "")
    || Number(b.attention > 0) - Number(a.attention > 0)
    || (b.lastUpdatedAt ?? "").localeCompare(a.lastUpdatedAt ?? "")
    || a.project.localeCompare(b.project));
}
