import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import type { AgyQuestionItem, AgyToolCardData } from "../shared/timeline.ts";

type ToolCallTransformer = PluginTimelineTransformerContribution<"tool_call">["transform"];
type AssistantMessageTransformer =
  PluginTimelineTransformerContribution<"assistant_message">["transform"];

const seenQuestionSignatures = new Set<string>();

function normalizeQuestionLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function buildQuestionFallbackLines(questions: AgyQuestionItem[]): string[] {
  const lines: string[] = [];
  for (const q of questions) {
    lines.push(normalizeQuestionLine(q.question));
    q.options.forEach((opt, idx) => {
      lines.push(normalizeQuestionLine(`- [${idx + 1}] ${opt}`));
    });
  }
  return lines;
}

function recordSeenQuestionFallback(questions: AgyQuestionItem[]): void {
  if (questions.length === 0) return;
  const sig = buildQuestionFallbackLines(questions).join("\n");
  seenQuestionSignatures.add(sig);
  if (seenQuestionSignatures.size > 60) {
    const first = seenQuestionSignatures.values().next().value;
    if (first) seenQuestionSignatures.delete(first);
  }
}

export const transformAgyQuestionFallback: AssistantMessageTransformer = ({ item }) => {
  if (seenQuestionSignatures.size === 0) return;
  const lines = item.text
    .split("\n")
    .map(normalizeQuestionLine)
    .filter((l) => l.length > 0);
  if (lines.length < 2) return;
  const sig = lines.join("\n");
  if (seenQuestionSignatures.has(sig)) {
    return { items: [] };
  }
  return;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStr(rec: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (!rec) return null;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

function readNum(rec: Record<string, unknown> | null, keys: readonly string[]): number | null {
  if (!rec) return null;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  }
  return null;
}

function clipOneLine(text: string, max = 92): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

function extractMentions(text: string): string[] {
  const seen = new Set<string>();
  const re = /(?:^|[\s(（【\[])@([a-z0-9][a-z0-9_-]{0,23})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    seen.add(m[1].toLowerCase());
  }
  return [...seen].slice(0, 6);
}

function normalizeToolKey(rawTitle: string): string {
  return rawTitle.replace(/^Run\s+/i, "").trim();
}

function safeJsonPreview(value: unknown, max = 900): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  try {
    const s = JSON.stringify(value, null, 2);
    if (!s || s === "{}" || s === "[]") return null;
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  } catch {
    return null;
  }
}

function parseQuestionsField(raw: unknown): AgyQuestionItem[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const result: AgyQuestionItem[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const question = readStr(entry, ["question", "prompt", "title"]);
    if (!question) continue;
    const rawOpts = Array.isArray(entry.options) ? entry.options : [];
    const options: string[] = [];
    for (const opt of rawOpts) {
      if (typeof opt === "string" && opt.trim().length > 0) {
        options.push(opt.trim());
      } else if (isRecord(opt)) {
        const label = readStr(opt, ["label", "text", "title", "value"]);
        if (label) options.push(label);
      }
    }
    const isMultiSelect = Boolean(
      entry.is_multi_select ?? entry.isMultiSelect ?? entry.multiSelect ?? false,
    );
    result.push({ question, options, isMultiSelect });
  }
  return result;
}

function extractQuestionAnswer(rawOutput: unknown): string | null {
  if (rawOutput === null || rawOutput === undefined) return null;
  let text: string | null = null;
  if (typeof rawOutput === "string") {
    text = rawOutput;
  } else if (isRecord(rawOutput)) {
    text =
      readStr(rawOutput, ["text", "answer", "output", "content", "result"]) ??
      (isRecord(rawOutput.answers)
        ? Object.values(rawOutput.answers)
            .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
            .join("；")
        : null);
  } else if (Array.isArray(rawOutput)) {
    const parts: string[] = [];
    for (const entry of rawOutput) {
      if (typeof entry === "string" && entry.trim()) parts.push(entry.trim());
      else if (isRecord(entry)) {
        const t = readStr(entry, ["text", "content"]);
        if (t) parts.push(t);
      }
    }
    if (parts.length > 0) text = parts.join("\n");
  }
  if (!text) return null;
  const cleanedLines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^(?:Created At|Completed At):\s/i.test(l));
  const cleaned = cleanedLines.join("\n").trim();
  if (!cleaned) return null;
  return cleaned.length > 600 ? `${cleaned.slice(0, 599)}…` : cleaned;
}

function extractConversationIdFromOutput(rawOutput: unknown): string | null {
  if (!rawOutput) return null;
  if (isRecord(rawOutput)) {
    const direct = readStr(rawOutput, ["conversationId", "conversation_id", "id"]);
    if (direct && /^[a-f0-9-]{8,}$/i.test(direct)) return direct;
  }
  const text = typeof rawOutput === "string" ? rawOutput : safeJsonPreview(rawOutput, 600);
  if (!text) return null;
  const m =
    /conversation[_-]?id["'\s:=]+([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i.exec(
      text,
    ) ?? /\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/i.exec(text);
  return m?.[1] ?? null;
}

function buildCardData(
  toolKey: string,
  status: AgyToolCardData["status"],
  input: Record<string, unknown> | null,
  rawInput: unknown,
  rawOutput: unknown,
  callId: string,
): AgyToolCardData {
  switch (toolKey) {
    case "post_message": {
      const text = readStr(input, ["text", "message", "Message"]) ?? "";
      const mentions = extractMentions(text);
      const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? text;
      return {
        toolKey,
        category: "swarm_post",
        status,
        badge: "Swarm 发帖",
        headline: firstLine ? clipOneLine(firstLine, 96) : "发布消息到共享板",
        subline: mentions.length > 0 ? `提及 ${mentions.map((m) => `@${m}`).join(" ")}` : null,
        accent: "accent",
        body: text.length > 0 ? text.slice(0, 4000) : null,
        mentions,
        boardSince: null,
        steps: null,
        canOpenConsole: true,
      };
    }

    case "swarm": {
      const action = (readStr(input, ["action"]) ?? "status").toLowerCase();
      const name = readStr(input, ["name"]);
      const model = readStr(input, ["model"]);
      const workspace = readStr(input, ["workspace"]);
      const title = readStr(input, ["title"]);
      const brief = readStr(input, ["brief"]);
      const n = readNum(input, ["n"]);
      const tasks = Array.isArray(input?.tasks) ? input.tasks.length : null;

      if (action === "add") {
        const countTag = tasks ? ` ×${tasks}` : n && n > 1 ? ` ×${n}` : "";
        const metaParts = [workspace, model].filter(Boolean);
        return {
          toolKey,
          category: "swarm_action",
          status,
          badge: "Swarm 派人",
          headline: `添加 ${name ?? "worker"}${countTag}`,
          subline: metaParts.length > 0 ? metaParts.join(" · ") : brief ? clipOneLine(brief, 76) : null,
          accent: "success",
          body: brief ? brief.slice(0, 4000) : null,
          mentions: name ? [name] : [],
          boardSince: null,
          steps: null,
          targetMember: name && !countTag ? name : null,
          canOpenConsole: true,
        };
      }
      if (action === "kill") {
        return {
          toolKey,
          category: "swarm_action",
          status,
          badge: "Swarm 结束",
          headline: `结束成员 ${name ?? ""}`.trim(),
          subline: null,
          accent: "warning",
          body: null,
          mentions: name ? [name] : [],
          boardSince: null,
          steps: null,
          targetMember: name && name !== "coordinator" ? name : null,
          canOpenConsole: true,
        };
      }
      if (action === "model") {
        return {
          toolKey,
          category: "swarm_action",
          status,
          badge: "Swarm 换模",
          headline: `${name ?? "coordinator"} → ${model ?? "默认模型"}`,
          subline: null,
          accent: "accent",
          body: null,
          mentions: name ? [name] : [],
          boardSince: null,
          steps: null,
          targetMember: name && name !== "coordinator" ? name : null,
          canOpenConsole: true,
        };
      }
      if (action === "title") {
        return {
          toolKey,
          category: "swarm_action",
          status,
          badge: "Swarm 命名",
          headline: title ?? "更新 Swarm 标题",
          subline: null,
          accent: "muted",
          body: null,
          mentions: [],
          boardSince: null,
          steps: null,
          canOpenConsole: true,
        };
      }
      return {
        toolKey,
        category: "swarm_action",
        status,
        badge: "Swarm",
        headline: action === "models" ? "查询 Swarm 可用模型" : "查看 Swarm 成员状态",
        subline: null,
        accent: "muted",
        body: null,
        mentions: [],
        boardSince: null,
        steps: null,
        canOpenConsole: true,
      };
    }

    case "read_board": {
      const since = readNum(input, ["since"]);
      return {
        toolKey,
        category: "swarm_read",
        status,
        badge: "读消息板",
        headline: since !== null ? `拉取 #${since} 之后的新帖` : "读取共享消息板",
        subline: "点击展开查看对应消息板帖子",
        accent: "muted",
        body: null,
        mentions: [],
        boardSince: since ?? 0,
        steps: null,
        canOpenConsole: true,
      };
    }

    case "swarm_wait": {
      const since = readNum(input, ["since"]);
      return {
        toolKey,
        category: "swarm_wait",
        status,
        badge: status === "running" ? "Swarm 等待中" : "Swarm 唤醒",
        headline:
          since !== null
            ? status === "running"
              ? `等待消息板更新 (> #${since})`
              : `已从消息板唤醒 (> #${since})`
            : status === "running"
              ? "等待消息板唤醒"
              : "已从消息板唤醒",
        subline: null,
        accent: status === "running" ? "warning" : "muted",
        body: null,
        mentions: [],
        boardSince: since ?? 0,
        steps: null,
        canOpenConsole: true,
      };
    }

    case "invoke_subagent": {
      const role = readStr(input, ["Role", "role"]) ?? "Subagent";
      const typeName = readStr(input, ["TypeName", "typeName"]) ?? "subagent";
      const model = readStr(input, ["Model", "model"]);
      const workspace = readStr(input, ["Workspace", "workspace"]);
      const prompt = readStr(input, ["Prompt", "prompt"]);
      const tl = `${typeName} ${role}`.toLowerCase();
      const isTeamwork = tl.includes("teamwork") || tl.includes("orchestrator") || tl.includes("auditor") || tl.includes("challenger");
      const isBoost = tl.includes("boost") || tl.includes("deepcoder") || tl.includes("deepinvestigator");
      const badge = isTeamwork ? "Teamwork 派发" : isBoost ? "Boost 派发" : "派发子代理";
      const meta = [typeName, workspace && workspace !== "inherit" ? workspace : null, model && model !== "inherit" ? model : null]
        .filter(Boolean)
        .join(" · ");
      const targetSubagentId = extractConversationIdFromOutput(rawOutput);
      return {
        toolKey,
        category: "subagent_invoke",
        status,
        badge,
        headline: role,
        subline: meta || null,
        accent: isTeamwork ? "accent" : isBoost ? "warning" : "success",
        body: prompt ? prompt.slice(0, 4000) : null,
        mentions: [],
        boardSince: null,
        steps: null,
        targetSubagentId,
        canOpenConsole: true,
      };
    }

    case "define_subagent": {
      const name = readStr(input, ["Name", "name"]) ?? "custom";
      const desc = readStr(input, ["Description", "description"]);
      return {
        toolKey,
        category: "subagent_manage",
        status,
        badge: "定义角色",
        headline: name,
        subline: desc ? clipOneLine(desc, 84) : null,
        accent: "muted",
        body: readStr(input, ["SystemPrompt"])?.slice(0, 3000) ?? null,
        mentions: [],
        boardSince: null,
        steps: null,
        canOpenConsole: true,
      };
    }

    case "send_message": {
      const recipient = readStr(input, ["Recipient", "recipient"]);
      const message = readStr(input, ["Message", "message"]) ?? "";
      return {
        toolKey,
        category: "subagent_message",
        status,
        badge: "子代理消息",
        headline: message ? clipOneLine(message, 88) : "发送子代理消息",
        subline: recipient ? `发往 ${recipient.slice(0, 12)}` : null,
        accent: "accent",
        body: message ? message.slice(0, 4000) : null,
        mentions: [],
        boardSince: null,
        steps: null,
        targetSubagentId: recipient,
        canOpenConsole: true,
      };
    }

    case "manage_subagents": {
      const action = readStr(input, ["Action", "action"]) ?? "list";
      const ids = Array.isArray(input?.ConversationIds) ? input.ConversationIds.length : 0;
      return {
        toolKey,
        category: "subagent_manage",
        status,
        badge: "管理子代理",
        headline:
          action === "list"
            ? "查询活跃子代理列表"
            : action === "kill_all"
              ? "终止全部子代理"
              : `终止子代理${ids > 0 ? ` (${ids} 个)` : ""}`,
        subline: null,
        accent: action.startsWith("kill") ? "warning" : "muted",
        body: null,
        mentions: [],
        boardSince: null,
        steps: null,
        canOpenConsole: true,
      };
    }

    case "run_workflow": {
      const desc = readStr(input, ["Description", "description"]) ?? readStr(input, ["ScriptPath"]) ?? "运行 Python Workflow";
      const script = readStr(input, ["Script", "ScriptPath"]);
      return {
        toolKey,
        category: "workflow",
        status,
        badge: "Workflow",
        headline: clipOneLine(desc, 92),
        subline: readStr(input, ["Cwd"]),
        accent: "accent",
        body: script ? script.slice(0, 3000) : safeJsonPreview(input?.Args),
        mentions: [],
        boardSince: null,
        steps: null,
        canOpenConsole: true,
      };
    }

    case "update_steps": {
      const rawSteps = Array.isArray(input?.steps) ? input.steps : [];
      const steps: Array<{ title: string; status: string }> = [];
      for (const s of rawSteps) {
        if (!isRecord(s)) continue;
        const title = readStr(s, ["title"]);
        const st = readStr(s, ["status"]) ?? "pending";
        if (title) steps.push({ title, status: st });
      }
      const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
      const activeStep = steps.find((s) => s.status === "in_progress");
      return {
        toolKey,
        category: "steps",
        status,
        badge: `进度 ${done}/${steps.length}`,
        headline: activeStep ? activeStep.title : done === steps.length && steps.length > 0 ? "全部步骤已完成" : "更新执行清单",
        subline: null,
        accent: done === steps.length && steps.length > 0 ? "success" : "accent",
        body: null,
        mentions: [],
        boardSince: null,
        steps: steps.length > 0 ? steps : null,
        canOpenConsole: true,
      };
    }

    case "enter_plan_mode":
    case "exit_plan_mode": {
      const entering = toolKey === "enter_plan_mode";
      return {
        toolKey,
        category: "plan_mode",
        status,
        badge: "Plan",
        headline: entering ? "进入规划模式" : "退出规划模式，开始执行",
        subline: null,
        accent: entering ? "accent" : "success",
        body: null,
        mentions: [],
        boardSince: null,
        steps: null,
        canOpenConsole: true,
      };
    }

    case "schedule": {
      const sec = readNum(input, ["DurationSeconds"]);
      const cron = readStr(input, ["CronExpression"]);
      const prompt = readStr(input, ["Prompt"]);
      return {
        toolKey,
        category: "schedule",
        status,
        badge: cron ? "定时任务" : "计时器",
        headline: prompt ? clipOneLine(prompt, 84) : cron ? `Cron: ${cron}` : `等待 ${sec ?? 0}s`,
        subline: cron ? `Cron: ${cron}` : sec !== null ? `${sec}s` : null,
        accent: "muted",
        body: prompt ? prompt.slice(0, 2000) : null,
        mentions: [],
        boardSince: null,
        steps: null,
        canOpenConsole: true,
      };
    }

    case "manage_task": {
      const action = readStr(input, ["Action", "action"]) ?? "list";
      const taskId = readStr(input, ["TaskId", "taskId"]);
      return {
        toolKey,
        category: "task_manage",
        status,
        badge: "后台任务",
        headline:
          action === "list"
            ? "查询后台任务列表"
            : `${action}${taskId ? ` ${taskId.slice(-12)}` : ""}`,
        subline: null,
        accent: action === "kill" ? "warning" : "muted",
        body: readStr(input, ["Input"])?.slice(0, 1000) ?? null,
        mentions: [],
        boardSince: null,
        steps: null,
        canOpenConsole: true,
      };
    }

    case "ask_question": {
      const parsedQuestions = parseQuestionsField(input?.questions);
      if (parsedQuestions.length > 0) {
        recordSeenQuestionFallback(parsedQuestions);
      }
      const firstQ = parsedQuestions[0]?.question ?? null;
      const questionAnswer = extractQuestionAnswer(rawOutput);
      const multiCount = parsedQuestions.filter((q) => q.isMultiSelect).length;
      const badge =
        parsedQuestions.length > 1
          ? `确认问题 · ${parsedQuestions.length} 题`
          : multiCount > 0
            ? "多选确认"
            : parsedQuestions.length === 1
              ? "单选确认"
              : "确认问题";
      return {
        callId,
        toolKey,
        category: "question",
        status,
        badge,
        headline: firstQ ? clipOneLine(firstQ, 92) : `向用户提问（${parsedQuestions.length || 1} 题）`,
        subline: questionAnswer ? clipOneLine(questionAnswer, 88) : null,
        accent: questionAnswer ? "success" : "warning",
        body: parsedQuestions.length === 0 ? safeJsonPreview(rawInput, 2000) : null,
        mentions: [],
        boardSince: null,
        steps: null,
        questions: parsedQuestions.length > 0 ? parsedQuestions : null,
        questionAnswer,
        canOpenConsole: false,
      };
    }

    default: {
      const summaryField = readStr(input, [
        "title",
        "description",
        "Description",
        "summary",
        "query",
        "path",
        "Path",
        "name",
        "Name",
        "action",
        "Action",
      ]);
      return {
        toolKey,
        category: "generic",
        status,
        badge: toolKey,
        headline: summaryField ? clipOneLine(summaryField, 90) : toolKey,
        subline: null,
        accent: "muted",
        body: safeJsonPreview(rawInput, 1500),
        mentions: [],
        boardSince: null,
        steps: null,
        canOpenConsole: false,
      };
    }
  }
}

export const transformAgyOtherToolCall: ToolCallTransformer = ({ item }) => {
  const metaKind =
    isRecord(item.metadata) && typeof item.metadata.kind === "string"
      ? item.metadata.kind.toLowerCase()
      : "";
  if (item.name.toLowerCase() !== "other" && metaKind !== "other") {
    return;
  }

  const metaTitle =
    isRecord(item.metadata) && typeof item.metadata.title === "string"
      ? item.metadata.title.trim()
      : item.name.trim();
  if (!metaTitle || metaTitle.toLowerCase() === "other") {
    return;
  }

  const toolKey = normalizeToolKey(metaTitle);
  if (!toolKey) return;

  const rawInput = item.detail.type === "unknown" ? item.detail.input : null;
  const rawOutput = item.detail.type === "unknown" ? item.detail.output : null;
  const inputRec = isRecord(rawInput) ? rawInput : null;
  const data = buildCardData(toolKey, item.status, inputRec, rawInput, rawOutput, item.callId);

  return {
    items: [
      {
        type: "plugin",
        kind: "agy-tool-card",
        version: 1,
        data,
      },
    ],
  };
};
