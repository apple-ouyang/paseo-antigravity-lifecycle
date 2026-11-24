import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  AgyConsoleDetail,
  ChildStepDetail,
  ChildStepToolDetail,
  ChildTranscriptResponse,
  SwarmBoardPost,
  SwarmPlan,
  TranscriptStep,
} from "../shared/rpc.ts";
import {
  cleanArg,
  inspectAgySession,
  readJsonSafe,
  readTranscriptRows,
  summarizeToolCall,
  type InspectAgySessionInput,
} from "./status.ts";

interface RawPlanFile {
  goal?: {
    title?: unknown;
    line?: unknown;
  };
  tasks?: Record<string, unknown>;
  threads?: Array<{
    id?: unknown;
    title?: unknown;
    goal?: unknown;
    tasks?: unknown;
  }>;
}

interface RawBoardRow {
  seq?: unknown;
  agent?: unknown;
  text?: unknown;
  time?: unknown;
}

function extractMentions(text: string): string[] {
  const seen = new Set<string>();
  const re = /(?:^|[\s(（【\[])@([a-z0-9][a-z0-9_-]{0,23})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    seen.add(m[1].toLowerCase());
  }
  return [...seen];
}

function extractScreenshots(text: string): Array<{ path: string; caption: string }> {
  const result: Array<{ path: string; caption: string }> = [];
  for (const line of text.split("\n")) {
    const m = /^\s*Screenshot:\s*([^|\n]+?)(?:\s*\|\s*(.*))?$/i.exec(line);
    if (!m) continue;
    const filePath = m[1].trim();
    if (!filePath) continue;
    result.push({
      path: filePath,
      caption: (m[2] ?? "").trim(),
    });
  }
  return result;
}

export function readSwarmPlan(brainRoot: string, sessionId: string): SwarmPlan | null {
  const planPath = path.join(brainRoot, sessionId, ".system_generated", "swarm", "plan.json");
  const raw = readJsonSafe<RawPlanFile>(planPath);
  if (!raw || typeof raw !== "object") return null;

  const goal =
    raw.goal && (typeof raw.goal.title === "string" || typeof raw.goal.line === "string")
      ? {
          title: typeof raw.goal.title === "string" ? raw.goal.title : "",
          line: typeof raw.goal.line === "string" ? raw.goal.line : "",
        }
      : null;

  const tasks: Record<string, string> = {};
  if (raw.tasks && typeof raw.tasks === "object") {
    for (const [k, v] of Object.entries(raw.tasks)) {
      if (typeof v === "string") tasks[k] = v;
    }
  }

  const threads: SwarmPlan["threads"] = [];
  if (Array.isArray(raw.threads)) {
    for (const t of raw.threads) {
      if (!t || typeof t !== "object") continue;
      const id = typeof t.id === "string" ? t.id : `thread-${threads.length + 1}`;
      const title = typeof t.title === "string" ? t.title : id;
      const tGoal = typeof t.goal === "string" ? t.goal : "";
      const tTasks = Array.isArray(t.tasks)
        ? t.tasks.filter((x): x is string => typeof x === "string")
        : [];
      threads.push({ id, title, goal: tGoal, tasks: tTasks });
    }
  }

  return { goal, tasks, threads };
}

export function readSwarmBoard(
  brainRoot: string,
  sessionId: string,
  options?: { since?: number; limit?: number },
): { posts: SwarmBoardPost[]; total: number; latestSeq: number } {
  const boardPath = path.join(brainRoot, sessionId, ".system_generated", "swarm", "board.jsonl");
  let raw = "";
  try {
    raw = readFileSync(boardPath, "utf8");
  } catch {
    return { posts: [], total: 0, latestSeq: 0 };
  }
  const all: SwarmBoardPost[] = [];
  let latestSeq = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as RawBoardRow;
      if (!obj || typeof obj !== "object") continue;
      const seq = typeof obj.seq === "number" ? obj.seq : all.length + 1;
      const agent = typeof obj.agent === "string" ? obj.agent : "unknown";
      const text = typeof obj.text === "string" ? obj.text : "";
      const time = typeof obj.time === "string" ? obj.time : null;
      if (seq > latestSeq) latestSeq = seq;
      all.push({
        seq,
        agent,
        text,
        time,
        mentions: extractMentions(text),
        screenshots: extractScreenshots(text),
      });
    } catch {
      // Ignore partial line during concurrent append.
    }
  }

  const since = options?.since;
  const filtered = since !== undefined ? all.filter((p) => p.seq > since) : all;
  const limit = options?.limit ?? 200;
  const posts =
    since !== undefined
      ? filtered.slice(0, limit)
      : filtered.length > limit
        ? filtered.slice(filtered.length - limit)
        : filtered;

  return { posts, total: all.length, latestSeq };
}

function clipText(text: string, maxLen = 420): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen - 1)}…`;
}

interface RawTranscriptRow {
  step_index?: number;
  type?: string;
  status?: string;
  created_at?: string;
  model?: string;
  content?: string;
  thinking?: string;
  tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>;
}

interface CachedTranscript {
  ino: number;
  size: number;
  mtimeMs: number;
  byteOffset: number;
  remainder: Buffer;
  model: string | null;
  steps: TranscriptStep[];
  lastAccessedAt: number;
}

const MAX_TRANSCRIPT_CACHE = 200;
const transcriptCache = new Map<string, CachedTranscript>();

export function clearTranscriptCache(): void {
  transcriptCache.clear();
}

function evictTranscriptCacheIfNeeded(): void {
  if (transcriptCache.size <= MAX_TRANSCRIPT_CACHE) return;
  let oldestKey: string | null = null;
  let oldestTs = Infinity;
  for (const [k, entry] of transcriptCache) {
    if (entry.lastAccessedAt < oldestTs) {
      oldestTs = entry.lastAccessedAt;
      oldestKey = k;
    }
  }
  if (oldestKey) transcriptCache.delete(oldestKey);
}

const SYSTEM_BOILERPLATE_RE =
  /^The following is a(?:n)?\s+(?:not actually sent by the user\.?\s*)?(?:<SYSTEM_MESSAGE>\s*)?(?:not actually sent by the user\.?\s*)?(?:It is provided by the system as important information to pay attention to\.?\s*)/i;

function stripSystemBoilerplate(raw: string): string {
  const flat = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const stripped = flat.replace(SYSTEM_BOILERPLATE_RE, "").trim();
  const contentMatch = /\bcontent=(.+)$/.exec(stripped);
  return contentMatch?.[1]?.trim() || stripped;
}

function summarizeToolCallForStep(tc: {
  name?: string;
  args?: Record<string, unknown>;
}): string {
  if (tc.name === "post_message") {
    const txt = cleanArg(tc.args?.text);
    if (txt) {
      const single = String(txt).replace(/\s+/g, " ").trim();
      return `发帖: ${clipText(single, 160)}`;
    }
  }
  return summarizeToolCall(tc);
}

function parseTranscriptRowIntoSteps(
  r: RawTranscriptRow,
  steps: TranscriptStep[],
  currentModel: string | null,
): string | null {
  let latestModel = currentModel;
  const stepIndex = typeof r.step_index === "number" ? r.step_index : steps.length;
  const model = typeof r.model === "string" && r.model.length > 0 ? r.model : null;
  if (model) latestModel = model;
  const status = typeof r.status === "string" ? r.status : null;
  const createdAt = typeof r.created_at === "string" ? r.created_at : null;

  if (r.type === "USER_INPUT") {
    steps.push({
      stepIndex,
      kind: "user",
      title: "任务输入",
      summary: clipText(r.content ?? "", 600),
      status,
      createdAt,
      model,
      hasDetail: (r.content?.length ?? 0) > 200,
    });
  } else if (r.type === "ERROR_MESSAGE") {
    steps.push({
      stepIndex,
      kind: "error",
      title: "错误",
      summary: clipText(r.content ?? "执行报错", 800),
      status,
      createdAt,
      model,
      hasDetail: true,
    });
  } else if (r.type === "SYSTEM_MESSAGE") {
    const content = r.content ?? "";
    if (content.includes("[board]") || content.includes("[Message]") || content.includes("[swarm]")) {
      const clean = stripSystemBoilerplate(content);
      steps.push({
        stepIndex,
        kind: "system",
        title: content.includes("[board]") ? "消息板通知" : "系统唤醒",
        summary: clipText(clean, 320),
        status,
        createdAt,
        model,
        hasDetail: content.length > 260,
      });
    }
  } else if (r.type === "PLANNER_RESPONSE") {
    const hasThinking = Boolean(r.thinking && r.thinking.trim().length > 0);
    if (r.tool_calls && r.tool_calls.length > 0) {
      const summaries = r.tool_calls.map((tc) => summarizeToolCallForStep(tc));
      steps.push({
        stepIndex,
        kind: "tool",
        title: summaries.length === 1 ? clipText(summaries[0], 72) : `${summaries.length} 个工具调用`,
        summary: summaries.join(" · "),
        status,
        createdAt,
        model,
        hasDetail: true,
      });
    }
    if (r.content && r.content.trim().length > 0) {
      steps.push({
        stepIndex,
        kind: "assistant",
        title: "回复输出",
        summary: clipText(r.content, 1200),
        status,
        createdAt,
        model,
        hasDetail: r.content.length > 400 || hasThinking,
      });
    } else if (hasThinking && !(r.tool_calls && r.tool_calls.length > 0)) {
      steps.push({
        stepIndex,
        kind: "thinking",
        title: "思考中",
        summary: clipText(r.thinking ?? "", 400),
        status,
        createdAt,
        model,
        hasDetail: true,
      });
    }
  }

  return latestModel;
}

function appendChunkToCache(entry: CachedTranscript, chunk: Buffer): void {
  const combined = entry.remainder.length > 0 ? Buffer.concat([entry.remainder, chunk]) : chunk;
  const lastNewline = combined.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    entry.remainder = combined;
    return;
  }
  const completeText = combined.subarray(0, lastNewline).toString("utf8");
  entry.remainder = combined.subarray(lastNewline + 1);

  for (const line of completeText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as RawTranscriptRow;
      if (parsed && typeof parsed === "object") {
        entry.model = parseTranscriptRowIntoSteps(parsed, entry.steps, entry.model);
      }
    } catch {
      // Ignore malformed JSONL line during concurrent write.
    }
  }
}

function readBytesRange(filePath: string, offset: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    let totalRead = 0;
    while (totalRead < length) {
      const n = readSync(fd, buf, totalRead, length - totalRead, offset + totalRead);
      if (n <= 0) break;
      totalRead += n;
    }
    return totalRead === length ? buf : buf.subarray(0, totalRead);
  } finally {
    closeSync(fd);
  }
}

function loadCachedTranscript(txPath: string): CachedTranscript | null {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(txPath);
  } catch {
    transcriptCache.delete(txPath);
    return null;
  }

  const now = Date.now();
  const cached = transcriptCache.get(txPath);
  if (cached && cached.ino === st.ino && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
    cached.lastAccessedAt = now;
    return cached;
  }

  if (cached && cached.ino === st.ino && st.size >= cached.byteOffset) {
    const deltaLen = st.size - cached.byteOffset;
    if (deltaLen > 0) {
      try {
        const chunk = readBytesRange(txPath, cached.byteOffset, deltaLen);
        appendChunkToCache(cached, chunk);
        cached.byteOffset += chunk.length;
      } catch {
        // Fall through to keep previous cache snapshot on transient read failure.
      }
    }
    cached.size = st.size;
    cached.mtimeMs = st.mtimeMs;
    cached.lastAccessedAt = now;
    return cached;
  }

  // Fresh load or file rotated/truncated -> full parse from byte 0
  let fullBuf: Buffer;
  try {
    fullBuf = readFileSync(txPath);
  } catch {
    return null;
  }

  const entry: CachedTranscript = {
    ino: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
    byteOffset: fullBuf.length,
    remainder: Buffer.alloc(0),
    model: null,
    steps: [],
    lastAccessedAt: now,
  };
  appendChunkToCache(entry, fullBuf);
  // If file doesn't end with '\n' yet, try parsing trailing line without consuming remainder
  // so complete single-line files still parse, while truncated JSON waits for next append.
  if (entry.remainder.length > 0) {
    const trailing = entry.remainder.toString("utf8").trim();
    if (trailing.startsWith("{") && trailing.endsWith("}")) {
      try {
        const parsed = JSON.parse(trailing) as RawTranscriptRow;
        if (parsed && typeof parsed === "object") {
          entry.model = parseTranscriptRowIntoSteps(parsed, entry.steps, entry.model);
          entry.remainder = Buffer.alloc(0);
        }
      } catch {
        // Incomplete JSON fragment; keep in remainder until trailing newline arrives.
      }
    }
  }

  transcriptCache.set(txPath, entry);
  evictTranscriptCacheIfNeeded();
  return entry;
}

export function readChildTranscript(
  brainRoot: string,
  allowedIds: Set<string>,
  conversationId: string,
  limit = 60,
  afterCursor?: number,
): ChildTranscriptResponse | null {
  if (
    !conversationId ||
    conversationId.includes("/") ||
    conversationId.includes("..") ||
    !allowedIds.has(conversationId)
  ) {
    return null;
  }

  const txPath = path.join(brainRoot, conversationId, ".system_generated", "logs", "transcript.jsonl");
  const entry = loadCachedTranscript(txPath);
  if (!entry) {
    return {
      conversationId,
      model: null,
      steps: [],
      totalSteps: 0,
      cursor: 0,
      mode: afterCursor !== undefined && afterCursor === 0 ? "delta" : "full",
      unchanged: afterCursor === 0,
    };
  }

  const totalSteps = entry.steps.length;
  if (afterCursor !== undefined && afterCursor >= 0 && afterCursor <= totalSteps) {
    if (afterCursor === totalSteps) {
      return {
        conversationId,
        model: entry.model,
        steps: [],
        totalSteps,
        cursor: totalSteps,
        mode: "delta",
        unchanged: true,
      };
    }
    const delta = entry.steps.slice(afterCursor);
    const boundedDelta = delta.length > limit ? delta.slice(delta.length - limit) : delta;
    return {
      conversationId,
      model: entry.model,
      steps: boundedDelta,
      totalSteps,
      cursor: totalSteps,
      mode: "delta",
      unchanged: false,
    };
  }

  const tail = totalSteps > limit ? entry.steps.slice(totalSteps - limit) : entry.steps;
  return {
    conversationId,
    model: entry.model,
    steps: tail,
    totalSteps,
    cursor: totalSteps,
    mode: "full",
    unchanged: false,
  };
}

const MAX_DETAIL_FIELD_CHARS = 24_000;
const MAX_TOOL_OUTPUT_CHARS = 16_000;

function capDetailText(raw: string | null | undefined, maxChars: number): { text: string | null; truncated: boolean } {
  if (!raw) return { text: null, truncated: false };
  const trimmed = raw.trim();
  if (!trimmed) return { text: null, truncated: false };
  if (trimmed.length <= maxChars) return { text: trimmed, truncated: false };
  return { text: `${trimmed.slice(0, maxChars)}\n…(已截断，原文共 ${trimmed.length} 字)`, truncated: true };
}

function cleanGenericToolOutput(raw: string | undefined): string | null {
  if (!raw) return null;
  const lines = raw.split("\n");
  let start = 0;
  while (start < lines.length && /^(?:Created At|Completed At):\s/i.test(lines[start].trim())) {
    start += 1;
  }
  const rest = lines.slice(start).join("\n").trim();
  return rest || raw.trim() || null;
}

function extractToolPrimaryAndArgs(tc: {
  name?: string;
  args?: Record<string, unknown>;
}): { primaryText: string | null; argsText: string | null; truncated: boolean } {
  const name = tc.name ?? "tool";
  const rawArgs = tc.args ?? {};
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawArgs)) {
    cleaned[k] = cleanArg(v);
  }

  let primaryRaw: string | null = null;
  const omittedKeys = new Set<string>();

  if (name === "post_message" && typeof cleaned.text === "string") {
    primaryRaw = cleaned.text;
    omittedKeys.add("text");
  } else if (name === "run_command" && typeof cleaned.CommandLine === "string") {
    primaryRaw = cleaned.CommandLine;
    omittedKeys.add("CommandLine");
  } else if (name === "send_message" && typeof cleaned.Message === "string") {
    primaryRaw = cleaned.Message;
    omittedKeys.add("Message");
  } else if (name === "swarm" && typeof cleaned.brief === "string") {
    primaryRaw = cleaned.brief;
    omittedKeys.add("brief");
  } else if (name === "invoke_subagent" && typeof cleaned.Prompt === "string") {
    primaryRaw = cleaned.Prompt;
    omittedKeys.add("Prompt");
  } else if (name === "read_file" && typeof cleaned.Path === "string") {
    const range =
      cleaned.StartLine !== undefined || cleaned.EndLine !== undefined
        ? ` (L${cleaned.StartLine ?? 1}–L${cleaned.EndLine ?? "end"})`
        : "";
    primaryRaw = `${cleaned.Path}${range}`;
    omittedKeys.add("Path");
    omittedKeys.add("StartLine");
    omittedKeys.add("EndLine");
  } else if ((name === "edit_file" || name === "write_file") && typeof cleaned.Path === "string") {
    primaryRaw = String(cleaned.Path);
    omittedKeys.add("Path");
  }

  const remaining: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cleaned)) {
    if (omittedKeys.has(k) || v === undefined || v === null) continue;
    remaining[k] = v;
  }

  const cappedPrimary = capDetailText(primaryRaw, MAX_DETAIL_FIELD_CHARS);
  let argsRaw: string | null = null;
  if (Object.keys(remaining).length > 0) {
    try {
      argsRaw = JSON.stringify(remaining, null, 2);
    } catch {
      argsRaw = null;
    }
  }
  const cappedArgs = capDetailText(argsRaw, 6_000);
  return {
    primaryText: cappedPrimary.text,
    argsText: cappedArgs.text,
    truncated: cappedPrimary.truncated || cappedArgs.truncated,
  };
}

export function readChildStepDetail(
  brainRoot: string,
  allowedIds: Set<string>,
  conversationId: string,
  stepIndex: number,
): ChildStepDetail | null {
  if (
    !conversationId ||
    conversationId.includes("/") ||
    conversationId.includes("..") ||
    !allowedIds.has(conversationId) ||
    !Number.isInteger(stepIndex) ||
    stepIndex < 0
  ) {
    return null;
  }

  const logsDir = path.join(brainRoot, conversationId, ".system_generated", "logs");
  const fullPath = path.join(logsDir, "transcript_full.jsonl");
  const compactPath = path.join(logsDir, "transcript.jsonl");
  const targetPath = existsSync(fullPath) ? fullPath : compactPath;
  const rows = readTranscriptRows(targetPath);
  if (rows.length === 0) return null;

  let rowIdx = rows.findIndex((r) => r.step_index === stepIndex);
  if (rowIdx < 0 && stepIndex < rows.length) {
    rowIdx = stepIndex;
  }
  if (rowIdx < 0) return null;

  const row = rows[rowIdx];
  let truncated = false;

  const rawContent =
    row.type === "SYSTEM_MESSAGE" && row.content
      ? stripSystemBoilerplate(row.content)
      : row.content;
  const cappedContent = capDetailText(rawContent, MAX_DETAIL_FIELD_CHARS);
  const cappedThinking = capDetailText(row.thinking, MAX_DETAIL_FIELD_CHARS);
  truncated = truncated || cappedContent.truncated || cappedThinking.truncated;

  const toolCalls: ChildStepToolDetail[] = [];
  if (row.type === "PLANNER_RESPONSE" && Array.isArray(row.tool_calls) && row.tool_calls.length > 0) {
    // AGY logs GENERIC tool results immediately after PLANNER_RESPONSE in exact call order.
    const followingGenerics: typeof rows = [];
    for (let j = rowIdx + 1; j < rows.length && followingGenerics.length < row.tool_calls.length; j += 1) {
      if (rows[j].type === "GENERIC") {
        followingGenerics.push(rows[j]);
      } else {
        break;
      }
    }

    for (let k = 0; k < row.tool_calls.length; k += 1) {
      const tc = row.tool_calls[k];
      const paired = followingGenerics[k];
      const { primaryText, argsText, truncated: tTrunc } = extractToolPrimaryAndArgs(tc);
      const outClean = cleanGenericToolOutput(paired?.content);
      const cappedOut = capDetailText(outClean, MAX_TOOL_OUTPUT_CHARS);
      truncated = truncated || tTrunc || cappedOut.truncated;
      toolCalls.push({
        name: tc.name ?? "tool",
        summary: summarizeToolCall(tc),
        primaryText,
        argsText,
        output: cappedOut.text,
        outputStatus: typeof paired?.status === "string" ? paired.status : null,
      });
    }
  }

  return {
    conversationId,
    stepIndex: typeof row.step_index === "number" ? row.step_index : stepIndex,
    type: String(row.type ?? "UNKNOWN"),
    status: typeof row.status === "string" ? row.status : null,
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
    model: typeof row.model === "string" && row.model.length > 0 ? row.model : null,
    content: cappedContent.text,
    thinking: cappedThinking.text,
    toolCalls,
    truncated,
  };
}

export function inspectAgyConsole(
  input: InspectAgySessionInput & { boardLimit?: number },
): AgyConsoleDetail | null {
  const status = inspectAgySession(input);
  if (!status || !status.sessionId) return null;
  const homeDir = input.homeDir ?? homedir();
  const brainRoot = path.join(homeDir, ".gemini", "antigravity-cli", "brain");
  const swarmPlan = readSwarmPlan(brainRoot, status.sessionId);
  const board = readSwarmBoard(brainRoot, status.sessionId, { limit: input.boardLimit ?? 200 });
  return {
    status,
    swarmPlan,
    boardPosts: board.posts,
    boardTotal: board.total,
  };
}

export function collectAllowedChildIds(status: NonNullable<ReturnType<typeof inspectAgySession>>): Set<string> {
  const allowed = new Set<string>();
  if (status.sessionId) allowed.add(status.sessionId);
  for (const m of status.swarm?.members ?? []) {
    if (m.conversationId) allowed.add(m.conversationId);
  }
  for (const n of status.teamwork?.nodes ?? []) {
    if (n.id) allowed.add(n.id);
  }
  for (const s of status.subagents) {
    if (s.id) allowed.add(s.id);
  }
  return allowed;
}
