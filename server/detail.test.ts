import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectAllowedChildIds,
  inspectAgyConsole,
  readChildTranscript,
  readSwarmBoard,
} from "./detail.ts";
import { inspectAgySession } from "./status.ts";

function writeJson(filePath: string, data: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data), "utf8");
}

function writeJsonl(filePath: string, rows: unknown[]) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

test("inspectAgySession discovers 4-level Teamwork hierarchy and bubbles deep running state", () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "paseo-agy-teamwork-"));
  try {
    const now = Date.now();
    const iso = new Date(now - 3_000).toISOString();
    const brain = path.join(homeDir, ".gemini", "antigravity-cli", "brain");

    // Level 0: root session
    writeJsonl(path.join(brain, "root-tw", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: iso, content: "/teamwork build simulator" },
      { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso, content: "Teamwork launched" },
    ]);
    writeJson(path.join(brain, "root-tw", ".system_generated", "logs", "process.json"), {
      conversationId: "root-tw",
      pid: 77777,
      event: "PreInvocation",
      ts: now - 3_000,
    });
    writeJson(path.join(brain, "root-tw", ".system_generated", "subagents", "tw-sentinel.json"), {
      conversationId: "tw-sentinel",
      state: "SUBAGENT_STATE_ALIVE",
      subagentDescriptor: { typeName: "teamwork", role: "Teamwork Multi-Agent Orchestrator" },
    });

    // Level 1: Sentinel (waiting/done) -> spawns Level 2 Project Orchestrator
    writeJsonl(path.join(brain, "tw-sentinel", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso, model: "gemini-4-neon-high", content: "Spawned orchestrator" },
    ]);
    writeJson(path.join(brain, "tw-sentinel", ".system_generated", "subagents", "tw-orch.json"), {
      conversationId: "tw-orch",
      state: "SUBAGENT_STATE_ALIVE",
      subagentDescriptor: { typeName: "teamwork_orchestrator", role: "Project Orchestrator" },
    });

    // Level 2: Project Orchestrator -> spawns Level 3 Sub-orchestrator (typeName: self!) & Challenger
    writeJsonl(path.join(brain, "tw-orch", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso, model: "gemini-4-carbon-high", content: "Running M1" },
    ]);
    writeJson(path.join(brain, "tw-orch", ".system_generated", "subagents", "m1-sub.json"), {
      conversationId: "m1-sub",
      state: "SUBAGENT_STATE_ALIVE",
      subagentDescriptor: { typeName: "self", role: "M1 Sub-orchestrator" },
    });

    // Level 3: M1 Sub-orchestrator -> spawns Level 4 active Challenger
    writeJsonl(path.join(brain, "m1-sub", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso, content: "Waiting on challenger" },
    ]);
    writeJson(path.join(brain, "m1-sub", ".system_generated", "subagents", "m1-chal.json"), {
      conversationId: "m1-chal",
      state: "SUBAGENT_STATE_ALIVE",
      subagentDescriptor: { typeName: "teamwork_challenger", role: "M1 Adversarial Challenger" },
    });

    // Level 4: Active Challenger running command
    writeJsonl(path.join(brain, "m1-chal", ".system_generated", "logs", "transcript.jsonl"), [
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "RUNNING",
        created_at: iso,
        model: "gemini-4-neon-high",
        tool_calls: [{ name: "run_command", args: { toolSummary: "Run adversarial stress suite" } }],
      },
    ]);

    const st = inspectAgySession({
      agentId: "agent-tw",
      sessionId: "root-tw",
      agentAlive: true,
      homeDir,
      now,
      isPidAlive: () => true,
    });

    assert.ok(st);
    assert.equal(st.backgroundActive, true);
    assert.equal(st.primaryMode, "teamwork");
    assert.ok(st.modes?.includes("teamwork"));
    assert.equal(st.subagents.length, 0); // All 4 nested nodes belong to teamwork branch
    assert.ok(st.teamwork);
    assert.equal(st.teamwork.active, true);
    assert.equal(st.teamwork.phase, "auditing");
    assert.equal(st.teamwork.totalNodes, 4);
    assert.equal(st.teamwork.runningNodes, 4); // Deep challenger bubbles running to alive ancestors
    assert.equal(st.teamwork.nodes[3]?.depth, 3);
    assert.equal(st.teamwork.nodes[3]?.category, "challenger");
    assert.match(st.teamwork.nodes[3]?.lastActivity ?? "", /adversarial stress suite/);
    assert.match(st.pillLabel, /^Teamwork · 门禁审核/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("inspectAgyConsole parses swarm plan.json, board.jsonl slices, and enforces child transcript whitelist", () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "paseo-agy-console-"));
  try {
    const now = Date.now();
    const iso = new Date(now - 2_000).toISOString();
    const brain = path.join(homeDir, ".gemini", "antigravity-cli", "brain");

    writeJsonl(path.join(brain, "sw-root", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: iso, content: "/swarm verify" },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: iso,
        tool_calls: [
          { name: "enter_plan_mode", args: {} },
          {
            name: "update_steps",
            args: {
              steps: JSON.stringify([
                { title: "Step A", status: "done" },
                { title: "Step B", status: "in_progress" },
              ]),
            },
          },
          { name: "run_workflow", args: { Description: "Batch lint 20 modules" } },
        ],
      },
      { step_index: 3, type: "GENERIC", status: "DONE", created_at: iso, content: "Workflow completed OK" },
    ]);
    writeJson(path.join(brain, "sw-root", ".system_generated", "swarm", "members.json"), {
      title: "Demo Swarm",
      members: {
        coordinator: { conversation_id: "sw-root", role: "coordinator" },
        "worker-a": {
          conversation_id: "sw-wa",
          role: "worker",
          workspace_mode: "share",
          workspace: "/tmp/wt/swarm-worker-a",
          last_read_seq: 1,
          wait_since: 1,
          last_nudged_seq: 2,
          killed: false,
          model: "gemini-4-neon-high",
        },
      },
    });
    writeJson(path.join(brain, "sw-root", ".system_generated", "swarm", "plan.json"), {
      goal: { title: "Ship Swarm Console", line: "Support Swarm and Teamwork in Paseo." },
      tasks: { "worker-a": "Build panel" },
      threads: [{ id: "t1", title: "UI", goal: "Render board", tasks: ["worker-a"] }],
    });
    writeJsonl(path.join(brain, "sw-root", ".system_generated", "swarm", "board.jsonl"), [
      { seq: 1, agent: "coordinator", text: "@worker-a please start", time: "2026-11-24 14:00:00" },
      {
        seq: 2,
        agent: "worker-a",
        text: "@coordinator [done] finished\nScreenshot: /tmp/a.png | board view",
        time: "2026-11-24 14:05:00",
      },
    ]);
    writeJsonl(path.join(brain, "sw-wa", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: iso, content: "Build panel" },
      { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso, model: "gemini-4-neon-high", content: "Panel built." },
    ]);
    // Unrelated session that must NOT be readable via child transcript RPC
    writeJsonl(path.join(brain, "foreign-secret", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: iso, content: "secret" },
    ]);

    const detail = inspectAgyConsole({
      agentId: "agent-sw",
      sessionId: "sw-root",
      agentAlive: true,
      homeDir,
      now,
      isPidAlive: () => true,
    });
    assert.ok(detail);
    assert.equal(detail.swarmPlan?.goal?.title, "Ship Swarm Console");
    assert.equal(detail.boardTotal, 2);
    assert.deepEqual(detail.boardPosts[1]?.mentions, ["coordinator"]);
    assert.deepEqual(detail.boardPosts[1]?.screenshots, [{ path: "/tmp/a.png", caption: "board view" }]);
    assert.equal(detail.status.plan?.inPlanMode, true);
    assert.equal(detail.status.plan?.completed, 1);
    assert.equal(detail.status.plan?.total, 2);
    assert.equal(detail.status.workflows?.length, 1);
    assert.equal(detail.status.swarm?.latestSeq, 2);

    const slice = readSwarmBoard(brain, "sw-root", { since: 1 });
    assert.equal(slice.posts.length, 1);
    assert.equal(slice.posts[0]?.seq, 2);

    const allowed = collectAllowedChildIds(detail.status);
    const workerTx = readChildTranscript(brain, allowed, "sw-wa", 20);
    assert.ok(workerTx);
    assert.equal(workerTx.steps.length, 2);
    assert.equal(workerTx.model, "gemini-4-neon-high");

    const denied = readChildTranscript(brain, allowed, "foreign-secret", 20);
    assert.equal(denied, null);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("inspectAgySession computes current-wave Swarm progress percentage, [done] delivery, and parallel ETA", () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "paseo-agy-eta-"));
  try {
    const now = Date.now();
    const brain = path.join(homeDir, ".gemini", "antigravity-cli", "brain");
    const tStart = new Date(now - 10 * 60_000).toISOString();
    const tDone1 = new Date(now - 2 * 60_000).toISOString(); // 8m duration
    const tStart2 = new Date(now - 5 * 60_000).toISOString(); // 5m elapsed so far -> ~3m remaining

    writeJsonl(path.join(brain, "wave-coord", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: tStart, content: "/swarm wave2" },
      { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", created_at: tDone1, tool_calls: [{ name: "swarm_wait", args: { since: 2 } }] },
    ]);
    writeJson(path.join(brain, "wave-coord", ".system_generated", "logs", "process.json"), {
      conversationId: "wave-coord",
      pid: 88888,
      event: "PreInvocation",
      ts: now - 10_000,
    });
    writeJson(path.join(brain, "wave-coord", ".system_generated", "swarm", "members.json"), {
      title: "Wave 2",
      members: {
        coordinator: { conversation_id: "wave-coord", role: "coordinator" },
        "old-wave1": { conversation_id: "w-old", role: "worker", killed: true, phase: "KILLED" },
        monitor: { conversation_id: "w-mon", role: "worker", killed: false, phase: "RUNNING", wait_since: 2, last_nudged_seq: 2 },
        "lane-a": { conversation_id: "w-a", role: "worker", killed: false, phase: "RUNNING", wait_since: 2, last_nudged_seq: 2 },
        "lane-b": { conversation_id: "w-b", role: "worker", killed: false, phase: "RUNNING", wait_since: 1, last_nudged_seq: 2 },
      },
    });
    writeJson(path.join(brain, "wave-coord", ".system_generated", "swarm", "plan.json"), {
      goal: { title: "Wave 2 Goal", line: "Two lanes" },
      tasks: { "lane-a": "Lane A", "lane-b": "Lane B" },
      threads: [{ id: "t1", title: "Lanes", goal: "Finish", tasks: ["lane-a", "lane-b"] }],
    });
    writeJsonl(path.join(brain, "wave-coord", ".system_generated", "swarm", "board.jsonl"), [
      { seq: 1, agent: "coordinator", text: "@lane-a @lane-b post [done] when finished", time: "2026-11-24 15:00:00" },
      { seq: 2, agent: "lane-a", text: "@coordinator [done] Lane A passed all checks", time: "2026-11-24 15:08:00" },
    ]);
    writeJsonl(path.join(brain, "w-a", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: tStart, content: "do A" },
      { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", created_at: tDone1, content: "done" },
    ]);
    writeJson(path.join(brain, "w-a", ".system_generated", "logs", "hook-state.json"), {
      conversationId: "w-a",
      event: "Stop",
      fullyIdle: true,
      ts: now - 2 * 60_000,
    });
    writeJsonl(path.join(brain, "w-b", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: tStart2, content: "do B" },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        status: "RUNNING",
        created_at: new Date(now - 5_000).toISOString(),
        tool_calls: [
          {
            name: "update_steps",
            args: {
              steps: JSON.stringify([
                { title: "s1", status: "done" },
                { title: "s2", status: "in_progress" },
              ]),
            },
          },
        ],
      },
    ]);

    const st = inspectAgySession({
      agentId: "agent-eta",
      sessionId: "wave-coord",
      agentAlive: true,
      homeDir,
      now,
      isPidAlive: () => true,
    });
    assert.ok(st);
    assert.ok(st.progress);
    assert.equal(st.progress.scopeLabel, "当前波次");
    assert.equal(st.progress.total, 2); // excludes old-wave1 & monitor
    assert.equal(st.progress.completed, 1); // lane-a delivered via [done] even before kill!
    assert.equal(st.progress.running, 1);
    assert.equal(st.progress.percent, 50);
    assert.equal(st.progress.etaState, "estimated");
    assert.ok((st.progress.etaMs ?? 0) > 2 * 60_000 && (st.progress.etaMs ?? 0) < 4 * 60_000);
    const laneB = st.swarm?.members.find((m) => m.name === "lane-b");
    assert.deepEqual(laneB?.stepProgress, { done: 1, total: 2 });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
