import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

    const runEvent = (hookEventName: "PreInvocation" | "PostInvocation" | "Stop", fullyIdle?: boolean) => {
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
        }),
        encoding: "utf8",
      });
      assert.equal(proc.status, 0, proc.stderr);
      return proc.stdout;
    };

    assert.equal(runEvent("PreInvocation"), "{}\n");

    assert.equal(runEvent("Stop", false), '{"decision":""}\n');
    let state = JSON.parse(readFileSync(path.join(logsDir, "hook-state.json"), "utf8")) as Record<string, unknown>;
    assert.equal(state.event, "Stop");
    assert.equal(state.fullyIdle, false);

    // PostInvocation fires right after Stop in Antigravity and must not clobber Stop's fullyIdle state.
    assert.equal(runEvent("PostInvocation"), "{}\n");
    state = JSON.parse(readFileSync(path.join(logsDir, "hook-state.json"), "utf8")) as Record<string, unknown>;
    assert.equal(state.event, "Stop");
    assert.equal(state.fullyIdle, false);

    assert.equal(runEvent("Stop", true), '{"decision":""}\n');
    state = JSON.parse(readFileSync(path.join(logsDir, "hook-state.json"), "utf8")) as Record<string, unknown>;
    assert.equal(state.event, "Stop");
    assert.equal(state.fullyIdle, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
