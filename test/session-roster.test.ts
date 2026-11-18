import assert from "node:assert/strict";
import test from "node:test";
import {
  collectHostSessions,
  executionForAgent,
  normalizeSessions,
  readRosterPages,
  SessionRosterCache,
  type RosterAgentEntry,
} from "../client/session-roster.ts";

const firstObservation = "2026-11-12T00:00:00.000Z";
const secondObservation = "2026-11-12T00:01:00.000Z";
const host = { hostId: "pc-a", label: "PC A" };
const entry = (id: string, fields: Partial<RosterAgentEntry["agent"]> = {}): RosterAgentEntry => ({
  agent: { id, title: `Task ${id}`, provider: "codex", cwd: "/work", status: "idle", ...fields },
});
const snapshot = (hostId = host.hostId, observedAt = firstObservation) => normalizeSessions(
  { hostId, label: hostId }, [entry("same-agent-id")], observedAt,
);

test("runtime states do not claim that a task is complete", () => {
  assert.equal(executionForAgent(entry("a", { status: "idle" }).agent), "idle");
  assert.equal(executionForAgent(entry("a", { status: "closed" }).agent), "closed");
  assert.equal(executionForAgent(entry("a", { status: "running", pendingPermissions: [{}] }).agent), "waiting");
  assert.equal(executionForAgent(entry("a", { status: "initializing" }).agent), "working");
  assert.equal(executionForAgent(entry("a", { status: "error", pendingPermissions: [{}] }).agent), "error");
  assert.equal(executionForAgent(entry("a", { status: "future-state" }).agent), "unknown");
});

test("excludes children and known archives but keeps closed primary sessions", () => {
  const sessions = normalizeSessions(host, [
    entry("primary", { status: "closed" }),
    entry("child", { labels: { "paseo.parent-agent-id": "primary" } }),
    entry("archived", { archivedAt: firstObservation }),
    entry("workspace-archive", { workspaceId: "w-archiving" }),
    entry("helper", { internal: true }),
    entry("unknown-workspace", { workspaceId: "not-in-workspace-page" }),
  ], firstObservation, [{ id: "w-archiving", archivingAt: firstObservation }]);
  assert.deepEqual(sessions.map((session) => session.agentId), ["primary", "unknown-workspace"]);
  assert.equal(sessions[0].execution, "closed");
});

test("pagination duplicates keep the newest snapshot and host IDs keep identities separate", () => {
  const sessions = normalizeSessions(host, [
    entry("duplicate", { status: "running", updatedAt: secondObservation }),
    entry("duplicate", { status: "idle", updatedAt: firstObservation }),
  ], secondObservation);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].execution, "working");
  const cache = new SessionRosterCache();
  cache.syncHosts([{ serverId: "pc-a", label: "A", status: "online" }, { serverId: "pc-b", label: "B", status: "online" }]);
  cache.succeed(cache.begin("pc-a", 1)!, snapshot("pc-a"), false);
  cache.succeed(cache.begin("pc-b", 2)!, snapshot("pc-b"), false);
  assert.equal(cache.snapshot().sessions.length, 2);
});

test("offline and failed refreshes retain timestamped last-known sessions", () => {
  const cache = new SessionRosterCache();
  cache.syncHosts([{ serverId: "pc-a", label: "A", status: "online" }]);
  cache.succeed(cache.begin("pc-a", 1)!, snapshot(), false);
  cache.fail(cache.begin("pc-a", 2)!, "timeout");
  assert.equal(cache.snapshot().hosts[0].status, "error");
  assert.equal(cache.snapshot().sessions[0].observedAt, firstObservation);
  cache.syncHosts([{ serverId: "pc-a", label: "Renamed", status: "offline" }]);
  assert.equal(cache.snapshot().hosts[0].status, "offline");
  assert.equal(cache.snapshot().sessions[0].hostLabel, "Renamed");
  assert.equal(cache.snapshot().sessions[0].observedAt, firstObservation);
  assert.equal(cache.begin("pc-a", 3), null);
});

test("out-of-order responses and responses from an old connection cannot replace current state", () => {
  const cache = new SessionRosterCache();
  cache.syncHosts([{ serverId: "pc-a", label: "A", status: "online" }]);
  const older = cache.begin("pc-a", 1)!;
  const newer = cache.begin("pc-a", 2)!;
  assert.equal(cache.succeed(newer, snapshot("pc-a", secondObservation), false), true);
  assert.equal(cache.succeed(older, snapshot(), true), false);
  assert.equal(cache.fail(older, "late error"), false);
  const previousConnection = cache.begin("pc-a", 3)!;
  cache.syncHosts([{ serverId: "pc-a", label: "A", status: "offline" }]);
  cache.syncHosts([{ serverId: "pc-a", label: "A", status: "online" }]);
  assert.equal(cache.succeed(previousConnection, snapshot(), false), false);
  assert.equal(cache.snapshot().sessions[0].observedAt, secondObservation);
});

test("a successful empty directory removes only that host's obsolete sessions", () => {
  const cache = new SessionRosterCache();
  cache.syncHosts([{ serverId: "pc-a", label: "A", status: "online" }, { serverId: "pc-b", label: "B", status: "online" }]);
  cache.succeed(cache.begin("pc-a", 1)!, snapshot("pc-a"), false);
  cache.succeed(cache.begin("pc-b", 1)!, snapshot("pc-b"), false);
  cache.succeed(cache.begin("pc-a", 2)!, [], false);
  assert.deepEqual(cache.snapshot().sessions.map((session) => session.hostId), ["pc-b"]);
});

test("reads all pages up to the per-host cap and explicitly marks truncation", async () => {
  const calls: number[] = [];
  const result = await readRosterPages(async ({ limit, cursor }) => {
    const offset = Number(cursor ?? 0);
    calls.push(offset);
    return {
      entries: Array.from({ length: limit }, (_, index) => offset + index),
      pageInfo: { hasMore: true, nextCursor: String(offset + limit) },
    };
  });
  assert.equal(result.entries.length, 2000);
  assert.equal(result.entries.at(-1), 1999);
  assert.equal(calls.length, 10);
  assert.equal(result.truncated, true);
});

test("a broken cursor fails instead of repeatedly reading or pretending the list is complete", async () => {
  await assert.rejects(readRosterPages(async () => ({
    entries: [entry("a")],
    pageInfo: { hasMore: true, nextCursor: "unchanged" },
  })), /페이지 정보/);
});

test("partial host reads are not returned as a successful replacement", async () => {
  await assert.rejects(collectHostSessions({
    agents: async () => ({ entries: [entry("a")], pageInfo: { hasMore: false, nextCursor: null } }),
    workspaces: async () => { throw new Error("workspace read failed"); },
  }, host, firstObservation), /workspace read failed/);
});

test("records the agent's own last activity time, separate from the observation time", () => {
  const [withActivity, without] = normalizeSessions(host, [
    entry("active", { updatedAt: "2026-11-11T23:30:00Z" }),
    entry("unknown", { updatedAt: "not a date" }),
  ], firstObservation);
  assert.equal(withActivity.activityAt, "2026-11-11T23:30:00.000Z");
  assert.equal(withActivity.observedAt, firstObservation);
  assert.equal(without.activityAt, undefined);
});
