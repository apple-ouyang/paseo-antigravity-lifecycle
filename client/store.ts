import type { AgentBgStatus } from "../shared/rpc.ts";

let statuses: Record<string, AgentBgStatus> = {};
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
