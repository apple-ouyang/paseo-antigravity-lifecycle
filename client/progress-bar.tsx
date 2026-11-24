import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { ProgressSummary } from "../shared/rpc.ts";

export function formatDurationShort(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 && min < 10 ? `${min}m${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h${remMin}m` : `${hr}h`;
}

export function formatEtaLabel(progress: ProgressSummary): string | null {
  switch (progress.etaState) {
    case "done":
      return "已全部完成";
    case "estimated":
      return progress.etaMs !== null ? `预计剩 ~${formatDurationShort(progress.etaMs)}` : null;
    case "over_avg":
      return "已超均值，收尾中";
    case "estimating":
      return "首个完成后估算剩余";
    case "none":
      return null;
  }
}

export function ProgressMeter({
  progress,
  theme,
  compact = false,
}: {
  progress: ProgressSummary;
  theme: PluginTheme;
  compact?: boolean;
}) {
  const total = Math.max(1, progress.total);
  const doneFlex = progress.completed;
  const runFlex = progress.running;
  const failFlex = progress.failed;
  const remFlex = Math.max(0, total - doneFlex - runFlex - failFlex);
  const elapsed = formatDurationShort(progress.elapsedMs);
  const eta = formatEtaLabel(progress);
  const avg = formatDurationShort(progress.avgDurationMs);

  return (
    <View
      style={{
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: compact ? 9 : 11,
        paddingVertical: compact ? 7 : 9,
        gap: 6,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, flexShrink: 1 }}>
          <Text
            style={{
              color:
                progress.percent === 100
                  ? theme.colors.statusSuccess
                  : progress.failed > 0
                    ? theme.colors.statusDanger
                    : theme.colors.accent,
              fontSize: compact ? 15 : 17,
              fontWeight: "700",
            }}
          >
            {progress.percent}%
          </Text>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
            {progress.completed}/{progress.total} {progress.scopeLabel}
          </Text>
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
          {[
            progress.running > 0 ? `${progress.running} 运行` : null,
            progress.waiting > 0 ? `${progress.waiting} 待命` : null,
            progress.failed > 0 ? `${progress.failed} 失败` : null,
          ]
            .filter(Boolean)
            .join(" · ") || "全部完成"}
        </Text>
      </View>

      {/* Multi-segment progress bar: green=done, accent=running, red=failed, track=remaining */}
      <View
        style={{
          height: compact ? 5 : 6,
          borderRadius: 99,
          backgroundColor: theme.colors.surface0,
          overflow: "hidden",
          flexDirection: "row",
        }}
      >
        {doneFlex > 0 ? (
          <View style={{ flex: doneFlex, backgroundColor: theme.colors.statusSuccess }} />
        ) : null}
        {runFlex > 0 ? (
          <View style={{ flex: runFlex, backgroundColor: theme.colors.accent }} />
        ) : null}
        {failFlex > 0 ? (
          <View style={{ flex: failFlex, backgroundColor: theme.colors.statusDanger }} />
        ) : null}
        {remFlex > 0 ? <View style={{ flex: remFlex }} /> : null}
      </View>

      {elapsed || eta || avg ? (
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
            {[
              elapsed ? `已耗时 ${elapsed}` : null,
              avg && progress.completed > 0 ? `均耗 ${avg}/人` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          {eta ? (
            <Text
              style={{
                color:
                  progress.etaState === "done"
                    ? theme.colors.statusSuccess
                    : progress.etaState === "over_avg"
                      ? theme.colors.statusWarning
                      : theme.colors.accent,
                fontSize: 10,
                fontWeight: "600",
              }}
            >
              {eta}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
