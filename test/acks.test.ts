import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AckStore } from "../server/acks.ts";

test("acknowledgements persist, replace per session, and prune after 30 days", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worklog-acks-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "focus-acks.json");
  let clock = Date.parse("2026-11-19T00:00:00.000Z");
  const make = () => new AckStore(path, () => new Date(clock));
  const first = make();
  first.ack([{ hostId: "pc-a", agentId: "a1", activityAt: "2026-11-18T10:00:00.000Z" }]);
  first.ack([{ hostId: "pc-a", agentId: "a1", activityAt: "2026-11-18T12:00:00.000Z" }, { hostId: "pc-b", agentId: "b1", activityAt: "2026-11-18T09:00:00.000Z" }]);
  assert.deepEqual(make().read().acks.map((ack) => `${ack.hostId}/${ack.agentId}@${ack.activityAt.slice(11, 13)}`).sort(), ["pc-a/a1@12", "pc-b/b1@09"]);
  clock += 31 * 86_400_000;
  make().ack([{ hostId: "pc-c", agentId: "c1", activityAt: "2026-12-19T00:00:00.000Z" }]);
  assert.deepEqual(make().read().acks.map((ack) => ack.agentId), ["c1"]);
});

test("an unreadable file starts empty instead of failing the plugin", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worklog-acks-bad-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "focus-acks.json");
  writeFileSync(path, "{not json");
  assert.deepEqual(new AckStore(path).read(), { acks: [] });
});
