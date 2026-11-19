import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

/** "확인함" on a session waiting for instructions, at the activity the user saw. */
export const sessionAckSchema = z.object({
  hostId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(256),
  activityAt: z.string().min(1).max(64),
});
export type SessionAck = z.infer<typeof sessionAckSchema>;

export const acksSnapshotSchema = z.object({ acks: z.array(sessionAckSchema) });
export type AcksSnapshot = z.infer<typeof acksSnapshotSchema>;

export const readAcksRpc = defineRpc({ name: "focus.acks", input: z.object({}), output: acksSnapshotSchema });
export const ackSessionsRpc = defineRpc({
  name: "focus.ack",
  input: z.object({ sessions: z.array(sessionAckSchema).min(1).max(500) }),
  output: acksSnapshotSchema,
});
