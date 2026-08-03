import { afterEach, describe, expect, it } from "vitest";

import {
  DIFF_MAX_MATRIX_CELLS,
  diffTokensToText,
  diffWords,
  tokenizeForDiff,
  type DiffToken,
} from "./word-diff";

function reconstruct(tokens: ReadonlyArray<DiffToken>, types: Array<DiffToken["type"]>) {
  return tokens
    .filter((token) => types.includes(token.type))
    .map((token) => token.text)
    .join("");
}

function expectWellFormed(original: string, polished: string, tokens: DiffToken[]) {
  // Reconstruction invariants.
  expect(reconstruct(tokens, ["same", "removed"])).toBe(original);
  expect(reconstruct(tokens, ["same", "added"])).toBe(polished);
  // Runs are maximal: no two adjacent runs share a type.
  for (let i = 1; i < tokens.length; i += 1) {
    expect(tokens[i].type).not.toBe(tokens[i - 1].type);
  }
  // No empty runs.
  for (const token of tokens) expect(token.text.length).toBeGreaterThan(0);
}

describe("tokenizeForDiff", () => {
  it("preserves the input exactly and splits English on word boundaries", () => {
    const text = "Built scalable systems, fast.";
    const tokens = tokenizeForDiff(text, "en");
    expect(tokens.join("")).toBe(text);
    expect(tokens).toContain("Built");
    expect(tokens).toContain(" ");
    expect(tokens).toContain("systems");
  });

  it("segments Chinese into word-like units when Intl.Segmenter is available", () => {
    const text = "我们开发了系统";
    const tokens = tokenizeForDiff(text, "zh");
    expect(tokens.join("")).toBe(text);
    // Dictionary segmentation should group at least one multi-char word.
    expect(tokens.some((token) => token.length > 1)).toBe(true);
  });

  it("falls back to character level for Chinese without Intl.Segmenter", () => {
    const original = Intl.Segmenter;
    // @ts-expect-error deliberate global removal for the fallback path
    delete Intl.Segmenter;
    try {
      expect(tokenizeForDiff("开发系统", "zh")).toEqual(["开", "发", "系", "统"]);
    } finally {
      // @ts-expect-error restore the global
      Intl.Segmenter = original;
    }
  });

  it("falls back to word/non-word runs for English without Intl.Segmenter", () => {
    const original = Intl.Segmenter;
    // @ts-expect-error deliberate global removal for the fallback path
    delete Intl.Segmenter;
    try {
      expect(tokenizeForDiff("built systems!", "en")).toEqual(["built", " ", "systems", "!"]);
    } finally {
      // @ts-expect-error restore the global
      Intl.Segmenter = original;
    }
  });

  it("returns no tokens for empty text", () => {
    expect(tokenizeForDiff("", "en")).toEqual([]);
  });
});

describe("diffWords", () => {
  it("treats identical texts as one same run", () => {
    const tokens = diffWords("主导订单系统重构", "主导订单系统重构", "zh");
    expect(tokens).toEqual([{ type: "same", text: "主导订单系统重构" }]);
  });

  it("marks an English insertion as an added run between same runs", () => {
    const tokens = diffWords("I built systems", "I built scalable systems", "en");
    expectWellFormed("I built systems", "I built scalable systems", tokens);
    expect(tokens.map((token) => token.type)).toEqual(["same", "added", "same"]);
    expect(tokens[1].text).toContain("scalable");
  });

  it("marks an English deletion as a removed run", () => {
    const tokens = diffWords("I built legacy systems", "I built systems", "en");
    expectWellFormed("I built legacy systems", "I built systems", tokens);
    expect(tokens.map((token) => token.type)).toEqual(["same", "removed", "same"]);
    expect(tokens[1].text).toContain("legacy");
  });

  it("diffs Chinese at word level: a replaced word is removed+added", () => {
    const original = "我们开发了核心系统";
    const polished = "我们设计了核心系统";
    const tokens = diffWords(original, polished, "zh");
    expectWellFormed(original, polished, tokens);
    const removed = tokens.filter((token) => token.type === "removed");
    const added = tokens.filter((token) => token.type === "added");
    expect(removed.map((token) => token.text).join("")).toContain("开发");
    expect(added.map((token) => token.text).join("")).toContain("设计");
    // The shared part stays untouched.
    expect(reconstruct(tokens, ["same"])).toContain("核心系统");
  });

  it("handles a full replacement as removed then added runs", () => {
    const tokens = diffWords("aaaa bbbb", "cccc dddd", "en");
    expectWellFormed("aaaa bbbb", "cccc dddd", tokens);
    expect(tokens[0].type).toBe("removed");
    expect(tokens[tokens.length - 1].type).toBe("added");
  });

  it("handles empty original / empty polished", () => {
    const added = diffWords("", "new text", "en");
    expect(added).toEqual([{ type: "added", text: "new text" }]);
    const removed = diffWords("old text", "", "en");
    expect(removed).toEqual([{ type: "removed", text: "old text" }]);
    expect(diffWords("", "", "en")).toEqual([]);
  });

  it("degrades gracefully beyond the matrix budget and still reconstructs", () => {
    // Two fully different strings whose middles exceed DIFF_MAX_MATRIX_CELLS.
    const side = Math.ceil(Math.sqrt(DIFF_MAX_MATRIX_CELLS)) + 10;
    const original = `共${"甲".repeat(side)}`;
    const polished = `共${"乙".repeat(side)}`;
    const tokens = diffWords(original, polished, "zh");
    expectWellFormed(original, polished, tokens);
    // Kept the common prefix; the differing middle is one removed + one added run.
    expect(tokens[0]).toEqual({ type: "same", text: "共" });
    expect(tokens.map((token) => token.type)).toEqual(["same", "removed", "added"]);
  });

  it("reconstructs across a mixed zh/en corpus", () => {
    const cases: Array<[string, string, "zh" | "en"]> = [
      ["主导订单系统重构，支撑双 11 峰值。", "负责订单系统重构，支撑双 11 峰值与增长。", "zh"],
      ["Led the redesign of checkout", "Drove the redesign of checkout flow", "en"],
      ["GPA 3.8/4.0，获国家奖学金。", "GPA 3.9/4.0，获国家奖学金。", "zh"],
      ["improved p99 latency by 60%", "improved p99 latency by 60% at peak", "en"],
      ["  padded  text  ", "padded text", "en"],
    ];
    for (const [original, polished, language] of cases) {
      expectWellFormed(original, polished, diffWords(original, polished, language));
    }
  });
});

describe("diffTokensToText", () => {
  it("wraps removed in {−…−} and added in {+…+}", () => {
    const tokens = diffWords("I built legacy systems", "I built systems", "en");
    const text = diffTokensToText(tokens);
    expect(text).toContain("{−");
    expect(text).toContain("−}");
    expect(text).toContain("legacy");
    // Same runs pass through unwrapped.
    expect(text).toContain("I built ");
  });
});

afterEach(() => {
  // Guard against a leaked global mutation from the fallback tests.
  expect(typeof Intl.Segmenter).toBe("function");
});
