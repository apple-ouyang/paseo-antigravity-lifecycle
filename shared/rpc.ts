import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

export const AgyModeSchema = z.enum([
  "swarm",
  "teamwork",
  "boost",
  "workflow",
  "goal",
  "plan",
  "subagents",
  "tasks",
]);

export const AgyPrimaryModeSchema = z.enum([
  "swarm",
  "teamwork",
  "boost",
  "workflow",
  "goal",
  "plan",
  "subagents",
  "tasks",
  "idle",
]);

export const TeamworkPhaseSchema = z.enum([
  "interview",
  "planning",
  "executing",
  "auditing",
  "victory_audit",
  "completed",
  "failed",
  "idle",
]);

export const SubagentCategorySchema = z.enum([
  "orchestrator",
  "interviewer",
  "explorer",
  "worker",
  "reviewer",
  "challenger",
  "auditor",
  "victory_auditor",
  "boost",
  "research",
  "self",
  "other",
]);

export const StepProgressSchema = z.object({
  done: z.number().int(),
  total: z.number().int(),
});

export const ProgressSummarySchema = z.object({
  completed: z.number().int(),
  running: z.number().int(),
  waiting: z.number().int(),
  failed: z.number().int(),
  total: z.number().int(),
  percent: z.number().int().min(0).max(100),
  scopeLabel: z.string(),
  startedAt: z.number().nullable(),
  elapsedMs: z.number().int().nullable(),
  avgDurationMs: z.number().int().nullable(),
  etaMs: z.number().int().nullable(),
  etaState: z.enum(["estimating", "estimated", "over_avg", "done", "none"]),
});

export const SwarmMemberSchema = z.object({
  name: z.string(),
  conversationId: z.string(),
  model: z.string().nullable(),
  state: z.enum(["working", "waiting", "completed", "failed", "canceled", "stopped"]),
  updatedAt: z.number().nullable(),
  startedAt: z.number().nullable().optional(),
  durationMs: z.number().int().nullable().optional(),
  delivered: z.boolean().optional(),
  stepProgress: StepProgressSchema.nullable().optional(),
  workspaceMode: z.string().nullable().optional(),
  workspace: z.string().nullable().optional(),
  lastReadSeq: z.number().int().nullable().optional(),
  waitSince: z.number().int().nullable().optional(),
  lastActivity: z.string().nullable().optional(),
  stepCount: z.number().int().optional(),
});

export const SubagentItemSchema = z.object({
  id: z.string(),
  role: z.string(),
  typeName: z.string(),
  state: z.enum(["running", "completed", "failed", "canceled"]),
  updatedAt: z.number().nullable(),
  startedAt: z.number().nullable().optional(),
  durationMs: z.number().int().nullable().optional(),
  stepProgress: StepProgressSchema.nullable().optional(),
  parentId: z.string().nullable().optional(),
  depth: z.number().int().optional(),
  category: SubagentCategorySchema.optional(),
  model: z.string().nullable().optional(),
  lastActivity: z.string().nullable().optional(),
  stepCount: z.number().int().optional(),
  workspace: z.string().nullable().optional(),
});

export const BgTaskItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["command", "schedule"]),
  summary: z.string(),
  startedAt: z.number().nullable(),
});

export const TeamworkStatusSchema = z.object({
  active: z.boolean(),
  phase: TeamworkPhaseSchema,
  totalNodes: z.number().int(),
  runningNodes: z.number().int(),
  completedNodes: z.number().int(),
  failedNodes: z.number().int(),
  nodes: z.array(SubagentItemSchema),
});

export const PlanStepSchema = z.object({
  title: z.string(),
  status: z.enum(["pending", "in_progress", "done", "skipped", "failed"]),
});

export const PlanStatusSchema = z.object({
  inPlanMode: z.boolean(),
  completed: z.number().int(),
  total: z.number().int(),
  steps: z.array(PlanStepSchema),
});

export const WorkflowRunSchema = z.object({
  id: z.string(),
  description: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  startedAt: z.number().nullable(),
});

export const SwarmPlanSchema = z.object({
  goal: z
    .object({
      title: z.string(),
      line: z.string(),
    })
    .nullable(),
  tasks: z.record(z.string(), z.string()),
  threads: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      goal: z.string(),
      tasks: z.array(z.string()),
    }),
  ),
});

export const SwarmBoardPostSchema = z.object({
  seq: z.number().int(),
  agent: z.string(),
  text: z.string(),
  time: z.string().nullable(),
  mentions: z.array(z.string()),
  screenshots: z.array(
    z.object({
      path: z.string(),
      caption: z.string(),
    }),
  ),
});

export const TranscriptStepSchema = z.object({
  stepIndex: z.number().int(),
  kind: z.enum(["user", "thinking", "tool", "assistant", "system", "error"]),
  title: z.string(),
  summary: z.string(),
  status: z.string().nullable(),
  createdAt: z.string().nullable(),
  model: z.string().nullable(),
  hasDetail: z.boolean().optional(),
});

export const ChildStepDiffLineSchema = z.object({
  kind: z.enum(["ctx", "add", "del", "hunk"]),
  text: z.string(),
  oldLine: z.number().int().nullable().optional(),
  newLine: z.number().int().nullable().optional(),
});

export const ChildStepDiffSchema = z.object({
  path: z.string(),
  mode: z.enum(["edit", "write", "append"]),
  addedLines: z.number().int(),
  removedLines: z.number().int(),
  lines: z.array(ChildStepDiffLineSchema),
  truncated: z.boolean().optional(),
  totalLines: z.number().int().optional(),
});

export const ChildStepToolDetailSchema = z.object({
  name: z.string(),
  summary: z.string(),
  subtitle: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  diff: ChildStepDiffSchema.nullable().optional(),
  primaryText: z.string().nullable(),
  argsText: z.string().nullable(),
  output: z.string().nullable(),
  outputStatus: z.string().nullable(),
});

export const ChildStepDetailSchema = z.object({
  conversationId: z.string(),
  stepIndex: z.number().int(),
  type: z.string(),
  status: z.string().nullable(),
  createdAt: z.string().nullable(),
  model: z.string().nullable(),
  content: z.string().nullable(),
  thinking: z.string().nullable(),
  toolCalls: z.array(ChildStepToolDetailSchema),
  truncated: z.boolean(),
});

export const AgentBgStatusSchema = z.object({
  agentId: z.string(),
  sessionId: z.string().nullable(),
  backgroundActive: z.boolean(),
  goalActive: z.boolean(),
  goalSummary: z.string().nullable().optional(),
  boostActive: z.boolean().optional(),
  modes: z.array(AgyModeSchema).optional(),
  primaryMode: AgyPrimaryModeSchema.optional(),
  hasConsoleData: z.boolean().optional(),
  progress: ProgressSummarySchema.nullable().optional(),
  coordinatorState: z.enum([
    "idle",
    "swarm_wait",
    "wakeup_running",
    "background_hold",
    "stopped",
  ]),
  coordinator: z
    .object({
      conversationId: z.string(),
      model: z.string().nullable(),
      lastActivity: z.string().nullable(),
      stepCount: z.number().int(),
    })
    .nullable()
    .optional(),
  pillLabel: z.string(),
  summaryLine: z.string(),
  swarm: z
    .object({
      title: z.string().nullable(),
      working: z.number().int(),
      waiting: z.number().int(),
      completed: z.number().int(),
      boardCount: z.number().int().optional(),
      latestSeq: z.number().int().optional(),
      planGoal: z
        .object({
          title: z.string(),
          line: z.string(),
        })
        .nullable()
        .optional(),
      members: z.array(SwarmMemberSchema),
    })
    .nullable(),
  teamwork: TeamworkStatusSchema.nullable().optional(),
  plan: PlanStatusSchema.nullable().optional(),
  workflows: z.array(WorkflowRunSchema).optional(),
  subagents: z.array(SubagentItemSchema),
  tasks: z.array(BgTaskItemSchema),
  observedAt: z.number(),
});

export const AgyConsoleDetailSchema = z.object({
  status: AgentBgStatusSchema,
  swarmPlan: SwarmPlanSchema.nullable(),
  boardPosts: z.array(SwarmBoardPostSchema),
  boardTotal: z.number().int(),
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

export const agyConsoleGet = defineRpc({
  name: "antigravity-lifecycle.console.get",
  input: z.object({
    agentId: z.string().min(1),
    boardLimit: z.number().int().min(1).max(500).optional(),
  }),
  output: AgyConsoleDetailSchema.nullable(),
});

export const agyBoardSliceGet = defineRpc({
  name: "antigravity-lifecycle.board.slice",
  input: z.object({
    agentId: z.string().min(1),
    since: z.number().int().min(0),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  output: z.object({
    posts: z.array(SwarmBoardPostSchema),
    latestSeq: z.number().int(),
  }),
});

export const agyChildTranscriptGet = defineRpc({
  name: "antigravity-lifecycle.child.transcript",
  input: z.object({
    agentId: z.string().min(1),
    conversationId: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
    afterCursor: z.number().int().min(0).optional(),
  }),
  output: z
    .object({
      conversationId: z.string(),
      model: z.string().nullable(),
      steps: z.array(TranscriptStepSchema),
      totalSteps: z.number().int(),
      cursor: z.number().int(),
      mode: z.enum(["full", "delta"]),
      unchanged: z.boolean(),
    })
    .nullable(),
});

export const agyChildStepDetailGet = defineRpc({
  name: "antigravity-lifecycle.child.step.detail",
  input: z.object({
    agentId: z.string().min(1),
    conversationId: z.string().min(1),
    stepIndex: z.number().int().min(0),
  }),
  output: ChildStepDetailSchema.nullable(),
});

export const agySwarmSendMessage = defineRpc({
  name: "antigravity-lifecycle.swarm.send",
  input: z.object({
    agentId: z.string().min(1),
    text: z.string().min(1).max(16_000),
    targetMember: z.string().min(1).max(64).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    method: z.enum(["agentapi", "hook_inbox", "paseo_send"]),
    pendingCount: z.number().int().optional(),
    error: z.string().optional(),
  }),
});

export type ChildTranscriptResponse = NonNullable<
  z.infer<typeof agyChildTranscriptGet.output>
>;
export type ChildStepDiffLine = z.infer<typeof ChildStepDiffLineSchema>;
export type ChildStepDiff = z.infer<typeof ChildStepDiffSchema>;
export type ChildStepToolDetail = z.infer<typeof ChildStepToolDetailSchema>;
export type ChildStepDetail = z.infer<typeof ChildStepDetailSchema>;

export type AgyMode = z.infer<typeof AgyModeSchema>;
export type AgyPrimaryMode = z.infer<typeof AgyPrimaryModeSchema>;
export type TeamworkPhase = z.infer<typeof TeamworkPhaseSchema>;
export type SubagentCategory = z.infer<typeof SubagentCategorySchema>;
export type StepProgress = z.infer<typeof StepProgressSchema>;
export type ProgressSummary = z.infer<typeof ProgressSummarySchema>;
export type SwarmMember = z.infer<typeof SwarmMemberSchema>;
export type SubagentItem = z.infer<typeof SubagentItemSchema>;
export type BgTaskItem = z.infer<typeof BgTaskItemSchema>;
export type TeamworkStatus = z.infer<typeof TeamworkStatusSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanStatus = z.infer<typeof PlanStatusSchema>;
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
export type SwarmPlan = z.infer<typeof SwarmPlanSchema>;
export type SwarmBoardPost = z.infer<typeof SwarmBoardPostSchema>;
export type TranscriptStep = z.infer<typeof TranscriptStepSchema>;
export type AgentBgStatus = z.infer<typeof AgentBgStatusSchema>;
export type AgyConsoleDetail = z.infer<typeof AgyConsoleDetailSchema>;
