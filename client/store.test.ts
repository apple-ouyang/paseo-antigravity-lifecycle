import assert from "node:assert/strict";
import test from "node:test";
import {
  applyChildTranscriptResponse,
  clearAllStatuses,
  consumeConsoleNavRequest,
  getChildTranscriptCache,
  getConsoleNavRequest,
  openConsoleForAgent,
  registerAgentWorkspace,
  setOpenConsoleHandler,
  subscribeConsoleNav,
  unregisterAgentWorkspace,
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
