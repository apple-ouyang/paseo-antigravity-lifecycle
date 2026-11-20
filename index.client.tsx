import type { PaseoAgent } from "@getpaseo/client";
import type {
  PluginButtonRegistration,
  PluginClientContext,
  PluginSubscriptionHandle,
} from "@getpaseo/plugin/client";
import { AgyLifecyclePopover } from "./client/popover.tsx";
import { clearAllStatuses, getStatusSnapshot, replaceAllStatuses } from "./client/store.ts";
import { agyLifecycleWatch } from "./shared/rpc.ts";

interface PillEntry {
  workspaceId: string;
  handle: PluginButtonRegistration;
  visible: boolean;
  label: string;
}

const DEFAULT_LABEL = "后台运行中";

function isAgyProvider(provider: string | null | undefined): boolean {
  return provider === "antigravity" || provider === "antigravity-cli" || provider === "agy";
}

export default function contribute(client: PluginClientContext) {
  let disposed = false;
  let agentSub: { release(): Promise<void> } | null = null;
  let watchSub: PluginSubscriptionHandle | null = null;
  const pills = new Map<string, PillEntry>();

  const remove = (agentId: string) => {
    pills.get(agentId)?.handle.remove();
    pills.delete(agentId);
  };

  const syncPill = (agentId: string, entry: PillEntry) => {
    const st = getStatusSnapshot(agentId);
    const nextVisible = Boolean(st?.backgroundActive);
    const nextLabel = st?.pillLabel && st.pillLabel.length > 0 ? st.pillLabel : DEFAULT_LABEL;
    if (nextVisible === entry.visible && nextLabel === entry.label) return;
    entry.visible = nextVisible;
    entry.label = nextLabel;
    entry.handle.update({ visible: nextVisible, label: nextLabel });
  };

  const upsert = (agent: PaseoAgent) => {
    if (disposed) return;
    const workspaceId = agent.workspaceId;
    if (
      !workspaceId ||
      agent.status === "closed" ||
      agent.archivedAt ||
      !isAgyProvider(agent.provider)
    ) {
      remove(agent.id);
      return;
    }
    const existing = pills.get(agent.id);
    if (existing && existing.workspaceId === workspaceId) {
      syncPill(agent.id, existing);
      return;
    }
    remove(agent.id);

    const st = getStatusSnapshot(agent.id);
    const visible = Boolean(st?.backgroundActive);
    const label = st?.pillLabel && st.pillLabel.length > 0 ? st.pillLabel : DEFAULT_LABEL;
    const handle = client.addComposerPill({
      id: `agy-bg-${agent.id}`,
      workspaceId,
      agentId: agent.id,
      button: {
        title: "Antigravity 后台状态",
        icon: "Activity",
        label,
        visible,
        behavior: { kind: "popover", Content: AgyLifecyclePopover },
      },
    });
    pills.set(agent.id, { workspaceId, handle, visible, label });
  };

  watchSub = client.subscribe(agyLifecycleWatch, {}, (event) => {
    if (disposed) return;
    replaceAllStatuses(event.agents);
    for (const [agentId, entry] of pills) {
      syncPill(agentId, entry);
    }
  });

  void (async () => {
    try {
      const directory = await client.paseo.agents.list({ subscribe: {}, page: { limit: 200 } });
      if (disposed) {
        await directory.subscription?.release().catch(() => undefined);
        return;
      }
      agentSub = directory.subscription ?? null;
      for (const { agent } of directory.entries) upsert(agent);
      directory.subscription?.subscribe({
        snapshot: ({ entries }) => {
          if (!disposed) for (const { agent } of entries) upsert(agent);
        },
        update: (message) => {
          if (disposed || message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") upsert(update.agent);
          else remove(update.agentId);
        },
        error: (error) => console.error("antigravity-lifecycle: agent catalog error", error),
      });
    } catch (error) {
      console.error("antigravity-lifecycle: failed to list agents", error);
    }
  })();

  return async () => {
    disposed = true;
    for (const agentId of [...pills.keys()]) remove(agentId);
    clearAllStatuses();
    await watchSub?.release().catch(() => undefined);
    await agentSub?.release().catch(() => undefined);
  };
}
