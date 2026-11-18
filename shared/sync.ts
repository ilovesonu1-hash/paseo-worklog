import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";
import { mutationResultSchema, reportSchema, sessionSchema, taskSchema } from "./model.ts";

export const SYNC_PROTOCOL = 1;
export const syncConfigSchema = z.object({
  role: z.enum(["central", "satellite"]).default("central"),
  enabled: z.boolean().default(true),
  pollIntervalSeconds: z.number().int().min(5).max(300).default(15),
  remoteHostIds: z.array(z.string().min(1).max(256)).max(20).default([]),
  centralServerId: z.string().trim().max(256).default(""),
});
export type SyncConfig = z.infer<typeof syncConfigSchema>;
export const configSnapshotSchema = z.object({ revision: z.number().int().positive(), config: syncConfigSchema });
export type ConfigSnapshot = z.infer<typeof configSnapshotSchema>;
export const configureResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), snapshot: configSnapshotSchema }),
  z.object({ ok: z.literal(false), message: z.string(), snapshot: configSnapshotSchema }),
]);
export type ConfigureResult = z.infer<typeof configureResultSchema>;

/** A delivery acknowledgment proves an outcome without exposing task contents. */
export const reportOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), taskId: z.string(), appliedRevision: z.number().int().positive(), replayed: z.boolean() }),
  z.object({ ok: z.literal(false), taskId: z.string(), code: mutationResultSchema.options[1].shape.code, message: z.string() }),
]);
export type ReportOutcome = z.infer<typeof reportOutcomeSchema>;
export const deliverySchema = z.object({
  deliveryId: z.string(), agentId: z.string(), report: reportSchema,
  state: z.enum(["queued", "applied", "blocked"]),
  createdAt: z.string(), settledAt: z.string().nullable(), dismissedAt: z.string().nullable(),
  result: reportOutcomeSchema.nullable(),
});
export type Delivery = z.infer<typeof deliverySchema>;
export const queueResultSchema = z.discriminatedUnion("delivery", [
  z.object({ delivery: z.literal("queued"), deliveryId: z.string(), requestId: z.string(), queuedAt: z.string(), message: z.string() }),
  z.object({ delivery: z.literal("applied"), deliveryId: z.string(), requestId: z.string(), message: z.string() }),
  z.object({ delivery: z.literal("blocked"), deliveryId: z.string().nullable(), requestId: z.string(), message: z.string() }),
]);
export type QueueResult = z.infer<typeof queueResultSchema>;
export const workerStateSchema = z.object({
  centralServerId: z.string().nullable(), boardId: z.string().nullable(), workerHostId: z.string().nullable(),
  lastSyncAt: z.string().nullable(), lastSequence: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(), applied: z.number().int().nonnegative(), blocked: z.number().int().nonnegative(),
  deliveries: z.array(deliverySchema),
});
export type WorkerState = z.infer<typeof workerStateSchema>;

export const hostHealthSchema = z.object({
  hostId: z.string(), label: z.string(),
  status: z.enum(["online", "offline", "error", "disabled", "connecting", "stale"]),
  lastAttemptAt: z.string().nullable(), lastSuccessAt: z.string().nullable(),
  error: z.string().nullable(), truncated: z.boolean(), sessionCount: z.number().int().nonnegative(),
  bridgeState: z.enum(["local", "ready", "unconfigured", "unavailable", "error", "paused"]).default("unconfigured"),
  queuedReports: z.number().int().nonnegative().default(0), blockedReports: z.number().int().nonnegative().default(0),
});
export type HostHealth = z.infer<typeof hostHealthSchema>;
export const rosterSnapshotSchema = z.object({
  sessions: z.array(sessionSchema), hosts: z.array(hostHealthSchema), generatedAt: z.string(),
});
export type RosterSnapshot = z.infer<typeof rosterSnapshotSchema>;

export const exchangeInputSchema = z.object({
  protocol: z.literal(SYNC_PROTOCOL), centralServerId: z.string().min(1).max(256),
  boardId: z.string().min(1).max(256), sequence: z.number().int().positive(),
  tasks: z.array(taskSchema).max(2000),
  acknowledgements: z.array(z.object({ deliveryId: z.string(), requestId: z.string(), result: reportOutcomeSchema })).max(100),
});
export type ExchangeInput = z.infer<typeof exchangeInputSchema>;
export const exchangeResultSchema = z.object({
  protocol: z.literal(SYNC_PROTOCOL), workerHostId: z.string(), boardId: z.string(),
  lastSequence: z.number().int().nonnegative(), lastSyncAt: z.string(),
  reports: z.array(z.object({ deliveryId: z.string(), agentId: z.string(), report: reportSchema, createdAt: z.string() })).max(50),
  queued: z.number().int().nonnegative(), blocked: z.number().int().nonnegative(),
});
export type ExchangeResult = z.infer<typeof exchangeResultSchema>;

export const runtimeStatusSchema = z.object({
  snapshot: configSnapshotSchema,
  self: z.object({ serverId: z.string(), label: z.string() }).nullable(),
  boardId: z.string(), running: z.boolean(), inFlight: z.boolean(),
  lastCycleAt: z.string().nullable(), error: z.string().nullable(),
  knownHosts: z.array(z.object({
    registrationId: z.string(), serverId: z.string().nullable(), label: z.string(),
    status: z.string(), enabled: z.boolean(), error: z.string().nullable(),
  })),
  roster: rosterSnapshotSchema,
  worker: workerStateSchema,
  localTaskCount: z.number().int().nonnegative(),
});
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;

export const readRosterRpc = defineRpc({ name: "sessions.read", input: z.object({}), output: rosterSnapshotSchema });
export const runtimeStatusRpc = defineRpc({ name: "runtime.status", input: z.object({}), output: runtimeStatusSchema });
export const configureRuntimeRpc = defineRpc({ name: "runtime.configure", input: z.object({ expectedRevision: z.number().int().positive(), config: syncConfigSchema }), output: configureResultSchema });
export const refreshRuntimeRpc = defineRpc({ name: "runtime.refresh", input: z.object({}), output: z.object({ scheduled: z.boolean() }) });
export const exchangeRpc = defineRpc({ name: "bridge.exchange", input: exchangeInputSchema, output: exchangeResultSchema });
export const dismissDeliveryRpc = defineRpc({ name: "worker.dismiss", input: z.object({ deliveryId: z.string().min(1) }), output: workerStateSchema });
