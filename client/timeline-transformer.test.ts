import assert from "node:assert/strict";
import test from "node:test";
import { AgyToolCardSchema } from "../shared/timeline.ts";
import { transformAgyOtherToolCall } from "./timeline-transformer.ts";

function callTransform(title: string, input: unknown, status: "running" | "completed" = "completed") {
  return transformAgyOtherToolCall({
    item: {
      type: "tool_call",
      callId: "call_1",
      name: "other",
      status,
      error: null,
      detail: {
        type: "unknown",
        input,
        output: null,
      },
      metadata: {
        kind: "other",
        title,
      },
    },
    phase: status === "running" ? "streaming" : "complete",
  });
}

test("transformAgyOtherToolCall transforms Swarm tools into validated semantic cards", () => {
  const post = callTransform("Run post_message", {
    text: "@m1a-qca-ps 请立即修复 2 处错误\n详见 #32",
  });
  assert.ok(post && post.items.length === 1);
  const parsedPost = AgyToolCardSchema.parse(post.items[0].data);
  assert.equal(parsedPost.category, "swarm_post");
  assert.equal(parsedPost.badge, "Swarm 发帖");
  assert.deepEqual(parsedPost.mentions, ["m1a-qca-ps"]);

  const add = callTransform("Run swarm", {
    action: "add",
    name: "auditor-w2",
    workspace: "inherit",
    model: "gemini-4-neon-high",
    brief: "Audit all diffs",
  });
  const parsedAdd = AgyToolCardSchema.parse(add?.items[0].data);
  assert.equal(parsedAdd.badge, "Swarm 派人");
  assert.equal(parsedAdd.headline, "添加 auditor-w2");

  const readBoard = callTransform("Run read_board", { since: 29 });
  const parsedRead = AgyToolCardSchema.parse(readBoard?.items[0].data);
  assert.equal(parsedRead.category, "swarm_read");
  assert.equal(parsedRead.boardSince, 29);

  const wait = callTransform("Run swarm_wait", { since: 32 }, "running");
  const parsedWait = AgyToolCardSchema.parse(wait?.items[0].data);
  assert.equal(parsedWait.category, "swarm_wait");
  assert.equal(parsedWait.badge, "Swarm 等待中");
});

test("transformAgyOtherToolCall transforms Teamwork, Workflow, Plan, and generic Other tools", () => {
  const tw = callTransform("Run invoke_subagent", {
    TypeName: "teamwork_challenger",
    Role: "M1 Adversarial Challenger",
    Workspace: "share",
    Prompt: "Break the invariant",
  });
  const parsedTw = AgyToolCardSchema.parse(tw?.items[0].data);
  assert.equal(parsedTw.badge, "Teamwork 派发");
  assert.equal(parsedTw.headline, "M1 Adversarial Challenger");

  const steps = callTransform("Run update_steps", {
    steps: [
      { title: "Step 1", status: "done" },
      { title: "Step 2", status: "in_progress" },
    ],
  });
  const parsedSteps = AgyToolCardSchema.parse(steps?.items[0].data);
  assert.equal(parsedSteps.category, "steps");
  assert.equal(parsedSteps.badge, "进度 1/2");
  assert.equal(parsedSteps.steps?.length, 2);

  const wf = callTransform("Run run_workflow", {
    Description: "Fan-out 10 audit agents",
    Cwd: "/tmp/repo",
  });
  const parsedWf = AgyToolCardSchema.parse(wf?.items[0].data);
  assert.equal(parsedWf.category, "workflow");
  assert.equal(parsedWf.badge, "Workflow");

  const generic = callTransform("Run custom_tool", { query: "hello" });
  const parsedGen = AgyToolCardSchema.parse(generic?.items[0].data);
  assert.equal(parsedGen.badge, "custom_tool");
  assert.equal(parsedGen.headline, "hello");
});

test("transformAgyOtherToolCall ignores non-other tool calls and supports metadata.kind=other forward-compat", () => {
  const res = transformAgyOtherToolCall({
    item: {
      type: "tool_call",
      callId: "call_2",
      name: "execute",
      status: "completed",
      error: null,
      detail: { type: "shell", command: "ls" },
      metadata: { kind: "execute", title: "Run command" },
    },
    phase: "complete",
  });
  assert.equal(res, undefined);

  const forward = transformAgyOtherToolCall({
    item: {
      type: "tool_call",
      callId: "call_3",
      name: "Run post_message",
      status: "completed",
      error: null,
      detail: { type: "unknown", input: { text: "@verifier check" }, output: null },
      metadata: { kind: "other", title: "Run post_message" },
    },
    phase: "complete",
  });
  assert.ok(forward && forward.items.length === 1);
  const parsed = AgyToolCardSchema.parse(forward.items[0].data);
  assert.equal(parsed.category, "swarm_post");
});
