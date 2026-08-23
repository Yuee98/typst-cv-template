import { afterEach, describe, expect, it, vi } from "vitest";
import { PolishProviderError, type PolishProviderRequest } from "./provider";
import {
  createFakePolishInferenceProvider,
  createFakePolishProvider,
  DEFAULT_FAKE_DELAY_MS,
  FAKE_PROVIDER_CODEWORDS,
  FAKE_SLOW_EXTRA_DELAY_MS,
  FAKE_V2_MAX_RETRY_AFTER_MS,
  FAKE_V2_SCENARIOS,
} from "./provider-fake";
import type { PolishInferenceRequestV2 } from "./inference-v2";
import { classifyProviderRetry, type ProviderRetryErrorMetadata } from "./provider-error";

const DEFAULT_TARGETS = [{ id: "i0", text: "原始文本 i0，含 40% 与 v1.4。" }] as const;

function makeRequest(
  userContent: string,
  targets: ReadonlyArray<{ id: string; text: string }> = DEFAULT_TARGETS,
): PolishProviderRequest {
  return {
    messages: [
      { role: "system", content: "You polish resume text." },
      { role: "user", content: userContent },
    ],
    maxOutputTokens: 1024,
    providerUserId: "hmac-sha256-hex-pseudonymous-id",
    targets,
  };
}

function callOptions(timeoutMs = 1000): { signal: AbortSignal; timeoutMs: number } {
  return { signal: new AbortController().signal, timeoutMs };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createFakePolishProvider — deterministic output", () => {
  it("echoes each target's original text unchanged, in order", async () => {
    const provider = createFakePolishProvider();
    const targets = [
      { id: "b1", text: "负责后端服务开发，将接口 P99 延迟降低 40%。" },
      { id: "a2", text: "Built the .NET billing pipeline (v1.4)." },
    ];
    const request = makeRequest("polish these items", targets);

    const first = await provider.complete(request, callOptions());
    const second = await provider.complete(request, callOptions());
    expect(second).toEqual(first);

    // Unchanged originals always survive the language / protected-span /
    // length validation pipeline.
    const parsed = JSON.parse(first.text) as { items: { id: string; polished: string }[] };
    expect(parsed.items).toEqual(targets.map((target) => ({ id: target.id, polished: target.text })));
    expect(first.finishReason).toBe("stop");
    expect(first.usage.promptTokens).toBeGreaterThan(0);
    expect(first.usage.uncachedReadTokens).toBe(first.usage.promptTokens);
    expect(first.usage.cachedReadTokens).toBe(0);
  });

  it("takes ids and texts from structured targets, never from the prompt strings", async () => {
    const provider = createFakePolishProvider();
    // The prompt content contains look-alike id fragments that must NOT leak
    // into the output.
    const result = await provider.complete(
      makeRequest('items: {"id":"zz","text":"decoy"}', [{ id: "k1", text: "真正的原文。" }]),
      callOptions(),
    );
    const parsed = JSON.parse(result.text) as { items: { id: string; polished: string }[] };
    expect(parsed.items).toEqual([{ id: "k1", polished: "真正的原文。" }]);
  });

  it("returns an empty items array when targets is empty", async () => {
    const provider = createFakePolishProvider();
    const result = await provider.complete(makeRequest("no targets", []), callOptions());
    expect(JSON.parse(result.text)).toEqual({ items: [] });
  });
});

describe("createFakePolishProvider — codewords", () => {
  it("FAIL_UPSTREAM rejects with PolishProviderError(UPSTREAM_ERROR)", async () => {
    const provider = createFakePolishProvider();
    const promise = provider.complete(
      makeRequest(`trigger ${FAKE_PROVIDER_CODEWORDS.failUpstream}`),
      callOptions(),
    );
    await expect(promise).rejects.toBeInstanceOf(PolishProviderError);
    await expect(promise).rejects.toMatchObject({
      name: "PolishProviderError",
      code: "UPSTREAM_ERROR",
    });
  });

  it("FAIL_JSON resolves with text that is not parseable JSON", async () => {
    const provider = createFakePolishProvider();
    const result = await provider.complete(
      makeRequest(`trigger ${FAKE_PROVIDER_CODEWORDS.failJson}`),
      callOptions(),
    );
    expect(result.finishReason).toBe("stop");
    expect(() => JSON.parse(result.text)).toThrow();
  });

  it("SLOW rejects with PolishProviderError(UPSTREAM_TIMEOUT) at the fake's own timeoutMs", async () => {
    vi.useFakeTimers();
    const provider = createFakePolishProvider();
    const timeoutMs = 50;
    const promise = provider.complete(
      makeRequest(`trigger ${FAKE_PROVIDER_CODEWORDS.slow}`),
      callOptions(timeoutMs),
    );
    const assertion = expect(promise).rejects.toMatchObject({
      name: "PolishProviderError",
      code: "UPSTREAM_TIMEOUT",
    });

    // Past timeoutMs the fake's own timeout must fire even though the
    // simulated latency (timeoutMs + extra) has not elapsed.
    await vi.advanceTimersByTimeAsync(timeoutMs);
    await assertion;
    await expect(promise).rejects.toBeInstanceOf(PolishProviderError);
  });
});

describe("createFakePolishProvider — timeout ownership", () => {
  it("enforces timeoutMs as a hard bound on the normal path (no SLOW codeword)", async () => {
    vi.useFakeTimers();
    const provider = createFakePolishProvider();
    const timeoutMs = DEFAULT_FAKE_DELAY_MS - 1;
    const promise = provider.complete(makeRequest("normal"), callOptions(timeoutMs));
    const assertion = expect(promise).rejects.toMatchObject({
      name: "PolishProviderError",
      code: "UPSTREAM_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_FAKE_DELAY_MS + FAKE_SLOW_EXTRA_DELAY_MS);
    await assertion;
  });

  it("caller abort rejects with AbortError, not UPSTREAM_TIMEOUT", async () => {
    vi.useFakeTimers();
    const provider = createFakePolishProvider();
    const controller = new AbortController();
    const promise = provider.complete(makeRequest(`trigger ${FAKE_PROVIDER_CODEWORDS.slow}`), {
      signal: controller.signal,
      timeoutMs: 50,
    });
    const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
    // Ownership matters: a caller abort must not be normalized into a
    // provider transport error.
    await expect(promise).rejects.not.toBeInstanceOf(PolishProviderError);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const provider = createFakePolishProvider();
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.complete(makeRequest("anything"), {
        signal: controller.signal,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("createFakePolishProvider — simulated latency", () => {
  it("honors the configured default delay", async () => {
    vi.useFakeTimers();
    const provider = createFakePolishProvider();
    const promise = provider.complete(makeRequest("normal"), callOptions());
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_FAKE_DELAY_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(promise).resolves.toMatchObject({ finishReason: "stop" });
  });
});

const V2_TARGETS = [{ id: "target-1", text: "履历正文 secret-cv-content" }] as const;

function makeV2Request(): PolishInferenceRequestV2 {
  return {
    schemaVersion: "polish_inference_request_v2",
    prompt: {
      blocks: [
        {
          id: "developer-1",
          role: "developer",
          stability: "stable",
          content: "Return JSON items only.",
        },
        {
          id: "user-1",
          role: "user",
          stability: "variable",
          content: "Please polish secret-cv-content.",
        },
      ],
      explicitCacheBoundaryAfter: "developer-1",
    },
    outputContract: { kind: "json_object", schemaName: "polish-items", schema: {} },
    maxOutputTokens: 256,
    providerSubjectId: "fake-subject-001",
    promptVersion: "prompt-v2-test",
    validatorVersion: "validator-v2-test",
    language: "zh",
    targets: V2_TARGETS,
  };
}

function v2CallOptions(timeoutMs = 1000): { signal: AbortSignal; timeoutMs: number } {
  return { signal: new AbortController().signal, timeoutMs };
}

describe("createFakePolishInferenceProvider — V2 conformance", () => {
  it("returns deterministic success with all cache buckets, route, and reported cost", async () => {
    const provider = createFakePolishInferenceProvider({ delayMs: 0 });
    const request = makeV2Request();
    const first = await provider.complete(request, v2CallOptions());
    const second = await provider.complete(request, v2CallOptions());

    expect(second).toEqual(first);
    expect(first.usage).toMatchObject({
      inputTotalTokens: 12,
      inputCacheReadTokens: 3,
      inputCacheWriteTokens: 4,
      inputStandardTokens: 5,
      cacheUsageReporting: "reported",
    });
    expect(first.usage.inputTotalTokens).toBe(
      first.usage.inputCacheReadTokens +
        (first.usage.inputCacheWriteTokens ?? 0) +
        first.usage.inputStandardTokens,
    );
    expect(first.route).toEqual({
      gatewayRequestId: "fake-gateway-request-001",
      providerRequestId: "fake-provider-request-001",
      actualUpstreamEndpoint: "https://fake.invalid/v2/responses",
      actualModelId: "fake-v2-model",
      routerAttemptCount: 1,
    });
    expect(first.providerReportedCost).toEqual({ currency: "CNY", nanos: "123456789" });
    expect(first.route).not.toHaveProperty("targets");
    expect(first.route).not.toHaveProperty("content");
    expect(first.text).toContain("secret-cv-content");
  });

  it("supports partial usage without fabricating cache-write zero", async () => {
    const provider = createFakePolishInferenceProvider({
      scenario: FAKE_V2_SCENARIOS.partialUsage,
      delayMs: 0,
    });
    const result = await provider.complete(makeV2Request(), v2CallOptions());
    expect(result.usage).toMatchObject({
      inputTotalTokens: 8,
      inputCacheReadTokens: 3,
      inputCacheWriteTokens: null,
      inputStandardTokens: 5,
      cacheUsageReporting: "unavailable",
      usageComplete: false,
    });
  });

  it("turns missing usage into an explicit unavailable observation", async () => {
    const provider = createFakePolishInferenceProvider({
      scenario: FAKE_V2_SCENARIOS.unavailableUsage,
    });
    await expect(provider.complete(makeV2Request(), v2CallOptions())).rejects.toMatchObject({
      name: "FakePolishInferenceProviderError",
      code: "UPSTREAM_ERROR",
    });
    const outcome = await provider.completeAttempt(makeV2Request(), v2CallOptions());
    expect(outcome).toMatchObject({
      kind: "failed",
      route: {
        providerRequestId: "fake-provider-request-001",
        actualModelId: "fake-v2-model",
      },
      providerBillable: null,
      result: null,
      usageObservation: { kind: "unavailable", usage: null, usageComplete: false },
      failure: {
        code: "UPSTREAM_ERROR",
        retryable: false,
        retryAfterMs: 0,
        providerRequestId: "fake-provider-request-001",
      },
    });
    if (outcome.kind !== "failed") throw new Error("expected failed fake outcome");
    expect(classifyProviderRetry(outcome.failure)).toEqual({
      retryable: false,
      retryAfterMs: 0,
    });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain("secret-cv-content");
    expect(serialized).not.toContain("Please polish");
  });

  it("snapshots safe custom route/cost values and isolates each result", async () => {
    const routeOverride = {
      gatewayRequestId: "gateway-custom-002",
      providerRequestId: "provider-custom-002",
      actualUpstreamEndpoint: "https://custom.invalid/v2/responses",
      actualModelId: "custom-v2-model",
      routerAttemptCount: 2,
    };
    const reportedCost = { currency: "USD", nanos: "42" };
    const provider = createFakePolishInferenceProvider({
      delayMs: 0,
      route: routeOverride,
      providerReportedCost: reportedCost,
    });

    routeOverride.actualModelId = "mutated-after-create";
    reportedCost.nanos = "999";
    const first = await provider.complete(makeV2Request(), v2CallOptions());
    first.route.actualModelId = "mutated-first-result";
    if (first.providerReportedCost) first.providerReportedCost.nanos = "1000";

    const second = await provider.complete(makeV2Request(), v2CallOptions());
    expect(second.route).toEqual({
      gatewayRequestId: "gateway-custom-002",
      providerRequestId: "provider-custom-002",
      actualUpstreamEndpoint: "https://custom.invalid/v2/responses",
      actualModelId: "custom-v2-model",
      routerAttemptCount: 2,
    });
    expect(second.providerReportedCost).toEqual({ currency: "USD", nanos: "42" });
  });

  it.each([
    { route: { actualUpstreamEndpoint: "http://insecure.invalid/v2" } },
    { route: { actualUpstreamEndpoint: "https://user:pass@fake.invalid/v2" } },
    { route: { actualUpstreamEndpoint: "https://fake.invalid/v2?token=secret" } },
    { route: { actualUpstreamEndpoint: "https://fake.invalid/v2\nlog" } },
    { route: { gatewayRequestId: "Bearer secret" } },
    { route: { routerAttemptCount: 0 } },
    { route: { routerAttemptCount: 101 } },
    { route: { unexpected: "field" } },
  ])("fails closed for unsafe route override %#", ({ route }) => {
    expect(() =>
      createFakePolishInferenceProvider({
        route: route as never,
      }),
    ).toThrow(/invalid|unknown fake V2 route/u);
  });

  it.each([
    { currency: "cny", nanos: "1" },
    { currency: "CNY", nanos: "-1" },
    { currency: "CNY", nanos: "1.5" },
    { currency: "CNY", nanos: "1000000000000000000000000000001" },
  ])("fails closed for unsafe provider-reported cost %#", (providerReportedCost) => {
    expect(() => createFakePolishInferenceProvider({ providerReportedCost })).toThrow(
      /invalid fake V2 providerReportedCost/u,
    );
  });

  it("exposes safe bounded Retry-After metadata for 429", async () => {
    const provider = createFakePolishInferenceProvider({
      scenario: FAKE_V2_SCENARIOS.rateLimited,
      retryAfterMs: FAKE_V2_MAX_RETRY_AFTER_MS * 10,
    });
    const sensitive = makeV2Request();
    await expect(provider.complete(sensitive, v2CallOptions())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      upstreamStatus: 429,
      retryAfterMs: FAKE_V2_MAX_RETRY_AFTER_MS,
      providerRequestId: "fake-provider-request-001",
    });
    try {
      await provider.complete(sensitive, v2CallOptions());
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("secret-cv-content");
    }
  });

  it("produces metadata consumable by the shared retry classifier", async () => {
    const cases = [
      {
        scenario: FAKE_V2_SCENARIOS.rateLimited,
        expected: { retryable: true, retryAfterMs: FAKE_V2_MAX_RETRY_AFTER_MS },
      },
      {
        scenario: FAKE_V2_SCENARIOS.serverError,
        expected: { retryable: true, retryAfterMs: 0 },
      },
      {
        scenario: FAKE_V2_SCENARIOS.timeout,
        expected: { retryable: true, retryAfterMs: 0 },
      },
    ] as const;

    for (const { scenario, expected } of cases) {
      vi.useFakeTimers();
      const provider = createFakePolishInferenceProvider({
        scenario,
        retryAfterMs: FAKE_V2_MAX_RETRY_AFTER_MS * 10,
      });
      const promise = provider.complete(makeV2Request(), v2CallOptions(50));
      const failure = promise.catch((error: unknown) => error);
      if (scenario === FAKE_V2_SCENARIOS.timeout) {
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(
        classifyProviderRetry((await failure) as ProviderRetryErrorMetadata),
      ).toEqual(expected);
      vi.useRealTimers();
    }
  });

  it("exposes safe 5xx metadata without a raw response body", async () => {
    const provider = createFakePolishInferenceProvider({
      scenario: FAKE_V2_SCENARIOS.serverError,
    });
    await expect(provider.complete(makeV2Request(), v2CallOptions())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      upstreamStatus: 503,
      providerRequestId: "fake-provider-request-001",
    });
  });

  it("enforces the single-call timeout", async () => {
    vi.useFakeTimers();
    const provider = createFakePolishInferenceProvider({ scenario: FAKE_V2_SCENARIOS.timeout });
    const promise = provider.complete(makeV2Request(), v2CallOptions(50));
    const assertion = expect(promise).rejects.toMatchObject({
      name: "FakePolishInferenceProviderError",
      code: "UPSTREAM_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("preserves caller cancellation as AbortError", async () => {
    vi.useFakeTimers();
    const provider = createFakePolishInferenceProvider({ delayMs: 100 });
    const controller = new AbortController();
    const promise = provider.complete(makeV2Request(), {
      signal: controller.signal,
      timeoutMs: 1000,
    });
    const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
  });

  it.each([
    FAKE_V2_SCENARIOS.rateLimited,
    FAKE_V2_SCENARIOS.serverError,
    FAKE_V2_SCENARIOS.timeout,
  ])("does not swallow transport scenario %s in completeAttempt", async (scenario) => {
    vi.useFakeTimers();
    const provider = createFakePolishInferenceProvider({ scenario });
    const promise = provider.completeAttempt(makeV2Request(), v2CallOptions(50));
    const assertion = expect(promise).rejects.toBeInstanceOf(Error);
    if (scenario === FAKE_V2_SCENARIOS.timeout) {
      await vi.advanceTimersByTimeAsync(50);
    }
    await assertion;
  });

  it("does not swallow cancellation in completeAttempt", async () => {
    vi.useFakeTimers();
    const provider = createFakePolishInferenceProvider({ delayMs: 100 });
    const controller = new AbortController();
    const promise = provider.completeAttempt(makeV2Request(), {
      signal: controller.signal,
      timeoutMs: 1000,
    });
    const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
  });
});
