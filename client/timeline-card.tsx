import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { agyBoardSliceGet, type SwarmBoardPost } from "../shared/rpc.ts";
import type { AgyQuestionItem, AgyToolCardData } from "../shared/timeline.ts";
import { RichMarkdown } from "./markdown.tsx";
import { clipMarkdownPreview } from "./markdown-normalize.ts";
import {
  formatLocalTimestamp,
  getStatusSnapshot,
  getSubmittedQuestionAnswer,
  openConsoleForAgent,
  resolveMemberChildFromStatus,
  resolveSubagentChildFromStatus,
  setSubmittedQuestionAnswer,
} from "./store.ts";

const RECOMMENDED_RE = /^\s*(?:\(Recommended\)|（推荐）|\[Recommended\])\s*/i;

function parseOptionDisplay(raw: string): { text: string; recommended: boolean } {
  const recommended = RECOMMENDED_RE.test(raw);
  const text = raw.replace(RECOMMENDED_RE, "").trim();
  return { text: text || raw, recommended };
}

function formatQuestionSubmission(
  questions: AgyQuestionItem[],
  selectedByQ: Record<number, number[]>,
  otherByQ: Record<number, string>,
): string {
  const blocks: string[] = [];
  questions.forEach((q, qi) => {
    const indices = [...(selectedByQ[qi] ?? [])].sort((a, b) => a - b);
    const chosen = indices
      .map((idx) => {
        const opt = q.options[idx];
        if (!opt) return null;
        return `[${idx + 1}] ${parseOptionDisplay(opt).text}`;
      })
      .filter((x): x is string => Boolean(x));
    const custom = (otherByQ[qi] ?? "").trim();
    if (custom) chosen.push(custom);
    if (chosen.length === 0) return;

    if (questions.length === 1) {
      if (indices.length === 0 && custom) {
        blocks.push(custom);
      } else {
        blocks.push(`我选择：\n${chosen.map((c) => `- ${c}`).join("\n")}`);
      }
    } else {
      blocks.push(`Q${qi + 1} (${q.question})：${chosen.join("；")}`);
    }
  });
  return blocks.join("\n\n");
}

function AgyQuestionCard({
  agentId,
  data,
  theme,
  timeLabel,
}: {
  agentId: string;
  data: AgyToolCardData;
  theme: PluginTheme;
  timeLabel: string | null;
}) {
  const paseo = usePaseo();
  const questions = data.questions ?? [];
  const answerKey = `${agentId}:${data.callId ?? data.headline}:${questions.map((q) => q.question).join("|")}`;
  const persistedAnswer = getSubmittedQuestionAnswer(answerKey);
  const initialAnswer = data.questionAnswer ?? persistedAnswer ?? null;

  const [submittedAnswer, setSubmittedAnswer] = useState<string | null>(initialAnswer);
  const effectiveAnswer = data.questionAnswer ?? submittedAnswer;
  const isAnswered = Boolean(effectiveAnswer);

  const [collapsed, setCollapsed] = useState<boolean>(isAnswered);
  const [selectedByQ, setSelectedByQ] = useState<Record<number, number[]>>({});
  const [otherByQ, setOtherByQ] = useState<Record<number, string>>({});
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const hasRecommended = useMemo(
    () => questions.some((q) => q.options.some((opt) => parseOptionDisplay(opt).recommended)),
    [questions],
  );

  const totalPickedCount = useMemo(() => {
    let count = 0;
    questions.forEach((_q, qi) => {
      count += (selectedByQ[qi] ?? []).length;
      if ((otherByQ[qi] ?? "").trim().length > 0) count += 1;
    });
    return count;
  }, [questions, selectedByQ, otherByQ]);

  const toggleOption = (qi: number, oi: number, isMulti: boolean) => {
    if (isAnswered || sending) return;
    setSelectedByQ((prev) => {
      const cur = prev[qi] ?? [];
      if (isMulti) {
        const next = cur.includes(oi) ? cur.filter((x) => x !== oi) : [...cur, oi];
        return { ...prev, [qi]: next };
      }
      // Single-select: toggle off if clicking the same option, else switch
      return { ...prev, [qi]: cur.includes(oi) ? [] : [oi] };
    });
    if (!isMulti) {
      setOtherByQ((prev) => (prev[qi] ? { ...prev, [qi]: "" } : prev));
    }
  };

  const applyRecommended = () => {
    if (isAnswered || sending) return;
    const nextSel: Record<number, number[]> = {};
    questions.forEach((q, qi) => {
      const recIndices = q.options
        .map((opt, idx) => (parseOptionDisplay(opt).recommended ? idx : -1))
        .filter((idx) => idx >= 0);
      if (recIndices.length > 0) {
        nextSel[qi] = q.isMultiSelect ? recIndices : [recIndices[0]];
      }
    });
    setSelectedByQ(nextSel);
  };

  const handleSubmit = async () => {
    if (isAnswered || sending || totalPickedCount === 0) return;
    const payload = formatQuestionSubmission(questions, selectedByQ, otherByQ).trim();
    if (!payload) return;
    setSending(true);
    setSendError(null);
    try {
      await paseo.agents.ref(agentId).send(payload);
      const compactSummary = payload.replace(/\s+/g, " ").trim();
      setSubmittedQuestionAnswer(answerKey, compactSummary);
      setSubmittedAnswer(compactSummary);
      setCollapsed(true);
    } catch (err) {
      setSendError(`发送失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <View
      style={{
        gap: 10,
        borderLeftWidth: 3,
        borderLeftColor: isAnswered ? theme.colors.statusSuccess : theme.colors.accent,
        borderTopWidth: 1,
        borderRightWidth: 1,
        borderBottomWidth: 1,
        borderTopColor: theme.colors.border,
        borderRightColor: theme.colors.border,
        borderBottomColor: theme.colors.border,
        borderRadius: 9,
        paddingHorizontal: 12,
        paddingVertical: 10,
        backgroundColor: theme.colors.surface1,
      }}
    >
      {/* Card Header */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
          <View
            style={{
              backgroundColor: theme.colors.surface2,
              borderRadius: 4,
              paddingHorizontal: 6,
              paddingVertical: 2,
            }}
          >
            <Text
              style={{
                color: isAnswered ? theme.colors.statusSuccess : theme.colors.accent,
                fontSize: 11,
                fontWeight: "700",
              }}
            >
              {data.badge}
            </Text>
          </View>
          <Text
            style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600", flexShrink: 1 }}
            numberOfLines={1}
          >
            {data.headline}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text
            style={{
              color: isAnswered ? theme.colors.statusSuccess : theme.colors.statusWarning,
              fontSize: 11,
              fontWeight: "600",
            }}
          >
            {isAnswered ? "✓ 已回复" : "待选择"}
          </Text>
          <Pressable onPress={() => setCollapsed((v) => !v)}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {collapsed ? "展开" : "收起"}
            </Text>
          </Pressable>
          {timeLabel ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontFamily: "monospace" }}>
              {timeLabel}
            </Text>
          ) : null}
        </View>
      </View>

      {isAnswered && collapsed && effectiveAnswer ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={2}>
          {effectiveAnswer}
        </Text>
      ) : null}

      {!collapsed ? (
        <View style={{ gap: 12 }}>
          {questions.map((q, qi) => {
            const selected = selectedByQ[qi] ?? [];
            const customVal = otherByQ[qi] ?? "";
            return (
              <View key={`q-${qi}-${q.question}`} style={{ gap: 6 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", lineHeight: 19 }}>
                    {questions.length > 1 ? `${qi + 1}. ` : ""}
                    {q.question}
                  </Text>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                    {q.isMultiSelect ? "可多选" : "单选"}
                  </Text>
                </View>

                <View style={{ gap: 5 }}>
                  {q.options.map((rawOpt, oi) => {
                    const { text, recommended } = parseOptionDisplay(rawOpt);
                    const checked = selected.includes(oi);
                    return (
                      <Pressable
                        key={`opt-${qi}-${oi}`}
                        disabled={isAnswered || sending}
                        onPress={() => toggleOption(qi, oi, q.isMultiSelect)}
                        style={{
                          flexDirection: "row",
                          alignItems: "flex-start",
                          gap: 9,
                          backgroundColor: checked ? theme.colors.surface2 : theme.colors.surface0,
                          borderColor: checked ? theme.colors.accent : theme.colors.border,
                          borderWidth: 1,
                          borderRadius: 7,
                          paddingHorizontal: 10,
                          paddingVertical: 8,
                          opacity: isAnswered && !checked ? 0.65 : 1,
                        }}
                      >
                        <View
                          style={{
                            width: 16,
                            height: 16,
                            marginTop: 1,
                            borderRadius: q.isMultiSelect ? 4 : 8,
                            borderWidth: 1.5,
                            borderColor: checked ? theme.colors.accent : theme.colors.foregroundMuted,
                            backgroundColor:
                              checked && q.isMultiSelect ? theme.colors.accent : "transparent",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          {checked ? (
                            q.isMultiSelect ? (
                              <Text
                                style={{
                                  color: theme.colors.accentForeground,
                                  fontSize: 10,
                                  fontWeight: "700",
                                  lineHeight: 12,
                                }}
                              >
                                ✓
                              </Text>
                            ) : (
                              <View
                                style={{
                                  width: 8,
                                  height: 8,
                                  borderRadius: 4,
                                  backgroundColor: theme.colors.accent,
                                }}
                              />
                            )
                          ) : null}
                        </View>

                        <View style={{ flex: 1, gap: 2 }}>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
                              [{oi + 1}]
                            </Text>
                            {recommended ? (
                              <View
                                style={{
                                  backgroundColor: theme.colors.surface2,
                                  borderColor: theme.colors.statusSuccess,
                                  borderWidth: 1,
                                  borderRadius: 4,
                                  paddingHorizontal: 5,
                                  paddingVertical: 0.5,
                                }}
                              >
                                <Text style={{ color: theme.colors.statusSuccess, fontSize: 10, fontWeight: "700" }}>
                                  推荐
                                </Text>
                              </View>
                            ) : null}
                            <Text
                              style={{
                                color: theme.colors.foreground,
                                fontSize: 12,
                                lineHeight: 18,
                                flexShrink: 1,
                              }}
                            >
                              {text}
                            </Text>
                          </View>
                        </View>
                      </Pressable>
                    );
                  })}

                  {/* Custom "Other" input matching AGY TUI */}
                  {!isAnswered ? (
                    <TextInput
                      value={customVal}
                      onChangeText={(val) => {
                        setOtherByQ((prev) => ({ ...prev, [qi]: val }));
                        if (!q.isMultiSelect && val.trim().length > 0) {
                          setSelectedByQ((prev) => ({ ...prev, [qi]: [] }));
                        }
                      }}
                      placeholder="其他补充或自定义回答…"
                      placeholderTextColor={theme.colors.foregroundMuted}
                      onSubmitEditing={() => void handleSubmit()}
                      style={{
                        backgroundColor: theme.colors.surface0,
                        borderColor: customVal.trim() ? theme.colors.accent : theme.colors.border,
                        borderWidth: 1,
                        borderRadius: 7,
                        paddingHorizontal: 10,
                        paddingVertical: 7,
                        color: theme.colors.foreground,
                        fontSize: 12,
                      }}
                    />
                  ) : null}
                </View>
              </View>
            );
          })}

          {isAnswered && effectiveAnswer ? (
            <View
              style={{
                backgroundColor: theme.colors.surface2,
                borderRadius: 7,
                paddingHorizontal: 10,
                paddingVertical: 7,
                gap: 2,
              }}
            >
              <Text style={{ color: theme.colors.statusSuccess, fontSize: 11, fontWeight: "600" }}>
                已提交回答
              </Text>
              <Text selectable style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 17 }}>
                {effectiveAnswer}
              </Text>
            </View>
          ) : (
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  {hasRecommended ? (
                    <Pressable
                      disabled={sending}
                      onPress={applyRecommended}
                      style={{
                        backgroundColor: theme.colors.surface2,
                        borderColor: theme.colors.border,
                        borderWidth: 1,
                        borderRadius: 6,
                        paddingHorizontal: 9,
                        paddingVertical: 5,
                      }}
                    >
                      <Text style={{ color: theme.colors.statusSuccess, fontSize: 11, fontWeight: "600" }}>
                        选用推荐
                      </Text>
                    </Pressable>
                  ) : null}
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                    {totalPickedCount > 0 ? `已选 ${totalPickedCount} 项` : "勾选选项或输入自定义内容"}
                  </Text>
                </View>

                <Pressable
                  disabled={sending || totalPickedCount === 0}
                  onPress={() => void handleSubmit()}
                  style={{
                    backgroundColor:
                      sending || totalPickedCount === 0
                        ? theme.colors.surface2
                        : theme.colors.accent,
                    borderRadius: 7,
                    paddingHorizontal: 14,
                    paddingVertical: 6,
                  }}
                >
                  <Text
                    style={{
                      color:
                        sending || totalPickedCount === 0
                          ? theme.colors.foregroundMuted
                          : theme.colors.accentForeground,
                      fontSize: 12,
                      fontWeight: "700",
                    }}
                  >
                    {sending ? "发送中…" : "提交选择"}
                  </Text>
                </Pressable>
              </View>
              {sendError ? (
                <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>{sendError}</Text>
              ) : null}
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

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
  timestamp,
}: PluginTimelineItemProps<AgyToolCardData>) {
  const data = item.data;
  const timeLabel = formatLocalTimestamp(timestamp);
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

  const consoleAction = useMemo((): { label: string; onPress: () => void } | null => {
    if (!data.canOpenConsole) return null;

    if (data.targetMember) {
      const memberName = data.targetMember;
      return {
        label: "看对话",
        onPress: () => {
          const resolved = resolveMemberChildFromStatus(getStatusSnapshot(agentId), memberName);
          if (resolved) {
            openConsoleForAgent(agentId, undefined, { kind: "child", child: resolved });
          } else {
            openConsoleForAgent(agentId, undefined, { kind: "member_by_name", memberName });
          }
        },
      };
    }

    if (data.category === "subagent_invoke" || data.category === "subagent_message") {
      return {
        label: "看对话",
        onPress: () => {
          const ref = {
            id: data.targetSubagentId ?? null,
            role: data.category === "subagent_invoke" ? data.headline : null,
          };
          const resolved = resolveSubagentChildFromStatus(getStatusSnapshot(agentId), ref);
          if (resolved) {
            openConsoleForAgent(agentId, undefined, { kind: "child", child: resolved });
          } else {
            openConsoleForAgent(agentId, undefined, { kind: "subagent_by_ref", ...ref });
          }
        },
      };
    }

    if (
      data.category === "swarm_post" ||
      data.category === "swarm_read" ||
      data.category === "swarm_wait"
    ) {
      const concreteMentions = data.mentions.filter((m) => m !== "coordinator" && m !== "all");
      const boardFilter = concreteMentions.length === 1 ? concreteMentions[0] : undefined;
      return {
        label: "消息板",
        onPress: () => openConsoleForAgent(agentId, undefined, { kind: "board", filter: boardFilter }),
      };
    }

    return {
      label: "控制台",
      onPress: () => openConsoleForAgent(agentId, undefined, { kind: "overview" }),
    };
  }, [agentId, data]);
  if (data.category === "question" && data.questions && data.questions.length > 0) {
    return <AgyQuestionCard agentId={agentId} data={data} theme={theme} timeLabel={timeLabel} />;
  }

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
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Pressable onPress={() => setExpanded((v) => !v)}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                {expanded ? "收起" : "展开"}
              </Text>
            </Pressable>
            {timeLabel ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontFamily: "monospace" }}>
                {timeLabel}
              </Text>
            ) : null}
          </View>
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
          {consoleAction ? (
            <Pressable onPress={consoleAction.onPress}>
              <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "500" }}>
                {consoleAction.label}
              </Text>
            </Pressable>
          ) : null}
          {timeLabel ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontFamily: "monospace" }}>
              {timeLabel}
            </Text>
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
          {data.body ? <RichMarkdown text={data.body} theme={theme} /> : null}

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
                          {formatLocalTimestamp(post.time)}
                        </Text>
                      ) : null}
                    </View>
                    <RichMarkdown text={clipMarkdownPreview(post.text, 600)} theme={theme} />
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
