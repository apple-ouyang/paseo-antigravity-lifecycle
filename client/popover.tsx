import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import type { AgentBgStatus, SubagentItem, SwarmMember } from "../shared/rpc.ts";
import { formatDurationShort, ProgressMeter } from "./progress-bar.tsx";
import {
  getStatusSnapshot,
  openConsoleForAgent,
  refreshAgentStatus,
  subscribeStatus,
  type SelectedChildTarget,
} from "./store.ts";

const MAX_SHOWN_MEMBERS = 10;
const ROLE_WORKER_RE = /^(?:narrator|monitor)(?:-\d+)?$/i;

function isMemberDone(member: SwarmMember): boolean {
  return (
    member.state === "completed" ||
    member.state === "canceled" ||
    member.state === "stopped" ||
    (member.state === "waiting" && Boolean(member.delivered))
  );
}

function stateLabelAndColor(
  state: SwarmMember["state"] | SubagentItem["state"],
  delivered: boolean | undefined,
  theme: PluginTheme,
): { label: string; color: string } {
  if (state === "waiting" && delivered) {
    return { label: "已交活 ✓", color: theme.colors.statusSuccess };
  }
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

function StatusContent({
  status,
  theme,
  onOpenConsole,
  onOpenChild,
  onOpenBoardForMember,
}: {
  status: AgentBgStatus;
  theme: PluginTheme;
  onOpenConsole: () => void;
  onOpenChild: (child: SelectedChildTarget) => void;
  onOpenBoardForMember: (memberName: string) => void;
}) {
  const [showCompleted, setShowCompleted] = useState(false);
  const [showDoneSteps, setShowDoneSteps] = useState(false);

  const allMembers = (status.swarm?.members ?? []).filter((m) => !ROLE_WORKER_RE.test(m.name));
  const liveMembers = allMembers.filter((m) => !isMemberDone(m));
  const doneMembersCount = allMembers.length - liveMembers.length;
  const shownMembers = (showCompleted ? allMembers : liveMembers).slice(0, MAX_SHOWN_MEMBERS);

  const tw = status.teamwork ?? null;
  const liveTw = (tw?.nodes ?? []).filter((n) => n.state === "running" || n.state === "failed");
  const shownTw = (showCompleted ? tw?.nodes ?? [] : liveTw).slice(0, 8);

  const liveSubs = status.subagents.filter((s) => s.state === "running" || s.state === "failed");
  const shownSubs = (showCompleted ? status.subagents : liveSubs).slice(0, MAX_SHOWN_MEMBERS);

  const totalRetired =
    doneMembersCount +
    ((tw?.totalNodes ?? 0) - liveTw.length) +
    (status.subagents.length - liveSubs.length);

  const plan = status.plan ?? null;
  const planOpenSteps = plan
    ? plan.steps.filter((s) => s.status !== "done" && s.status !== "skipped")
    : [];
  const planDoneSteps = plan
    ? plan.steps.filter((s) => s.status === "done" || s.status === "skipped")
    : [];

  return (
    <View style={{ gap: 10, minWidth: 360, maxWidth: 480 }}>
      {/* Header */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "700" }} numberOfLines={1}>
            {status.swarm?.title ?? "Antigravity 实时进度"}
          </Text>
          {status.goalActive ? (
            <View
              style={{
                backgroundColor: theme.colors.surface2,
                borderColor: theme.colors.border,
                borderWidth: 1,
                borderRadius: 5,
                paddingHorizontal: 5,
                paddingVertical: 1,
              }}
            >
              <Text style={{ color: theme.colors.accent, fontSize: 10, fontWeight: "600" }}>
                /goal
              </Text>
            </View>
          ) : null}
          {status.boostActive ? (
            <View
              style={{
                backgroundColor: theme.colors.surface2,
                borderColor: theme.colors.border,
                borderWidth: 1,
                borderRadius: 5,
                paddingHorizontal: 5,
                paddingVertical: 1,
              }}
            >
              <Text style={{ color: theme.colors.statusWarning, fontSize: 10, fontWeight: "600" }}>
                Boost
              </Text>
            </View>
          ) : null}
        </View>
        <Pressable
          onPress={onOpenConsole}
          style={{
            backgroundColor: theme.colors.surface2,
            borderColor: theme.colors.border,
            borderWidth: 1,
            borderRadius: 6,
            paddingHorizontal: 8,
            paddingVertical: 3,
          }}
        >
          <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>
            打开控制台 →
          </Text>
        </Pressable>
      </View>

      <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ gap: 10 }}>
        {/* 1. Real-time percentage progress bar + elapsed + ETA */}
        {status.progress ? <ProgressMeter progress={status.progress} theme={theme} compact /> : null}

        {/* 2. Task checklist right at the top inside the chat dialog popover! */}
        {plan && plan.total > 0 ? (
          <View
            style={{
              gap: 5,
              backgroundColor: theme.colors.surface1,
              borderColor: theme.colors.border,
              borderWidth: 1,
              borderRadius: 8,
              padding: 9,
            }}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "700" }}>
                任务清单
              </Text>
              <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>
                {plan.completed}/{plan.total} ({Math.round((plan.completed / plan.total) * 100)}%)
              </Text>
            </View>

            {planOpenSteps.map((s, idx) => (
              <View key={`o-${idx}-${s.title}`} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
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

            {planDoneSteps.length > 0 ? (
              <View style={{ gap: 3 }}>
                <Pressable onPress={() => setShowDoneSteps((v) => !v)}>
                  <Text style={{ color: theme.colors.statusSuccess, fontSize: 11 }}>
                    {showDoneSteps
                      ? "▾ 收起已完成步骤"
                      : `▸ 已完成 ${planDoneSteps.length} 步（点击展开）`}
                  </Text>
                </Pressable>
                {showDoneSteps
                  ? planDoneSteps.map((s, idx) => (
                      <Text key={`d-${idx}-${s.title}`} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                        ✓ {s.title}
                      </Text>
                    ))
                  : null}
              </View>
            ) : null}
          </View>
        ) : null}

        {/* 3. Active Swarm members with per-member elapsed time & step progress (clickable → jumps to agent chat in console) */}
        {status.swarm ? (
          <View style={{ gap: 6, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
                Swarm 成员（{liveMembers.length} 进行中 · {doneMembersCount} 已完成
                {status.swarm.latestSeq ? ` · #${status.swarm.latestSeq}` : ""}）
              </Text>
              {shownMembers.length > 0 ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                  点击看对话
                </Text>
              ) : null}
            </View>
            {shownMembers.length === 0 ? (
              <Text style={{ color: theme.colors.statusSuccess, fontSize: 11 }}>
                ✓ 全部 {allMembers.length} 个成员已完成
              </Text>
            ) : (
              shownMembers.map((member) => {
                const badge = stateLabelAndColor(member.state, member.delivered, theme);
                const dur = formatDurationShort(member.durationMs);
                const handleMemberPress = () => {
                  if (member.conversationId) {
                    onOpenChild({
                      conversationId: member.conversationId,
                      label: `@${member.name}`,
                      subtitle: member.model,
                      running: member.state === "working",
                      workspace: member.workspace ?? null,
                      memberName: member.name,
                    });
                  } else {
                    onOpenBoardForMember(member.name);
                  }
                };
                return (
                  <Pressable
                    key={member.name + member.conversationId}
                    onPress={handleMemberPress}
                    style={{
                      gap: 2,
                      backgroundColor: theme.colors.surface1,
                      borderColor: theme.colors.border,
                      borderWidth: 1,
                      borderRadius: 7,
                      paddingHorizontal: 9,
                      paddingVertical: 6,
                    }}
                  >
                    <View
                      style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}
                    >
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
                            {isMemberDone(member) ? dur : `已跑 ${dur}`}
                          </Text>
                        ) : null}
                      </View>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                        <Text style={{ color: badge.color, fontSize: 11, fontWeight: "600" }}>
                          {badge.label}
                        </Text>
                        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>›</Text>
                      </View>
                    </View>
                    {member.lastActivity ? (
                      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }} numberOfLines={1}>
                        {member.lastActivity}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })
            )}
          </View>
        ) : null}

        {/* 4. Active Teamwork nodes */}
        {tw ? (
          <View style={{ gap: 5, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
              Teamwork（{tw.completedNodes}/{tw.totalNodes} 完成 · {tw.runningNodes} 运行中）
            </Text>
            {shownTw.length === 0 ? (
              <Text style={{ color: theme.colors.statusSuccess, fontSize: 11 }}>
                ✓ 全部 {tw.totalNodes} 个节点已完成
              </Text>
            ) : (
              shownTw.map((node) => {
                const badge = stateLabelAndColor(node.state, false, theme);
                const indent = Math.min(node.depth ?? 0, 3) * 10;
                const dur = formatDurationShort(node.durationMs);
                return (
                  <Pressable
                    key={node.id}
                    onPress={() =>
                      onOpenChild({
                        conversationId: node.id,
                        label: node.role,
                        subtitle: `${node.typeName}${node.model ? ` · ${node.model}` : ""}`,
                        running: node.state === "running",
                        workspace: node.workspace ?? null,
                      })
                    }
                    style={{
                      marginLeft: indent,
                      flexDirection: "row",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 10,
                      backgroundColor: theme.colors.surface1,
                      borderColor: theme.colors.border,
                      borderWidth: 1,
                      borderRadius: 6,
                      paddingHorizontal: 8,
                      paddingVertical: 5,
                    }}
                  >
                    <Text style={{ color: theme.colors.foreground, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
                      {node.role}{dur ? ` (${dur})` : ""}
                    </Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                      <Text style={{ color: badge.color, fontSize: 11, fontWeight: "600" }}>
                        {badge.label}
                      </Text>
                      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>›</Text>
                    </View>
                  </Pressable>
                );
              })
            )}
          </View>
        ) : null}

        {/* 5. Active regular subagents */}
        {shownSubs.length > 0 ? (
          <View style={{ gap: 5, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
              子代理（{liveSubs.length} 活跃 / 共 {status.subagents.length}）
            </Text>
            {shownSubs.map((sub) => {
              const badge = stateLabelAndColor(sub.state, false, theme);
              return (
                <Pressable
                  key={sub.id}
                  onPress={() =>
                    onOpenChild({
                      conversationId: sub.id,
                      label: sub.role,
                      subtitle: `${sub.typeName}${sub.model ? ` · ${sub.model}` : ""}`,
                      running: sub.state === "running",
                      workspace: sub.workspace ?? null,
                    })
                  }
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 12,
                    backgroundColor: theme.colors.surface1,
                    borderColor: theme.colors.border,
                    borderWidth: 1,
                    borderRadius: 6,
                    paddingHorizontal: 8,
                    paddingVertical: 5,
                  }}
                >
                  <Text style={{ color: theme.colors.foreground, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
                    {sub.role} ({sub.typeName})
                  </Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                    <Text style={{ color: badge.color, fontSize: 11, fontWeight: "600" }}>
                      {badge.label}
                    </Text>
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>›</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {/* 6. Active background commands & schedules */}
        {status.tasks.length > 0 ? (
          <View style={{ gap: 5, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
              后台命令 / 定时器（{status.tasks.length}）
            </Text>
            {status.tasks.slice(0, MAX_SHOWN_MEMBERS).map((task) => (
              <View
                key={task.id}
                style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}
              >
                <Text style={{ color: theme.colors.foreground, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
                  [{task.kind}] {task.summary}
                </Text>
                <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>
                  运行中
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {totalRetired > 0 ? (
          <Pressable onPress={() => setShowCompleted((v) => !v)}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {showCompleted ? "▾ 隐藏已完成/已归档项" : `▸ 已隐藏 ${totalRetired} 个已完成项（点击展开）`}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

export function AgyLifecyclePopover(props: PluginButtonContentProps) {
  const agentId = props.context === "agent" ? props.agentId : "";
  const workspaceId = props.workspaceId;
  const status = useSyncExternalStore(
    subscribeStatus,
    () => (agentId ? getStatusSnapshot(agentId) : null),
    () => null,
  );

  // Always self-heal with a fresh RPC read when the popover opens and while it stays open,
  // so resumed windows or post-reconnect sessions never stay frozen on stale watch snapshots.
  useEffect(() => {
    if (!agentId) return;
    void refreshAgentStatus(agentId);
    const timer = setInterval(() => {
      void refreshAgentStatus(agentId);
    }, 3_000);
    return () => clearInterval(timer);
  }, [agentId]);

  if (!agentId) return null;

  const handleOpenConsole = () => {
    props.close();
    openConsoleForAgent(agentId, workspaceId, { kind: "overview" });
  };

  const handleOpenChild = (child: SelectedChildTarget) => {
    props.close();
    openConsoleForAgent(agentId, workspaceId, { kind: "child", child });
  };

  const handleOpenBoardForMember = (memberName: string) => {
    props.close();
    openConsoleForAgent(agentId, workspaceId, { kind: "board", filter: memberName });
  };

  if (!status) {
    return (
      <View style={{ gap: 8, minWidth: 260 }}>
        <Text style={{ color: props.theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>
          Antigravity 实时进度
        </Text>
        <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 12 }}>
          当前无活动后台任务
        </Text>
        <Pressable onPress={handleOpenConsole}>
          <Text style={{ color: props.theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
            打开控制台 →
          </Text>
        </Pressable>
      </View>
    );
  }
  return (
    <StatusContent
      status={status}
      theme={props.theme}
      onOpenConsole={handleOpenConsole}
      onOpenChild={handleOpenChild}
      onOpenBoardForMember={handleOpenBoardForMember}
    />
  );
}
