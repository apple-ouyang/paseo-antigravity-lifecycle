import type { AgentBgStatus } from "../shared/rpc.ts";

export const AGY_CONSOLE_PANEL_ID = "agy-console";

let statuses: Record<string, AgentBgStatus> = {};
const agentWorkspaces = new Map<string, string>();
let openPanelCallback: ((agentId: string, workspaceId: string) => void) | null = null;
const listeners = new Set<() => void>();

export function replaceAllStatuses(next: Record<string, AgentBgStatus>): void {
  statuses = next;
  for (const listener of listeners) {
    listener();
  }
}

export function clearAllStatuses(): void {
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

export function registerAgentWorkspace(agentId: string, workspaceId: string): void {
  agentWorkspaces.set(agentId, workspaceId);
}

export function unregisterAgentWorkspace(agentId: string): void {
  agentWorkspaces.delete(agentId);
}

export function setOpenConsoleHandler(
  handler: ((agentId: string, workspaceId: string) => void) | null,
): void {
  openPanelCallback = handler;
}

export function openConsoleForAgent(agentId: string, explicitWorkspaceId?: string): void {
  const workspaceId = explicitWorkspaceId ?? agentWorkspaces.get(agentId);
  if (!workspaceId || !openPanelCallback) return;
  openPanelCallback(agentId, workspaceId);
}
