import { useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import type { AgentBgStatus, SubagentItem, SwarmMember } from "../shared/rpc.ts";
import { getStatusSnapshot, openConsoleForAgent, subscribeStatus } from "./store.ts";

const MAX_SHOWN_MEMBERS = 10;

function stateLabelAndColor(
  state: SwarmMember["state"] | SubagentItem["state"],
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

function renderStatusContent(
  status: AgentBgStatus,
  theme: PluginTheme,
  onOpenConsole: () => void,
) {
  const members = status.swarm?.members ?? [];
  const shownMembers = members.slice(0, MAX_SHOWN_MEMBERS);
  const hiddenCount = members.length - shownMembers.length;
  const tw = status.teamwork ?? null;

  return (
    <View style={{ gap: 10, minWidth: 340, maxWidth: 480 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>
            Antigravity 编排状态
          </Text>
          {status.goalActive ? (
            <View
              style={{
                backgroundColor: theme.colors.surface2,
                borderColor: theme.colors.border,
                borderWidth: 1,
                borderRadius: 6,
                paddingHorizontal: 6,
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
                borderRadius: 6,
                paddingHorizontal: 6,
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
            backgroundColor: theme.colors.accent,
            borderRadius: 6,
            paddingHorizontal: 10,
            paddingVertical: 4,
          }}
        >
          <Text style={{ color: theme.colors.accentForeground, fontSize: 11, fontWeight: "600" }}>
            打开控制台 →
          </Text>
        </Pressable>
      </View>

      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {status.summaryLine}
      </Text>

      {status.swarm ? (
        <View style={{ gap: 5, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
            Swarm{status.swarm.title ? `：${status.swarm.title}` : ""}（运行 {status.swarm.working} · 待命{" "}
            {status.swarm.waiting} · 完成 {status.swarm.completed}
            {status.swarm.latestSeq ? ` · #${status.swarm.latestSeq}` : ""}）
          </Text>
          {shownMembers.map((member) => {
            const badge = stateLabelAndColor(member.state, theme);
            return (
              <View key={member.name + member.conversationId} style={{ gap: 1 }}>
                <View
                  style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}>
                    <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "500" }} numberOfLines={1}>
                      {member.name}
                    </Text>
                    {member.model ? (
                      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }} numberOfLines={1}>
                        {member.model}
                      </Text>
                    ) : null}
                  </View>
                  <Text style={{ color: badge.color, fontSize: 11, fontWeight: "600" }}>
                    {badge.label}
                  </Text>
                </View>
                {member.lastActivity ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }} numberOfLines={1}>
                    {member.lastActivity}
                  </Text>
                ) : null}
              </View>
            );
          })}
          {hiddenCount > 0 ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              另有 {hiddenCount} 个成员，点击「打开控制台」查看完整消息板与日志
            </Text>
          ) : null}
        </View>
      ) : null}

      {tw ? (
        <View style={{ gap: 5, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
            Teamwork（运行 {tw.runningNodes} / 共 {tw.totalNodes} 节点 · 完成 {tw.completedNodes}）
          </Text>
          {tw.nodes.slice(0, 8).map((node) => {
            const badge = stateLabelAndColor(node.state, theme);
            const indent = Math.min(node.depth ?? 0, 3) * 10;
            return (
              <View
                key={node.id}
                style={{
                  marginLeft: indent,
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <Text style={{ color: theme.colors.foreground, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
                  {node.role}
                </Text>
                <Text style={{ color: badge.color, fontSize: 11, fontWeight: "600" }}>
                  {badge.label}
                </Text>
              </View>
            );
          })}
          {tw.nodes.length > 8 ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              另有 {tw.nodes.length - 8} 个嵌套节点，点击「打开控制台」查看完整树
            </Text>
          ) : null}
        </View>
      ) : null}

      {status.plan && status.plan.total > 0 ? (
        <View style={{ gap: 4, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
            执行清单（{status.plan.completed}/{status.plan.total}）
          </Text>
        </View>
      ) : null}

      {status.subagents.length > 0 ? (
        <View style={{ gap: 5, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
            子代理（{status.subagents.length}）
          </Text>
          {status.subagents.slice(0, MAX_SHOWN_MEMBERS).map((sub) => {
            const badge = stateLabelAndColor(sub.state, theme);
            return (
              <View
                key={sub.id}
                style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}
              >
                <Text style={{ color: theme.colors.foreground, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
                  {sub.role} ({sub.typeName})
                </Text>
                <Text style={{ color: badge.color, fontSize: 11, fontWeight: "600" }}>
                  {badge.label}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}

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

  if (!agentId) return null;

  const handleOpenConsole = () => {
    props.close();
    openConsoleForAgent(agentId, workspaceId);
  };

  if (!status) {
    return (
      <View style={{ gap: 8, minWidth: 240 }}>
        <Text style={{ color: props.theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>
          Antigravity 编排状态
        </Text>
        <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 12 }}>
          当前无活动后台任务
        </Text>
        <Pressable onPress={handleOpenConsole}>
          <Text style={{ color: props.theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
            打开控制台面板 →
          </Text>
        </Pressable>
      </View>
    );
  }
  return renderStatusContent(status, props.theme, handleOpenConsole);
}
