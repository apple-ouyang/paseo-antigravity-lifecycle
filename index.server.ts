import { homedir } from "node:os";
import path from "node:path";
import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  clearTranscriptCache,
  collectAllowedChildIds,
  enqueueCoordinatorHookInboxMessage,
  formatCoordinatorMessagePayload,
  inspectAgyConsole,
  readChildStepDetail,
  readChildTranscript,
  readSwarmBoard,
  sendCoordinatorMessageViaAgentApi,
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
  agySwarmSendMessage,
  type AgentBgStatus,
} from "./shared/rpc.ts";

const WATCH_POLL_MS = 2_000;
const REFRESH_COOLDOWN_MS = 10_000;
const MAX_AGENT_LIST_PAGES = 5;

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
  const needsRefresh =
    !agent ||
    agent.status === "closed" ||
    (!agent.runtimeInfo?.sessionId && !agent.persistence?.sessionId);

  if (needsRefresh) {
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

async function listNonArchivedAgents(paseo: PaseoApi): Promise<PaseoAgent[]> {
  const agents: PaseoAgent[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_AGENT_LIST_PAGES; page += 1) {
    const list = await paseo.agents.list({
      sort: [{ key: "created_at", direction: "desc" }],
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const { agent } of list.entries) {
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
      agents.push(agent);
    }
    const nextCursor = list.pageInfo?.nextCursor ?? undefined;
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  return agents;
}

async function collectActiveAgyAgents(
  paseo: PaseoApi,
  refreshedAt: Map<string, number>,
  knownSessions: Map<string, ResolvedSession>,
): Promise<Record<string, AgentBgStatus>> {
  const result: Record<string, AgentBgStatus> = {};
  const agents = await listNonArchivedAgents(paseo);
  const now = Date.now();
  for (const agent of agents) {
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
    // Clear refresh cooldown so newly resumed agents pick up fresh status immediately.
    refreshedAt.delete(event.agent.id);
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

  server.handle(agySwarmSendMessage, async ({ agentId, text, targetMember, mode }, context) => {
    const resolved = await resolveAgentAndSession(
      context.paseo,
      agentId,
      refreshedAt,
      inFlightRefresh,
      knownSessions,
    );
    if (!resolved) {
      return { ok: false, method: "hook_inbox" as const, error: "未找到对应的 Antigravity 协调者会话" };
    }

    const sendMode = mode ?? "queue";
    const trimmed = text.trim();
    const normalizedTarget = targetMember?.trim();

    // 0. Explicit user opt-in: interrupt immediately to wake @coordinator right now.
    if (sendMode === "interrupt") {
      try {
        const directBody =
          !normalizedTarget || normalizedTarget === "coordinator"
            ? trimmed
            : `[请转达给 @${normalizedTarget}]\n${trimmed}`;
        await context.paseo.agents.ref(agentId).send(directBody);
        return { ok: true, method: "paseo_send" as const };
      } catch (error) {
        return {
          ok: false,
          method: "paseo_send" as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    // 1. If the plugin environment already exposes AGY LS credentials, use instant out-of-band agentapi.
    if (process.env.ANTIGRAVITY_LS_ADDRESS?.trim() && process.env.ANTIGRAVITY_CSRF_TOKEN?.trim()) {
      const viaAgentApi = await sendCoordinatorMessageViaAgentApi({
        sessionId: resolved.sessionId,
        text: trimmed,
        targetMember,
      });
      if (viaAgentApi.ok) {
        return { ok: true, method: "agentapi" as const };
      }
    }

    const status = inspectAgySession({
      agentId: resolved.agentId,
      sessionId: resolved.sessionId,
      agentAlive: resolved.agentAlive,
    });
    const currentAgent = context.paseo.agents.ref(agentId).current();
    const paseoRunning = currentAgent?.status === "running";

    // 2. Default non-interrupting mode when background Swarm/subagents are active OR turn is running:
    // deliver via AGY's official lifecycle hook inbox (`PreInvocation`/`PostInvocation`/`Stop`
    // injectSteps / continue), so running Swarm workers are never force-cancelled.
    if (status?.backgroundActive || paseoRunning) {
      try {
        ensureAntigravityHooksInstalled();
      } catch (error) {
        console.error(
          `[antigravity-lifecycle] swarm.send hook check failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const queued = enqueueCoordinatorHookInboxMessage({
        brainRoot,
        sessionId: resolved.sessionId,
        text: trimmed,
        targetMember,
      });
      if (queued.ok) {
        return {
          ok: true,
          method: "hook_inbox" as const,
          pendingCount: queued.pendingCount,
        };
      }
      return {
        ok: false,
        method: "hook_inbox" as const,
        error: `非中断收件箱写入失败：${queued.error ?? "unknown error"}`,
      };
    }

    // 3. Session is genuinely idle with no active background work -> start a normal turn cleanly.
    try {
      const { body } = formatCoordinatorMessagePayload(trimmed, targetMember);
      await context.paseo.agents.ref(agentId).send(body);
      return { ok: true, method: "paseo_send" as const };
    } catch (error) {
      return {
        ok: false,
        method: "paseo_send" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
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
            await context.push({ agents });
            lastHash = hash;
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
