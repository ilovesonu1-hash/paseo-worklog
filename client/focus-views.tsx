import React, { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { sessionKey, STATUS_LABELS, STATUS_ORDER } from "../shared/model";
import type { SessionSnapshot, Task, TaskStatus } from "../shared/model";
import {
  buildFocusQueue, buildProjectLanes, DEFAULT_RECENT_DAYS, DEFAULT_STALL_DAYS, FOCUS_HINTS, FOCUS_LABELS, FOCUS_ORDER,
  focusItemKey, sessionActivity,
} from "../shared/focus";
import type { AutoColumn, FocusItem, FocusReason, ProjectLane } from "../shared/focus";
import { Body, BOTTOM_CLEARANCE, Button, Empty, SessionState, statusColor } from "./components";
import type { Colors } from "./components";
import { shortAge } from "./presentation";

export interface FocusViewProps {
  tasks: Task[];
  liveSessions: ReadonlyMap<string, SessionSnapshot>;
  inboxCount: number;
  colors: Colors;
  compact: boolean;
  onOpenTask: (task: Task) => void;
  onRegisterSession: (session: SessionSnapshot) => void;
  onShowProject: (project: string) => void;
  onOpenInbox: () => void;
  canOpenSession: (session: SessionSnapshot) => boolean;
  openSession: (session: SessionSnapshot) => void;
  hasNavigation: boolean;
  writesDisabled: boolean;
  /** sessionKey → acknowledged activityAt, from the central board. */
  acknowledged: ReadonlyMap<string, string>;
  acking: boolean;
  onAcknowledge: (sessions: SessionSnapshot[]) => void;
  /** Group a project row: link its recent unlinked sessions to one task. */
  onGroupProject?: (lane: ProjectLane, target: Task | null, sessions: SessionSnapshot[]) => void;
}

function reasonColor(reason: FocusReason, colors: Colors): string {
  return reason === "idle" ? colors.accent
    : reason === "waiting" || reason === "review" || reason === "stalled" ? colors.statusWarning
    : reason === "blocked" || reason === "error" ? colors.statusDanger : colors.foregroundMuted;
}

function projectLabel(project: string): string {
  return project || "프로젝트 미지정";
}

/** The one line that says what to do next for a task. */
function nextLine(task: Task): string {
  if (task.status === "blocked" && task.blockedReason) return `막힌 이유: ${task.blockedReason}`;
  if (task.status === "review" && task.summary) return `보고: ${task.summary}`;
  if (task.nextAction) return `다음 행동: ${task.nextAction}`;
  return task.summary;
}

function SessionActions({ session, props }: { session: SessionSnapshot; props: FocusViewProps }) {
  const { colors } = props;
  return <>
    {props.hasNavigation ? <Button small colors={colors} label={props.canOpenSession(session) ? "대화 열기" : "앱에 호스트 연결 필요"}
      disabled={!props.canOpenSession(session)} onPress={() => props.openSession(session)} /> : null}
    <Button small variant="ghost" colors={colors} label="작업으로 등록" disabled={props.writesDisabled} onPress={() => props.onRegisterSession(session)} />
  </>;
}

function AckButton({ sessions, props, label = "확인함" }: { sessions: SessionSnapshot[]; props: FocusViewProps; label?: string }) {
  return <Button small variant="ghost" colors={props.colors} label={props.acking ? "저장 중…" : label} disabled={props.acking || !sessions.length}
    accessibilityLabel={`${label}: 다음 응답이 올 때까지 지시 대기에서 뺍니다`} onPress={() => props.onAcknowledge(sessions)} />;
}

function FocusRow({ item, props }: { item: FocusItem; props: FocusViewProps }) {
  const { colors } = props;
  const tone = reasonColor(item.reason, colors);
  const session = item.sessions[0];
  const task = item.task;
  const line = task ? nextLine(task) : "";
  return <View style={{ borderWidth: 1, borderColor: colors.border, borderLeftWidth: 3, borderLeftColor: tone,
    borderStyle: task ? "solid" : "dashed", borderRadius: 10, backgroundColor: colors.surface1, padding: 14, gap: 8 }}>
    <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 10, fontWeight: "600" }}>{projectLabel(item.project)}</Text>
      {!task ? <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>· 자동 배치된 세션</Text> : null}
      {task?.priority === "high" ? <Text style={{ color: colors.statusDanger, fontSize: 10, fontWeight: "600" }}>높음</Text> : null}
      {item.reasons.slice(1).map((reason) => <Text key={reason} style={{ color: reasonColor(reason, colors), fontSize: 10 }}>· {FOCUS_LABELS[reason]}</Text>)}
      <View style={{ flex: 1 }} />
      <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>{shortAge(item.at)}</Text>
    </View>
    {task ? <Pressable accessibilityRole="button" accessibilityLabel={`작업 열기: ${task.title}`} onPress={() => props.onOpenTask(task)}>
      <Text numberOfLines={2} style={{ color: colors.foreground, fontSize: 14, lineHeight: 21, fontWeight: "600" }}>{task.title}</Text>
      {line ? <Body colors={colors} muted lines={2} style={{ fontSize: 12, lineHeight: 18 }}>{line}</Body> : null}
    </Pressable> : <Text numberOfLines={2} style={{ color: colors.foreground, fontSize: 14, lineHeight: 21, fontWeight: "600" }}>{session.title}</Text>}
    {session ? <SessionState session={session} colors={colors} live /> : null}
    <View style={{ flexDirection: "row", gap: 7, flexWrap: "wrap" }}>
      {task ? <>
        <Button small label={item.reason === "review" ? "검토하기" : "작업 열기"} colors={colors} onPress={() => props.onOpenTask(task)} />
        {props.hasNavigation && session ? <Button small variant="ghost" colors={colors}
          label={props.canOpenSession(session) ? "대화 열기" : "앱에 호스트 연결 필요"}
          disabled={!props.canOpenSession(session)} onPress={() => props.openSession(session)} /> : null}
      </> : <SessionActions session={session} props={props} />}
      {item.reason === "idle" ? <AckButton sessions={item.sessions} props={props} /> : null}
    </View>
  </View>;
}

/** (나) Everything across projects that is waiting on the user, most urgent first. */
export function FocusQueueView(props: FocusViewProps) {
  const { colors, compact } = props;
  const queue = useMemo(() => buildFocusQueue(props.tasks, props.liveSessions, { acknowledged: props.acknowledged }), [props.tasks, props.liveSessions, props.acknowledged]);
  const doing = props.tasks.filter((task) => !task.archivedAt && task.status === "doing").length;
  const working = [...props.liveSessions.values()].filter((session) => session.execution === "working").length;
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: compact ? 16 : 24, paddingBottom: compact ? 16 + BOTTOM_CLEARANCE : 24, gap: 14, maxWidth: 900, width: "100%", flexGrow: 1 }}>
    <View style={{ gap: 4 }}>
      <Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "700" }}>확인 필요 {queue.length}</Text>
      <Body colors={colors} muted style={{ fontSize: 12 }}>모든 프로젝트에서 내 손이 필요한 작업과 세션을 모았습니다. 진행 중인 작업 {doing}개 · 실행 중인 세션 {working}개.</Body>
    </View>
    {props.inboxCount ? <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10,
      padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 9, backgroundColor: colors.surface1 }}>
      <Body colors={colors} style={{ fontSize: 12, flex: 1 }}>아직 작업에 연결하지 않은 세션이 {props.inboxCount}개 있습니다. "작업" 탭의 프로젝트별 보기에도 폴더별로 표시됩니다.</Body>
      <Button small variant="ghost" label="새 세션 보기" colors={colors} onPress={props.onOpenInbox} />
    </View> : null}
    {FOCUS_ORDER.map((reason) => {
      const group = queue.filter((item) => item.reason === reason);
      if (!group.length) return null;
      return <View key={reason} style={{ gap: 9 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 }}>
          <Text style={{ color: reasonColor(reason, colors), fontSize: 13, fontWeight: "700" }}>{FOCUS_LABELS[reason]}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{group.length}</Text>
          {reason === "idle" && group.length > 1 ? <><View style={{ flex: 1 }} /><AckButton sessions={group.flatMap((item) => item.sessions)} props={props} label="모두 확인함" /></> : null}
        </View>
        <Body colors={colors} muted style={{ fontSize: 11 }}>{reason === "stalled" ? `진행 중인데 ${DEFAULT_STALL_DAYS}일 넘게 기록이 없고, 실행 중인 세션도 없습니다.` : FOCUS_HINTS[reason]}</Body>
        {group.map((item) => <FocusRow key={focusItemKey(item)} item={item} props={props} />)}
      </View>;
    })}
    {!queue.length ? <Empty colors={colors} title="지금 확인할 일이 없습니다"
      subtitle={doing ? `진행 중인 작업 ${doing}개는 모두 다음 행동이 적혀 있고 막힌 곳이 없습니다.` : "권한이나 답변을 기다리는 세션도 없습니다. 프로젝트별 현황은 \"작업\" 탭에서 볼 수 있습니다."} /> : null}
    <Body colors={colors} muted style={{ fontSize: 11 }}>세션 상태는 수집이 정상인 호스트의 현재 관측만 반영합니다. 오래된 관측은 이 목록에 넣지 않습니다.</Body>
  </ScrollView>;
}

function LiveDots({ lane, colors }: { lane: ProjectLane; colors: Colors }) {
  const parts = [
    lane.live.waiting ? { label: `권한·답변 필요 ${lane.live.waiting}`, tone: colors.statusWarning } : null,
    lane.live.working ? { label: `실행 중 ${lane.live.working}`, tone: colors.accent } : null,
    lane.live.error ? { label: `오류 ${lane.live.error}`, tone: colors.statusDanger } : null,
  ].filter((part): part is { label: string; tone: string } => !!part);
  if (!parts.length) return <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>실행 중인 세션 없음</Text>;
  return <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>{parts.map((part) =>
    <View key={part.label} style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: part.tone }} />
      <Text style={{ color: part.tone, fontSize: 10 }}>{part.label}</Text>
    </View>)}</View>;
}

function taskCount(lane: ProjectLane): number {
  return STATUS_ORDER.reduce((sum, status) => sum + lane.tasks[status].length, 0);
}

function sessionCount(lane: ProjectLane): number {
  return lane.sessions.doing.length + lane.sessions.review.length + lane.sessions.blocked.length;
}

function LaneHeader({ lane, props }: { lane: ProjectLane; props: FocusViewProps }) {
  const { colors } = props;
  const activeSession = lane.sessions.blocked[0] ?? lane.sessions.doing[0] ?? lane.sessions.review[0];
  const latestSession = activeSession ?? lane.dormant[0];
  // Recent unlinked sessions only; dormant (quiet) ones are left where they are.
  const unlinked = [...lane.sessions.blocked, ...lane.sessions.doing, ...lane.sessions.review];
  const target = lane.current ?? lane.tasks.review[0] ?? lane.tasks.blocked[0] ?? null;
  return <View style={{ gap: 6 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 14, fontWeight: "700", flexShrink: 1 }}>{projectLabel(lane.project)}</Text>
      {lane.attention ? <Text style={{ color: colors.statusWarning, fontSize: 10, fontWeight: "700" }}>확인 {lane.attention}</Text> : null}
    </View>
    {lane.current ? <Pressable accessibilityRole="button" accessibilityLabel={`이어서 할 작업: ${lane.current.title}`} onPress={() => props.onOpenTask(lane.current!)}
      style={{ backgroundColor: colors.surface0, borderRadius: 6, padding: 8, gap: 2 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 9, fontWeight: "600" }}>{lane.current.status === "doing" ? "지금 하는 일" : "다음에 할 일"}</Text>
      <Text numberOfLines={2} style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }}>{lane.current.title}</Text>
      {lane.current.nextAction ? <Body colors={colors} muted lines={2} style={{ fontSize: 11, lineHeight: 16 }}>→ {lane.current.nextAction}</Body> : null}
    </Pressable> : latestSession ? <View style={{ backgroundColor: colors.surface0, borderRadius: 6, padding: 8, gap: 2 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 9, fontWeight: "600" }}>{activeSession ? "최근 세션" : `마지막 세션 · ${shortAge(sessionActivity(latestSession))}`}</Text>
      <Text numberOfLines={2} style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }}>{latestSession.title}</Text>
    </View> : <Body colors={colors} muted style={{ fontSize: 11 }}>진행 중이거나 남은 할 일이 없습니다.</Body>}
    <LiveDots lane={lane} colors={colors} />
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 10, flexShrink: 1 }}>{lane.lastUpdatedAt ? `최근 활동 ${shortAge(lane.lastUpdatedAt)}` : ""}{sessionCount(lane) ? ` · 자동 배치 세션 ${sessionCount(lane)}` : ""}{lane.dormant.length ? ` · 조용한 세션 ${lane.dormant.length}(${DEFAULT_RECENT_DAYS}일 넘게 활동 없음)` : ""}</Text>
      {taskCount(lane) ? <Button small variant="ghost" label="이 프로젝트만 보기" colors={colors} onPress={() => props.onShowProject(lane.project)} /> : null}
    </View>
    {unlinked.length && lane.project && props.onGroupProject ? <Button small colors={colors} disabled={props.writesDisabled}
      label={target ? `"${target.title.length > 14 ? `${target.title.slice(0, 14)}…` : target.title}"에 연결 (세션 ${unlinked.length})` : `작업으로 묶기 (세션 ${unlinked.length})`}
      accessibilityLabel={target ? `${lane.project}의 연결 안 된 세션 ${unlinked.length}개를 ${target.title}에 연결` : `${lane.project}의 연결 안 된 세션 ${unlinked.length}개를 새 작업으로 묶기`}
      onPress={() => props.onGroupProject!(lane, target, unlinked)} /> : null}
  </View>;
}

function MiniCard({ task, props }: { task: Task; props: FocusViewProps }) {
  const { colors } = props;
  return <Pressable accessibilityRole="button" accessibilityLabel={`작업 열기: ${task.title}`} onPress={() => props.onOpenTask(task)}
    style={({ pressed }) => ({ borderWidth: 1, borderColor: colors.border, borderRadius: 7, paddingHorizontal: 8, paddingVertical: 6,
      backgroundColor: pressed ? colors.surface2 : colors.surface1 })}>
    <Text numberOfLines={2} style={{ color: colors.foreground, fontSize: 11, lineHeight: 16 }}>{task.priority === "high" ? "! " : ""}{task.title}</Text>
  </Pressable>;
}

const AUTO_LABEL: Record<SessionSnapshot["execution"], string> = {
  working: "실행 중", idle: "응답 완료", waiting: "권한·답변 필요", error: "오류", closed: "종료", unknown: "상태 미확인",
};

/** An unlinked session placed by run state. Tapping opens the conversation, or registers it when that host is not open in this app. */
function SessionMiniCard({ session, props }: { session: SessionSnapshot; props: FocusViewProps }) {
  const { colors } = props;
  const tone = session.execution === "working" ? colors.accent : session.execution === "idle" ? colors.foregroundMuted
    : session.execution === "waiting" ? colors.statusWarning : colors.statusDanger;
  const canOpen = props.hasNavigation && props.canOpenSession(session);
  return <Pressable accessibilityRole="button"
    accessibilityLabel={canOpen ? `대화 열기: ${session.title}` : `작업으로 등록: ${session.title}`}
    onPress={() => canOpen ? props.openSession(session) : props.onRegisterSession(session)}
    style={({ pressed }) => ({ borderWidth: 1, borderStyle: "dashed", borderColor: tone, borderRadius: 7, paddingHorizontal: 8, paddingVertical: 6, gap: 3,
      backgroundColor: pressed ? colors.surface2 : colors.surface0 })}>
    <Text numberOfLines={2} style={{ color: colors.foreground, fontSize: 11, lineHeight: 16 }}>{session.title}</Text>
    <Text numberOfLines={1} style={{ color: tone, fontSize: 9 }}>작업 아님 · {AUTO_LABEL[session.execution]} · {session.provider} · {shortAge(sessionActivity(session))}</Text>
  </Pressable>;
}

const AUTO_COLUMN_FOR_STATUS: Partial<Record<TaskStatus, AutoColumn>> = { doing: "doing", review: "review", blocked: "blocked" };

/** (가) One row per project; columns follow the task status flow. */
export function ProjectFlowView(props: FocusViewProps & { viewportWidth: number }) {
  const { colors, compact } = props;
  const lanes = useMemo(() => buildProjectLanes(props.tasks, props.liveSessions, { acknowledged: props.acknowledged }), [props.tasks, props.liveSessions, props.acknowledged]);
  if (!lanes.length) return <Empty colors={colors} title="아직 프로젝트가 없습니다" subtitle="세션이 수집되거나 작업에 프로젝트 이름을 적으면 프로젝트마다 한 줄씩 여기에 나타납니다." />;
  const activeTasks = props.tasks.filter((task) => !task.archivedAt).length;
  const header = <View style={{ gap: 4, paddingBottom: 6 }}>
    <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "700" }}>등록된 작업 {activeTasks}개 · 아직 작업으로 묶지 않은 세션 {props.inboxCount}개(최근 것은 점선 카드로 표시)</Text>
    <Body colors={colors} muted style={{ fontSize: 12 }}>프로젝트마다 지금 하는 일과 단계별 작업을 한 줄로 봅니다. 작업에 연결하지 않은 세션은 폴더 이름으로 자동 배치됩니다(점선 카드). "실행 중"은 "진행 중", "응답 완료"는 "검토", "권한·답변 필요"와 "오류"는 "막힘" 열에 놓입니다. {DEFAULT_RECENT_DAYS}일 넘게 활동이 없는 응답 완료 세션은 카드 대신 "조용한 세션" 개수로만 표시합니다.</Body>
  </View>;

  if (compact) return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 16 + BOTTOM_CLEARANCE, gap: 12 }}>
    {header}
    {lanes.map((lane) => <View key={lane.project || "(none)"} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.surface1, padding: 13, gap: 10 }}>
      <LaneHeader lane={lane} props={props} />
      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
        {STATUS_ORDER.map((status) => {
          const auto = AUTO_COLUMN_FOR_STATUS[status];
          const count = lane.tasks[status].length + (auto ? lane.sessions[auto].length : 0);
          return <View key={status} style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: statusColor(status, colors) }} />
            <Text style={{ color: count ? colors.foreground : colors.foregroundMuted, fontSize: 11 }}>{STATUS_LABELS[status]} {count}</Text>
          </View>;
        })}
      </View>
      {[...lane.sessions.blocked, ...lane.sessions.doing].slice(0, 3).map((session) => <SessionMiniCard key={sessionKey(session)} session={session} props={props} />)}
    </View>)}
  </ScrollView>;

  const laneWidth = 250;
  // 48 = outer padding, 24 = lane border/padding plus room for a vertical scrollbar.
  const columnWidth = Math.max(150, (props.viewportWidth - 48 - 24 - laneWidth - STATUS_ORDER.length * 8) / STATUS_ORDER.length);
  const shown = 4;
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 24, gap: 10 }}>
    {header}
    <ScrollView horizontal showsHorizontalScrollIndicator>
      <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ width: laneWidth }} />
        {STATUS_ORDER.map((status) => <View key={status} style={{ width: columnWidth, borderTopWidth: 2, borderColor: statusColor(status, colors), paddingTop: 6 }}>
          <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "700" }}>{STATUS_LABELS[status]}</Text>
        </View>)}
      </View>
      {lanes.map((lane) => <View key={lane.project || "(none)"} style={{ flexDirection: "row", gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.surface0, padding: 10 }}>
        <View style={{ width: laneWidth - 22 }}><LaneHeader lane={lane} props={props} /></View>
        {STATUS_ORDER.map((status) => {
          const list = lane.tasks[status];
          const auto = AUTO_COLUMN_FOR_STATUS[status];
          const sessions = auto ? lane.sessions[auto] : [];
          const sessionSlots = Math.max(0, shown - list.length);
          const hidden = Math.max(0, list.length - shown) + Math.max(0, sessions.length - sessionSlots);
          return <View key={status} style={{ width: columnWidth, gap: 6 }}>
            {list.slice(0, shown).map((task) => <MiniCard key={task.id} task={task} props={props} />)}
            {sessions.slice(0, sessionSlots).map((session) => <SessionMiniCard key={sessionKey(session)} session={session} props={props} />)}
            {hidden ? <Pressable accessibilityRole="button" onPress={() => list.length > shown ? props.onShowProject(lane.project) : props.onOpenInbox()}>
              <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>+{hidden}개 더 보기</Text>
            </Pressable> : null}
            {!list.length && !sessions.length ? <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>—</Text> : null}
          </View>;
        })}
      </View>)}
      </View>
    </ScrollView>
  </ScrollView>;
}
