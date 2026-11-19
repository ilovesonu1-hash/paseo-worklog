import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { sessionAckSchema } from "../shared/acks.ts";
import type { AcksSnapshot, SessionAck } from "../shared/acks.ts";

const MAX_ENTRIES = 5_000;
const KEEP_MS = 30 * 86_400_000;
const fileSchema = z.object({ acks: z.array(sessionAckSchema.extend({ ackedAt: z.string() })).default([]) });
type Entry = SessionAck & { ackedAt: string };

/**
 * Acknowledgements of sessions waiting for instructions, kept on the central
 * board so every device sees the same list. A separate small file: the task
 * database schema is unchanged. Old entries are pruned on write.
 */
export class AckStore {
  private entries: Map<string, Entry>;
  private readonly path: string;
  private readonly now: () => Date;

  constructor(path: string, now: () => Date = () => new Date()) {
    this.path = path; this.now = now;
    let parsed: Entry[] = [];
    try { parsed = fileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).acks; } catch { /* missing or unreadable: start empty */ }
    this.entries = new Map(parsed.map((entry) => [AckStore.key(entry), entry]));
  }

  private static key(ack: Pick<SessionAck, "hostId" | "agentId">): string { return JSON.stringify([ack.hostId, ack.agentId]); }

  read(): AcksSnapshot {
    return { acks: [...this.entries.values()].map(({ hostId, agentId, activityAt }) => ({ hostId, agentId, activityAt })) };
  }

  ack(sessions: SessionAck[]): AcksSnapshot {
    const at = this.now();
    for (const session of sessions) this.entries.set(AckStore.key(session), { ...session, ackedAt: at.toISOString() });
    const cutoff = at.getTime() - KEEP_MS;
    const kept = [...this.entries.values()]
      .filter((entry) => Date.parse(entry.ackedAt) >= cutoff)
      .sort((a, b) => b.ackedAt.localeCompare(a.ackedAt))
      .slice(0, MAX_ENTRIES);
    this.entries = new Map(kept.map((entry) => [AckStore.key(entry), entry]));
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ acks: kept })}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
    return this.read();
  }
}
