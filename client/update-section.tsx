import React, { useEffect, useRef, useState } from "react";
import { Linking, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { applyUpdateRpc, checkUpdateRpc, updateStatusRpc } from "../shared/updates";
import type { UpdateStatus } from "../shared/updates";
import { Banner, Body, Button } from "./components";
import type { Colors } from "./components";
import { dateLabel, errorMessage } from "./presentation";

function commit(value: string | null | undefined): string { return value ? value.slice(0, 7) : "확인 전"; }

const OUTCOME_TEXT: Record<NonNullable<UpdateStatus["check"]>["outcome"], string> = {
  update: "새 버전이 있습니다.",
  current: "최신 버전입니다.",
  "installed-newer": "설치된 커밋이 저장소보다 앞서 있습니다.",
  local: "폴더(ZIP)로 설치되어 있어 GitHub 업데이트를 쓸 수 없습니다. README의 \"GitHub에서 설치\"로 다시 설치하세요.",
  error: "업데이트를 확인하지 못했습니다.",
  unsupported: "이 PC의 Paseo가 플러그인 업데이트 확인을 지원하지 않습니다.",
};

/**
 * This host's Worklog version. Checking runs when the panel opens; applying is
 * central-only and goes through Paseo's own plugin update.
 */
export function UpdateSection({ hostId, central, colors }: { hostId: string; central: boolean; colors: Colors }) {
  const readStatus = useRpc(updateStatusRpc);
  const requestCheck = useRpc(checkUpdateRpc);
  const requestApply = useRpc(applyUpdateRpc);
  const queryClient = useQueryClient();
  const key = ["worklog", hostId, "updates"];
  const query = useQuery({
    queryKey: key, queryFn: () => readStatus({}), retry: 2,
    // While Paseo reloads Worklog the RPC fails; keep polling until the new instance answers.
    refetchInterval: (current) => current.state.data?.pending ? 3_000 : false,
  });
  const [busy, setBusy] = useState<"check" | "apply" | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opened = useRef(false);
  const status = query.data;

  async function check() {
    if (busy) return;
    setBusy("check"); setError(null); setConfirming(null);
    try { queryClient.setQueryData(key, await requestCheck({})); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(null); }
  }
  useEffect(() => {
    if (opened.current || !status || status.pending) return;
    opened.current = true;
    void check();
  }, [status]);

  async function apply(targetRevision: string) {
    if (busy) return;
    setBusy("apply"); setError(null);
    try {
      const result = await requestApply({ targetRevision });
      queryClient.setQueryData(key, result.status);
      setConfirming(null);
      if (!result.ok) setError(result.message);
    } catch (cause) {
      // Paseo may already be reloading Worklog; the persisted status decides.
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: key });
      setError(`업데이트 요청의 응답을 받지 못했습니다. 결과는 아래 상태에 표시됩니다. ${errorMessage(cause)}`);
    } finally { setBusy(null); }
  }

  const check_ = status?.check ?? null;
  const pending = status?.pending ?? null;
  const last = status?.last ?? null;
  const target = check_?.outcome === "update" ? check_.targetRevision : null;
  return <View style={{ gap: 8 }}>
    <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "700" }}>Worklog 업데이트</Text>
    {!status && query.isError ? <Banner colors={colors} danger>업데이트 상태를 읽지 못했습니다. {errorMessage(query.error)}</Banner> : null}
    {status ? <>
      <Body colors={colors} muted style={{ fontSize: 11 }}>
        설치된 커밋 {commit(check_?.currentRevision)}{target ? ` → 최신 ${commit(target)}` : ""}
        {check_ ? ` · 확인 ${dateLabel(check_.checkedAt)}` : ""}{busy === "check" || status.checking ? " · 확인 중…" : ""}
      </Body>
      {check_ && !pending ? <Body colors={colors} style={{ fontSize: 12, color: check_.outcome === "update" ? colors.accent
        : check_.outcome === "current" ? colors.statusSuccess : check_.outcome === "error" || check_.outcome === "unsupported" ? colors.statusDanger : colors.foregroundMuted }}>
        {OUTCOME_TEXT[check_.outcome]}{check_.error ? ` ${check_.error}` : ""}
      </Body> : null}
      {pending ? <Banner colors={colors}>
        {commit(pending.targetRevision)} 커밋으로 업데이트하는 중입니다 · 요청 {dateLabel(pending.requestedAt)}{"\n"}Paseo가 Worklog를 다시 로드합니다. 잠시 연결이 끊겼다가 결과가 이곳에 표시됩니다.
      </Banner> : null}
      {last && !pending ? <Banner colors={colors} danger={last.outcome !== "updated"}>
        {last.outcome === "updated" ? `업데이트 완료: ${commit(last.fromRevision)} → ${commit(last.targetRevision)}` : last.outcome === "failed" ? `업데이트 실패 (${commit(last.targetRevision)})` : `업데이트 결과 알 수 없음 (${commit(last.targetRevision)})`}
        {" · "}{dateLabel(last.at)}{last.message ? `\n${last.message}` : ""}
      </Banner> : null}
      {error ? <Banner colors={colors} danger>{error}</Banner> : null}
      {confirming ? <Banner colors={colors} action={<View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button label={busy === "apply" ? "요청 중…" : "업데이트 실행"} small variant="primary" colors={colors} disabled={!!busy} onPress={() => { void apply(confirming); }} />
        <Button label="취소" small variant="ghost" colors={colors} disabled={!!busy} onPress={() => setConfirming(null)} />
      </View>}>
        {commit(check_?.currentRevision)} → {commit(confirming)} 커밋으로 업데이트합니다. 이 커밋만 설치되며, 확인한 뒤 저장소에 새 커밋이 올라오면 실행하지 않고 다시 확인을 요청합니다. 공개 저장소의 코드가 이 PC에서 샌드박스 없이 실행됩니다. 아래 "바뀐 내용 보기"로 먼저 확인하세요.
      </Banner> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button label={busy === "check" ? "확인 중…" : "업데이트 확인"} small colors={colors} disabled={!!busy || !!pending} onPress={() => { void check(); }} />
        {target && check_?.compareUrl ? <Button label="바뀐 내용 보기" small variant="ghost" colors={colors}
          onPress={() => { void Linking.openURL(check_.compareUrl!).catch(() => setError(`링크를 열지 못했습니다: ${check_.compareUrl}`)); }} /> : null}
        {target && central && !confirming ? <Button label={`업데이트 (${commit(target)})`} small variant="primary" colors={colors} disabled={!!busy || !!pending} onPress={() => setConfirming(target)} /> : null}
      </View>
      {!central ? <Body colors={colors} muted style={{ fontSize: 11 }}>화면에서 하는 업데이트는 중앙 보드에서만 실행할 수 있습니다. 이 PC에서는 버전만 표시합니다. 지금은 이 PC에서 paseo plugin update worklog-board 명령으로 업데이트하세요.</Body> : null}
    </> : !query.isError ? <Body colors={colors} muted style={{ fontSize: 11 }}>업데이트 상태를 읽는 중…</Body> : null}
  </View>;
}
