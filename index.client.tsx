import type { PaseoAgent } from "@getpaseo/client";
import type {
  PluginButtonRegistration,
  PluginClientContext,
  PluginSubscriptionHandle,
} from "@getpaseo/plugin/client";
import { AgyConsolePanel } from "./client/console-panel.tsx";
import { AgyLifecyclePopover } from "./client/popover.tsx";
import {
  AGY_CONSOLE_PANEL_ID,
  clearAllStatuses,
  getStatusSnapshot,
  registerAgentWorkspace,
  replaceAllStatuses,
  setOpenConsoleHandler,
  unregisterAgentWorkspace,
} from "./client/store.ts";
import { AgyToolCard } from "./client/timeline-card.tsx";
import { formatDurationShort } from "./client/progress-bar.tsx";
import { transformAgyOtherToolCall } from "./client/timeline-transformer.ts";
import { agyLifecycleWatch, type AgentBgStatus } from "./shared/rpc.ts";
import { AgyToolCardSchema } from "./shared/timeline.ts";

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

function resolvePillPresentation(st: AgentBgStatus | null): { visible: boolean; label: string } {
  if (!st) return { visible: false, label: DEFAULT_LABEL };
  const prog = st.progress ?? null;

  if (st.backgroundActive) {
    if (st.swarm && prog && (st.primaryMode === "swarm" || st.swarm.working > 0)) {
      const pct = `${prog.percent}% (${prog.completed}/${prog.total})`;
      const timeHint =
        prog.etaState === "estimated" && prog.etaMs !== null
          ? ` · ~${formatDurationShort(prog.etaMs)}`
          : prog.etaState === "over_avg"
            ? " · 收尾中"
            : prog.elapsedMs && prog.elapsedMs >= 60_000
              ? ` · ${formatDurationShort(prog.elapsedMs)}`
              : "";
      const runTag = prog.running > 0 ? ` · ${prog.running}运行` : "";
      return {
        visible: true,
        label: `Swarm ${pct}${runTag}${timeHint}`,
      };
    }
    if (st.teamwork && st.teamwork.active && prog) {
      const eta =
        prog.etaState === "estimated" && prog.etaMs !== null
          ? ` · ~${formatDurationShort(prog.etaMs)}`
          : "";
      return {
        visible: true,
        label: `Teamwork ${prog.percent}% (${prog.completed}/${prog.total})${eta}`,
      };
    }
    if (prog && prog.total > 0 && (st.primaryMode === "subagents" || st.primaryMode === "workflow")) {
      const prefix = st.primaryMode === "workflow" ? "Workflow" : "子代理";
      return {
        visible: true,
        label: `${prefix} ${prog.percent}% (${prog.completed}/${prog.total})`,
      };
    }
    return {
      visible: true,
      label: st.pillLabel && st.pillLabel.length > 0 ? st.pillLabel : DEFAULT_LABEL,
    };
  }

  if (st.goalActive) {
    const planHint =
      st.plan && st.plan.total > 0
        ? ` · ${Math.round((st.plan.completed / st.plan.total) * 100)}% (${st.plan.completed}/${st.plan.total})`
        : "";
    return { visible: true, label: `/goal${planHint || " 循环中"}` };
  }
  if (st.swarm) {
    const doneTag = prog ? ` ${prog.percent}% (${prog.completed}/${prog.total})` : "";
    return { visible: true, label: `Swarm ✓${doneTag}` };
  }
  if (st.teamwork) {
    const doneTag = prog ? ` ${prog.percent}% (${prog.completed}/${prog.total})` : "";
    return { visible: true, label: `Teamwork ✓${doneTag}` };
  }
  if (st.plan && st.plan.total > 0) {
    const pct = Math.round((st.plan.completed / st.plan.total) * 100);
    return {
      visible: true,
      label:
        st.plan.completed >= st.plan.total
          ? `任务 ✓ (${st.plan.completed}/${st.plan.total})`
          : `任务 ${pct}% (${st.plan.completed}/${st.plan.total})`,
    };
  }
  if (st.workflows && st.workflows.length > 0) {
    return { visible: true, label: "Workflow ✓" };
  }
  if (st.plan && st.plan.inPlanMode) {
    return { visible: true, label: "Plan 模式" };
  }
  return { visible: false, label: DEFAULT_LABEL };
}

export default function contribute(client: PluginClientContext) {
  let disposed = false;
  let agentSub: { release(): Promise<void> } | null = null;
  let watchSub: PluginSubscriptionHandle | null = null;
  const pills = new Map<string, PillEntry>();

  const openConsole = (agentId: string, workspaceId: string) => {
    client.openPanel(AGY_CONSOLE_PANEL_ID, {
      workspaceId,
      agentId,
      location: "explorer",
    });
  };
  setOpenConsoleHandler(openConsole);

  // 1. Live Antigravity Console panel (Swarm Board + Overview + Teamwork nested tree + Worker logs)
  const disposePanel = client.addAgentPanel({
    id: AGY_CONSOLE_PANEL_ID,
    title: "Antigravity 控制台",
    icon: "Layers",
    locations: ["workspace", "explorer"],
    Component: AgyConsolePanel,
  });

  // 2. Timeline transformer + renderer to replace opaque `Other` tool calls with rich semantic cards
  const disposeTransformer = client.addTimelineTransformer({
    id: "agy-other-tools",
    query: { itemType: "tool_call" },
    transform: transformAgyOtherToolCall,
  });

  const disposeRenderer = client.addTimelineRenderer({
    kind: "agy-tool-card",
    version: 1,
    schema: AgyToolCardSchema,
    Component: AgyToolCard,
  });

  // 3. Slash commands (/swarm-board, /agy-board) and Command Center entry
  const disposeSwarmSlash = client.addSlashCommand({
    name: "swarm-board",
    description: "在侧栏打开 Antigravity Swarm / Teamwork 实时控制台面板",
    argumentHint: "",
    context: "agent",
    onSubmit({ openPanel }) {
      openPanel(AGY_CONSOLE_PANEL_ID, { location: "explorer" });
    },
  });

  const disposeAgySlash = client.addSlashCommand({
    name: "agy-board",
    description: "在侧栏打开 Antigravity 全模式控制台（Swarm / Teamwork / Boost / Goal / Plan）",
    argumentHint: "",
    context: "agent",
    onSubmit({ openPanel }) {
      openPanel(AGY_CONSOLE_PANEL_ID, { location: "explorer" });
    },
  });

  const disposeCommandCenter = client.addCommandCenterItem({
    id: "open-agy-console",
    title: "在侧栏打开 Antigravity 控制台 (Swarm / Teamwork)",
    icon: "Layers",
    keywords: ["swarm", "board", "teamwork", "boost", "goal", "antigravity", "agy"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel(AGY_CONSOLE_PANEL_ID, { location: "explorer" });
    },
  });

  const remove = (agentId: string) => {
    pills.get(agentId)?.handle.remove();
    pills.delete(agentId);
    unregisterAgentWorkspace(agentId);
  };

  const syncPill = (agentId: string, entry: PillEntry) => {
    const st = getStatusSnapshot(agentId);
    const { visible: nextVisible, label: nextLabel } = resolvePillPresentation(st);
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
    registerAgentWorkspace(agent.id, workspaceId);
    const existing = pills.get(agent.id);
    if (existing && existing.workspaceId === workspaceId) {
      syncPill(agent.id, existing);
      return;
    }
    remove(agent.id);
    registerAgentWorkspace(agent.id, workspaceId);

    const st = getStatusSnapshot(agent.id);
    const { visible, label } = resolvePillPresentation(st);
    const handle = client.addComposerPill({
      id: `agy-bg-${agent.id}`,
      workspaceId,
      agentId: agent.id,
      button: {
        title: "Antigravity 编排控制台",
        icon: "Layers",
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
    setOpenConsoleHandler(null);
    for (const agentId of [...pills.keys()]) remove(agentId);
    clearAllStatuses();
    await disposePanel?.();
    await disposeTransformer?.();
    await disposeRenderer?.();
    await disposeSwarmSlash?.();
    await disposeAgySlash?.();
    await disposeCommandCenter?.();
    await watchSub?.release().catch(() => undefined);
    await agentSub?.release().catch(() => undefined);
  };
}
