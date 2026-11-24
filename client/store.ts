import type {
  AgentBgStatus,
  AgyConsoleDetail,
  ChildTranscriptResponse,
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
  | { kind: "child"; child: SelectedChildTarget };

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
const listeners = new Set<() => void>();

let navSeq = 0;
const pendingNavs = new Map<string, ConsoleNavRequest>();
const navListeners = new Set<() => void>();

const childTranscriptCache = new Map<string, ChildTranscriptCacheEntry>();
const consoleDetailCache = new Map<string, { detail: AgyConsoleDetail; updatedAt: number }>();

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

export function clearAllStatuses(): void {
  pendingNavs.clear();
  childTranscriptCache.clear();
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
