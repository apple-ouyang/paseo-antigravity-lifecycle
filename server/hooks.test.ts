import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PASEO_BUNDLE_KEY, ensureAntigravityHooksInstalled } from "./hooks.ts";

test("ensureAntigravityHooksInstalled preserves sibling bundles and writes hook-state.json across lifecycle events", () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-agy-lifecycle-"));
  try {
    const homeDir = path.join(root, "home");
    const paseoHomeDir = path.join(root, "paseo");
    const hooksDir = path.join(homeDir, ".gemini", "config");
    mkdirSync(hooksDir, { recursive: true });
    const initialHooks = {
      "thread-scope": {
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "true", timeout: 10 }] }],
      },
      "orca-status": {
        Stop: [{ type: "command", command: "orca-hook", timeout: 10 }],
      },
    };
    writeFileSync(path.join(hooksDir, "hooks.json"), `${JSON.stringify(initialHooks, null, 2)}\n`, "utf8");

    const first = ensureAntigravityHooksInstalled({
      homeDir,
      paseoHomeDir,
      nodeBinPath: process.execPath,
    });
    assert.equal(first.scriptUpdated, true);
    assert.equal(first.configUpdated, true);

    const second = ensureAntigravityHooksInstalled({
      homeDir,
      paseoHomeDir,
      nodeBinPath: process.execPath,
    });
    assert.equal(second.scriptUpdated, false);
    assert.equal(second.configUpdated, false);

    const installedConfig = JSON.parse(readFileSync(first.hooksJsonPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(installedConfig["thread-scope"], initialHooks["thread-scope"]);
    assert.deepEqual(installedConfig["orca-status"], initialHooks["orca-status"]);
    assert.ok(installedConfig[PASEO_BUNDLE_KEY]);

    const logsDir = path.join(
      homeDir,
      ".gemini",
      "antigravity-cli",
      "brain",
      "sid-123",
      ".system_generated",
      "logs",
    );
    const transcriptPath = path.join(logsDir, "transcript.jsonl");

    const runEvent = (
      hookEventName: "PreInvocation" | "PostInvocation" | "Stop",
      fullyIdle?: boolean,
      extraPayload?: Record<string, unknown>,
    ) => {
      const bundle = installedConfig[PASEO_BUNDLE_KEY] as Record<
        string,
        Array<{ command: string }>
      >;
      const command = bundle[hookEventName]?.[0]?.command;
      assert.ok(command);
      const proc = spawnSync("/bin/sh", ["-c", command], {
        input: JSON.stringify({
          conversationId: "sid-123",
          transcriptPath,
          hookEventName,
          ...(fullyIdle !== undefined ? { fullyIdle } : {}),
          ...extraPayload,
        }),
        encoding: "utf8",
      });
      assert.equal(proc.status, 0, proc.stderr);
      return proc.stdout;
    };

    assert.equal(runEvent("PreInvocation"), "{}\n");
    assert.equal(existsSync(path.join(logsDir, "hook-state.json")), false);
    const procMeta = JSON.parse(readFileSync(path.join(logsDir, "process.json"), "utf8")) as Record<string, unknown>;
    assert.equal(procMeta.conversationId, "sid-123");
    assert.equal(procMeta.event, "PreInvocation");
    assert.equal(typeof procMeta.pid, "number");
    assert.ok((procMeta.pid as number) > 1);

    assert.equal(runEvent("Stop", false), '{"decision":""}\n');
    let state = JSON.parse(readFileSync(path.join(logsDir, "hook-state.json"), "utf8")) as Record<string, unknown>;
    assert.equal(state.event, "Stop");
    assert.equal(state.fullyIdle, false);
    assert.equal(typeof state.pid, "number");
    assert.ok((state.pid as number) > 1);

    // PostInvocation fires right after Stop in Antigravity and must not clobber Stop's fullyIdle state.
    assert.equal(runEvent("PostInvocation"), "{}\n");
    state = JSON.parse(readFileSync(path.join(logsDir, "hook-state.json"), "utf8")) as Record<string, unknown>;
    assert.equal(state.event, "Stop");
    assert.equal(state.fullyIdle, false);

    assert.equal(runEvent("Stop", true), '{"decision":""}\n');
    state = JSON.parse(readFileSync(path.join(logsDir, "hook-state.json"), "utf8")) as Record<string, unknown>;
    assert.equal(state.event, "Stop");
    assert.equal(state.fullyIdle, true);

    // Non-interrupting inbox drain on PreInvocation -> injects userMessage steps atomically & clears inbox
    const inboxPath = path.join(logsDir, "paseo-inbox.jsonl");
    writeFileSync(
      inboxPath,
      `${JSON.stringify({ id: "m1", body: "现在啥情况了？总结下" })}\n${JSON.stringify({ id: "m2", body: "顺便核对第3篇" })}\n`,
      "utf8",
    );
    const preInjected = JSON.parse(runEvent("PreInvocation")) as {
      injectSteps?: Array<{ userMessage?: string }>;
    };
    assert.deepEqual(preInjected.injectSteps, [
      { userMessage: "现在啥情况了？总结下" },
      { userMessage: "顺便核对第3篇" },
    ]);
    assert.equal(existsSync(inboxPath), false);
    // Second PreInvocation sees empty inbox
    assert.equal(runEvent("PreInvocation"), "{}\n");

    // Non-interrupting inbox drain on PostInvocation -> injects userMessage + force_continue
    writeFileSync(inboxPath, `${JSON.stringify({ id: "m3", body: "继续核查" })}\n`, "utf8");
    const postInjected = JSON.parse(runEvent("PostInvocation")) as {
      injectSteps?: Array<{ userMessage?: string }>;
      terminationBehavior?: string;
    };
    assert.deepEqual(postInjected.injectSteps, [{ userMessage: "继续核查" }]);
    assert.equal(postInjected.terminationBehavior, "force_continue");
    assert.equal(existsSync(inboxPath), false);

    // Non-interrupting inbox drain on Stop -> decision=continue & hook-state fullyIdle=false
    writeFileSync(inboxPath, `${JSON.stringify({ id: "m4", body: "结束前再总结" })}\n`, "utf8");
    const stopContinue = JSON.parse(runEvent("Stop", true, { terminationReason: "NO_TOOL_CALL" })) as {
      decision?: string;
      reason?: string;
    };
    assert.equal(stopContinue.decision, "continue");
    assert.equal(stopContinue.reason, "结束前再总结");
    assert.equal(existsSync(inboxPath), false);
    state = JSON.parse(readFileSync(path.join(logsDir, "hook-state.json"), "utf8")) as Record<string, unknown>;
    assert.equal(state.fullyIdle, false);

    // Explicit USER_CANCELED Stop must NOT force-continue or consume the inbox
    writeFileSync(inboxPath, `${JSON.stringify({ id: "m5", body: "保留" })}\n`, "utf8");
    assert.equal(
      runEvent("Stop", true, { terminationReason: "USER_CANCELED" }),
      '{"decision":""}\n',
    );
    assert.equal(existsSync(inboxPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
