import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  COORDINATOR_INBOX_FILENAME,
  clearTranscriptCache,
  collectAllowedChildIds,
  enqueueCoordinatorHookInboxMessage,
  formatCoordinatorMessagePayload,
  inspectAgyConsole,
  readChildStepDetail,
  readChildTranscript,
  readSwarmBoard,
  sendCoordinatorMessageViaAgentApi,
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

test("readChildTranscript caches parsed steps and returns byte-incremental deltas safely", () => {
  clearTranscriptCache();
  const homeDir = mkdtempSync(path.join(tmpdir(), "paseo-agy-delta-"));
  try {
    const brain = path.join(homeDir, ".gemini", "antigravity-cli", "brain");
    const txPath = path.join(brain, "worker-inc", ".system_generated", "logs", "transcript.jsonl");
    const allowed = new Set(["worker-inc"]);
    const iso = new Date().toISOString();

    // 1. Missing file before worker writes first line
    const empty = readChildTranscript(brain, allowed, "worker-inc", 60);
    assert.ok(empty);
    assert.equal(empty.totalSteps, 0);
    assert.equal(empty.cursor, 0);
    assert.equal(empty.mode, "full");

    // 2. Initial 2 lines written
    writeJsonl(txPath, [
      { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: iso, content: "检查任务" },
      { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso, model: "gemini-4-neon-xhigh", content: "开始处理" },
    ]);
    const full = readChildTranscript(brain, allowed, "worker-inc", 60);
    assert.ok(full);
    assert.equal(full.mode, "full");
    assert.equal(full.unchanged, false);
    assert.equal(full.steps.length, 2);
    assert.equal(full.cursor, 2);

    // 3. Re-query with afterCursor=2 when file unchanged -> delta + unchanged=true + 0 steps
    const same = readChildTranscript(brain, allowed, "worker-inc", 60, full.cursor);
    assert.ok(same);
    assert.equal(same.mode, "delta");
    assert.equal(same.unchanged, true);
    assert.equal(same.steps.length, 0);
    assert.equal(same.cursor, 2);

    // 4. Append a partial UTF-8 JSON line (no newline yet) -> should NOT crash or corrupt
    const thirdRow = JSON.stringify({
      step_index: 3,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso,
      content: "中文增量回复内容完成",
    });
    const halfBuf = Buffer.from(thirdRow + "\n", "utf8");
    const splitAt = Math.floor(halfBuf.length / 2);
    appendFileSync(txPath, halfBuf.subarray(0, splitAt));
    const partial = readChildTranscript(brain, allowed, "worker-inc", 60, full.cursor);
    assert.ok(partial);
    assert.equal(partial.mode, "delta");
    assert.equal(partial.steps.length, 0);
    assert.equal(partial.cursor, 2);

    // 5. Append remaining bytes -> delta returns ONLY the new step 3 with intact Chinese UTF-8
    appendFileSync(txPath, halfBuf.subarray(splitAt));
    const delta = readChildTranscript(brain, allowed, "worker-inc", 60, full.cursor);
    assert.ok(delta);
    assert.equal(delta.mode, "delta");
    assert.equal(delta.unchanged, false);
    assert.equal(delta.steps.length, 1);
    assert.equal(delta.steps[0]?.stepIndex, 3);
    assert.equal(delta.steps[0]?.summary, "中文增量回复内容完成");
    assert.equal(delta.cursor, 3);
    assert.equal(delta.totalSteps, 3);
  } finally {
    clearTranscriptCache();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("inspectAgySession switches progress to new Swarm wave when plan.json is stale from prior wave", () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "paseo-agy-newwave-"));
  try {
    const now = Date.now();
    const brain = path.join(homeDir, ".gemini", "antigravity-cli", "brain");
    const tOldStart = new Date(now - 70 * 60_000).toISOString();
    const tOldEnd = new Date(now - 40 * 60_000).toISOString();
    const tNewTitle = new Date(now - 13 * 60_000).toISOString();
    const tNewStart = new Date(now - 12 * 60_000).toISOString();
    const tNewDone = new Date(now - 2 * 60_000).toISOString();

    writeJsonl(path.join(brain, "multi-wave", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: tOldStart, content: "/swarm wave1" },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: tNewTitle,
        tool_calls: [{ name: "swarm", args: { action: "\"title\"", title: "\"Wave 2 New\"" } }],
      },
      {
        step_index: 3,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: new Date(now - 5_000).toISOString(),
        tool_calls: [{ name: "swarm_wait", args: { since: 10 } }],
      },
    ]);
    writeJson(path.join(brain, "multi-wave", ".system_generated", "logs", "process.json"), {
      conversationId: "multi-wave",
      pid: 99999,
      event: "PreInvocation",
      ts: now - 5_000,
    });
    // Stale plan.json still lists only Wave 1's killed members!
    writeJson(path.join(brain, "multi-wave", ".system_generated", "swarm", "plan.json"), {
      goal: { title: "Old Wave 1 Goal", line: "Old line" },
      tasks: { "old-a": "Old A", "old-b": "Old B" },
      threads: [{ id: "t-old", title: "Old Thread", goal: "Old", tasks: ["old-a", "old-b"] }],
    });
    writeJson(path.join(brain, "multi-wave", ".system_generated", "swarm", "members.json"), {
      title: "Wave 2 New",
      members: {
        coordinator: { conversation_id: "multi-wave", role: "coordinator" },
        "old-a": { conversation_id: "c-old-a", role: "worker", killed: true, phase: "KILLED" },
        "old-b": { conversation_id: "c-old-b", role: "worker", killed: true, phase: "KILLED" },
        // New wave: p1 already killed/done, p2 running, p3 waiting
        "p1-done": { conversation_id: "c-p1", role: "worker", killed: true, phase: "KILLED" },
        "p2-run": { conversation_id: "c-p2", role: "worker", killed: false, phase: "RUNNING", last_nudged_seq: 11, wait_since: 10 },
        "p3-wait": { conversation_id: "c-p3", role: "worker", killed: false, phase: "RUNNING", last_nudged_seq: 10, wait_since: 10 },
      },
    });
    writeJsonl(path.join(brain, "c-old-a", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: tOldStart, content: "old a" },
      { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", created_at: tOldEnd, content: "done" },
    ]);
    writeJsonl(path.join(brain, "c-old-b", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: tOldStart, content: "old b" },
      { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", created_at: tOldEnd, content: "done" },
    ]);
    writeJsonl(path.join(brain, "c-p1", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: tNewStart, content: "p1" },
      { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", created_at: tNewDone, content: "p1 done" },
    ]);
    writeJsonl(path.join(brain, "c-p2", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: tNewStart, content: "p2" },
      { step_index: 2, type: "PLANNER_RESPONSE", status: "RUNNING", created_at: new Date(now - 3_000).toISOString(), content: "" },
    ]);
    writeJsonl(path.join(brain, "c-p3", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: tNewStart, content: "p3" },
      { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", created_at: new Date(now - 30_000).toISOString(), content: "waiting" },
    ]);

    const st = inspectAgySession({
      agentId: "agent-mw",
      sessionId: "multi-wave",
      agentAlive: true,
      homeDir,
      now,
      isPidAlive: () => true,
    });
    assert.ok(st);
    assert.ok(st.progress);
    assert.equal(st.progress.scopeLabel, "当前波次");
    // Must ignore stale 2/2 from plan.json and count the 3 Wave 2 members (p1 done, p2 running, p3 waiting)!
    assert.equal(st.progress.total, 3);
    assert.equal(st.progress.completed, 1);
    assert.equal(st.progress.running, 1);
    assert.equal(st.progress.waiting, 1);
    assert.equal(st.progress.percent, 33);
    // Elapsed time must reflect Wave 2 (~12m), NOT Wave 1 (~70m)!
    assert.ok((st.progress.elapsedMs ?? 0) < 20 * 60_000);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("inspectAgySession matches official AGY turnEnded logic for mid-turn wakeups vs swarm_wait", () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "paseo-agy-turnended-"));
  try {
    const now = Date.now();
    const brain = path.join(homeDir, ".gemini", "antigravity-cli", "brain");
    const iso1 = new Date(now - 60_000).toISOString();
    const iso2 = new Date(now - 10_000).toISOString();

    writeJsonl(path.join(brain, "te-coord", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: iso1, content: "/swarm go" },
      { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso2, tool_calls: [{ name: "swarm_wait", args: { since: 5 } }] },
    ]);
    writeJson(path.join(brain, "te-coord", ".system_generated", "logs", "process.json"), {
      conversationId: "te-coord",
      pid: 77771,
      event: "PreInvocation",
      ts: now - 5_000,
    });
    writeJson(path.join(brain, "te-coord", ".system_generated", "swarm", "members.json"), {
      title: "TurnEnded Check",
      members: {
        coordinator: { conversation_id: "te-coord", role: "coordinator" },
        "w-woken": { conversation_id: "c-woken", role: "worker", killed: false, wait_since: 5, last_nudged_seq: 5 },
        "w-tool": { conversation_id: "c-tool", role: "worker", killed: false, wait_since: 5, last_nudged_seq: 5 },
        "w-parked": { conversation_id: "c-parked", role: "worker", killed: false, wait_since: 5, last_nudged_seq: 5 },
      },
    });

    // 1. Woken by SYSTEM_MESSAGE (no PLANNER_RESPONSE yet -> mid-turn working!)
    writeJsonl(path.join(brain, "c-woken", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso1, content: "waiting" },
      { step_index: 2, type: "SYSTEM_MESSAGE", status: "DONE", created_at: iso2, content: "[swarm] new board message #6" },
    ]);
    // 2. Non-wait tool results returned (model thinking on tool outputs -> mid-turn working!)
    writeJsonl(path.join(brain, "c-tool", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso1, tool_calls: [{ name: "run_command", args: {} }] },
      { step_index: 2, type: "GENERIC", status: "DONE", created_at: iso2, content: "exit 0" },
    ]);
    // 3. Parked in swarm_wait with GENERIC DONE -> waiting!
    writeJsonl(path.join(brain, "c-parked", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso1, tool_calls: [{ name: "swarm_wait", args: { since: 5 } }] },
      { step_index: 2, type: "GENERIC", status: "DONE", created_at: iso2, content: "waiting" },
    ]);

    const st = inspectAgySession({
      agentId: "agent-te",
      sessionId: "te-coord",
      agentAlive: true,
      homeDir,
      now,
      isPidAlive: () => true,
    });
    assert.ok(st?.swarm);
    const byName = new Map(st.swarm.members.map((m) => [m.name, m.state]));
    assert.equal(byName.get("w-woken"), "working");
    assert.equal(byName.get("w-tool"), "working");
    assert.equal(byName.get("w-parked"), "waiting");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("inspectAgySession clears stale [done] on rework, recognizes [review:x] PASS, and handles empty title + active plan", () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "paseo-agy-rework-"));
  try {
    const now = Date.now();
    const brain = path.join(homeDir, ".gemini", "antigravity-cli", "brain");
    const iso1 = new Date(now - 120_000).toISOString();
    const iso2 = new Date(now - 10_000).toISOString();

    writeJsonl(path.join(brain, "rw-coord", ".system_generated", "logs", "transcript.jsonl"), [
      { step_index: 1, type: "USER_INPUT", status: "DONE", created_at: iso1, content: "/swarm check" },
      { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso2, tool_calls: [{ name: "swarm_wait", args: { since: 4 } }] },
    ]);
    writeJson(path.join(brain, "rw-coord", ".system_generated", "logs", "process.json"), {
      conversationId: "rw-coord",
      pid: 77772,
      event: "PreInvocation",
      ts: now - 5_000,
    });
    writeJson(path.join(brain, "rw-coord", ".system_generated", "swarm", "members.json"), {
      title: "",
      members: {
        coordinator: { conversation_id: "rw-coord", role: "coordinator" },
        "lane-pass": { conversation_id: "c-pass", role: "worker", killed: false, wait_since: 4, last_nudged_seq: 4 },
        "lane-rework": { conversation_id: "c-rework", role: "worker", killed: false, wait_since: 4, last_nudged_seq: 4 },
        "auditor-x": { conversation_id: "c-aud", role: "worker", killed: false, wait_since: 4, last_nudged_seq: 4 },
      },
    });
    writeJsonl(path.join(brain, "rw-coord", ".system_generated", "swarm", "board.jsonl"), [
      { seq: 1, agent: "lane-rework", text: "@coordinator [done] initial submit", time: "2026-11-24 20:50:00" },
      { seq: 2, agent: "lane-pass", text: "@auditor-x 返工完成，请复审", time: "2026-11-24 20:55:00" },
      { seq: 3, agent: "auditor-x", text: "@coordinator [review:lane-pass] PASS 全部闭环", time: "2026-11-24 20:58:00" },
      { seq: 4, agent: "auditor-x", text: "@lane-rework BLOCK 请修复 2 处数值误差", time: "2026-11-24 21:00:00" },
    ]);
    for (const cid of ["c-pass", "c-rework", "c-aud"]) {
      writeJsonl(path.join(brain, cid, ".system_generated", "logs", "transcript.jsonl"), [
        { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso2, tool_calls: [{ name: "swarm_wait", args: { since: 4 } }] },
        { step_index: 2, type: "GENERIC", status: "DONE", created_at: iso2, content: "waiting" },
      ]);
    }

    const st = inspectAgySession({
      agentId: "agent-rw",
      sessionId: "rw-coord",
      agentAlive: true,
      homeDir,
      now,
      isPidAlive: () => true,
    });
    assert.ok(st?.swarm);
    // Empty title string should normalize to null
    assert.equal(st.swarm.title, null);
    const byName = new Map(st.swarm.members.map((m) => [m.name, m]));
    assert.equal(byName.get("lane-pass")?.delivered, true);
    assert.equal(byName.get("lane-rework")?.delivered, false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("readChildStepDetail loads full untruncated content, thinking, post_message text, and paired tool output", () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "paseo-agy-stepdetail-"));
  try {
    const brain = path.join(homeDir, ".gemini", "antigravity-cli", "brain");
    const logs = path.join(brain, "worker-full", ".system_generated", "logs");
    const iso = new Date().toISOString();
    const longPost = "@coordinator [done] 定案意见：" + "详细论证内容。".repeat(80);
    const longThinking = "Deep chain of thought " + "reasoning ".repeat(50);

    // Compact transcript has truncated args, while transcript_full has complete content
    writeJsonl(path.join(logs, "transcript.jsonl"), [
      {
        step_index: 14,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: iso,
        model: "claude-opus-5-5-high",
        tool_calls: [{ name: "post_message", args: { text: `"${longPost.slice(0, 60)}` } }],
      },
      { step_index: 15, type: "GENERIC", status: "DONE", created_at: iso, content: "Posted #2" },
    ]);
    writeJsonl(path.join(logs, "transcript_full.jsonl"), [
      {
        step_index: 14,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: iso,
        model: "claude-opus-5-5-high",
        thinking: longThinking,
        tool_calls: [
          { name: "post_message", args: { text: JSON.stringify(longPost) } },
          { name: "swarm_wait", args: { since: 1 } },
        ],
      },
      {
        step_index: 15,
        type: "GENERIC",
        status: "DONE",
        created_at: iso,
        content: "Created At: 2026-11-24T22:09:00+08:00\nCompleted At: 2026-11-24T22:09:00+08:00\nPosted message #2",
      },
      {
        step_index: 16,
        type: "GENERIC",
        status: "DONE",
        created_at: iso,
        content: "Waiting on board > #1",
      },
    ]);

    const allowed = new Set(["worker-full"]);
    const detail = readChildStepDetail(brain, allowed, "worker-full", 14);
    assert.ok(detail);
    assert.equal(detail.stepIndex, 14);
    assert.equal(detail.model, "claude-opus-5-5-high");
    assert.equal(detail.thinking, longThinking.trim());
    assert.equal(detail.toolCalls.length, 2);
    assert.equal(detail.toolCalls[0]?.name, "post_message");
    assert.equal(detail.toolCalls[0]?.primaryText, longPost);
    assert.equal(detail.toolCalls[0]?.output, "Posted message #2");
    assert.equal(detail.toolCalls[1]?.name, "swarm_wait");
    assert.equal(detail.toolCalls[1]?.output, "Waiting on board > #1");

    // Unauthorized conversation must be denied
    assert.equal(readChildStepDetail(brain, allowed, "other-secret", 14), null);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("readChildStepDetail renders structured edit_file LCS diff, write_file lines, and run_command without raw JSON blobs", () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "paseo-agy-stepdiff-"));
  try {
    const brain = path.join(homeDir, ".gemini", "antigravity-cli", "brain");
    const logs = path.join(brain, "worker-diff", ".system_generated", "logs");
    const iso = new Date().toISOString();

    writeJsonl(path.join(logs, "transcript_full.jsonl"), [
      {
        step_index: 41,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: iso,
        model: "gemini-4-neon-high",
        tool_calls: [
          {
            name: "edit_file",
            args: {
              Path: JSON.stringify("/Users/admin/workspace/research/main.tex"),
              Target: JSON.stringify("line 1\nold line 2\nline 3\n"),
              Replacement: JSON.stringify("line 1\nnew line 2a\nnew line 2b\nline 3\n"),
            },
          },
          {
            name: "write_file",
            args: {
              Path: JSON.stringify("/Users/admin/workspace/research/papers/p1/main.tex"),
              Content: JSON.stringify("\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n"),
              Overwrite: true,
            },
          },
          {
            name: "run_command",
            args: {
              CommandLine: JSON.stringify("mkdir -p papers/p1 && cp fig.pdf papers/p1/"),
              toolSummary: JSON.stringify("Create dirs"),
              WaitMsBeforeAsync: 5000,
            },
          },
        ],
      },
      { step_index: 42, type: "GENERIC", status: "DONE", created_at: iso, content: "Edited file." },
      { step_index: 43, type: "GENERIC", status: "DONE", created_at: iso, content: "Created file." },
      { step_index: 44, type: "GENERIC", status: "DONE", created_at: iso, content: "Command exited with code 0." },
    ]);

    const detail = readChildStepDetail(brain, new Set(["worker-diff"]), "worker-diff", 41);
    assert.ok(detail);
    assert.equal(detail.toolCalls.length, 3);

    // 1. edit_file -> structured LCS diff, no raw JSON argsText
    const editTc = detail.toolCalls[0];
    assert.ok(editTc?.diff);
    assert.equal(editTc.diff.mode, "edit");
    assert.equal(editTc.diff.addedLines, 2);
    assert.equal(editTc.diff.removedLines, 1);
    assert.equal(editTc.argsText, null);
    assert.ok(editTc.diff.lines.some((l) => l.kind === "del" && l.text === "old line 2"));
    assert.ok(editTc.diff.lines.some((l) => l.kind === "add" && l.text === "new line 2a"));
    assert.ok(editTc.diff.lines.some((l) => l.kind === "ctx" && l.text === "line 1"));

    // 2. write_file -> structured added lines with unescaped newlines, no raw JSON Content blob
    const writeTc = detail.toolCalls[1];
    assert.ok(writeTc?.diff);
    assert.equal(writeTc.diff.mode, "write");
    assert.equal(writeTc.diff.addedLines, 4);
    assert.equal(writeTc.diff.removedLines, 0);
    assert.equal(writeTc.diff.lines[0]?.text, "\\documentclass{article}");
    assert.equal(writeTc.argsText, null);
    assert.equal(writeTc.subtitle, "…/p1/main.tex");

    // 3. run_command -> clean command string & subtitle, no noisy WaitMsBeforeAsync JSON
    const cmdTc = detail.toolCalls[2];
    assert.equal(cmdTc?.command, "mkdir -p papers/p1 && cp fig.pdf papers/p1/");
    assert.equal(cmdTc?.argsText, null);
    assert.equal(cmdTc?.output, "Command exited with code 0.");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("enqueueCoordinatorHookInboxMessage queues non-interrupting coordinator directives safely", () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "paseo-agy-inbox-"));
  try {
    const brain = path.join(homeDir, ".gemini", "antigravity-cli", "brain");
    const coordId = "0abf5d68-0fb5-467e-b0ec-0bdf0441ff14";

    const first = enqueueCoordinatorHookInboxMessage({
      brainRoot: brain,
      sessionId: coordId,
      text: "现在啥情况了？总结下",
      targetMember: "coordinator",
      now: 1795559000000,
    });
    assert.equal(first.ok, true);
    assert.equal(first.pendingCount, 1);
    assert.ok(first.inboxPath?.endsWith(COORDINATOR_INBOX_FILENAME));

    const second = enqueueCoordinatorHookInboxMessage({
      brainRoot: brain,
      sessionId: coordId,
      text: "先核对第3节",
      targetMember: "s4-gamma-bridge",
      now: 1795559001000,
    });
    assert.equal(second.ok, true);
    assert.equal(second.pendingCount, 2);

    const lines = readFileSync(first.inboxPath!, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { body: string; targetMember: string });
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.targetMember, "coordinator");
    assert.ok(lines[0]?.body.includes("@coordinator"));
    assert.ok(lines[0]?.body.includes("现在啥情况了？总结下"));
    assert.equal(lines[1]?.targetMember, "s4-gamma-bridge");
    assert.ok(lines[1]?.body.includes("@s4-gamma-bridge"));

    const bad = enqueueCoordinatorHookInboxMessage({
      brainRoot: brain,
      sessionId: "../evil",
      text: "hi",
    });
    assert.equal(bad.ok, false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("sendCoordinatorMessageViaAgentApi uses env credentials when present and rejects cleanly when absent", async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "paseo-agy-agentapi-"));
  try {
    const coordId = "0abf5d68-0fb5-467e-b0ec-0bdf0441ff14";

    // Without ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CSRF_TOKEN -> fails cleanly without spawning CLI
    const missingEnv = await sendCoordinatorMessageViaAgentApi({
      sessionId: coordId,
      text: "hi",
      homeDir,
      env: {},
    });
    assert.equal(missingEnv.ok, false);
    assert.ok(missingEnv.error?.includes("ANTIGRAVITY_LS_ADDRESS"));

    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const res1 = await sendCoordinatorMessageViaAgentApi({
      sessionId: coordId,
      text: "11篇论文已经拆分完毕，基于最新版改",
      targetMember: "coordinator",
      homeDir,
      env: {
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:54321",
        ANTIGRAVITY_CSRF_TOKEN: "csrf-unit-test",
      },
      runner: async (file, args, opts) => {
        calls.push({ file, args, env: opts.env });
        return { stdout: '{"response":{"sendMessage":{}}}', stderr: "" };
      },
    });
    assert.equal(res1.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.args[0], "agentapi");
    assert.equal(calls[0]?.args[1], "send-message");
    assert.equal(calls[0]?.args[3], coordId);
    assert.ok(calls[0]?.args[4]?.includes("11篇论文已经拆分完毕"));
    assert.ok(calls[0]?.args[4]?.includes("@coordinator"));
    assert.equal(calls[0]?.env.ANTIGRAVITY_LS_ADDRESS, "127.0.0.1:54321");

    const relayed = formatCoordinatorMessagePayload("先核对第3节", "s4-gamma-bridge");
    assert.ok(relayed.title.includes("@s4-gamma-bridge"));
    assert.ok(relayed.body.includes("@s4-gamma-bridge"));
    assert.ok(relayed.body.includes("@coordinator"));

    const bad = await sendCoordinatorMessageViaAgentApi({
      sessionId: "../evil",
      text: "hi",
      homeDir,
      env: { ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:1", ANTIGRAVITY_CSRF_TOKEN: "x" },
    });
    assert.equal(bad.ok, false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
