import { useMemo } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Markdown } from "@getpaseo/plugin/client/ui";
import { normalizeMarkdownForPaseo } from "./markdown-normalize.ts";

export function RichMarkdown({
  text,
  theme,
}: {
  text: string;
  theme: PluginTheme;
}) {
  const normalized = useMemo(() => normalizeMarkdownForPaseo(text), [text]);
  if (!normalized) return null;

  if (typeof Markdown === "function" || (Markdown && typeof Markdown === "object")) {
    return (
      <View style={{ width: "100%", flexShrink: 1 }}>
        <Markdown>{normalized}</Markdown>
      </View>
    );
  }

  return (
    <Text selectable style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 18 }}>
      {normalized}
    </Text>
  );
}
