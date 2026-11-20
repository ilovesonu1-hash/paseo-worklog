import React, { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useHosts, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { activitiesRpc, exportRpc, mutateRpc, readBoardRpc } from "../shared/contracts";
import { ackSessionsRpc, readAcksRpc } from "../shared/acks";
import { autoLinkRulesRpc, groupProjectRpc, removeAutoLinkRpc } from "../shared/projects";
import type { ProjectLane } from "../shared/focus";
import { newRequestId, sessionKey, STATUS_LABELS, STATUS_ORDER } from "../shared/model";
import type { BoardSnapshot, Mutation, SessionSnapshot, Task, TaskFields, TaskStatus } from "../shared/model";
import { useSessionRoster } from "./use-session-roster";
import { runtimeStatusRpc } from "../shared/sync";
import type { RuntimeStatus } from "../shared/sync";
import { ConnectionPanel, SatelliteScreen } from "./connection-panel";
import { Banner, Body, BOTTOM_CLEARANCE, Button, Chip, Drawer, Empty, Field, SessionState, StatusPicker, statusColor, Timeline } from "./components";
import type { Colors } from "./components";
import { changedFields, dateLabel, EMPTY_FIELDS, errorMessage, fieldsOf, sessionProject, shortAge, STATUS_HINT } from "./presentation";
import { FocusQueueView, ProjectFlowView } from "./focus-views";
import { buildFocusQueue } from "../shared/focus";

type Section = "focus" | "work" | "inbox" | "history";
/** The 작업 tab shows one task list three ways: per project row, all tasks by status, or archived tasks. */
type WorkView = "projects" | "all" | "archive";
type Editor = { task: Task | null; fields: TaskFields; session?: SessionSnapshot };
type PendingMutation = { input: Mutation; onSuccess?: (task: Task) => void };

function TaskCard({ task, colors, sessions, onOpen }: {
  task: Task; colors: Colors; sessions: Map<string, SessionSnapshot>; onOpen: () => void;
}) {
  const savedSession = task.sessions[0];
  const currentSession = savedSession ? sessions.get(sessionKey(savedSession)) : undefined;
  return <Pressable accessibilityRole="button" accessibilityLabel={`작업 열기: ${task.title}`} onPress={onOpen}
    style={({ pressed }) => ({ borderWidth: 1, borderColor: colors.border, borderRadius: 11, padding: 14, gap: 10,
      backgroundColor: pressed ? colors.surface2 : colors.surface1 })}>
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 6, alignItems: "center" }}>
      <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 10, flex: 1 }}>{task.project || "프로젝트 미지정"}</Text>
      {task.priority !== "normal" ? <Text style={{ color: task.priority === "high" ? colors.statusDanger : colors.foregroundMuted, fontSize: 10, fontWeight: "600" }}>{task.priority === "high" ? "높음" : "낮음"}</Text> : null}
    </View>
    <Text numberOfLines={3} style={{ color: colors.foreground, fontSize: 14, lineHeight: 21, fontWeight: "600" }}>{task.title}</Text>
    {task.summary ? <Body colors={colors} muted lines={3} style={{ fontSize: 12, lineHeight: 19 }}>{task.summary}</Body> : null}
    {task.status === "blocked" && task.blockedReason ? <View style={{ borderLeftWidth: 2, borderColor: colors.statusDanger, paddingLeft: 8 }}><Body colors={colors} lines={2} style={{ fontSize: 11, color: colors.statusDanger }}>{task.blockedReason}</Body></View>
      : task.nextAction && task.status !== "done" ? <View style={{ backgroundColor: colors.surface0, borderRadius: 6, padding: 8, gap: 2 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 9, fontWeight: "600" }}>다음 행동</Text>
        <Body colors={colors} lines={2} style={{ fontSize: 11, lineHeight: 17 }}>{task.nextAction}</Body>
      </View> : task.status === "done" && task.doneText ? <Body colors={colors} muted lines={2} style={{ fontSize: 11, lineHeight: 18 }}>{task.doneText}</Body> : null}
    <View style={{ borderTopWidth: 1, borderColor: colors.border, paddingTop: 9, gap: 5 }}>
      {savedSession ? <SessionState session={currentSession ?? savedSession} live={!!currentSession} colors={colors} /> : <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>직접 기록한 작업</Text>}
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 6 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>{task.sessions.length > 1 ? `연결 세션 ${task.sessions.length}개` : task.evidence ? "결과 근거 기록됨" : ""}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>{shortAge(task.updatedAt)}</Text>
      </View>
    </View>
  </Pressable>;
}

export function WorklogBoardScreen(props: PluginScreenProps) {
  // A screen may be reused when the selected host changes. Keep editor revisions and
  // uncertain mutation receipts inside their original host's component lifetime.
  return <HostRuntimeScreen key={props.host.id} {...props} />;
}

function HostRuntimeScreen(props: PluginScreenProps) {
  const readRuntime = useRpc(runtimeStatusRpc);
  const runtime = useQuery({ queryKey: ["worklog", props.host.id, "runtime"], queryFn: () => readRuntime({}), refetchInterval: 15_000, retry: 1 });
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [width, setWidth] = useState(1200);
  const colors = props.theme.colors;
  if (!runtime.data) return <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
    <Empty colors={colors} title={runtime.isError ? "Worklog 연결 상태를 확인하지 못했습니다" : "Worklog 연결 확인 중…"}
      subtitle={runtime.isError ? errorMessage(runtime.error) : "이 호스트의 역할과 저장된 기록을 확인합니다."}
      action={runtime.isError ? <Button label="다시 연결" colors={colors} onPress={() => { void runtime.refetch(); }} /> : undefined} />
  </View>;
  const runtimeError = runtime.isError ? errorMessage(runtime.error) : null;
  return <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
    {runtime.data.snapshot.config.role === "satellite"
      ? <SatelliteScreen props={props} runtime={runtime.data} runtimeError={runtimeError} onOpenConnection={() => setConnectionOpen(true)} onRefresh={() => { void runtime.refetch(); }} />
      : <HostWorklogBoard {...props} runtime={runtime.data} runtimeError={runtimeError} onOpenConnection={() => setConnectionOpen(true)} />}
    {connectionOpen ? <ConnectionPanel runtime={runtime.data} hostId={props.host.id} colors={colors} compact={props.layout.compact || width < 700} onClose={() => setConnectionOpen(false)} /> : null}
  </View>;
}

function HostWorklogBoard(props: PluginScreenProps & { runtime: RuntimeStatus; runtimeError: string | null; onOpenConnection: () => void }) {
  const colors = props.theme.colors;
  const readBoard = useRpc(readBoardRpc);
  const mutate = useRpc(mutateRpc);
  const listActivities = useRpc(activitiesRpc);
  const exportBoard = useRpc(exportRpc);
  const queryClient = useQueryClient();
  const roster = useSessionRoster(props.host.id);
  const appHosts = useHosts();
  const appHostIds = new Set(appHosts.filter((host) => host.status === "online").map((host) => host.serverId));
  const canOpenSession = (session: SessionSnapshot) => !!props.navigation && (session.hostId === props.runtime.self?.serverId || appHostIds.has(session.hostId));
  const openSession = (session: SessionSnapshot) => {
    if (canOpenSession(session)) props.navigation?.openAgent({ agentId: session.agentId, serverId: session.hostId === props.runtime.self?.serverId ? props.host.id : session.hostId });
  };
  const queryKey = ["worklog", props.host.id, "board"];
  const board = useQuery({ queryKey, queryFn: () => readBoard({}), refetchInterval: 15_000, retry: 1 });
  const [section, setSection] = useState<Section>("focus");
  const [workView, setWorkView] = useState<WorkView>("projects");
  const [search, setSearch] = useState("");
  const [project, setProject] = useState<string | null>(null);
  const [compactStatus, setCompactStatus] = useState<TaskStatus>("todo");
  const [viewportWidth, setViewportWidth] = useState(1200);
  const compact = props.layout.compact || viewportWidth < 700;
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorSection, setEditorSection] = useState<"details" | "sessions" | "activity">("details");
  const [note, setNote] = useState("");
  const [closeIntent, setCloseIntent] = useState(false);
  const [linkingSession, setLinkingSession] = useState<SessionSnapshot | null>(null);
  const [linkSearch, setLinkSearch] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [exported, setExported] = useState<{ path: string; text: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [showExportText, setShowExportText] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const pending = useRef<PendingMutation | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Task | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const tasks = board.data?.tasks ?? [];
  const activeTasks = tasks.filter((task) => !task.archivedAt);
  const archived = tasks.filter((task) => !!task.archivedAt);
  const taskTitles = useMemo(() => new Map(tasks.map((task) => [task.id, task.title])), [tasks]);
  // "online" means this cycle's session list was read. A report-link error (host.error) does not make the sessions stale.
  const onlineHosts = useMemo(() => new Set(roster.hosts.filter((host) => host.status === "online").map((host) => host.hostId)), [roster.hosts]);
  const liveSessions = useMemo(() => new Map(roster.sessions.filter((session) => onlineHosts.has(session.hostId)).map((session) => [sessionKey(session), session])), [roster.sessions, onlineHosts]);
  const linkedKeys = new Set(tasks.flatMap((task) => task.sessions.map(sessionKey)));
  const inbox = roster.sessions.filter((session) => !session.parentAgentId && !linkedKeys.has(sessionKey(session)));
  const projects = [...new Set(tasks.map((task) => task.project).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const matches = (task: Task) => (project === null || task.project === project) &&
    `${task.title}\n${task.project}\n${task.summary}\n${task.nextAction}\n${task.description}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const visibleTasks = activeTasks.filter(matches).sort((a, b) => {
    const priorities = { high: 0, normal: 1, low: 2 };
    return priorities[a.priority] - priorities[b.priority] || b.updatedAt.localeCompare(a.updatedAt);
  });
  const editorDirty = !!editor && Object.keys(changedFields(editor.task ? fieldsOf(editor.task) : EMPTY_FIELDS, editor.fields)).length > 0;
  const editorLatest = editor?.task ? tasks.find((task) => task.id === editor.task?.id) : undefined;
  const writesDisabled = busy || uncertain || board.isError || !board.data || !!props.runtimeError;
  // All tasks, archived included: archived tasks keep their session links, so
  // those sessions must not be auto-placed. The views skip archived tasks themselves.
  const readAcks = useRpc(readAcksRpc);
  const ackSessions = useRpc(ackSessionsRpc);
  const acksKey = ["worklog", props.host.id, "acks"];
  const acksQuery = useQuery({ queryKey: acksKey, queryFn: () => readAcks({}), refetchInterval: 15_000, retry: 1 });
  const readRules = useRpc(autoLinkRulesRpc);
  const groupProject = useRpc(groupProjectRpc);
  const removeRule = useRpc(removeAutoLinkRpc);
  const rulesKey = ["worklog", props.host.id, "autolink"];
  const rulesQuery = useQuery({ queryKey: rulesKey, queryFn: () => readRules({}), refetchInterval: 30_000, retry: 1 });
  const [grouping, setGrouping] = useState<{ lane: ProjectLane; target: Task | null; sessions: SessionSnapshot[]; autoLink: boolean } | null>(null);
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  async function runGroup() {
    if (!grouping || groupBusy) return;
    setGroupBusy(true); setGroupError(null);
    try {
      const result = await groupProject({ requestId: newRequestId(), folder: grouping.lane.project, taskId: grouping.target?.id,
        sessions: grouping.sessions, autoLink: grouping.autoLink });
      setGrouping(null);
      setNotice(`세션 ${result.linked}개를 "${result.task.title}"에 연결했습니다.${result.rule ? ` 앞으로 ${result.rule.label} 폴더의 새 세션도 자동으로 연결합니다.` : ""}`);
      void board.refetch(); void queryClient.invalidateQueries({ queryKey: rulesKey });
    } catch (error) { setGroupError(errorMessage(error)); }
    finally { setGroupBusy(false); }
  }
  async function stopAutoLink(folder: string) {
    try { queryClient.setQueryData(rulesKey, await removeRule({ folder })); setNotice(`${folder} 폴더의 자동 연결을 껐습니다.`); }
    catch (error) { setActionError(errorMessage(error)); }
  }
  const acknowledged = useMemo(() => new Map((acksQuery.data?.acks ?? []).map((ack) => [sessionKey(ack), ack.activityAt])), [acksQuery.data]);
  const [acking, setAcking] = useState(false);
  async function acknowledge(sessions: SessionSnapshot[]) {
    const entries = sessions.filter((session) => !!session.activityAt)
      .map((session) => ({ hostId: session.hostId, agentId: session.agentId, activityAt: session.activityAt! }));
    if (!entries.length || acking) return;
    setAcking(true); setActionError(null);
    try {
      for (let index = 0; index < entries.length; index += 500) queryClient.setQueryData(acksKey, await ackSessions({ sessions: entries.slice(index, index + 500) }));
    } catch (error) { setActionError(`확인 표시를 저장하지 못했습니다. ${errorMessage(error)}`); }
    finally { setAcking(false); }
  }
  const focusCount = buildFocusQueue(tasks, liveSessions, { acknowledged }).length;
  // One line for the 새 세션 tab; the per-PC list lives in the connection panel.
  const collectedHosts = roster.hosts.filter((host) => host.status !== "disabled");
  const hostProblems = collectedHosts.filter((host) => host.status === "offline" || host.status === "error" || host.status === "stale").length;
  const lastCollected = collectedHosts.map((host) => host.lastSuccessAt).filter((value): value is string => !!value).sort().at(-1);
  const collectionSummary = !props.runtime.snapshot.config.enabled ? "백그라운드 연결이 꺼져 있습니다. 마지막 관측을 표시합니다."
    : `PC ${collectedHosts.length}대에서 수집${lastCollected ? ` · 마지막 수집 ${shortAge(lastCollected)}` : ""}${hostProblems ? ` · 연결 확인 필요 ${hostProblems}대` : ""}`;
  const focusProps = {
    tasks, liveSessions, inboxCount: inbox.length, colors, compact,
    onOpenTask: openTask, canOpenSession, openSession, hasNavigation: !!props.navigation, writesDisabled,
    onRegisterSession: (session: SessionSnapshot) => newTask("todo", session),
    onShowProject: (name: string) => { setProject(name); setSearch(""); setSection("work"); setWorkView("all"); },
    onOpenInbox: () => setSection("inbox"),
    acknowledged, acking, onAcknowledge: (sessions: SessionSnapshot[]) => { void acknowledge(sessions); },
    onGroupProject: (lane: ProjectLane, target: Task | null, sessions: SessionSnapshot[]) => { setGroupError(null); setGrouping({ lane, target, sessions, autoLink: true }); },
  };
  const activityTaskId = editor?.task?.id;
  const activityQuery = useQuery({
    queryKey: ["worklog", props.host.id, "activities", activityTaskId ?? "all"],
    queryFn: () => listActivities({ taskId: activityTaskId, limit: activityTaskId ? 50 : 100 }),
    enabled: !!activityTaskId || section === "history", refetchInterval: 15_000, retry: 1,
  });

  const refresh = () => {
    void board.refetch();
    void queryClient.invalidateQueries({ queryKey: ["worklog", props.host.id, "activities"] });
    roster.refresh();
  };

  async function perform(request: PendingMutation) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setActionError(null); setNotice(null);
    try {
      const result = await mutate(request.input);
      pending.current = null; setUncertain(false);
      if (!result.ok) {
        setActionError(result.message);
        setConflict(result.current ?? null);
        void board.refetch();
        return;
      }
      setConflict(null);
      queryClient.setQueryData<BoardSnapshot>(queryKey, (previous) => previous ? {
        ...previous, tasks: previous.tasks.some((task) => task.id === result.task.id)
          ? previous.tasks.map((task) => task.id === result.task.id ? result.task : task)
          : [...previous.tasks, result.task],
      } : previous);
      request.onSuccess?.(result.task);
      setNotice(result.replayed ? "기존 요청이 정상 반영된 것을 확인했습니다." : "저장했습니다.");
      void queryClient.invalidateQueries({ queryKey: ["worklog", props.host.id] });
    } catch (error) {
      pending.current = request;
      setUncertain(true);
      setActionError(`서버 응답을 받지 못했습니다. 입력한 내용은 유지됩니다. "결과 다시 확인"을 누르면 같은 변경을 두 번 반영하지 않고 결과만 다시 확인합니다. ${errorMessage(error)}`);
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }

  function send(input: Mutation, onSuccess?: (task: Task) => void) {
    if (writesDisabled || busyRef.current) return;
    void perform({ input, onSuccess });
  }

  function retryPending() {
    if (pending.current) void perform(pending.current);
  }

  function openTask(task: Task) {
    if (uncertain || busyRef.current) return;
    setEditor({ task, fields: fieldsOf(task) }); setEditorSection("details");
    setNote(""); setConflict(null); setActionError(null); setCloseIntent(false);
  }

  function newTask(status: TaskStatus = "todo", session?: SessionSnapshot) {
    if (writesDisabled) return;
    setEditor({ task: null, fields: { ...EMPTY_FIELDS, status, project: project ?? (session ? sessionProject(session) : ""), title: session?.title.slice(0, 200) ?? "" }, session });
    setEditorSection("details"); setNote(""); setConflict(null); setActionError(null); setCloseIntent(false);
  }

  function closeEditor() {
    if (busy || uncertain) return;
    if (editorDirty || note.trim()) { setCloseIntent(true); return; }
    setEditor(null); setCloseIntent(false); setConflict(null); setActionError(null);
  }

  function updateField<K extends keyof TaskFields>(key: K, value: TaskFields[K]) {
    setEditor((current) => current ? { ...current, fields: { ...current.fields, [key]: value } } : current);
  }

  function acceptTask(task: Task) {
    setEditor((current) => current && current.task?.id === task.id ? { ...current, task, fields: fieldsOf(task) } : current);
    setConflict(null); setActionError(null); setCloseIntent(false);
  }

  function saveEditor() {
    if (!editor || writesDisabled) return;
    if (!editor.fields.title.trim()) { setActionError("작업 제목을 입력하세요."); return; }
    const fields = { ...editor.fields, title: editor.fields.title.trim(), project: editor.fields.project.trim() };
    if (editor.task) {
      const patch = changedFields(fieldsOf(editor.task), fields);
      if (!Object.keys(patch).length) return;
      send({ op: "update", requestId: newRequestId(), taskId: editor.task.id, expectedRevision: editor.task.revision, patch }, acceptTask);
    } else {
      send({ op: "create", requestId: newRequestId(), fields, session: editor.session }, (task) => {
        setEditor({ task, fields: fieldsOf(task) }); setSection("work"); setWorkView("all"); setCompactStatus(task.status);
      });
    }
  }

  function linkSession(session: SessionSnapshot, task: Task) {
    send({ op: "link", requestId: newRequestId(), taskId: task.id, expectedRevision: task.revision, session }, (updated) => {
      setLinkingSession(null);
      if (editor?.task?.id === task.id) acceptTask(updated);
    });
  }

  async function runExport(format: "json" | "markdown") {
    setExporting(true); setExportError(null);
    try { setExported(await exportBoard({ format })); setShowExportText(false); }
    catch (error) { setExportError(errorMessage(error)); }
    finally { setExporting(false); }
  }

  const actionBanner = actionError ? <Banner danger colors={colors}
    action={uncertain ? <Button label={busy ? "결과 확인 중…" : "결과 다시 확인"} onPress={retryPending} colors={colors} disabled={busy} small /> : undefined}>{actionError}</Banner> : null;

  return <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }} onLayout={(event) => setViewportWidth(event.nativeEvent.layout.width)}>
    <View style={{ paddingHorizontal: compact ? 16 : 24, paddingTop: 21, paddingBottom: 16, gap: 17, borderBottomWidth: 1, borderColor: colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <View style={{ gap: 4, flex: 1, minWidth: 180 }}>
          <View style={{ flexDirection: "row", gap: 9, alignItems: "center" }}>
            <View style={{ width: 25, height: 25, backgroundColor: colors.accent, borderRadius: 7, alignItems: "center", justifyContent: "center" }}><Text style={{ color: colors.accentForeground, fontSize: 17, fontWeight: "700" }}>≡</Text></View>
            <Text style={{ color: colors.foreground, fontSize: 23, fontWeight: "700", letterSpacing: -0.7 }}>Worklog</Text>
            <Text style={{ color: colors.foregroundMuted, fontSize: 10, marginTop: 5 }}>개인 작업 기록</Text>
          </View>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>한 일은 남기고, 다음 일은 분명하게.</Text>
        </View>
        <View style={{ flexDirection: "row", gap: 7, alignItems: "center" }}>
          <Button label="연결 상태" colors={colors} small variant="ghost" onPress={props.onOpenConnection} />
          {!compact ? <Button label="내보내기" colors={colors} onPress={() => setExportOpen(true)} disabled={!board.data} /> : null}
          <Button label="＋ 새 작업" colors={colors} variant="primary" onPress={() => newTask()} disabled={writesDisabled} />
        </View>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 5, alignItems: "center" }} style={{ flexGrow: 0, flexShrink: 1 }}>
          {([
            ["focus", "확인 필요", focusCount], ["work", "작업", activeTasks.length],
            ["inbox", "새 세션", inbox.length], ["history", "기록", null],
          ] as const).map(([key, label, count]) => <Pressable key={key} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: section === key }}
            onPress={() => setSection(key)} style={{ flexDirection: "row", gap: 7, alignItems: "center", paddingHorizontal: 11, paddingVertical: 8,
              backgroundColor: section === key ? colors.surface2 : "transparent", borderRadius: 8 }}>
            <Text style={{ color: section === key ? colors.foreground : colors.foregroundMuted, fontWeight: section === key ? "700" : "500", fontSize: 12 }}>{label}</Text>
            {count !== null ? <Text style={{ color: section === key ? colors.accent : colors.foregroundMuted, fontSize: 10, fontWeight: "600" }}>{count}</Text> : null}
          </Pressable>)}
        </ScrollView>
        {!compact ? <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>중앙 보드 · {props.runtime.self?.label || props.host.label}</Text> : null}
      </View>
    </View>

    {actionError && !editor && !linkingSession ? <View style={{ paddingHorizontal: compact ? 16 : 24, paddingTop: 12 }}>{actionBanner}</View> : null}
    {props.runtimeError ? <View style={{ padding: 16 }}><Banner colors={colors} danger action={<Button label="연결 상태 확인" colors={colors} small onPress={props.onOpenConnection} />}>호스트 역할과 연결 상태를 확인하지 못해 작업 추가와 변경을 잠시 멈췄습니다. {props.runtimeError}</Banner></View> : null}
    {notice && !actionError && !editor ? <View style={{ paddingHorizontal: compact ? 16 : 24, paddingTop: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <Text style={{ color: colors.statusSuccess, fontSize: 11 }}>{notice}</Text><Button label="닫기" colors={colors} small variant="ghost" onPress={() => setNotice(null)} /></View> : null}
    {board.isError ? <View style={{ padding: 16 }}><Banner danger colors={colors} action={<Button small label="다시 불러오기" colors={colors} onPress={() => { void board.refetch(); }} />}>작업 기록을 불러오지 못했습니다. {errorMessage(board.error)}{board.data ? " 마지막으로 받은 내용이 표시됩니다." : ""}</Banner></View> : null}

    {section === "work" && board.data ? <View style={{ paddingHorizontal: compact ? 16 : 24, paddingTop: 13, paddingBottom: workView === "projects" ? 0 : 13, gap: 10 }}>
      <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 11, marginRight: 2 }}>보기</Text>
        {([["projects", "프로젝트별"], ["all", "전체"], ["archive", `보관함 ${archived.length}`]] as const).map(([key, label]) =>
          <Chip key={key} label={label} colors={colors} selected={workView === key} onPress={() => setWorkView(key)} />)}
      </View>
      {workView !== "projects" ? <><View style={{ flexDirection: "row", gap: 9, alignItems: "center" }}>
        <TextInput accessibilityLabel="작업 검색" value={search} onChangeText={setSearch} placeholder="작업, 프로젝트, 다음 행동 검색…"
          placeholderTextColor={colors.foregroundMuted} style={{ color: colors.foreground, borderWidth: 1, borderColor: colors.border,
            backgroundColor: colors.surface1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, fontSize: 12, flex: 1, maxWidth: 400 }} />
        <Button small label={board.isFetching ? "새로고침 중…" : "새로고침"} colors={colors} variant="ghost" onPress={refresh} disabled={board.isFetching} />
        {compact ? <Button small label="내보내기" colors={colors} variant="ghost" onPress={() => setExportOpen(true)} /> : null}
      </View>
      {projects.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        <Chip label="모든 프로젝트" colors={colors} selected={project === null} onPress={() => setProject(null)} />
        {projects.map((name) => <Chip key={name} label={name} colors={colors} selected={project === name} onPress={() => setProject(name)} />)}
        {tasks.some((task) => !task.project) ? <Chip label="미지정" colors={colors} selected={project === ""} onPress={() => setProject("")} /> : null}
      </ScrollView> : null}</> : null}
    </View> : null}

    {!board.data && board.isPending ? <Empty colors={colors} title="작업 기록을 불러오는 중…" subtitle="이 호스트에 저장한 작업을 불러옵니다." /> : null}

    {section === "focus" && board.data ? <FocusQueueView {...focusProps} /> : null}
    {section === "work" && workView === "projects" && board.data ? <ProjectFlowView {...focusProps} viewportWidth={viewportWidth} /> : null}

    {section === "work" && workView === "all" && board.data ? <View style={{ flex: 1, minHeight: 0 }}>
      {compact ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12, gap: 6 }}>
        {STATUS_ORDER.map((status) => <Chip key={status} label={`${STATUS_LABELS[status]} ${visibleTasks.filter((task) => task.status === status).length}`} colors={colors}
          tone={compactStatus === status ? statusColor(status, colors) : undefined} selected={compactStatus === status} onPress={() => setCompactStatus(status)} />)}
      </ScrollView> : null}
      <ScrollView horizontal={!compact} showsHorizontalScrollIndicator={!compact} style={{ flex: 1 }}
        contentContainerStyle={compact ? { paddingHorizontal: 16, paddingBottom: 20 + BOTTOM_CLEARANCE } : { paddingHorizontal: 24, paddingBottom: 20, gap: 12, flexGrow: 1 }}>
        {(compact ? [compactStatus] : STATUS_ORDER).map((status) => {
          const columnTasks = visibleTasks.filter((task) => task.status === status);
          return <View key={status} style={{ width: compact ? "100%" : Math.max(226, (viewportWidth - 96) / 5),
            backgroundColor: colors.surface0, borderTopWidth: 2, borderColor: statusColor(status, colors), borderRadius: 9 }}>
            <View style={{ paddingTop: 13, paddingBottom: 12, paddingHorizontal: 4, gap: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                  <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "700" }}>{STATUS_LABELS[status]}</Text>
                  <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{columnTasks.length}</Text>
                </View>
                <Button label="＋" accessibilityLabel={`${STATUS_LABELS[status]}에 작업 추가`} colors={colors} small variant="ghost" onPress={() => newTask(status)} disabled={writesDisabled} />
              </View>
              <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>{STATUS_HINT[status]}</Text>
            </View>
            <ScrollView style={compact ? undefined : { flex: 1 }} contentContainerStyle={{ gap: 10, paddingBottom: 12 }}>
              {columnTasks.map((task) => <TaskCard key={task.id} task={task} colors={colors} sessions={liveSessions} onOpen={() => openTask(task)} />)}
              {!columnTasks.length ? <View style={{ borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, borderRadius: 10, padding: 20, minHeight: 100, gap: 7, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{search || project !== null ? "일치하는 작업이 없습니다" : "아직 작업이 없습니다"}</Text>
                {status === "todo" && !search ? <Button label="첫 작업 적기" colors={colors} small variant="ghost" onPress={() => newTask(status)} disabled={writesDisabled} /> : null}
              </View> : null}
            </ScrollView>
          </View>;
        })}
      </ScrollView>
      {!activeTasks.length ? <View style={{ paddingHorizontal: 24, paddingBottom: 14 }}><Body colors={colors} muted style={{ fontSize: 11 }}>새 작업을 직접 적거나, "새 세션"에서 진행 중인 세션을 작업에 연결하세요.</Body></View> : null}
    </View> : null}

    {section === "inbox" ? <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: compact ? 16 : 24, paddingBottom: compact ? 16 + BOTTOM_CLEARANCE : 24, gap: 18, flexGrow: 1 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, gap: 4 }}><Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "700" }}>새 세션 {inbox.length}</Text>
          <Body colors={colors} muted style={{ fontSize: 12 }}>아직 어느 작업에도 연결하지 않은 세션입니다. 남길 세션만 작업으로 등록하거나 기존 작업에 연결하세요.</Body></View>
        <Button label={roster.loading ? "요청 중…" : "수집 요청"} colors={colors} small onPress={roster.refresh} disabled={roster.loading} />
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <Body colors={colors} muted style={{ fontSize: 11, flexShrink: 1 }}>{collectionSummary}</Body>
        <Button label="연결 상태" colors={colors} small variant="ghost" onPress={props.onOpenConnection} />
      </View>
      {roster.notice ? <Body colors={colors} muted style={{ fontSize: 11 }}>{roster.notice}</Body> : null}
      {roster.error ? <Banner colors={colors} danger>{roster.error}</Banner> : null}
      {inbox.map((session) => <View key={sessionKey(session)} style={{ borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, borderRadius: 11, padding: 16, gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <View style={{ flex: 1, gap: 5 }}><Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }} numberOfLines={2}>{session.title || "제목 없는 세션"}</Text>
            <SessionState session={session} colors={colors} live={onlineHosts.has(session.hostId)} />
            <Body colors={colors} muted lines={1} style={{ fontSize: 11 }}>{session.provider} · {session.cwd}</Body></View>
          {props.navigation ? <Button label={canOpenSession(session) ? "대화 열기" : "앱에 호스트 연결 필요"} colors={colors} variant="ghost" small disabled={!canOpenSession(session)} onPress={() => openSession(session)} /> : null}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
          <Button label="작업으로 등록" colors={colors} small onPress={() => newTask("todo", session)} disabled={writesDisabled} />
          <Button label="기존 작업에 연결" colors={colors} small variant="ghost" onPress={() => { setLinkingSession(session); setLinkSearch(""); setActionError(null); }} disabled={writesDisabled || !activeTasks.length} />
        </View>
      </View>)}
      {!inbox.length && !roster.loading ? <Empty colors={colors} title="새로 연결할 세션이 없습니다" subtitle="새 세션이 나타나면 이곳에서 확인할 수 있습니다. 이미 연결한 세션은 각 작업에서 볼 수 있습니다." /> : null}
      <Body colors={colors} muted style={{ fontSize: 11 }}>실행 상태는 대화의 현재 상태입니다. 세션이 멈추거나 끝나도 작업을 자동으로 완료하지 않습니다.</Body>
    </ScrollView> : null}

    {section === "history" && board.data ? <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: compact ? 16 : 24, paddingBottom: compact ? 16 + BOTTOM_CLEARANCE : 24, gap: 20, maxWidth: 850, width: "100%" }}>
      <View style={{ gap: 4 }}><Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "700" }}>최근 활동</Text><Body colors={colors} muted style={{ fontSize: 12 }}>수정, 상태 변경, 보고와 메모를 시간순으로 남깁니다.</Body></View>
      {activityQuery.isError ? <Banner colors={colors} danger>{errorMessage(activityQuery.error)}</Banner> : null}
      <Timeline items={activityQuery.data?.activities ?? board.data.activities} colors={colors} titles={taskTitles} />
      {!(activityQuery.data?.activities ?? board.data.activities).length ? <Empty colors={colors} title="아직 남긴 기록이 없습니다" subtitle="작업을 만들고 내용을 바꾸면 활동 기록이 쌓입니다." /> : null}
      {activityQuery.data?.hasMore ? <Body colors={colors} muted style={{ fontSize: 11 }}>최근 100개 기록을 표시합니다. 전체 기록은 JSON 내보내기로 보관할 수 있습니다.</Body> : null}
    </ScrollView> : null}

    {section === "work" && workView === "archive" && board.data ? <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: compact ? 16 : 24, paddingBottom: 24 + (compact ? BOTTOM_CLEARANCE : 0), gap: 10, flexGrow: 1 }}>
      <Body colors={colors} muted style={{ fontSize: 12, marginBottom: 5 }}>보관한 작업은 기록과 연결을 유지합니다. 복원하면 작업 목록으로 돌아옵니다.</Body>
      {archived.filter(matches).map((task) => <View key={task.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 16, borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.surface1 }}>
        <Pressable onPress={() => openTask(task)} accessibilityRole="button" style={{ flex: 1, gap: 5 }}>
          <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>{task.title}</Text>
          <Body colors={colors} muted style={{ fontSize: 11 }}>{task.project || "프로젝트 미지정"} · {STATUS_LABELS[task.status]} · {dateLabel(task.archivedAt ?? task.updatedAt)} 보관</Body>
        </Pressable>
        <Button label="복원" colors={colors} small disabled={writesDisabled} onPress={() => send({ op: "restore", requestId: newRequestId(), taskId: task.id, expectedRevision: task.revision })} />
      </View>)}
      {!archived.filter(matches).length ? <Empty colors={colors} title="보관한 작업이 없습니다" subtitle="정리한 작업은 삭제하는 대신 보관할 수 있습니다." /> : null}
    </ScrollView> : null}

    {editor ? <Drawer title={editor.task ? "작업 상세" : "새 작업"} subtitle={editor.task ? `수정 ${dateLabel(editor.task.updatedAt)} · r${editor.task.revision}` : "작은 단위로 적고, 결과와 다음 행동을 이어가세요."}
      colors={colors} compact={compact} onClose={closeEditor}
      footer={<>
        {closeIntent ? <Banner colors={colors} action={<View style={{ flexDirection: "row", gap: 8 }}>
          <Button small label="계속 편집" colors={colors} onPress={() => setCloseIntent(false)} />
          <Button small label="저장하지 않고 닫기" colors={colors} variant="danger" onPress={() => { setEditor(null); setCloseIntent(false); setActionError(null); setConflict(null); }} />
        </View>}>저장하지 않은 내용이 있습니다.</Banner> : null}
        {uncertain ? <Button label={busy ? "결과 확인 중…" : "결과 다시 확인"} colors={colors} onPress={retryPending} disabled={busy} /> : null}
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          {editor.task ? <Button label={editor.task.archivedAt ? "보드로 복원" : "보관"} colors={colors} small variant="ghost" disabled={writesDisabled || editorDirty}
            onPress={() => { const task = editor.task; if (task) send({ op: task.archivedAt ? "restore" : "archive", requestId: newRequestId(), taskId: task.id, expectedRevision: task.revision }, (updated) => { acceptTask(updated); setSection("work"); setWorkView(updated.archivedAt ? "archive" : "all"); }); }} />
            : <Body colors={colors} muted style={{ fontSize: 11 }}>제목만으로도 시작할 수 있습니다.</Body>}
          <Button label={busy ? "저장 중…" : editor.task ? "변경 저장" : "작업 만들기"} colors={colors} variant="primary" onPress={saveEditor} disabled={writesDisabled || (!!editor.task && !editorDirty)} />
        </View>
      </>}>
      {actionBanner}
      {conflict && conflict.id === editor.task?.id ? <Banner danger colors={colors}
        action={<Button label="서버 내용으로 교체" colors={colors} small onPress={() => { acceptTask(conflict); setNote(""); }} />}>
        다른 곳에서 이 작업이 먼저 수정되었습니다. 현재 서버 기록: {conflict.title} / {STATUS_LABELS[conflict.status]} / r{conflict.revision}{"\n"}{conflict.summary || "요약 없음"}{conflict.nextAction ? `\n다음 행동: ${conflict.nextAction}` : ""}
      </Banner> : null}
      {!conflict && editorLatest && editorLatest.revision !== editor.task?.revision ? <Banner colors={colors}
        action={!editorDirty ? <Button label="최신 내용 불러오기" colors={colors} small onPress={() => acceptTask(editorLatest)} /> : undefined}>
        이 작업에 새 변경이 있습니다. 입력한 초안은 그대로 유지됩니다.{editorDirty ? " 저장할 때 충돌 여부를 확인합니다." : " 최신 내용을 불러온 후 편집하세요."}
      </Banner> : null}
      {editor.task?.archivedAt ? <Banner colors={colors}>보관 중인 작업입니다. 기록을 확인하거나 보드로 복원할 수 있습니다.</Banner> : null}
      {editor.task ? <View style={{ flexDirection: "row", gap: 6 }}>
        {([ ["details", "작업 내용"], ["sessions", `연결 세션 ${editor.task.sessions.length}`], ["activity", "기록·메모"] ] as const).map(([key, label]) => <Chip key={key} label={label} colors={colors} selected={editorSection === key} onPress={() => setEditorSection(key)} />)}
      </View> : null}
      {editorSection === "details" ? <>
        <Field label="작업 제목" value={editor.fields.title} onChange={(value) => updateField("title", value)} colors={colors} placeholder="예: 로그인 오류 원인 정리" disabled={busy || uncertain} maxLength={200} />
        <Field label="프로젝트" value={editor.fields.project} onChange={(value) => updateField("project", value)} colors={colors} placeholder="예: my-app" disabled={busy || uncertain} maxLength={200} />
        <View style={{ gap: 7 }}><Body colors={colors} muted style={{ fontSize: 11, fontWeight: "600" }}>작업 상태</Body><StatusPicker value={editor.fields.status} onChange={(value) => updateField("status", value)} colors={colors} disabled={busy || uncertain} /></View>
        <View style={{ gap: 7 }}><Body colors={colors} muted style={{ fontSize: 11, fontWeight: "600" }}>우선순위</Body>
          <View style={{ flexDirection: "row", gap: 6 }}>{([ ["high", "높음"], ["normal", "보통"], ["low", "낮음"] ] as const).map(([value, label]) => <Chip key={value} label={label} colors={colors} selected={editor.fields.priority === value} onPress={busy || uncertain ? undefined : () => updateField("priority", value)} />)}</View>
        </View>
        <Field label="설명" value={editor.fields.description} onChange={(value) => updateField("description", value)} colors={colors} placeholder="목표, 범위, 완료 기준" multiline tall disabled={busy || uncertain} />
        <View style={{ height: 1, backgroundColor: colors.border }} />
        <View style={{ gap: 3 }}><Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "700" }}>이어갈 기록</Text><Body colors={colors} muted style={{ fontSize: 11 }}>세션이 바뀌어도 맥락이 남도록 적어 두세요.</Body></View>
        <Field label="현재 요약" value={editor.fields.summary} onChange={(value) => updateField("summary", value)} colors={colors} placeholder="지금 어디까지 진행했나요?" multiline disabled={busy || uncertain} maxLength={5000} />
        <Field label="한 일" value={editor.fields.doneText} onChange={(value) => updateField("doneText", value)} colors={colors} placeholder="실제로 수행한 일과 확인한 결과" multiline tall disabled={busy || uncertain} maxLength={10000} />
        <Field label="다음 행동" value={editor.fields.nextAction} onChange={(value) => updateField("nextAction", value)} colors={colors} placeholder="다음에 시작할 구체적인 행동 한 가지" multiline disabled={busy || uncertain} maxLength={5000} />
        <Field label="막힌 이유" value={editor.fields.blockedReason} onChange={(value) => updateField("blockedReason", value)} colors={colors} placeholder="필요한 결정, 자료 또는 도움" multiline disabled={busy || uncertain} maxLength={5000} />
        <Field label="결과 근거" value={editor.fields.evidence} onChange={(value) => updateField("evidence", value)} colors={colors} placeholder="결과물 경로, 검증 명령·결과, 관련 링크" multiline disabled={busy || uncertain} maxLength={10000} />
        {editor.session ? <Banner colors={colors}>만들 때 연결할 세션: {editor.session.title || editor.session.agentId}{"\n"}{editor.session.hostLabel} · {editor.session.provider}</Banner> : null}
      </> : null}
      {editorSection === "sessions" && editor.task ? <>
        {(rulesQuery.data?.rules ?? []).filter((rule) => rule.taskId === editor.task?.id).map((rule) => <Banner key={rule.folder} colors={colors}
          action={<Button small variant="ghost" label="자동 연결 끄기" colors={colors} disabled={writesDisabled} onPress={() => { void stopAutoLink(rule.folder); }} />}>
          자동 연결: {rule.label} 폴더의 새 세션을 이 작업에 연결합니다(다른 PC 포함, {dateLabel(rule.createdAt)} 이후 활동한 세션).
        </Banner>)}
        <Body colors={colors} muted style={{ fontSize: 12 }}>한 작업에 여러 호스트의 세션을 연결할 수 있습니다. 실행 상태와 작업 상태는 별도로 기록됩니다.</Body>
        {editorDirty ? <Banner colors={colors}>수정 중인 내용을 먼저 저장한 뒤 세션을 연결하거나 해제하세요.</Banner> : null}
        {editor.task.sessions.map((saved) => {
          const live = liveSessions.get(sessionKey(saved));
          return <View key={sessionKey(saved)} style={{ gap: 9, padding: 13, borderWidth: 1, borderColor: colors.border, borderRadius: 9 }}>
            <Body colors={colors} style={{ fontWeight: "600" }}>{live?.title || saved.title || saved.agentId}</Body>
            <SessionState session={live ?? saved} live={!!live} colors={colors} />
            <Body colors={colors} muted style={{ fontSize: 10 }}>{saved.provider} · {saved.cwd}{"\n"}관측 {dateLabel(live?.observedAt ?? saved.observedAt)}</Body>
            <View style={{ flexDirection: "row", gap: 6 }}>
              {props.navigation ? <Button label={canOpenSession(saved) ? "대화 열기" : "앱에 호스트 연결 필요"} small colors={colors} disabled={!canOpenSession(saved)} onPress={() => openSession(saved)} /> : null}
              <Button label="연결 해제" small colors={colors} variant="ghost" disabled={writesDisabled || editorDirty} onPress={() => { const task = editor.task; if (task) send({ op: "unlink", requestId: newRequestId(), taskId: task.id, expectedRevision: task.revision, hostId: saved.hostId, agentId: saved.agentId }, acceptTask); }} />
            </View>
          </View>;
        })}
        {!editor.task.sessions.length ? <Body colors={colors} muted>아직 연결한 세션이 없습니다.</Body> : null}
        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "700", marginTop: 8 }}>연결할 수 있는 세션</Text>
        {inbox.slice(0, 50).map((session) => <View key={sessionKey(session)} style={{ gap: 7, paddingBottom: 12, borderBottomWidth: 1, borderColor: colors.border }}>
          <Body colors={colors} lines={2}>{session.title || "제목 없는 세션"}</Body><SessionState session={session} colors={colors} live={onlineHosts.has(session.hostId)} />
          <Button label="이 작업에 연결" colors={colors} small disabled={writesDisabled || editorDirty} onPress={() => { if (editor.task) linkSession(session, editor.task); }} />
        </View>)}
        {!inbox.length ? <Body colors={colors} muted style={{ fontSize: 12 }}>새로 연결할 세션이 없습니다.</Body> : null}
      </> : null}
      {editorSection === "activity" && editor.task ? <>
        <Field label="메모 남기기" value={note} onChange={setNote} colors={colors} placeholder="결정한 내용이나 다음에 참고할 사항" multiline disabled={busy || uncertain} maxLength={10000} />
        <Button label="메모 추가" colors={colors} disabled={writesDisabled || editorDirty || !note.trim()} onPress={() => { const task = editor.task; if (task) send({ op: "note", requestId: newRequestId(), taskId: task.id, expectedRevision: task.revision, message: note.trim() }, (updated) => { acceptTask(updated); setNote(""); }); }} />
        {editorDirty ? <Body colors={colors} muted style={{ fontSize: 11 }}>수정 중인 작업 내용을 먼저 저장하세요.</Body> : null}
        <View style={{ height: 1, backgroundColor: colors.border }} />
        {activityQuery.isError ? <Banner colors={colors} danger>{errorMessage(activityQuery.error)}</Banner> : null}
        <Timeline items={activityQuery.data?.activities ?? []} colors={colors} />
        {activityQuery.isPending ? <Body colors={colors} muted>기록을 불러오는 중…</Body> : null}
        {activityQuery.data?.hasMore ? <Body colors={colors} muted style={{ fontSize: 11 }}>이 작업의 최근 50개 기록입니다.</Body> : null}
      </> : null}
    </Drawer> : null}

    {grouping ? <Drawer title={grouping.target ? "프로젝트 세션 연결" : "프로젝트를 작업으로 묶기"} subtitle={grouping.lane.project} colors={colors} compact={compact}
      onClose={() => { if (!groupBusy) setGrouping(null); }}
      footer={<View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
        <Button label="취소" colors={colors} variant="ghost" disabled={groupBusy} onPress={() => setGrouping(null)} />
        <Button label={groupBusy ? "연결 중…" : grouping.target ? "연결" : "묶기"} colors={colors} variant="primary" disabled={groupBusy || writesDisabled} onPress={() => { void runGroup(); }} />
      </View>}>
      <Body colors={colors}>{grouping.target
        ? `${grouping.lane.project} 폴더의 최근 세션 ${grouping.sessions.length}개를 "${grouping.target.title}" 작업에 연결합니다.`
        : `"${grouping.lane.project}" 작업을 새로 만들고, 이 폴더의 최근 세션 ${grouping.sessions.length}개를 연결합니다.`}</Body>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: grouping.autoLink }} onPress={() => setGrouping({ ...grouping, autoLink: !grouping.autoLink })}
        style={{ flexDirection: "row", gap: 8, alignItems: "flex-start", padding: 12, borderWidth: 1, borderColor: grouping.autoLink ? colors.accent : colors.border, borderRadius: 8 }}>
        <Text style={{ color: grouping.autoLink ? colors.accent : colors.foregroundMuted }}>{grouping.autoLink ? "☑" : "□"}</Text>
        <View style={{ flex: 1, gap: 3 }}>
          <Body colors={colors} style={{ fontWeight: "600" }}>앞으로 이 폴더의 새 세션도 자동 연결</Body>
          <Body colors={colors} muted style={{ fontSize: 11 }}>폴더 이름이 {grouping.lane.project}인 세션이 새로 활동하면 수집할 때 이 작업에 붙입니다. 다른 PC도 같습니다. 작업 상세의 세션 탭에서 끌 수 있습니다.</Body>
        </View>
      </Pressable>
      <View style={{ gap: 6 }}>
        {grouping.sessions.slice(0, 8).map((session) => <Body key={sessionKey(session)} colors={colors} muted lines={1} style={{ fontSize: 12 }}>· {session.title || "제목 없는 세션"} · {session.hostLabel || session.hostId}</Body>)}
        {grouping.sessions.length > 8 ? <Body colors={colors} muted style={{ fontSize: 11 }}>외 {grouping.sessions.length - 8}개</Body> : null}
      </View>
      <Body colors={colors} muted style={{ fontSize: 11 }}>3일 넘게 활동이 없는 조용한 세션과 이미 다른 작업에 연결된 세션은 넣지 않습니다.</Body>
      {groupError ? <Banner colors={colors} danger>{groupError}</Banner> : null}
    </Drawer> : null}
    {linkingSession ? <Drawer title="기존 작업에 연결" subtitle={linkingSession.title || "제목 없는 세션"} colors={colors} compact={compact} onClose={() => { if (!busy && !uncertain) { setLinkingSession(null); setActionError(null); } }}>
      {actionBanner}
      <Field label="연결할 작업 검색" value={linkSearch} onChange={setLinkSearch} colors={colors} placeholder="제목 또는 프로젝트" />
      {activeTasks.filter((task) => `${task.title} ${task.project}`.toLocaleLowerCase().includes(linkSearch.toLocaleLowerCase())).map((task) => <View key={task.id} style={{ padding: 14, gap: 7, borderWidth: 1, borderColor: colors.border, borderRadius: 9 }}>
        <Body colors={colors} style={{ fontWeight: "600" }}>{task.title}</Body><Body colors={colors} muted style={{ fontSize: 11 }}>{task.project || "프로젝트 미지정"} · {STATUS_LABELS[task.status]}</Body>
        <Button label="연결" colors={colors} small disabled={writesDisabled} onPress={() => linkSession(linkingSession, task)} />
      </View>)}
    </Drawer> : null}

    {exportOpen ? <Drawer title="작업 기록 내보내기" subtitle={`저장 호스트 · ${props.host.label}`} colors={colors} compact={compact} onClose={() => setExportOpen(false)}>
      <Body colors={colors} muted>JSON은 전체 작업과 기록을 보관하는 용도입니다. Markdown은 읽고 공유하기 좋은 문서입니다.</Body>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button label="JSON 내보내기" colors={colors} disabled={exporting} onPress={() => { void runExport("json"); }} />
        <Button label="Markdown 내보내기" colors={colors} disabled={exporting} onPress={() => { void runExport("markdown"); }} />
      </View>
      {exporting ? <Body colors={colors} muted>내보내는 중…</Body> : null}
      {exportError ? <Banner colors={colors} danger>{exportError}</Banner> : null}
      {exported ? <>
        <Banner colors={colors}>호스트에 파일을 저장했습니다.</Banner>
        <Body colors={colors} selectable style={{ fontSize: 12 }}>{exported.path}</Body>
        <Button label={showExportText ? "내용 접기" : "내용 보기"} colors={colors} small onPress={() => setShowExportText(!showExportText)} />
        {showExportText ? <View style={{ padding: 12, borderRadius: 8, backgroundColor: colors.surface0 }}><Body colors={colors} selectable style={{ fontSize: 11, lineHeight: 18 }}>{exported.text.slice(0, 30000)}{exported.text.length > 30000 ? "\n…미리보기는 여기까지입니다. 전체 내용은 저장된 파일에 있습니다." : ""}</Body></View> : null}
      </> : null}
    </Drawer> : null}
  </View>;
}
