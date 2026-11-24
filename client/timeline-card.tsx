import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { agyBoardSliceGet, type SwarmBoardPost } from "../shared/rpc.ts";
import type { AgyToolCardData } from "../shared/timeline.ts";
import { openConsoleForAgent } from "./store.ts";

function accentColor(accent: AgyToolCardData["accent"], theme: PluginTheme): string {
  switch (accent) {
    case "accent":
      return theme.colors.accent;
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    case "muted":
      return theme.colors.foregroundMuted;
  }
}

function stepGlyph(status: string, theme: PluginTheme): { glyph: string; color: string } {
  switch (status) {
    case "done":
      return { glyph: "✓", color: theme.colors.statusSuccess };
    case "in_progress":
      return { glyph: "◐", color: theme.colors.accent };
    case "failed":
      return { glyph: "✕", color: theme.colors.statusDanger };
    case "skipped":
      return { glyph: "–", color: theme.colors.foregroundMuted };
    default:
      return { glyph: "○", color: theme.colors.foregroundMuted };
  }
}

export function AgyToolCard({
  agentId,
  item,
  theme,
}: PluginTimelineItemProps<AgyToolCardData>) {
  const data = item.data;
  const [expanded, setExpanded] = useState(false);
  const [boardPosts, setBoardPosts] = useState<SwarmBoardPost[] | null>(null);
  const [boardLoading, setBoardLoading] = useState(false);
  const fetchBoardSlice = useRpc(agyBoardSliceGet);

  const badgeColor =
    data.status === "failed"
      ? theme.colors.statusDanger
      : data.status === "running"
        ? theme.colors.accent
        : accentColor(data.accent, theme);

  const canExpand =
    Boolean(data.body) ||
    data.category === "swarm_read" ||
    data.category === "swarm_wait" ||
    Boolean(data.steps && data.steps.length > 0);

  const handleToggle = () => {
    if (!canExpand) return;
    const next = !expanded;
    setExpanded(next);
    if (
      next &&
      (data.category === "swarm_read" || data.category === "swarm_wait") &&
      boardPosts === null &&
      !boardLoading
    ) {
      setBoardLoading(true);
      void fetchBoardSlice({
        agentId,
        since: data.boardSince ?? 0,
        limit: 8,
      })
        .then((res) => {
          setBoardPosts(res.posts);
        })
        .catch(() => {
          setBoardPosts([]);
        })
        .finally(() => {
          setBoardLoading(false);
        });
    }
  };

  // Checklist rendering for update_steps
  if (data.category === "steps" && data.steps && data.steps.length > 0) {
    return (
      <View
        style={{
          gap: 6,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          backgroundColor: theme.colors.surface1,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}>
            <Text style={{ color: badgeColor, fontSize: 11, fontWeight: "700" }}>{data.badge}</Text>
            <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "500" }} numberOfLines={1}>
              {data.headline}
            </Text>
          </View>
          <Pressable onPress={() => setExpanded((v) => !v)}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {expanded ? "收起" : "展开"}
            </Text>
          </Pressable>
        </View>
        {expanded ? (
          <View style={{ gap: 4, paddingTop: 2 }}>
            {data.steps.map((s, idx) => {
              const g = stepGlyph(s.status, theme);
              return (
                <View key={`${idx}-${s.title}`} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={{ color: g.color, fontSize: 12, width: 14 }}>{g.glyph}</Text>
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
              );
            })}
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View
      style={{
        gap: 4,
        borderLeftWidth: 2,
        borderLeftColor: badgeColor,
        borderTopWidth: 1,
        borderRightWidth: 1,
        borderBottomWidth: 1,
        borderTopColor: theme.colors.border,
        borderRightColor: theme.colors.border,
        borderBottomColor: theme.colors.border,
        borderRadius: 7,
        paddingHorizontal: 10,
        paddingVertical: 6,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Pressable
          onPress={handleToggle}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}
        >
          <View
            style={{
              backgroundColor: theme.colors.surface2,
              borderRadius: 4,
              paddingHorizontal: 6,
              paddingVertical: 1,
            }}
          >
            <Text style={{ color: badgeColor, fontSize: 11, fontWeight: "600" }}>{data.badge}</Text>
          </View>
          <Text
            style={{ color: theme.colors.foreground, fontSize: 12, flexShrink: 1 }}
            numberOfLines={1}
          >
            {data.headline}
          </Text>
          {data.status === "running" ? (
            <Text style={{ color: theme.colors.accent, fontSize: 11 }}>运行中…</Text>
          ) : data.status === "failed" ? (
            <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>失败</Text>
          ) : null}
        </Pressable>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {canExpand ? (
            <Pressable onPress={handleToggle}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                {expanded ? "收起" : "详情"}
              </Text>
            </Pressable>
          ) : null}
          {data.canOpenConsole ? (
            <Pressable onPress={() => openConsoleForAgent(agentId)}>
              <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "500" }}>
                控制台
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {data.subline && !expanded ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
          {data.subline}
        </Text>
      ) : null}

      {expanded ? (
        <View
          style={{
            marginTop: 4,
            paddingTop: 6,
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            gap: 6,
          }}
        >
          {data.body ? (
            <Text
              selectable
              style={{
                color: theme.colors.foreground,
                fontSize: 12,
                lineHeight: 18,
              }}
            >
              {data.body}
            </Text>
          ) : null}

          {data.category === "swarm_read" || data.category === "swarm_wait" ? (
            boardLoading ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                正在从消息板读取 #{data.boardSince ?? 0} 之后的帖子…
              </Text>
            ) : boardPosts && boardPosts.length > 0 ? (
              <View style={{ gap: 6 }}>
                {boardPosts.map((post) => (
                  <View
                    key={post.seq}
                    style={{
                      backgroundColor: theme.colors.surface2,
                      borderRadius: 6,
                      padding: 7,
                      gap: 3,
                    }}
                  >
                    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                      <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>
                        #{post.seq} {post.agent}
                      </Text>
                      {post.time ? (
                        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                          {post.time}
                        </Text>
                      ) : null}
                    </View>
                    <Text
                      selectable
                      style={{ color: theme.colors.foreground, fontSize: 11, lineHeight: 16 }}
                      numberOfLines={6}
                    >
                      {post.text}
                    </Text>
                  </View>
                ))}
              </View>
            ) : (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                #{data.boardSince ?? 0} 之后暂无新帖
              </Text>
            )
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
