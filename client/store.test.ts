import assert from "node:assert/strict";
import test from "node:test";
import {
  applyChildTranscriptResponse,
  clearAllStatuses,
  consumeConsoleNavRequest,
  formatLocalTimestamp,
  getChildTranscriptCache,
  getConsoleNavRequest,
  getStatusSnapshot,
  openConsoleForAgent,
  refreshAgentStatus,
  registerAgentWorkspace,
  replaceAllStatuses,
  resolveCoordinatorChildFromStatus,
  resolveMemberChildFromStatus,
  resolveSubagentChildFromStatus,
  sendSwarmMessage,
  setOpenConsoleHandler,
  setRefreshAgentStatusHandler,
  setSendSwarmMessageHandler,
  subscribeConsoleNav,
  subscribeStatus,
  unregisterAgentWorkspace,
  upsertAgentStatus,
} from "./store.ts";

test("openConsoleForAgent records and notifies child navigation target for cold and hot console switches", () => {
  clearAllStatuses();
  const opened: Array<{ agentId: string; workspaceId: string }> = [];
  let notifyCount = 0;

  setOpenConsoleHandler((agentId, workspaceId) => {
    opened.push({ agentId, workspaceId });
  });
  registerAgentWorkspace("agent-1", "ws-1");
  const unsub = subscribeConsoleNav(() => {
    notifyCount += 1;
  });

  try {
    // 1. Click a Swarm worker in popover -> sets pending child nav & opens console panel
    openConsoleForAgent("agent-1", undefined, {
      kind: "child",
      child: {
        conversationId: "worker-conv-1",
        label: "@f4-bmv-exp-scorecard",
        subtitle: "gemini-4-neon-high",
        running: true,
        workspace: "/tmp/wt",
        memberName: "f4-bmv-exp-scorecard",
      },
    });

    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0], { agentId: "agent-1", workspaceId: "ws-1" });
    assert.equal(notifyCount, 1);

    const first = getConsoleNavRequest("agent-1");
    assert.ok(first);
    assert.equal(first.target.kind, "child");
    if (first.target.kind === "child") {
      assert.equal(first.target.child.conversationId, "worker-conv-1");
      assert.equal(first.target.child.memberName, "f4-bmv-exp-scorecard");
    }

    // 2. Clicking a second agent before consumption advances seq; consuming stale seq is a no-op
    openConsoleForAgent("agent-1", "ws-1", {
      kind: "child",
      child: {
        conversationId: "worker-conv-2",
        label: "@auditor-w4",
        subtitle: null,
        running: false,
        workspace: null,
        memberName: "auditor-w4",
      },
    });
    const second = getConsoleNavRequest("agent-1");
    assert.ok(second);
    assert.ok(second.seq > first.seq);

    consumeConsoleNavRequest("agent-1", first.seq);
    assert.equal(getConsoleNavRequest("agent-1")?.seq, second.seq);

    // 3. Consuming the latest seq clears pending nav
    consumeConsoleNavRequest("agent-1", second.seq);
    assert.equal(getConsoleNavRequest("agent-1"), null);

    // 4. Overview target also works cleanly
    openConsoleForAgent("agent-1", "ws-1", { kind: "overview" });
    assert.equal(getConsoleNavRequest("agent-1")?.target.kind, "overview");
  } finally {
    unsub();
    unregisterAgentWorkspace("agent-1");
    setOpenConsoleHandler(null);
    clearAllStatuses();
  }
});

test("applyChildTranscriptResponse caches full loads and merges incremental deltas", () => {
  clearAllStatuses();
  try {
    assert.equal(getChildTranscriptCache("conv-a"), null);

    // 1. Initial full load
    const c1 = applyChildTranscriptResponse({
      conversationId: "conv-a",
      model: "gemini-4-neon-xhigh",
      steps: [
        { stepIndex: 1, kind: "user", title: "任务输入", summary: "start", status: "DONE", createdAt: null, model: null },
        { stepIndex: 2, kind: "assistant", title: "回复输出", summary: "working", status: "DONE", createdAt: null, model: "gemini-4-neon-xhigh" },
      ],
      totalSteps: 2,
      cursor: 2,
      mode: "full",
      unchanged: false,
    });
    assert.equal(c1.loadedOnce, true);
    assert.equal(c1.steps.length, 2);
    assert.equal(c1.cursor, 2);

    // 2. Unchanged delta preserves reference and steps
    const c2 = applyChildTranscriptResponse({
      conversationId: "conv-a",
      model: "gemini-4-neon-xhigh",
      steps: [],
      totalSteps: 2,
      cursor: 2,
      mode: "delta",
      unchanged: true,
    });
    assert.equal(c2.steps, c1.steps);

    // 3. Incremental delta appends only new step
    const c3 = applyChildTranscriptResponse({
      conversationId: "conv-a",
      model: "gemini-4-neon-xhigh",
      steps: [
        { stepIndex: 3, kind: "tool", title: "运行测试", summary: "运行测试", status: "DONE", createdAt: null, model: null },
      ],
      totalSteps: 3,
      cursor: 3,
      mode: "delta",
      unchanged: false,
    });
    assert.equal(c3.steps.length, 3);
    assert.equal(c3.steps[2]?.stepIndex, 3);
    assert.equal(c3.cursor, 3);
    assert.equal(getChildTranscriptCache("conv-a")?.steps.length, 3);
  } finally {
    clearAllStatuses();
  }
});

test("formatLocalTimestamp converts UTC ISO strings to local time and preserves local board strings", () => {
  const sample = "2026-11-24T12:03:51Z";
  const d = new Date(sample);
  const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));
  const expectedSameDay = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const expectedOtherDay = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${expectedSameDay}`;

  assert.equal(formatLocalTimestamp(sample, d.getTime() + 60_000), expectedSameDay);
  assert.equal(formatLocalTimestamp(d, d.getTime() + 60_000), expectedSameDay);
  assert.equal(formatLocalTimestamp(d.getTime(), d.getTime() + 60_000), expectedSameDay);
  assert.equal(formatLocalTimestamp(sample, d.getTime() + 2 * 86_400_000), expectedOtherDay);
  assert.equal(formatLocalTimestamp(d, d.getTime() + 2 * 86_400_000), expectedOtherDay);
  assert.equal(formatLocalTimestamp("2026-11-24 20:03:33"), "2026-11-24 20:03:33");
  assert.equal(formatLocalTimestamp(null), null);
});

test("resolveMemberChildFromStatus and resolveSubagentChildFromStatus resolve direct chat jump targets", () => {
  const status = {
    agentId: "a1",
    sessionId: "s1",
    backgroundActive: true,
    goalActive: false,
    coordinatorState: "swarm_wait" as const,
    pillLabel: "Swarm",
    summaryLine: "Swarm",
    swarm: {
      title: "Demo",
      working: 1,
      waiting: 0,
      completed: 0,
      members: [
        {
          name: "opus",
          conversationId: "conv-opus",
          model: "claude-opus-5-5-high",
          state: "working" as const,
          updatedAt: null,
          workspace: "/tmp/wt/opus",
        },
      ],
    },
    subagents: [
      {
        id: "sub-12345678",
        role: "M1 Challenger",
        typeName: "teamwork_challenger",
        state: "running" as const,
        updatedAt: null,
        model: "gemini-4-neon-high",
      },
    ],
    tasks: [],
    observedAt: Date.now(),
  };

  const memberTarget = resolveMemberChildFromStatus(status, "opus");
  assert.ok(memberTarget);
  assert.equal(memberTarget.conversationId, "conv-opus");
  assert.equal(memberTarget.label, "@opus");
  assert.equal(memberTarget.memberName, "opus");
  assert.equal(memberTarget.running, true);

  const subByRole = resolveSubagentChildFromStatus(status, { role: "M1 Challenger" });
  assert.ok(subByRole);
  assert.equal(subByRole.conversationId, "sub-12345678");
  assert.equal(subByRole.label, "M1 Challenger");

  const subById = resolveSubagentChildFromStatus(status, { id: "sub-1234" });
  assert.equal(subById?.conversationId, "sub-12345678");
});

test("upsertAgentStatus and refreshAgentStatus heal stale snapshots without clobbering sibling agents", async () => {
  clearAllStatuses();
  let notifications = 0;
  const unsub = subscribeStatus(() => {
    notifications += 1;
  });

  const makeStatus = (agentId: string, title: string, working: number) => ({
    agentId,
    sessionId: `sess-${agentId}`,
    backgroundActive: working > 0,
    goalActive: false,
    coordinatorState: working > 0 ? ("swarm_wait" as const) : ("idle" as const),
    pillLabel: working > 0 ? `Swarm ${working} 运行` : "Swarm ✓",
    summaryLine: title,
    swarm: {
      title,
      working,
      waiting: 0,
      completed: working > 0 ? 14 : 14,
      members: [],
    },
    subagents: [],
    tasks: [],
    observedAt: Date.now(),
  });

  try {
    replaceAllStatuses({
      a1: makeStatus("a1", "Old Wave", 0),
      a2: makeStatus("a2", "Other Window", 2),
    });
    assert.equal(getStatusSnapshot("a1")?.swarm?.title, "Old Wave");
    assert.equal(getStatusSnapshot("a2")?.swarm?.title, "Other Window");
    const beforeUpsert = notifications;

    setRefreshAgentStatusHandler(async (agentId) => {
      const fresh = makeStatus(agentId, "New Audit Wave", 4);
      upsertAgentStatus(agentId, fresh);
      return fresh;
    });

    const refreshed = await refreshAgentStatus("a1");
    assert.equal(refreshed?.swarm?.title, "New Audit Wave");
    assert.equal(getStatusSnapshot("a1")?.swarm?.title, "New Audit Wave");
    assert.equal(getStatusSnapshot("a1")?.swarm?.working, 4);
    assert.equal(getStatusSnapshot("a2")?.swarm?.title, "Other Window");
    assert.ok(notifications > beforeUpsert);

    // Clearing a single agent removes only that agent
    upsertAgentStatus("a1", null);
    assert.equal(getStatusSnapshot("a1"), null);
    assert.equal(getStatusSnapshot("a2")?.swarm?.title, "Other Window");
  } finally {
    unsub();
    setRefreshAgentStatusHandler(null);
    clearAllStatuses();
  }
});

test("resolveCoordinatorChildFromStatus and sendSwarmMessage target @coordinator cleanly", async () => {
  const status = {
    agentId: "a-coord",
    sessionId: "sess-coord-123",
    backgroundActive: true,
    goalActive: false,
    coordinatorState: "swarm_wait" as const,
    coordinator: {
      conversationId: "sess-coord-123",
      model: "gemini-4-neon-high",
      lastActivity: "等待消息板唤醒",
      stepCount: 86,
    },
    pillLabel: "Swarm",
    summaryLine: "Swarm",
    swarm: null,
    subagents: [],
    tasks: [],
    observedAt: Date.now(),
  };

  const coord = resolveCoordinatorChildFromStatus(status);
  assert.ok(coord);
  assert.equal(coord.conversationId, "sess-coord-123");
  assert.equal(coord.memberName, "coordinator");
  assert.equal(coord.isCoordinator, true);
  assert.equal(coord.subtitle, "gemini-4-neon-high");

  const sent: Array<{ agentId: string; text: string; targetMember?: string }> = [];
  setSendSwarmMessageHandler(async (agentId, text, targetMember) => {
    sent.push({ agentId, text, targetMember });
    return { ok: true, method: "hook_inbox", pendingCount: 1 };
  });
  try {
    const res = await sendSwarmMessage("a-coord", "11篇论文已拆完", "coordinator");
    assert.equal(res.ok, true);
    assert.equal(res.method, "hook_inbox");
    assert.equal(res.pendingCount, 1);
    assert.deepEqual(sent, [{ agentId: "a-coord", text: "11篇论文已拆完", targetMember: "coordinator" }]);
  } finally {
    setSendSwarmMessageHandler(null);
  }
});
