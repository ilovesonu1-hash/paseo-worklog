import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

/**
 * Plugin self-update for this host only. Paseo performs the update; Worklog
 * previews, records the intent, and confirms the result after its own reload.
 */
export const updateCheckSchema = z.object({
  checkedAt: z.string(),
  // "unsupported": the daemon lacks features.pluginSourceUpdates.
  outcome: z.enum(["update", "current", "installed-newer", "local", "error", "unsupported"]),
  currentRevision: z.string().nullable(),
  targetRevision: z.string().nullable(),
  compareUrl: z.string().nullable(),
  error: z.string().nullable(),
});
export type UpdateCheck = z.infer<typeof updateCheckSchema>;

export const pendingUpdateSchema = z.object({
  requestedAt: z.string(),
  fromRevision: z.string().nullable(),
  targetRevision: z.string(),
});
export type PendingUpdate = z.infer<typeof pendingUpdateSchema>;

export const updateResultSchema = z.object({
  at: z.string(),
  outcome: z.enum(["updated", "failed", "unknown"]),
  fromRevision: z.string().nullable(),
  targetRevision: z.string(),
  message: z.string().nullable(),
});
export type UpdateResult = z.infer<typeof updateResultSchema>;

export const updateStateSchema = z.object({
  check: updateCheckSchema.nullable().default(null),
  pending: pendingUpdateSchema.nullable().default(null),
  last: updateResultSchema.nullable().default(null),
});
export type UpdateState = z.infer<typeof updateStateSchema>;

export const updateStatusSchema = updateStateSchema.extend({ checking: z.boolean() });
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

export const applyUpdateResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), status: updateStatusSchema }),
  z.object({ ok: z.literal(false), code: z.enum(["changed", "unavailable", "busy"]), message: z.string(), status: updateStatusSchema }),
]);
export type ApplyUpdateResult = z.infer<typeof applyUpdateResultSchema>;

export const updateStatusRpc = defineRpc({ name: "updates.status", input: z.object({}), output: updateStatusSchema });
export const checkUpdateRpc = defineRpc({ name: "updates.check", input: z.object({}), output: updateStatusSchema });
/** The client sends the commit it showed the user; the server re-previews and applies only that commit. */
export const applyUpdateRpc = defineRpc({
  name: "updates.apply",
  input: z.object({ targetRevision: z.string().regex(/^[0-9a-f]{40,64}$/) }),
  output: applyUpdateResultSchema,
});
