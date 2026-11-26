/**
 * Antigravity CLI (`agy`) lifecycle hook installer for Paseo.
 *
 * `agy acp` returns `{ stopReason: "end_turn" }` at the end of the first foreground
 * planner invocation even when background `run_command` tasks or `invoke_subagent`
 * runs are still executing (`Stop` hook fires with `fullyIdle: false`). When a
 * background task finishes later, `agy` automatically wakes up in the same process
 * (`PreInvocation` -> `Stop` -> `PostInvocation`), appending rows to `transcript.jsonl`
 * without emitting ACP `session/update` notifications.
 *
 * This module installs a lightweight hook script (`~/.paseo/agent-hooks/antigravity-hook.mjs`)
 * and registers the sibling `"paseo-status"` bundle in `~/.gemini/config/hooks.json`
 * (never touching `"orca-status"` or `"thread-scope"`). On `PreInvocation`,
 * `PostInvocation`, and `Stop`, the hook script outputs the protojson expected by `agy`
 * (`{"decision":""}` on `Stop`, `{}` on `PreInvocation`/`PostInvocation`) and atomically
 * writes `<dirname(transcriptPath)>/hook-state.json`:
 *
 *   {
 *     "conversationId": "<uuid>",
 *     "event": "Stop",
 *     "fullyIdle": false,
 *     "ts": 1794540000000
 *   }
 *
 * Paseo's `ACPAgentSession` reads `hook-state.json` alongside `transcript.jsonl` so the
 * turn stays open while `fullyIdle === false` or during mid-step wakeups, and settles
 * immediately once `Stop` reports `fullyIdle: true`.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const PASEO_BUNDLE_KEY = "paseo-status";
export const HOOK_TIMEOUT_SECONDS = 10;

export interface AntigravityHookInstallOptions {
  homeDir?: string;
  paseoHomeDir?: string;
  nodeBinPath?: string;
}

export interface AntigravityHookInstallResult {
  scriptPath: string;
  hooksJsonPath: string;
  scriptUpdated: boolean;
  configUpdated: boolean;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function resolveHookPaths(options: AntigravityHookInstallOptions = {}): {
  homeDir: string;
  paseoHomeDir: string;
  scriptPath: string;
  hooksJsonPath: string;
  nodeBinPath: string;
} {
  const homeDir = options.homeDir ?? homedir();
  const envPaseoHome = process.env.PASEO_HOME?.trim();
  const paseoHomeDir =
    options.paseoHomeDir ??
    (envPaseoHome && envPaseoHome.length > 0 ? envPaseoHome : path.join(homeDir, ".paseo"));
  const scriptPath = path.join(paseoHomeDir, "agent-hooks", "antigravity-hook.mjs");
  const hooksJsonPath = path.join(homeDir, ".gemini", "config", "hooks.json");
  const nodeBinPath = options.nodeBinPath ?? path.join(homeDir, ".local", "bin", "node");
  return { homeDir, paseoHomeDir, scriptPath, hooksJsonPath, nodeBinPath };
}

export function buildAntigravityHookScript(): string {
  return `#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const fallbackEvent = process.argv[2] || process.env.PASEO_ANTIGRAVITY_EVENT || "";
const INBOX_FILENAME = "paseo-inbox.jsonl";

function drainInboxMessages(logsDir) {
  const inboxPath = path.join(logsDir, INBOX_FILENAME);
  const claimPath = \`\${inboxPath}.\${process.pid}.\${Date.now()}.claiming\`;
  try {
    renameSync(inboxPath, claimPath);
  } catch {
    return [];
  }
  try {
    const rawText = readFileSync(claimPath, "utf8");
    const messages = [];
    for (const line of rawText.split("\\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.body === "string" && parsed.body.trim()) {
          messages.push(parsed.body.trim());
        }
      } catch {
        // Ignore malformed JSONL inbox line.
      }
    }
    return messages;
  } catch {
    return [];
  } finally {
    try {
      rmSync(claimPath, { force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (raw.length < 262144) {
    raw += chunk;
  }
});
process.stdin.on("end", () => {
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  const event =
    typeof payload.hookEventName === "string" && payload.hookEventName.length > 0
      ? payload.hookEventName
      : fallbackEvent;

  const conversationId =
    typeof payload.conversationId === "string" && payload.conversationId.length > 0
      ? payload.conversationId
      : null;
  const transcriptPath =
    typeof payload.transcriptPath === "string" && payload.transcriptPath.length > 0
      ? payload.transcriptPath
      : null;
  const logsDir = transcriptPath
    ? path.dirname(transcriptPath)
    : conversationId
      ? path.join(
          homedir(),
          ".gemini",
          "antigravity-cli",
          "brain",
          conversationId,
          ".system_generated",
          "logs",
        )
      : null;

  let drained = [];
  const isUserCanceled = payload.terminationReason === "USER_CANCELED";
  if (
    logsDir &&
    (event === "PreInvocation" ||
      event === "PostInvocation" ||
      (event === "Stop" && !isUserCanceled))
  ) {
    try {
      drained = drainInboxMessages(logsDir);
    } catch {
      drained = [];
    }
  }

  let responseObj;
  if (event === "Stop") {
    responseObj =
      drained.length > 0
        ? { decision: "continue", reason: drained.join("\\n\\n") }
        : { decision: "" };
  } else if (event === "PreInvocation" && drained.length > 0) {
    responseObj = {
      injectSteps: drained.map((body) => ({ userMessage: body })),
    };
  } else if (event === "PostInvocation" && drained.length > 0) {
    responseObj = {
      injectSteps: drained.map((body) => ({ userMessage: body })),
      terminationBehavior: "force_continue",
    };
  } else {
    responseObj = {};
  }
  process.stdout.write(\`\${JSON.stringify(responseObj)}\\n\`);

  try {
    if (!logsDir || (event !== "PreInvocation" && event !== "PostInvocation" && event !== "Stop")) {
      return;
    }
    mkdirSync(logsDir, { recursive: true });
    const now = Date.now();
    const envPid = Number(process.env.PASEO_HOOK_AGENT_PID || "");
    // On Windows the parent is the short-lived cmd.exe, not agy, so record no PID there.
    const pid = Number.isInteger(envPid) && envPid > 1 ? envPid : (process.platform !== "win32" && typeof process.ppid === "number" && process.ppid > 1 ? process.ppid : null);
    const writeJsonAtomic = (filename, data, mode) => {
      const target = path.join(logsDir, filename);
      const tmp = \`\${target}.\${process.pid}.tmp\`;
      writeFileSync(tmp, \`\${JSON.stringify(data)}\\n\`, "utf8");
      if (mode !== undefined) {
        chmodSync(tmp, mode);
      }
      try {
        renameSync(tmp, target);
      } catch (err) {
        rmSync(tmp, { force: true });
        throw err;
      }
    };
    if (event === "PostInvocation") {
      return;
    }
    if (pid !== null) {
      writeJsonAtomic("process.json", {
        conversationId,
        pid,
        event,
        ts: now,
      });
    }
    if (event !== "Stop") {
      return;
    }
    const state = {
      conversationId,
      event: "Stop",
      fullyIdle: drained.length > 0 ? false : (payload.fullyIdle === false ? false : true),
      ...(pid !== null ? { pid } : {}),
      ts: now,
    };
    writeJsonAtomic("hook-state.json", state);
  } catch {
    // Never fail an Antigravity lifecycle hook on state write errors.
  }
});
process.stdin.resume();
`;
}

export function buildHookCommand(
  scriptPath: string,
  event: "PreInvocation" | "PostInvocation" | "Stop",
  nodeBinPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    // agy runs hook commands with `cmd /c` on Windows, so /bin/sh is not available.
    const quote = (value: string) => (/[\s&|<>^()]/.test(value) ? `"${value}"` : value);
    return `node ${quote(scriptPath)} ${event}`;
  }
  const quotedScript = shellSingleQuote(scriptPath);
  const quotedNode = shellSingleQuote(nodeBinPath);
  const quotedEvent = shellSingleQuote(event);
  const fallbackJson = event === "Stop" ? '{"decision":""}' : "{}";
  const quotedFallback = shellSingleQuote(fallbackJson);
  const inner = `PASEO_HOOK_AGENT_PID="\${PPID:-}"; export PASEO_HOOK_AGENT_PID; if [ -f ${quotedScript} ] && [ -r ${quotedScript} ]; then if [ -x ${quotedNode} ]; then exec ${quotedNode} ${quotedScript} ${quotedEvent}; else exec node ${quotedScript} ${quotedEvent}; fi; else printf '%s\\n' ${quotedFallback}; { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi`;
  return `/bin/sh -c ${shellSingleQuote(inner)}`;
}

export function buildPaseoStatusBundle(scriptPath: string, nodeBinPath: string): Record<string, unknown> {
  return {
    PreInvocation: [
      {
        type: "command",
        command: buildHookCommand(scriptPath, "PreInvocation", nodeBinPath),
        timeout: HOOK_TIMEOUT_SECONDS,
      },
    ],
    PostInvocation: [
      {
        type: "command",
        command: buildHookCommand(scriptPath, "PostInvocation", nodeBinPath),
        timeout: HOOK_TIMEOUT_SECONDS,
      },
    ],
    Stop: [
      {
        type: "command",
        command: buildHookCommand(scriptPath, "Stop", nodeBinPath),
        timeout: HOOK_TIMEOUT_SECONDS,
      },
    ],
  };
}

function writeAtomic(filePath: string, content: string, mode?: number): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, content, "utf8");
  if (mode !== undefined) {
    chmodSync(tmpPath, mode);
  }
  try {
    renameSync(tmpPath, filePath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

export function ensureAntigravityHooksInstalled(
  options: AntigravityHookInstallOptions = {},
): AntigravityHookInstallResult {
  const { scriptPath, hooksJsonPath, nodeBinPath } = resolveHookPaths(options);
  const desiredScript = buildAntigravityHookScript();
  let existingScript: string | null = null;
  try {
    existingScript = readFileSync(scriptPath, "utf8");
  } catch {
    existingScript = null;
  }
  let scriptUpdated = false;
  if (existingScript !== desiredScript) {
    writeAtomic(scriptPath, desiredScript, 0o755);
    scriptUpdated = true;
  }

  let existingText: string | null = null;
  let parsed: Record<string, unknown> = {};
  try {
    existingText = readFileSync(hooksJsonPath, "utf8");
    const candidate = JSON.parse(existingText) as unknown;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      parsed = { ...(candidate as Record<string, unknown>) };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT") {
      // Do not clobber a malformed user hooks.json file.
      throw error;
    }
  }

  const desiredBundle = buildPaseoStatusBundle(scriptPath, nodeBinPath);
  const nextConfig: Record<string, unknown> = {
    ...parsed,
    [PASEO_BUNDLE_KEY]: desiredBundle,
  };
  const rendered = `${JSON.stringify(nextConfig, null, 2)}\n`;
  let configUpdated = false;
  if (existingText !== rendered) {
    writeAtomic(hooksJsonPath, rendered);
    configUpdated = true;
  }

  return {
    scriptPath,
    hooksJsonPath,
    scriptUpdated,
    configUpdated,
  };
}
