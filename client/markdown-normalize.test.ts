import assert from "node:assert/strict";
import test from "node:test";
import { clipMarkdownPreview, normalizeMarkdownForPaseo } from "./markdown-normalize.ts";

test("normalizeMarkdownForPaseo fixes bold inner whitespace and converts LaTeX delimiters without touching code", () => {
  const sample = [
    "1. **【BLOCK-1: 真 21 维 $G_{\\rm PS}$ 单态 Pfaffian 全筛】 **",
    "   - 删去将 `S1`/`S2` 冒充 $G_{\\rm PS}$ 单态的不实宣称（$\\Phi_1(\\mathbf 1_c,\\mathbf 2_L,\\mathbf 2_R)$）",
    "   - 替换 `nu_weyl % 16` 字面量，内联公式 \\(\\sqrt{2\\tau_{\\rm int}}\\) 与块公式：",
    "\\[",
    "\\mathrm{Pf}\\,M(\\phi) \\ge 0",
    "\\]",
    "2. **【BLOCK-2: 消除欧拉反常双标偷换荷 & 杜绝 `nu % 16` 字面量】 **",
    "3. 穷举出的**【核心结论】**与 `**不要改代码内空格 **`",
    "```python",
    "# **keep code fence ** and \\(a+b\\)",
    "x = 2 * 3",
    "```",
  ].join("\n");

  const out = normalizeMarkdownForPaseo(sample);

  // Trailing space inside **...** fixed even when bold wraps inline code or math
  assert.ok(out.includes("1. **【BLOCK-1: 真 21 维 $G_{\\rm PS}$ 单态 Pfaffian 全筛】**"));
  assert.ok(out.includes("2. **【BLOCK-2: 消除欧拉反常双标偷换荷 & 杜绝 `nu % 16` 字面量】**"));
  assert.ok(!out.includes("全筛】 **"));
  assert.ok(!out.includes("字面量】 **"));

  // Existing $...$ math untouched
  assert.ok(out.includes("$\\Phi_1(\\mathbf 1_c,\\mathbf 2_L,\\mathbf 2_R)$"));

  // \(...\) and \[...\] converted to $...$ and $$...$$
  assert.ok(out.includes("$\\sqrt{2\\tau_{\\rm int}}$"));
  assert.ok(out.includes("$$\n\\mathrm{Pf}\\,M(\\phi) \\ge 0\n$$"));

  // CJK flanking before `**【` gets a space so CommonMark opens bold cleanly
  assert.ok(out.includes("穷举出的 **【核心结论】** 与"));

  // Inline code and fenced code remain untouched
  assert.ok(out.includes("`**不要改代码内空格 **`"));
  assert.ok(out.includes("# **keep code fence ** and \\(a+b\\)"));
});

test("clipMarkdownPreview avoids leaving unclosed math or code fences", () => {
  const raw = "前文说明\n第二行包含公式 $G_{\\rm PS} = SU(4)_c \\times SU(2)_L \\times SU(2)_R$ 以及后续说明文字。";
  const clipped = clipMarkdownPreview(raw, 28);
  assert.ok(!clipped.includes("$G_{\\rm PS}"));
  assert.ok(clipped.endsWith("…"));

  const fenced = "示例：\n```ts\nconst a = 1;\nconst b = 2;\n```\n尾部";
  const clippedFence = clipMarkdownPreview(fenced, 24);
  const fenceCount = (clippedFence.match(/```/g) ?? []).length;
  assert.equal(fenceCount % 2, 0);
});
