import type { AgentBgStatus } from "../shared/rpc.ts";

export const AGY_CONSOLE_PANEL_ID = "agy-console";

export interface SelectedChildTarget {
  conversationId: string;
  label: string;
  subtitle: string | null;
  running: boolean;
  workspace: string | null;
  memberName?: string | null;
}

export type ConsoleNavTarget =
  | { kind: "overview" }
  | { kind: "board"; filter?: string }
  | { kind: "child"; child: SelectedChildTarget };

export interface ConsoleNavRequest {
  seq: number;
  target: ConsoleNavTarget;
}

let statuses: Record<string, AgentBgStatus> = {};
const agentWorkspaces = new Map<string, string>();
let openPanelCallback: ((agentId: string, workspaceId: string) => void) | null = null;
const listeners = new Set<() => void>();

let navSeq = 0;
const pendingNavs = new Map<string, ConsoleNavRequest>();
const navListeners = new Set<() => void>();

function notifyNavListeners(): void {
  for (const listener of navListeners) {
    listener();
  }
}

export function replaceAllStatuses(next: Record<string, AgentBgStatus>): void {
  statuses = next;
  for (const listener of listeners) {
    listener();
  }
}

export function clearAllStatuses(): void {
  pendingNavs.clear();
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
