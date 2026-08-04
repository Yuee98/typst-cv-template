import { describe, expect, it, vi } from "vitest";

import {
  classifyGlobalUsage,
  collectAllPages,
  summarizeTokenUsage,
} from "./metrics-logic.mjs";

describe("collectAllPages", () => {
  it("collects a full first page and a one-row second page", async () => {
    const first = Array.from({ length: 1000 }, (_, index) => ({ id: index }));
    const second = [{ id: 1000 }];
    const loadPage = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const rows = await collectAllPages(loadPage);

    expect(rows).toHaveLength(1001);
    expect(rows.at(-1)).toEqual({ id: 1000 });
    expect(loadPage).toHaveBeenNthCalledWith(1, 0, 999);
    expect(loadPage).toHaveBeenNthCalledWith(2, 1000, 1999);
  });
});

describe("summarizeTokenUsage", () => {
  it("keeps known cost from every finalized status and incomplete rows", () => {
    const rows = [
      { status: "succeeded", usage_complete: true, input_cached_tokens: 1, input_uncached_tokens: 2, output_tokens: 3 },
      { status: "invalid_output", usage_complete: true, input_cached_tokens: 4, input_uncached_tokens: 5, output_tokens: 6 },
      { status: "failed_upstream", usage_complete: false, input_cached_tokens: 7, input_uncached_tokens: null, output_tokens: 8 },
      { status: "canceled", usage_complete: false, input_cached_tokens: null, input_uncached_tokens: 9, output_tokens: null },
      { status: "released", usage_complete: false, input_cached_tokens: null, input_uncached_tokens: null, output_tokens: null },
    ];

    const summary = summarizeTokenUsage(rows);

    expect(summary.known).toEqual({ count: 4, totals: { inputCached: 12, inputUncached: 16, output: 17 } });
    expect(summary.complete).toEqual({ count: 2, totals: { inputCached: 5, inputUncached: 7, output: 9 } });
    expect(summary.incompleteKnown).toEqual({ count: 2, totals: { inputCached: 7, inputUncached: 9, output: 8 } });
    expect(summary.completeWithInput.count).toBe(2);
    expect(summary.succeededCompleteWithInput.count).toBe(1);
  });
});

describe("classifyGlobalUsage", () => {
  it("reports a zero limit with zero use as disabled, not OK", () => {
    expect(classifyGlobalUsage(0, 0)).toEqual({ level: "disabled", ratio: null });
  });

  it("preserves alert and critical thresholds", () => {
    expect(classifyGlobalUsage(79, 100).level).toBe("ok");
    expect(classifyGlobalUsage(80, 100).level).toBe("alert");
    expect(classifyGlobalUsage(100, 100).level).toBe("critical");
    expect(classifyGlobalUsage(1, 0).level).toBe("critical");
  });
});
