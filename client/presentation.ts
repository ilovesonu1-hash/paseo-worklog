import type { Activity, SessionSnapshot, Task, TaskFields, TaskStatus } from "../shared/model";

export const EMPTY_FIELDS: TaskFields = {
  title: "", project: "", description: "", status: "todo", priority: "normal",
  summary: "", doneText: "", nextAction: "", blockedReason: "", evidence: "",
};

export const FIELD_KEYS = Object.keys(EMPTY_FIELDS) as (keyof TaskFields)[];

export function fieldsOf(task: Task): TaskFields {
  return Object.fromEntries(FIELD_KEYS.map((key) => [key, task[key]])) as TaskFields;
}

export function changedFields(before: TaskFields, after: TaskFields): Partial<TaskFields> {
  return Object.fromEntries(FIELD_KEYS.filter((key) => before[key] !== after[key]).map((key) => [key, after[key]]));
}

export const STATUS_HINT: Record<TaskStatus, string> = {
  todo: "다음에 할 일", doing: "현재 진행하는 일", review: "결과를 확인할 일",
  blocked: "도움이나 결정이 필요한 일", done: "확인하고 마친 일",
};

export const EXECUTION_LABELS: Record<SessionSnapshot["execution"], string> = {
  // idle = the agent finished its turn and is waiting for the next instruction.
  working: "실행 중", waiting: "권한·답변 필요", error: "실행 오류", idle: "응답 완료 · 지시 대기",
  closed: "종료", unknown: "상태 미확인",
};

export const ACTIVITY_LABELS: Record<Activity["kind"], string> = {
  created: "작업 등록", edited: "내용 수정", status: "상태 변경", linked: "세션 연결",
  unlinked: "연결 해제", note: "메모", reported: "작업 보고", session: "실행 상태",
  archived: "보관", restored: "복원",
};

export function dateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function shortAge(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return "";
  if (elapsed < 60_000) return "방금";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}분 전`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}시간 전`;
  return `${Math.floor(elapsed / 86_400_000)}일 전`;
}

export function sessionProject(session: SessionSnapshot): string {
  return session.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "요청을 처리하지 못했습니다.";
}
