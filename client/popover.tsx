import { useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import type { AgentBgStatus, SubagentItem, SwarmMember } from "../shared/rpc.ts";
import { getStatusSnapshot, subscribeStatus } from "./store.ts";

const MAX_SHOWN_MEMBERS = 12;

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

function renderStatusContent(status: AgentBgStatus, theme: PluginTheme) {
  const members = status.swarm?.members ?? [];
  const shownMembers = members.slice(0, MAX_SHOWN_MEMBERS);
  const hiddenCount = members.length - shownMembers.length;

  return (
    <View style={{ gap: 10, minWidth: 320, maxWidth: 480 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>
          Antigravity 后台状态
        </Text>
        {status.goalActive ? (
          <View
            style={{
              backgroundColor: theme.colors.surface2,
              borderColor: theme.colors.border,
              borderWidth: 1,
              borderRadius: 6,
              paddingHorizontal: 8,
              paddingVertical: 2,
            }}
          >
            <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>
              /goal 循环中
            </Text>
          </View>
        ) : null}
      </View>

      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {status.summaryLine}
      </Text>

      {status.swarm ? (
        <View style={{ gap: 5, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
            Swarm{status.swarm.title ? `：${status.swarm.title}` : ""}（运行 {status.swarm.working} · 待命{" "}
            {status.swarm.waiting} · 完成 {status.swarm.completed}）
          </Text>
          {shownMembers.map((member) => {
            const badge = stateLabelAndColor(member.state, theme);
            return (
              <View
                key={member.name + member.conversationId}
                style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 12 }} numberOfLines={1}>
                    {member.name}
                  </Text>
                  {member.model ? (
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                      {member.model}
                    </Text>
                  ) : null}
                </View>
                <Text style={{ color: badge.color, fontSize: 12, fontWeight: "500" }}>
                  {badge.label}
                </Text>
              </View>
            );
          })}
          {hiddenCount > 0 ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              另有 {hiddenCount} 个成员未展开
            </Text>
          ) : null}
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
                <Text style={{ color: badge.color, fontSize: 12, fontWeight: "500" }}>
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
              <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "500" }}>
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
  const status = useSyncExternalStore(
    subscribeStatus,
    () => (agentId ? getStatusSnapshot(agentId) : null),
    () => null,
  );

  if (!agentId) return null;
  if (!status) {
    return (
      <View style={{ gap: 6, minWidth: 240 }}>
        <Text style={{ color: props.theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>
          Antigravity 后台状态
        </Text>
        <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 12 }}>
          当前无活动后台任务
        </Text>
      </View>
    );
  }
  return renderStatusContent(status, props.theme);
}
