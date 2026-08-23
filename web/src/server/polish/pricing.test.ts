import { describe, expect, it } from "vitest";
import type { NormalizedUsageV2 } from "./inference-v2";
import {
  PricingContractError,
  calculateEstimatedCost,
  validateFrozenPriceSnapshot,
  type FrozenPriceSnapshotV1,
} from "./pricing";

function usage(overrides: Partial<NormalizedUsageV2> = {}): NormalizedUsageV2 {
  return {
    schemaVersion: "normalized_usage_v2",
    inputTotalTokens: 1_000_000,
    inputCacheReadTokens: 200_000,
    inputCacheWriteTokens: null,
    inputStandardTokens: 800_000,
    outputTokens: 100_000,
    reasoningTokens: 50_000,
    cacheUsageReporting: "unavailable",
    usageComplete: true,
    ...overrides,
  };
}

function linearPrice(
  overrides: Partial<FrozenPriceSnapshotV1> = {},
): FrozenPriceSnapshotV1 {
  return {
    schemaVersion: "price_snapshot_v1",
    priceVersionId: "price-deepseek-offpeak-v1",
    currency: "CNY",
    calculatorKind: "linear_token_v1",
    components: {
      input_standard: "1500000000",
      input_cache_read: "50000000",
      output: "4500000000",
    },
    parameters: {},
    ...overrides,
  };
}

function gptPrice(
  overrides: Partial<FrozenPriceSnapshotV1> = {},
): FrozenPriceSnapshotV1 {
  return {
    schemaVersion: "price_snapshot_v1",
    priceVersionId: "price-gpt-v1",
    currency: "USD",
    calculatorKind: "openai_gpt56_v1",
    components: {
      input_standard: "1000000000",
      input_cache_read: "100000000",
      input_cache_write: "1250000000",
      output: "2000000000",
    },
    parameters: { longContext: null },
    ...overrides,
  };
}

describe("linear_token_v1", () => {
  it("calculates DeepSeek-style cache read, standard input, and output in CNY", () => {
    expect(calculateEstimatedCost(usage(), linearPrice())).toEqual({
      status: "complete",
      estimatedCost: { currency: "CNY", nanos: "1660000000" },
      incompleteReasons: [],
    });
  });

  it("does not count reasoning separately from output", () => {
    const withReasoning = calculateEstimatedCost(usage({ reasoningTokens: 90_000 }), linearPrice());
    const withoutReasoning = calculateEstimatedCost(usage({ reasoningTokens: null }), linearPrice());
    expect(withReasoning).toEqual(withoutReasoning);
  });

  it("allows unknown write tokens only when no separate write charge can change cost", () => {
    expect(
      calculateEstimatedCost(
        usage(),
        linearPrice({
          priceVersionId: "price-mimo-free-write-v1",
          components: {
            input_standard: "3000000000",
            input_cache_read: "25000000",
            input_cache_write: "0",
            output: "6000000000",
          },
        }),
      ).status,
    ).toBe("complete");
    expect(
      calculateEstimatedCost(
        usage(),
        linearPrice({
          components: {
            ...linearPrice().components,
            input_cache_write: "1",
          },
        }),
      ),
    ).toEqual({
      status: "incomplete_usage",
      estimatedCost: null,
      incompleteReasons: ["input_cache_write"],
    });
  });

  it("fails closed when reported writes have no price component", () => {
    expect(
      calculateEstimatedCost(
        usage({
          inputCacheReadTokens: 100_000,
          inputCacheWriteTokens: 100_000,
          inputStandardTokens: 800_000,
          cacheUsageReporting: "reported",
        }),
        linearPrice(),
      ),
    ).toEqual({
      status: "incomplete_usage",
      estimatedCost: null,
      incompleteReasons: ["missing_price_component"],
    });
  });

  it("rounds fractional nanos upward instead of underestimating", () => {
    expect(
      calculateEstimatedCost(
        usage({
          inputTotalTokens: 1,
          inputCacheReadTokens: 0,
          inputStandardTokens: 1,
          outputTokens: 0,
          reasoningTokens: null,
        }),
        linearPrice({
          components: {
            input_standard: "1",
            input_cache_read: "0",
            output: "0",
          },
        }),
      ),
    ).toMatchObject({ estimatedCost: { nanos: "1" } });
  });
});

describe("openai_gpt56_v1", () => {
  const reportedUsage = usage({
    inputCacheReadTokens: 200_000,
    inputCacheWriteTokens: 100_000,
    inputStandardTokens: 700_000,
    cacheUsageReporting: "reported",
  });

  it("prices standard/read/write/output buckets without double-counting reasoning", () => {
    expect(calculateEstimatedCost(reportedUsage, gptPrice())).toEqual({
      status: "complete",
      estimatedCost: { currency: "USD", nanos: "1045000000" },
      incompleteReasons: [],
    });
  });

  it("applies long-context input and output multipliers above the threshold", () => {
    expect(
      calculateEstimatedCost(
        reportedUsage,
        gptPrice({
          parameters: {
            longContext: {
              thresholdInputTokens: 999_999,
              inputMultiplierBps: 20_000,
              outputMultiplierBps: 15_000,
            },
          },
        }),
      ),
    ).toEqual({
      status: "complete",
      estimatedCost: { currency: "USD", nanos: "1990000000" },
      incompleteReasons: [],
    });
  });

  it("returns unknown cost when cache-write usage is unavailable", () => {
    expect(calculateEstimatedCost(usage(), gptPrice())).toEqual({
      status: "incomplete_usage",
      estimatedCost: null,
      incompleteReasons: ["input_cache_write"],
    });
  });
});

describe("price snapshot validation and fail-closed behavior", () => {
  it("retains native currency rather than converting or aggregating it", () => {
    expect(calculateEstimatedCost(usage(), linearPrice({ currency: "CNY" }))).toMatchObject({
      estimatedCost: { currency: "CNY" },
    });
    expect(calculateEstimatedCost(usage(), linearPrice({ currency: "USD" }))).toMatchObject({
      estimatedCost: { currency: "USD" },
    });
  });

  it.each([
    ["unknown calculator", linearPrice({ calculatorKind: "db_code_v1" }), "unknown_calculator"],
    [
      "missing component",
      linearPrice({ components: { input_standard: "1", output: "2" } }),
      "missing_price_component",
    ],
    ["invalid parameters", linearPrice({ parameters: { multiplier: 2 } }), "invalid_price_snapshot"],
  ])("returns null/incomplete for %s", (_label, snapshot, reason) => {
    expect(calculateEstimatedCost(usage(), snapshot)).toEqual({
      status: "incomplete_usage",
      estimatedCost: null,
      incompleteReasons: [reason],
    });
  });

  it("strictly rejects malformed component keys and values in direct validation", () => {
    expect(() =>
      validateFrozenPriceSnapshot(
        linearPrice({
          components: {
            ...linearPrice().components,
            // Runtime input can be untyped JSON even though TS callers cannot name this key.
            request_fee: "1",
          } as FrozenPriceSnapshotV1["components"],
        }),
      ),
    ).toThrow(PricingContractError);
    expect(() =>
      validateFrozenPriceSnapshot(
        linearPrice({ components: { ...linearPrice().components, output: "01" } }),
      ),
    ).toThrow(/canonical non-negative decimal/);
  });

  it("returns incomplete rather than pricing invalid usage", () => {
    expect(calculateEstimatedCost(usage({ inputTotalTokens: 999_999 }), linearPrice())).toEqual({
      status: "incomplete_usage",
      estimatedCost: null,
      incompleteReasons: ["invalid_usage"],
    });
  });
});
