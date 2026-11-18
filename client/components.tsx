import React from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { STATUS_LABELS, STATUS_ORDER } from "../shared/model";
import type { Activity, SessionSnapshot, TaskStatus } from "../shared/model";
import type { HostHealth } from "../shared/sync";
import { ACTIVITY_LABELS, dateLabel, EXECUTION_LABELS, shortAge } from "./presentation";

export type Colors = PluginScreenProps["theme"]["colors"];

export function statusColor(status: TaskStatus, colors: Colors): string {
  return status === "doing" ? colors.accent : status === "review" ? colors.statusWarning
    : status === "blocked" ? colors.statusDanger : status === "done" ? colors.statusSuccess : colors.foregroundMuted;
}

export function Body({ children, colors, muted = false, style, lines, selectable = false }: {
  children: React.ReactNode; colors: Colors; muted?: boolean; style?: TextStyle; lines?: number; selectable?: boolean;
}) {
  return <Text selectable={selectable} numberOfLines={lines} style={{ color: muted ? colors.foregroundMuted : colors.foreground, fontSize: 13, lineHeight: 20, ...style }}>{children}</Text>;
}

export function Button({ label, onPress, colors, variant = "secondary", disabled = false, small = false, style, accessibilityLabel }: {
  label: string; onPress: () => void; colors: Colors; variant?: "primary" | "secondary" | "ghost" | "danger";
  disabled?: boolean; small?: boolean; style?: ViewStyle; accessibilityLabel?: string;
}) {
  const primary = variant === "primary";
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ paddingHorizontal: small ? 10 : 14, paddingVertical: small ? 6 : 9,
      borderRadius: 8, minHeight: small ? 30 : 37, justifyContent: "center", alignItems: "center",
      borderWidth: variant === "secondary" ? 1 : 0, borderColor: colors.border,
      backgroundColor: primary ? colors.accent : variant === "secondary" ? colors.surface1 : "transparent",
      opacity: disabled ? 0.45 : pressed ? 0.75 : 1, ...style })}>
    <Text style={{ color: primary ? colors.accentForeground : variant === "danger" ? colors.statusDanger : colors.foreground,
      fontWeight: "600", fontSize: small ? 12 : 13 }}>{label}</Text>
  </Pressable>;
}

export function Chip({ label, colors, selected = false, onPress, tone }: {
  label: string; colors: Colors; selected?: boolean; onPress?: () => void; tone?: string;
}) {
  const contents = <Text numberOfLines={1} style={{ fontSize: 11, fontWeight: selected ? "600" : "500", color: tone ?? (selected ? colors.accent : colors.foregroundMuted) }}>{label}</Text>;
  const style: ViewStyle = { paddingVertical: 5, paddingHorizontal: 9, borderRadius: 6, borderWidth: 1,
    borderColor: selected ? colors.accent : colors.border, backgroundColor: colors.surface1, maxWidth: 240 };
  return onPress ? <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={style}>{contents}</Pressable>
    : <View style={style}>{contents}</View>;
}

export function Field({ label, value, onChange, colors, placeholder, multiline = false, tall = false, disabled = false, maxLength = 20000 }: {
  label: string; value: string; onChange: (value: string) => void; colors: Colors; placeholder?: string;
  multiline?: boolean; tall?: boolean; disabled?: boolean; maxLength?: number;
}) {
  return <View style={{ gap: 6 }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>{label}</Text>
    <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} placeholder={placeholder}
      placeholderTextColor={colors.foregroundMuted} multiline={multiline} editable={!disabled} maxLength={maxLength}
      textAlignVertical={multiline ? "top" : "center"} style={{ color: colors.foreground, backgroundColor: colors.surface0,
        borderColor: colors.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 11, paddingVertical: 10,
        fontSize: 13, lineHeight: 20, minHeight: multiline ? tall ? 100 : 68 : 40, opacity: disabled ? 0.55 : 1 }} />
  </View>;
}

export function StatusPicker({ value, onChange, colors, disabled = false }: {
  value: TaskStatus; onChange: (status: TaskStatus) => void; colors: Colors; disabled?: boolean;
}) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
    {STATUS_ORDER.map((status) => <Pressable key={status} disabled={disabled} onPress={() => onChange(status)}
      accessibilityRole="button" accessibilityLabel={`상태 ${STATUS_LABELS[status]}`} accessibilityState={{ selected: value === status, disabled }}
      style={{ flexDirection: "row", alignItems: "center", gap: 5, borderRadius: 7, paddingHorizontal: 10, paddingVertical: 8,
        borderWidth: 1, borderColor: value === status ? statusColor(status, colors) : colors.border,
        backgroundColor: value === status ? colors.surface2 : colors.surface0, opacity: disabled ? 0.5 : 1 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: statusColor(status, colors) }} />
      <Text style={{ color: value === status ? colors.foreground : colors.foregroundMuted, fontSize: 12, fontWeight: value === status ? "700" : "400" }}>{STATUS_LABELS[status]}</Text>
    </Pressable>)}
  </View>;
}

export function Banner({ children, colors, danger = false, action }: {
  children: React.ReactNode; colors: Colors; danger?: boolean; action?: React.ReactNode;
}) {
  return <View style={{ padding: 12, gap: 8, borderWidth: 1, borderColor: danger ? colors.statusDanger : colors.border,
    borderLeftWidth: 3, borderRadius: 8, backgroundColor: colors.surface1 }}>
    <Body colors={colors} style={{ fontSize: 12 }}>{children}</Body>{action}
  </View>;
}

export function Empty({ title, subtitle, colors, action }: {
  title: string; subtitle?: string; colors: Colors; action?: React.ReactNode;
}) {
  return <View style={{ padding: 30, gap: 10, alignItems: "center", justifyContent: "center", flexGrow: 1 }}>
    <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: colors.surface2, alignItems: "center", justifyContent: "center", marginBottom: 4 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 20 }}>≡</Text>
    </View>
    <Body colors={colors} style={{ fontWeight: "600", textAlign: "center" }}>{title}</Body>
    {subtitle ? <Body colors={colors} muted style={{ textAlign: "center", fontSize: 12, maxWidth: 340 }}>{subtitle}</Body> : null}
    {action ? <View style={{ paddingTop: 6 }}>{action}</View> : null}
  </View>;
}

export function SessionState({ session, colors, live = false }: { session: SessionSnapshot; colors: Colors; live?: boolean }) {
  const tone = session.execution === "working" ? colors.accent : session.execution === "error" ? colors.statusDanger
    : session.execution === "waiting" ? colors.statusWarning : colors.foregroundMuted;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 5, minWidth: 0 }}>
    <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: tone }} />
    <Text numberOfLines={1} style={{ color: tone, fontSize: 11, flexShrink: 1 }}>{!live ? "마지막 관측 · " : ""}{EXECUTION_LABELS[session.execution]} · {session.hostLabel || session.hostId}</Text>
  </View>;
}

export function HostHealthList({ hosts, colors, showIds = false }: { hosts: HostHealth[]; colors: Colors; showIds?: boolean }) {
  const labels: Record<HostHealth["status"], string> = {
    online: "수집 정상", offline: "연결 끊김", error: "수집 오류", disabled: "수집 꺼짐", connecting: "연결 중", stale: "갱신 지연",
  };
  const bridgeLabels: Record<HostHealth["bridgeState"], string> = {
    local: "이 호스트", ready: "보고 연결됨", unconfigured: "보고 설정 필요", unavailable: "보고 플러그인 확인", error: "보고 연결 오류", paused: "보고 일시 정지",
  };
  return <View style={{ gap: 8 }}>{hosts.map((host) => {
    const tone = host.status === "online" ? colors.statusSuccess : host.status === "error" ? colors.statusDanger : colors.foregroundMuted;
    return <View key={host.hostId} style={{ padding: 12, gap: 5, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: 9 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600", flex: 1 }}>{host.label || host.hostId}</Text>
        <Text style={{ color: tone, fontSize: 11 }}>{labels[host.status]}</Text>
      </View>
      <Body colors={colors} muted style={{ fontSize: 10 }}>마지막 성공 {host.lastSuccessAt ? `${shortAge(host.lastSuccessAt)} · ${dateLabel(host.lastSuccessAt)}` : "아직 없음"}</Body>
      <Body colors={colors} muted style={{ fontSize: 10 }}>세션 {host.sessionCount}개 · {bridgeLabels[host.bridgeState]}{host.queuedReports ? ` · 보고 대기 ${host.queuedReports}` : ""}{host.blockedReports ? ` · 보류 ${host.blockedReports}` : ""}{host.truncated ? " · 목록 일부만 표시" : ""}</Body>
      {host.error ? <Body colors={colors} style={{ fontSize: 11, color: colors.statusDanger }}>{host.error}</Body> : null}
      {showIds ? <Body colors={colors} muted selectable style={{ fontSize: 10 }}>{host.hostId}</Body> : null}
    </View>;
  })}</View>;
}

export function Timeline({ items, colors, titles }: { items: Activity[]; colors: Colors; titles?: Map<string, string> }) {
  return <View>
    {items.map((item, index) => <View key={item.id} style={{ flexDirection: "row", gap: 11, paddingBottom: 16 }}>
      <View style={{ width: 9, alignItems: "center", paddingTop: 7 }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: item.kind === "note" ? colors.accent : colors.border }} />
        {index < items.length - 1 ? <View style={{ width: 1, flex: 1, backgroundColor: colors.border, marginTop: 5, marginBottom: -14 }} /> : null}
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
          <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }}>{ACTIVITY_LABELS[item.kind]}{item.actor === "agent" ? " · 에이전트" : item.actor === "system" ? " · 자동" : ""}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>{dateLabel(item.createdAt)}</Text>
        </View>
        {titles ? <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11 }}>{titles.get(item.taskId) ?? item.taskId}</Text> : null}
        <Body selectable colors={colors} muted style={{ fontSize: 12, lineHeight: 19 }}>{item.message}</Body>
      </View>
    </View>)}
  </View>;
}

export function Drawer({ title, subtitle, colors, compact, onClose, children, footer, width = 510 }: {
  title: string; subtitle?: string; colors: Colors; compact: boolean; onClose: () => void;
  children: React.ReactNode; footer?: React.ReactNode; width?: number;
}) {
  return <View style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, zIndex: 20, flexDirection: "row", justifyContent: "flex-end" }}>
    <Pressable accessibilityRole="button" accessibilityLabel="패널 닫기" onPress={onClose} style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: "rgba(0,0,0,0.32)" }} />
    <View style={{ width: compact ? "100%" : width, maxWidth: "100%", backgroundColor: colors.surface1, borderLeftWidth: 1, borderColor: colors.border, flexDirection: "column" }}>
      <View style={{ padding: 20, borderBottomWidth: 1, borderColor: colors.border, flexDirection: "row", gap: 10, alignItems: "center" }}>
        <View style={{ flex: 1, gap: 3 }}><Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "700" }}>{title}</Text>
          {subtitle ? <Body colors={colors} muted style={{ fontSize: 11 }}>{subtitle}</Body> : null}</View>
        <Button label="닫기" colors={colors} variant="ghost" small onPress={onClose} />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, gap: 18 }} keyboardShouldPersistTaps="handled">{children}</ScrollView>
      {footer ? <View style={{ padding: 16, gap: 10, borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}>{footer}</View> : null}
    </View>
  </View>;
}
