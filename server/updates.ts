import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { updateStateSchema } from "../shared/updates.ts";
import type { ApplyUpdateResult, UpdateCheck, UpdateState, UpdateStatus } from "../shared/updates.ts";
import type { PaseoConnection } from "./paseo-transport.ts";

export const PLUGIN_ID = "worklog-board";
/** A pending intent older than this, with no confirmation, is reported as unknown. */
export const PENDING_TIMEOUT_MS = 10 * 60_000;

const previewEntrySchema = z.object({
  id: z.string(),
  outcome: z.enum(["update", "current", "installed-newer", "local", "error"]),
  current: z.object({ currentRevision: z.string().optional() }).passthrough().optional(),
  target: z.object({ kind: z.string(), commit: z.string().optional(), version: z.string().optional() }).passthrough().optional(),
  links: z.array(z.string()).default([]),
  proposal: z.unknown().optional(),
  error: z.string().optional(),
}).passthrough();
type PreviewEntry = z.infer<typeof previewEntrySchema>;
const applyEntrySchema = z.object({
  id: z.string(),
  outcome: z.enum(["updated", "error"]),
  error: z.string().optional(),
}).passthrough();

export interface UpdaterDeps {
  /** The local host only: phase 1 never updates another PC. */
  local(): Promise<Pick<PaseoConnection, "updates">>;
  statePath: string;
  now?: () => Date;
  /** Delay between confirmation attempts while an intent is pending. */
  retryMs?: number;
}

function short(message: string): string { return message.replace(/\s+/g, " ").trim().slice(0, 300); }

export function updateError(error: unknown): { unsupported: boolean; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (/Update the host to review plugin updates/i.test(message)) {
    return { unsupported: true, message: "이 PC의 Paseo가 플러그인 업데이트 확인을 지원하지 않습니다. Paseo를 업데이트하세요." };
  }
  if (/timeout|timed out/i.test(message)) return { unsupported: false, message: "Paseo 응답 시간이 초과됐습니다. 잠시 후 다시 확인하세요." };
  if (/LOCAL_|로컬 Paseo|자격 증명/.test(message)) return { unsupported: false, message: "이 PC의 Paseo 데몬에 아직 연결할 수 없습니다." };
  return { unsupported: false, message: short(message) || "업데이트를 확인하지 못했습니다." };
}

function compareUrl(links: string[]): string | null {
  return links.find((link) => /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/compare\//.test(link)) ?? null;
}

/**
 * Self-update of this plugin on this host. The daemon stops this process while
 * applying, so the apply response is usually lost: the intent is persisted
 * first, apply runs detached, and the next instance confirms the revision.
 */
export class PluginUpdater {
  private readonly deps: UpdaterDeps;
  private state: UpdateState;
  private checking: Promise<UpdateStatus> | null = null;
  private applying = false;
  private stopped = false;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: UpdaterDeps) {
    this.deps = deps;
    this.state = this.read();
  }

  private now(): Date { return this.deps.now ? this.deps.now() : new Date(); }

  private read(): UpdateState {
    try { return updateStateSchema.parse(JSON.parse(readFileSync(this.deps.statePath, "utf8"))); }
    catch { return updateStateSchema.parse({}); }
  }

  private write(next: UpdateState): void {
    this.state = next;
    const temporary = `${this.deps.statePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.deps.statePath);
  }

  status(): UpdateStatus {
    this.expirePending();
    return { ...this.state, checking: !!this.checking };
  }

  /** Called once at load. Confirms an update the previous instance requested. */
  start(delayMs = 3_000): void {
    if (!this.state.pending) return;
    this.scheduleReconcile(delayMs, true);
  }

  private scheduleReconcile(delayMs: number, startup: boolean): void {
    if (this.stopped || this.reconcileTimer) return;
    this.reconcileTimer = setTimeout(() => { this.reconcileTimer = null; void this.reconcile(startup); }, delayMs);
    this.reconcileTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  private expirePending(): void {
    const pending = this.state.pending;
    if (!pending || this.applying) return;
    if (this.now().getTime() - Date.parse(pending.requestedAt) < PENDING_TIMEOUT_MS) return;
    this.write({ ...this.state, pending: null, last: {
      at: this.now().toISOString(), outcome: "unknown", fromRevision: pending.fromRevision, targetRevision: pending.targetRevision,
      message: "업데이트 결과를 확인하지 못했습니다. \"업데이트 확인\"을 다시 눌러 지금 설치된 커밋을 보세요.",
    } });
  }

  /**
   * startup: this instance replaced the one that requested the update, so the
   * old revision still installed means Paseo kept it. Otherwise (the requester
   * is still alive and lost its response) only the target revision settles it;
   * keep retrying until expirePending reports "unknown".
   */
  async reconcile(startup = true): Promise<void> {
    this.expirePending();
    const pending = this.state.pending;
    if (!pending || this.stopped) return;
    const retry = () => this.scheduleReconcile(this.deps.retryMs ?? 5_000, startup);
    let entry: PreviewEntry | undefined;
    try { entry = await this.preview(); }
    catch { retry(); return; }
    if (this.stopped || this.state.pending !== pending) return;
    const current = entry?.current?.currentRevision ?? null;
    if (current !== pending.targetRevision && !startup) { retry(); return; }
    const at = this.now().toISOString();
    const last = current === pending.targetRevision
      ? { at, outcome: "updated" as const, fromRevision: pending.fromRevision, targetRevision: pending.targetRevision, message: null }
      : current && current === pending.fromRevision
        ? { at, outcome: "failed" as const, fromRevision: pending.fromRevision, targetRevision: pending.targetRevision,
          message: "Paseo가 업데이트를 적용하지 않고 이전 버전을 유지했습니다. Paseo 플러그인 로그를 확인하세요." }
        : { at, outcome: "unknown" as const, fromRevision: pending.fromRevision, targetRevision: pending.targetRevision,
          message: `현재 커밋(${current ? current.slice(0, 7) : "확인 불가"})이 요청한 커밋과 다릅니다.` };
    this.write({ ...this.state, pending: null, last, check: entry ? this.toCheck(entry, at) : this.state.check });
  }

  private async preview(): Promise<PreviewEntry | undefined> {
    const local = await this.deps.local();
    const entries = z.array(previewEntrySchema).parse(await local.updates.preview());
    return entries.find((entry) => entry.id === PLUGIN_ID);
  }

  private toCheck(entry: PreviewEntry | undefined, checkedAt: string): UpdateCheck {
    if (!entry) return { checkedAt, outcome: "error", currentRevision: null, targetRevision: null, compareUrl: null, error: "Paseo가 설치된 Worklog를 찾지 못했습니다." };
    const target = entry.target?.kind === "git" ? entry.target.commit ?? null : entry.target?.version ?? null;
    return {
      checkedAt, outcome: entry.outcome, currentRevision: entry.current?.currentRevision ?? null, targetRevision: target,
      compareUrl: entry.outcome === "update" ? compareUrl(entry.links) : null,
      error: entry.outcome === "error" ? short(entry.error ?? "") || "업데이트를 확인하지 못했습니다." : null,
    };
  }

  check(): Promise<UpdateStatus> {
    if (this.checking) return this.checking;
    const operation = (async () => {
      const checkedAt = this.now().toISOString();
      let check: UpdateCheck;
      try { check = this.toCheck(await this.preview(), checkedAt); }
      catch (cause) {
        const { unsupported, message } = updateError(cause);
        check = { checkedAt, outcome: unsupported ? "unsupported" : "error", currentRevision: this.state.check?.currentRevision ?? null,
          targetRevision: null, compareUrl: null, error: message };
      }
      if (!this.stopped) this.write({ ...this.state, check });
      return check;
    })().finally(() => { this.checking = null; });
    this.checking = operation.then(() => this.status());
    return this.checking;
  }

  async apply(targetRevision: string): Promise<ApplyUpdateResult> {
    this.expirePending();
    if (this.applying || this.state.pending) return { ok: false, code: "busy", message: "이미 업데이트가 진행 중입니다. 결과가 표시될 때까지 기다리세요.", status: this.status() };
    this.applying = true;
    try {
      let entry: PreviewEntry | undefined;
      try { entry = await this.preview(); }
      catch (cause) { return { ok: false, code: "unavailable", message: updateError(cause).message, status: this.status() }; }
      const checkedAt = this.now().toISOString();
      const check = this.toCheck(entry, checkedAt);
      this.write({ ...this.state, check });
      if (!entry || entry.outcome !== "update" || entry.proposal === undefined || entry.target?.kind !== "git") {
        return { ok: false, code: "unavailable", message: "지금 적용할 업데이트가 없습니다. 업데이트 확인 결과를 보세요.", status: this.status() };
      }
      if (entry.target.commit !== targetRevision) {
        return { ok: false, code: "changed", message: "확인한 뒤 저장소에 새 커밋이 올라왔습니다. 바뀐 내용을 확인하고 다시 실행하세요.", status: this.status() };
      }
      const pending = { requestedAt: this.now().toISOString(), fromRevision: entry.current?.currentRevision ?? null, targetRevision };
      this.write({ ...this.state, pending, last: null });
      const proposal = entry.proposal;
      // Detached on purpose: the daemon reloads this process while applying.
      void this.deps.local()
        .then((local) => local.updates.apply([proposal]))
        .then((raw) => {
          if (this.stopped || this.state.pending !== pending) return;
          const result = z.array(applyEntrySchema).parse(raw).find((item) => item.id === PLUGIN_ID);
          const at = this.now().toISOString();
          this.write({ ...this.state, pending: null, last: result?.outcome === "updated"
            ? { at, outcome: "updated", fromRevision: pending.fromRevision, targetRevision, message: null }
            : { at, outcome: "failed", fromRevision: pending.fromRevision, targetRevision, message: short(result?.error ?? "") || "Paseo가 업데이트를 적용하지 못했습니다." } });
        })
        .catch(() => {
          // No response is not a failure: the daemon may still be applying
          // (its request timeout is 5 minutes) or already reloading this
          // process. Only an error response above records "failed".
          if (this.stopped || this.state.pending !== pending) return;
          this.scheduleReconcile(this.deps.retryMs ?? 5_000, false);
        });
      return { ok: true, status: this.status() };
    } finally { this.applying = false; }
  }
}
