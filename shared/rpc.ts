import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

export const SwarmMemberSchema = z.object({
  name: z.string(),
  conversationId: z.string(),
  model: z.string().nullable(),
  state: z.enum(["working", "waiting", "completed", "failed", "canceled", "stopped"]),
  updatedAt: z.number().nullable(),
});

export const SubagentItemSchema = z.object({
  id: z.string(),
  role: z.string(),
  typeName: z.string(),
  state: z.enum(["running", "completed", "failed", "canceled"]),
  updatedAt: z.number().nullable(),
});

export const BgTaskItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["command", "schedule"]),
  summary: z.string(),
  startedAt: z.number().nullable(),
});

export const AgentBgStatusSchema = z.object({
  agentId: z.string(),
  sessionId: z.string().nullable(),
  backgroundActive: z.boolean(),
  goalActive: z.boolean(),
  coordinatorState: z.enum([
    "idle",
    "swarm_wait",
    "wakeup_running",
    "background_hold",
    "stopped",
  ]),
  pillLabel: z.string(),
  summaryLine: z.string(),
  swarm: z
    .object({
      title: z.string().nullable(),
      working: z.number().int(),
      waiting: z.number().int(),
      completed: z.number().int(),
      members: z.array(SwarmMemberSchema),
    })
    .nullable(),
  subagents: z.array(SubagentItemSchema),
  tasks: z.array(BgTaskItemSchema),
  observedAt: z.number(),
});

export const agyLifecycleWatch = defineSubscription({
  name: "antigravity-lifecycle.watch",
  input: z.object({}),
  event: z.object({
    agents: z.record(z.string(), AgentBgStatusSchema),
  }),
});

export const agyLifecycleGet = defineRpc({
  name: "antigravity-lifecycle.get",
  input: z.object({
    agentId: z.string().min(1),
  }),
  output: AgentBgStatusSchema.nullable(),
});

export type SwarmMember = z.infer<typeof SwarmMemberSchema>;
export type SubagentItem = z.infer<typeof SubagentItemSchema>;
export type BgTaskItem = z.infer<typeof BgTaskItemSchema>;
export type AgentBgStatus = z.infer<typeof AgentBgStatusSchema>;
