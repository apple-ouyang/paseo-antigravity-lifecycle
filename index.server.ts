import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ensureAntigravityHooksInstalled } from "./server/hooks.ts";
import { inspectAgySession } from "./server/status.ts";
import {
  agyLifecycleGet,
  agyLifecycleWatch,
  type AgentBgStatus,
} from "./shared/rpc.ts";

const WATCH_POLL_MS = 2_000;
const REFRESH_COOLDOWN_MS = 10_000;

function isAgyProvider(provider: string | null | undefined): boolean {
  return provider === "antigravity" || provider === "antigravity-cli" || provider === "agy";
}

function stableSignature(agents: Record<string, AgentBgStatus>): string {
  const normalized: Record<string, Omit<AgentBgStatus, "observedAt">> = {};
  for (const agentId of Object.keys(agents).sort()) {
    const { observedAt: _ignored, ...rest } = agents[agentId];
    normalized[agentId] = rest;
  }
  return JSON.stringify(normalized);
}

async function resolveSessionId(
  paseo: PaseoApi,
  agent: PaseoAgent,
  refreshedAt: Map<string, number>,
): Promise<string | null> {
  const handle = paseo.agents.ref(agent.id);
  let sessionId =
    agent.runtimeInfo?.sessionId ??
    handle.runtimeInfo?.sessionId ??
    agent.persistence?.sessionId ??
    handle.current()?.persistence?.sessionId ??
    null;
  if (sessionId) return sessionId;

  const now = Date.now();
  if (now - (refreshedAt.get(agent.id) ?? 0) > REFRESH_COOLDOWN_MS) {
    refreshedAt.set(agent.id, now);
    try {
      const refetched = await handle.refresh();
      const refreshedAgent = refetched?.agent;
      sessionId =
        refreshedAgent?.runtimeInfo?.sessionId ??
        handle.runtimeInfo?.sessionId ??
        refreshedAgent?.persistence?.sessionId ??
        null;
    } catch {
      // Ignore refresh failure for transiently closing agents.
    }
  }
  return sessionId;
}

async function collectActiveAgyAgents(
  paseo: PaseoApi,
  refreshedAt: Map<string, number>,
): Promise<Record<string, AgentBgStatus>> {
  const result: Record<string, AgentBgStatus> = {};
  const list = await paseo.agents.list({ page: { limit: 200 } });
  const now = Date.now();
  for (const { agent } of list.entries) {
    if (!isAgyProvider(agent.provider)) continue;
    if (agent.archivedAt || agent.status === "closed") continue;
    const sessionId = await resolveSessionId(paseo, agent, refreshedAt);
    if (!sessionId) continue;
    const status = inspectAgySession({
      agentId: agent.id,
      sessionId,
      agentAlive: true,
      now,
    });
    if (status) {
      result[agent.id] = status;
    }
  }
  return result;
}

export default function contribute(server: PluginServerContext) {
  const refreshedAt = new Map<string, number>();

  try {
    const result = ensureAntigravityHooksInstalled();
    console.log(
      `[antigravity-lifecycle] ready script=${result.scriptPath} hooks=${result.hooksJsonPath} scriptUpdated=${result.scriptUpdated} configUpdated=${result.configUpdated}`,
    );
  } catch (error) {
    console.error(
      `[antigravity-lifecycle] initial hook install failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  server.on("agent.turn_started", (event) => {
    if (!isAgyProvider(event.agent.provider)) {
      return;
    }
    try {
      ensureAntigravityHooksInstalled();
    } catch (error) {
      console.error(
        `[antigravity-lifecycle] turn_started hook check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  server.handle(agyLifecycleGet, async ({ agentId }, context) => {
    const handle = context.paseo.agents.ref(agentId);
    if (!handle.current() && Date.now() - (refreshedAt.get(agentId) ?? 0) > 1_000) {
      refreshedAt.set(agentId, Date.now());
      await handle.refresh().catch(() => null);
    }
    const agent = handle.current();
    if (!agent || !isAgyProvider(agent.provider)) return null;
    const sessionId = await resolveSessionId(context.paseo, agent, refreshedAt);
    if (!sessionId) return null;
    return inspectAgySession({
      agentId: agent.id,
      sessionId,
      agentAlive: !agent.archivedAt && agent.status !== "closed",
    });
  });

  server.handle(agyLifecycleWatch, (_input, context) => {
    let lastHash = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    return new Promise<void>((resolve) => {
      const done = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        resolve();
      };
      if (context.signal.aborted) {
        done();
        return;
      }
      context.signal.addEventListener("abort", done, { once: true });

      const tick = async () => {
        if (context.signal.aborted || inFlight) return;
        inFlight = true;
        try {
          const agents = await collectActiveAgyAgents(context.paseo, refreshedAt);
          const hash = stableSignature(agents);
          if (!context.signal.aborted && hash !== lastHash) {
            lastHash = hash;
            await context.push({ agents });
          }
        } catch (error) {
          console.error(
            `[antigravity-lifecycle] watch poll failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          inFlight = false;
          if (!context.signal.aborted) {
            timer = setTimeout(() => void tick(), WATCH_POLL_MS);
          }
        }
      };

      void tick();
    });
  });

  return () => {
    refreshedAt.clear();
  };
}
