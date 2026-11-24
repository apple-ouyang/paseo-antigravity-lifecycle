import { homedir } from "node:os";
import path from "node:path";
import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  clearTranscriptCache,
  collectAllowedChildIds,
  inspectAgyConsole,
  readChildStepDetail,
  readChildTranscript,
  readSwarmBoard,
} from "./server/detail.ts";
import { ensureAntigravityHooksInstalled } from "./server/hooks.ts";
import { clearStatusCaches, inspectAgySession } from "./server/status.ts";
import {
  agyBoardSliceGet,
  agyChildStepDetailGet,
  agyChildTranscriptGet,
  agyConsoleGet,
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

interface ResolvedSession {
  agentId: string;
  sessionId: string;
  agentAlive: boolean;
  updatedAt: number;
}

const KNOWN_SESSION_TTL_MS = 60_000;

async function resolveAgentAndSession(
  paseo: PaseoApi,
  agentId: string,
  refreshedAt: Map<string, number>,
  inFlightRefresh: Map<string, Promise<unknown>>,
  knownSessions: Map<string, ResolvedSession>,
): Promise<ResolvedSession | null> {
  const handle = paseo.agents.ref(agentId);
  let agent = handle.current();

  if (!agent) {
    // Share any in-flight refresh promise so concurrent RPCs (e.g. console.get + child.transcript)
    // never race past each other and return null before handle.refresh() settles.
    const existingFlight = inFlightRefresh.get(agentId);
    if (existingFlight) {
      await existingFlight.catch(() => null);
      agent = handle.current();
    } else if (Date.now() - (refreshedAt.get(agentId) ?? 0) > 1_000) {
      refreshedAt.set(agentId, Date.now());
      const flight = handle.refresh().catch(() => null);
      inFlightRefresh.set(agentId, flight);
      try {
        await flight;
      } finally {
        if (inFlightRefresh.get(agentId) === flight) {
          inFlightRefresh.delete(agentId);
        }
      }
      agent = handle.current();
    }
  }

  if (agent) {
    if (!isAgyProvider(agent.provider)) return null;
    const sessionId = await resolveSessionId(paseo, agent, refreshedAt);
    if (sessionId) {
      const resolved: ResolvedSession = {
        agentId: agent.id,
        sessionId,
        agentAlive: !agent.archivedAt && agent.status !== "closed",
        updatedAt: Date.now(),
      };
      knownSessions.set(agent.id, resolved);
      return resolved;
    }
  }

  // Fallback to recently observed session from the background watch loop
  const cached = knownSessions.get(agentId);
  if (cached && Date.now() - cached.updatedAt < KNOWN_SESSION_TTL_MS) {
    return cached;
  }
  return null;
}

async function collectActiveAgyAgents(
  paseo: PaseoApi,
  refreshedAt: Map<string, number>,
  knownSessions: Map<string, ResolvedSession>,
): Promise<Record<string, AgentBgStatus>> {
  const result: Record<string, AgentBgStatus> = {};
  const list = await paseo.agents.list({ page: { limit: 200 } });
  const now = Date.now();
  for (const { agent } of list.entries) {
    if (!isAgyProvider(agent.provider)) continue;
    if (agent.archivedAt || agent.status === "closed") continue;
    const sessionId = await resolveSessionId(paseo, agent, refreshedAt);
    if (!sessionId) continue;
    knownSessions.set(agent.id, {
      agentId: agent.id,
      sessionId,
      agentAlive: true,
      updatedAt: now,
    });
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
  const inFlightRefresh = new Map<string, Promise<unknown>>();
  const knownSessions = new Map<string, ResolvedSession>();
  const brainRoot = path.join(homedir(), ".gemini", "antigravity-cli", "brain");

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
    const resolved = await resolveAgentAndSession(
      context.paseo,
      agentId,
      refreshedAt,
      inFlightRefresh,
      knownSessions,
    );
    if (!resolved) return null;
    return inspectAgySession({
      agentId: resolved.agentId,
      sessionId: resolved.sessionId,
      agentAlive: resolved.agentAlive,
    });
  });

  server.handle(agyConsoleGet, async ({ agentId, boardLimit }, context) => {
    const resolved = await resolveAgentAndSession(
      context.paseo,
      agentId,
      refreshedAt,
      inFlightRefresh,
      knownSessions,
    );
    if (!resolved) return null;
    return inspectAgyConsole({
      agentId: resolved.agentId,
      sessionId: resolved.sessionId,
      agentAlive: resolved.agentAlive,
      boardLimit,
    });
  });

  server.handle(agyBoardSliceGet, async ({ agentId, since, limit }, context) => {
    const resolved = await resolveAgentAndSession(
      context.paseo,
      agentId,
      refreshedAt,
      inFlightRefresh,
      knownSessions,
    );
    if (!resolved) return { posts: [], latestSeq: 0 };
    const board = readSwarmBoard(brainRoot, resolved.sessionId, {
      since,
      limit: limit ?? 20,
    });
    return {
      posts: board.posts,
      latestSeq: board.latestSeq,
    };
  });

  server.handle(agyChildTranscriptGet, async ({ agentId, conversationId, limit, afterCursor }, context) => {
    const resolved = await resolveAgentAndSession(
      context.paseo,
      agentId,
      refreshedAt,
      inFlightRefresh,
      knownSessions,
    );
    if (!resolved) return null;
    const status = inspectAgySession({
      agentId: resolved.agentId,
      sessionId: resolved.sessionId,
      agentAlive: resolved.agentAlive,
    });
    if (!status) return null;
    const allowed = collectAllowedChildIds(status);
    return readChildTranscript(brainRoot, allowed, conversationId, limit ?? 60, afterCursor);
  });

  server.handle(agyChildStepDetailGet, async ({ agentId, conversationId, stepIndex }, context) => {
    const resolved = await resolveAgentAndSession(
      context.paseo,
      agentId,
      refreshedAt,
      inFlightRefresh,
      knownSessions,
    );
    if (!resolved) return null;
    const status = inspectAgySession({
      agentId: resolved.agentId,
      sessionId: resolved.sessionId,
      agentAlive: resolved.agentAlive,
    });
    if (!status) return null;
    const allowed = collectAllowedChildIds(status);
    return readChildStepDetail(brainRoot, allowed, conversationId, stepIndex);
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
          const agents = await collectActiveAgyAgents(context.paseo, refreshedAt, knownSessions);
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
    inFlightRefresh.clear();
    knownSessions.clear();
    clearTranscriptCache();
    clearStatusCaches();
  };
}
