import assert from "node:assert/strict";
import test from "node:test";
import { buildFocusQueue, buildProjectLanes, focusReasons, placeUnlinkedSessions } from "../shared/focus.ts";
import { sessionKey, type SessionSnapshot, type Task } from "../shared/model.ts";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

const session = (agentId: string, execution: SessionSnapshot["execution"], hostId = "pc-a"): SessionSnapshot => ({
  hostId, hostLabel: hostId, agentId, workspaceId: null, title: agentId, provider: "claude",
  cwd: "/work", execution, observedAt: hoursAgo(0), parentAgentId: null,
});

let counter = 0;
const task = (fields: Partial<Task> = {}): Task => ({
  id: `t${++counter}`, revision: 1, createdAt: hoursAgo(200), updatedAt: hoursAgo(1), archivedAt: null,
  title: "작업", project: "alpha", description: "", status: "doing", priority: "normal",
  summary: "", doneText: "", nextAction: "다음", blockedReason: "", evidence: "", sessions: [],
  ...fields,
});

const live = (...sessions: SessionSnapshot[]) => new Map(sessions.map((entry) => [sessionKey(entry), entry]));
const options = { now: NOW, stallDays: 3 };

test("a healthy doing task with a next action needs nothing", () => {
  assert.deepEqual(focusReasons(task(), live(), options), []);
});

test("done and archived tasks never ask for attention", () => {
  const waiting = session("a1", "waiting");
  assert.deepEqual(focusReasons(task({ status: "done", sessions: [waiting] }), live(waiting), options), []);
  assert.deepEqual(focusReasons(task({ status: "blocked", archivedAt: hoursAgo(1) }), live(), options), []);
});

test("a waiting live session outranks the task's own status", () => {
  const waiting = session("a1", "waiting");
  const reasons = focusReasons(task({ status: "review", sessions: [waiting] }), live(waiting), options);
  assert.deepEqual(reasons, ["waiting", "review"]);
});

test("only live observations raise session signals", () => {
  // Saved on the task but not in the live map: the host is stale or offline.
  const reasons = focusReasons(task({ sessions: [session("a1", "waiting")] }), live(), options);
  assert.deepEqual(reasons, []);
});

test("stalled requires age past the threshold and no working session", () => {
  assert.deepEqual(focusReasons(task({ updatedAt: hoursAgo(73) }), live(), options), ["stalled"]);
  assert.deepEqual(focusReasons(task({ updatedAt: hoursAgo(71) }), live(), options), []);
  const working = session("a1", "working");
  assert.deepEqual(focusReasons(task({ updatedAt: hoursAgo(200), sessions: [working] }), live(working), options), []);
  // todo tasks are not "stalled": waiting to start is normal.
  assert.deepEqual(focusReasons(task({ status: "todo", updatedAt: hoursAgo(200) }), live(), options), []);
});

test("a doing task without a next action is flagged, a todo one is not", () => {
  assert.deepEqual(focusReasons(task({ nextAction: "  " }), live(), options), ["noNext"]);
  assert.deepEqual(focusReasons(task({ status: "todo", nextAction: "" }), live(), options), []);
});

test("the queue lists each task once, most urgent reason first, then priority, then oldest", () => {
  const waiting = session("w", "waiting");
  const tasks = [
    task({ id: "no-next", nextAction: "" }),
    task({ id: "review-old", status: "review", updatedAt: hoursAgo(10) }),
    task({ id: "review-new", status: "review", updatedAt: hoursAgo(2) }),
    task({ id: "review-high", status: "review", priority: "high", updatedAt: hoursAgo(1) }),
    task({ id: "waiting", status: "blocked", sessions: [waiting] }),
    task({ id: "fine" }),
  ];
  const queue = buildFocusQueue(tasks, live(waiting), options);
  assert.deepEqual(queue.map((item) => item.task?.id), ["waiting", "review-high", "review-old", "review-new", "no-next"]);
  assert.equal(queue[0].reason, "waiting");
  assert.deepEqual(queue[0].reasons, ["waiting", "blocked"]);
  assert.deepEqual(queue[0].sessions.map((entry) => entry.agentId), ["w"]);
});

test("project lanes group by project, pick the task to resume, and sort attention first", () => {
  const working = session("run", "working");
  const waiting = session("ask", "waiting", "pc-b");
  const tasks = [
    task({ project: "quiet", status: "todo", updatedAt: hoursAgo(1), title: "quiet todo" }),
    task({ project: "busy", status: "doing", priority: "low", title: "low doing", sessions: [working] }),
    task({ project: "busy", status: "doing", priority: "high", title: "high doing", updatedAt: hoursAgo(5) }),
    task({ project: "busy", status: "review", title: "to review", sessions: [waiting] }),
    task({ project: "busy", status: "done", title: "finished" }),
    task({ project: "", status: "blocked", title: "orphan" }),
    task({ project: "gone", status: "doing", archivedAt: hoursAgo(1) }),
  ];
  const lanes = buildProjectLanes(tasks, live(working, waiting), options);
  assert.deepEqual(lanes.map((lane) => lane.project), ["busy", "quiet", ""]);
  const busy = lanes[0];
  assert.equal(busy.current?.title, "high doing");
  assert.equal(busy.attention, 1);
  assert.deepEqual(busy.live, { working: 1, waiting: 1, error: 0 });
  assert.deepEqual(busy.tasks.doing.map((entry) => entry.title), ["high doing", "low doing"]);
  assert.equal(busy.tasks.done.length, 1);
  assert.equal(lanes[1].current?.title, "quiet todo");
  assert.equal(lanes[2].attention, 1, "unassigned lane still counts attention but sorts last");
});

const at = (agentId: string, execution: SessionSnapshot["execution"], cwd: string, activityHours = 0, extra: Partial<SessionSnapshot> = {}): SessionSnapshot =>
  ({ ...session(agentId, execution), cwd, activityAt: hoursAgo(activityHours), ...extra });

test("unlinked sessions are placed by folder, matching an existing project name case-insensitively", () => {
  const tasks = [task({ project: "BUN", status: "todo" })];
  const placed = placeUnlinkedSessions(tasks, live(
    at("run", "working", String.raw`C:\PROJECT\Lumberjack\bun`),
    at("done", "idle", String.raw`C:\PROJECT\imaging`, 2),
    at("ask", "waiting", "/home/k/imaging/"),
    at("bad", "error", String.raw`C:\PROJECT\Proofreading`),
  ), options);
  const byId = new Map(placed.map((entry) => [entry.session.agentId, entry]));
  assert.deepEqual([byId.get("run")?.project, byId.get("run")?.column], ["BUN", "doing"]);
  assert.deepEqual([byId.get("done")?.project, byId.get("done")?.column], ["imaging", "review"]);
  assert.deepEqual([byId.get("ask")?.project, byId.get("ask")?.column], ["imaging", "blocked"]);
  assert.deepEqual([byId.get("bad")?.project, byId.get("bad")?.column], ["Proofreading", "blocked"]);
});

test("auto placement skips linked (including archived-task links), closed and child sessions; old idle ones are dormant", () => {
  const linkedActive = at("linked", "working", "/p/a");
  const linkedArchived = at("archived-link", "waiting", "/p/a");
  const tasks = [task({ sessions: [linkedActive] }), task({ archivedAt: hoursAgo(1), sessions: [linkedArchived] })];
  const placed = placeUnlinkedSessions(tasks, live(
    linkedActive, linkedArchived,
    at("closed", "closed", "/p/a"),
    at("child", "working", "/p/a", 0, { parentAgentId: "linked" }),
    at("old-idle", "idle", "/p/a", 24 * 4),
    at("old-working", "working", "/p/a", 24 * 30),
    at("no-activity-idle", "idle", "/p/a", 0, { activityAt: undefined }),
  ), options);
  assert.deepEqual(placed.map((entry) => `${entry.session.agentId}:${entry.column}`).sort(),
    ["no-activity-idle:review", "old-idle:dormant", "old-working:doing"]);
});

test("a project whose only sessions are dormant still gets a lane, with no cards and no attention", () => {
  const lanes = buildProjectLanes([], live(
    at("old-1", "idle", "/p/Diagnostic_Exam", 24 * 6), at("old-2", "idle", "/p/Diagnostic_Exam", 24 * 5),
  ), options);
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].project, "Diagnostic_Exam");
  assert.deepEqual(lanes[0].dormant.map((entry) => entry.agentId), ["old-2", "old-1"], "newest first");
  assert.deepEqual(lanes[0].sessions, { doing: [], review: [], blocked: [] });
  assert.equal(lanes[0].attention, 0);
  assert.deepEqual(buildFocusQueue([], live(at("old-1", "idle", "/p/Diagnostic_Exam", 24 * 6)), options), []);
});

test("waiting and error unlinked sessions join the focus queue; working and idle ones do not", () => {
  const queue = buildFocusQueue([task({ id: "review", status: "review", updatedAt: hoursAgo(1) })], live(
    at("ask", "waiting", "/p/imaging", 5),
    at("bad", "error", "/p/imaging", 1),
    at("run", "working", "/p/imaging"),
    at("done", "idle", "/p/imaging"),
  ), options);
  assert.deepEqual(queue.map((item) => [item.reason, item.task?.id ?? item.sessions[0].agentId, item.project]), [
    ["waiting", "ask", "imaging"], ["review", "review", "alpha"], ["error", "bad", "imaging"],
  ]);
});

test("a project with only unlinked sessions still gets a lane with attention and live counts", () => {
  const lanes = buildProjectLanes([task({ project: "alpha", status: "todo" })], live(
    at("ask", "waiting", "/p/imaging"), at("run", "working", "/p/imaging"), at("done", "idle", "/p/imaging"),
  ), options);
  const imaging = lanes.find((lane) => lane.project === "imaging");
  assert.ok(imaging);
  assert.equal(lanes[0].project, "imaging", "attention sorts first");
  assert.deepEqual(imaging.sessions.blocked.map((entry) => entry.agentId), ["ask"]);
  assert.deepEqual(imaging.sessions.doing.map((entry) => entry.agentId), ["run"]);
  assert.deepEqual(imaging.sessions.review.map((entry) => entry.agentId), ["done"]);
  assert.equal(imaging.attention, 1);
  assert.deepEqual(imaging.live, { working: 1, waiting: 1, error: 0 });
  assert.equal(imaging.current, null);
});
