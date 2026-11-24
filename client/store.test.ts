import assert from "node:assert/strict";
import test from "node:test";
import {
  clearAllStatuses,
  consumeConsoleNavRequest,
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
