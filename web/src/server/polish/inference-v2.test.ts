import { describe, expect, it } from "vitest";
import {
  InferenceV2ContractError,
  assertNormalizedUsageV2,
  observedUsage,
  toInferenceRequestV2,
  toInferenceResultV2,
  toLegacyProviderRequest,
  toLegacyProviderResult,
  toLegacyProviderUsage,
  toNormalizedUsageV2,
  unavailableUsage,
  type NormalizedUsageV2,
} from "./inference-v2";

function usage(overrides: Partial<NormalizedUsageV2> = {}): NormalizedUsageV2 {
  return {
    schemaVersion: "normalized_usage_v2",
    inputTotalTokens: 100,
    inputCacheReadTokens: 60,
    inputCacheWriteTokens: null,
    inputStandardTokens: 40,
    outputTokens: 20,
    reasoningTokens: null,
    cacheUsageReporting: "unavailable",
    usageComplete: true,
    ...overrides,
  };
}

describe("NormalizedUsageV2", () => {
  it("accepts reported four-bucket and unavailable three-bucket conservation", () => {
    expect(
      assertNormalizedUsageV2(
        usage({
          inputCacheReadTokens: 50,
          inputCacheWriteTokens: 10,
          inputStandardTokens: 40,
          cacheUsageReporting: "reported",
        }),
      ),
    ).toBeDefined();
    expect(assertNormalizedUsageV2(usage())).toBeDefined();
  });

  it("preserves unknown cache writes as null and rejects a fabricated zero", () => {
    expect(assertNormalizedUsageV2(usage()).inputCacheWriteTokens).toBeNull();
    expect(() =>
      assertNormalizedUsageV2(usage({ inputCacheWriteTokens: 0 })),
    ).toThrow(/must use null/);
    expect(() =>
      assertNormalizedUsageV2(
        usage({ cacheUsageReporting: "reported", inputCacheWriteTokens: null }),
      ),
    ).toThrow(/requires inputCacheWriteTokens/);
  });

  it("requires not-applicable cache buckets to be known zero", () => {
    expect(
      assertNormalizedUsageV2(
        usage({
          inputCacheReadTokens: 0,
          inputCacheWriteTokens: 0,
          inputStandardTokens: 100,
          cacheUsageReporting: "not_applicable",
        }),
      ),
    ).toBeDefined();
    expect(() =>
      assertNormalizedUsageV2(
        usage({
          inputCacheWriteTokens: 0,
          cacheUsageReporting: "not_applicable",
        }),
      ),
    ).toThrow(/zero read and write/);
  });

  it.each([
    ["negative", { outputTokens: -1 }],
    ["fractional", { inputStandardTokens: 39.5, inputTotalTokens: 99.5 }],
    ["unsafe", { outputTokens: Number.MAX_SAFE_INTEGER + 1 }],
    ["bad conservation", { inputTotalTokens: 101 }],
  ])("rejects %s token values", (_label, overrides) => {
    expect(() => assertNormalizedUsageV2(usage(overrides))).toThrow(
      InferenceV2ContractError,
    );
  });

  it("treats reasoning as an output detail and bounds it by output", () => {
    expect(assertNormalizedUsageV2(usage({ reasoningTokens: 5 })).reasoningTokens).toBe(5);
    expect(() => assertNormalizedUsageV2(usage({ reasoningTokens: 21 }))).toThrow(
      /must not exceed/,
    );
  });

  it("derives usage completeness only from the observation discriminant", () => {
    expect(observedUsage(usage({ usageComplete: false }))).toEqual({
      kind: "observed",
      usage: usage({ usageComplete: false }),
    });
    expect(unavailableUsage()).toEqual({
      kind: "unavailable",
      usage: null,
      usageComplete: false,
    });
  });
});

describe("legacy usage converters", () => {
  it("round-trips representable legacy usage without inventing cache writes", () => {
    const legacy = {
      promptTokens: 100,
      completionTokens: 20,
      cachedReadTokens: 60,
      uncachedReadTokens: 40,
    };
    const v2 = toNormalizedUsageV2(legacy);
    expect(v2.inputCacheWriteTokens).toBeNull();
    expect(v2.cacheUsageReporting).toBe("unavailable");
    expect(toLegacyProviderUsage(v2)).toEqual(legacy);
  });

  it("rejects legacy usage that does not conserve input", () => {
    expect(() =>
      toNormalizedUsageV2({
        promptTokens: 100,
        completionTokens: 20,
        cachedReadTokens: 80,
        uncachedReadTokens: 40,
      }),
    ).toThrow(/legacy usage violates input conservation/);
  });

  it.each([
    usage({
      inputCacheReadTokens: 50,
      inputCacheWriteTokens: 10,
      inputStandardTokens: 40,
      cacheUsageReporting: "reported",
    }),
    usage({ reasoningTokens: 5 }),
    usage({ usageComplete: false }),
  ])("rejects V2-only usage semantics", (v2) => {
    expect(() => toLegacyProviderUsage(v2)).toThrow(/not representable/);
  });
});

describe("legacy request/result converters", () => {
  const legacyRequest = {
    messages: [
      { role: "system" as const, content: "stable instruction" },
      { role: "user" as const, content: "variable CV" },
    ],
    maxOutputTokens: 500,
    providerUserId: "pseudonym",
    targets: [{ id: "summary", text: "variable CV" }],
  };

  it("maps legacy roles to stable/variable blocks and back", () => {
    const v2 = toInferenceRequestV2(legacyRequest, {
      outputContract: { kind: "json_object", schemaName: "polish", schema: {} },
      promptVersion: "prompt-v1",
      validatorVersion: "validator-v1",
      language: "zh",
    });
    expect(v2.prompt.explicitCacheBoundaryAfter).toBe("legacy-message-1");
    expect(v2.prompt.blocks.map(({ role, stability }) => ({ role, stability }))).toEqual([
      { role: "developer", stability: "stable" },
      { role: "user", stability: "variable" },
    ]);
    expect(toLegacyProviderRequest(v2)).toEqual(legacyRequest);
  });

  it("rejects V2 request semantics the legacy Chat shape cannot preserve", () => {
    const v2 = toInferenceRequestV2(legacyRequest, {
      outputContract: { kind: "json_schema", schemaName: "polish", schema: {} },
      promptVersion: "prompt-v1",
      validatorVersion: "validator-v1",
      language: "zh",
    });
    expect(() => toLegacyProviderRequest(v2)).toThrow(/cannot preserve json_schema/);
    expect(() =>
      toLegacyProviderRequest({
        ...v2,
        outputContract: { ...v2.outputContract, kind: "json_object" },
        prompt: {
          ...v2.prompt,
          blocks: [{ id: "x", role: "developer", stability: "variable", content: "x" }],
        },
      }),
    ).toThrow(/role\/stability/);
    expect(() =>
      toLegacyProviderRequest({
        ...v2,
        outputContract: { ...v2.outputContract, kind: "json_object" },
        prompt: { ...v2.prompt, explicitCacheBoundaryAfter: "legacy-message-2" },
      }),
    ).toThrow(/stable prefix/);
  });

  it("requires the exact stable-prefix boundary and a variable-only suffix", () => {
    const v2 = toInferenceRequestV2(legacyRequest, {
      outputContract: { kind: "json_object", schemaName: "polish", schema: {} },
      promptVersion: "prompt-v1",
      validatorVersion: "validator-v1",
      language: "zh",
    });
    expect(() =>
      toLegacyProviderRequest({
        ...v2,
        prompt: { ...v2.prompt, explicitCacheBoundaryAfter: undefined },
      }),
    ).toThrow(/final block of the stable prefix/);
    expect(() =>
      toLegacyProviderRequest({
        ...v2,
        prompt: { ...v2.prompt, explicitCacheBoundaryAfter: "legacy-message-2" },
      }),
    ).toThrow(/final block of the stable prefix/);
    expect(() =>
      toLegacyProviderRequest({
        ...v2,
        prompt: {
          blocks: [
            ...v2.prompt.blocks,
            { id: "late-stable", role: "developer", stability: "stable", content: "late" },
          ],
          explicitCacheBoundaryAfter: "legacy-message-1",
        },
      }),
    ).toThrow(/stable prefix followed by a variable suffix/);
  });

  it("forbids a cache boundary when every block is variable", () => {
    const variableOnly = toInferenceRequestV2(
      {
        ...legacyRequest,
        messages: [legacyRequest.messages[1]],
      },
      {
        outputContract: { kind: "json_object", schemaName: "polish", schema: {} },
        promptVersion: "prompt-v1",
        validatorVersion: "validator-v1",
        language: "zh",
      },
    );
    expect(toLegacyProviderRequest(variableOnly).messages).toHaveLength(1);
    expect(() =>
      toLegacyProviderRequest({
        ...variableOnly,
        prompt: {
          ...variableOnly.prompt,
          explicitCacheBoundaryAfter: "legacy-message-1",
        },
      }),
    ).toThrow(/must not declare/);
  });

  it("requires a positive safe maxOutputTokens in both converter directions", () => {
    expect(() =>
      toInferenceRequestV2(
        { ...legacyRequest, maxOutputTokens: 0 },
        {
          outputContract: { kind: "json_object", schemaName: "polish", schema: {} },
          promptVersion: "prompt-v1",
          validatorVersion: "validator-v1",
          language: "zh",
        },
      ),
    ).toThrow(/positive safe integer/);

    const v2 = toInferenceRequestV2(legacyRequest, {
      outputContract: { kind: "json_object", schemaName: "polish", schema: {} },
      promptVersion: "prompt-v1",
      validatorVersion: "validator-v1",
      language: "zh",
    });
    expect(() => toLegacyProviderRequest({ ...v2, maxOutputTokens: 0 })).toThrow(
      /positive safe integer/,
    );
  });

  it("rejects a legacy message order that would cache variable content", () => {
    expect(() =>
      toInferenceRequestV2(
        {
          ...legacyRequest,
          messages: [legacyRequest.messages[1], legacyRequest.messages[0]],
        },
        {
          outputContract: { kind: "json_object", schemaName: "polish", schema: {} },
          promptVersion: "prompt-v1",
          validatorVersion: "validator-v1",
          language: "zh",
        },
      ),
    ).toThrow(/stable prefix/);
  });

  it("round-trips a representable legacy result", () => {
    const legacy = {
      text: "{}",
      finishReason: "stop" as const,
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        cachedReadTokens: 60,
        uncachedReadTokens: 40,
      },
      providerRequestId: "req-1",
    };
    expect(toLegacyProviderResult(toInferenceResultV2(legacy))).toEqual(legacy);
  });

  it("refuses to discard V2-only route and cost facts", () => {
    const v2 = toInferenceResultV2({
      text: "{}",
      finishReason: "stop",
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        cachedReadTokens: 60,
        uncachedReadTokens: 40,
      },
    });
    expect(() =>
      toLegacyProviderResult({
        ...v2,
        route: { ...v2.route, actualModelId: "model-v2" },
      }),
    ).toThrow(/not representable/);
    expect(() =>
      toLegacyProviderResult({
        ...v2,
        providerReportedCost: { currency: "CNY", nanos: "1" },
      }),
    ).toThrow(/not representable/);
  });
});
