/**
 * Normalizes LLM-generated Markdown & LaTeX math before handing text to
 * Paseo's native `<Markdown>` (`md4c` + KaTeX) renderer.
 *
 * Strictly protects fenced code blocks (``` / ~~~) and inline code spans (`...`)
 * via placeholder masking so code is never altered while bold spans that wrap
 * inline code or math (e.g. `**【BLOCK-2: 杜绝 \`nu % 16\` 字面量】 **`) still
 * normalize cleanly.
 */

const OPENING_PUNCT = /^[\p{Ps}\p{Pi}「『【（《〈“‘]/u;
const CLOSING_PUNCT = /[\p{Pe}\p{Pf}」』】）》〉”’]$/u;
const WORD_OR_CJK_END = /[\p{L}\p{N}]$/u;
const WORD_OR_CJK_START = /^[\p{L}\p{N}]/u;

function normalizeBoldLine(line: string): string {
  // Trim accidental whitespace inside **...** delimiters (e.g. `**【BLOCK-1】 **` -> `**【BLOCK-1】**`),
  // which CommonMark/md4c otherwise refuses to close, leaving literal `**` visible.
  return line.replace(
    /\*\*((?:[^\n*]|\*(?!\*))+?)\*\*/g,
    (match, inner: string, offset: number, full: string) => {
      const trimmed = inner.trim();
      if (!trimmed) return match;
      const prevChar = offset > 0 ? full[offset - 1] : "";
      const nextChar = offset + match.length < full.length ? full[offset + match.length] : "";
      // CommonMark flanking safeguard: a CJK/word char directly before `**` followed by opening
      // punctuation (e.g. `的**【标题】**`) is not left-flanking unless separated by a space.
      const prefix = prevChar && WORD_OR_CJK_END.test(prevChar) && OPENING_PUNCT.test(trimmed) ? " " : "";
      const suffix = nextChar && WORD_OR_CJK_START.test(nextChar) && CLOSING_PUNCT.test(trimmed) ? " " : "";
      return `${prefix}**${trimmed}**${suffix}`;
    },
  );
}

function normalizeLatexDelimiters(segment: string): string {
  // Convert display math `\[ ... \]` -> `$$\n...\n$$`
  let out = segment.replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return _m;
    return `\n$$\n${trimmed}\n$$\n`;
  });

  // Convert inline math `\( ... \)` -> `$...$`
  out = out.replace(/\\\(([^\n]+?)\\\)/g, (_m, body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return _m;
    return `$${trimmed}$`;
  });

  return out;
}

function maskInlineCodeSpans(segment: string): { masked: string; tokens: string[] } {
  const tokens: string[] = [];
  const out: string[] = [];
  let cursor = 0;
  let i = 0;
  const n = segment.length;

  while (i < n) {
    if (segment[i] === "`") {
      let ticks = 0;
      while (i + ticks < n && segment[i + ticks] === "`") ticks += 1;
      const delim = "`".repeat(ticks);
      let searchFrom = i + ticks;
      let matchedEnd = -1;
      while (searchFrom < n) {
        const closeIdx = segment.indexOf(delim, searchFrom);
        if (closeIdx === -1) break;
        const after = closeIdx + ticks;
        const prevIsTick = closeIdx > 0 && segment[closeIdx - 1] === "`";
        const nextIsTick = after < n && segment[after] === "`";
        if (!prevIsTick && !nextIsTick) {
          matchedEnd = after;
          break;
        }
        searchFrom = after;
      }
      if (matchedEnd !== -1) {
        if (i > cursor) out.push(segment.slice(cursor, i));
        const token = `\uE012C${tokens.length}\uE013`;
        tokens.push(segment.slice(i, matchedEnd));
        out.push(token);
        i = matchedEnd;
        cursor = matchedEnd;
        continue;
      }
      i += ticks;
      continue;
    }
    i += 1;
  }

  if (cursor < n) out.push(segment.slice(cursor));
  return { masked: out.join(""), tokens };
}

function transformNonFenceSegment(segment: string): string {
  if (!segment) return segment;
  // 1. Mask inline code spans so neither LaTeX conversion nor bold trimming touches code
  const { masked: codeMasked, tokens: codeTokens } = maskInlineCodeSpans(segment);

  // 2. Convert \(...\) and \[...\] to $...$ and $$...$$
  const withMath = normalizeLatexDelimiters(codeMasked);

  // 3. Mask $...$ and $$...$$ math regions so `*` inside math (e.g. `a_*`) stays untouched
  const mathTokens: string[] = [];
  const mathMasked = withMath.replace(/\$\$[\s\S]+?\$\$|\$(?!\s)(?:\\.|[^$\n\\])+?(?<!\s)\$/g, (m) => {
    const token = `\uE010M${mathTokens.length}\uE011`;
    mathTokens.push(m);
    return token;
  });

  // 4. Normalize bold delimiters per line (fixes `**【BLOCK-2: ... `nu % 16` 字面量】 **`)
  const normalizedBold = mathMasked
    .split("\n")
    .map((line) => normalizeBoldLine(line))
    .join("\n");

  // 5. Restore math tokens, then inline code tokens
  const restoredMath = normalizedBold.replace(
    /\uE010M(\d+)\uE011/g,
    (_m, idx: string) => mathTokens[Number(idx)] ?? "",
  );
  return restoredMath.replace(
    /\uE012C(\d+)\uE013/g,
    (_m, idx: string) => codeTokens[Number(idx)] ?? "",
  );
}

export function normalizeMarkdownForPaseo(raw: string): string {
  if (!raw) return "";
  const lines = raw.split("\n");
  const result: string[] = [];
  let proseBuf: string[] = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;

  const flushProse = () => {
    if (proseBuf.length === 0) return;
    result.push(transformNonFenceSegment(proseBuf.join("\n")));
    proseBuf = [];
  };

  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!inFence) {
      if (fenceMatch) {
        flushProse();
        inFence = true;
        fenceChar = fenceMatch[1][0];
        fenceLen = fenceMatch[1].length;
        result.push(line);
      } else {
        proseBuf.push(line);
      }
    } else {
      result.push(line);
      const trimmed = line.trim();
      if (trimmed.length >= fenceLen && trimmed.split("").every((c) => c === fenceChar)) {
        inFence = false;
        fenceChar = "";
        fenceLen = 0;
      }
    }
  }
  flushProse();

  return result.join("\n");
}

/**
 * Clips a Markdown string cleanly for collapsed previews without cutting inside
 * a fenced code block or leaving an unclosed `$...$` math span.
 */
export function clipMarkdownPreview(raw: string, maxChars = 360): string {
  const trimmed = raw.trim();
  if (trimmed.length <= maxChars) return trimmed;
  let slice = trimmed.slice(0, maxChars);
  const lastNl = slice.lastIndexOf("\n");
  if (lastNl > maxChars * 0.55) {
    slice = slice.slice(0, lastNl);
  }
  const fenceMatches = slice.match(/^\s{0,3}(?:```|~~~)/gm);
  if (fenceMatches && fenceMatches.length % 2 === 1) {
    slice = `${slice}\n\`\`\``;
  }
  const strippedCode = slice.replace(/`[^`\n]*`/g, "");
  const singleDollars = (strippedCode.match(/(?<!\\)(?<!\$)\$(?!\$)/g) ?? []).length;
  if (singleDollars % 2 === 1) {
    const lastDollar = slice.lastIndexOf("$");
    if (lastDollar > 0) {
      slice = slice.slice(0, lastDollar).trimEnd();
    }
  }
  return `${slice.trimEnd()} …`;
}
