import React, { useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { configureRuntimeRpc, dismissDeliveryRpc, refreshRuntimeRpc, runtimeStatusRpc } from "../shared/sync";
import type { ConfigSnapshot, RuntimeStatus, SyncConfig } from "../shared/sync";
import { Banner, Body, Button, Chip, Drawer, Empty, Field, HostHealthList } from "./components";
import type { Colors } from "./components";
import { dateLabel, errorMessage, shortAge } from "./presentation";
import { UpdateSection } from "./update-section";

function copyConfig(config: SyncConfig): SyncConfig { return { ...config, remoteHostIds: [...config.remoteHostIds] }; }
function configEquals(a: SyncConfig, b: SyncConfig): boolean {
  return a.role === b.role && a.enabled === b.enabled && a.pollIntervalSeconds === b.pollIntervalSeconds &&
    a.centralServerId === b.centralServerId && [...a.remoteHostIds].sort().join("\n") === [...b.remoteHostIds].sort().join("\n");
}

export function ConnectionPanel({ runtime, hostId, colors, compact, onClose }: {
  runtime: RuntimeStatus; hostId: string; colors: Colors; compact: boolean; onClose: () => void;
}) {
  const configure = useRpc(configureRuntimeRpc);
  const readRuntime = useRpc(runtimeStatusRpc);
  const requestCycle = useRpc(refreshRuntimeRpc);
  const queryClient = useQueryClient();
  const [baseline, setBaseline] = useState<ConfigSnapshot>(() => runtime.snapshot);
  const [draft, setDraft] = useState<SyncConfig>(() => copyConfig(runtime.snapshot.config));
  const [interval, setIntervalValue] = useState(() => String(runtime.snapshot.config.pollIntervalSeconds));
  const [conflict, setConflict] = useState<ConfigSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [closeIntent, setCloseIntent] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const attempted = useRef<{ expectedRevision: number; config: SyncConfig } | null>(null);
  const inFlight = useRef(false);
  const dirty = !configEquals(draft, baseline.config) || interval !== String(baseline.config.pollIntervalSeconds);
  const runtimeKey = ["worklog", hostId, "runtime"];
  const hosts = [...new Map(runtime.knownHosts.filter((host) => host.serverId !== runtime.self?.serverId)
    .map((host) => [host.serverId ?? `unresolved:${host.registrationId}`, host])).values()];
  const missingSelections = draft.remoteHostIds.filter((id) => !hosts.some((host) => host.serverId === id));
  const currentSnapshot = conflict && conflict.revision > runtime.snapshot.revision ? conflict : runtime.snapshot;

  function reload(snapshot: ConfigSnapshot) {
    setBaseline(snapshot); setDraft(copyConfig(snapshot.config)); setIntervalValue(String(snapshot.config.pollIntervalSeconds));
    setConflict(null); setError(null); setUnknown(false); attempted.current = null; setCloseIntent(false);
  }
  function committed(snapshot: ConfigSnapshot) {
    reload(snapshot); setNotice("연결 설정을 저장했습니다.");
    queryClient.setQueryData<RuntimeStatus>(runtimeKey, (previous) => previous ? { ...previous, snapshot } : previous);
    void queryClient.invalidateQueries({ queryKey: ["worklog", hostId] });
  }
  function close() {
    if (saving || checking) return;
    if (dirty || unknown) { setCloseIntent(true); return; }
    onClose();
  }
  async function save() {
    if (inFlight.current || unknown) return;
    const seconds = Number(interval);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 300) { setError("수집 주기를 5~300초 사이의 정수로 입력하세요."); return; }
    if (draft.role === "satellite" && !draft.centralServerId.trim()) { setError("중앙 서버 ID를 입력하세요. 중앙 Worklog의 연결 상태에서 복사할 수 있습니다."); return; }
    inFlight.current = true; setSaving(true); setError(null); setNotice(null);
    const attempt = { expectedRevision: baseline.revision, config: { ...draft, centralServerId: draft.centralServerId.trim(), pollIntervalSeconds: seconds } };
    attempted.current = attempt;
    try {
      const result = await configure(attempt);
      attempted.current = null;
      if (result.ok) committed(result.snapshot);
      else { setError(result.message); setConflict(result.snapshot); void queryClient.invalidateQueries({ queryKey: runtimeKey }); }
    } catch (cause) {
      setUnknown(true); setError(`저장 응답을 확인하지 못했습니다. 초안을 유지했습니다. 저장 결과를 먼저 확인하세요. ${errorMessage(cause)}`);
    } finally { inFlight.current = false; setSaving(false); }
  }
  async function checkSaved() {
    if (inFlight.current || !attempted.current) return;
    inFlight.current = true; setChecking(true); setError(null);
    try {
      const current = await readRuntime({});
      queryClient.setQueryData(runtimeKey, current);
      const attempt = attempted.current;
      if (attempt && configEquals(current.snapshot.config, attempt.config)) committed(current.snapshot);
      else {
        attempted.current = null; setUnknown(false); setConflict(current.snapshot);
        setError(current.snapshot.revision === baseline.revision ? "변경이 반영되지 않은 것을 확인했습니다. 초안을 다시 저장할 수 있습니다." : "서버의 설정이 변경되었습니다. 현재 설정을 확인한 후 다시 편집하세요.");
      }
    } catch (cause) { setError(`저장 결과를 확인하지 못했습니다. ${errorMessage(cause)}`); }
    finally { inFlight.current = false; setChecking(false); }
  }
  async function refresh() {
    if (inFlight.current || unknown) return;
    inFlight.current = true; setChecking(true); setError(null);
    try {
      if (runtime.snapshot.config.role === "central") {
        const result = await requestCycle({});
        setNotice(result.scheduled ? "백그라운드 수집을 요청했습니다." : "수집을 시작하지 않았습니다. 실행 상태와 설정을 확인하세요.");
      }
      const current = await readRuntime({});
      queryClient.setQueryData(runtimeKey, current);
      void queryClient.invalidateQueries({ queryKey: ["worklog", hostId, "roster"] });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { inFlight.current = false; setChecking(false); }
  }

  return <Drawer title="연결 상태와 설정" subtitle={`설정 r${baseline.revision} · ${runtime.self?.label ?? hostId}`} colors={colors} compact={compact} onClose={close}
    footer={<>
      {closeIntent ? <Banner colors={colors} action={<View style={{ flexDirection: "row", gap: 8 }}>
        <Button label="계속 편집" small colors={colors} onPress={() => setCloseIntent(false)} />
        <Button label="변경 버리고 닫기" small colors={colors} variant="ghost" onPress={onClose} />
      </View>}>저장하지 않은 설정이 있습니다.{unknown ? " 저장 응답은 아직 확인하지 못했습니다." : ""}</Banner> : null}
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Button label={checking ? "확인 중…" : runtime.snapshot.config.role === "central" ? "지금 수집 요청" : "상태 새로고침"} colors={colors} small onPress={() => { void refresh(); }} disabled={checking || saving || unknown} />
        <Button label={unknown ? checking ? "결과 확인 중…" : "저장 결과 확인" : saving ? "저장 중…" : "설정 저장"} colors={colors} variant="primary"
          onPress={() => { void (unknown ? checkSaved() : save()); }} disabled={saving || checking || (!unknown && !dirty)} />
      </View>
    </>}>
    {error ? <Banner colors={colors} danger>{error}</Banner> : null}
    {notice ? <Body colors={colors} style={{ color: colors.statusSuccess, fontSize: 12 }}>{notice}</Body> : null}
    {currentSnapshot.revision !== baseline.revision && !unknown ? <Banner colors={colors}
      action={<Button label="현재 설정으로 다시 열기 · 초안 교체" colors={colors} small onPress={() => reload(currentSnapshot)} />}>
      서버에 다른 설정이 저장되어 있습니다. 현재 역할: {currentSnapshot.config.role === "central" ? "중앙 보드" : "수집·보고 호스트"}, 설정 r{currentSnapshot.revision}. 작성 중인 초안은 유지했습니다.
    </Banner> : null}
    <View style={{ gap: 5 }}>
      <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "700" }}>이 호스트의 서버 ID</Text>
      <Body colors={colors} selectable style={{ fontSize: 11 }}>{runtime.self?.serverId || "아직 확인하지 못했습니다."}</Body>
      <Body colors={colors} muted style={{ fontSize: 11 }}>중앙 PC에서 표시된 ID를 다른 PC의 중앙 서버 ID에 입력하세요.</Body>
    </View>
    <View style={{ gap: 8 }}><Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "700" }}>이 호스트의 역할</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
        <Chip label="중앙 보드" colors={colors} selected={draft.role === "central"} onPress={saving || unknown ? undefined : () => setDraft({ ...draft, role: "central" })} />
        <Chip label="수집·보고 호스트" colors={colors} selected={draft.role === "satellite"} onPress={saving || unknown ? undefined : () => setDraft({ ...draft, role: "satellite" })} />
      </View>
      <Body colors={colors} muted style={{ fontSize: 12 }}>{draft.role === "central" ? "작업 보드를 편집하고 선택한 PC들의 세션과 보고를 백그라운드에서 모읍니다." : "에이전트 보고를 이 호스트에 보관하고, 연결된 중앙 서버가 가져가도록 합니다. 작업 편집은 중앙 Worklog에서 합니다."}</Body>
    </View>
    {draft.role !== baseline.config.role && runtime.localTaskCount > 0 ? <Banner colors={colors}>이 호스트에 작업 {runtime.localTaskCount}개가 있습니다. 역할을 바꿔도 기록은 이곳에 보존되며 다른 PC로 이동하지 않습니다. 중앙 보드 역할에서 다시 편집할 수 있습니다.</Banner> : null}
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <View style={{ flex: 1, gap: 3 }}><Body colors={colors} style={{ fontWeight: "600" }}>백그라운드 연결</Body><Body colors={colors} muted style={{ fontSize: 11 }}>Paseo 데몬이 실행되는 동안 동작합니다.</Body></View>
      <Button label={draft.enabled ? "켜짐" : "꺼짐"} colors={colors} small variant={draft.enabled ? "primary" : "secondary"} onPress={() => setDraft({ ...draft, enabled: !draft.enabled })} disabled={saving || unknown} />
    </View>
    {draft.role === "satellite" ? <Field label="중앙 서버 ID" value={draft.centralServerId} onChange={(value) => setDraft({ ...draft, centralServerId: value })}
      colors={colors} placeholder="중앙 Worklog에 표시된 서버 ID" disabled={saving || unknown} maxLength={256} /> : <View style={{ gap: 9 }}>
      <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "700" }}>수집할 호스트</Text>
      <Body colors={colors} muted style={{ fontSize: 11 }}>이 호스트는 자동으로 포함됩니다. 다른 PC는 중앙 Paseo의 Connected Hosts에 먼저 등록하세요.</Body>
      {hosts.map((host) => {
        const selected = !!host.serverId && draft.remoteHostIds.includes(host.serverId);
        return <Pressable key={host.registrationId} accessibilityRole="checkbox" accessibilityLabel={`수집 호스트 ${host.label}`} accessibilityState={{ checked: selected, disabled: !host.serverId || saving || unknown }}
          disabled={!host.serverId || saving || unknown} onPress={() => {
            if (!host.serverId) return;
            if (!selected && draft.remoteHostIds.length >= 20) { setError("원격 수집 호스트는 최대 20개까지 선택할 수 있습니다."); return; }
            setDraft({ ...draft, remoteHostIds: selected ? draft.remoteHostIds.filter((id) => id !== host.serverId) : [...draft.remoteHostIds, host.serverId] });
          }}
          style={{ padding: 12, borderWidth: 1, borderColor: selected ? colors.accent : colors.border, borderRadius: 8, gap: 5, opacity: host.serverId ? 1 : 0.6 }}>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}><Text style={{ color: selected ? colors.accent : colors.foregroundMuted }}>{selected ? "☑" : "□"}</Text><Body colors={colors} style={{ fontWeight: "600" }}>{host.label}</Body></View>
          <Body colors={colors} muted style={{ fontSize: 10 }}>{host.serverId || "Paseo 호스트 연결 확인 필요"}</Body>
          {host.error ? <Body colors={colors} style={{ fontSize: 10, color: colors.statusDanger }}>{host.error}</Body> : null}
        </Pressable>;
      })}
      {!hosts.length ? <Body colors={colors} muted style={{ fontSize: 12 }}>등록된 원격 호스트가 없습니다. Connected Hosts에서 다른 PC를 연결한 뒤 상태를 새로고침하세요.</Body> : null}
      {missingSelections.map((id) => <View key={id} style={{ padding: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 8, gap: 6 }}>
        <Body colors={colors} muted style={{ fontSize: 11 }}>선택되어 있지만 현재 등록을 찾을 수 없는 호스트</Body><Body colors={colors} selectable style={{ fontSize: 10 }}>{id}</Body>
        <Button label="수집 선택 해제" colors={colors} small disabled={saving || unknown} onPress={() => setDraft({ ...draft, remoteHostIds: draft.remoteHostIds.filter((value) => value !== id) })} />
      </View>)}
    </View>}
    {draft.role === "central" ? <Field label="수집 주기 · 초" value={interval} onChange={setIntervalValue} colors={colors} placeholder="15" disabled={saving || unknown} maxLength={3} /> : null}
    <View style={{ height: 1, backgroundColor: colors.border }} />
    <View style={{ gap: 6 }}><Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "700" }}>현재 실행 상태</Text>
      <Body colors={colors} muted style={{ fontSize: 11 }}>{runtime.running ? "백그라운드 연결 실행 중" : "백그라운드 연결 정지"}{runtime.inFlight ? " · 처리 중" : ""}{runtime.lastCycleAt ? `\n마지막 주기 ${dateLabel(runtime.lastCycleAt)}` : ""}</Body>
      {runtime.error ? <Banner colors={colors} danger>{runtime.error}</Banner> : null}
    </View>
    <HostHealthList hosts={runtime.roster.hosts} colors={colors} showIds />
    <View style={{ height: 1, backgroundColor: colors.border }} />
    <UpdateSection hostId={hostId} central={runtime.snapshot.config.role === "central"} colors={colors} />
    <View style={{ height: 1, backgroundColor: colors.border }} />
    <View style={{ gap: 7 }}><Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "700" }}>PC 연결 순서</Text>
      <Body colors={colors} muted style={{ fontSize: 12 }}>1. 각 PC에 Worklog 플러그인을 설치합니다.{"\n"}2. 작업을 모을 PC를 중앙 보드로 둡니다.{"\n"}3. 다른 PC는 수집·보고 호스트로 바꾸고 중앙 서버 ID를 저장합니다.{"\n"}4. 중앙 Paseo의 Connected Hosts에서 다른 PC를 연결하고, 위 목록에서 수집할 호스트로 선택합니다.</Body>
      <Body colors={colors} muted style={{ fontSize: 11 }}>Paseo의 기존 호스트 연결을 사용합니다. 수집과 보고 처리는 앱 화면을 닫아도 데몬에서 이어집니다.</Body>
    </View>
  </Drawer>;
}

export function SatelliteScreen({ props, runtime, runtimeError, onOpenConnection, onRefresh }: {
  props: PluginScreenProps; runtime: RuntimeStatus; runtimeError: string | null; onOpenConnection: () => void; onRefresh: () => void;
}) {
  const colors = props.theme.colors;
  const dismiss = useRpc(dismissDeliveryRpc);
  const queryClient = useQueryClient();
  const [busyDelivery, setBusyDelivery] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  async function acknowledge(deliveryId: string) {
    if (inFlight.current) return;
    inFlight.current = true; setBusyDelivery(deliveryId); setError(null);
    try {
      const worker = await dismiss({ deliveryId });
      queryClient.setQueryData<RuntimeStatus>(["worklog", props.host.id, "runtime"], (current) => current ? { ...current, worker } : current);
      void queryClient.invalidateQueries({ queryKey: ["worklog", props.host.id, "runtime"] });
    } catch (cause) { setError(errorMessage(cause)); void queryClient.invalidateQueries({ queryKey: ["worklog", props.host.id, "runtime"] }); }
    finally { inFlight.current = false; setBusyDelivery(null); }
  }
  const centralId = runtime.snapshot.config.centralServerId;
  return <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }}>
    <View style={{ padding: 24, gap: 10, borderBottomWidth: 1, borderColor: colors.border }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <View style={{ gap: 4 }}><Text style={{ color: colors.foreground, fontSize: 23, fontWeight: "700" }}>Worklog</Text><Body colors={colors} muted>수집·보고 호스트 · {runtime.self?.label || props.host.label}</Body></View>
        <Button label="연결 상태" colors={colors} onPress={onOpenConnection} />
      </View>
      <Body colors={colors} muted style={{ fontSize: 12 }}>이 PC의 에이전트 보고를 보관합니다. 중앙 서버가 보고를 가져가 작업 기록에 반영합니다.</Body>
    </View>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: props.layout.compact ? 16 : 24, gap: 18, maxWidth: 960, width: "100%" }}>
      {runtimeError || runtime.error ? <Banner colors={colors} danger>{runtimeError || runtime.error}</Banner> : null}
      {error ? <Banner colors={colors} danger>{error}</Banner> : null}
      <Banner colors={colors} action={<Button label="상태 새로고침" small colors={colors} onPress={onRefresh} />}>
        작업 등록과 편집은 중앙 호스트의 Worklog에서 진행하세요.{"\n"}최근 중앙 연결: {runtime.worker.lastSyncAt ? `${shortAge(runtime.worker.lastSyncAt)} · ${dateLabel(runtime.worker.lastSyncAt)}` : "아직 연결되지 않음"}{!runtime.snapshot.config.enabled ? "\n백그라운드 연결이 꺼져 있습니다." : ""}
      </Banner>
      <View style={{ gap: 5 }}><Body colors={colors} muted style={{ fontSize: 11 }}>중앙 서버 ID</Body><Body colors={colors} selectable style={{ fontSize: 11 }}>{centralId || "설정 필요"}</Body></View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 9 }}>
        <Chip label={`전송 대기 ${runtime.worker.queued}`} colors={colors} />
        <Chip label={`전송 완료 ${runtime.worker.applied}`} colors={colors} tone={colors.statusSuccess} />
        <Chip label={`보류 ${runtime.worker.blocked}`} colors={colors} tone={runtime.worker.blocked ? colors.statusWarning : undefined} />
      </View>
      <View style={{ gap: 5 }}><Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "700" }}>최근 보고</Text><Body colors={colors} muted style={{ fontSize: 11 }}>전송 대기는 중앙 반영 전입니다. 전송 완료는 보고가 반영되었다는 뜻이며 작업 완료 상태와는 별개입니다.</Body></View>
      {runtime.worker.deliveries.map((delivery) => <View key={delivery.deliveryId} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.surface1, padding: 15, gap: 9 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
          <Text style={{ color: delivery.state === "applied" ? colors.statusSuccess : delivery.state === "blocked" ? colors.statusWarning : colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{delivery.state === "queued" ? "전송 대기" : delivery.state === "applied" ? "전송 완료 · 중앙 반영됨" : delivery.dismissedAt ? "확인한 보류" : "보류"}</Text>
          <Body colors={colors} muted style={{ fontSize: 10 }}>{dateLabel(delivery.createdAt)}</Body>
        </View>
        <Body colors={colors} style={{ fontWeight: "600" }}>{delivery.report.summary || "요약 없는 보고"}</Body>
        <Body colors={colors} muted selectable style={{ fontSize: 10 }}>작업 {delivery.report.taskId} · 기준 r{delivery.report.expectedRevision}</Body>
        {delivery.report.doneText ? <Body colors={colors} lines={4} style={{ fontSize: 12 }}>한 일: {delivery.report.doneText}</Body> : null}
        {delivery.report.nextAction ? <Body colors={colors} lines={3} style={{ fontSize: 12 }}>다음 행동: {delivery.report.nextAction}</Body> : null}
        {delivery.result && !delivery.result.ok ? <Banner colors={colors} danger>{delivery.result.message}</Banner> : null}
        {delivery.state === "blocked" && !delivery.dismissedAt ? <>
          <Body colors={colors} muted style={{ fontSize: 11 }}>중앙 작업에 반영되지 않았습니다. 내용을 확인한 뒤 필요하면 최신 작업을 기준으로 새 보고를 작성하세요.</Body>
          <Button label={busyDelivery === delivery.deliveryId ? "확인 중…" : "보류 내용 확인함"} colors={colors} small disabled={!!busyDelivery || !!runtimeError} onPress={() => { void acknowledge(delivery.deliveryId); }} />
        </> : null}
        {delivery.dismissedAt ? <Body colors={colors} muted style={{ fontSize: 10 }}>보류 확인 {dateLabel(delivery.dismissedAt)} · 재전송되거나 반영 처리된 것은 아닙니다.</Body> : null}
      </View>)}
      {!runtime.worker.deliveries.length ? <Empty colors={colors} title="아직 보낸 보고가 없습니다" subtitle="연결된 작업에 에이전트가 보고하면 이곳에서 전송 상태를 확인할 수 있습니다." /> : null}
    </ScrollView>
  </View>;
}
