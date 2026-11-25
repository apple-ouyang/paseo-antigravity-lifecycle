import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { parseModelAndEffort } from "./store.ts";

function effortColor(effort: string, theme: PluginTheme): string {
  switch (effort.toLowerCase()) {
    case "xhigh":
    case "max":
      return theme.colors.statusWarning;
    case "high":
      return theme.colors.accent;
    case "medium":
      return theme.colors.statusSuccess;
    default:
      return theme.colors.foregroundMuted;
  }
}

export function ModelEffortBadge({
  model,
  theme,
  compact = false,
}: {
  model: string | null | undefined;
  theme: PluginTheme;
  compact?: boolean;
}) {
  const parsed = parseModelAndEffort(model);
  if (!parsed) return null;

  const fontSize = compact ? 9 : 10;
  const padH = compact ? 4 : 5;
  const padV = compact ? 0.5 : 1;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 3,
        flexShrink: 0,
      }}
    >
      <View
        style={{
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 4,
          paddingHorizontal: padH,
          paddingVertical: padV,
          maxWidth: compact ? 135 : 165,
        }}
      >
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize,
            fontFamily: "monospace",
          }}
          numberOfLines={1}
        >
          {parsed.modelId}
        </Text>
      </View>
      {parsed.effort ? (
        <View
          style={{
            backgroundColor: theme.colors.surface2,
            borderColor: theme.colors.border,
            borderWidth: 1,
            borderRadius: 4,
            paddingHorizontal: padH,
            paddingVertical: padV,
          }}
        >
          <Text
            style={{
              color: effortColor(parsed.effort, theme),
              fontSize,
              fontWeight: "600",
            }}
            numberOfLines={1}
          >
            {parsed.effort}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
