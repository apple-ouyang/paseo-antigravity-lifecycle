import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  useRpc,
  type PluginAgentPanelProps,
} from "@getpaseo/plugin/client";
import {
  agyChildStepDetailGet,
  agyChildTranscriptGet,
  agyConsoleGet,
  agySwarmSendMessage,
  type AgyConsoleDetail,
  type AgyMode,
  type ChildStepDetail,
  type ChildStepDiff,
  type ChildStepToolDetail,
  type SubagentCategory,
  type SubagentItem,
  type SwarmBoardPost,
  type SwarmMember,
  type TeamworkPhase,
  type TranscriptStep,
} from "../shared/rpc.ts";
import { formatDurationShort, ProgressMeter } from "./progress-bar.tsx";
import {
  applyChildTranscriptResponse,
  consumeConsoleNavRequest,
  formatLocalTimestamp,
  getChildStepDetailCache,
  getChildTranscriptCache,
  getConsoleDetailCache,
  getConsoleNavRequest,
  getStatusSnapshot,
  resolveCoordinatorChildFromStatus,
  resolveMemberChildFromStatus,
  resolveSubagentChildFromStatus,
  setChildStepDetailCache,
  setConsoleDetailCache,
  subscribeConsoleNav,
  subscribeStatus,
  upsertAgentStatus,
  type ConsoleNavTarget,
  type SelectedChildTarget,
} from "./store.ts";

type ConsoleTab = "overview" | "board" | "members" | "tree";
type ChildFetchState = "loading" | "syncing" | "ready" | "error";

type SelectedChild = SelectedChildTarget;

const MODE_LABELS: Record<AgyMode, string> = {
  swarm: "Swarm",
  teamwork: "Teamwork",
  boost: "Boost",
  workflow: "Workflow",
  goal: "/goal",
  plan: "Plan",
  subagents: "子代理",
  tasks: "后台任务",
};

const TEAMWORK_PHASES: Array<{ key: TeamworkPhase; label: string }> = [
  { key: "interview", label: "访谈" },
  { key: "planning", label: "规划" },
  { key: "executing", label: "执行" },
  { key: "auditing", label: "门禁" },
  { key: "victory_audit", label: "终审" },
  { key: "completed", label: "完成" },
];

const ROLE_WORKER_RE = /^(?:narrator|monitor)(?:-\d+)?$/i;

function isRoleWorker(name: string): boolean {
  return ROLE_WORKER_RE.test(name);
}

function isMemberDoneOrRetired(member: SwarmMember): boolean {
  return (
    member.state === "completed" ||
    member.state === "canceled" ||
    member.state === "stopped" ||
    (member.state === "waiting" && Boolean(member.delivered))
  );
}

function isMemberActive(member: SwarmMember): boolean {
  return member.state === "working" || member.state === "failed";
}

function stateMeta(
  state: SwarmMember["state"] | SubagentItem["state"] | "running" | "completed" | "failed",
  theme: PluginTheme,
): { label: string; color: string } {
  switch (state) {
    case "working":
    case "running":
      return { label: "运行中", color: theme.colors.accent };
    case "waiting":
      return { label: "待命", color: theme.colors.statusWarning };
    case "completed":
      return { label: "已完成", color: theme.colors.statusSuccess };
    case "failed":
      return { label: "失败", color: theme.colors.statusDanger };
    case "canceled":
      return { label: "已取消", color: theme.colors.foregroundMuted };
    case "stopped":
      return { label: "已归档", color: theme.colors.foregroundMuted };
  }
}

function categoryMeta(
  category: SubagentCategory | undefined,
  theme: PluginTheme,
): { label: string; color: string } {
  switch (category) {
    case "orchestrator":
      return { label: "编排器", color: theme.colors.accent };
    case "interviewer":
      return { label: "访谈官", color: theme.colors.accent };
    case "explorer":
      return { label: "探索者", color: theme.colors.statusSuccess };
    case "worker":
      return { label: "执行者", color: theme.colors.statusSuccess };
    case "reviewer":
      return { label: "评审官", color: theme.colors.statusWarning };
    case "challenger":
      return { label: "挑战官", color: theme.colors.statusWarning };
    case "auditor":
      return { label: "审计官", color: theme.colors.statusDanger };
    case "victory_auditor":
      return { label: "终审官", color: theme.colors.statusDanger };
    case "boost":
      return { label: "Boost", color: theme.colors.statusWarning };
    case "research":
      return { label: "调研", color: theme.colors.accent };
    case "self":
      return { label: "子代理", color: theme.colors.foregroundMuted };
    default:
      return { label: "角色", color: theme.colors.foregroundMuted };
  }
}

function stepKindColor(kind: TranscriptStep["kind"], theme: PluginTheme): string {
  switch (kind) {
    case "error":
      return theme.colors.statusDanger;
    case "tool":
      return theme.colors.accent;
    case "assistant":
      return theme.colors.statusSuccess;
    case "system":
      return theme.colors.statusWarning;
    default:
      return theme.colors.foregroundMuted;
  }
}

function shortWorkspace(p: string | null | undefined): string | null {
  if (!p) return null;
  const parts = p.split("/").filter(Boolean);
  return parts.length >= 2 ? `…/${parts.slice(-2).join("/")}` : parts[0] ?? p;
}

function stripDonePrefix(text: string): string {
  return text
    .replace(/^(?:@[a-z0-9_-]+[\s,:–—-]*)+/i, "")
    .replace(/^(?:\*\*|\*|`|_)?\[done\](?:\*\*|\*|`|_)?[\s:,.–—-]*/i, "")
    .trim();
}

function Chip({
  label,
  color,
  theme,
  active,
  onPress,
}: {
  label: string;
  color: string;
  theme: PluginTheme;
  active?: boolean;
  onPress?: () => void;
}) {
  const inner = (
    <View
      style={{
        backgroundColor: active ? theme.colors.accent : theme.colors.surface2,
        borderColor: active ? theme.colors.accent : theme.colors.border,
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 3,
      }}
    >
      <Text
        style={{
          color: active ? theme.colors.accentForeground : color,
          fontSize: 11,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </View>
  );
  if (!onPress) return inner;
  return <Pressable onPress={onPress}>{inner}</Pressable>;
}

function DisclosureBar({
  title,
  count,
  open,
  accentColor,
  theme,
  onToggle,
  children,
}: {
  title: string;
  count: string;
  open: boolean;
  accentColor?: string;
  theme: PluginTheme;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 9,
        overflow: "hidden",
      }}
    >
      <Pressable
        onPress={onToggle}
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingHorizontal: 12,
          paddingVertical: 9,
          gap: 8,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
          <Text style={{ color: accentColor ?? theme.colors.foregroundMuted, fontSize: 11 }}>
            {open ? "▾" : "▸"}
          </Text>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }} numberOfLines={1}>
            {title}
          </Text>
        </View>
        <Text style={{ color: accentColor ?? theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
          {count}
        </Text>
      </Pressable>
      {open ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            padding: 10,
            gap: 6,
          }}
        >
          {children}
        </View>
      ) : null}
    </View>
  );
}

function SectionCard({
  title,
  right,
  theme,
  children,
}: {
  title: string;
  right?: string | null;
  theme: PluginTheme;
  children: React.ReactNode;
}) {
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "700" }}>{title}</Text>
        {right ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{right}</Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

function MemberRow({
  member,
  taskDesc,
  theme,
  onOpen,
}: {
  member: SwarmMember;
  taskDesc?: string;
  theme: PluginTheme;
  onOpen: () => void;
}) {
  const delivered = member.state === "waiting" && Boolean(member.delivered);
  const meta = delivered
    ? { label: "已交活 ✓", color: theme.colors.statusSuccess }
    : stateMeta(member.state, theme);
  const retired = isMemberDoneOrRetired(member);
  const cleanAct = member.lastActivity ? stripDonePrefix(member.lastActivity) : null;
  const dur = formatDurationShort(member.durationMs);
  return (
    <Pressable
      disabled={!member.conversationId}
      onPress={onOpen}
      style={{
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 7,
        paddingHorizontal: 10,
        paddingVertical: 8,
        gap: 3,
        opacity: retired ? 0.8 : 1,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }} numberOfLines={1}>
            @{member.name}
          </Text>
          {member.stepProgress ? (
            <Text style={{ color: theme.colors.accent, fontSize: 10, fontWeight: "600" }}>
              {member.stepProgress.done}/{member.stepProgress.total}步
            </Text>
          ) : null}
          {dur ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
              {retired ? dur : `已跑 ${dur}`}
            </Text>
          ) : null}
          {member.workspaceMode && member.workspaceMode !== "inherit" ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
              {member.workspaceMode}
            </Text>
          ) : null}
        </View>
        <Text style={{ color: meta.color, fontSize: 11, fontWeight: "600" }}>{meta.label}</Text>
      </View>

      {taskDesc ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
          {taskDesc}
        </Text>
      ) : null}

      {cleanAct ? (
        <Text
          style={{
            color: member.state === "working" ? theme.colors.accent : theme.colors.foregroundMuted,
            fontSize: 11,
          }}
          numberOfLines={1}
        >
          {cleanAct}
        </Text>
      ) : null}

      {member.workspace || member.stepCount ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }} numberOfLines={1}>
          {[
            shortWorkspace(member.workspace),
            member.stepCount ? `${member.stepCount} 步` : null,
            member.conversationId ? "点击查看对话 →" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      ) : null}
    </Pressable>
  );
}

function BoardPostRow({
  post,
  theme,
}: {
  post: SwarmBoardPost;
  theme: PluginTheme;
}) {
  const [expanded, setExpanded] = useState(post.text.length <= 260);
  const isCoord = post.agent === "coordinator";
  const agentColor = isCoord ? theme.colors.accent : theme.colors.statusSuccess;

  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderLeftWidth: 3,
        borderLeftColor: agentColor,
        borderRadius: 8,
        padding: 10,
        gap: 6,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", flex: 1 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
            #{post.seq}
          </Text>
          <Text style={{ color: agentColor, fontSize: 12, fontWeight: "700" }}>{post.agent}</Text>
          {post.mentions.map((m) => (
            <View
              key={m}
              style={{
                backgroundColor: theme.colors.surface2,
                borderRadius: 4,
                paddingHorizontal: 5,
                paddingVertical: 1,
              }}
            >
              <Text style={{ color: theme.colors.accent, fontSize: 10, fontWeight: "600" }}>@{m}</Text>
            </View>
          ))}
        </View>
        {post.time ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
            {formatLocalTimestamp(post.time)}
          </Text>
        ) : null}
      </View>

      <Text
        selectable
        style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 18 }}
        numberOfLines={expanded ? undefined : 5}
      >
        {post.text}
      </Text>

      {post.screenshots.length > 0 ? (
        <View style={{ gap: 2 }}>
          {post.screenshots.map((sc, idx) => (
            <Text
              key={`${idx}-${sc.path}`}
              style={{ color: theme.colors.accent, fontSize: 11 }}
              numberOfLines={1}
            >
              [截图] {sc.caption || shortWorkspace(sc.path)}
            </Text>
          ))}
        </View>
      ) : null}

      {post.text.length > 260 ? (
        <Pressable onPress={() => setExpanded((v) => !v)}>
          <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "500" }}>
            {expanded ? "收起" : "展开全文"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const INITIAL_DIFF_VISIBLE_LINES = 40;

function toolKindMeta(
  name: string,
  theme: PluginTheme,
): { label: string; color: string } {
  switch (name) {
    case "edit_file":
    case "replace_file_content":
      return { label: "编辑", color: theme.colors.statusWarning };
    case "write_file":
    case "write_to_file":
      return { label: "写入", color: theme.colors.statusSuccess };
    case "run_command":
      return { label: "命令", color: theme.colors.accent };
    case "read_file":
      return { label: "读取", color: theme.colors.foregroundMuted };
    case "post_message":
      return { label: "发帖", color: theme.colors.accent };
    case "read_board":
    case "swarm_wait":
      return { label: "消息板", color: theme.colors.foregroundMuted };
    case "swarm":
      return { label: "Swarm", color: theme.colors.accent };
    case "invoke_subagent":
    case "send_message":
      return { label: "子代理", color: theme.colors.accent };
    case "update_steps":
      return { label: "进度", color: theme.colors.statusSuccess };
    default:
      return { label: name, color: theme.colors.foregroundMuted };
  }
}

function DiffViewer({ diff, theme }: { diff: ChildStepDiff; theme: PluginTheme }) {
  const [showAllLines, setShowAllLines] = useState(false);
  const canExpand = diff.lines.length > INITIAL_DIFF_VISIBLE_LINES;
  const visibleLines =
    showAllLines || !canExpand ? diff.lines : diff.lines.slice(0, INITIAL_DIFF_VISIBLE_LINES);
  const modeLabel =
    diff.mode === "edit" ? "Diff" : diff.mode === "append" ? "追加写入" : "新建/覆写";

  return (
    <View
      style={{
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 6,
        overflow: "hidden",
        backgroundColor: theme.colors.surface1,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 8,
          paddingVertical: 5,
          backgroundColor: theme.colors.surface2,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
          <Text
            style={{
              color: diff.mode === "edit" ? theme.colors.statusWarning : theme.colors.statusSuccess,
              fontSize: 10,
              fontWeight: "700",
            }}
          >
            {modeLabel}
          </Text>
          <Text
            selectable
            style={{ color: theme.colors.foreground, fontSize: 11, fontFamily: "monospace", flexShrink: 1 }}
            numberOfLines={1}
          >
            {diff.path}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {diff.addedLines > 0 ? (
            <Text style={{ color: theme.colors.statusSuccess, fontSize: 11, fontWeight: "700", fontFamily: "monospace" }}>
              +{diff.addedLines}
            </Text>
          ) : null}
          {diff.removedLines > 0 ? (
            <Text style={{ color: theme.colors.statusDanger, fontSize: 11, fontWeight: "700", fontFamily: "monospace" }}>
              -{diff.removedLines}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={{ paddingVertical: 3 }}>
        {visibleLines.map((line, idx) => {
          if (line.kind === "hunk") {
            return (
              <View
                key={`h-${idx}`}
                style={{
                  backgroundColor: "rgba(56, 189, 248, 0.10)",
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                }}
              >
                <Text
                  selectable
                  style={{
                    color: theme.colors.accent,
                    fontSize: 10,
                    fontFamily: "monospace",
                    lineHeight: 15,
                  }}
                >
                  {line.text}
                </Text>
              </View>
            );
          }

          const isAdd = line.kind === "add";
          const isDel = line.kind === "del";
          const rowBg = isAdd
            ? "rgba(34, 197, 94, 0.13)"
            : isDel
              ? "rgba(239, 68, 68, 0.14)"
              : "transparent";
          const sign = isAdd ? "+" : isDel ? "-" : " ";
          const signColor = isAdd
            ? theme.colors.statusSuccess
            : isDel
              ? theme.colors.statusDanger
              : theme.colors.foregroundMuted;
          const lineNo = isDel ? line.oldLine : (line.newLine ?? line.oldLine);

          return (
            <View
              key={`l-${idx}`}
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                backgroundColor: rowBg,
                paddingHorizontal: 6,
                paddingVertical: 1,
                gap: 4,
              }}
            >
              <Text
                style={{
                  width: 30,
                  textAlign: "right",
                  color: theme.colors.foregroundMuted,
                  fontSize: 10,
                  fontFamily: "monospace",
                  lineHeight: 16,
                  opacity: 0.7,
                }}
              >
                {lineNo != null ? String(lineNo) : ""}
              </Text>
              <Text
                style={{
                  width: 12,
                  textAlign: "center",
                  color: signColor,
                  fontSize: 11,
                  fontWeight: isAdd || isDel ? "700" : "400",
                  fontFamily: "monospace",
                  lineHeight: 16,
                }}
              >
                {sign}
              </Text>
              <Text
                selectable
                style={{
                  flex: 1,
                  color: isAdd || isDel ? theme.colors.foreground : theme.colors.foregroundMuted,
                  fontSize: 11,
                  fontFamily: "monospace",
                  lineHeight: 16,
                }}
              >
                {line.text.length > 0 ? line.text : " "}
              </Text>
            </View>
          );
        })}
      </View>

      {canExpand || diff.truncated ? (
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            paddingHorizontal: 8,
            paddingVertical: 5,
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            backgroundColor: theme.colors.surface2,
          }}
        >
          {canExpand ? (
            <Pressable onPress={() => setShowAllLines((v) => !v)}>
              <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>
                {showAllLines
                  ? `▴ 收起至前 ${INITIAL_DIFF_VISIBLE_LINES} 行`
                  : `▾ 展开剩余 ${diff.lines.length - INITIAL_DIFF_VISIBLE_LINES} 行`}
              </Text>
            </Pressable>
          ) : (
            <View />
          )}
          {diff.truncated && diff.totalLines ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
              已预览 {diff.lines.length} / 共 {diff.totalLines} 行
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ToolCallItemRow({
  tc,
  open,
  onToggle,
  theme,
}: {
  tc: ChildStepToolDetail;
  open: boolean;
  onToggle: () => void;
  theme: PluginTheme;
}) {
  const isErrorOut = tc.outputStatus === "ERROR";
  const outputLines = tc.output ? tc.output.split("\n").length : 0;
  const isShortOut = Boolean(tc.output && tc.output.length <= 240 && outputLines <= 6);
  const [outOpen, setOutOpen] = useState(() => isShortOut || isErrorOut);
  const meta = toolKindMeta(tc.name, theme);
  const hasDetailBody = Boolean(tc.diff || tc.command || tc.primaryText || tc.argsText || tc.output);

  return (
    <View
      style={{
        backgroundColor: theme.colors.surface0,
        borderColor: open ? theme.colors.accent : theme.colors.border,
        borderWidth: 1,
        borderRadius: 7,
        overflow: "hidden",
      }}
    >
      <Pressable
        onPress={hasDetailBody ? onToggle : undefined}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          paddingHorizontal: 9,
          paddingVertical: 7,
          backgroundColor: open ? theme.colors.surface1 : theme.colors.surface0,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
          <View
            style={{
              backgroundColor: theme.colors.surface2,
              borderColor: theme.colors.border,
              borderWidth: 1,
              borderRadius: 4,
              paddingHorizontal: 5,
              paddingVertical: 1,
            }}
          >
            <Text style={{ color: meta.color, fontSize: 10, fontWeight: "700" }}>{meta.label}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <Text
              style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "600" }}
              numberOfLines={1}
            >
              {tc.summary}
            </Text>
            {tc.subtitle && tc.subtitle !== tc.summary ? (
              <Text
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 10,
                  fontFamily: tc.command || tc.diff ? "monospace" : undefined,
                }}
                numberOfLines={1}
              >
                {tc.command ? `$ ${tc.subtitle}` : tc.subtitle}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {tc.diff ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              {tc.diff.addedLines > 0 ? (
                <Text
                  style={{
                    color: theme.colors.statusSuccess,
                    fontSize: 10,
                    fontWeight: "700",
                    fontFamily: "monospace",
                  }}
                >
                  +{tc.diff.addedLines}
                </Text>
              ) : null}
              {tc.diff.removedLines > 0 ? (
                <Text
                  style={{
                    color: theme.colors.statusDanger,
                    fontSize: 10,
                    fontWeight: "700",
                    fontFamily: "monospace",
                  }}
                >
                  -{tc.diff.removedLines}
                </Text>
              ) : null}
            </View>
          ) : null}
          {tc.outputStatus ? (
            <Text
              style={{
                color: isErrorOut ? theme.colors.statusDanger : theme.colors.statusSuccess,
                fontSize: 10,
                fontWeight: "600",
              }}
            >
              {tc.outputStatus}
            </Text>
          ) : null}
          {hasDetailBody ? (
            <Text style={{ color: theme.colors.accent, fontSize: 10, fontWeight: "600" }}>
              {open ? "▾" : "▸"}
            </Text>
          ) : null}
        </View>
      </Pressable>

      {open && hasDetailBody ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            padding: 8,
            gap: 7,
          }}
        >
          {tc.diff ? <DiffViewer diff={tc.diff} theme={theme} /> : null}

          {tc.command ? (
            <View
              style={{
                backgroundColor: theme.colors.surface1,
                borderColor: theme.colors.border,
                borderWidth: 1,
                borderRadius: 5,
                paddingHorizontal: 8,
                paddingVertical: 6,
              }}
            >
              <Text
                selectable
                style={{
                  color: theme.colors.foreground,
                  fontSize: 11,
                  lineHeight: 16,
                  fontFamily: "monospace",
                }}
              >
                $ {tc.command}
              </Text>
            </View>
          ) : null}

          {tc.primaryText ? (
            <Text
              selectable
              style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 18 }}
            >
              {tc.primaryText}
            </Text>
          ) : null}

          {tc.argsText ? (
            <Text
              selectable
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 11,
                lineHeight: 16,
                fontFamily: "monospace",
                backgroundColor: theme.colors.surface1,
                borderRadius: 5,
                padding: 7,
              }}
            >
              {tc.argsText}
            </Text>
          ) : null}

          {tc.output ? (
            <View style={{ gap: 4 }}>
              <Pressable onPress={() => setOutOpen((v) => !v)}>
                <Text
                  style={{
                    color: isErrorOut ? theme.colors.statusDanger : theme.colors.foregroundMuted,
                    fontSize: 11,
                    fontWeight: "600",
                  }}
                >
                  {outOpen
                    ? `▾ 收起执行结果 (${outputLines > 1 ? `${outputLines} 行 · ` : ""}${tc.output.length} 字)`
                    : `▸ 展开执行结果 (${outputLines > 1 ? `${outputLines} 行 · ` : ""}${tc.output.length} 字)`}
                </Text>
              </Pressable>
              {outOpen ? (
                <Text
                  selectable
                  style={{
                    color: isErrorOut ? theme.colors.statusDanger : theme.colors.foreground,
                    fontSize: 11,
                    lineHeight: 16,
                    fontFamily: "monospace",
                    backgroundColor: theme.colors.surface1,
                    borderRadius: 5,
                    padding: 7,
                  }}
                >
                  {tc.output}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ChildStepRow({
  agentId,
  conversationId,
  step,
  theme,
  fetchStepDetail,
}: {
  agentId: string;
  conversationId: string;
  step: TranscriptStep;
  theme: PluginTheme;
  fetchStepDetail: (input: {
    agentId: string;
    conversationId: string;
    stepIndex: number;
  }) => Promise<ChildStepDetail | null>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<ChildStepDetail | null>(() =>
    getChildStepDetailCache(conversationId, step.stepIndex),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [openTools, setOpenTools] = useState<Record<number, boolean>>({});

  const toggleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (!next) return;

    const cached = getChildStepDetailCache(conversationId, step.stepIndex);
    if (cached) {
      setDetail(cached);
      return;
    }
    if (loading) return;
    setLoading(true);
    setError(null);
    void fetchStepDetail({
      agentId,
      conversationId,
      stepIndex: step.stepIndex,
    })
      .then((res) => {
        if (res) {
          setChildStepDetailCache(res);
          setDetail(res);
        } else {
          setError("未能读取该步骤的完整详情");
        }
      })
      .catch((err: unknown) => {
        setError(`读取详情失败：${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const toolCalls = detail?.toolCalls ?? [];
  const defaultToolOpen = toolCalls.length === 1;
  const allToolsOpen =
    toolCalls.length > 0 &&
    toolCalls.every((_, idx) => openTools[idx] ?? defaultToolOpen);

  return (
    <View
      style={{
        backgroundColor:
          step.kind === "user" || step.kind === "assistant"
            ? theme.colors.surface2
            : theme.colors.surface1,
        borderColor: expanded ? theme.colors.accent : theme.colors.border,
        borderWidth: 1,
        borderLeftWidth: 3,
        borderLeftColor: stepKindColor(step.kind, theme),
        borderRadius: 8,
        padding: 9,
        gap: 6,
      }}
    >
      <Pressable
        onPress={toggleExpand}
        style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}
      >
        <Text
          style={{
            color: stepKindColor(step.kind, theme),
            fontSize: 11,
            fontWeight: "700",
            flexShrink: 1,
          }}
          numberOfLines={1}
        >
          #{step.stepIndex} · {step.title}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: theme.colors.accent, fontSize: 10, fontWeight: "600" }}>
            {expanded ? "收起 ▾" : "详情 ▸"}
          </Text>
          {step.createdAt ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
              {formatLocalTimestamp(step.createdAt)}
            </Text>
          ) : null}
        </View>
      </Pressable>

      {!expanded && step.summary ? (
        <Pressable onPress={toggleExpand}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 18 }}>
            {step.summary}
          </Text>
        </Pressable>
      ) : null}

      {expanded ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            paddingTop: 8,
            gap: 8,
          }}
        >
          {loading ? (
            <Text style={{ color: theme.colors.accent, fontSize: 11 }}>
              正在读取完整详情（transcript_full）…
            </Text>
          ) : error ? (
            <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>{error}</Text>
          ) : detail ? (
            <View style={{ gap: 8 }}>
              {detail.content ? (
                <Text selectable style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 19 }}>
                  {detail.content}
                </Text>
              ) : null}

              {toolCalls.length > 0 ? (
                <View style={{ gap: 5 }}>
                  {toolCalls.length > 1 ? (
                    <View
                      style={{
                        flexDirection: "row",
                        justifyContent: "space-between",
                        alignItems: "center",
                        paddingHorizontal: 2,
                      }}
                    >
                      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
                        共 {toolCalls.length} 个操作（点击单项查看详情 / Diff）
                      </Text>
                      <Pressable
                        onPress={() => {
                          const nextVal = !allToolsOpen;
                          const map: Record<number, boolean> = {};
                          for (let i = 0; i < toolCalls.length; i += 1) map[i] = nextVal;
                          setOpenTools(map);
                        }}
                      >
                        <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>
                          {allToolsOpen ? "全部收起" : "全部展开"}
                        </Text>
                      </Pressable>
                    </View>
                  ) : null}

                  {toolCalls.map((tc, tIdx) => {
                    const isOpen = openTools[tIdx] ?? defaultToolOpen;
                    return (
                      <ToolCallItemRow
                        key={`${tIdx}-${tc.name}`}
                        tc={tc}
                        open={isOpen}
                        onToggle={() =>
                          setOpenTools((prev) => ({ ...prev, [tIdx]: !isOpen }))
                        }
                        theme={theme}
                      />
                    );
                  })}
                </View>
              ) : null}

              {detail.thinking ? (
                <View
                  style={{
                    backgroundColor: theme.colors.surface0,
                    borderColor: theme.colors.border,
                    borderWidth: 1,
                    borderRadius: 7,
                    padding: 8,
                    gap: 6,
                  }}
                >
                  <Pressable onPress={() => setThinkingOpen((v) => !v)}>
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
                      {thinkingOpen
                        ? `▾ 收起思考过程 (${detail.thinking.length} 字)`
                        : `▸ 展开思考过程 (${detail.thinking.length} 字)`}
                    </Text>
                  </Pressable>
                  {thinkingOpen ? (
                    <Text
                      selectable
                      style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 17 }}
                    >
                      {detail.thinking}
                    </Text>
                  ) : null}
                </View>
              ) : null}

              {!detail.content && toolCalls.length === 0 && !detail.thinking ? (
                <Text selectable style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 18 }}>
                  {step.summary || "该步骤无额外详情"}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function AgyConsolePanel(props: PluginAgentPanelProps) {
  const { theme } = props;
  const agentId = props.params?.agentId ?? props.agentId;
  const fetchConsole = useRpc(agyConsoleGet);
  const fetchChildTranscript = useRpc(agyChildTranscriptGet);
  const fetchChildStepDetail = useRpc(agyChildStepDetailGet);
  const sendSwarmMsg = useRpc(agySwarmSendMessage);

  const liveStatus = useSyncExternalStore(
    subscribeStatus,
    () => (agentId ? getStatusSnapshot(agentId) : null),
    () => null,
  );
  const navRequest = useSyncExternalStore(
    subscribeConsoleNav,
    () => (agentId ? getConsoleNavRequest(agentId) : null),
    () => null,
  );

  const [detail, setDetail] = useState<AgyConsoleDetail | null>(() =>
    agentId ? getConsoleDetailCache(agentId) : null,
  );
  const [loading, setLoading] = useState(() => !(agentId && getConsoleDetailCache(agentId)));
  const [tab, setTab] = useState<ConsoleTab>("overview");
  const [tabInitialized, setTabInitialized] = useState(false);

  // Official hive.js-style progressive disclosure states (completed/retired collapsed by default!)
  const [whoFilter, setWhoFilter] = useState<string | null>(null);
  const [doneTasksOpen, setDoneTasksOpen] = useState(false);
  const [doneThreadsOpen, setDoneThreadsOpen] = useState(false);
  const [expandedThreads, setExpandedThreads] = useState<Record<string, boolean>>({});
  const [retiredMembersOpen, setRetiredMembersOpen] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
  const [donePlanOpen, setDonePlanOpen] = useState(false);

  // Board tab controls (chronological chat order + pin-to-bottom by default, matching official AGY Swarm Board)
  const [boardFilter, setBoardFilter] = useState<string>("all");
  const [boardSearch, setBoardSearch] = useState("");
  const [boardNewestFirst, setBoardNewestFirst] = useState(false);
  const [composeTarget, setComposeTarget] = useState<string>("coordinator");
  const [composeText, setComposeText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendFeedback, setSendFeedback] = useState<string | null>(null);
  const [overviewCoordText, setOverviewCoordText] = useState("");
  const [overviewCoordSending, setOverviewCoordSending] = useState(false);
  const [overviewCoordFeedback, setOverviewCoordFeedback] = useState<string | null>(null);
  const boardScrollRef = useRef<ScrollView | null>(null);
  const boardPinnedRef = useRef(true);
  const [boardScrolledAway, setBoardScrolledAway] = useState(false);

  // Teamwork / subagent tree controls (default hides completed!)
  const [showCompletedTree, setShowCompletedTree] = useState(false);

  // Child transcript drill-down with persistent client cache + incremental delta updates
  const initialSelectedChild = useMemo(() => {
    const req = agentId ? getConsoleNavRequest(agentId) : null;
    return req && req.target.kind === "child" ? req.target.child : null;
  }, [agentId]);

  const initialChildCache = initialSelectedChild
    ? getChildTranscriptCache(initialSelectedChild.conversationId)
    : null;

  const [selectedChild, setSelectedChild] = useState<SelectedChild | null>(initialSelectedChild);
  const [childSteps, setChildSteps] = useState<TranscriptStep[]>(() => initialChildCache?.steps ?? []);
  const [childModel, setChildModel] = useState<string | null>(() => initialChildCache?.model ?? null);
  const [childTotal, setChildTotal] = useState<number>(() => initialChildCache?.totalSteps ?? 0);
  const [childLoadedOnce, setChildLoadedOnce] = useState<boolean>(
    () => Boolean(initialChildCache?.loadedOnce),
  );
  const [childFetchState, setChildFetchState] = useState<ChildFetchState>(() =>
    initialSelectedChild
      ? initialChildCache?.loadedOnce
        ? "syncing"
        : "loading"
      : "ready",
  );
  const [childNewestFirst, setChildNewestFirst] = useState(false);
  const [childReplyText, setChildReplyText] = useState("");
  const [childSending, setChildSending] = useState(false);
  const [childSendFeedback, setChildSendFeedback] = useState<string | null>(null);
  const childReqSeqRef = useRef(0);
  const childRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const childRetryCountRef = useRef(0);
  const childScrollRef = useRef<ScrollView | null>(null);
  const childPinnedRef = useRef(true);
  const [childScrolledAway, setChildScrolledAway] = useState(false);

  const selectChild = useCallback((next: SelectedChild) => {
    if (childRetryTimerRef.current) {
      clearTimeout(childRetryTimerRef.current);
      childRetryTimerRef.current = null;
    }
    childRetryCountRef.current = 0;
    childPinnedRef.current = true;
    setChildScrolledAway(false);
    const cached = getChildTranscriptCache(next.conversationId);
    setSelectedChild((prev) => {
      if (prev?.conversationId !== next.conversationId) {
        setChildSteps(cached?.steps ?? []);
        setChildModel(cached?.model ?? null);
        setChildTotal(cached?.totalSteps ?? 0);
        setChildLoadedOnce(Boolean(cached?.loadedOnce));
        setChildFetchState(cached?.loadedOnce ? "syncing" : "loading");
        setChildSendFeedback(null);
      }
      return next;
    });
  }, []);

  const handleChildScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    const nearBottom = contentOffset.y + layoutMeasurement.height >= contentSize.height - 64;
    childPinnedRef.current = nearBottom;
    setChildScrolledAway((prev) => (prev === !nearBottom ? prev : !nearBottom));
  }, []);

  const handleBoardScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    const nearBottom = contentOffset.y + layoutMeasurement.height >= contentSize.height - 64;
    boardPinnedRef.current = nearBottom;
    setBoardScrolledAway((prev) => (prev === !nearBottom ? prev : !nearBottom));
  }, []);

  const jumpChildToBottom = useCallback(() => {
    childPinnedRef.current = true;
    setChildScrolledAway(false);
    childScrollRef.current?.scrollToEnd({ animated: true });
  }, []);

  const jumpBoardToBottom = useCallback(() => {
    boardPinnedRef.current = true;
    setBoardScrolledAway(false);
    boardScrollRef.current?.scrollToEnd({ animated: true });
  }, []);

  useEffect(() => {
    if (tab === "board") {
      boardPinnedRef.current = true;
      setBoardScrolledAway(false);
    }
  }, [tab, boardFilter]);

  const [pendingLookup, setPendingLookup] = useState<
    Extract<ConsoleNavTarget, { kind: "member_by_name" | "subagent_by_ref" }> | null
  >(null);

  useEffect(() => {
    if (!agentId || !navRequest) return;
    consumeConsoleNavRequest(agentId, navRequest.seq);
    const { target } = navRequest;
    if (target.kind === "child") {
      setPendingLookup(null);
      selectChild(target.child);
    } else if (target.kind === "member_by_name") {
      const resolved = resolveMemberChildFromStatus(
        detail?.status ?? liveStatus,
        target.memberName,
      );
      if (resolved) {
        setPendingLookup(null);
        selectChild(resolved);
      } else {
        setPendingLookup(target);
      }
    } else if (target.kind === "subagent_by_ref") {
      const resolved = resolveSubagentChildFromStatus(detail?.status ?? liveStatus, target);
      if (resolved) {
        setPendingLookup(null);
        selectChild(resolved);
      } else {
        setPendingLookup(target);
      }
    } else if (target.kind === "board") {
      setPendingLookup(null);
      setSelectedChild(null);
      setTab("board");
      setTabInitialized(true);
      if (target.filter) {
        setBoardFilter(target.filter);
        setComposeTarget(target.filter);
      } else {
        setBoardFilter("all");
      }
    } else if (target.kind === "overview") {
      setPendingLookup(null);
      setSelectedChild(null);
      setTab("overview");
      setTabInitialized(true);
    }
  }, [agentId, navRequest, detail, liveStatus, selectChild]);

  useEffect(() => {
    if (!pendingLookup) return;
    const currentStatus = detail?.status ?? liveStatus;
    if (!currentStatus) return;
    if (pendingLookup.kind === "member_by_name") {
      const resolved = resolveMemberChildFromStatus(currentStatus, pendingLookup.memberName);
      if (resolved) {
        setPendingLookup(null);
        selectChild(resolved);
      } else if (!loading) {
        setPendingLookup(null);
        setSelectedChild(null);
        setTab("board");
        setTabInitialized(true);
        setBoardFilter(pendingLookup.memberName);
        setComposeTarget(pendingLookup.memberName);
      }
    } else if (pendingLookup.kind === "subagent_by_ref") {
      const resolved = resolveSubagentChildFromStatus(currentStatus, pendingLookup);
      if (resolved) {
        setPendingLookup(null);
        selectChild(resolved);
      } else if (!loading) {
        setPendingLookup(null);
        setSelectedChild(null);
        setTab("tree");
        setTabInitialized(true);
      }
    }
  }, [pendingLookup, detail, liveStatus, loading, selectChild]);

  const reloadConsole = useCallback(async () => {
    if (!agentId) return;
    try {
      const next = await fetchConsole({ agentId, boardLimit: 200 });
      if (next) {
        setConsoleDetailCache(agentId, next);
        upsertAgentStatus(agentId, next.status);
      }
      setDetail(next);
    } catch {
      // Keep previous snapshot on transient RPC failure.
    } finally {
      setLoading(false);
    }
  }, [agentId, fetchConsole]);

  const statusFingerprint = liveStatus
    ? `${liveStatus.swarm?.title ?? ""}:${liveStatus.swarm?.latestSeq ?? 0}:${liveStatus.swarm?.working ?? 0}:${liveStatus.swarm?.waiting ?? 0}:${liveStatus.swarm?.completed ?? 0}:${liveStatus.swarm?.members.length ?? 0}:${liveStatus.progress?.completed ?? 0}/${liveStatus.progress?.total ?? 0}:${liveStatus.plan?.completed ?? 0}/${liveStatus.plan?.total ?? 0}:${liveStatus.teamwork?.runningNodes ?? 0}/${liveStatus.teamwork?.completedNodes ?? 0}:${liveStatus.subagents.length}:${liveStatus.tasks.length}`
    : "none";

  useEffect(() => {
    void reloadConsole();
  }, [reloadConsole, statusFingerprint]);

  const status = detail?.status ?? liveStatus;
  const swarm = status?.swarm ?? null;
  const teamwork = status?.teamwork ?? null;
  const subagents = status?.subagents ?? [];
  const plan = status?.plan ?? null;
  const workflows = status?.workflows ?? [];
  const tasks = status?.tasks ?? [];
  const modes = status?.modes ?? [];
  const swarmPlan = detail?.swarmPlan ?? null;
  const boardPosts = detail?.boardPosts ?? [];

  useEffect(() => {
    if (tabInitialized || !status) return;
    setTabInitialized(true);
    if (status.primaryMode === "teamwork" && !status.swarm) {
      setTab("tree");
    } else {
      setTab("overview");
    }
  }, [status, tabInitialized]);

  const loadChild = useCallback(
    async (child: SelectedChild, options?: { full?: boolean }) => {
      if (!agentId) return;
      const reqSeq = ++childReqSeqRef.current;
      const cached = getChildTranscriptCache(child.conversationId);
      const useDelta = !options?.full && Boolean(cached?.loadedOnce);
      setChildFetchState(cached?.loadedOnce ? "syncing" : "loading");

      try {
        const res = await fetchChildTranscript({
          agentId,
          conversationId: child.conversationId,
          limit: 80,
          afterCursor: useDelta ? cached!.cursor : undefined,
        });
        if (reqSeq !== childReqSeqRef.current) return;

        if (res) {
          const merged = applyChildTranscriptResponse(res);
          childRetryCountRef.current = 0;
          setChildSteps(merged.steps);
          setChildModel(merged.model);
          setChildTotal(merged.totalSteps);
          setChildLoadedOnce(true);
          setChildFetchState("ready");
          return;
        }

        // Server returned null transiently (e.g. session lookup still warming up)
        if (cached?.loadedOnce) {
          setChildFetchState("ready");
        } else if (childRetryCountRef.current < 2) {
          childRetryCountRef.current += 1;
          setChildFetchState("loading");
          childRetryTimerRef.current = setTimeout(() => {
            if (reqSeq === childReqSeqRef.current) {
              void loadChild(child, { full: true });
            }
          }, 1_500);
        } else {
          setChildFetchState("error");
        }
      } catch {
        if (reqSeq !== childReqSeqRef.current) return;
        if (cached?.loadedOnce) {
          setChildFetchState("ready");
        } else if (childRetryCountRef.current < 2) {
          childRetryCountRef.current += 1;
          setChildFetchState("loading");
          childRetryTimerRef.current = setTimeout(() => {
            if (reqSeq === childReqSeqRef.current) {
              void loadChild(child, { full: true });
            }
          }, 1_500);
        } else {
          setChildFetchState("error");
        }
      }
    },
    [agentId, fetchChildTranscript],
  );

  const selectedChildState = useMemo(() => {
    if (!selectedChild) return { running: false, live: false };
    const matchedMember = (swarm?.members ?? []).find(
      (m) => m.conversationId === selectedChild.conversationId,
    );
    if (matchedMember) {
      const running = matchedMember.state === "working";
      const live = running || (matchedMember.state === "waiting" && !matchedMember.delivered);
      return { running, live };
    }
    const matchedTw = (teamwork?.nodes ?? []).find((n) => n.id === selectedChild.conversationId);
    if (matchedTw) {
      const running = matchedTw.state === "running";
      return { running, live: running };
    }
    const matchedSub = subagents.find((s) => s.id === selectedChild.conversationId);
    if (matchedSub) {
      const running = matchedSub.state === "running";
      return { running, live: running };
    }
    return { running: selectedChild.running, live: selectedChild.running };
  }, [selectedChild, swarm, teamwork, subagents]);

  const selectedChildRunning = selectedChildState.running;
  const selectedChildLive = selectedChildState.live;

  useEffect(() => {
    if (!selectedChild) return;
    void loadChild(selectedChild);
    if (!selectedChildLive) {
      return () => {
        if (childRetryTimerRef.current) {
          clearTimeout(childRetryTimerRef.current);
          childRetryTimerRef.current = null;
        }
      };
    }
    const timer = setInterval(() => {
      void loadChild(selectedChild);
    }, 3_000);
    return () => {
      clearInterval(timer);
      if (childRetryTimerRef.current) {
        clearTimeout(childRetryTimerRef.current);
        childRetryTimerRef.current = null;
      }
    };
  }, [selectedChild, selectedChildLive, loadChild]);

  // Partition Swarm members just like official hive.js (exclude role workers monitor/narrator from task team)
  const swarmPartitions = useMemo(() => {
    const all = (swarm?.members ?? []).filter((m) => !isRoleWorker(m.name));
    const live = all.filter((m) => !isMemberDoneOrRetired(m));
    const active = live.filter((m) => isMemberActive(m));
    const standby = live.filter((m) => !isMemberActive(m));
    const retired = all.filter((m) => isMemberDoneOrRetired(m));
    const finished = all.length > 0 && live.length === 0;
    return { all, live, active, standby, retired, finished };
  }, [swarm]);

  // Partition threads into open (active/waiting/failed) vs done (collapsed by default)
  const threadPartitions = useMemo(() => {
    if (!swarmPlan?.threads?.length) {
      return { open: [], done: [] };
    }
    const memberMap = new Map((swarm?.members ?? []).map((m) => [m.name, m]));
    const open: Array<{
      id: string;
      title: string;
      goal: string;
      members: SwarmMember[];
      doneCount: number;
      totalCount: number;
      hasIssue: boolean;
      hasActive: boolean;
    }> = [];
    const done: typeof open = [];

    for (const th of swarmPlan.threads) {
      const thMembers = th.tasks
        .map((n) => memberMap.get(n))
        .filter((m): m is SwarmMember => Boolean(m))
        .filter((m) => !whoFilter || m.name === whoFilter);
      if (whoFilter && thMembers.length === 0) continue;
      const doneCount = thMembers.filter((m) => isMemberDoneOrRetired(m)).length;
      const hasIssue = thMembers.some((m) => m.state === "failed");
      const hasActive = thMembers.some((m) => m.state === "working" || m.state === "waiting");
      const row = {
        id: th.id,
        title: th.title,
        goal: th.goal,
        members: thMembers,
        doneCount,
        totalCount: thMembers.length,
        hasIssue,
        hasActive,
      };
      if (thMembers.length > 0 && doneCount === thMembers.length && !hasIssue) {
        done.push(row);
      } else {
        open.push(row);
      }
    }
    open.sort((a, b) => Number(b.hasIssue) - Number(a.hasIssue) || Number(b.hasActive) - Number(a.hasActive));
    return { open, done };
  }, [swarmPlan, swarm, whoFilter]);

  const swarmPlanIsStale = useMemo(() => {
    if (!swarmPlan || swarmPartitions.live.length === 0) return false;
    const planNames = new Set<string>(Object.keys(swarmPlan.tasks ?? {}));
    for (const th of swarmPlan.threads ?? []) {
      for (const t of th.tasks ?? []) planNames.add(t);
    }
    if (planNames.size === 0) return false;
    return !swarmPartitions.live.some((m) => planNames.has(m.name));
  }, [swarmPlan, swarmPartitions.live]);

  const memberNames = useMemo(() => {
    const names = new Set<string>(["coordinator"]);
    for (const m of swarmPartitions.live) names.add(m.name);
    for (const m of swarmPartitions.retired) names.add(m.name);
    for (const p of boardPosts) names.add(p.agent);
    return [...names];
  }, [swarmPartitions, boardPosts]);

  const filteredPosts = useMemo(() => {
    const q = boardSearch.trim().toLowerCase();
    const base = boardPosts.filter((p) => {
      if (
        boardFilter !== "all" &&
        p.agent !== boardFilter &&
        !p.mentions.includes(boardFilter.toLowerCase())
      ) {
        return false;
      }
      if (q && !p.text.toLowerCase().includes(q) && !p.agent.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
    return boardNewestFirst ? [...base].reverse() : base;
  }, [boardPosts, boardFilter, boardSearch, boardNewestFirst]);

  const treePartitions = useMemo(() => {
    const all: Array<{ group: "teamwork" | "subagent"; node: SubagentItem }> = [];
    for (const n of teamwork?.nodes ?? []) all.push({ group: "teamwork", node: n });
    for (const s of subagents) all.push({ group: "subagent", node: s });
    const active = all.filter((x) => x.node.state === "running" || x.node.state === "failed");
    const completed = all.filter((x) => x.node.state !== "running" && x.node.state !== "failed");
    return { all, active, completed };
  }, [teamwork, subagents]);

  const coordinatorTarget = useMemo(
    () => resolveCoordinatorChildFromStatus(status ?? null),
    [status],
  );

  const openCoordinatorLog = () => {
    if (!coordinatorTarget) return;
    selectChild(coordinatorTarget);
  };

  const openMemberLog = (member: SwarmMember) => {
    if (!member.conversationId) return;
    selectChild({
      conversationId: member.conversationId,
      label: `@${member.name}`,
      subtitle: member.model,
      running: member.state === "working",
      workspace: member.workspace ?? null,
      memberName: member.name,
    });
  };

  const openSubagentLog = (node: SubagentItem) => {
    selectChild({
      conversationId: node.id,
      label: node.role,
      subtitle: `${node.typeName}${node.model ? ` · ${node.model}` : ""}`,
      running: node.state === "running",
      workspace: node.workspace ?? null,
    });
  };

  const handleSendToChildMember = async () => {
    const memberName = selectedChild?.memberName;
    const body = childReplyText.trim();
    if (!memberName || !body || childSending) return;
    setChildSending(true);
    setChildSendFeedback(null);
    try {
      const res = await sendSwarmMsg({
        agentId,
        text: body,
        targetMember: memberName,
      });
      if (res.ok) {
        setChildReplyText("");
        const suffix =
          res.method === "agentapi"
            ? "（未打断运行中的进程）"
            : res.method === "hook_inbox"
              ? "（非中断收件箱：协调者下次步骤/唤醒时自动注入，不打断 Swarm 成员）"
              : "";
        setChildSendFeedback(
          memberName === "coordinator"
            ? `✓ 已投递给 @coordinator${suffix}`
            : `✓ 已投递给 @coordinator 转达给 @${memberName}${suffix}`,
        );
      } else {
        setChildSendFeedback(`发送失败：${res.error ?? "未知错误"}`);
      }
    } catch (err) {
      setChildSendFeedback(`发送失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setChildSending(false);
    }
  };

  const handleSendOverviewCoordinator = async () => {
    const body = overviewCoordText.trim();
    if (!body || overviewCoordSending) return;
    setOverviewCoordSending(true);
    setOverviewCoordFeedback(null);
    try {
      const res = await sendSwarmMsg({
        agentId,
        text: body,
        targetMember: "coordinator",
      });
      if (res.ok) {
        setOverviewCoordText("");
        setOverviewCoordFeedback(
          res.method === "agentapi"
            ? "✓ 已直达 @coordinator（未打断运行中的 Swarm 成员）"
            : res.method === "hook_inbox"
              ? "✓ 已投递到 @coordinator 非中断收件箱（协调者下次步骤/唤醒时自动注入，不打断 Swarm 成员）"
              : "✓ 已发送给 @coordinator",
        );
      } else {
        setOverviewCoordFeedback(`发送失败：${res.error ?? "未知错误"}`);
      }
    } catch (err) {
      setOverviewCoordFeedback(`发送失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setOverviewCoordSending(false);
    }
  };

  const handleSendDirective = async () => {
    const body = composeText.trim();
    if (!body || sending) return;
    setSending(true);
    setSendFeedback(null);
    try {
      const res = await sendSwarmMsg({
        agentId,
        text: body,
        targetMember: composeTarget,
      });
      if (res.ok) {
        setComposeText("");
        const suffix =
          res.method === "agentapi"
            ? "（未打断运行中的进程）"
            : res.method === "hook_inbox"
              ? "（非中断收件箱：协调者下次步骤/唤醒时自动注入，不打断 Swarm 成员）"
              : "";
        setSendFeedback(
          composeTarget === "coordinator"
            ? `✓ 已投递给 @coordinator${suffix}`
            : `✓ 已投递给 @coordinator 转达给 @${composeTarget}${suffix}`,
        );
      } else {
        setSendFeedback(`发送失败：${res.error ?? "未知错误"}`);
      }
    } catch (err) {
      setSendFeedback(`发送失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  };

  // Child conversation / live transcript view (rendered immediately even before agyConsoleGet settles)
  if (selectedChild) {
    const orderedSteps = childNewestFirst ? [...childSteps].reverse() : childSteps;
    const quickSwitchMembers = swarmPartitions.live.filter((m) => Boolean(m.conversationId));

    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        <View
          style={{
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            gap: 6,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <Pressable onPress={() => setSelectedChild(null)}>
              <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
                ← 返回控制台
              </Text>
            </Pressable>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {selectedChild.memberName ? (
                <Chip
                  label={`消息板 (@${selectedChild.memberName})`}
                  color={theme.colors.accent}
                  theme={theme}
                  onPress={() => {
                    const name = selectedChild.memberName!;
                    setSelectedChild(null);
                    setTab("board");
                    setTabInitialized(true);
                    setBoardFilter(name);
                    setComposeTarget(name);
                  }}
                />
              ) : null}
              <Chip
                label={childNewestFirst ? "倒序 ⇅" : "正序 ⇅"}
                color={theme.colors.foregroundMuted}
                theme={theme}
                onPress={() => {
                  setChildNewestFirst((v) => {
                    const next = !v;
                    if (!next) {
                      childPinnedRef.current = true;
                      setChildScrolledAway(false);
                    }
                    return next;
                  });
                }}
              />
              {!childNewestFirst && childScrolledAway ? (
                <Chip
                  label="回到底部 ↓"
                  color={theme.colors.accent}
                  theme={theme}
                  onPress={jumpChildToBottom}
                />
              ) : null}
              {childFetchState === "loading" ? (
                <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>
                  加载中…
                </Text>
              ) : childFetchState === "syncing" ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                  增量同步中…
                </Text>
              ) : selectedChildRunning ? (
                <Text style={{ color: theme.colors.statusSuccess, fontSize: 11, fontWeight: "600" }}>
                  ● 实时增量 (3s)
                </Text>
              ) : selectedChildLive ? (
                <Text style={{ color: theme.colors.statusWarning, fontSize: 11, fontWeight: "600" }}>
                  ● 待命监听 (3s)
                </Text>
              ) : childLoadedOnce ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>已缓存</Text>
              ) : null}
              <Pressable onPress={() => void loadChild(selectedChild)}>
                <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>刷新</Text>
              </Pressable>
            </View>
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "700" }}>
              {selectedChild.label}
            </Text>
            <Text
              style={{
                color: selectedChildRunning ? theme.colors.accent : theme.colors.foregroundMuted,
                fontSize: 11,
                fontWeight: "600",
              }}
            >
              {selectedChildRunning ? "运行中" : "已静默"}
            </Text>
          </View>

          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            {[
              selectedChild.subtitle,
              childModel && !selectedChild.subtitle?.includes(childModel) ? childModel : null,
              childTotal > 0 ? `共 ${childTotal} 步（显示最近 ${childSteps.length} 步）` : null,
              selectedChild.workspace ? shortWorkspace(selectedChild.workspace) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>

          {coordinatorTarget || quickSwitchMembers.length > 0 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingTop: 2 }}>
              {coordinatorTarget ? (
                <Chip
                  label="@coordinator"
                  color={theme.colors.accent}
                  active={selectedChild.conversationId === coordinatorTarget.conversationId}
                  theme={theme}
                  onPress={openCoordinatorLog}
                />
              ) : null}
              {quickSwitchMembers.map((m) => (
                <Chip
                  key={m.name}
                  label={`@${m.name}`}
                  color={m.state === "working" ? theme.colors.accent : theme.colors.statusWarning}
                  active={selectedChild.conversationId === m.conversationId}
                  theme={theme}
                  onPress={() => openMemberLog(m)}
                />
              ))}
            </View>
          ) : null}
        </View>

        <ScrollView
          ref={childScrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 12, gap: 8 }}
          scrollEventThrottle={100}
          onScroll={handleChildScroll}
          onContentSizeChange={() => {
            if (!childNewestFirst && childPinnedRef.current) {
              childScrollRef.current?.scrollToEnd({ animated: false });
            }
          }}
        >
          {!childLoadedOnce && childSteps.length === 0 && childFetchState !== "error" ? (
            <View
              style={{
                backgroundColor: theme.colors.surface1,
                borderColor: theme.colors.border,
                borderWidth: 1,
                borderRadius: 9,
                padding: 14,
                gap: 4,
              }}
            >
              <Text style={{ color: theme.colors.accent, fontSize: 13, fontWeight: "600" }}>
                正在加载 {selectedChild.label} 的对话与执行日志…
              </Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                首次读取后会自动缓存，后续切换与刷新仅拉取增量步骤。
              </Text>
            </View>
          ) : childFetchState === "error" && childSteps.length === 0 ? (
            <View
              style={{
                backgroundColor: theme.colors.surface1,
                borderColor: theme.colors.border,
                borderWidth: 1,
                borderRadius: 9,
                padding: 14,
                gap: 8,
              }}
            >
              <Text style={{ color: theme.colors.statusWarning, fontSize: 12, fontWeight: "600" }}>
                暂时未能读取到 {selectedChild.label} 的对话日志
              </Text>
              <Pressable
                onPress={() => {
                  childRetryCountRef.current = 0;
                  void loadChild(selectedChild, { full: true });
                }}
              >
                <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
                  点击重新加载 →
                </Text>
              </Pressable>
            </View>
          ) : orderedSteps.length === 0 ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {selectedChildLive
                ? `${selectedChild.label} 已启动，正在等待首条对话与步骤写入（每 3s 自动增量检查）…`
                : "暂无对话与步骤记录"}
            </Text>
          ) : (
            orderedSteps.map((step, idx) => (
              <ChildStepRow
                key={`${selectedChild.conversationId}-${step.stepIndex}-${step.kind}-${idx}`}
                agentId={agentId}
                conversationId={selectedChild.conversationId}
                step={step}
                theme={theme}
                fetchStepDetail={fetchChildStepDetail}
              />
            ))
          )}
        </ScrollView>

        {selectedChild.memberName ? (
          <View
            style={{
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderTopWidth: 1,
              borderTopColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
              gap: 6,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <TextInput
                value={childReplyText}
                onChangeText={setChildReplyText}
                placeholder={
                  selectedChild.memberName === "coordinator"
                    ? "给 @coordinator 发消息（直达协调者，不打断运行中的进程）…"
                    : `给 @${selectedChild.memberName} 发指令（经协调者转达，不打断运行中的进程）…`
                }
                placeholderTextColor={theme.colors.foregroundMuted}
                onSubmitEditing={() => void handleSendToChildMember()}
                style={{
                  flex: 1,
                  backgroundColor: theme.colors.surface0,
                  borderColor: theme.colors.border,
                  borderWidth: 1,
                  borderRadius: 7,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  color: theme.colors.foreground,
                  fontSize: 12,
                }}
              />
              <Pressable
                disabled={childSending || !childReplyText.trim()}
                onPress={() => void handleSendToChildMember()}
                style={{
                  backgroundColor:
                    childSending || !childReplyText.trim()
                      ? theme.colors.surface2
                      : theme.colors.accent,
                  borderRadius: 7,
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                }}
              >
                <Text
                  style={{
                    color:
                      childSending || !childReplyText.trim()
                        ? theme.colors.foregroundMuted
                        : theme.colors.accentForeground,
                    fontSize: 12,
                    fontWeight: "600",
                  }}
                >
                  {childSending ? "发送中" : "发送"}
                </Text>
              </Pressable>
            </View>
            {childSendFeedback ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                {childSendFeedback}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  }

  if (loading && !status) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.surface0,
          alignItems: "center",
          justifyContent: "center",
          padding: 20,
        }}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
          正在读取 Antigravity 会话状态…
        </Text>
      </View>
    );
  }

  if (!status) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.surface0,
          alignItems: "center",
          justifyContent: "center",
          padding: 20,
          gap: 8,
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>
          暂无 Antigravity 编排数据
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, textAlign: "center" }}>
          当前会话尚未产生 Swarm、Teamwork、Boost、/goal、Plan 或子代理记录。
        </Text>
      </View>
    );
  }

  const runningForWho = swarmPartitions.active.filter((m) => !whoFilter || m.name === whoFilter);
  const doneForWho = swarmPartitions.retired.filter((m) => !whoFilter || m.name === whoFilter);
  const totalTasks = swarmPartitions.all.length;
  const doneTasksCount = swarmPartitions.retired.length;

  const memberSearchQ = memberSearch.trim().toLowerCase();
  const matchMember = (m: SwarmMember) =>
    !memberSearchQ ||
    m.name.toLowerCase().includes(memberSearchQ) ||
    (m.model ?? "").toLowerCase().includes(memberSearchQ) ||
    (m.lastActivity ?? "").toLowerCase().includes(memberSearchQ);

  const visibleActiveMembers = swarmPartitions.active.filter(matchMember);
  const visibleStandbyMembers = swarmPartitions.standby.filter(matchMember);
  const visibleRetiredMembers = swarmPartitions.retired.filter(matchMember);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      {/* Header matching official Swarm Board chrome */}
      <View
        style={{
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          gap: 8,
        }}
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "700", flexShrink: 1 }} numberOfLines={1}>
            {swarm?.title ?? (teamwork ? "Teamwork 控制台" : "Antigravity 控制台")}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            {status.backgroundActive ? (
              <Text style={{ color: theme.colors.statusSuccess, fontSize: 11, fontWeight: "600" }}>
                ● Live
              </Text>
            ) : (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>已静默</Text>
            )}
            <Pressable onPress={() => void reloadConsole()}>
              <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>刷新</Text>
            </Pressable>
          </View>
        </View>

        {/* Active mode pills */}
        {modes.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {modes.map((m) => (
              <Chip
                key={m}
                label={MODE_LABELS[m]}
                color={
                  m === "swarm" || m === "teamwork" || m === "goal"
                    ? theme.colors.accent
                    : m === "boost"
                      ? theme.colors.statusWarning
                      : theme.colors.foregroundMuted
                }
                theme={theme}
              />
            ))}
          </View>
        ) : null}

        {/* Official tabs: Overview / Board / Members + Tree (for Teamwork & Subagents) */}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <Chip
            label="总览"
            color={theme.colors.foreground}
            theme={theme}
            active={tab === "overview"}
            onPress={() => setTab("overview")}
          />
          {swarm ? (
            <Chip
              label={`消息板 (${detail?.boardTotal ?? swarm.boardCount ?? 0})`}
              color={theme.colors.foreground}
              theme={theme}
              active={tab === "board"}
              onPress={() => setTab("board")}
            />
          ) : null}
          {swarm ? (
            <Chip
              label={
                swarmPartitions.live.length > 0
                  ? `成员 (${swarmPartitions.live.length})`
                  : `成员 (0 活跃)`
              }
              color={theme.colors.foreground}
              theme={theme}
              active={tab === "members"}
              onPress={() => setTab("members")}
            />
          ) : null}
          {teamwork || subagents.length > 0 ? (
            <Chip
              label={
                treePartitions.active.length > 0
                  ? `层级树 (${treePartitions.active.length} 活跃)`
                  : `层级树 (${treePartitions.all.length})`
              }
              color={theme.colors.foreground}
              theme={theme}
              active={tab === "tree"}
              onPress={() => setTab("tree")}
            />
          ) : null}
        </View>
      </View>

      {/* TAB 1: OVERVIEW (Progress meter -> Task checklist at top -> Goal -> Running -> Collapsed Progress -> Open Threads -> Collapsed Done Threads -> Live Team) */}
      {tab === "overview" ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 10 }}>
          {/* 0. Real-time percentage progress bar + elapsed + ETA */}
          {status.progress ? <ProgressMeter progress={status.progress} theme={theme} /> : null}

          {/* 0.25 Coordinator card pinned at the top of Overview home for 1-click chat & non-interrupting messaging */}
          {coordinatorTarget ? (
            <View
              style={{
                backgroundColor: theme.colors.surface1,
                borderColor: theme.colors.accent,
                borderWidth: 1,
                borderRadius: 10,
                padding: 11,
                gap: 8,
              }}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <Pressable onPress={openCoordinatorLog} style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "700" }}>
                      @coordinator
                    </Text>
                    <View
                      style={{
                        backgroundColor: theme.colors.surface2,
                        borderColor: theme.colors.border,
                        borderWidth: 1,
                        borderRadius: 4,
                        paddingHorizontal: 5,
                        paddingVertical: 1,
                      }}
                    >
                      <Text style={{ color: theme.colors.accent, fontSize: 10, fontWeight: "700" }}>
                        协调者
                      </Text>
                    </View>
                    <Text
                      style={{
                        color:
                          status.coordinatorState === "wakeup_running" ||
                          status.coordinatorState === "background_hold"
                            ? theme.colors.accent
                            : status.coordinatorState === "swarm_wait"
                              ? theme.colors.statusWarning
                              : status.coordinatorState === "idle"
                                ? theme.colors.statusSuccess
                                : theme.colors.foregroundMuted,
                        fontSize: 11,
                        fontWeight: "600",
                      }}
                    >
                      {status.coordinatorState === "wakeup_running"
                        ? "运行中"
                        : status.coordinatorState === "swarm_wait"
                          ? "等待唤醒"
                          : status.coordinatorState === "background_hold"
                            ? "后台协调中"
                            : status.coordinatorState === "stopped"
                              ? "已停止"
                              : "空闲"}
                    </Text>
                    {status.coordinator?.stepCount ? (
                      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                        · {status.coordinator.stepCount} 步
                      </Text>
                    ) : null}
                  </View>
                  {status.coordinator?.lastActivity ? (
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                      {status.coordinator.lastActivity}
                    </Text>
                  ) : null}
                </Pressable>
                <Chip
                  label="查看对话 →"
                  color={theme.colors.accent}
                  theme={theme}
                  onPress={openCoordinatorLog}
                />
              </View>

              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <TextInput
                  value={overviewCoordText}
                  onChangeText={setOverviewCoordText}
                  placeholder="给 @coordinator 发消息（直达协调者，不打断运行中的 Swarm 成员）…"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  onSubmitEditing={() => void handleSendOverviewCoordinator()}
                  style={{
                    flex: 1,
                    backgroundColor: theme.colors.surface0,
                    borderColor: theme.colors.border,
                    borderWidth: 1,
                    borderRadius: 7,
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    color: theme.colors.foreground,
                    fontSize: 12,
                  }}
                />
                <Pressable
                  disabled={overviewCoordSending || !overviewCoordText.trim()}
                  onPress={() => void handleSendOverviewCoordinator()}
                  style={{
                    backgroundColor:
                      overviewCoordSending || !overviewCoordText.trim()
                        ? theme.colors.surface2
                        : theme.colors.accent,
                    borderRadius: 7,
                    paddingHorizontal: 12,
                    paddingVertical: 7,
                  }}
                >
                  <Text
                    style={{
                      color:
                        overviewCoordSending || !overviewCoordText.trim()
                          ? theme.colors.foregroundMuted
                          : theme.colors.accentForeground,
                      fontSize: 12,
                      fontWeight: "600",
                    }}
                  >
                    {overviewCoordSending ? "发送中" : "发送"}
                  </Text>
                </Pressable>
              </View>
              {overviewCoordFeedback ? (
                <Text
                  style={{
                    color: overviewCoordFeedback.startsWith("✓")
                      ? theme.colors.statusSuccess
                      : theme.colors.statusWarning,
                    fontSize: 11,
                  }}
                >
                  {overviewCoordFeedback}
                </Text>
              ) : null}
            </View>
          ) : null}

          {/* 0.5 Task checklist pinned right at the top */}
          {plan ? (
            plan.inPlanMode || plan.completed < plan.total ? (
              <SectionCard
                title={plan.inPlanMode ? "任务清单（规划中）" : "任务清单"}
                right={
                  plan.total > 0
                    ? `${plan.completed}/${plan.total} (${Math.round((plan.completed / plan.total) * 100)}%)`
                    : undefined
                }
                theme={theme}
              >
                {plan.steps
                  .filter((s) => s.status !== "done" && s.status !== "skipped")
                  .map((s, idx) => (
                    <View key={`${idx}-${s.title}`} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text
                        style={{
                          color:
                            s.status === "in_progress"
                              ? theme.colors.accent
                              : s.status === "failed"
                                ? theme.colors.statusDanger
                                : theme.colors.foregroundMuted,
                          fontSize: 12,
                          width: 14,
                        }}
                      >
                        {s.status === "in_progress" ? "◐" : s.status === "failed" ? "✕" : "○"}
                      </Text>
                      <Text style={{ color: theme.colors.foreground, fontSize: 12, flex: 1 }}>
                        {s.title}
                      </Text>
                    </View>
                  ))}
                {plan.completed > 0 ? (
                  <Pressable onPress={() => setDonePlanOpen((v) => !v)}>
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                      {donePlanOpen ? "▾ 收起已完成步骤" : `▸ 已隐藏 ${plan.completed} 个已完成步骤`}
                    </Text>
                  </Pressable>
                ) : null}
                {donePlanOpen
                  ? plan.steps
                      .filter((s) => s.status === "done" || s.status === "skipped")
                      .map((s, idx) => (
                        <Text key={`d-${idx}-${s.title}`} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                          ✓ {s.title}
                        </Text>
                      ))
                  : null}
              </SectionCard>
            ) : (
              <DisclosureBar
                title={`✓ 任务清单已全部完成 (${plan.completed}/${plan.total} · 100%)`}
                count="已折叠"
                accentColor={theme.colors.statusSuccess}
                open={donePlanOpen}
                theme={theme}
                onToggle={() => setDonePlanOpen((v) => !v)}
              >
                {plan.steps.map((s, idx) => (
                  <Text key={`${idx}-${s.title}`} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                    ✓ {s.title}
                  </Text>
                ))}
              </DisclosureBar>
            )
          ) : null}

          {/* 1. Goal card (compact 2 lines; hidden if plan.json is stale from a previous wave) */}
          {swarmPlan?.goal && !swarmPlanIsStale ? (
            <View
              style={{
                backgroundColor: theme.colors.surface1,
                borderColor: theme.colors.border,
                borderWidth: 1,
                borderRadius: 10,
                padding: 12,
                gap: 3,
              }}
            >
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "700" }}>
                GOAL
              </Text>
              <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "700" }}>
                {swarmPlan.goal.title}
              </Text>
              {swarmPlan.goal.line ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                  {swarmPlan.goal.line}
                </Text>
              ) : null}
            </View>
          ) : null}

          {/* 2. Running now (hidden when nothing is running or swarm is finished, matching hive.js!) */}
          {swarm && !swarmPartitions.finished && runningForWho.length > 0 ? (
            <SectionCard
              title="进行中"
              right={`${runningForWho.length} 个成员运行中`}
              theme={theme}
            >
              {runningForWho.map((m) => (
                <MemberRow
                  key={m.name + m.conversationId}
                  member={m}
                  taskDesc={swarmPlan?.tasks[m.name]}
                  theme={theme}
                  onOpen={() => openMemberLog(m)}
                />
              ))}
            </SectionCard>
          ) : null}

          {/* 3. Progress disclosure bar (all completed/retired tasks collapsed by default!) */}
          {swarm && totalTasks > 0 ? (
            <DisclosureBar
              title={
                swarmPartitions.finished
                  ? `✓ ${doneTasksCount} / ${totalTasks} 项任务已全部完成`
                  : `${doneTasksCount} / ${totalTasks} 项任务已完成`
              }
              count={
                swarmPartitions.live.length > 0
                  ? `${swarmPartitions.active.length} 运行 · ${swarmPartitions.standby.length} 待命`
                  : "已归档"
              }
              accentColor={
                swarmPartitions.finished ? theme.colors.statusSuccess : theme.colors.accent
              }
              open={doneTasksOpen}
              theme={theme}
              onToggle={() => setDoneTasksOpen((v) => !v)}
            >
              {doneForWho.length === 0 ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                  暂无已完成的任务。
                </Text>
              ) : (
                doneForWho.map((m) => (
                  <MemberRow
                    key={m.name + m.conversationId}
                    member={m}
                    taskDesc={swarmPlan?.tasks[m.name]}
                    theme={theme}
                    onOpen={() => openMemberLog(m)}
                  />
                ))
              )}
            </DisclosureBar>
          ) : null}

          {/* 4. Open Threads (only active/issue threads shown prominently; hidden when plan.json is stale) */}
          {!swarmPlanIsStale && threadPartitions.open.length > 0 ? (
            <View style={{ gap: 8 }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "700" }}>
                进行中线程（{threadPartitions.open.length}）
              </Text>
              {threadPartitions.open.map((th) => {
                const isOpen = expandedThreads[th.id] ?? (th.hasIssue || th.hasActive);
                return (
                  <DisclosureBar
                    key={th.id}
                    title={th.title}
                    count={`${th.doneCount}/${th.totalCount}`}
                    accentColor={th.hasIssue ? theme.colors.statusDanger : theme.colors.accent}
                    open={isOpen}
                    theme={theme}
                    onToggle={() =>
                      setExpandedThreads((prev) => ({ ...prev, [th.id]: !isOpen }))
                    }
                  >
                    {th.goal ? (
                      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                        {th.goal}
                      </Text>
                    ) : null}
                    {th.members.map((m) => (
                      <MemberRow
                        key={m.name + m.conversationId}
                        member={m}
                        taskDesc={swarmPlan?.tasks[m.name]}
                        theme={theme}
                        onOpen={() => openMemberLog(m)}
                      />
                    ))}
                  </DisclosureBar>
                );
              })}
            </View>
          ) : null}

          {/* 5. Completed Threads (collapsed by default; hidden when plan.json is stale) */}
          {!swarmPlanIsStale && threadPartitions.done.length > 0 ? (
            <DisclosureBar
              title={`已完成线程（已折叠，点击查看）`}
              count={`${threadPartitions.done.length} 个`}
              accentColor={theme.colors.statusSuccess}
              open={doneThreadsOpen}
              theme={theme}
              onToggle={() => setDoneThreadsOpen((v) => !v)}
            >
              {threadPartitions.done.map((th) => (
                <View
                  key={th.id}
                  style={{
                    borderColor: theme.colors.border,
                    borderWidth: 1,
                    borderRadius: 7,
                    padding: 8,
                    gap: 4,
                  }}
                >
                  <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                    <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600", flex: 1 }}>
                      ✓ {th.title}
                    </Text>
                    <Text style={{ color: theme.colors.statusSuccess, fontSize: 11 }}>
                      {th.doneCount}/{th.totalCount}
                    </Text>
                  </View>
                  {th.members.map((m) => (
                    <Pressable
                      key={m.name + m.conversationId}
                      onPress={() => openMemberLog(m)}
                      style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 }}
                    >
                      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                        @{m.name} · {swarmPlan?.tasks[m.name] ?? "查看日志"}
                      </Text>
                      <Text style={{ color: theme.colors.accent, fontSize: 10 }}>日志 →</Text>
                    </Pressable>
                  ))}
                </View>
              ))}
            </DisclosureBar>
          ) : null}

          {/* 6. Live Team quick-filter strip (official hive.js hides killed members here!) */}
          {swarm && swarmPartitions.live.length > 0 ? (
            <SectionCard
              title="在线团队"
              right={`${swarmPartitions.live.length} 人在线（按成员筛选）`}
              theme={theme}
            >
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                <Chip
                  label="全部"
                  color={theme.colors.foreground}
                  theme={theme}
                  active={whoFilter === null}
                  onPress={() => setWhoFilter(null)}
                />
                {swarmPartitions.live.map((m) => (
                  <Chip
                    key={m.name}
                    label={`@${m.name}`}
                    color={m.state === "working" ? theme.colors.accent : theme.colors.statusWarning}
                    theme={theme}
                    active={whoFilter === m.name}
                    onPress={() => setWhoFilter((prev) => (prev === m.name ? null : m.name))}
                  />
                ))}
              </View>
            </SectionCard>
          ) : null}

          {/* Teamwork summary (active nodes prominent; finished collapsed) */}
          {teamwork ? (
            teamwork.active || teamwork.failedNodes > 0 ? (
              <SectionCard
                title="Teamwork 流水线"
                right={`运行 ${teamwork.runningNodes} · 完成 ${teamwork.completedNodes}/${teamwork.totalNodes}`}
                theme={theme}
              >
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {TEAMWORK_PHASES.map((p) => (
                    <Chip
                      key={p.key}
                      label={p.label}
                      color={teamwork.phase === p.key ? theme.colors.accent : theme.colors.foregroundMuted}
                      theme={theme}
                      active={teamwork.phase === p.key}
                    />
                  ))}
                </View>
                {teamwork.nodes
                  .filter((n) => n.state === "running" || n.state === "failed")
                  .slice(0, 6)
                  .map((node) => {
                    const cat = categoryMeta(node.category, theme);
                    const meta = stateMeta(node.state, theme);
                    return (
                      <Pressable
                        key={node.id}
                        onPress={() => openSubagentLog(node)}
                        style={{
                          backgroundColor: theme.colors.surface2,
                          borderRadius: 6,
                          padding: 8,
                          gap: 2,
                        }}
                      >
                        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600", flex: 1 }} numberOfLines={1}>
                            [{cat.label}] {node.role}
                          </Text>
                          <Text style={{ color: meta.color, fontSize: 11, fontWeight: "600" }}>{meta.label}</Text>
                        </View>
                        {node.lastActivity ? (
                          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                            {node.lastActivity}
                          </Text>
                        ) : null}
                      </Pressable>
                    );
                  })}
                <Pressable onPress={() => setTab("tree")}>
                  <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
                    查看 Teamwork 层级树 →
                  </Text>
                </Pressable>
              </SectionCard>
            ) : (
              <DisclosureBar
                title={`✓ Teamwork 已完成（共 ${teamwork.totalNodes} 节点）`}
                count="点击切换层级树"
                accentColor={theme.colors.statusSuccess}
                open={false}
                theme={theme}
                onToggle={() => {
                  setShowCompletedTree(true);
                  setTab("tree");
                }}
              >
                <View />
              </DisclosureBar>
            )
          ) : null}

          {/* /goal active card */}
          {status.goalActive ? (
            <SectionCard title="/goal 目标循环" right="Stop Hook 保活中" theme={theme}>
              <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
                {status.goalSummary ?? "目标循环已激活，完成全部验收条件前不会提前停工。"}
              </Text>
            </SectionCard>
          ) : null}

          {/* Running workflows & background tasks only */}
          {workflows.some((w) => w.status === "running" || w.status === "failed") ? (
            <SectionCard title="Python Workflow 编排" theme={theme}>
              {workflows
                .filter((w) => w.status === "running" || w.status === "failed")
                .map((wf) => {
                  const meta = stateMeta(wf.status, theme);
                  return (
                    <View key={wf.id} style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                      <Text style={{ color: theme.colors.foreground, fontSize: 12, flex: 1 }} numberOfLines={1}>
                        {wf.description}
                      </Text>
                      <Text style={{ color: meta.color, fontSize: 11, fontWeight: "600" }}>{meta.label}</Text>
                    </View>
                  );
                })}
            </SectionCard>
          ) : null}

          {tasks.length > 0 ? (
            <SectionCard title="后台命令与定时器" right={`${tasks.length} 运行中`} theme={theme}>
              {tasks.map((t) => (
                <View key={t.id} style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 12, flex: 1 }} numberOfLines={1}>
                    [{t.kind}] {t.summary}
                  </Text>
                  <Text style={{ color: theme.colors.accent, fontSize: 11 }}>运行中</Text>
                </View>
              ))}
            </SectionCard>
          ) : null}
        </ScrollView>
      ) : tab === "members" ? (
        /* TAB 2: MEMBERS (Official hive.js membersView: Search -> Active -> Standing by -> Retired collapsed!) */
        <View style={{ flex: 1 }}>
          <View
            style={{
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.border,
            }}
          >
            <TextInput
              value={memberSearch}
              onChangeText={setMemberSearch}
              placeholder="搜索成员名 / 模型 / 最新动作…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                color: theme.colors.foreground,
                backgroundColor: theme.colors.surface2,
                borderColor: theme.colors.border,
                borderWidth: 1,
                borderRadius: 7,
                paddingHorizontal: 10,
                paddingVertical: 6,
                fontSize: 12,
              }}
            />
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 10 }}>
            {coordinatorTarget ? (
              <SectionCard title="协调者 (Coordinator)" right="点击查看对话 / 发消息" theme={theme}>
                <Pressable
                  onPress={openCoordinatorLog}
                  style={{
                    backgroundColor: theme.colors.surface2,
                    borderColor: theme.colors.accent,
                    borderWidth: 1,
                    borderRadius: 8,
                    padding: 10,
                    gap: 4,
                  }}
                >
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "700" }}>
                      @coordinator（协调者）
                    </Text>
                    <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>
                      对话 / 发消息 ›
                    </Text>
                  </View>
                  {status.coordinator?.lastActivity ? (
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={2}>
                      {status.coordinator.lastActivity}
                    </Text>
                  ) : null}
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                    {[status.coordinator?.model, status.coordinator?.stepCount ? `${status.coordinator.stepCount} 步` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </Pressable>
              </SectionCard>
            ) : null}

            {visibleActiveMembers.length > 0 ? (
              <SectionCard title="活跃中 (Active)" right={`${visibleActiveMembers.length}`} theme={theme}>
                {visibleActiveMembers.map((m) => (
                  <MemberRow
                    key={m.name + m.conversationId}
                    member={m}
                    taskDesc={swarmPlan?.tasks[m.name]}
                    theme={theme}
                    onOpen={() => openMemberLog(m)}
                  />
                ))}
              </SectionCard>
            ) : null}

            {visibleStandbyMembers.length > 0 ? (
              <SectionCard title="待命中 (Standing by)" right={`${visibleStandbyMembers.length}`} theme={theme}>
                {visibleStandbyMembers.map((m) => (
                  <MemberRow
                    key={m.name + m.conversationId}
                    member={m}
                    taskDesc={swarmPlan?.tasks[m.name]}
                    theme={theme}
                    onOpen={() => openMemberLog(m)}
                  />
                ))}
              </SectionCard>
            ) : null}

            {visibleActiveMembers.length === 0 && visibleStandbyMembers.length === 0 ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                当前没有活跃或待命的 Swarm 成员。
              </Text>
            ) : null}

            {/* Official hive.js Retired collapsible drawer (collapsed by default!) */}
            {visibleRetiredMembers.length > 0 ? (
              <DisclosureBar
                title="已归档 / 已结束 (Retired)"
                count={`${visibleRetiredMembers.length}`}
                open={retiredMembersOpen || memberSearchQ.length > 0}
                theme={theme}
                onToggle={() => setRetiredMembersOpen((v) => !v)}
              >
                {visibleRetiredMembers.map((m) => (
                  <MemberRow
                    key={m.name + m.conversationId}
                    member={m}
                    taskDesc={swarmPlan?.tasks[m.name]}
                    theme={theme}
                    onOpen={() => openMemberLog(m)}
                  />
                ))}
              </DisclosureBar>
            ) : null}
          </ScrollView>
        </View>
      ) : tab === "board" ? (
        /* TAB 3: BOARD (Official search + poster/@mention filter + safe coordinator composer) */
        <View style={{ flex: 1 }}>
          <View
            style={{
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.border,
              gap: 6,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <TextInput
                value={boardSearch}
                onChangeText={setBoardSearch}
                placeholder="搜索帖子正文或发帖人…"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{
                  flex: 1,
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface2,
                  borderColor: theme.colors.border,
                  borderWidth: 1,
                  borderRadius: 7,
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                  fontSize: 12,
                }}
              />
              <Pressable
                onPress={() => {
                  setBoardNewestFirst((v) => {
                    const next = !v;
                    if (!next) {
                      boardPinnedRef.current = true;
                      setBoardScrolledAway(false);
                    }
                    return next;
                  });
                }}
              >
                <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>
                  {boardNewestFirst ? "倒序 ⇅" : "正序 ⇅"}
                </Text>
              </Pressable>
              {!boardNewestFirst && boardScrolledAway ? (
                <Pressable onPress={jumpBoardToBottom}>
                  <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>
                    到底 ↓
                  </Text>
                </Pressable>
              ) : null}
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: "row", gap: 6 }}>
                <Chip
                  label={`全部 (${filteredPosts.length})`}
                  color={theme.colors.foreground}
                  theme={theme}
                  active={boardFilter === "all"}
                  onPress={() => setBoardFilter("all")}
                />
                {memberNames.map((name) => (
                  <Chip
                    key={name}
                    label={`@${name}`}
                    color={theme.colors.foreground}
                    theme={theme}
                    active={boardFilter === name}
                    onPress={() => setBoardFilter(name)}
                  />
                ))}
              </View>
            </ScrollView>
          </View>

          <ScrollView
            ref={boardScrollRef}
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 12, gap: 8 }}
            scrollEventThrottle={100}
            onScroll={handleBoardScroll}
            onContentSizeChange={() => {
              if (!boardNewestFirst && boardPinnedRef.current) {
                boardScrollRef.current?.scrollToEnd({ animated: false });
              }
            }}
          >
            {filteredPosts.length === 0 ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                当前筛选条件下暂无消息板记录。
              </Text>
            ) : (
              filteredPosts.map((post) => <BoardPostRow key={post.seq} post={post} theme={theme} />)
            )}
          </ScrollView>

          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
              padding: 10,
              gap: 6,
            }}
          >
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: "row", gap: 5, alignItems: "center" }}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>发给：</Text>
                {memberNames.map((name) => (
                  <Chip
                    key={`to-${name}`}
                    label={name === "coordinator" ? "协调者" : `@${name}`}
                    color={theme.colors.foreground}
                    theme={theme}
                    active={composeTarget === name}
                    onPress={() => setComposeTarget(name)}
                  />
                ))}
              </View>
            </ScrollView>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
              <TextInput
                value={composeText}
                onChangeText={setComposeText}
                placeholder={
                  composeTarget === "coordinator"
                    ? "给协调者发指令（不打断运行中的进程）…"
                    : `让协调者转达给 @${composeTarget}（不打断运行中的进程）…`
                }
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{
                  flex: 1,
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface2,
                  borderColor: theme.colors.border,
                  borderWidth: 1,
                  borderRadius: 7,
                  paddingHorizontal: 10,
                  paddingVertical: 7,
                  fontSize: 12,
                }}
                onSubmitEditing={() => void handleSendDirective()}
              />
              <Pressable
                disabled={sending || !composeText.trim()}
                onPress={() => void handleSendDirective()}
                style={{
                  backgroundColor:
                    sending || !composeText.trim() ? theme.colors.surface2 : theme.colors.accent,
                  borderRadius: 7,
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                }}
              >
                <Text
                  style={{
                    color:
                      sending || !composeText.trim()
                        ? theme.colors.foregroundMuted
                        : theme.colors.accentForeground,
                    fontSize: 12,
                    fontWeight: "600",
                  }}
                >
                  {sending ? "发送中" : "发送"}
                </Text>
              </Pressable>
            </View>
            {sendFeedback ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{sendFeedback}</Text>
            ) : null}
          </View>
        </View>
      ) : (
        /* TAB 4: TEAMWORK & SUBAGENT TREE (Hides completed by default, matching official retired drawer!) */
        <View style={{ flex: 1 }}>
          <View
            style={{
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.border,
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              活跃 {treePartitions.active.length} · 已完成 {treePartitions.completed.length}
            </Text>
            <Chip
              label={
                showCompletedTree
                  ? "隐藏已完成"
                  : `显示已完成 (+${treePartitions.completed.length})`
              }
              color={theme.colors.foreground}
              theme={theme}
              active={showCompletedTree}
              onPress={() => setShowCompletedTree((v) => !v)}
            />
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 6 }}>
            {treePartitions.active.length === 0 && !showCompletedTree ? (
              <View
                style={{
                  backgroundColor: theme.colors.surface1,
                  borderColor: theme.colors.border,
                  borderWidth: 1,
                  borderRadius: 9,
                  padding: 14,
                  gap: 6,
                }}
              >
                <Text style={{ color: theme.colors.statusSuccess, fontSize: 13, fontWeight: "700" }}>
                  ✓ 当前没有运行中的节点
                </Text>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                  已有 {treePartitions.completed.length} 个已完成节点默认折叠，点击右上角按钮可随时展开复盘。
                </Text>
              </View>
            ) : (
              (showCompletedTree ? treePartitions.all : treePartitions.active).map(({ group, node }) => {
                const depth = Math.min(node.depth ?? 0, 4);
                const meta = stateMeta(node.state, theme);
                const cat = categoryMeta(node.category, theme);
                const done = node.state !== "running" && node.state !== "failed";
                return (
                  <Pressable
                    key={node.id}
                    onPress={() => openSubagentLog(node)}
                    style={{
                      marginLeft: depth * 14,
                      backgroundColor: theme.colors.surface1,
                      borderColor: theme.colors.border,
                      borderWidth: 1,
                      borderLeftWidth: 3,
                      borderLeftColor: cat.color,
                      borderRadius: 7,
                      padding: 9,
                      gap: 3,
                      opacity: done ? 0.78 : 1,
                    }}
                  >
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
                        <View
                          style={{
                            backgroundColor: theme.colors.surface2,
                            borderRadius: 4,
                            paddingHorizontal: 5,
                            paddingVertical: 1,
                          }}
                        >
                          <Text style={{ color: cat.color, fontSize: 10, fontWeight: "700" }}>
                            {group === "teamwork" ? cat.label : node.typeName}
                          </Text>
                        </View>
                        <Text
                          style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600", flexShrink: 1 }}
                          numberOfLines={1}
                        >
                          {node.role}
                        </Text>
                      </View>
                      <Text style={{ color: meta.color, fontSize: 11, fontWeight: "600" }}>
                        {meta.label}
                      </Text>
                    </View>
                    {node.lastActivity ? (
                      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                        {node.lastActivity}
                      </Text>
                    ) : null}
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }} numberOfLines={1}>
                      {[
                        node.typeName,
                        node.model,
                        node.stepCount ? `${node.stepCount} 步` : null,
                        shortWorkspace(node.workspace),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </Pressable>
                );
              })
            )}
          </ScrollView>
        </View>
      )}
    </View>
  );
}
