import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { readRosterRpc, refreshRuntimeRpc } from "../shared/sync";
import type { HostHealth } from "../shared/sync";
import type { SessionSnapshot } from "../shared/model";
import { errorMessage } from "./presentation";

export interface SessionRosterResult {
  sessions: SessionSnapshot[];
  hosts: HostHealth[];
  loading: boolean;
  error: string | null;
  notice: string | null;
  refresh: () => void;
}

/** Reads the central daemon's durable inventory. Collection never depends on this screen. */
export function useSessionRoster(hostId: string): SessionRosterResult {
  const readRoster = useRpc(readRosterRpc);
  const scheduleRefresh = useRpc(refreshRuntimeRpc);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["worklog", hostId, "roster"], queryFn: () => readRoster({}),
    refetchInterval: 15_000, retry: 1,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true); setRefreshError(null); setNotice(null);
    void (async () => {
      try {
        const result = await scheduleRefresh({});
        setNotice(result.scheduled ? "백그라운드 수집을 요청했습니다. 완료 여부는 마지막 성공 시각에서 확인할 수 있습니다." : "현재 수집을 시작하지 않았습니다. 연결 설정과 실행 상태를 확인하세요.");
        await queryClient.invalidateQueries({ queryKey: ["worklog", hostId, "roster"] });
        await queryClient.invalidateQueries({ queryKey: ["worklog", hostId, "runtime"] });
      } catch (error) { setRefreshError(errorMessage(error)); }
      finally { inFlight.current = false; setRefreshing(false); }
    })();
  }, [scheduleRefresh, queryClient, hostId]);

  return {
    sessions: query.data?.sessions ?? [],
    hosts: (query.data?.hosts ?? []).map((host) => query.isError && host.status === "online" ? { ...host, status: "stale" as const } : host),
    loading: query.isPending || refreshing,
    error: refreshError ?? (query.isError ? errorMessage(query.error) : null),
    notice, refresh,
  };
}
