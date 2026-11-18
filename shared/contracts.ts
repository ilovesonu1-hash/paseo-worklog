import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { activitySchema, boardSchema, mutationSchema, mutationResultSchema, sessionSchema } from "./model.ts";

export const readBoardRpc = defineRpc({ name: "board.read", input: z.object({}), output: boardSchema });
export const mutateRpc = defineRpc({ name: "board.mutate", input: mutationSchema, output: mutationResultSchema });
export const observeSessionsRpc = defineRpc({
  name: "sessions.observe", input: z.object({ sessions: z.array(sessionSchema).max(2000) }),
  output: z.object({ changed: z.number().int().nonnegative() }),
});
export const activitiesRpc = defineRpc({
  name: "activities.list", input: z.object({ taskId: z.string().optional(), before: z.number().int().optional(), limit: z.number().int().min(1).max(500).default(100) }),
  output: z.object({ activities: z.array(activitySchema), hasMore: z.boolean() }),
});
export const exportRpc = defineRpc({
  name: "board.export", input: z.object({ format: z.enum(["json", "markdown"]) }),
  output: z.object({ path: z.string(), text: z.string() }),
});
