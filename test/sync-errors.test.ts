import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeStateForError, safeSyncError } from "../server/runtime.ts";
import { PaseoTransportError } from "../server/paseo-transport.ts";

// A remote plugin error as the native client reports it.
const remote = (body: string) => new Error(`Request failed: ${body} requestType=plugin.rpc.invoke.request code=handler_error`);

test("an unclassified exchange failure is an error, not a configuration problem", () => {
  const cause = new Error("socket hang up");
  assert.match(safeSyncError(cause), /설정/, "the generic fallback text mentions 설정");
  assert.equal(bridgeStateForError(cause), "error");
});

test("bridge state comes from stable WORKLOG codes", () => {
  assert.equal(bridgeStateForError(remote("WORKLOG_PAUSED: 수집·보고 호스트의 백그라운드 연결이 일시 정지되어 있습니다.")), "paused");
  for (const code of ["ROLE", "CENTRAL_ID", "BOARD_ID", "IDENTITY_MISMATCH"]) {
    assert.equal(bridgeStateForError(remote(`WORKLOG_${code}: any wording`)), "unconfigured", code);
  }
  assert.equal(bridgeStateForError(new Error("Unknown plugin worklog-board")), "unconfigured");
  assert.equal(bridgeStateForError(new Error("Request timed out")), "error");
});

test("older satellites' wording is still classified by code", () => {
  assert.equal(bridgeStateForError(remote("WORKLOG_PAUSED: 작업 PC 동기화가 일시 정지되어 있습니다.")), "paused");
  assert.equal(bridgeStateForError(remote("WORKLOG_ROLE: 중앙 역할의 플러그인은 작업 PC 교환 요청을 받지 않습니다.")), "unconfigured");
});

test("a local daemon that has not published its host ID is not reported as an identity mismatch", () => {
  const notReady = new PaseoTransportError("LOCAL_DAEMON_NOT_READY", "로컬 Paseo 데몬이 아직 연결 주소와 호스트 ID를 게시하지 않았습니다.");
  assert.match(safeSyncError(notReady), /로컬 연결 자격 증명|실행 정보/);
  const mismatch = new PaseoTransportError("SERVER_ID_MISMATCH", "연결한 Paseo 호스트의 실제 ID가 요청한 호스트와 다릅니다.");
  assert.match(safeSyncError(mismatch), /ID가 등록된 대상과 다릅니다/);
});

test("the transport suffix is not shown to people", () => {
  assert.equal(safeSyncError(remote("WORKLOG_ROLE: 이 호스트는 중앙 역할이라 수집·보고 교환 요청을 받지 않습니다.")),
    "이 호스트는 중앙 역할이라 수집·보고 교환 요청을 받지 않습니다.");
});
