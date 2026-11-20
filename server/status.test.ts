import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectAgySession } from "./status.ts";

function setupBrain(
  homeDir: string,
  sid: string,
  options: {
    rows: Array<Record<string, unknown>>;
    fullRows?: Array<Record<string, unknown>>;
    hookState?: Record<string, unknown>;
    processState?: Record<string, unknown>;
    swarmMembers?: Record<string, unknown>;
    subagents?: Array<{ id: string; state: string; role: string; typeName: string }>;
  },
) {
  const bdir = path.join(homeDir, ".gemini", "antigravity-cli", "brain", sid, ".system_generated");
  const logsDir = path.join(bdir, "logs");
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    path.join(logsDir, "transcript.jsonl"),
    options.rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
  if (options.fullRows) {
    writeFileSync(
      path.join(logsDir, "transcript_full.jsonl"),
      options.fullRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );
  }
  if (options.hookState) {
    writeFileSync(path.join(logsDir, "hook-state.json"), JSON.stringify(options.hookState), "utf8");
  }
  if (options.processState) {
    writeFileSync(path.join(logsDir, "process.json"), JSON.stringify(options.processState), "utf8");
  }
  if (options.swarmMembers) {
    const swarmDir = path.join(bdir, "swarm");
    mkdirSync(swarmDir, { recursive: true });
    writeFileSync(
      path.join(swarmDir, "members.json"),
      JSON.stringify(options.swarmMembers),
      "utf8",
    );
  }
  if (options.subagents) {
    const subDir = path.join(bdir, "subagents");
    mkdirSync(subDir, { recursive: true });
    for (const s of options.subagents) {
      writeFileSync(
        path.join(subDir, `${s.id}.json`),
        JSON.stringify({
          conversationId: s.id,
          state: s.state,
          subagentDescriptor: { role: s.role, typeName: s.typeName },
        }),
        "utf8",
      );
    }
  }
}

test("inspectAgySession detects active swarm with working + waiting + killed members and /goal badge", () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "paseo-agy-status-1-"));
  try {
    const now = Date.now();
    const iso0 = new Date(now - 20_000).toISOString();
    const iso1 = new Date(now - 5_000).toISOString();

    setupBrain(homeDir, "coord-1", {
      rows: [
        {
          step_index: 1,
          type: "USER_INPUT",
          status: "DONE",
          created_at: iso0,
          content: "<USER_REQUEST>\n/goal finish all tasks",
          truncated_fields: ["content"],
        },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: iso1,
          tool_calls: [{ id: "tc-w", name: "swarm_wait", args: { since: 37 } }],
        },
        {
          step_index: 3,
          type: "GENERIC",
          status: "DONE",
          created_at: iso1,
          content: "Waiting for any message posted after #37.",
        },
      ],
      fullRows: [
        {
          step_index: 1,
          type: "USER_INPUT",
          status: "DONE",
          created_at: iso0,
          content: "<USER_REQUEST>\n/goal finish all tasks\n</USER_REQUEST>\n/goal is a [Slash Command]:",
        },
      ],
      hookState: { conversationId: "coord-1", event: "Stop", fullyIdle: false, pid: 12345, ts: now - 3_000 },
      swarmMembers: {
        title: "四力统一",
        members: {
          coordinator: { conversation_id: "coord-1", role: "coordinator" },
          "quantum-cosmo": {
            conversation_id: "w-1",
            role: "worker",
            phase: "RUNNING",
            wait_since: 36,
            last_nudged_seq: 39,
            killed: false,
            model: "gemini-4-carbon-high",
          },
          "lean-v3": {
            conversation_id: "w-2",
            role: "worker",
            phase: "RUNNING",
            wait_since: 37,
            last_nudged_seq: 37,
            killed: false,
            model: "gemini-4-carbon-high",
          },
          monitor: {
            conversation_id: "w-3",
            role: "worker",
            phase: "RUNNING",
            wait_since: 39,
            last_nudged_seq: 39,
            killed: false,
            model: "gemini-4-carbon-high",
          },
          "em-gauge": {
            conversation_id: "w-4",
            role: "worker",
            phase: "KILLED",
            killed: true,
            model: "gemini-flash",
          },
        },
      },
    });
    setupBrain(homeDir, "w-1", {
      rows: [{ step_index: 1, type: "PLANNER_RESPONSE", status: "RUNNING", created_at: iso1 }],
    });
    setupBrain(homeDir, "w-2", {
      rows: [{ step_index: 1, type: "GENERIC", status: "DONE", created_at: iso1 }],
      hookState: { conversationId: "w-2", event: "Stop", fullyIdle: true, ts: now - 4_000 },
    });

    const st = inspectAgySession({
      agentId: "agent-1",
      sessionId: "coord-1",
      agentAlive: true,
      homeDir,
      now,
      isPidAlive: () => true,
    });
    assert.ok(st);
    assert.equal(st.backgroundActive, true);
    assert.equal(st.goalActive, true);
    assert.equal(st.coordinatorState, "swarm_wait");
    assert.equal(st.pillLabel, "后台运行中 · Swarm 1 运行 / 2 待命");
    assert.equal(st.swarm?.working, 1);
    assert.equal(st.swarm?.waiting, 2);
    assert.equal(st.swarm?.completed, 1);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("inspectAgySession survives the 1.75s Stop-hook race right after swarm_wait", () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "paseo-agy-status-2-"));
  try {
    const now = Date.now();
    const iso0 = new Date(now - 10_000).toISOString();
    const iso1 = new Date(now - 500).toISOString();

    setupBrain(homeDir, "coord-2", {
      rows: [
        { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: iso0, content: "run" },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: iso1,
          tool_calls: [{ id: "tc-sw", name: "swarm_wait", args: { since: 10 } }],
        },
        { step_index: 3, type: "GENERIC", status: "DONE", created_at: iso1, content: "Waiting after #10." },
      ],
      // Stale hookState from earlier invocation (> 5s before iso1) simulating 1.75s Stop hook lag.
      hookState: { conversationId: "coord-2", event: "Stop", fullyIdle: true, pid: 22222, ts: now - 12_000 },
      swarmMembers: {
        members: {
          coordinator: { conversation_id: "coord-2", role: "coordinator" },
          worker1: {
            conversation_id: "w-10",
            role: "worker",
            wait_since: 10,
            last_nudged_seq: 10,
            killed: false,
          },
        },
      },
    });

    const st = inspectAgySession({
      agentId: "agent-2",
      sessionId: "coord-2",
      agentAlive: true,
      homeDir,
      now,
      isPidAlive: () => true,
    });
    assert.ok(st);
    assert.equal(st.backgroundActive, true);
    assert.equal(st.coordinatorState, "swarm_wait");
    assert.equal(st.pillLabel, "后台等唤醒 · Swarm 1 待命");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("inspectAgySession clears active status when recorded agy PID is dead even if hook-state left fullyIdle=false", () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "paseo-agy-status-3-"));
  try {
    const now = Date.now();
    const iso = new Date(now - 3_000).toISOString();
    setupBrain(homeDir, "coord-dead", {
      rows: [
        { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: iso, content: "/goal x" },
        { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso, tool_calls: [{ name: "swarm_wait", args: {} }] },
        { step_index: 3, type: "GENERIC", status: "DONE", created_at: iso, content: "Waiting" },
      ],
      hookState: { conversationId: "coord-dead", event: "Stop", fullyIdle: false, pid: 99991, ts: now - 2_000 },
      swarmMembers: {
        members: {
          coordinator: { conversation_id: "coord-dead", role: "coordinator" },
          w1: { conversation_id: "w-d1", role: "worker", wait_since: 1, last_nudged_seq: 5, killed: false },
        },
      },
    });

    const st = inspectAgySession({
      agentId: "agent-3",
      sessionId: "coord-dead",
      agentAlive: true,
      homeDir,
      now,
      isPidAlive: () => false,
    });
    assert.ok(st);
    assert.equal(st.backgroundActive, false);
    assert.equal(st.coordinatorState, "stopped");
    assert.equal(st.pillLabel, "");
    assert.equal(st.swarm?.members[0].state, "stopped");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("inspectAgySession marks finished invoke_subagent (SUBAGENT_STATE_ALIVE + child Stop fullyIdle=true) as completed", () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "paseo-agy-status-4-"));
  try {
    const now = Date.now();
    const iso = new Date(now - 5_000).toISOString();
    setupBrain(homeDir, "parent-sub-done", {
      rows: [
        { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: iso, content: "hi" },
        { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso, content: "all done", tool_calls: [] },
      ],
      hookState: { conversationId: "parent-sub-done", event: "Stop", fullyIdle: true, pid: 33333, ts: now - 4_000 },
      subagents: [{ id: "sub-done", state: "SUBAGENT_STATE_ALIVE", role: "Reviewer", typeName: "research" }],
    });
    setupBrain(homeDir, "sub-done", {
      rows: [{ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso, content: "ok" }],
      hookState: { conversationId: "sub-done", event: "Stop", fullyIdle: true, ts: now - 4_000 },
    });

    const st = inspectAgySession({
      agentId: "agent-4",
      sessionId: "parent-sub-done",
      agentAlive: true,
      homeDir,
      now,
      isPidAlive: () => true,
    });
    assert.ok(st);
    assert.equal(st.backgroundActive, false);
    assert.equal(st.subagents[0]?.state, "completed");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("inspectAgySession reports active invoke_subagent as running", () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "paseo-agy-status-5-"));
  try {
    const now = Date.now();
    const iso = new Date(now - 5_000).toISOString();
    setupBrain(homeDir, "parent-sub-run", {
      rows: [
        { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: iso, content: "hi" },
        { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso, content: "started", tool_calls: [] },
      ],
      hookState: { conversationId: "parent-sub-run", event: "Stop", fullyIdle: false, pid: 44444, ts: now - 4_000 },
      subagents: [{ id: "sub-run", state: "SUBAGENT_STATE_ALIVE", role: "Searcher", typeName: "research" }],
    });
    setupBrain(homeDir, "sub-run", {
      rows: [{ step_index: 1, type: "PLANNER_RESPONSE", status: "RUNNING", created_at: iso }],
    });

    const st = inspectAgySession({
      agentId: "agent-5",
      sessionId: "parent-sub-run",
      agentAlive: true,
      homeDir,
      now,
      isPidAlive: () => true,
    });
    assert.ok(st);
    assert.equal(st.backgroundActive, true);
    assert.equal(st.subagents[0]?.state, "running");
    assert.equal(st.pillLabel, "后台运行中 · 1 个子代理");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("inspectAgySession tracks active background run_command and clears when SYSTEM_MESSAGE settles", () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "paseo-agy-status-6-"));
  try {
    const now = Date.now();
    const iso = new Date(now - 5_000).toISOString();
    const sid = "parent-bg-cmd";
    setupBrain(homeDir, sid, {
      rows: [
        { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: iso, content: "run build" },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: iso,
          tool_calls: [{ id: "tc-bg", name: "run_command", args: { CommandLine: "npm test", toolSummary: "Run unit tests" } }],
        },
        {
          step_index: 3,
          type: "GENERIC",
          status: "DONE",
          created_at: iso,
          content: `Tool is running as a background task with task id: ${sid}/task-9`,
        },
      ],
      processState: { conversationId: sid, pid: 55555, event: "PreInvocation", ts: now - 5_000 },
    });

    const active = inspectAgySession({
      agentId: "agent-6",
      sessionId: sid,
      agentAlive: true,
      homeDir,
      now,
      isPidAlive: () => true,
    });
    assert.ok(active);
    assert.equal(active.backgroundActive, true);
    assert.equal(active.tasks.length, 1);
    assert.equal(active.tasks[0]?.summary, "Run unit tests");
    assert.equal(active.pillLabel, "后台运行中 · 1 个后台任务");

    // Settle via SYSTEM_MESSAGE + idle Stop
    setupBrain(homeDir, sid, {
      rows: [
        { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: iso, content: "run build" },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: iso,
          tool_calls: [{ id: "tc-bg", name: "run_command", args: { CommandLine: "npm test", toolSummary: "Run unit tests" } }],
        },
        {
          step_index: 3,
          type: "GENERIC",
          status: "DONE",
          created_at: iso,
          content: `Tool is running as a background task with task id: ${sid}/task-9`,
        },
        {
          step_index: 4,
          type: "SYSTEM_MESSAGE",
          status: "DONE",
          created_at: iso,
          content: `[Message] timestamp=${iso} sender=${sid}/task-9 content=Finished`,
        },
        {
          step_index: 5,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: new Date(now - 1_000).toISOString(),
          content: "Tests passed.",
          tool_calls: [],
        },
      ],
      hookState: { conversationId: sid, event: "Stop", fullyIdle: true, pid: 55555, ts: now - 900 },
    });

    const settled = inspectAgySession({
      agentId: "agent-6",
      sessionId: sid,
      agentAlive: true,
      homeDir,
      now,
      isPidAlive: () => true,
    });
    assert.ok(settled);
    assert.equal(settled.backgroundActive, false);
    assert.equal(settled.tasks.length, 0);
    assert.equal(settled.pillLabel, "");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
