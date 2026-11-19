import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { autoLinkRulesSchema } from "../shared/projects.ts";
import type { AutoLinkRule } from "../shared/projects.ts";
import { sessionFolder } from "../shared/focus.ts";
import { sessionKey, type SessionSnapshot, type Task } from "../shared/model.ts";
import type { WorklogStore } from "./store.ts";

export function folderKey(cwd: string): string { return sessionFolder(cwd).toLocaleLowerCase(); }

/** A session worth grouping: a top-level, still-open session that has a real activity time. */
export function groupable(session: SessionSnapshot): boolean {
  return !session.parentAgentId && session.execution !== "closed" && !!session.activityAt;
}

/**
 * Folder → task rules, kept on the central board in a small file so the task
 * database schema is unchanged. One rule per folder; the latest grouping wins.
 */
export class AutoLinkRules {
  private rules: AutoLinkRule[];
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    try { this.rules = autoLinkRulesSchema.parse(JSON.parse(readFileSync(path, "utf8"))).rules; }
    catch { this.rules = []; }
  }

  list(): { rules: AutoLinkRule[] } { return { rules: [...this.rules] }; }

  set(rule: AutoLinkRule): void { this.write([...this.rules.filter((entry) => entry.folder !== rule.folder), rule]); }

  remove(folder: string): { rules: AutoLinkRule[] } {
    this.write(this.rules.filter((entry) => entry.folder !== folder.toLocaleLowerCase()));
    return this.list();
  }

  private write(rules: AutoLinkRule[]): void {
    this.rules = rules;
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ rules }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
  }

  /**
   * One pass over the stored roster, run by the central collector after each
   * cycle. Links unlinked sessions of a ruled folder that became active after
   * the rule was made. Rules whose task is gone are dropped; a done or
   * archived task pauses its rule.
   */
  apply(store: WorklogStore): number {
    if (!this.rules.length) return 0;
    const roster = store.readRoster(Number.MAX_SAFE_INTEGER).sessions;
    const linked = new Set(store.readBoard().tasks.flatMap((task) => task.sessions.map(sessionKey)));
    let total = 0;
    const keep: AutoLinkRule[] = [];
    for (const rule of this.rules) {
      const task: Task | undefined = store.taskById(rule.taskId);
      if (!task) continue;
      keep.push(rule);
      if (task.archivedAt || task.status === "done") continue;
      const since = Date.parse(rule.createdAt);
      const matches = roster.filter((session) => groupable(session) && !linked.has(sessionKey(session))
        && folderKey(session.cwd) === rule.folder && Date.parse(session.activityAt!) >= since);
      if (!matches.length) continue;
      const result = store.linkMany(task.id, matches, "system");
      if (result) { total += result.linked; matches.forEach((session) => linked.add(sessionKey(session))); }
    }
    if (keep.length !== this.rules.length) this.write(keep);
    return total;
  }
}

/** projects.group: create or reuse the folder's task, link the given recent sessions, and optionally keep auto-linking. */
export function groupProject(store: WorklogStore, rules: AutoLinkRules, input: {
  requestId: string; folder: string; taskId?: string; sessions: SessionSnapshot[]; autoLink: boolean;
}, now: () => Date = () => new Date()): { task: Task; linked: number; rule: AutoLinkRule | null } {
  const folder = input.folder.toLocaleLowerCase();
  const sessions = input.sessions.filter((session) => groupable(session) && folderKey(session.cwd) === folder);
  let taskId = input.taskId;
  if (taskId) {
    const existing = store.taskById(taskId);
    if (!existing || existing.archivedAt) throw new Error("연결할 작업을 찾을 수 없거나 보관된 작업입니다.");
  } else {
    const created = store.mutate({ op: "create", requestId: input.requestId, fields: {
      title: input.folder, project: input.folder, description: "", status: "doing", priority: "normal",
      summary: "", doneText: "", nextAction: "", blockedReason: "", evidence: "",
    } });
    if (!created.ok) throw new Error(created.message);
    taskId = created.task.id;
  }
  const result = store.linkMany(taskId, sessions, "user");
  if (!result) throw new Error("작업에 세션을 연결하지 못했습니다.");
  let rule: AutoLinkRule | null = null;
  if (input.autoLink) {
    rule = { folder, label: input.folder, taskId, createdAt: now().toISOString() };
    rules.set(rule);
  }
  return { ...result, rule };
}
