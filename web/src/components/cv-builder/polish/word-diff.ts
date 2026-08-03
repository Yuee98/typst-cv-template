/**
 * Word-level diff for the polish preview (roadmap「词级 diff」).
 *
 * Tokenization uses `Intl.Segmenter` with word granularity in the content
 * language (dictionary-based Chinese segmentation in modern runtimes). When
 * the Segmenter API is unavailable or throws, the fallback is character
 * level for Chinese and word/non-word runs for English, per the roadmap.
 *
 * The diff itself is a minimal LCS over the token sequences — deliberately
 * NOT a Myers implementation, and no new dependency: common prefix/suffix
 * tokens are trimmed first, so the DP matrix stays small for real edits
 * (polish rewrites are local). Contract-sized inputs (≤2000 original /
 * ≤2400 polished chars) always fit the full matrix; beyond
 * DIFF_MAX_MATRIX_CELLS the diff degrades to "prefix/suffix kept, middle
 * replaced", which still reconstructs both texts exactly.
 */

import type { PolishLanguage } from "@/lib/polish/contract";

export type DiffTokenType = "same" | "added" | "removed";

export interface DiffToken {
  type: DiffTokenType;
  text: string;
}

/**
 * Upper bound on DP matrix cells (n × m of the differing middles) before the
 * diff degrades to prefix/suffix-only. Uint16 cells (LCS lengths fit: inputs
 * are far below 65535 tokens), so 6.25M cells ≈ 12.5 MiB transient.
 */
export const DIFF_MAX_MATRIX_CELLS = 6_250_000;

const EN_FALLBACK_TOKEN = /\w+|\W+/g;

/**
 * Split text into diff tokens, preserving every character: concatenating the
 * tokens always reproduces the input. Word-like and separator segments are
 * kept as separate tokens so unchanged whitespace never glues two words into
 * one displayed run.
 */
export function tokenizeForDiff(text: string, language: PolishLanguage): string[] {
  if (text.length === 0) return [];
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    try {
      const segmenter = new Intl.Segmenter(language, { granularity: "word" });
      return Array.from(segmenter.segment(text), (part) => part.segment);
    } catch {
      // Fall through to the language fallback below.
    }
  }
  if (language === "zh") {
    // Character level (code points, surrogate-pair safe).
    return Array.from(text);
  }
  return text.match(EN_FALLBACK_TOKEN) ?? [];
}

/**
 * Word-level diff of `original` → `polished` as merged runs. Invariants:
 * concatenating same+removed runs reproduces `original`, concatenating
 * same+added runs reproduces `polished`, and no two adjacent runs share a
 * type (runs are maximal).
 */
export function diffWords(
  original: string,
  polished: string,
  language: PolishLanguage,
): DiffToken[] {
  const a = tokenizeForDiff(original, language);
  const b = tokenizeForDiff(polished, language);

  // Trim common prefix / suffix tokens.
  let start = 0;
  const minLength = Math.min(a.length, b.length);
  while (start < minLength && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const tokens: DiffToken[] = [];
  const push = (type: DiffTokenType, text: string) => {
    if (text.length === 0) return;
    const last = tokens[tokens.length - 1];
    if (last && last.type === type) last.text += text;
    else tokens.push({ type, text });
  };

  push("same", a.slice(0, start).join(""));

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length > 0 && midB.length > 0 && midA.length * midB.length <= DIFF_MAX_MATRIX_CELLS) {
    for (const token of lcsDiff(midA, midB)) push(token.type, token.text);
  } else {
    // One side empty, or inputs too large for the matrix: the whole middle
    // is a replacement.
    push("removed", midA.join(""));
    push("added", midB.join(""));
  }

  push("same", a.slice(endA).join(""));
  return tokens;
}

/** Classic LCS backtrack over the (already trimmed) token middles. */
function lcsDiff(a: string[], b: string[]): DiffToken[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // lengths[i * width + j] = LCS length of a[i:], b[j:] (suffix dynamic
  // programming; lengths fit in Uint16 for any realistic polish item).
  const lengths = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = i * width;
    const below = row + width;
    for (let j = m - 1; j >= 0; j -= 1) {
      lengths[row + j] =
        a[i] === b[j]
          ? lengths[below + j + 1] + 1
          : Math.max(lengths[below + j], lengths[row + j + 1]);
    }
  }

  const tokens: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      tokens.push({ type: "same", text: a[i] });
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
      tokens.push({ type: "removed", text: a[i] });
      i += 1;
    } else {
      tokens.push({ type: "added", text: b[j] });
      j += 1;
    }
  }
  while (i < n) tokens.push({ type: "removed", text: a[i++] });
  while (j < m) tokens.push({ type: "added", text: b[j++] });
  return tokens;
}

/** Plain-text equivalent for assistive tech and tests: {−old−} / {+new+}. */
export function diffTokensToText(tokens: ReadonlyArray<DiffToken>): string {
  return tokens
    .map((token) => {
      if (token.type === "removed") return `{−${token.text}−}`;
      if (token.type === "added") return `{+${token.text}+}`;
      return token.text;
    })
    .join("");
}
