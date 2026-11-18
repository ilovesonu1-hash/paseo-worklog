import { z } from "zod";

export const statusSchema = z.enum(["todo", "doing", "review", "blocked", "done"]);
export type TaskStatus = z.infer<typeof statusSchema>;
export const STATUS_LABELS: Record<TaskStatus, string> = { todo: "할 일", doing: "진행 중", review: "검토", blocked: "막힘", done: "완료" };
export const STATUS_ORDER: TaskStatus[] = ["todo", "doing", "review", "blocked", "done"];
export const PRIORITY_LABELS: Record<"high" | "normal" | "low", string> = { high: "높음", normal: "보통", low: "낮음" };
export const executionSchema = z.enum(["working", "waiting", "error", "idle", "closed", "unknown"]);
export const sessionSchema = z.object({
  hostId: z.string().min(1).max(256), hostLabel: z.string().max(256),
  agentId: z.string().min(1).max(256), workspaceId: z.string().nullable(),
  title: z.string().max(2000), provider: z.string().max(256), cwd: z.string().max(8192),
  execution: executionSchema, observedAt: z.string(),
  parentAgentId: z.string().nullable().default(null),
  /** The agent's own last-update time (not the collection time). Absent in snapshots saved before 0.2.1. */
  activityAt: z.string().max(64).optional(),
});
export type SessionSnapshot = z.infer<typeof sessionSchema>;
export function sessionKey(session: Pick<SessionSnapshot, "hostId" | "agentId">): string {
  return JSON.stringify([session.hostId, session.agentId]);
}
export const taskFieldsSchema = z.object({
  title: z.string().trim().min(1, "작업 제목을 입력하세요.").max(200),
  project: z.string().trim().max(200).default(""),
  description: z.string().max(20000).default(""),
  status: statusSchema.default("todo"),
  priority: z.enum(["high", "normal", "low"]).default("normal"),
  summary: z.string().max(5000).default(""),
  doneText: z.string().max(10000).default(""),
  nextAction: z.string().max(5000).default(""),
  blockedReason: z.string().max(5000).default(""),
  evidence: z.string().max(10000).default(""),
});
export type TaskFields = z.infer<typeof taskFieldsSchema>;
// A sparse patch must never inherit create-time defaults (Zod 4 applies defaults
// under .partial()). Explicit optionals keep unrelated fields unchanged.
export const taskPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  project: z.string().trim().max(200).optional(),
  description: z.string().max(20000).optional(),
  status: statusSchema.optional(),
  priority: z.enum(["high", "normal", "low"]).optional(),
  summary: z.string().max(5000).optional(),
  doneText: z.string().max(10000).optional(),
  nextAction: z.string().max(5000).optional(),
  blockedReason: z.string().max(5000).optional(),
  evidence: z.string().max(10000).optional(),
});
export const taskSchema = taskFieldsSchema.extend({
  id: z.string(), revision: z.number().int().positive(),
  createdAt: z.string(), updatedAt: z.string(), archivedAt: z.string().nullable(),
  sessions: z.array(sessionSchema),
});
export type Task = z.infer<typeof taskSchema>;
export const activitySchema = z.object({
  id: z.number().int().positive(), taskId: z.string(),
  kind: z.enum(["created", "edited", "status", "linked", "unlinked", "note", "reported", "session", "archived", "restored"]),
  message: z.string(), actor: z.enum(["user", "agent", "system"]), createdAt: z.string(),
});
export type Activity = z.infer<typeof activitySchema>;
export const boardSchema = z.object({ tasks: z.array(taskSchema), activities: z.array(activitySchema), generatedAt: z.string() });
export type BoardSnapshot = z.infer<typeof boardSchema>;

const receipt = { requestId: z.string().min(8).max(200) };
const target = { taskId: z.string().min(1), expectedRevision: z.number().int().positive() };
export const mutationSchema = z.discriminatedUnion("op", [
  z.object({ ...receipt, op: z.literal("create"), fields: taskFieldsSchema, session: sessionSchema.optional() }),
  z.object({ ...receipt, ...target, op: z.literal("update"), patch: taskPatchSchema }),
  z.object({ ...receipt, ...target, op: z.literal("link"), session: sessionSchema }),
  z.object({ ...receipt, ...target, op: z.literal("unlink"), hostId: z.string(), agentId: z.string() }),
  z.object({ ...receipt, ...target, op: z.literal("note"), message: z.string().trim().min(1).max(10000) }),
  z.object({ ...receipt, ...target, op: z.literal("archive") }),
  z.object({ ...receipt, ...target, op: z.literal("restore") }),
]);
export type Mutation = z.infer<typeof mutationSchema>;
export const mutationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), task: taskSchema, replayed: z.boolean().default(false) }),
  z.object({ ok: z.literal(false), code: z.enum(["CONFLICT", "NOT_FOUND", "ALREADY_LINKED", "REQUEST_ID_REUSED", "VALIDATION", "LIMIT"]), message: z.string(), current: taskSchema.optional() }),
]);
export type MutationResult = z.infer<typeof mutationResultSchema>;
export const reportSchema = z.object({
  requestId: z.string().min(8).max(200), taskId: z.string().min(1), expectedRevision: z.number().int().positive(),
  summary: z.string().max(5000), doneText: z.string().max(10000), nextAction: z.string().max(5000),
  blockedReason: z.string().max(5000).optional(), evidence: z.string().max(10000).optional(),
  status: statusSchema.optional(),
});
export type AgentReport = z.infer<typeof reportSchema>;

export function newRequestId(): string {
  return `wl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
