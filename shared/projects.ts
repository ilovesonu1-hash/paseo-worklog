import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";
import { sessionSchema, taskSchema } from "./model.ts";

/**
 * Project grouping: link a folder's recent unlinked sessions to one task and,
 * optionally, keep linking that folder's new sessions to it as they appear.
 * A folder is matched by its last path segment, case-insensitively, on any PC.
 */
export const autoLinkRuleSchema = z.object({
  /** Lower-cased folder name. */
  folder: z.string().min(1).max(200),
  /** The folder name as shown. */
  label: z.string().min(1).max(200),
  taskId: z.string().min(1),
  /** Only sessions active after this are auto-linked; older ones stay where they are. */
  createdAt: z.string(),
});
export type AutoLinkRule = z.infer<typeof autoLinkRuleSchema>;
export const autoLinkRulesSchema = z.object({ rules: z.array(autoLinkRuleSchema) });

export const groupProjectRpc = defineRpc({
  name: "projects.group",
  input: z.object({
    requestId: z.string().min(8).max(200),
    folder: z.string().trim().min(1).max(200),
    /** Existing task to link into; omitted creates a task named after the folder. */
    taskId: z.string().min(1).optional(),
    sessions: z.array(sessionSchema).max(500),
    autoLink: z.boolean(),
  }),
  output: z.object({ task: taskSchema, linked: z.number().int().nonnegative(), rule: autoLinkRuleSchema.nullable() }),
});
export const autoLinkRulesRpc = defineRpc({ name: "autolink.rules", input: z.object({}), output: autoLinkRulesSchema });
export const removeAutoLinkRpc = defineRpc({ name: "autolink.remove", input: z.object({ folder: z.string().min(1).max(200) }), output: autoLinkRulesSchema });
