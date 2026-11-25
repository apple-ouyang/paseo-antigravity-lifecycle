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
  setAgentRuntimeStatus,
  setFetchConsoleHandler,
  setOpenConsoleHandler,
  setRefreshAgentStatusHandler,
  setSendSwarmMessageHandler,
  subscribeStatus,
  unregisterAgentWorkspace,
  upsertAgentStatus,
} from "./client/store.ts";
import { AgyToolCard } from "./client/timeline-card.tsx";
import { formatDurationShort } from "./client/progress-bar.tsx";
import {
  resetQuestionTransformerState,
  transformAgyOtherToolCall,
  transformAgyQuestionFallback,
} from "./client/timeline-transformer.ts";
import {
  agyConsoleGet,
  agyLifecycleGet,
  agyLifecycleWatch,
  agySwarmSendMessage,
  type AgentBgStatus,
} from "./shared/rpc.ts";
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
      const pct = `${prog.percent}% ${prog.completed}/${prog.total}`;
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
        label: `Teamwork ${prog.percent}% ${prog.completed}/${prog.total}${eta}`,
      };
    }
    if (prog && prog.total > 0 && (st.primaryMode === "subagents" || st.primaryMode === "workflow")) {
      const prefix = st.primaryMode === "workflow" ? "Workflow" : "子代理";
      return {
        visible: true,
        label: `${prefix} ${prog.percent}% ${prog.completed}/${prog.total}`,
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
        ? ` · ${Math.round((st.plan.completed / st.plan.total) * 100)}% ${st.plan.completed}/${st.plan.total}`
        : "";
    return { visible: true, label: `/goal${planHint || " 循环中"}` };
  }
  if (st.swarm) {
    const doneTag = prog ? ` ${prog.percent}% ${prog.completed}/${prog.total}` : "";
    return { visible: true, label: `Swarm ✓${doneTag}` };
  }
  if (st.teamwork) {
    const doneTag = prog ? ` ${prog.percent}% ${prog.completed}/${prog.total}` : "";
    return { visible: true, label: `Teamwork ✓${doneTag}` };
  }
  if (st.plan && st.plan.total > 0) {
    const pct = Math.round((st.plan.completed / st.plan.total) * 100);
    return {
      visible: true,
      label:
        st.plan.completed >= st.plan.total
          ? `任务 ✓ ${st.plan.completed}/${st.plan.total}`
          : `任务 ${pct}% ${st.plan.completed}/${st.plan.total}`,
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
  let watchActive = false;
  let watchGeneration = 0;
  let watchRetryMs = 1_000;
  let watchRetryTimer: ReturnType<typeof setTimeout> | null = null;
  const pills = new Map<string, PillEntry>();
  const inFlightRefresh = new Map<string, Promise<AgentBgStatus | null>>();
  const lastRefreshAt = new Map<string, number>();

  const openConsole = (agentId: string, workspaceId: string) => {
    client.openPanel(AGY_CONSOLE_PANEL_ID, {
      workspaceId,
      agentId,
      location: "workspace",
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

  // 2. Timeline transformers + renderer to replace opaque `Other` tool calls with rich semantic cards
  const disposeTransformer = client.addTimelineTransformer({
    id: "agy-other-tools",
    query: { itemType: "tool_call" },
    transform: transformAgyOtherToolCall,
  });

  const disposeQuestionFallback = client.addTimelineTransformer({
    id: "agy-question-fallback",
    query: { itemType: "assistant_message" },
    transform: transformAgyQuestionFallback,
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
    description: "打开 Antigravity Swarm / Teamwork 实时控制台面板",
    argumentHint: "",
    context: "agent",
    onSubmit({ openPanel }) {
      openPanel(AGY_CONSOLE_PANEL_ID, { location: "workspace" });
    },
  });

  const disposeAgySlash = client.addSlashCommand({
    name: "agy-board",
    description: "打开 Antigravity 全模式控制台（Swarm / Teamwork / Boost / Goal / Plan）",
    argumentHint: "",
    context: "agent",
    onSubmit({ openPanel }) {
      openPanel(AGY_CONSOLE_PANEL_ID, { location: "workspace" });
    },
  });

  const disposeCommandCenter = client.addCommandCenterItem({
    id: "open-agy-console",
    title: "打开 Antigravity 控制台 (Swarm / Teamwork)",
    icon: "Layers",
    keywords: ["swarm", "board", "teamwork", "boost", "goal", "antigravity", "agy"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel(AGY_CONSOLE_PANEL_ID, { location: "workspace" });
    },
  });

  const remove = (agentId: string) => {
    pills.get(agentId)?.handle.remove();
    pills.delete(agentId);
    lastRefreshAt.delete(agentId);
    setAgentRuntimeStatus(agentId, null);
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

  const syncAllPills = () => {
    for (const [agentId, entry] of pills) {
      syncPill(agentId, entry);
    }
  };

  const unsubStatusPills = subscribeStatus(syncAllPills);

  const refreshAgent = (
    agentId: string,
    options?: { minIntervalMs?: number },
  ): Promise<AgentBgStatus | null> => {
    if (disposed || !agentId) return Promise.resolve(null);
    const existing = inFlightRefresh.get(agentId);
    if (existing) return existing;
    const minIntervalMs = options?.minIntervalMs ?? 0;
    const now = Date.now();
    if (minIntervalMs > 0 && now - (lastRefreshAt.get(agentId) ?? 0) < minIntervalMs) {
      return Promise.resolve(getStatusSnapshot(agentId));
    }
    lastRefreshAt.set(agentId, now);
    const req = client
      .rpc(agyLifecycleGet, { agentId })
      .then((next) => {
        if (!disposed) {
          upsertAgentStatus(agentId, next);
        }
        return next;
      })
      .catch(() => null)
      .finally(() => {
        if (inFlightRefresh.get(agentId) === req) {
          inFlightRefresh.delete(agentId);
        }
      });
    inFlightRefresh.set(agentId, req);
    return req;
  };
  setRefreshAgentStatusHandler((agentId) => refreshAgent(agentId));
  setSendSwarmMessageHandler((agentId, text, targetMember, mode) =>
    client.rpc(agySwarmSendMessage, { agentId, text, targetMember, mode }),
  );
  setFetchConsoleHandler((agentId, boardLimit) =>
    client.rpc(agyConsoleGet, { agentId, boardLimit }),
  );

  const startWatch = () => {
    if (disposed) return;
    if (watchRetryTimer) {
      clearTimeout(watchRetryTimer);
      watchRetryTimer = null;
    }
    const prev = watchSub;
    watchSub = null;
    if (prev) {
      void prev.release().catch(() => undefined);
    }
    const gen = ++watchGeneration;
    watchActive = true;
    try {
      watchSub = client.subscribe(
        agyLifecycleWatch,
        {},
        (event) => {
          if (disposed || gen !== watchGeneration) return;
          watchRetryMs = 1_000;
          replaceAllStatuses(event.agents);
        },
        {
          onClosed: () => {
            if (disposed || gen !== watchGeneration) return;
            watchActive = false;
            watchSub = null;
            const delay = watchRetryMs;
            watchRetryMs = Math.min(watchRetryMs * 2, 15_000);
            watchRetryTimer = setTimeout(() => {
              watchRetryTimer = null;
              startWatch();
            }, delay);
          },
        },
      );
    } catch {
      watchActive = false;
      const delay = watchRetryMs;
      watchRetryMs = Math.min(watchRetryMs * 2, 15_000);
      watchRetryTimer = setTimeout(() => {
        watchRetryTimer = null;
        startWatch();
      }, delay);
    }
  };

  const upsert = (agent: PaseoAgent, options?: { fromUpdate?: boolean }) => {
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
    setAgentRuntimeStatus(agent.id, agent.status);
    const existing = pills.get(agent.id);
    if (existing && existing.workspaceId === workspaceId) {
      syncPill(agent.id, existing);
      if (options?.fromUpdate || !watchActive) {
        void refreshAgent(agent.id, { minIntervalMs: 1_500 });
      }
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
    // Fetch fresh status right away for newly created / resumed old windows so they never display stale cache.
    void refreshAgent(agent.id, { minIntervalMs: 500 });
  };

  startWatch();

  void (async () => {
    try {
      const directory = await client.paseo.agents.list({ subscribe: {}, page: { limit: 200 } });
      if (disposed) {
        await directory.subscription?.release().catch(() => undefined);
        return;
      }
      agentSub = directory.subscription ?? null;
      for (const { agent } of directory.entries) upsert(agent);
      // Fetch extra pages if a user has >200 non-archived agents so older active windows still get pills.
      let cursor = directory.pageInfo?.nextCursor ?? undefined;
      for (let page = 1; cursor && page < 5 && !disposed; page += 1) {
        try {
          const extra = await client.paseo.agents.list({
            sort: [{ key: "created_at", direction: "desc" }],
            page: { limit: 200, cursor },
          });
          if (disposed) break;
          for (const { agent } of extra.entries) upsert(agent);
          const nextCursor = extra.pageInfo?.nextCursor ?? undefined;
          if (!nextCursor || nextCursor === cursor) break;
          cursor = nextCursor;
        } catch {
          break;
        }
      }
      directory.subscription?.subscribe({
        snapshot: ({ entries }) => {
          if (disposed) return;
          for (const { agent } of entries) upsert(agent);
          // Re-establish watch immediately after a reconnect snapshot if the previous stream closed.
          if (!watchActive) {
            watchRetryMs = 1_000;
            startWatch();
          }
          for (const agentId of pills.keys()) {
            void refreshAgent(agentId, { minIntervalMs: 1_500 });
          }
        },
        update: (message) => {
          if (disposed || message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") upsert(update.agent, { fromUpdate: true });
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
    watchGeneration += 1;
    watchActive = false;
    if (watchRetryTimer) {
      clearTimeout(watchRetryTimer);
      watchRetryTimer = null;
    }
    inFlightRefresh.clear();
    lastRefreshAt.clear();
    unsubStatusPills();
    setOpenConsoleHandler(null);
    setRefreshAgentStatusHandler(null);
    setSendSwarmMessageHandler(null);
    setFetchConsoleHandler(null);
    for (const agentId of [...pills.keys()]) remove(agentId);
    clearAllStatuses();
    resetQuestionTransformerState();
    await disposePanel?.();
    await disposeTransformer?.();
    await disposeQuestionFallback?.();
    await disposeRenderer?.();
    await disposeSwarmSlash?.();
    await disposeAgySlash?.();
    await disposeCommandCenter?.();
    await watchSub?.release().catch(() => undefined);
    await agentSub?.release().catch(() => undefined);
  };
}
