import type {
  AgentBgStatus,
  AgyConsoleDetail,
  ChildStepDetail,
  ChildTranscriptResponse,
  SwarmSendMode,
  TranscriptStep,
} from "../shared/rpc.ts";

export const AGY_CONSOLE_PANEL_ID = "agy-console";

export interface SelectedChildTarget {
  conversationId: string;
  label: string;
  subtitle: string | null;
  running: boolean;
  workspace: string | null;
  memberName?: string | null;
  isCoordinator?: boolean;
}

export interface SwarmSendResult {
  ok: boolean;
  method: "agentapi" | "hook_inbox" | "paseo_send";
  pendingCount?: number;
  error?: string;
}

export interface ChildTranscriptCacheEntry {
  conversationId: string;
  model: string | null;
  steps: TranscriptStep[];
  totalSteps: number;
  cursor: number;
  loadedOnce: boolean;
  updatedAt: number;
}

export type ConsoleNavTarget =
  | { kind: "overview" }
  | { kind: "board"; filter?: string }
  | { kind: "child"; child: SelectedChildTarget }
  | { kind: "member_by_name"; memberName: string }
  | { kind: "subagent_by_ref"; id?: string | null; role?: string | null };

export interface ParsedModelEffort {
  modelId: string;
  effort: string | null;
  raw: string;
}

const EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

export function formatModelBadgeLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower === "inherit" || lower === "default" || lower === "auto") return null;
  return trimmed;
}

export function parseModelAndEffort(raw: string | null | undefined): ParsedModelEffort | null {
  const clean = formatModelBadgeLabel(raw);
  if (!clean) return null;

  // Format 1: Display label with parenthesized effort, e.g. "Gemini 4 Carbon (Medium)"
  const parenMatch = /^(.+?)\s*\((minimal|low|medium|high|xhigh|max)\)$/i.exec(clean);
  if (parenMatch) {
    const modelId = parenMatch[1].trim();
    const effort = EFFORT_LABELS[parenMatch[2].toLowerCase()] ?? parenMatch[2];
    if (modelId) return { modelId, effort, raw: clean };
  }

  // Format 2: Model ID with trailing effort suffix, e.g. "gemini-4-carbon-medium", "claude-opus-5-5-high"
  const suffixMatch = /^(.+?)[-_](minimal|low|medium|high|xhigh|max)$/i.exec(clean);
  if (suffixMatch) {
    const modelId = suffixMatch[1].trim();
    const effort = EFFORT_LABELS[suffixMatch[2].toLowerCase()] ?? suffixMatch[2];
    if (modelId) return { modelId, effort, raw: clean };
  }

  return { modelId: clean, effort: null, raw: clean };
}

export function formatModelAndEffortText(raw: string | null | undefined): string | null {
  const parsed = parseModelAndEffort(raw);
  if (!parsed) return null;
  return parsed.effort ? `${parsed.modelId} · ${parsed.effort}` : parsed.modelId;
}

export function resolveMemberModelFromStatus(
  status: AgentBgStatus | null,
  memberName: string | null | undefined,
  explicitModel?: string | null,
): string | null {
  const coordModel = formatModelBadgeLabel(status?.coordinator?.model);
  const explicit = formatModelBadgeLabel(explicitModel);
  const cleanName = memberName?.trim().replace(/^@/, "");
  if (!cleanName) return explicit;
  if (cleanName.toLowerCase() === "coordinator") {
    return coordModel ?? explicit;
  }
  const member = status?.swarm?.members.find(
    (m) => m.name.toLowerCase() === cleanName.toLowerCase(),
  );
  return formatModelBadgeLabel(member?.model) ?? explicit ?? coordModel;
}

export function resolveSubagentModelFromStatus(
  status: AgentBgStatus | null,
  ref: { id?: string | null; role?: string | null },
  explicitModel?: string | null,
): string | null {
  const coordModel = formatModelBadgeLabel(status?.coordinator?.model);
  const explicit = formatModelBadgeLabel(explicitModel);
  const pool = [...(status?.teamwork?.nodes ?? []), ...(status?.subagents ?? [])];
  const matched =
    (ref.id ? pool.find((item) => item.id === ref.id) : undefined) ??
    (ref.role
      ? pool.find((item) => item.role.toLowerCase() === ref.role!.trim().toLowerCase())
      : undefined);
  return formatModelBadgeLabel(matched?.model) ?? explicit ?? coordModel;
}

export function resolveCoordinatorChildFromStatus(
  status: AgentBgStatus | null,
): SelectedChildTarget | null {
  const convId = status?.coordinator?.conversationId ?? status?.sessionId ?? "";
  if (!status || !convId) return null;
  return {
    conversationId: convId,
    label: "@coordinator（协调者）",
    subtitle: status.coordinator?.model ?? "协调者",
    running:
      status.coordinatorState === "wakeup_running" ||
      status.coordinatorState === "background_hold",
    workspace: null,
    memberName: "coordinator",
    isCoordinator: true,
  };
}

export function resolveMemberChildFromStatus(
  status: AgentBgStatus | null,
  memberName: string,
): SelectedChildTarget | null {
  if (!status?.swarm?.members) return null;
  const target = memberName.toLowerCase();
  const matched = status.swarm.members.find((m) => m.name.toLowerCase() === target);
  if (!matched || !matched.conversationId) return null;
  return {
    conversationId: matched.conversationId,
    label: `@${matched.name}`,
    subtitle: matched.model,
    running: matched.state === "working",
    workspace: matched.workspace ?? null,
    memberName: matched.name,
  };
}

export function resolveSubagentChildFromStatus(
  status: AgentBgStatus | null,
  ref: { id?: string | null; role?: string | null },
): SelectedChildTarget | null {
  if (!status) return null;
  const allNodes = [...(status.teamwork?.nodes ?? []), ...status.subagents];
  if (allNodes.length === 0) return null;
  const idLower = ref.id?.trim().toLowerCase() ?? "";
  const roleLower = ref.role?.trim().toLowerCase() ?? "";
  const matched =
    (idLower
      ? allNodes.find(
          (n) => n.id.toLowerCase() === idLower || n.id.toLowerCase().startsWith(idLower),
        )
      : undefined) ??
    (roleLower
      ? [...allNodes].reverse().find((n) => n.role.trim().toLowerCase() === roleLower)
      : undefined);
  if (!matched) return null;
  return {
    conversationId: matched.id,
    label: matched.role,
    subtitle: `${matched.typeName}${matched.model ? ` · ${matched.model}` : ""}`,
    running: matched.state === "running",
    workspace: matched.workspace ?? null,
  };
}

export interface ConsoleNavRequest {
  seq: number;
  target: ConsoleNavTarget;
}

const MAX_CHILD_CACHE = 80;
const MAX_CACHED_STEPS = 200;
const MAX_CONSOLE_CACHE = 30;

let statuses: Record<string, AgentBgStatus> = {};
const agentWorkspaces = new Map<string, string>();
let openPanelCallback: ((agentId: string, workspaceId: string) => void) | null = null;
let refreshAgentStatusCallback: ((agentId: string) => Promise<AgentBgStatus | null>) | null = null;
let sendSwarmMessageCallback:
  | ((
      agentId: string,
      text: string,
      targetMember?: string,
      mode?: SwarmSendMode,
    ) => Promise<SwarmSendResult>)
  | null = null;
let fetchConsoleCallback:
  | ((agentId: string, boardLimit?: number) => Promise<AgyConsoleDetail | null>)
  | null = null;
const listeners = new Set<() => void>();

let navSeq = 0;
const pendingNavs = new Map<string, ConsoleNavRequest>();
const navListeners = new Set<() => void>();

const childTranscriptCache = new Map<string, ChildTranscriptCacheEntry>();
const childStepDetailCache = new Map<string, { detail: ChildStepDetail; updatedAt: number }>();
const consoleDetailCache = new Map<string, { detail: AgyConsoleDetail; updatedAt: number }>();
const submittedQuestionAnswers = new Map<string, string>();

const MAX_STEP_DETAIL_CACHE = 160;

export function getChildStepDetailCache(
  conversationId: string,
  stepIndex: number,
): ChildStepDetail | null {
  const key = `${conversationId}:${stepIndex}`;
  const hit = childStepDetailCache.get(key);
  if (!hit) return null;
  hit.updatedAt = Date.now();
  return hit.detail;
}

export function setChildStepDetailCache(detail: ChildStepDetail): void {
  const key = `${detail.conversationId}:${detail.stepIndex}`;
  childStepDetailCache.set(key, { detail, updatedAt: Date.now() });
  evictOldest(childStepDetailCache, MAX_STEP_DETAIL_CACHE);
}

export function getSubmittedQuestionAnswer(key: string): string | null {
  return submittedQuestionAnswers.get(key) ?? null;
}

export function setSubmittedQuestionAnswer(key: string, answer: string): void {
  submittedQuestionAnswers.set(key, answer);
  if (submittedQuestionAnswers.size > 120) {
    const first = submittedQuestionAnswers.keys().next().value;
    if (first) submittedQuestionAnswers.delete(first);
  }
}

function notifyNavListeners(): void {
  for (const listener of navListeners) {
    listener();
  }
}

function evictOldest<T extends { updatedAt: number }>(map: Map<string, T>, max: number): void {
  if (map.size <= max) return;
  let oldestKey: string | null = null;
  let oldestTs = Infinity;
  for (const [k, v] of map) {
    if (v.updatedAt < oldestTs) {
      oldestTs = v.updatedAt;
      oldestKey = k;
    }
  }
  if (oldestKey) map.delete(oldestKey);
}

export function getChildTranscriptCache(conversationId: string): ChildTranscriptCacheEntry | null {
  const hit = childTranscriptCache.get(conversationId);
  if (!hit) return null;
  hit.updatedAt = Date.now();
  return hit;
}

export function applyChildTranscriptResponse(
  res: ChildTranscriptResponse,
  maxSteps = MAX_CACHED_STEPS,
): ChildTranscriptCacheEntry {
  const prev = childTranscriptCache.get(res.conversationId);
  let nextSteps: TranscriptStep[];

  if (res.mode === "delta" && prev) {
    if (res.unchanged || res.steps.length === 0) {
      nextSteps = prev.steps;
    } else {
      const merged = [...prev.steps, ...res.steps];
      nextSteps = merged.length > maxSteps ? merged.slice(merged.length - maxSteps) : merged;
    }
  } else {
    nextSteps = res.steps.length > maxSteps ? res.steps.slice(res.steps.length - maxSteps) : res.steps;
  }

  const next: ChildTranscriptCacheEntry = {
    conversationId: res.conversationId,
    model: res.model ?? prev?.model ?? null,
    steps: nextSteps,
    totalSteps: res.totalSteps,
    cursor: res.cursor,
    loadedOnce: true,
    updatedAt: Date.now(),
  };
  childTranscriptCache.set(res.conversationId, next);
  evictOldest(childTranscriptCache, MAX_CHILD_CACHE);
  return next;
}

export function getConsoleDetailCache(agentId: string): AgyConsoleDetail | null {
  const hit = consoleDetailCache.get(agentId);
  if (!hit) return null;
  hit.updatedAt = Date.now();
  return hit.detail;
}

export function setConsoleDetailCache(agentId: string, detail: AgyConsoleDetail): void {
  consoleDetailCache.set(agentId, { detail, updatedAt: Date.now() });
  evictOldest(consoleDetailCache, MAX_CONSOLE_CACHE);
}

export function replaceAllStatuses(next: Record<string, AgentBgStatus>): void {
  statuses = next;
  for (const listener of listeners) {
    listener();
  }
}

export function upsertAgentStatus(agentId: string, next: AgentBgStatus | null): void {
  if (!agentId) return;
  if (next === null) {
    if (!(agentId in statuses)) return;
    const copy = { ...statuses };
    delete copy[agentId];
    statuses = copy;
  } else {
    statuses = { ...statuses, [agentId]: next };
  }
  for (const listener of listeners) {
    listener();
  }
}

export function setRefreshAgentStatusHandler(
  handler: ((agentId: string) => Promise<AgentBgStatus | null>) | null,
): void {
  refreshAgentStatusCallback = handler;
}

export async function refreshAgentStatus(agentId: string): Promise<AgentBgStatus | null> {
  if (!agentId || !refreshAgentStatusCallback) return null;
  try {
    return await refreshAgentStatusCallback(agentId);
  } catch {
    return null;
  }
}

export function setSendSwarmMessageHandler(
  handler:
    | ((
        agentId: string,
        text: string,
        targetMember?: string,
        mode?: SwarmSendMode,
      ) => Promise<SwarmSendResult>)
    | null,
): void {
  sendSwarmMessageCallback = handler;
}

export async function sendSwarmMessage(
  agentId: string,
  text: string,
  targetMember?: string,
  mode?: SwarmSendMode,
): Promise<SwarmSendResult> {
  if (!agentId || !text.trim()) {
    return { ok: false, method: "hook_inbox", error: "消息内容为空" };
  }
  if (!sendSwarmMessageCallback) {
    return { ok: false, method: "hook_inbox", error: "发送通道尚未就绪" };
  }
  try {
    return await sendSwarmMessageCallback(agentId, text.trim(), targetMember, mode);
  } catch (err: unknown) {
    return {
      ok: false,
      method: "hook_inbox",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function setFetchConsoleHandler(
  handler: ((agentId: string, boardLimit?: number) => Promise<AgyConsoleDetail | null>) | null,
): void {
  fetchConsoleCallback = handler;
}

export async function fetchConsoleSnapshot(
  agentId: string,
  boardLimit = 10,
): Promise<AgyConsoleDetail | null> {
  if (!agentId || !fetchConsoleCallback) return null;
  try {
    return await fetchConsoleCallback(agentId, boardLimit);
  } catch {
    return null;
  }
}

export function clearAllStatuses(): void {
  pendingNavs.clear();
  childTranscriptCache.clear();
  childStepDetailCache.clear();
  consoleDetailCache.clear();
  if (Object.keys(statuses).length === 0) return;
  statuses = {};
  for (const listener of listeners) {
    listener();
  }
}

export function getStatusSnapshot(agentId: string): AgentBgStatus | null {
  return statuses[agentId] ?? null;
}

export function subscribeStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getConsoleNavRequest(agentId: string): ConsoleNavRequest | null {
  return pendingNavs.get(agentId) ?? null;
}

export function consumeConsoleNavRequest(agentId: string, seq: number): void {
  const current = pendingNavs.get(agentId);
  if (!current || current.seq !== seq) return;
  pendingNavs.delete(agentId);
  notifyNavListeners();
}

export function subscribeConsoleNav(listener: () => void): () => void {
  navListeners.add(listener);
  return () => {
    navListeners.delete(listener);
  };
}

export function registerAgentWorkspace(agentId: string, workspaceId: string): void {
  agentWorkspaces.set(agentId, workspaceId);
}

export function unregisterAgentWorkspace(agentId: string): void {
  agentWorkspaces.delete(agentId);
  if (pendingNavs.delete(agentId)) {
    notifyNavListeners();
  }
}

export function setOpenConsoleHandler(
  handler: ((agentId: string, workspaceId: string) => void) | null,
): void {
  openPanelCallback = handler;
}

export function openConsoleForAgent(
  agentId: string,
  explicitWorkspaceId?: string,
  target?: ConsoleNavTarget,
): void {
  const workspaceId = explicitWorkspaceId ?? agentWorkspaces.get(agentId);
  if (!workspaceId || !openPanelCallback) return;
  if (target) {
    navSeq += 1;
    pendingNavs.set(agentId, { seq: navSeq, target });
    notifyNavListeners();
  }
  openPanelCallback(agentId, workspaceId);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatLocalDate(d: Date, nowMs: number): string {
  const now = new Date(nowMs);
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hms = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return sameDay ? hms : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hms}`;
}

/**
 * Converts Date, epoch ms, or UTC/offset ISO timestamps (e.g. "2026-11-24T12:03:51Z")
 * into local HH:MM:SS (or MM-DD HH:MM:SS when not today).
 * Already-local strings without timezone suffix pass through cleanly.
 */
export function formatLocalTimestamp(
  raw: Date | string | number | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : formatLocalDate(raw, nowMs);
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : formatLocalDate(d, nowMs);
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // ISO-8601 with explicit timezone (Z or ±HH:MM / ±HHMM) -> convert to local clock
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) return trimmed.slice(11, 19);
    return formatLocalDate(d, nowMs);
  }

  return trimmed;
}
