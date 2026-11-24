import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  usePaseo,
  useRpc,
  type PluginAgentPanelProps,
} from "@getpaseo/plugin/client";
import {
  agyChildTranscriptGet,
  agyConsoleGet,
  type AgyConsoleDetail,
  type AgyMode,
  type SubagentCategory,
  type SubagentItem,
  type SwarmBoardPost,
  type SwarmMember,
  type TeamworkPhase,
  type TranscriptStep,
} from "../shared/rpc.ts";
import { getStatusSnapshot, subscribeStatus } from "./store.ts";

type ConsoleTab = "overview" | "board" | "tree";

interface SelectedChild {
  conversationId: string;
  label: string;
  subtitle: string | null;
  running: boolean;
  workspace: string | null;
}

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
      return { label: "已停止", color: theme.colors.foregroundMuted };
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
  return parts.length > 0 ? parts[parts.length - 1] : p;
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
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{post.time}</Text>
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

export function AgyConsolePanel(props: PluginAgentPanelProps) {
  const { theme } = props;
  const agentId = props.params?.agentId ?? props.agentId;
  const paseo = usePaseo();
  const fetchConsole = useRpc(agyConsoleGet);
  const fetchChildTranscript = useRpc(agyChildTranscriptGet);

  const liveStatus = useSyncExternalStore(
    subscribeStatus,
    () => (agentId ? getStatusSnapshot(agentId) : null),
    () => null,
  );

  const [detail, setDetail] = useState<AgyConsoleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<ConsoleTab>("overview");
  const [tabInitialized, setTabInitialized] = useState(false);

  // Board tab controls
  const [boardFilter, setBoardFilter] = useState<string>("all");
  const [boardNewestFirst, setBoardNewestFirst] = useState(true);
  const [composeTarget, setComposeTarget] = useState<string>("coordinator");
  const [composeText, setComposeText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendFeedback, setSendFeedback] = useState<string | null>(null);

  // Tree tab controls
  const [onlyRunning, setOnlyRunning] = useState(false);

  // Child transcript drill-down
  const [selectedChild, setSelectedChild] = useState<SelectedChild | null>(null);
  const [childSteps, setChildSteps] = useState<TranscriptStep[]>([]);
  const [childModel, setChildModel] = useState<string | null>(null);
  const [childTotal, setChildTotal] = useState(0);
  const [childLoading, setChildLoading] = useState(false);

  const reloadConsole = useCallback(async () => {
    if (!agentId) return;
    try {
      const next = await fetchConsole({ agentId, boardLimit: 200 });
      setDetail(next);
    } catch {
      // Keep previous snapshot on transient RPC failure.
    } finally {
      setLoading(false);
    }
  }, [agentId, fetchConsole]);

  // Reload whenever live watch status changes (boardCount, states, observedAt)
  const statusFingerprint = liveStatus
    ? `${liveStatus.observedAt}:${liveStatus.swarm?.latestSeq ?? 0}:${liveStatus.swarm?.working ?? 0}:${liveStatus.teamwork?.runningNodes ?? 0}:${liveStatus.subagents.length}`
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

  // Default to the most relevant tab once data arrives
  useEffect(() => {
    if (tabInitialized || !status) return;
    setTabInitialized(true);
    if (status.primaryMode === "teamwork" && !status.swarm) {
      setTab("tree");
    } else {
      setTab("overview");
    }
  }, [status, tabInitialized]);

  // Load child transcript when a child node is selected (and poll while running)
  const loadChild = useCallback(
    async (child: SelectedChild) => {
      setChildLoading(true);
      try {
        const res = await fetchChildTranscript({
          agentId,
          conversationId: child.conversationId,
          limit: 50,
        });
        if (res) {
          setChildSteps(res.steps);
          setChildModel(res.model);
          setChildTotal(res.totalSteps);
        }
      } catch {
        // Ignore transient failure
      } finally {
        setChildLoading(false);
      }
    },
    [agentId, fetchChildTranscript],
  );

  useEffect(() => {
    if (!selectedChild) return;
    void loadChild(selectedChild);
    if (!selectedChild.running) return;
    const timer = setInterval(() => {
      void loadChild(selectedChild);
    }, 3_000);
    return () => clearInterval(timer);
  }, [selectedChild, loadChild]);

  const memberNames = useMemo(() => {
    const names = new Set<string>(["coordinator"]);
    for (const m of swarm?.members ?? []) names.add(m.name);
    for (const p of boardPosts) names.add(p.agent);
    return [...names];
  }, [swarm, boardPosts]);

  const filteredPosts = useMemo(() => {
    const base =
      boardFilter === "all"
        ? boardPosts
        : boardPosts.filter(
            (p) => p.agent === boardFilter || p.mentions.includes(boardFilter.toLowerCase()),
          );
    return boardNewestFirst ? [...base].reverse() : base;
  }, [boardPosts, boardFilter, boardNewestFirst]);

  const allTreeNodes = useMemo(() => {
    const list: Array<{ group: "teamwork" | "subagent"; node: SubagentItem }> = [];
    for (const n of teamwork?.nodes ?? []) {
      list.push({ group: "teamwork", node: n });
    }
    for (const s of subagents) {
      list.push({ group: "subagent", node: s });
    }
    return onlyRunning ? list.filter((x) => x.node.state === "running") : list;
  }, [teamwork, subagents, onlyRunning]);

  const handleSendDirective = async () => {
    const body = composeText.trim();
    if (!body || sending) return;
    setSending(true);
    setSendFeedback(null);
    try {
      const prompt =
        composeTarget === "coordinator"
          ? body
          : `请在 Swarm 消息板上转达给 @${composeTarget}：\n${body}`;
      await paseo.agents.ref(agentId).send(prompt);
      setComposeText("");
      setSendFeedback(`已发送给协调者${composeTarget !== "coordinator" ? `（转 @${composeTarget}）` : ""}`);
    } catch (err) {
      setSendFeedback(`发送失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  };

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

  // Child transcript drill-down view
  if (selectedChild) {
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
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Pressable onPress={() => setSelectedChild(null)}>
              <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
                ← 返回控制台
              </Text>
            </Pressable>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {selectedChild.running ? (
                <Text style={{ color: theme.colors.accent, fontSize: 11 }}>实时刷新中 (3s)</Text>
              ) : null}
              <Pressable onPress={() => void loadChild(selectedChild)}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>刷新</Text>
              </Pressable>
            </View>
          </View>
          <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "700" }}>
            {selectedChild.label}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            {[
              selectedChild.subtitle,
              childModel,
              childTotal > 0 ? `共 ${childTotal} 步（显示最近 ${childSteps.length} 步）` : null,
              selectedChild.workspace ? `工作区: ${shortWorkspace(selectedChild.workspace)}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 8 }}>
          {childLoading && childSteps.length === 0 ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>加载执行日志中…</Text>
          ) : childSteps.length === 0 ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>暂无步骤日志</Text>
          ) : (
            [...childSteps].reverse().map((step) => (
              <View
                key={`${step.stepIndex}-${step.kind}-${step.title}`}
                style={{
                  backgroundColor: theme.colors.surface1,
                  borderColor: theme.colors.border,
                  borderWidth: 1,
                  borderLeftWidth: 3,
                  borderLeftColor: stepKindColor(step.kind, theme),
                  borderRadius: 8,
                  padding: 9,
                  gap: 4,
                }}
              >
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
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
                  {step.createdAt ? (
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                      {step.createdAt.slice(11, 19)}
                    </Text>
                  ) : null}
                </View>
                {step.summary ? (
                  <Text selectable style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 17 }}>
                    {step.summary}
                  </Text>
                ) : null}
              </View>
            ))
          )}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      {/* Header */}
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
            {swarm?.title ?? (teamwork ? "Teamwork 编排控制台" : "Antigravity 控制台")}
          </Text>
          <Pressable onPress={() => void reloadConsole()}>
            <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>刷新</Text>
          </Pressable>
        </View>

        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{status.summaryLine}</Text>

        {/* Active mode chips */}
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

        {/* Navigation tabs */}
        <View style={{ flexDirection: "row", gap: 6 }}>
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
          {teamwork || subagents.length > 0 ? (
            <Chip
              label={`成员树 (${(teamwork?.totalNodes ?? 0) + subagents.length})`}
              color={theme.colors.foreground}
              theme={theme}
              active={tab === "tree"}
              onPress={() => setTab("tree")}
            />
          ) : null}
        </View>
      </View>

      {/* Body */}
      {tab === "overview" ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 12 }}>
          {/* Swarm Goal & Threads */}
          {swarm ? (
            <SectionCard
              title="Swarm 蜂群态势"
              right={`运行 ${swarm.working} · 待命 ${swarm.waiting} · 完成 ${swarm.completed}${swarm.latestSeq ? ` · #${swarm.latestSeq}` : ""}`}
              theme={theme}
            >
              {swarmPlan?.goal ? (
                <View
                  style={{
                    backgroundColor: theme.colors.surface2,
                    borderRadius: 7,
                    padding: 9,
                    gap: 2,
                  }}
                >
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

              {/* Threads from plan.json if present */}
              {swarmPlan && swarmPlan.threads.length > 0 ? (
                <View style={{ gap: 8 }}>
                  {swarmPlan.threads.map((th) => (
                    <View
                      key={th.id}
                      style={{
                        borderColor: theme.colors.border,
                        borderWidth: 1,
                        borderRadius: 8,
                        padding: 9,
                        gap: 6,
                      }}
                    >
                      <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "700" }}>
                        {th.title}
                      </Text>
                      {th.goal ? (
                        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{th.goal}</Text>
                      ) : null}
                      {th.tasks.map((memberName) => {
                        const member = swarm.members.find((m) => m.name === memberName);
                        const taskDesc = swarmPlan.tasks[memberName];
                        const meta = member
                          ? stateMeta(member.state, theme)
                          : { label: "未启动", color: theme.colors.foregroundMuted };
                        const unread =
                          member &&
                          typeof swarm.latestSeq === "number" &&
                          typeof member.lastReadSeq === "number" &&
                          swarm.latestSeq > member.lastReadSeq
                            ? swarm.latestSeq - member.lastReadSeq
                            : 0;
                        return (
                          <Pressable
                            key={memberName}
                            disabled={!member?.conversationId}
                            onPress={() => {
                              if (!member?.conversationId) return;
                              setSelectedChild({
                                conversationId: member.conversationId,
                                label: `Swarm Worker: ${member.name}`,
                                subtitle: member.model,
                                running: member.state === "working",
                                workspace: member.workspace ?? null,
                              });
                            }}
                            style={{
                              backgroundColor: theme.colors.surface2,
                              borderRadius: 6,
                              padding: 8,
                              gap: 3,
                            }}
                          >
                            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                              <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
                                @{memberName}
                              </Text>
                              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                                {unread > 0 ? (
                                  <Text style={{ color: theme.colors.statusWarning, fontSize: 10 }}>
                                    滞后 {unread} 帖
                                  </Text>
                                ) : null}
                                <Text style={{ color: meta.color, fontSize: 11, fontWeight: "600" }}>
                                  {meta.label}
                                </Text>
                              </View>
                            </View>
                            {taskDesc ? (
                              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={2}>
                                {taskDesc}
                              </Text>
                            ) : null}
                            {member?.lastActivity ? (
                              <Text style={{ color: theme.colors.accent, fontSize: 11 }} numberOfLines={1}>
                                最新：{member.lastActivity}
                              </Text>
                            ) : null}
                            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }} numberOfLines={1}>
                              {[
                                member?.model,
                                member?.workspaceMode,
                                shortWorkspace(member?.workspace),
                                member?.stepCount ? `${member.stepCount} 步` : null,
                                member?.conversationId ? "点击查看实时日志 →" : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  ))}
                </View>
              ) : null}

              {/* All Swarm members (including historical / killed or when no plan.json) */}
              <View style={{ gap: 6 }}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
                  全部成员（{swarm.members.length}，点击查看实时日志）
                </Text>
                {swarm.members.map((member) => {
                  const meta = stateMeta(member.state, theme);
                  return (
                    <Pressable
                      key={member.name + member.conversationId}
                      disabled={!member.conversationId}
                      onPress={() => {
                        if (!member.conversationId) return;
                        setSelectedChild({
                          conversationId: member.conversationId,
                          label: `Swarm Worker: ${member.name}`,
                          subtitle: member.model,
                          running: member.state === "working",
                          workspace: member.workspace ?? null,
                        });
                      }}
                      style={{
                        borderColor: theme.colors.border,
                        borderWidth: 1,
                        borderRadius: 7,
                        padding: 8,
                        gap: 3,
                      }}
                    >
                      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}>
                          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
                            {member.name}
                          </Text>
                          {member.workspaceMode ? (
                            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                              [{member.workspaceMode}]
                            </Text>
                          ) : null}
                          {member.model ? (
                            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }} numberOfLines={1}>
                              {member.model}
                            </Text>
                          ) : null}
                        </View>
                        <Text style={{ color: meta.color, fontSize: 11, fontWeight: "600" }}>
                          {meta.label}
                        </Text>
                      </View>
                      {member.lastActivity ? (
                        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                          {member.lastActivity}
                        </Text>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            </SectionCard>
          ) : null}

          {/* Teamwork Pipeline Overview */}
          {teamwork ? (
            <SectionCard
              title="Teamwork 流水线"
              right={`运行 ${teamwork.runningNodes} / 共 ${teamwork.totalNodes} 节点 · 完成 ${teamwork.completedNodes}${teamwork.failedNodes > 0 ? ` · 失败 ${teamwork.failedNodes}` : ""}`}
              theme={theme}
            >
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {TEAMWORK_PHASES.map((p) => {
                  const isCurrent = teamwork.phase === p.key;
                  return (
                    <Chip
                      key={p.key}
                      label={p.label}
                      color={isCurrent ? theme.colors.accent : theme.colors.foregroundMuted}
                      theme={theme}
                      active={isCurrent}
                    />
                  );
                })}
              </View>
              {teamwork.nodes
                .filter((n) => n.state === "running")
                .slice(0, 6)
                .map((node) => {
                  const cat = categoryMeta(node.category, theme);
                  return (
                    <Pressable
                      key={node.id}
                      onPress={() =>
                        setSelectedChild({
                          conversationId: node.id,
                          label: node.role,
                          subtitle: `${node.typeName}${node.model ? ` · ${node.model}` : ""}`,
                          running: node.state === "running",
                          workspace: node.workspace ?? null,
                        })
                      }
                      style={{
                        backgroundColor: theme.colors.surface2,
                        borderRadius: 6,
                        padding: 8,
                        gap: 2,
                      }}
                    >
                      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                        <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600", flexShrink: 1 }} numberOfLines={1}>
                          [{cat.label}] {node.role}
                        </Text>
                        <Text style={{ color: theme.colors.accent, fontSize: 11 }}>运行中 →</Text>
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
                  查看完整 Teamwork 层级树 ({teamwork.totalNodes} 节点) →
                </Text>
              </Pressable>
            </SectionCard>
          ) : null}

          {/* /goal status */}
          {status.goalActive ? (
            <SectionCard title="/goal 目标循环" right="Stop Hook 保活中" theme={theme}>
              <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
                {status.goalSummary ?? "目标循环已激活，完成全部验收条件前不会提前停工。"}
              </Text>
            </SectionCard>
          ) : null}

          {/* Plan checklist */}
          {plan ? (
            <SectionCard
              title={plan.inPlanMode ? "规划模式（进行中）" : "执行步骤清单"}
              right={plan.total > 0 ? `${plan.completed}/${plan.total}` : undefined}
              theme={theme}
            >
              {plan.steps.length === 0 ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                  当前处于 Plan 模式，尚未提交步骤列表。
                </Text>
              ) : (
                plan.steps.map((s, idx) => (
                  <View key={`${idx}-${s.title}`} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text
                      style={{
                        color:
                          s.status === "done"
                            ? theme.colors.statusSuccess
                            : s.status === "in_progress"
                              ? theme.colors.accent
                              : s.status === "failed"
                                ? theme.colors.statusDanger
                                : theme.colors.foregroundMuted,
                        fontSize: 12,
                        width: 14,
                      }}
                    >
                      {s.status === "done"
                        ? "✓"
                        : s.status === "in_progress"
                          ? "◐"
                          : s.status === "failed"
                            ? "✕"
                            : "○"}
                    </Text>
                    <Text
                      style={{
                        color:
                          s.status === "done" || s.status === "skipped"
                            ? theme.colors.foregroundMuted
                            : theme.colors.foreground,
                        fontSize: 12,
                        flex: 1,
                      }}
                    >
                      {s.title}
                    </Text>
                  </View>
                ))
              )}
            </SectionCard>
          ) : null}

          {/* Workflows */}
          {workflows.length > 0 ? (
            <SectionCard title="Python Workflow 编排" right={`${workflows.length} 次运行`} theme={theme}>
              {workflows.map((wf) => {
                const meta = stateMeta(wf.status, theme);
                return (
                  <View
                    key={wf.id}
                    style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}
                  >
                    <Text style={{ color: theme.colors.foreground, fontSize: 12, flex: 1 }} numberOfLines={1}>
                      {wf.description}
                    </Text>
                    <Text style={{ color: meta.color, fontSize: 11, fontWeight: "600" }}>{meta.label}</Text>
                  </View>
                );
              })}
            </SectionCard>
          ) : null}

          {/* Regular subagents & background tasks */}
          {subagents.length > 0 ? (
            <SectionCard title="常规子代理" right={`${subagents.length} 个`} theme={theme}>
              {subagents.slice(0, 8).map((s) => {
                const meta = stateMeta(s.state, theme);
                return (
                  <Pressable
                    key={s.id}
                    onPress={() =>
                      setSelectedChild({
                        conversationId: s.id,
                        label: s.role,
                        subtitle: `${s.typeName}${s.model ? ` · ${s.model}` : ""}`,
                        running: s.state === "running",
                        workspace: s.workspace ?? null,
                      })
                    }
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                      paddingVertical: 3,
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: theme.colors.foreground, fontSize: 12 }} numberOfLines={1}>
                        {s.role} ({s.typeName})
                      </Text>
                      {s.lastActivity ? (
                        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                          {s.lastActivity}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={{ color: meta.color, fontSize: 11, fontWeight: "600" }}>{meta.label}</Text>
                  </Pressable>
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
      ) : tab === "board" ? (
        <View style={{ flex: 1 }}>
          {/* Filter bar */}
          <View
            style={{
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.border,
              gap: 6,
            }}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                共 {filteredPosts.length} / {detail?.boardTotal ?? boardPosts.length} 条帖子
              </Text>
              <Pressable onPress={() => setBoardNewestFirst((v) => !v)}>
                <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>
                  {boardNewestFirst ? "排序：最新在前 ⇅" : "排序：时间正序 ⇅"}
                </Text>
              </Pressable>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: "row", gap: 6 }}>
                <Chip
                  label="全部"
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

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 8 }}>
            {filteredPosts.length === 0 ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                当前筛选条件下暂无消息板记录。
              </Text>
            ) : (
              filteredPosts.map((post) => <BoardPostRow key={post.seq} post={post} theme={theme} />)
            )}
          </ScrollView>

          {/* Safe directive composer via coordinator */}
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
                    ? "给协调者发指令…"
                    : `让协调者转达给 @${composeTarget}…`
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
            }}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              点击任意节点可查看其实时执行日志
            </Text>
            <Chip
              label={onlyRunning ? "仅显示运行中 ✓" : "全部节点"}
              color={theme.colors.foreground}
              theme={theme}
              active={onlyRunning}
              onPress={() => setOnlyRunning((v) => !v)}
            />
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 6 }}>
            {allTreeNodes.length === 0 ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                {onlyRunning ? "当前没有运行中的子代理节点。" : "暂无子代理节点。"}
              </Text>
            ) : (
              allTreeNodes.map(({ group, node }) => {
                const depth = Math.min(node.depth ?? 0, 4);
                const meta = stateMeta(node.state, theme);
                const cat = categoryMeta(node.category, theme);
                return (
                  <Pressable
                    key={node.id}
                    onPress={() =>
                      setSelectedChild({
                        conversationId: node.id,
                        label: node.role,
                        subtitle: `${node.typeName}${node.model ? ` · ${node.model}` : ""}`,
                        running: node.state === "running",
                        workspace: node.workspace ?? null,
                      })
                    }
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
