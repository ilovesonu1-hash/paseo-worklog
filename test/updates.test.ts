import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { PENDING_TIMEOUT_MS, PluginUpdater } from "../server/updates.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const REMOTE = "https://github.com/owner/paseo-worklog";

function entry(outcome: string, current: string, target?: string) {
  return {
    id: "worklog-board", outcome,
    current: { identity: { kind: "git", remote: REMOTE, pluginPath: "." }, currentRevision: current },
    ...(target ? { target: { kind: "git", commit: target } } : {}),
    links: target ? [`${REMOTE}/compare/${current}...${target}`] : [],
    ...(outcome === "update" ? { proposal: { id: "worklog-board", expected: { revision: current }, target: { kind: "git", commit: target } } } : {}),
  };
}

function harness(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "worklog-updates-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fake = {
    preview: async (): Promise<unknown> => [entry("current", A, A)],
    apply: async (_proposals: unknown[]): Promise<unknown> => [{ id: "worklog-board", outcome: "updated" }],
    applied: [] as unknown[][],
  };
  let clock = Date.parse("2026-11-18T12:00:00.000Z");
  const make = () => new PluginUpdater({
    statePath: join(directory, "update-state.json"),
    now: () => new Date(clock),
    local: async () => ({ updates: {
      preview: () => fake.preview(),
      apply: (proposals) => { fake.applied.push(proposals); return fake.apply(proposals); },
    } }),
  });
  return { fake, make, advance: (ms: number) => { clock += ms; } };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("check maps an available update with its compare link", async (t) => {
  const { fake, make } = harness(t);
  fake.preview = async () => [entry("update", A, B)];
  const status = await make().check();
  assert.equal(status.check?.outcome, "update");
  assert.equal(status.check?.currentRevision, A);
  assert.equal(status.check?.targetRevision, B);
  assert.equal(status.check?.compareUrl, `${REMOTE}/compare/${A}...${B}`);
  assert.equal(status.pending, null);
});

test("check distinguishes directory installs and hosts without update support", async (t) => {
  const { fake, make } = harness(t);
  fake.preview = async () => [{ id: "worklog-board", outcome: "local", links: [] }];
  assert.equal((await make().check()).check?.outcome, "local");
  fake.preview = async () => { throw new Error("Update the host to review plugin updates."); };
  const status = await make().check();
  assert.equal(status.check?.outcome, "unsupported");
  assert.match(status.check?.error ?? "", /Paseo를 업데이트/);
});

test("apply refuses a target that changed after the user confirmed", async (t) => {
  const { fake, make } = harness(t);
  fake.preview = async () => [entry("update", A, C)];
  const result = await make().apply(B);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "changed");
  assert.equal(result.status.pending, null);
  assert.equal(fake.applied.length, 0);
});

test("apply passes Paseo's own proposal and records a confirmed response", async (t) => {
  const { fake, make } = harness(t);
  fake.preview = async () => [entry("update", A, B)];
  const updater = make();
  const result = await updater.apply(B);
  assert.equal(result.ok, true);
  assert.equal(result.status.pending?.targetRevision, B);
  await settle(); await settle();
  assert.deepEqual(fake.applied, [[entry("update", A, B).proposal]]);
  const status = updater.status();
  assert.equal(status.pending, null);
  assert.equal(status.last?.outcome, "updated");
  assert.equal(status.last?.fromRevision, A);
});

test("a response lost during reload is confirmed by the next instance", async (t) => {
  const { fake, make } = harness(t);
  fake.preview = async () => [entry("update", A, B)];
  let fail!: (cause: unknown) => void;
  fake.apply = () => new Promise((_resolve, reject) => { fail = reject; });
  const old = make();
  assert.equal((await old.apply(B)).ok, true);
  await settle();
  old.stop();
  fail(new Error("Paseo 연결이 닫혔거나 다시 초기화되었습니다."));
  await settle();
  assert.equal(old.status().pending?.targetRevision, B, "stopping must not settle the intent");

  fake.preview = async () => [entry("current", B, B)];
  const next = make();
  assert.equal(next.status().pending?.targetRevision, B, "intent is persisted");
  await next.reconcile();
  const status = next.status();
  assert.equal(status.pending, null);
  assert.equal(status.last?.outcome, "updated");
  assert.equal(status.check?.currentRevision, B);
});

test("the next instance reports a kept old revision as a failure", async (t) => {
  const { fake, make } = harness(t);
  fake.preview = async () => [entry("update", A, B)];
  fake.apply = () => new Promise(() => {});
  const old = make();
  await old.apply(B);
  old.stop();
  const next = make();
  await next.reconcile();
  assert.equal(next.status().last?.outcome, "failed");
});

test("an error response while running records a failure and frees the updater", async (t) => {
  const { fake, make } = harness(t);
  fake.preview = async () => [entry("update", A, B)];
  fake.apply = async () => [{ id: "worklog-board", outcome: "error", error: "build failed" }];
  const updater = make();
  await updater.apply(B);
  await settle(); await settle();
  const status = updater.status();
  assert.equal(status.pending, null);
  assert.equal(status.last?.outcome, "failed");
  assert.equal(status.last?.message, "build failed");
});

test("a pending intent blocks a second apply and expires to unknown", async (t) => {
  const { fake, make, advance } = harness(t);
  fake.preview = async () => [entry("update", A, B)];
  fake.apply = () => new Promise(() => {});
  const updater = make();
  await updater.apply(B);
  const second = await updater.apply(B);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.code, "busy");
  advance(PENDING_TIMEOUT_MS + 1);
  const status = updater.status();
  assert.equal(status.pending, null);
  assert.equal(status.last?.outcome, "unknown");
});

test("a check failure keeps the last known revision", async (t) => {
  const { fake, make } = harness(t);
  const updater = make();
  await updater.check();
  fake.preview = async () => { throw new Error("timed out"); };
  const status = await updater.check();
  assert.equal(status.check?.outcome, "error");
  assert.equal(status.check?.currentRevision, A);
});
