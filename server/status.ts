import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  AgentBgStatus,
  BgTaskItem,
  SubagentItem,
  SwarmMember,
} from "../shared/rpc.ts";

export interface InspectAgySessionInput {
  agentId: string;
  sessionId: string | null;
  agentAlive: boolean;
  homeDir?: string;
  now?: number;
  isPidAlive?: (pid: number) => boolean;
}

interface TranscriptRow {
  step_index?: number;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
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
  wait_since?: number;
  last_nudged_seq?: number;
  killed?: boolean;
  model?: string;
}

interface RawSwarmMembersFile {
  title?: string;
  members?: Record<string, RawSwarmMember>;
}

interface RawSubagentFile {
  conversationId?: string;
  state?: string;
  subagentDescriptor?: {
    typeName?: string;
    role?: string;
  };
}

interface ChildConvStatus {
  lastType: string | null;
  lastStatus: string | null;
  lastTs: number | null;
  hasAskQ: boolean;
  stopIdle: boolean;
  stopBusy: boolean;
  hasOpenTask: boolean;
  freshestMtimeMs: number;
}

const STALE_NO_PID_MS = 65 * 60_000;
const HOOK_RACE_GRACE_MS = 5_000;
const WAKEUP_MID_WINDOW_MS = 90_000;

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

function readJsonSafe<T>(filePath: string): T | null {
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

function cleanArg(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function readTranscriptRows(transcriptPath: string): TranscriptRow[] {
  let raw = "";
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }
  if (!raw.trim()) return [];
  const rows: TranscriptRow[] = [];
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
  return rows;
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

function detectGoalActive(rows: TranscriptRow[], bdir: string): boolean {
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
  if (lastGoalUserIdx < 0) return false;

  // Verify `/goal is a [Slash Command]` from full log when USER_INPUT was truncated.
  let confirmed =
    (rows[lastGoalUserIdx].content ?? "").includes("/goal is a [Slash Command]") ||
    /(?:^|\n)\s*\/goal\b/.test(rows[lastGoalUserIdx].content ?? "");
  if (!confirmed) {
    const fullRows = readTranscriptRows(path.join(bdir, "logs", "transcript_full.jsonl"));
    const targetStep = rows[lastGoalUserIdx].step_index;
    const match = fullRows.find(
      (fr) =>
        (targetStep !== undefined ? fr.step_index === targetStep : fr.type === "USER_INPUT") &&
        (fr.content ?? "").includes("/goal is a [Slash Command]"),
    );
    confirmed = Boolean(match);
  }
  if (!confirmed) return false;

  for (let i = lastGoalUserIdx + 1; i < rows.length; i += 1) {
    const r = rows[i];
    if (r.type === "USER_INPUT") {
      const content = r.content ?? "";
      if (/(?:^|\n)\s*\/goal\s+(?:clear|stop|cancel|off)\b/i.test(content)) return false;
    }
    if (r.type === "PLANNER_RESPONSE" && (r.content ?? "").includes("<!-- GOAL_COMPLETE -->")) {
      return false;
    }
  }
  return true;
}

function inspectChildConv(brainRoot: string, conversationId: string): ChildConvStatus {
  const cbdir = path.join(brainRoot, conversationId, ".system_generated");
  const txPath = path.join(cbdir, "logs", "transcript.jsonl");
  const hsPath = path.join(cbdir, "logs", "hook-state.json");
  const procPath = path.join(cbdir, "logs", "process.json");

  const hs = readJsonSafe<HookStateJson>(hsPath);
  const rows = readTranscriptRows(txPath);
  const lr = rows.length > 0 ? rows[rows.length - 1] : null;
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

  return {
    lastType: lr?.type ?? null,
    lastStatus: lr?.status ?? null,
    lastTs,
    hasAskQ,
    stopIdle,
    stopBusy,
    hasOpenTask: openTasks.length > 0,
    freshestMtimeMs: Math.max(readMtimeMs(txPath), readMtimeMs(hsPath), readMtimeMs(procPath)),
  };
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

  const rows = readTranscriptRows(txPath);
  const hs = readJsonSafe<HookStateJson>(hsPath);
  const proc = readJsonSafe<ProcessStateJson>(procPath);
  const recordedPid = pickRecordedPid(proc, hs);

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
  );

  // Inspect swarm members.json first (also contributes freshest mtime when no PID exists yet).
  const rawSwarm = readJsonSafe<RawSwarmMembersFile>(swarmMembersPath);
  const rawSwarmMeta = readJsonSafe<{ swarm_id?: string; title?: string }>(swarmMetaPath);
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
            lastTs: null,
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

  // Inspect non-swarm subagents/*.json.
  const subagentsDir = path.join(bdir, "subagents");
  const subagentEntries: Array<{ id: string; raw: RawSubagentFile; child: ChildConvStatus }> = [];
  try {
    for (const file of readdirSync(subagentsDir)) {
      if (!file.endsWith(".json")) continue;
      const d = readJsonSafe<RawSubagentFile>(path.join(subagentsDir, file));
      const cid = d?.conversationId;
      if (!cid || swarmConvIds.has(cid)) continue;
      const child = inspectChildConv(brainRoot, cid);
      if (child.freshestMtimeMs > freshestActivityMs) {
        freshestActivityMs = child.freshestMtimeMs;
      }
      if (child.lastTs && child.lastTs > freshestActivityMs) {
        freshestActivityMs = child.lastTs;
      }
      subagentEntries.push({ id: cid, raw: d, child });
    }
  } catch {
    // subagents directory absent
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
  const goalActive = detectGoalActive(rows, bdir);
  const tasks = runtimeAlive ? extractOpenBgTasks(rows, lu, sessionId, bdir) : [];

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
      (Number(raw.last_nudged_seq ?? 0) > Number(raw.wait_since ?? 0) && !child.stopIdle) ||
      child.stopBusy ||
      child.hasOpenTask ||
      child.lastStatus === "RUNNING" ||
      child.lastStatus === "PENDING" ||
      child.lastStatus === "GENERATING"
    ) {
      state = "working";
    } else {
      state = "waiting";
    }
    return {
      name,
      conversationId: raw.conversation_id ?? "",
      model: raw.model ?? null,
      state,
      updatedAt: child.lastTs,
    };
  });

  const subagents: SubagentItem[] = subagentEntries.map(({ id, raw, child }) => {
    let state: SubagentItem["state"];
    if (child.lastType === "ERROR_MESSAGE") {
      state = "failed";
    } else if (raw.state === "SUBAGENT_STATE_KILLED") {
      state = child.stopIdle ? "completed" : "canceled";
    } else if (
      !runtimeAlive ||
      child.stopIdle ||
      (child.lastType === "PLANNER_RESPONSE" &&
        child.lastStatus === "DONE" &&
        !child.stopBusy &&
        !child.hasOpenTask)
    ) {
      state = "completed";
    } else {
      state = "running";
    }
    return {
      id,
      role: raw.subagentDescriptor?.role ?? id.slice(0, 8),
      typeName: raw.subagentDescriptor?.typeName ?? "subagent",
      state,
      updatedAt: child.lastTs,
    };
  });

  const workingCount = members.filter((m) => m.state === "working").length;
  const waitingCount = members.filter((m) => m.state === "waiting").length;
  const completedCount = members.filter(
    (m) => m.state === "completed" || m.state === "failed" || m.state === "canceled",
  ).length;
  const swarm =
    members.length > 0
      ? {
          title: rawSwarm?.title ?? rawSwarmMeta?.title ?? null,
          working: workingCount,
          waiting: waitingCount,
          completed: completedCount,
          members,
        }
      : null;

  const runningSubagents = subagents.filter((s) => s.state === "running").length;
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
  const backgroundActive = Boolean(
    runtimeAlive &&
      (swarmActive || runningSubagents > 0 || tasks.length > 0 || hookBusy || hasWakeupMid),
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

  let pillLabel = "";
  if (swarm && swarmActive) {
    if (swarm.working > 0) {
      pillLabel = `后台运行中 · Swarm ${swarm.working} 运行${
        swarm.waiting > 0 ? ` / ${swarm.waiting} 待命` : ""
      }`;
    } else {
      pillLabel = `后台等唤醒 · Swarm ${swarm.waiting} 待命`;
    }
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
  } else if (coordinatorState === "wakeup_running") {
    summaryLine = "主代理已收到唤醒，正在执行后续步骤";
  } else if (backgroundActive) {
    summaryLine = "Antigravity 仍有后台任务或子代理未收尾";
  } else {
    summaryLine = "当前无活动后台任务";
  }

  return {
    agentId,
    sessionId,
    backgroundActive,
    goalActive,
    coordinatorState,
    pillLabel,
    summaryLine,
    swarm,
    subagents,
    tasks,
    observedAt: now,
  };
}
