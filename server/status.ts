import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  AgentBgStatus,
  AgyMode,
  AgyPrimaryMode,
  BgTaskItem,
  PlanStatus,
  PlanStep,
  ProgressSummary,
  StepProgress,
  SubagentCategory,
  SubagentItem,
  SwarmMember,
  TeamworkPhase,
  TeamworkStatus,
  WorkflowRun,
} from "../shared/rpc.ts";

export interface InspectAgySessionInput {
  agentId: string;
  sessionId: string | null;
  agentAlive: boolean;
  homeDir?: string;
  now?: number;
  isPidAlive?: (pid: number) => boolean;
}

export interface TranscriptRow {
  step_index?: number;
  type?: string;
  status?: string;
  created_at?: string;
  model?: string;
  content?: string;
  thinking?: string;
  truncated_fields?: string[];
  tool_calls?: Array<{
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  }>;
}

interface HookStateJson {
  conversationId?: string;
  event?: string;
  fullyIdle?: boolean;
  pid?: number;
  ts?: number;
}

interface ProcessStateJson {
  conversationId?: string;
  pid?: number;
  event?: string;
  ts?: number;
}

interface RawSwarmMember {
  conversation_id?: string;
  role?: string;
  desired_state?: string;
  phase?: string;
  wake_mode?: string;
  workspace_mode?: string;
  workspace?: string;
  wait_since?: number;
  last_read_seq?: number;
  last_nudged_seq?: number;
  killed?: boolean;
  model?: string;
}

interface RawSwarmMembersFile {
  title?: string;
  members?: Record<string, RawSwarmMember>;
}

interface RawSwarmPlanFile {
  goal?: {
    title?: string;
    line?: string;
  };
  tasks?: Record<string, string>;
  threads?: Array<{
    tasks?: string[];
  }>;
}

interface RawSubagentFile {
  conversationId?: string;
  state?: string;
  workspaceUris?: string[];
  subagentDescriptor?: {
    typeName?: string;
    role?: string;
  };
}

interface ChildConvStatus {
  lastType: string | null;
  lastStatus: string | null;
  firstTs: number | null;
  lastTs: number | null;
  model: string | null;
  lastActivity: string | null;
  stepCount: number;
  stepProgress: StepProgress | null;
  turnEnded: boolean | null;
  hasAskQ: boolean;
  stopIdle: boolean;
  stopBusy: boolean;
  hasOpenTask: boolean;
  freshestMtimeMs: number;
}

interface RawTreeNode {
  id: string;
  parentId: string | null;
  depth: number;
  isTeamworkBranch: boolean;
  raw: RawSubagentFile;
  child: ChildConvStatus;
}

const STALE_NO_PID_MS = 65 * 60_000;
const HOOK_RACE_GRACE_MS = 5_000;
const WAKEUP_MID_WINDOW_MS = 90_000;
const MAX_SUBAGENT_TREE_DEPTH = 5;
const MAX_SUBAGENT_TREE_NODES = 120;
const MAX_TRANSCRIPT_ROWS_CACHE = 300;
const MAX_BOARD_META_CACHE = 60;

interface CachedRowsEntry {
  ino: number;
  size: number;
  mtimeMs: number;
  rows: TranscriptRow[];
  lastAccessedAt: number;
}

interface CachedBoardMetaEntry {
  ino: number;
  size: number;
  mtimeMs: number;
  meta: {
    count: number;
    latestSeq: number;
    mtimeMs: number;
    doneAgents: Set<string>;
  };
  lastAccessedAt: number;
}

const transcriptRowsCache = new Map<string, CachedRowsEntry>();
const boardMetaCache = new Map<string, CachedBoardMetaEntry>();

export function clearStatusCaches(): void {
  transcriptRowsCache.clear();
  boardMetaCache.clear();
}

function evictLru<T extends { lastAccessedAt: number }>(map: Map<string, T>, max: number): void {
  if (map.size <= max) return;
  let oldestKey: string | null = null;
  let oldestTs = Infinity;
  for (const [k, v] of map) {
    if (v.lastAccessedAt < oldestTs) {
      oldestTs = v.lastAccessedAt;
      oldestKey = k;
    }
  }
  if (oldestKey) map.delete(oldestKey);
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

export function readJsonSafe<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function readMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function parseIsoMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function cleanArg(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    trimmed === "true" ||
    trimmed === "false" ||
    /^-?\d+(?:\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }
  if (trimmed.startsWith('"') && !trimmed.endsWith('"')) {
    return trimmed.slice(1).replace(/\\n/g, " ").replace(/\\"/g, '"');
  }
  return value;
}

export function readTranscriptRows(transcriptPath: string): TranscriptRow[] {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(transcriptPath);
  } catch {
    transcriptRowsCache.delete(transcriptPath);
    return [];
  }
  const now = Date.now();
  const cached = transcriptRowsCache.get(transcriptPath);
  if (cached && cached.ino === st.ino && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
    cached.lastAccessedAt = now;
    return cached.rows;
  }

  let raw = "";
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }
  const rows: TranscriptRow[] = [];
  if (raw.trim()) {
    const stepMap = new Map<number, number>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as TranscriptRow;
        if (!obj || typeof obj !== "object") continue;
        if (typeof obj.step_index === "number") {
          const existing = stepMap.get(obj.step_index);
          if (existing !== undefined) {
            rows[existing] = obj;
            continue;
          }
          stepMap.set(obj.step_index, rows.length);
        }
        rows.push(obj);
      } catch {
        // Ignore partial line while agy appends to transcript.jsonl.
      }
    }
  }
  transcriptRowsCache.set(transcriptPath, {
    ino: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
    rows,
    lastAccessedAt: now,
  });
  evictLru(transcriptRowsCache, MAX_TRANSCRIPT_ROWS_CACHE);
  return rows;
}

function truncateLine(text: string, maxLen = 84): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= maxLen) return single;
  return `${single.slice(0, maxLen - 1)}…`;
}

function formatWorkspaceUri(uri: string | undefined): string | null {
  if (!uri) return null;
  return uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri;
}

export function summarizeToolCall(tc: {
  name?: string;
  args?: Record<string, unknown>;
}): string {
  const name = tc.name ?? "tool";
  const args = tc.args ?? {};
  switch (name) {
    case "run_command": {
      const summary = cleanArg(args.toolSummary) ?? cleanArg(args.CommandLine);
      return summary ? `命令: ${truncateLine(String(summary), 64)}` : "执行命令";
    }
    case "read_file": {
      const p = cleanArg(args.Path);
      return p ? `读取 ${path.basename(String(p))}` : "读取文件";
    }
    case "edit_file":
    case "write_file": {
      const p = cleanArg(args.Path);
      return p
        ? `${name === "edit_file" ? "编辑" : "写入"} ${path.basename(String(p))}`
        : name === "edit_file"
          ? "编辑文件"
          : "写入文件";
    }
    case "post_message": {
      const txt = cleanArg(args.text);
      return txt ? `发帖: ${truncateLine(String(txt), 60)}` : "发帖到消息板";
    }
    case "read_board": {
      const since = cleanArg(args.since);
      return since !== undefined ? `读取消息板 (> #${since})` : "读取消息板";
    }
    case "swarm_wait": {
      const since = cleanArg(args.since);
      return since !== undefined ? `等待消息板 (> #${since})` : "等待消息板唤醒";
    }
    case "swarm": {
      const action = cleanArg(args.action);
      const target = cleanArg(args.name);
      return target ? `swarm ${action}: ${target}` : `swarm ${action ?? ""}`.trim();
    }
    case "invoke_subagent": {
      const role = cleanArg(args.Role) ?? cleanArg(args.TypeName);
      return role ? `派发子代理: ${truncateLine(String(role), 50)}` : "派发子代理";
    }
    case "send_message": {
      const msg = cleanArg(args.Message);
      return msg ? `发消息: ${truncateLine(String(msg), 56)}` : "发送消息";
    }
    case "run_workflow": {
      const desc = cleanArg(args.Description);
      return desc ? `Workflow: ${truncateLine(String(desc), 56)}` : "运行 Workflow";
    }
    default:
      return name;
  }
}

function summarizeRecentActivity(rows: TranscriptRow[]): {
  model: string | null;
  lastActivity: string | null;
} {
  let model: string | null = null;
  let lastActivity: string | null = null;
  let fallbackActivity: string | null = null;
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 20); i -= 1) {
    const r = rows[i];
    if (!model && typeof r.model === "string" && r.model.length > 0) {
      model = r.model;
    }
    if (!lastActivity) {
      if (r.type === "ERROR_MESSAGE") {
        lastActivity = `错误: ${truncateLine(r.content ?? "执行失败", 68)}`;
      } else if (r.type === "PLANNER_RESPONSE") {
        if (r.tool_calls && r.tool_calls.length > 0) {
          const substantive = [...r.tool_calls]
            .reverse()
            .find((tc) => tc.name !== "swarm_wait" && tc.name !== "read_board");
          if (substantive) {
            lastActivity = summarizeToolCall(substantive);
          } else if (!fallbackActivity) {
            fallbackActivity = summarizeToolCall(r.tool_calls[r.tool_calls.length - 1]);
          }
        } else if (r.content && r.content.trim().length > 0) {
          lastActivity = truncateLine(r.content, 72);
        } else if (r.thinking && r.thinking.trim().length > 0 && !fallbackActivity) {
          fallbackActivity = `思考: ${truncateLine(r.thinking, 64)}`;
        }
      }
    }
    if (model && lastActivity) break;
  }
  return { model, lastActivity: lastActivity ?? fallbackActivity };
}

function extractOpenBgTasks(
  rows: TranscriptRow[],
  luIndex: number,
  sessionId: string,
  bdir: string,
): BgTaskItem[] {
  const tasks: BgTaskItem[] = [];
  if (luIndex < 0) return tasks;

  for (let i = luIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.type !== "GENERIC") continue;
    const content = row.content ?? "";
    const match = /background task with task id:\s*(\S+)/.exec(content);
    if (!match || !match[1].startsWith(sessionId)) continue;
    const taskId = match[1];

    let p = i - 1;
    while (p > luIndex && rows[p].type !== "PLANNER_RESPONSE") p -= 1;
    const toolCalls = p > luIndex ? rows[p].tool_calls ?? [] : [];
    const tc = toolCalls[i - p - 1] ?? toolCalls[0];
    const isDaemon = String(cleanArg(tc?.args?.IsDaemon) ?? "").toLowerCase() === "true";
    if (isDaemon) continue;

    const timerCond = String(cleanArg(tc?.args?.TimerCondition) ?? "");
    let done = false;
    for (let j = i + 1; j < rows.length; j += 1) {
      const jc = rows[j].content ?? "";
      if (
        rows[j].type === "SYSTEM_MESSAGE" &&
        (jc.includes(taskId) ||
          jc.includes("tasks have been stopped") ||
          timerCond === "any" ||
          (timerCond.length > 0 && timerCond !== "never" && jc.includes(timerCond)))
      ) {
        done = true;
        break;
      }
      if (
        rows[j].type === "GENERIC" &&
        jc.includes(taskId) &&
        /cancelled|canceled|killed|not found|completed|finished|stopped/i.test(jc)
      ) {
        done = true;
        break;
      }
    }
    if (!done && typeof row.step_index === "number") {
      try {
        const stepOut = readFileSync(
          path.join(bdir, "steps", String(row.step_index), "output.txt"),
          "utf8",
        );
        if (/terminated by signal|canceled/i.test(stepOut)) done = true;
      } catch {
        // step output file may not exist
      }
    }
    if (done) continue;

    const tcName = tc?.name ?? "";
    const kind: "command" | "schedule" = tcName === "schedule" ? "schedule" : "command";
    const summaryRaw =
      cleanArg(tc?.args?.toolSummary) ??
      cleanArg(tc?.args?.CommandLine) ??
      cleanArg(tc?.args?.Prompt) ??
      (kind === "schedule" ? "schedule 定时器" : "后台命令");
    const summary = String(summaryRaw).slice(0, 80);
    tasks.push({
      id: taskId,
      kind,
      summary,
      startedAt: parseIsoMs(row.created_at),
    });
  }

  return tasks;
}

function hasSystemWakeupAfter(rows: TranscriptRow[], luIndex: number): boolean {
  for (let i = luIndex + 1; i < rows.length; i += 1) {
    const r = rows[i];
    const p = rows[i - 1];
    if (r.type !== "SYSTEM_MESSAGE" || !p) continue;
    if (
      (p.type === "PLANNER_RESPONSE" && !(p.tool_calls && p.tool_calls.length > 0)) ||
      p.type === "GENERIC"
    ) {
      const tsMatch = /timestamp=(\S+)/.exec(r.content ?? "");
      const rowTs = parseIsoMs(r.created_at);
      if (!tsMatch || rowTs === null) return true;
      const msgTs = parseIsoMs(tsMatch[1]);
      if (msgTs !== null && Math.abs(msgTs - rowTs) <= 1500) return true;
      if ((r.content ?? "").includes("[swarm]") || (r.content ?? "").includes("[board]")) {
        return true;
      }
    }
  }
  return false;
}

function detectGoal(
  rows: TranscriptRow[],
  bdir: string,
): { active: boolean; summary: string | null } {
  let lastGoalUserIdx = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i];
    if (r.type === "USER_INPUT") {
      const content = r.content ?? "";
      if (content.includes("/goal is a [Slash Command]") || /(?:^|\n)\s*\/goal\b/.test(content)) {
        lastGoalUserIdx = i;
        break;
      }
    }
  }
  if (lastGoalUserIdx < 0) return { active: false, summary: null };

  let userContent = rows[lastGoalUserIdx].content ?? "";
  let confirmed =
    userContent.includes("/goal is a [Slash Command]") || /(?:^|\n)\s*\/goal\b/.test(userContent);
  if (!confirmed) {
    const fullRows = readTranscriptRows(path.join(bdir, "logs", "transcript_full.jsonl"));
    const targetStep = rows[lastGoalUserIdx].step_index;
    const match = fullRows.find(
      (fr) =>
        (targetStep !== undefined ? fr.step_index === targetStep : fr.type === "USER_INPUT") &&
        (fr.content ?? "").includes("/goal is a [Slash Command]"),
    );
    if (match) {
      confirmed = true;
      userContent = match.content ?? userContent;
    }
  }
  if (!confirmed) return { active: false, summary: null };

  for (let i = lastGoalUserIdx + 1; i < rows.length; i += 1) {
    const r = rows[i];
    if (r.type === "USER_INPUT") {
      const content = r.content ?? "";
      if (/(?:^|\n)\s*\/goal\s+(?:clear|stop|cancel|off)\b/i.test(content)) {
        return { active: false, summary: null };
      }
    }
    if (r.type === "PLANNER_RESPONSE" && (r.content ?? "").includes("<!-- GOAL_COMPLETE -->")) {
      return { active: false, summary: null };
    }
  }

  const m = /\/goal\s+([^\n<]+)/.exec(userContent);
  const summary = m?.[1]?.trim() ? truncateLine(m[1].trim(), 90) : null;
  return { active: true, summary };
}

function detectBoostActive(rows: TranscriptRow[], luIndex: number, allNodes: SubagentItem[]): boolean {
  if (allNodes.some((n) => n.category === "boost" && n.state === "running")) {
    return true;
  }
  if (luIndex < 0) return false;
  for (let i = rows.length - 1; i >= Math.max(0, luIndex - 2); i -= 1) {
    const r = rows[i];
    if (r.type === "USER_INPUT") {
      const c = r.content ?? "";
      if (c.includes("/boost is a [Slash Command]") || /(?:^|\n)\s*\/boost\b/.test(c)) {
        return true;
      }
      break;
    }
  }
  return false;
}

function extractPlanStatus(rows: TranscriptRow[]): PlanStatus | null {
  let inPlanMode = false;
  let steps: PlanStep[] = [];
  let sawPlanEvent = false;
  const validStatuses = new Set(["pending", "in_progress", "done", "skipped", "failed"]);

  for (const r of rows) {
    if (r.type !== "PLANNER_RESPONSE" || !r.tool_calls) continue;
    for (const tc of r.tool_calls) {
      if (tc.name === "enter_plan_mode") {
        inPlanMode = true;
        sawPlanEvent = true;
      } else if (tc.name === "exit_plan_mode") {
        inPlanMode = false;
        sawPlanEvent = true;
      } else if (tc.name === "update_steps") {
        const rawSteps = cleanArg(tc.args?.steps);
        if (Array.isArray(rawSteps)) {
          const parsed: PlanStep[] = [];
          for (const item of rawSteps) {
            if (!item || typeof item !== "object") continue;
            const rec = item as Record<string, unknown>;
            const title = typeof rec.title === "string" ? rec.title.trim() : "";
            const statusRaw = typeof rec.status === "string" ? rec.status : "pending";
            if (!title) continue;
            parsed.push({
              title,
              status: (validStatuses.has(statusRaw) ? statusRaw : "pending") as PlanStep["status"],
            });
          }
          if (parsed.length > 0) {
            steps = parsed;
            sawPlanEvent = true;
          }
        }
      }
    }
  }

  if (!sawPlanEvent) return null;
  const completed = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  return {
    inPlanMode,
    completed,
    total: steps.length,
    steps,
  };
}

function extractWorkflowRuns(rows: TranscriptRow[], runtimeAlive: boolean): WorkflowRun[] {
  const runs: WorkflowRun[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (r.type !== "PLANNER_RESPONSE" || !r.tool_calls) continue;
    for (let tcIdx = 0; tcIdx < r.tool_calls.length; tcIdx += 1) {
      const tc = r.tool_calls[tcIdx];
      if (tc.name !== "run_workflow") continue;
      const desc =
        String(cleanArg(tc.args?.Description) ?? cleanArg(tc.args?.ScriptPath) ?? "Workflow").slice(
          0,
          100,
        );
      const id = tc.id ?? `wf-${r.step_index ?? i}-${tcIdx}`;
      let status: WorkflowRun["status"] = runtimeAlive ? "running" : "completed";
      const nextGeneric = rows[i + 1 + tcIdx];
      if (nextGeneric?.type === "GENERIC") {
        const gc = nextGeneric.content ?? "";
        if (/error|failed|exception|traceback/i.test(gc) && !/background/i.test(gc)) {
          status = "failed";
        } else if (!/running in the background|background task/i.test(gc)) {
          status = "completed";
        } else {
          // Check later SYSTEM_MESSAGE for completion
          for (let j = i + 2; j < rows.length; j += 1) {
            if (rows[j].type === "SYSTEM_MESSAGE") {
              const sc = rows[j].content ?? "";
              if (/workflow.*(failed|error)/i.test(sc)) {
                status = "failed";
                break;
              }
              if (/workflow.*(completed|finished|done)/i.test(sc)) {
                status = "completed";
                break;
              }
            }
          }
        }
      }
      runs.push({
        id,
        description: desc,
        status,
        startedAt: parseIsoMs(r.created_at),
      });
    }
  }
  return runs;
}

function classifySubagentCategory(typeName: string, role: string): SubagentCategory {
  const t = typeName.toLowerCase();
  const r = role.toLowerCase();
  if (t === "teamwork_victory_auditor" || r.includes("victory auditor")) return "victory_auditor";
  if (t === "teamwork_interviewer" || r.includes("interviewer")) return "interviewer";
  if (
    t === "teamwork" ||
    t === "teamwork_orchestrator" ||
    r.includes("orchestrator") ||
    r.includes("sentinel")
  ) {
    return "orchestrator";
  }
  if (t === "teamwork_challenger" || r.includes("challenger")) return "challenger";
  if (t === "teamwork_auditor" || r.includes("auditor")) return "auditor";
  if (t === "teamwork_reviewer" || r.includes("reviewer") || r.includes("critic")) return "reviewer";
  if (t === "teamwork_explorer" || r.includes("explorer") || t === "teamwork_spec_miner") {
    return "explorer";
  }
  if (t === "teamwork_worker" || t === "teamwork_test_writer" || t === "worker") return "worker";
  if (
    t.includes("boost") ||
    r.includes("deepcoder") ||
    r.includes("deepinvestigator") ||
    r.includes("pipeline coordinator")
  ) {
    return "boost";
  }
  if (t === "research") return "research";
  if (t === "self") return "self";
  return "other";
}

function isTeamworkDescriptor(typeName: string, role: string): boolean {
  const t = typeName.toLowerCase();
  const r = role.toLowerCase();
  return (
    t.startsWith("teamwork") ||
    r.includes("teamwork") ||
    r.includes("project orchestrator") ||
    r.includes("victory auditor") ||
    r.includes("task interviewer")
  );
}

/**
 * Mirrors official Antigravity swarm_board `turnEnded(lines)`:
 * A member's turn has ended (idle/waiting) ONLY when the newest transcript step is:
 *  - a completed PLANNER_RESPONSE with no tool calls, OR
 *  - tool results (GENERIC) for a PLANNER_RESPONSE batch that included `swarm_wait`
 *    once `swarm_wait`'s own result is DONE.
 * Any newer SYSTEM_MESSAGE (board wakeup / background task completion), USER_INPUT,
 * or non-wait tool result batch means the model is actively mid-turn (working).
 */
function isTranscriptTurnEnded(rows: TranscriptRow[]): boolean | null {
  if (rows.length === 0) return null;
  const results: TranscriptRow[] = [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const step = rows[i];
    if (step.type === "GENERIC") {
      results.unshift(step);
      continue;
    }
    if (step.type !== "PLANNER_RESPONSE") return false;
    if (step.status && step.status !== "DONE") return false;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    if (calls.length === 0) return results.length === 0;
    const waitIdx = calls.findIndex((c) => c?.name === "swarm_wait");
    return waitIdx >= 0 && results.length >= calls.length && results[waitIdx]?.status === "DONE";
  }
  return false;
}

function inspectChildConv(brainRoot: string, conversationId: string): ChildConvStatus {
  const cbdir = path.join(brainRoot, conversationId, ".system_generated");
  const txPath = path.join(cbdir, "logs", "transcript.jsonl");
  const hsPath = path.join(cbdir, "logs", "hook-state.json");
  const procPath = path.join(cbdir, "logs", "process.json");

  const hs = readJsonSafe<HookStateJson>(hsPath);
  const rows = readTranscriptRows(txPath);
  const fr = rows.length > 0 ? rows[0] : null;
  const lr = rows.length > 0 ? rows[rows.length - 1] : null;
  const firstTs = parseIsoMs(fr?.created_at);
  const lastTs = parseIsoMs(lr?.created_at);

  let lu = -1;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].type === "USER_INPUT") lu = i;
  }
  const hasAskQ =
    lr?.type === "PLANNER_RESPONSE" &&
    lr.status === "DONE" &&
    Boolean(lr.tool_calls?.some((x) => x.name === "ask_question"));
  const openTasks = extractOpenBgTasks(rows, lu, conversationId, cbdir);
  const hsFresh = Boolean(hs?.ts && (!lastTs || hs.ts >= lastTs - 2_000));
  const stopIdle = Boolean(!hasAskQ && hs?.event === "Stop" && hs.fullyIdle === true && hsFresh);
  const stopBusy = Boolean(!hasAskQ && hs?.event === "Stop" && hs.fullyIdle === false && hsFresh);
  const { model, lastActivity } = summarizeRecentActivity(rows);
  const childPlan = extractPlanStatus(rows);
  const stepProgress =
    childPlan && childPlan.total > 0
      ? { done: childPlan.completed, total: childPlan.total }
      : null;
  const turnEnded = isTranscriptTurnEnded(rows);

  return {
    lastType: lr?.type ?? null,
    lastStatus: lr?.status ?? null,
    firstTs,
    lastTs,
    model,
    lastActivity,
    stepCount: rows.length,
    stepProgress,
    turnEnded,
    hasAskQ,
    stopIdle,
    stopBusy,
    hasOpenTask: openTasks.length > 0,
    freshestMtimeMs: Math.max(readMtimeMs(txPath), readMtimeMs(hsPath), readMtimeMs(procPath)),
  };
}

function scanSubagentTree(
  brainRoot: string,
  rootSessionId: string,
  swarmConvIds: Set<string>,
): { nodes: RawTreeNode[]; freshestMtimeMs: number } {
  const nodes: RawTreeNode[] = [];
  const visited = new Set<string>([rootSessionId]);
  let freshestMtimeMs = 0;

  const walk = (parentId: string, depth: number, inheritedTeamwork: boolean) => {
    if (depth > MAX_SUBAGENT_TREE_DEPTH || nodes.length >= MAX_SUBAGENT_TREE_NODES) return;
    const subagentsDir = path.join(brainRoot, parentId, ".system_generated", "subagents");
    let files: string[];
    try {
      files = readdirSync(subagentsDir)
        .filter((f) => f.endsWith(".json"))
        .sort();
    } catch {
      return;
    }

    for (const file of files) {
      if (nodes.length >= MAX_SUBAGENT_TREE_NODES) break;
      const raw = readJsonSafe<RawSubagentFile>(path.join(subagentsDir, file));
      const cid = raw?.conversationId;
      if (!cid || visited.has(cid)) continue;
      if (depth === 0 && swarmConvIds.has(cid)) continue;
      visited.add(cid);

      const typeName = raw.subagentDescriptor?.typeName ?? "subagent";
      const role = raw.subagentDescriptor?.role ?? cid.slice(0, 8);
      const isTeamworkBranch = inheritedTeamwork || isTeamworkDescriptor(typeName, role);
      const child = inspectChildConv(brainRoot, cid);
      if (child.freshestMtimeMs > freshestMtimeMs) freshestMtimeMs = child.freshestMtimeMs;
      if (child.lastTs && child.lastTs > freshestMtimeMs) freshestMtimeMs = child.lastTs;

      nodes.push({
        id: cid,
        parentId: depth === 0 ? null : parentId,
        depth,
        isTeamworkBranch,
        raw,
        child,
      });

      walk(cid, depth + 1, isTeamworkBranch);
    }
  };

  walk(rootSessionId, 0, false);
  return { nodes, freshestMtimeMs };
}

const ROLE_WORKER_RE = /^(?:narrator|monitor)(?:-\d+)?$/i;
const DONE_POST_RE =
  /^(@[A-Za-z0-9_-]+[\s,:–—-]*)*(?:\*\*|\*|`|_)?\[done\](?:\*\*|\*|`|_)?/i;
const REVIEW_PASS_RE = /\[review:([A-Za-z0-9_-]+)\][^\n]*\bPASS\b/i;
const BOARD_MENTION_RE = /(?:^|[\s(（【\[])@([a-z0-9][a-z0-9_-]{0,23})/gi;

function isRoleWorkerName(name: string): boolean {
  return ROLE_WORKER_RE.test(name);
}

function readBoardQuickMeta(boardPath: string): {
  count: number;
  latestSeq: number;
  mtimeMs: number;
  doneAgents: Set<string>;
} {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(boardPath);
  } catch {
    boardMetaCache.delete(boardPath);
    return { count: 0, latestSeq: 0, mtimeMs: 0, doneAgents: new Set() };
  }
  const now = Date.now();
  const cached = boardMetaCache.get(boardPath);
  if (cached && cached.ino === st.ino && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
    cached.lastAccessedAt = now;
    return cached.meta;
  }

  const mtimeMs = st.mtimeMs;
  const doneAgents = new Set<string>();
  try {
    const raw = readFileSync(boardPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    let latestSeq = lines.length;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as { seq?: number; agent?: string; text?: string };
        if (typeof obj.seq === "number" && obj.seq > latestSeq) {
          latestSeq = obj.seq;
        }
        if (typeof obj.agent === "string" && typeof obj.text === "string") {
          const text = obj.text.trim();
          const passMatch = REVIEW_PASS_RE.exec(text);
          if (passMatch?.[1]) {
            doneAgents.add(passMatch[1]);
          } else {
            // If another agent @mentions a previously-done worker (e.g. red-team rework),
            // clear its stale delivered state unless this is a PASS review or done summary.
            BOARD_MENTION_RE.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = BOARD_MENTION_RE.exec(text)) !== null) {
              const mentioned = m[1];
              if (mentioned !== obj.agent && mentioned !== "coordinator" && mentioned !== "all") {
                doneAgents.delete(mentioned);
              }
            }
          }
          if (DONE_POST_RE.test(text)) {
            doneAgents.add(obj.agent);
          } else if (obj.agent !== "coordinator") {
            doneAgents.delete(obj.agent);
          }
        }
      } catch {
        // skip partial line
      }
    }
    if (lines.length > 0) {
      try {
        const last = JSON.parse(lines[lines.length - 1]) as { seq?: number };
        if (typeof last.seq === "number") latestSeq = last.seq;
      } catch {
        // keep latestSeq
      }
    }
    const meta = { count: lines.length, latestSeq, mtimeMs, doneAgents };
    boardMetaCache.set(boardPath, {
      ino: st.ino,
      size: st.size,
      mtimeMs: st.mtimeMs,
      meta,
      lastAccessedAt: now,
    });
    evictLru(boardMetaCache, MAX_BOARD_META_CACHE);
    return meta;
  } catch {
    return { count: 0, latestSeq: 0, mtimeMs, doneAgents };
  }
}

function extractLatestSwarmTitleTs(rows: TranscriptRow[]): number | null {
  let latest: number | null = null;
  for (const r of rows) {
    if (r.type !== "PLANNER_RESPONSE" || !r.tool_calls) continue;
    const hasTitle = r.tool_calls.some(
      (tc) =>
        tc.name === "swarm" &&
        String(cleanArg(tc.args?.action) ?? "").toLowerCase() === "title",
    );
    if (!hasTitle) continue;
    const ts = parseIsoMs(r.created_at);
    if (ts !== null && (latest === null || ts > latest)) {
      latest = ts;
    }
  }
  return latest;
}

function isMemberUnkilled(m: SwarmMember): boolean {
  return m.state === "working" || m.state === "waiting" || m.state === "failed";
}

function selectCurrentSwarmWaveMembers(
  taskMembers: SwarmMember[],
  rawSwarmPlan: RawSwarmPlanFile | null,
  latestSwarmTitleTs: number | null,
): { scopeMembers: SwarmMember[]; scopeLabel: string; planIsStale: boolean } {
  const planNames = new Set<string>();
  if (rawSwarmPlan?.tasks) {
    for (const k of Object.keys(rawSwarmPlan.tasks)) planNames.add(k);
  }
  if (Array.isArray(rawSwarmPlan?.threads)) {
    for (const th of rawSwarmPlan.threads) {
      for (const n of th.tasks ?? []) planNames.add(n);
    }
  }

  const planMembers =
    planNames.size > 0 ? taskMembers.filter((m) => planNames.has(m.name)) : [];
  const unkilledMembers = taskMembers.filter((m) => isMemberUnkilled(m));
  const planUnkilled = planMembers.filter((m) => isMemberUnkilled(m));
  const unplannedUnkilled = unkilledMembers.filter((m) => !planNames.has(m.name));

  const planMaxStartedAt = planMembers.reduce(
    (max, m) => (m.startedAt != null && m.startedAt > max ? m.startedAt : max),
    0,
  );

  // Case A: Active members exist outside plan.json, and NONE of plan.json's members are live
  // -> Coordinator started a new Swarm wave without updating plan.json!
  if (unplannedUnkilled.length > 0 && planUnkilled.length === 0) {
    const liveStarts = unkilledMembers
      .map((m) => m.startedAt)
      .filter((t): t is number => typeof t === "number");
    const liveMinStartedAt = liveStarts.length > 0 ? Math.min(...liveStarts) : null;

    let waveCutoffMs: number;
    if (latestSwarmTitleTs !== null && latestSwarmTitleTs > planMaxStartedAt) {
      waveCutoffMs = latestSwarmTitleTs - 30_000;
    } else if (liveMinStartedAt !== null) {
      waveCutoffMs = Math.max(planMaxStartedAt + 1, liveMinStartedAt - 120_000);
    } else {
      waveCutoffMs = planMaxStartedAt + 1;
    }

    const scopeMembers = taskMembers.filter(
      (m) =>
        isMemberUnkilled(m) ||
        (!planNames.has(m.name) && m.startedAt != null && m.startedAt >= waveCutoffMs),
    );
    return {
      scopeMembers: scopeMembers.length > 0 ? scopeMembers : unkilledMembers,
      scopeLabel: "当前波次",
      planIsStale: planMembers.length > 0,
    };
  }

  // Case B: Coordinator is in the plan.json wave AND dynamically added extra unkilled members
  if (unplannedUnkilled.length > 0 && planUnkilled.length > 0) {
    const seen = new Set<string>();
    const combined: SwarmMember[] = [];
    for (const m of [...planMembers, ...unplannedUnkilled]) {
      if (seen.has(m.name)) continue;
      seen.add(m.name);
      combined.push(m);
    }
    return { scopeMembers: combined, scopeLabel: "当前波次", planIsStale: false };
  }

  // Case C: All members are finished/killed; check if a newer wave ran after plan.json
  if (unkilledMembers.length === 0) {
    if (latestSwarmTitleTs !== null && latestSwarmTitleTs > planMaxStartedAt) {
      const postTitle = taskMembers.filter(
        (m) => m.startedAt != null && m.startedAt >= latestSwarmTitleTs - 30_000,
      );
      if (postTitle.length > 0 && postTitle.some((m) => !planNames.has(m.name))) {
        return { scopeMembers: postTitle, scopeLabel: "当前波次", planIsStale: planMembers.length > 0 };
      }
    }
    if (planMembers.length > 0) {
      const unplannedFinished = taskMembers.filter(
        (m) => !planNames.has(m.name) && m.startedAt != null && m.startedAt > planMaxStartedAt + 120_000,
      );
      if (unplannedFinished.length > 0) {
        const newestStart = Math.max(...unplannedFinished.map((m) => m.startedAt!));
        const newestBurst = unplannedFinished.filter((m) => m.startedAt! >= newestStart - 300_000);
        return { scopeMembers: newestBurst, scopeLabel: "当前波次", planIsStale: true };
      }
      return { scopeMembers: planMembers, scopeLabel: "当前波次", planIsStale: false };
    }
    return { scopeMembers: taskMembers, scopeLabel: "Swarm 成员", planIsStale: false };
  }

  // Case D: Standard active plan.json wave
  if (planMembers.length > 0) {
    return { scopeMembers: planMembers, scopeLabel: "当前波次", planIsStale: false };
  }
  return { scopeMembers: taskMembers, scopeLabel: "Swarm 成员", planIsStale: false };
}

function computeProgress(input: {
  now: number;
  primaryMode: AgyPrimaryMode;
  swarm: AgentBgStatus["swarm"];
  rawSwarmPlan: RawSwarmPlanFile | null;
  latestSwarmTitleTs: number | null;
  teamwork: TeamworkStatus | null;
  plan: PlanStatus | null;
  workflows: WorkflowRun[];
  subagents: SubagentItem[];
}): ProgressSummary | null {
  const { now, primaryMode, swarm, rawSwarmPlan, latestSwarmTitleTs, teamwork, plan, workflows, subagents } =
    input;

  // Helper to compute parallel ETA from per-unit start/duration arrays
  const finalizeTiming = (
    items: Array<{
      done: boolean;
      running: boolean;
      startedAt: number | null;
      updatedAt: number | null;
      durationMs: number | null;
    }>,
    counts: { completed: number; running: number; waiting: number; failed: number; total: number },
    scopeLabel: string,
  ): ProgressSummary => {
    const { completed, running, waiting, failed, total } = counts;
    const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;

    const starts = items
      .map((x) => x.startedAt)
      .filter((t): t is number => typeof t === "number" && t > 0);
    const startedAt = starts.length > 0 ? Math.min(...starts) : null;

    const allDone = total > 0 && completed >= total && running === 0 && failed === 0;
    const ends = items
      .map((x) => x.updatedAt)
      .filter((t): t is number => typeof t === "number" && t > 0);
    const endTs = allDone && ends.length > 0 ? Math.max(...ends) : now;
    const elapsedMs = startedAt !== null ? Math.max(0, Math.round(endTs - startedAt)) : null;

    const doneDurations = items
      .filter((x) => x.done && typeof x.durationMs === "number" && x.durationMs > 0)
      .map((x) => x.durationMs as number);
    const avgDurationMs =
      doneDurations.length > 0
        ? Math.round(doneDurations.reduce((a, b) => a + b, 0) / doneDurations.length)
        : null;

    let etaMs: number | null = null;
    let etaState: ProgressSummary["etaState"] = "none";
    if (allDone) {
      etaMs = 0;
      etaState = "done";
    } else if (running > 0 || waiting > 0) {
      if (avgDurationMs !== null) {
        const activeItems = items.filter((x) => !x.done);
        const remainingEstimates = activeItems.map((x) => {
          const itemElapsed =
            x.startedAt !== null ? Math.max(0, now - x.startedAt) : 0;
          return avgDurationMs - itemElapsed;
        });
        const maxRem = remainingEstimates.length > 0 ? Math.max(...remainingEstimates) : 0;
        if (maxRem > 15_000) {
          etaMs = Math.round(maxRem);
          etaState = "estimated";
        } else {
          etaMs = null;
          etaState = "over_avg";
        }
      } else {
        etaState = "estimating";
      }
    }

    return {
      completed,
      running,
      waiting,
      failed,
      total,
      percent,
      scopeLabel,
      startedAt,
      elapsedMs,
      avgDurationMs,
      etaMs,
      etaState,
    };
  };

  const swarmHasLive = Boolean(
    swarm && swarm.members.some((m) => !isRoleWorkerName(m.name) && isMemberUnkilled(m)),
  );
  const planHasOpenWork = Boolean(plan && (plan.inPlanMode || plan.completed < plan.total));

  if (
    swarm &&
    (swarmHasLive || !planHasOpenWork) &&
    (primaryMode === "swarm" || (primaryMode !== "teamwork" && swarm.members.length > 0))
  ) {
    const taskMembers = swarm.members.filter((m) => !isRoleWorkerName(m.name));
    const { scopeMembers, scopeLabel } = selectCurrentSwarmWaveMembers(
      taskMembers,
      rawSwarmPlan,
      latestSwarmTitleTs,
    );

    if (scopeMembers.length > 0) {
      let completed = 0;
      let running = 0;
      let waiting = 0;
      let failed = 0;
      const items = scopeMembers.map((m) => {
        const isDone =
          m.state === "completed" ||
          m.state === "canceled" ||
          m.state === "stopped" ||
          (m.state === "waiting" && Boolean(m.delivered));
        if (isDone) completed += 1;
        else if (m.state === "working") running += 1;
        else if (m.state === "failed") failed += 1;
        else waiting += 1;
        return {
          done: isDone,
          running: m.state === "working",
          startedAt: m.startedAt ?? null,
          updatedAt: m.updatedAt ?? null,
          durationMs: m.durationMs ?? null,
        };
      });
      return finalizeTiming(
        items,
        { completed, running, waiting, failed, total: scopeMembers.length },
        scopeLabel,
      );
    }
  }

  if (teamwork && teamwork.totalNodes > 0) {
    const items = teamwork.nodes.map((n) => ({
      done: n.state === "completed" || n.state === "canceled",
      running: n.state === "running",
      startedAt: n.startedAt ?? null,
      updatedAt: n.updatedAt ?? null,
      durationMs: n.durationMs ?? null,
    }));
    return finalizeTiming(
      items,
      {
        completed: teamwork.completedNodes,
        running: teamwork.runningNodes,
        waiting: 0,
        failed: teamwork.failedNodes,
        total: teamwork.totalNodes,
      },
      "Teamwork 节点",
    );
  }

  if (plan && plan.total > 0) {
    const running = plan.steps.filter((s) => s.status === "in_progress").length;
    const failed = plan.steps.filter((s) => s.status === "failed").length;
    const waiting = Math.max(0, plan.total - plan.completed - running - failed);
    return {
      completed: plan.completed,
      running,
      waiting,
      failed,
      total: plan.total,
      percent: Math.min(100, Math.round((plan.completed / plan.total) * 100)),
      scopeLabel: "任务步骤",
      startedAt: null,
      elapsedMs: null,
      avgDurationMs: null,
      etaMs: null,
      etaState: plan.completed >= plan.total ? "done" : "none",
    };
  }

  if (subagents.length > 0) {
    const completed = subagents.filter((s) => s.state === "completed" || s.state === "canceled").length;
    const running = subagents.filter((s) => s.state === "running").length;
    const failed = subagents.filter((s) => s.state === "failed").length;
    const items = subagents.map((s) => ({
      done: s.state === "completed" || s.state === "canceled",
      running: s.state === "running",
      startedAt: s.startedAt ?? null,
      updatedAt: s.updatedAt ?? null,
      durationMs: s.durationMs ?? null,
    }));
    return finalizeTiming(
      items,
      { completed, running, waiting: 0, failed, total: subagents.length },
      "子代理",
    );
  }

  if (workflows.length > 0) {
    const completed = workflows.filter((w) => w.status === "completed").length;
    const running = workflows.filter((w) => w.status === "running").length;
    const failed = workflows.filter((w) => w.status === "failed").length;
    return {
      completed,
      running,
      waiting: 0,
      failed,
      total: workflows.length,
      percent: Math.min(100, Math.round((completed / workflows.length) * 100)),
      scopeLabel: "Workflow",
      startedAt: workflows[0]?.startedAt ?? null,
      elapsedMs: workflows[0]?.startedAt ? Math.max(0, now - workflows[0].startedAt) : null,
      avgDurationMs: null,
      etaMs: null,
      etaState: completed >= workflows.length ? "done" : "none",
    };
  }

  return null;
}

function inferTeamworkPhase(nodes: SubagentItem[]): TeamworkPhase {
  const running = nodes.filter((n) => n.state === "running");
  if (running.length > 0) {
    if (running.some((n) => n.category === "victory_auditor")) return "victory_audit";
    if (
      running.some(
        (n) => n.category === "auditor" || n.category === "challenger" || n.category === "reviewer",
      )
    ) {
      return "auditing";
    }
    if (running.some((n) => n.category === "interviewer")) return "interview";
    if (running.some((n) => n.category === "worker" || n.category === "explorer")) {
      return "executing";
    }
    return "planning";
  }
  if (nodes.length === 0) return "idle";
  if (nodes.some((n) => n.state === "failed")) return "failed";
  return "completed";
}

function phaseLabelZh(phase: TeamworkPhase): string {
  switch (phase) {
    case "interview":
      return "需求访谈";
    case "planning":
      return "里程碑规划";
    case "executing":
      return "并行执行";
    case "auditing":
      return "门禁审核";
    case "victory_audit":
      return "终局验收";
    case "completed":
      return "已完成";
    case "failed":
      return "有失败";
    case "idle":
      return "空闲";
  }
}

function pickRecordedPid(proc: ProcessStateJson | null, hs: HookStateJson | null): number | null {
  const procPid = typeof proc?.pid === "number" && proc.pid > 1 ? proc.pid : null;
  const hsPid = typeof hs?.pid === "number" && hs.pid > 1 ? hs.pid : null;
  if (procPid !== null && hsPid !== null) {
    const procTs = typeof proc?.ts === "number" ? proc.ts : 0;
    const hsTs = typeof hs?.ts === "number" ? hs.ts : 0;
    return hsTs >= procTs ? hsPid : procPid;
  }
  return procPid ?? hsPid;
}

export function inspectAgySession(input: InspectAgySessionInput): AgentBgStatus | null {
  const { agentId, sessionId, agentAlive } = input;
  if (!sessionId || sessionId.includes("/") || sessionId.includes("..")) {
    return null;
  }

  const homeDir = input.homeDir ?? homedir();
  const now = input.now ?? Date.now();
  const isPidAlive = input.isPidAlive ?? defaultIsPidAlive;
  const brainRoot = path.join(homeDir, ".gemini", "antigravity-cli", "brain");
  const bdir = path.join(brainRoot, sessionId, ".system_generated");
  if (!existsSync(bdir)) {
    return null;
  }

  const txPath = path.join(bdir, "logs", "transcript.jsonl");
  const hsPath = path.join(bdir, "logs", "hook-state.json");
  const procPath = path.join(bdir, "logs", "process.json");
  const swarmMembersPath = path.join(bdir, "swarm", "members.json");
  const swarmMetaPath = path.join(bdir, "swarm", "swarm.json");
  const swarmPlanPath = path.join(bdir, "swarm", "plan.json");
  const swarmBoardPath = path.join(bdir, "swarm", "board.jsonl");

  const rows = readTranscriptRows(txPath);
  const hs = readJsonSafe<HookStateJson>(hsPath);
  const proc = readJsonSafe<ProcessStateJson>(procPath);
  const recordedPid = pickRecordedPid(proc, hs);
  const boardMeta = readBoardQuickMeta(swarmBoardPath);

  const lr = rows.length > 0 ? rows[rows.length - 1] : null;
  const lts = parseIsoMs(lr?.created_at);

  let freshestActivityMs = Math.max(
    lts ?? 0,
    typeof hs?.ts === "number" ? hs.ts : 0,
    typeof proc?.ts === "number" ? proc.ts : 0,
    readMtimeMs(txPath),
    readMtimeMs(hsPath),
    readMtimeMs(procPath),
    readMtimeMs(swarmMembersPath),
    boardMeta.mtimeMs,
  );

  // Inspect swarm members.json first (also contributes freshest mtime when no PID exists yet).
  const rawSwarm = readJsonSafe<RawSwarmMembersFile>(swarmMembersPath);
  const rawSwarmMeta = readJsonSafe<{ swarm_id?: string; title?: string }>(swarmMetaPath);
  const rawSwarmPlan = readJsonSafe<RawSwarmPlanFile>(swarmPlanPath);
  const memberStatuses: Array<{ name: string; raw: RawSwarmMember; child: ChildConvStatus }> = [];
  const swarmConvIds = new Set<string>();

  if (rawSwarm?.members && typeof rawSwarm.members === "object") {
    for (const [name, member] of Object.entries(rawSwarm.members)) {
      if (!member || member.role === "coordinator" || member.conversation_id === sessionId) {
        continue;
      }
      const cid = member.conversation_id ?? "";
      if (cid) swarmConvIds.add(cid);
      const child = cid
        ? inspectChildConv(brainRoot, cid)
        : {
            lastType: null,
            lastStatus: null,
            firstTs: null,
            lastTs: null,
            model: null,
            lastActivity: null,
            stepCount: 0,
            stepProgress: null,
            turnEnded: null,
            hasAskQ: false,
            stopIdle: false,
            stopBusy: false,
            hasOpenTask: false,
            freshestMtimeMs: 0,
          };
      if (child.freshestMtimeMs > freshestActivityMs) {
        freshestActivityMs = child.freshestMtimeMs;
      }
      if (child.lastTs && child.lastTs > freshestActivityMs) {
        freshestActivityMs = child.lastTs;
      }
      memberStatuses.push({ name, raw: member, child });
    }
  }

  // Recursively scan non-swarm subagent trees (captures Teamwork 4-level hierarchy, Boost, regular subagents).
  const scannedTree = scanSubagentTree(brainRoot, sessionId, swarmConvIds);
  if (scannedTree.freshestMtimeMs > freshestActivityMs) {
    freshestActivityMs = scannedTree.freshestMtimeMs;
  }

  const pidAlive = recordedPid !== null ? isPidAlive(recordedPid) : null;
  const staleWithoutPid =
    recordedPid === null && freshestActivityMs > 0 && now - freshestActivityMs > STALE_NO_PID_MS;
  const runtimeAlive =
    Boolean(agentAlive) &&
    (pidAlive !== null ? pidAlive : !staleWithoutPid) &&
    lr?.type !== "ERROR_MESSAGE";

  let lu = -1;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].type === "USER_INPUT") lu = i;
  }

  let latestPlanner: TranscriptRow | null = null;
  for (let i = rows.length - 1; i > lu; i -= 1) {
    if (rows[i].type === "PLANNER_RESPONSE") {
      latestPlanner = rows[i];
      break;
    }
  }

  const askQ = Boolean(
    lr?.type === "PLANNER_RESPONSE" &&
      lr.status === "DONE" &&
      lr.tool_calls?.some((x) => x.name === "ask_question"),
  );
  const swWait = Boolean(
    !askQ && latestPlanner?.tool_calls?.some((x) => x.name === "swarm_wait"),
  );
  const goalInfo = detectGoal(rows, bdir);
  const goalActive = goalInfo.active;
  const tasks = runtimeAlive ? extractOpenBgTasks(rows, lu, sessionId, bdir) : [];
  const plan = extractPlanStatus(rows);
  const workflows = extractWorkflowRuns(rows, runtimeAlive);

  const members: SwarmMember[] = memberStatuses.map(({ name, raw, child }) => {
    const isKilled = Boolean(
      raw.killed || raw.desired_state === "KILLED" || raw.phase === "KILLED",
    );
    let state: SwarmMember["state"];
    if (isKilled) {
      state = child.lastType === "ERROR_MESSAGE" ? "failed" : "completed";
    } else if (!runtimeAlive) {
      state = child.lastType === "ERROR_MESSAGE" ? "failed" : "stopped";
    } else if (child.lastType === "ERROR_MESSAGE") {
      state = "failed";
    } else if (
      child.stopBusy ||
      child.hasOpenTask ||
      child.lastStatus === "RUNNING" ||
      child.lastStatus === "PENDING" ||
      child.lastStatus === "GENERATING" ||
      (child.turnEnded === false && !child.stopIdle) ||
      (Number(raw.last_nudged_seq ?? 0) > Number(raw.wait_since ?? 0) && !child.stopIdle) ||
      (child.turnEnded === null &&
        raw.wake_mode !== "mentions" &&
        raw.wake_mode !== "anything" &&
        !child.stopIdle &&
        Number(raw.wait_since ?? 0) === 0)
    ) {
      state = "working";
    } else {
      state = "waiting";
    }
    const delivered = state !== "working" && boardMeta.doneAgents.has(name);
    const isFinishedMember =
      state === "completed" ||
      state === "failed" ||
      state === "stopped" ||
      (state === "waiting" && delivered);
    const endTs = isFinishedMember ? (child.lastTs ?? now) : now;
    const durationMs =
      child.firstTs !== null ? Math.max(0, Math.round(endTs - child.firstTs)) : null;

    return {
      name,
      conversationId: raw.conversation_id ?? "",
      model: raw.model ?? child.model ?? null,
      state,
      updatedAt: child.lastTs,
      startedAt: child.firstTs,
      durationMs,
      delivered,
      stepProgress: child.stepProgress,
      workspaceMode: raw.workspace_mode ?? null,
      workspace: raw.workspace ?? null,
      lastReadSeq: typeof raw.last_read_seq === "number" ? raw.last_read_seq : null,
      waitSince: typeof raw.wait_since === "number" ? raw.wait_since : null,
      lastActivity: child.lastActivity,
      stepCount: child.stepCount,
    };
  });

  // First map leaf/node states, then bubble up running state from descendants to ancestor containers
  const mappedTreeNodes: Array<{ item: SubagentItem; isTeamworkBranch: boolean }> =
    scannedTree.nodes.map(({ id, parentId, depth, isTeamworkBranch, raw, child }) => {
      let state: SubagentItem["state"];
      if (child.lastType === "ERROR_MESSAGE") {
        state = "failed";
      } else if (raw.state === "SUBAGENT_STATE_KILLED") {
        state = child.stopIdle || child.lastStatus === "DONE" ? "completed" : "canceled";
      } else if (
        !runtimeAlive ||
        child.stopIdle ||
        (child.turnEnded === true && !child.stopBusy && !child.hasOpenTask)
      ) {
        state = "completed";
      } else {
        state = "running";
      }
      const typeName = raw.subagentDescriptor?.typeName ?? "subagent";
      const role = raw.subagentDescriptor?.role ?? id.slice(0, 8);
      const endTs = state === "running" ? now : (child.lastTs ?? now);
      const durationMs =
        child.firstTs !== null ? Math.max(0, Math.round(endTs - child.firstTs)) : null;
      return {
        isTeamworkBranch,
        item: {
          id,
          parentId,
          depth,
          role,
          typeName,
          category: classifySubagentCategory(typeName, role),
          state,
          model: child.model,
          lastActivity: child.lastActivity,
          stepCount: child.stepCount,
          stepProgress: child.stepProgress,
          startedAt: child.firstTs,
          durationMs,
          workspace: formatWorkspaceUri(raw.workspaceUris?.[0]),
          updatedAt: child.lastTs,
        },
      };
    });

  // If any descendant is running while runtime is alive, mark its alive ancestors as running too.
  if (runtimeAlive) {
    const byId = new Map(mappedTreeNodes.map((n) => [n.item.id, n.item]));
    const rawById = new Map(scannedTree.nodes.map((n) => [n.id, n.raw]));
    for (const entry of mappedTreeNodes) {
      if (entry.item.state !== "running") continue;
      let curParentId = entry.item.parentId ?? null;
      let guard = 0;
      while (curParentId && guard < MAX_SUBAGENT_TREE_DEPTH + 1) {
        guard += 1;
        const parentItem = byId.get(curParentId);
        const parentRaw = rawById.get(curParentId);
        if (!parentItem) break;
        if (parentRaw?.state !== "SUBAGENT_STATE_KILLED" && parentItem.state === "completed") {
          parentItem.state = "running";
        }
        curParentId = parentItem.parentId ?? null;
      }
    }
  }

  const teamworkNodes = mappedTreeNodes.filter((n) => n.isTeamworkBranch).map((n) => n.item);
  const subagents = mappedTreeNodes.filter((n) => !n.isTeamworkBranch).map((n) => n.item);

  const teamworkRunning = teamworkNodes.filter((n) => n.state === "running").length;
  const teamworkCompleted = teamworkNodes.filter((n) => n.state === "completed").length;
  const teamworkFailed = teamworkNodes.filter((n) => n.state === "failed").length;
  const teamwork: TeamworkStatus | null =
    teamworkNodes.length > 0
      ? {
          active: runtimeAlive && teamworkRunning > 0,
          phase: inferTeamworkPhase(teamworkNodes),
          totalNodes: teamworkNodes.length,
          runningNodes: teamworkRunning,
          completedNodes: teamworkCompleted,
          failedNodes: teamworkFailed,
          nodes: teamworkNodes,
        }
      : null;

  const workingCount = members.filter((m) => m.state === "working").length;
  const waitingCount = members.filter((m) => m.state === "waiting").length;
  const completedCount = members.filter(
    (m) => m.state === "completed" || m.state === "failed" || m.state === "canceled",
  ).length;
  const planGoal =
    rawSwarmPlan?.goal?.title || rawSwarmPlan?.goal?.line
      ? {
          title: String(rawSwarmPlan.goal.title ?? ""),
          line: String(rawSwarmPlan.goal.line ?? ""),
        }
      : null;

  const swarm =
    members.length > 0
      ? {
          title:
            nonEmpty(rawSwarm?.title) ??
            nonEmpty(rawSwarmMeta?.title) ??
            nonEmpty(planGoal?.title),
          working: workingCount,
          waiting: waitingCount,
          completed: completedCount,
          boardCount: boardMeta.count,
          latestSeq: boardMeta.latestSeq,
          planGoal,
          members,
        }
      : null;

  const runningSubagents = subagents.filter((s) => s.state === "running").length;
  const runningWorkflows = workflows.filter((w) => w.status === "running").length;
  const boostActive = runtimeAlive && detectBoostActive(rows, lu, [...teamworkNodes, ...subagents]);

  const hasWakeupMid = Boolean(
    runtimeAlive &&
      !askQ &&
      !swWait &&
      hasSystemWakeupAfter(rows, lu) &&
      (lr?.type !== "PLANNER_RESPONSE" ||
        lr?.status !== "DONE" ||
        Boolean(lr?.tool_calls?.some((x) => x.name !== "ask_question"))) &&
      (!lts || now - lts < WAKEUP_MID_WINDOW_MS),
  );
  const hookBusy = Boolean(
    runtimeAlive &&
      !askQ &&
      hs?.event === "Stop" &&
      hs.fullyIdle === false &&
      (!lts || !hs.ts || hs.ts >= lts - HOOK_RACE_GRACE_MS) &&
      (swWait || !hs.ts || now - hs.ts < WAKEUP_MID_WINDOW_MS),
  );
  const recentSwWaitRace = Boolean(
    runtimeAlive && swWait && lts !== null && now - lts < HOOK_RACE_GRACE_MS,
  );
  const swarmActive = Boolean(
    runtimeAlive &&
      swarm !== null &&
      (swarm.working > 0 || (swWait && (swarm.waiting > 0 || hookBusy || recentSwWaitRace))),
  );
  const teamworkActive = Boolean(teamwork?.active);
  const backgroundActive = Boolean(
    runtimeAlive &&
      (swarmActive ||
        teamworkActive ||
        runningSubagents > 0 ||
        runningWorkflows > 0 ||
        tasks.length > 0 ||
        hookBusy ||
        hasWakeupMid),
  );

  let coordinatorState: AgentBgStatus["coordinatorState"];
  if (!runtimeAlive) {
    coordinatorState = "stopped";
  } else if (hasWakeupMid) {
    coordinatorState = "wakeup_running";
  } else if (swWait && swarmActive) {
    coordinatorState = "swarm_wait";
  } else if (backgroundActive) {
    coordinatorState = "background_hold";
  } else {
    coordinatorState = "idle";
  }

  const modes: AgyMode[] = [];
  if (swarm) modes.push("swarm");
  if (teamwork) modes.push("teamwork");
  if (boostActive) modes.push("boost");
  if (workflows.length > 0) modes.push("workflow");
  if (goalActive) modes.push("goal");
  if (plan) modes.push("plan");
  if (subagents.length > 0) modes.push("subagents");
  if (tasks.length > 0) modes.push("tasks");

  let primaryMode: AgyPrimaryMode = "idle";
  if (swarmActive) primaryMode = "swarm";
  else if (teamworkActive) primaryMode = "teamwork";
  else if (boostActive) primaryMode = "boost";
  else if (runningWorkflows > 0) primaryMode = "workflow";
  else if (runningSubagents > 0) primaryMode = "subagents";
  else if (tasks.length > 0) primaryMode = "tasks";
  else if (goalActive) primaryMode = "goal";
  else if (swarm) primaryMode = "swarm";
  else if (teamwork) primaryMode = "teamwork";
  else if (workflows.length > 0) primaryMode = "workflow";
  else if (plan) primaryMode = "plan";
  else if (subagents.length > 0) primaryMode = "subagents";

  const latestSwarmTitleTs = extractLatestSwarmTitleTs(rows);
  const hasConsoleData = modes.length > 0;
  const progress = computeProgress({
    now,
    primaryMode,
    swarm,
    rawSwarmPlan,
    latestSwarmTitleTs,
    teamwork,
    plan,
    workflows,
    subagents,
  });

  let pillLabel = "";
  if (swarm && swarmActive) {
    const boardSuffix = boardMeta.latestSeq > 0 ? ` · #${boardMeta.latestSeq}` : "";
    if (swarm.working > 0) {
      pillLabel = `后台运行中 · Swarm ${swarm.working} 运行${
        swarm.waiting > 0 ? ` / ${swarm.waiting} 待命` : ""
      }${boardSuffix}`;
    } else {
      pillLabel = `后台等唤醒 · Swarm ${swarm.waiting} 待命${boardSuffix}`;
    }
  } else if (teamwork && teamworkActive) {
    pillLabel = `Teamwork · ${phaseLabelZh(teamwork.phase)} · ${teamwork.runningNodes}/${teamwork.totalNodes} 运行`;
  } else if (boostActive) {
    pillLabel = `Boost 深度推进中${runningSubagents > 0 ? ` · ${runningSubagents} 个子代理` : ""}`;
  } else if (runningWorkflows > 0) {
    pillLabel = `Workflow 运行中（${runningWorkflows}）`;
  } else if (runningSubagents > 0) {
    pillLabel = `后台运行中 · ${runningSubagents} 个子代理`;
  } else if (tasks.length > 0) {
    pillLabel = `后台运行中 · ${tasks.length} 个后台任务`;
  } else if (backgroundActive) {
    pillLabel = "后台回合运行中";
  }

  let summaryLine: string;
  if (!runtimeAlive) {
    summaryLine = "会话进程已停止或已回收";
  } else if (coordinatorState === "swarm_wait") {
    summaryLine = "主代理在 swarm_wait 挂起等唤醒，worker 发帖后自动继续";
  } else if (teamwork && teamworkActive) {
    summaryLine = `Teamwork 正在「${phaseLabelZh(teamwork.phase)}」阶段，${teamwork.runningNodes} 个成员运行中（共 ${teamwork.totalNodes} 节点）`;
  } else if (boostActive) {
    summaryLine = "Boost 多轮对抗优化流水线正在运行";
  } else if (coordinatorState === "wakeup_running") {
    summaryLine = "主代理已收到唤醒，正在执行后续步骤";
  } else if (backgroundActive) {
    summaryLine = "Antigravity 仍有后台任务或子代理未收尾";
  } else if (goalActive) {
    summaryLine = goalInfo.summary ? `/goal 目标循环中：${goalInfo.summary}` : "/goal 目标循环已开启";
  } else {
    summaryLine = "当前无活动后台任务";
  }

  const coordinatorRecent = summarizeRecentActivity(rows);
  const coordinatorRosterModel =
    typeof rawSwarm?.members?.coordinator?.model === "string" &&
    rawSwarm.members.coordinator.model.trim().length > 0
      ? rawSwarm.members.coordinator.model.trim()
      : null;
  const coordinatorModel = coordinatorRecent.model ?? coordinatorRosterModel;
  let pendingInboxCount = 0;
  try {
    const inboxRaw = readFileSync(path.join(bdir, "logs", "paseo-inbox.jsonl"), "utf8");
    pendingInboxCount = inboxRaw.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    pendingInboxCount = 0;
  }

  return {
    agentId,
    sessionId,
    backgroundActive,
    goalActive,
    goalSummary: goalInfo.summary,
    boostActive,
    modes,
    primaryMode,
    hasConsoleData,
    progress,
    coordinatorState,
    coordinator: {
      conversationId: sessionId,
      model: coordinatorModel,
      lastActivity: coordinatorRecent.lastActivity,
      stepCount: rows.length,
    },
    ...(pendingInboxCount > 0 ? { pendingInboxCount } : {}),
    pillLabel,
    summaryLine,
    swarm,
    teamwork,
    plan,
    workflows,
    subagents,
    tasks,
    observedAt: now,
  };
}
