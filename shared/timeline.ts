import { z } from "zod";

export const AgyToolCategorySchema = z.enum([
  "swarm_post",
  "swarm_action",
  "swarm_read",
  "swarm_wait",
  "subagent_invoke",
  "subagent_message",
  "subagent_manage",
  "workflow",
  "steps",
  "plan_mode",
  "schedule",
  "task_manage",
  "question",
  "generic",
]);

export const AgyQuestionItemSchema = z.object({
  question: z.string(),
  options: z.array(z.string()),
  isMultiSelect: z.boolean(),
});

export const AgyToolCardSchema = z.object({
  callId: z.string().optional(),
  toolKey: z.string(),
  category: AgyToolCategorySchema,
  status: z.enum(["running", "completed", "failed", "canceled"]),
  badge: z.string(),
  headline: z.string(),
  subline: z.string().nullable(),
  accent: z.enum(["accent", "success", "warning", "danger", "muted"]),
  body: z.string().nullable(),
  mentions: z.array(z.string()),
  boardSince: z.number().int().nullable(),
  steps: z
    .array(
      z.object({
        title: z.string(),
        status: z.string(),
      }),
    )
    .nullable(),
  questions: z.array(AgyQuestionItemSchema).nullable().optional(),
  questionAnswer: z.string().nullable().optional(),
  targetMember: z.string().nullable().optional(),
  targetSubagentId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  canOpenConsole: z.boolean(),
});

export type AgyToolCategory = z.infer<typeof AgyToolCategorySchema>;
export type AgyQuestionItem = z.infer<typeof AgyQuestionItemSchema>;
export type AgyToolCardData = z.infer<typeof AgyToolCardSchema>;
