import { describe, expect, it, vi } from "vitest";
import { computePolishMaxOutputTokens, type PolishRequest } from "@/lib/polish/contract";
import {
  addPolishUsage,
  aggregatePolishAttemptFactsV2,
  MIN_RETRY_BUDGET_MS,
  orchestratePolish,
  orchestratePolishV2,
  POLISH_MAX_ATTEMPTS,
  POLISH_TOTAL_DEADLINE_MS,
  PolishAttemptPersistenceErrorV2,
  PolishUsageAggregationError,
  zeroPolishUsage,
  type PolishAttemptCompletedEventV2,
  type PolishAttemptCompletedFactV2,
  type PolishInferenceAttemptOutcomeV2,
  type PolishInferenceProviderV2,
  type PolishOrchestrateV2Options,
  type PolishProvider,
  type PolishProviderRequest,
  type PolishProviderResult,
  type PolishProviderUsage,
} from "./orchestrator";
import {
  observedUsage,
  unavailableUsage,
  type NormalizedUsageV2,
  type PolishInferenceRequestV2,
  type PolishInferenceResultV2,
} from "./inference-v2";
import {
  createFakePolishInferenceProvider,
  FAKE_V2_SCENARIOS,
  FAKE_V2_USAGE_FIXTURES,
} from "./provider-fake";
import type { FrozenPriceSnapshotV1 } from "./pricing";
import { MAX_PROVIDER_RETRY_AFTER_MS } from "./provider-error";

const VALID_ZH_POLISHED = "负责后端核心服务的开发与优化，将 P99 延迟降低 40%。";
/** Pseudonymous id the handler would inject; forwarded to the provider unchanged. */
const TEST_PROVIDER_USER_ID = "1".repeat(63) + "b";

function makeRequest(overrides: Partial<PolishRequest> = {}): PolishRequest {
  return {
    clientRequestId: "123e4567-e89b-42d3-a456-426614174000",
    granularity: "item",
    sectionId: "experience",
    language: "zh",
    items: [{ id: "i0", kind: "experience_bullet", text: "负责后端服务开发，将 P99 延迟降低 40%。" }],
    context: { level: 0, references: [] },
    ...overrides,
  };
}

/** Options every orchestratePolish call needs; override per test as needed. */
function callOpts(
  signal: AbortSignal,
  extra: Partial<Parameters<typeof orchestratePolish>[2]> = {},
): Parameters<typeof orchestratePolish>[2] {
  return { signal, providerUserId: TEST_PROVIDER_USER_ID, ...extra };
}

function usage(overrides: Partial<PolishProviderUsage> = {}): PolishProviderUsage {
  return { promptTokens: 100, completionTokens: 50, cachedReadTokens: 60, uncachedReadTokens: 40, ...overrides };
}

function successResult(polished: string = VALID_ZH_POLISHED, u: PolishProviderUsage = usage()): PolishProviderResult {
  return { text: JSON.stringify({ items: [{ id: "i0", polished }] }), finishReason: "stop", usage: u };
}

interface ProviderCall {
  request: PolishProviderRequest;
  options: { signal: AbortSignal; timeoutMs: number };
}

type ProviderBehavior = (call: ProviderCall) => Promise<PolishProviderResult>;

/** Mock provider: each behavior handles one attempt, in order. */
function makeMockProvider(...behaviors: ProviderBehavior[]): { provider: PolishProvider; calls: ProviderCall[] } {
  const calls: ProviderCall[] = [];
  const provider: PolishProvider = {
    complete(request, options) {
      const call: ProviderCall = { request, options };
      calls.push(call);
      const behavior = behaviors[calls.length - 1];
      if (!behavior) return Promise.reject(new Error(`unexpected attempt ${calls.length}`));
      return behavior(call);
    },
  };
  return { provider, calls };
}

function resolveWith(result: PolishProviderResult): ProviderBehavior {
  return () => Promise.resolve(result);
}

function rejectWith(error: unknown): ProviderBehavior {
  return () => Promise.reject(error);
}

function providerError(
  code: "UPSTREAM_ERROR" | "UPSTREAM_TIMEOUT",
  message: string,
  metadata: { upstreamStatus?: number; retryable?: boolean; retryAfterMs?: number } = {},
): Error {
  return Object.assign(new Error(message), { code, ...metadata });
}

function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

const V2_PRICE: FrozenPriceSnapshotV1 = {
  schemaVersion: "price_snapshot_v1",
  priceVersionId: "price-v2-test",
  currency: "CNY",
  calculatorKind: "linear_token_v1",
  components: {
    input_standard: "1000000000",
    input_cache_read: "500000000",
    input_cache_write: "750000000",
    output: "2000000000",
  },
  parameters: {},
};

const V2_REPORTED_USAGE: NormalizedUsageV2 = {
  schemaVersion: "normalized_usage_v2",
  inputTotalTokens: 100,
  inputCacheReadTokens: 60,
  inputCacheWriteTokens: 10,
  inputStandardTokens: 30,
  outputTokens: 20,
  reasoningTokens: 5,
  cacheUsageReporting: "reported",
  usageComplete: true,
};

const V2_UNAVAILABLE_WRITE_USAGE: NormalizedUsageV2 = {
  schemaVersion: "normalized_usage_v2",
  inputTotalTokens: 100,
  inputCacheReadTokens: 60,
  inputCacheWriteTokens: null,
  inputStandardTokens: 40,
  outputTokens: 20,
  reasoningTokens: null,
  cacheUsageReporting: "unavailable",
  usageComplete: true,
};

function v2Result(
  text = JSON.stringify({ items: [{ id: "i0", polished: VALID_ZH_POLISHED }] }),
  usageValue: NormalizedUsageV2 = V2_REPORTED_USAGE,
): PolishInferenceResultV2 {
  return {
    schemaVersion: "polish_inference_result_v2",
    text,
    finishReason: "stop",
    usage: usageValue,
    route: {
      gatewayRequestId: "gateway-1",
      providerRequestId: "provider-1",
      actualUpstreamEndpoint: "https://api.example.invalid/v1/responses",
      actualModelId: "model-v2",
      routerAttemptCount: 1,
    },
    providerReportedCost: { currency: "CNY", nanos: "999" },
  };
}

function v2Options<TStartResult = unknown>(
  signal: AbortSignal,
  extra: Partial<PolishOrchestrateV2Options<TStartResult>> = {},
): PolishOrchestrateV2Options<TStartResult> {
  return {
    signal,
    providerSubjectId: TEST_PROVIDER_USER_ID,
    frozenPrice: V2_PRICE,
    ...extra,
  };
}

interface V2ProviderCall {
  request: PolishInferenceRequestV2;
  options: { signal: AbortSignal; timeoutMs: number };
}

type V2ProviderBehavior = (call: V2ProviderCall) => Promise<PolishInferenceResultV2>;

function makeV2Provider(
  ...behaviors: V2ProviderBehavior[]
): { provider: PolishInferenceProviderV2; calls: V2ProviderCall[] } {
  const calls: V2ProviderCall[] = [];
  return {
    calls,
    provider: {
      complete(request, options) {
        const call = { request, options };
        calls.push(call);
        const behavior = behaviors[calls.length - 1];
        if (!behavior) return Promise.reject(new Error(`unexpected V2 attempt ${calls.length}`));
        return behavior(call);
      },
    },
  };
}

describe("addPolishUsage", () => {
  it("sums every field", () => {
    expect(
      addPolishUsage(
        { promptTokens: 1, completionTokens: 2, cachedReadTokens: 3, uncachedReadTokens: 4 },
        { promptTokens: 10, completionTokens: 20, cachedReadTokens: 30, uncachedReadTokens: 40 },
      ),
    ).toEqual({ promptTokens: 11, completionTokens: 22, cachedReadTokens: 33, uncachedReadTokens: 44 });
  });

  it("zeroPolishUsage is the identity", () => {
    expect(addPolishUsage(zeroPolishUsage(), usage())).toEqual(usage());
  });
});

describe("orchestratePolish — success paths", () => {
  it("succeeds on the first attempt and passes budget + prompt through", async () => {
    const { provider, calls } = makeMockProvider(resolveWith(successResult()));
    const result = await orchestratePolish(provider, makeRequest(), callOpts(new AbortController().signal, { now: fakeClock().now }));

    expect(result.items).toEqual([{ id: "i0", polished: VALID_ZH_POLISHED }]);
    expect(result.usage).toEqual(usage());
    expect(result.attempts).toBe(1);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.options.timeoutMs).toBe(POLISH_TOTAL_DEADLINE_MS);
    // dynamic max_tokens from the contract's single-source helper:
    // 1 item × 24 chars → min(2400, 36+40)=76 → 76 + 1692 envelope = 1768
    expect(call.request.maxOutputTokens).toBe(computePolishMaxOutputTokens(makeRequest().items));
    expect(call.request.maxOutputTokens).toBe(1768);
    // pinned interface fields: pseudonymous id forwarded unchanged, targets
    // metadata from the validated request items (fake echo / validation only)
    expect(call.request.providerUserId).toBe(TEST_PROVIDER_USER_ID);
    expect(call.request.targets).toEqual(
      makeRequest().items.map((item) => ({ id: item.id, text: item.text })),
    );
    expect(call.request.messages).toHaveLength(2);
    expect(call.request.messages[0].role).toBe("system");
    expect(call.request.messages[1].role).toBe("user");
    expect(call.request.messages[1].content).toContain('<item id="i0">');
    // first attempt has no retry feedback
    expect(call.request.messages[1].content).not.toContain("failed validation");
    // clientRequestId is never sent to the provider
    expect(JSON.stringify(call.request)).not.toContain("123e4567-e89b-42d3-a456-426614174000");
  });

  it("retries after a validation failure with the reason in the retry prompt, then succeeds", async () => {
    const invalid: PolishProviderResult = {
      text: JSON.stringify({ items: [{ id: "i0", polished: "将延迟降低 99%。" }] }), // invented 99%, lost P99/40%
      finishReason: "stop",
      usage: usage({ promptTokens: 110, completionTokens: 55 }),
    };
    const { provider, calls } = makeMockProvider(resolveWith(invalid), resolveWith(successResult()));

    const result = await orchestratePolish(provider, makeRequest(), callOpts(new AbortController().signal, { now: fakeClock().now }));

    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    // usage is the SUM of both attempts (Invariant 7: retry tokens count too)
    expect(result.usage).toEqual(addPolishUsage(invalid.usage, usage()));

    const retryMessage = calls[1].request.messages[1].content;
    expect(retryMessage).toContain("your previous response failed validation");
    expect(retryMessage).toContain("protected"); // stage-specific reason fed back
    expect(retryMessage).toContain('"99%"');
    // system prompt is identical across attempts (provider context caching)
    expect(calls[1].request.messages[0].content).toBe(calls[0].request.messages[0].content);
  });

  it("retries after a transport failure (shared budget), then succeeds", async () => {
    const { provider, calls } = makeMockProvider(
      rejectWith(providerError("UPSTREAM_ERROR", "upstream 500")),
      resolveWith(successResult()),
    );

    const result = await orchestratePolish(provider, makeRequest(), callOpts(new AbortController().signal, { now: fakeClock().now }));

    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    // the failed transport attempt contributed no usage
    expect(result.usage).toEqual(usage());
    expect(calls[1].request.messages[1].content).toContain("UPSTREAM_ERROR");
    expect(calls[1].request.messages[1].content).not.toContain("upstream 500");
  });

  it("does not retry terminal provider 4xx failures", async () => {
    const { provider, calls } = makeMockProvider(
      rejectWith(
        providerError("UPSTREAM_ERROR", "sensitive upstream body", {
          upstreamStatus: 402,
          retryable: true,
        }),
      ),
    );

    const error = await orchestratePolish(
      provider,
      makeRequest(),
      callOpts(new AbortController().signal, { now: fakeClock().now }),
    ).catch((caught: unknown) => caught);

    expect(calls).toHaveLength(1);
    expect(error).toMatchObject({
      code: "UPSTREAM_ERROR",
      attempts: 1,
      upstreamStatus: 402,
    });
    expect((error as Error).message).not.toContain("sensitive upstream body");
  });

  it("honors a capped 429 Retry-After inside the shared deadline", async () => {
    const clock = fakeClock();
    const sleeps: number[] = [];
    const { provider, calls } = makeMockProvider(
      rejectWith(
        providerError("UPSTREAM_ERROR", "rate limited", {
          upstreamStatus: 429,
          retryAfterMs: MAX_PROVIDER_RETRY_AFTER_MS * 10,
        }),
      ),
      resolveWith(successResult()),
    );

    const result = await orchestratePolish(
      provider,
      makeRequest(),
      callOpts(new AbortController().signal, {
        now: clock.now,
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
          clock.advance(delayMs);
        },
      }),
    );

    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([MAX_PROVIDER_RETRY_AFTER_MS]);
    expect(calls[1].options.timeoutMs).toBe(
      POLISH_TOTAL_DEADLINE_MS - MAX_PROVIDER_RETRY_AFTER_MS,
    );
  });

  it("does not wait or retry when Retry-After would consume the minimum retry budget", async () => {
    const clock = fakeClock();
    const sleep = vi.fn(async () => {});
    const { provider, calls } = makeMockProvider(() => {
      clock.advance(POLISH_TOTAL_DEADLINE_MS - MIN_RETRY_BUDGET_MS - 1_000);
      return Promise.reject(
        providerError("UPSTREAM_ERROR", "rate limited", {
          upstreamStatus: 429,
          retryAfterMs: 2_000,
        }),
      );
    });

    const error = await orchestratePolish(
      provider,
      makeRequest(),
      callOpts(new AbortController().signal, { now: clock.now, sleep }),
    ).catch((caught: unknown) => caught);

    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(error).toMatchObject({ code: "UPSTREAM_ERROR", attempts: 1 });
  });
});

describe("orchestratePolish — failure paths", () => {
  it("throws INVALID_MODEL_OUTPUT after two validation failures, usage summed", async () => {
    const bad = (polished: string): PolishProviderResult => ({
      text: JSON.stringify({ items: [{ id: "i0", polished }] }),
      finishReason: "stop",
      usage: usage(),
    });
    const { provider, calls } = makeMockProvider(
      resolveWith(bad("将延迟降低 99%。")),
      resolveWith(bad("仍然丢失关键指标的写法。")),
    );

    const error = await orchestratePolish(provider, makeRequest(), callOpts(new AbortController().signal, { now: fakeClock().now })).catch((caught: unknown) => caught);

    expect(calls).toHaveLength(POLISH_MAX_ATTEMPTS);
    expect(error).toMatchObject({
      name: "PolishOrchestrationError",
      code: "INVALID_MODEL_OUTPUT",
      attempts: 2,
      usage: addPolishUsage(usage(), usage()),
    });
  });

  it("throws UPSTREAM_TIMEOUT when the last failure is a transport timeout", async () => {
    const { provider, calls } = makeMockProvider(
      rejectWith(providerError("UPSTREAM_ERROR", "upstream 500")),
      rejectWith(providerError("UPSTREAM_TIMEOUT", "timed out")),
    );

    const error = await orchestratePolish(provider, makeRequest(), callOpts(new AbortController().signal, { now: fakeClock().now })).catch((caught: unknown) => caught);

    expect(calls).toHaveLength(2);
    expect(error).toMatchObject({ code: "UPSTREAM_TIMEOUT", failureStage: "transport", attempts: 2 });
  });

  it("maps insufficient_system_resource to UPSTREAM_ERROR after retry", async () => {
    const insufficient: PolishProviderResult = { text: "", finishReason: "insufficient_system_resource", usage: usage() };
    const { provider } = makeMockProvider(resolveWith(insufficient), resolveWith(insufficient));

    const error = await orchestratePolish(provider, makeRequest(), callOpts(new AbortController().signal, { now: fakeClock().now })).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "UPSTREAM_ERROR", failureStage: "finish_reason", attempts: 2 });
  });
});

describe("orchestratePolish — deadline budget allocation", () => {
  it("shrinks the second attempt's timeoutMs by the elapsed time", async () => {
    const clock = fakeClock();
    const { provider, calls } = makeMockProvider(
      () => {
        clock.advance(30_000); // first attempt burns 30s, then times out
        return Promise.reject(providerError("UPSTREAM_TIMEOUT", "timed out"));
      },
      resolveWith(successResult()),
    );

    const result = await orchestratePolish(provider, makeRequest(), callOpts(new AbortController().signal, { now: clock.now }));

    expect(result.attempts).toBe(2);
    expect(calls[0].options.timeoutMs).toBe(45_000);
    expect(calls[1].options.timeoutMs).toBe(15_000);
  });

  it("does not start a second attempt when the remaining budget is too small", async () => {
    const clock = fakeClock();
    const { provider, calls } = makeMockProvider(() => {
      // 41s elapsed → 4s remaining < MIN_RETRY_BUDGET_MS (5s)
      clock.advance(POLISH_TOTAL_DEADLINE_MS - MIN_RETRY_BUDGET_MS + 1_000);
      return Promise.reject(providerError("UPSTREAM_TIMEOUT", "timed out"));
    });

    const error = await orchestratePolish(provider, makeRequest(), callOpts(new AbortController().signal, { now: clock.now })).catch((caught: unknown) => caught);

    expect(calls).toHaveLength(1);
    expect(error).toMatchObject({ code: "UPSTREAM_TIMEOUT", attempts: 1 });
  });

  it("retries validation failures with the remaining budget as timeout", async () => {
    const clock = fakeClock();
    const invalid: PolishProviderResult = {
      text: JSON.stringify({ items: [{ id: "i0", polished: "将延迟降低 99%。" }] }),
      finishReason: "stop",
      usage: usage(),
    };
    const { provider, calls } = makeMockProvider(
      () => {
        clock.advance(3_000); // fast validation failure
        return Promise.resolve(invalid);
      },
      resolveWith(successResult()),
    );

    await orchestratePolish(provider, makeRequest(), callOpts(new AbortController().signal, { now: clock.now }));
    expect(calls[1].options.timeoutMs).toBe(42_000);
  });
});

describe("orchestratePolish — abort propagation", () => {
  it("propagates a mid-flight abort as-is: no retry, not counted as a failed attempt", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const { provider, calls } = makeMockProvider(() => {
      controller.abort();
      return Promise.reject(abortError);
    });

    const error = await orchestratePolish(provider, makeRequest(), callOpts(controller.signal, { now: fakeClock().now })).catch((caught: unknown) => caught);

    expect(calls).toHaveLength(1);
    expect(error).toBe(abortError);
  });

  it("throws AbortError before the first attempt when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider, calls } = makeMockProvider(resolveWith(successResult()));

    const error = await orchestratePolish(provider, makeRequest(), callOpts(controller.signal, { now: fakeClock().now })).catch((caught: unknown) => caught);

    expect(calls).toHaveLength(0);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });
});

describe("orchestratePolish — request shaping", () => {
  it("trims references server-side by context level (never trusting the client)", async () => {
    const { provider, calls } = makeMockProvider(resolveWith(successResult()));
    await orchestratePolish(
      provider,
      makeRequest({
        context: {
          level: 1,
          references: [
            { role: "sibling", text: "允许出现的 sibling 内容" },
            { role: "profile", text: "不应出现的 profile 内容" },
          ],
        },
      }),
      callOpts(new AbortController().signal, { now: fakeClock().now }),
    );

    const userMessage = calls[0].request.messages[1].content;
    expect(userMessage).toContain("允许出现的 sibling 内容");
    expect(userMessage).not.toContain("不应出现的 profile 内容");
  });

  it("clamps maxOutputTokens at the aggregate content ceiling for a maximal request", async () => {
    const bigItems = Array.from({ length: 30 }, (_, index) => ({
      id: `i${index}`,
      kind: "experience_bullet" as const,
      text: "原".repeat(166),
    }));
    // 30 × min(2400, ceil(249)+40=289) = 8670 → aggregate clamp 7500 →
    // 7500 + 1692 envelope = 9192 (< POLISH_MAX_OUTPUT_TOKENS 10240)
    const { provider, calls } = makeMockProvider((call) => {
      void call;
      return Promise.resolve({
        text: JSON.stringify({ items: bigItems.map((item) => ({ id: item.id, polished: item.text })) }),
        finishReason: "stop" as const,
        usage: usage(),
      });
    });

    await orchestratePolish(provider, makeRequest({ items: bigItems }), callOpts(new AbortController().signal, { now: fakeClock().now }));
    expect(calls[0].request.maxOutputTokens).toBe(9192);
    expect(calls[0].request.maxOutputTokens).toBe(computePolishMaxOutputTokens(bigItems));
  });

  it("calls onProviderAttemptStart once per attempt and propagates its failures unchanged", async () => {
    // Happy path: hook sees 1-based attempt numbers, once per provider call.
    const started: number[] = [];
    const { provider, calls } = makeMockProvider(
      rejectWith(providerError("UPSTREAM_ERROR", "upstream 500")),
      resolveWith(successResult()),
    );
    await orchestratePolish(
      provider,
      makeRequest(),
      callOpts(new AbortController().signal, {
        now: fakeClock().now,
        onProviderAttemptStart: async (attempt) => {
          started.push(attempt);
        },
      }),
    );
    expect(started).toEqual([1, 2]);
    expect(calls).toHaveLength(2);

    // Failure path: a hook error (ledger mark_provider_started infra failure)
    // is an infrastructure failure — it must propagate unchanged, never be
    // retried and never be misclassified as a transport failure.
    const infraError = Object.assign(new Error("mark_provider_started RPC failed"), {
      code: "INTERNAL_ERROR",
    });
    const { provider: provider2, calls: calls2 } = makeMockProvider(resolveWith(successResult()));
    const caught = await orchestratePolish(
      provider2,
      makeRequest(),
      callOpts(new AbortController().signal, {
        now: fakeClock().now,
        onProviderAttemptStart: async () => {
          throw infraError;
        },
      }),
    ).catch((error: unknown) => error);
    expect(caught).toBe(infraError);
    expect(calls2).toHaveLength(0);
  });

  it("propagates providerRequestId from the winning result / last failure", async () => {
    const { provider } = makeMockProvider(
      resolveWith({ ...successResult(), providerRequestId: "req-win-1" }),
    );
    const ok = await orchestratePolish(
      provider,
      makeRequest(),
      callOpts(new AbortController().signal, { now: fakeClock().now }),
    );
    expect(ok.providerRequestId).toBe("req-win-1");

    const failing = Object.assign(new Error("upstream 503"), {
      code: "UPSTREAM_ERROR",
      providerRequestId: "req-fail-7",
      upstreamStatus: 503,
    });
    const { provider: provider2 } = makeMockProvider(rejectWith(failing), rejectWith(failing));
    const error = await orchestratePolish(
      provider2,
      makeRequest(),
      callOpts(new AbortController().signal, { now: fakeClock().now }),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "PolishOrchestrationError",
      code: "UPSTREAM_ERROR",
      providerRequestId: "req-fail-7",
      upstreamStatus: 503,
    });
  });
});

describe("orchestratePolish — terminal progress & post-mark rechecks (relay #3)", () => {
  it("recomputes the deadline after the mark: a slow mark leaves only the post-mark budget for the provider", async () => {
    const clock = fakeClock();
    const { provider, calls } = makeMockProvider(resolveWith(successResult()));

    await orchestratePolish(
      provider,
      makeRequest(),
      callOpts(new AbortController().signal, {
        now: clock.now,
        onProviderAttemptStart: async () => {
          clock.advance(10_000); // the mark RPC burned 10s of the 45s deadline
        },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].options.timeoutMs).toBe(35_000); // 45s − 10s mark time
  });

  it("never calls the provider when the mark consumed the whole deadline", async () => {
    const clock = fakeClock();
    const { provider, calls } = makeMockProvider(resolveWith(successResult()));

    const error = await orchestratePolish(
      provider,
      makeRequest(),
      callOpts(new AbortController().signal, {
        now: clock.now,
        onProviderAttemptStart: async () => {
          clock.advance(POLISH_TOTAL_DEADLINE_MS + 1);
        },
      }),
    ).catch((caught: unknown) => caught);

    expect(calls).toHaveLength(0);
    expect(error).toMatchObject({
      name: "PolishOrchestrationError",
      code: "UPSTREAM_TIMEOUT",
      attempts: 1,
    });
  });

  it("rethrows AbortError after the mark when the caller aborted during the mark RPC (provider never entered)", async () => {
    const controller = new AbortController();
    const progress: import("./orchestrator").PolishOrchestrationProgress[] = [];
    const { provider, calls } = makeMockProvider(resolveWith(successResult()));

    const error = await orchestratePolish(
      provider,
      makeRequest(),
      callOpts(controller.signal, {
        now: fakeClock().now,
        onProviderAttemptStart: async () => {
          controller.abort(); // aborted mid-mark; the RPC itself "succeeded"
        },
        onProgress: (update) => progress.push({ ...update }),
      }),
    ).catch((caught: unknown) => caught);

    expect(calls).toHaveLength(0);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    // A ledger mark is NOT provider-call evidence: no call was entered.
    expect(progress.every((p) => p.enteredAttempts === 0)).toBe(true);
  });

  it("publishes call entry, cumulative usage and accounting state after every provider result", async () => {
    const invalid: PolishProviderResult = {
      text: JSON.stringify({ items: [{ id: "i0", polished: "将延迟降低 99%。" }] }),
      finishReason: "stop",
      usage: usage(),
      providerRequestId: "req-attempt-1",
    };
    const progress: import("./orchestrator").PolishOrchestrationProgress[] = [];
    const { provider } = makeMockProvider(resolveWith(invalid), resolveWith(successResult()));

    const result = await orchestratePolish(
      provider,
      makeRequest(),
      callOpts(new AbortController().signal, {
        now: fakeClock().now,
        onProgress: (update) => progress.push({ ...update }),
      }),
    );

    expect(result.attempts).toBe(2);
    // Entry events (in flight, no usage returned yet) and post-result events
    // (usage returned + cumulative) were published in order.
    expect(progress.length).toBeGreaterThanOrEqual(4);
    expect(progress[0]).toMatchObject({
      enteredAttempts: 1,
      usageReturnedAttempts: 0,
      providerCallInFlight: true,
      usageComplete: true,
    });
    expect(progress[1]).toMatchObject({
      enteredAttempts: 1,
      usageReturnedAttempts: 1,
      providerCallInFlight: false,
      usageComplete: true,
      cumulativeUsage: usage(),
      lastProviderRequestId: "req-attempt-1",
    });
    const last = progress[progress.length - 1];
    expect(last).toMatchObject({
      enteredAttempts: 2,
      usageReturnedAttempts: 2,
      providerCallInFlight: false,
      usageComplete: true,
      cumulativeUsage: addPolishUsage(usage(), usage()),
    });
  });

  it("publishes usageComplete=false + the transport request id after a usage-less transport failure (and never recovers)", async () => {
    const failing = Object.assign(new Error("upstream 503"), {
      code: "UPSTREAM_ERROR",
      providerRequestId: "req-fail-1",
    });
    const progress: import("./orchestrator").PolishOrchestrationProgress[] = [];
    const { provider } = makeMockProvider(rejectWith(failing), resolveWith(successResult()));

    const result = await orchestratePolish(
      provider,
      makeRequest(),
      callOpts(new AbortController().signal, {
        now: fakeClock().now,
        onProgress: (update) => progress.push({ ...update }),
      }),
    );

    expect(result.attempts).toBe(2);
    // The transport failure was published too: call no longer in flight, no
    // usage returned, usageComplete permanently false, request id merged (#5).
    expect(progress[1]).toMatchObject({
      enteredAttempts: 1,
      usageReturnedAttempts: 0,
      providerCallInFlight: false,
      usageComplete: false,
      lastProviderRequestId: "req-fail-1",
    });
    // A later success does NOT restore usageComplete (round-2 #1), and the
    // result without a request id does not overwrite the transport one.
    const last = progress[progress.length - 1];
    expect(last).toMatchObject({
      enteredAttempts: 2,
      usageReturnedAttempts: 1,
      providerCallInFlight: false,
      usageComplete: false,
      lastProviderRequestId: "req-fail-1",
    });
  });

  it("rechecks MIN_RETRY_BUDGET_MS after the mark: a 1s mark on attempt 2 with 5.5s left prevents the retry (#4)", async () => {
    const clock = fakeClock();
    const invalid: PolishProviderResult = {
      text: JSON.stringify({ items: [{ id: "i0", polished: "将延迟降低 99%。" }] }),
      finishReason: "stop",
      usage: usage(),
    };
    const { provider, calls } = makeMockProvider(
      () => {
        clock.advance(39_500); // attempt 1 burns 39.5s → 5.5s ≥ 5s pre-mark
        return Promise.resolve(invalid);
      },
      resolveWith(successResult()),
    );

    const error = await orchestratePolish(
      provider,
      makeRequest(),
      callOpts(new AbortController().signal, {
        now: clock.now,
        onProviderAttemptStart: async (attempt) => {
          if (attempt === 2) clock.advance(1_000); // the mark RPC burns 1s → 4.5s < 5s
        },
      }),
    ).catch((caught: unknown) => caught);

    // The retry passed the PRE-mark budget check (5.5s ≥ 5s) but the mark
    // consumed 1s, leaving 4.5s < MIN_RETRY_BUDGET_MS: provider called once.
    // error.attempts counts ledger MARKS (attempt 2 was really marked — the
    // global counter was incremented), so it reads 2 while the provider was
    // entered only once.
    expect(calls).toHaveLength(1);
    expect(error).toMatchObject({
      name: "PolishOrchestrationError",
      code: "INVALID_MODEL_OUTPUT",
      attempts: 2,
    });
  });
});

describe("orchestratePolishV2 — canonical request and immutable attempt facts", () => {
  it("uses canonical prompt blocks, prices the frozen snapshot, and carries the start receipt", async () => {
    const { provider, calls } = makeV2Provider(async () => v2Result());
    const completedEvents: PolishAttemptCompletedEventV2<{ attemptId: string }>[] = [];

    const result = await orchestratePolishV2(
      provider,
      makeRequest(),
      v2Options(new AbortController().signal, {
        now: fakeClock().now,
        onAttemptStarted: async (fact) => {
          expect(Object.isFrozen(fact)).toBe(true);
          return { attemptId: `attempt-${fact.attemptNo}` };
        },
        onAttemptCompleted: (event) => {
          completedEvents.push(event);
        },
      }),
    );

    expect(result.items).toEqual([{ id: "i0", polished: VALID_ZH_POLISHED }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].options.timeoutMs).toBe(POLISH_TOTAL_DEADLINE_MS);
    expect(calls[0].request).toMatchObject({
      schemaVersion: "polish_inference_request_v2",
      providerSubjectId: TEST_PROVIDER_USER_ID,
      promptVersion: "2026-08-prompt-v1",
      outputContract: { kind: "json_object", schemaName: "polish_items_v1" },
    });
    expect(calls[0].request.prompt.blocks.map((block) => [block.role, block.stability])).toEqual([
      ["developer", "stable"],
      ["user", "variable"],
    ]);
    expect(calls[0].request.prompt.explicitCacheBoundaryAfter).toBe(
      calls[0].request.prompt.blocks[0].id,
    );
    expect(JSON.stringify(calls[0].request)).not.toContain(
      "123e4567-e89b-42d3-a456-426614174000",
    );

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].startResult).toEqual({ attemptId: "attempt-1" });
    expect(completedEvents[0].completed).toMatchObject({
      status: "succeeded",
      transmitted: true,
      providerBillable: true,
      route: {
        providerRequestId: "provider-1",
        actualModelId: "model-v2",
      },
      cost: {
        estimationStatus: "complete",
        providerReportedCost: { currency: "CNY", nanos: "999" },
      },
    });
    expect(Object.isFrozen(completedEvents[0])).toBe(true);
    expect(Object.isFrozen(completedEvents[0].completed)).toBe(true);
    expect(Object.isFrozen(completedEvents[0].completed.usageObservation)).toBe(true);
    expect(result.aggregate).toMatchObject({
      knownUsage: {
        inputTotalTokens: "100",
        inputCacheReadTokens: "60",
        inputStandardTokens: "30",
        outputTokens: "20",
      },
      inputCacheWriteTokens: "10",
      reasoningTokens: "5",
      usageComplete: true,
      providerBillable: true,
    });
    expect(result.aggregate.estimatedCost).not.toBeNull();
  });

  it("consumes the existing fake completeAttempt seam without coupling to its type", async () => {
    const provider = createFakePolishInferenceProvider({
      scenario: FAKE_V2_SCENARIOS.success,
      delayMs: 0,
    });
    const result = await orchestratePolishV2(
      provider,
      makeRequest(),
      v2Options(new AbortController().signal),
    );

    expect(result.attemptFacts).toHaveLength(1);
    expect(result.attemptFacts[0].usageObservation).toEqual(
      observedUsage(FAKE_V2_USAGE_FIXTURES.reported),
    );
    expect(result.winningRoute).toMatchObject({
      gatewayRequestId: "fake-gateway-request-001",
      providerRequestId: "fake-provider-request-001",
      actualModelId: "fake-v2-model",
    });
  });
});

describe("orchestratePolishV2 — cancellation and admission boundary", () => {
  it("does not admit or transmit when cancellation already exists", async () => {
    const controller = new AbortController();
    const reason = new DOMException("canceled before start", "AbortError");
    controller.abort(reason);
    const started = vi.fn();
    const completed = vi.fn();
    const { provider, calls } = makeV2Provider(async () => v2Result());

    const caught = await orchestratePolishV2(
      provider,
      makeRequest(),
      v2Options(controller.signal, {
        onAttemptStarted: started,
        onAttemptCompleted: completed,
      }),
    ).catch((error: unknown) => error);

    expect(caught).toBe(reason);
    expect(started).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("completes the admitted attempt as non-billable when canceled after start but before transport", async () => {
    const controller = new AbortController();
    const reason = new DOMException("canceled after admission", "AbortError");
    const events: PolishAttemptCompletedEventV2<{ attemptId: string }>[] = [];
    const { provider, calls } = makeV2Provider(async () => v2Result());

    const caught = await orchestratePolishV2(
      provider,
      makeRequest(),
      v2Options(controller.signal, {
        now: fakeClock().now,
        onAttemptStarted: () => {
          controller.abort(reason);
          return { attemptId: "admitted-1" };
        },
        onAttemptCompleted: (event) => {
          events.push(event);
        },
      }),
    ).catch((error: unknown) => error);

    expect(caught).toBe(reason);
    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      startResult: { attemptId: "admitted-1" },
      completed: {
        status: "canceled",
        transmitted: false,
        providerBillable: false,
        usageObservation: { kind: "unavailable" },
      },
    });
  });

  it("retains the start receipt and unknown billing when cancellation happens in transport", async () => {
    const controller = new AbortController();
    const reason = new DOMException("canceled in transport", "AbortError");
    const events: PolishAttemptCompletedEventV2<string>[] = [];
    const { provider, calls } = makeV2Provider(async () => {
      controller.abort(reason);
      throw reason;
    });

    const caught = await orchestratePolishV2(
      provider,
      makeRequest(),
      v2Options(controller.signal, {
        now: fakeClock().now,
        onAttemptStarted: () => "attempt-id-1",
        onAttemptCompleted: (event) => {
          events.push(event);
        },
      }),
    ).catch((error: unknown) => error);

    expect(caught).toBe(reason);
    expect(calls).toHaveLength(1);
    expect(events[0]).toMatchObject({
      startResult: "attempt-id-1",
      completed: {
        status: "canceled",
        transmitted: true,
        providerBillable: null,
        usageObservation: { kind: "unavailable" },
      },
    });
  });

  it("does not transmit when the start hook consumes the total deadline", async () => {
    const clock = fakeClock();
    const events: PolishAttemptCompletedEventV2<string>[] = [];
    const { provider, calls } = makeV2Provider(async () => v2Result());

    const caught = await orchestratePolishV2(
      provider,
      makeRequest(),
      v2Options(new AbortController().signal, {
        now: clock.now,
        onAttemptStarted: () => {
          clock.advance(POLISH_TOTAL_DEADLINE_MS + 1);
          return "deadline-attempt";
        },
        onAttemptCompleted: (event) => {
          events.push(event);
        },
      }),
    ).catch((error: unknown) => error);

    expect(calls).toHaveLength(0);
    expect(caught).toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect(events[0]).toMatchObject({
      startResult: "deadline-attempt",
      completed: {
        status: "timed_out",
        transmitted: false,
        providerBillable: false,
      },
    });
  });
});

describe("orchestratePolishV2 — retry, failure usage, and conservative aggregation", () => {
  it("retains usage/cost/route for malformed content and retries the same provider", async () => {
    const clock = fakeClock();
    const events: PolishAttemptCompletedEventV2<string>[] = [];
    const { provider, calls } = makeV2Provider(
      async () => {
        clock.advance(1_000);
        return v2Result("not-json");
      },
      async () => {
        clock.advance(2_000);
        return v2Result();
      },
    );

    const result = await orchestratePolishV2(
      provider,
      makeRequest(),
      v2Options(new AbortController().signal, {
        now: clock.now,
        onAttemptStarted: (fact) => `attempt-${fact.attemptNo}`,
        onAttemptCompleted: (event) => {
          events.push(event);
        },
      }),
    );

    expect(calls).toHaveLength(2);
    expect(calls[1].request.prompt.blocks[1].content).toContain(
      "previous response failed validation",
    );
    expect(calls[1].request.prompt.blocks[1].content).toContain("not valid JSON");
    expect(events.map((event) => event.startResult)).toEqual(["attempt-1", "attempt-2"]);
    expect(result.attemptFacts.map((fact) => fact.status)).toEqual([
      "invalid_output",
      "succeeded",
    ]);
    expect(result.attemptFacts[0]).toMatchObject({
      transmitted: true,
      providerBillable: true,
      usageObservation: { kind: "observed" },
      route: { providerRequestId: "provider-1" },
      cost: { estimationStatus: "complete" },
      latencyMs: 1_000,
    });
    expect(result.aggregate).toMatchObject({
      knownUsage: {
        inputTotalTokens: "200",
        inputCacheReadTokens: "120",
        inputStandardTokens: "60",
        outputTokens: "40",
      },
      inputCacheWriteTokens: "20",
      reasoningTokens: "10",
      usageComplete: true,
      providerBillable: true,
    });
  });

  it("records the fake explicit unavailable-usage failure without inventing zero cost", async () => {
    const provider = createFakePolishInferenceProvider({
      scenario: FAKE_V2_SCENARIOS.unavailableUsage,
      delayMs: 0,
    });
    const caught = await orchestratePolishV2(
      provider,
      makeRequest(),
      v2Options(new AbortController().signal),
    ).catch((error: unknown) => error as {
      attemptFacts: readonly PolishAttemptCompletedFactV2[];
      aggregate: ReturnType<typeof aggregatePolishAttemptFactsV2>;
    });

    expect(caught.attemptFacts).toHaveLength(1);
    expect(caught.attemptFacts[0]).toMatchObject({
      status: "failed_upstream",
      transmitted: true,
      providerBillable: null,
      usageObservation: { kind: "unavailable", usage: null, usageComplete: false },
      cost: { estimatedCost: null, estimationStatus: "incomplete_usage" },
    });
    expect(caught.aggregate).toMatchObject({
      knownUsage: {
        inputTotalTokens: "0",
        inputCacheReadTokens: "0",
        inputStandardTokens: "0",
        outputTokens: "0",
      },
      usageComplete: false,
      providerBillable: null,
      knownEstimatedCost: null,
      estimatedCost: null,
    });
    expect(caught.aggregate.incompleteFields).toEqual([
      "attempt_usage",
      "input_cache_write",
      "reasoning",
      "provider_billable",
      "estimated_cost",
    ]);
  });

  it("preserves an observed lower bound when a failed outcome includes usage", async () => {
    const failedOutcome: PolishInferenceAttemptOutcomeV2 = {
      kind: "failed",
      failure: {
        code: "UPSTREAM_ERROR",
        upstreamStatus: 400,
        retryable: false,
        retryAfterMs: 0,
        providerRequestId: "provider-failed-with-usage",
      },
      route: { providerRequestId: "provider-failed-with-usage" },
      providerBillable: true,
      result: null,
      usageObservation: observedUsage(V2_REPORTED_USAGE),
      providerReportedCost: { currency: "CNY", nanos: "123" },
    };
    const provider: PolishInferenceProviderV2 = {
      complete: async () => {
        throw new Error("complete must not be used when completeAttempt exists");
      },
      completeAttempt: async () => failedOutcome,
    };

    const caught = await orchestratePolishV2(
      provider,
      makeRequest(),
      v2Options(new AbortController().signal),
    ).catch((error: unknown) => error as {
      attemptFacts: readonly PolishAttemptCompletedFactV2[];
      aggregate: ReturnType<typeof aggregatePolishAttemptFactsV2>;
    });

    expect(caught.attemptFacts[0]).toMatchObject({
      providerBillable: true,
      usageObservation: { kind: "observed", usage: V2_REPORTED_USAGE },
      cost: {
        estimationStatus: "complete",
        providerReportedCost: { currency: "CNY", nanos: "123" },
      },
    });
    expect(caught.aggregate).toMatchObject({
      knownUsage: {
        inputTotalTokens: "100",
        outputTokens: "20",
      },
      usageComplete: true,
      providerBillable: true,
    });
    expect(caught.aggregate.knownEstimatedCost).not.toBeNull();
  });

  it("keeps usage known while making cost and optional buckets null when cache-write is unavailable", async () => {
    const { provider } = makeV2Provider(async () =>
      v2Result(undefined, V2_UNAVAILABLE_WRITE_USAGE),
    );
    const result = await orchestratePolishV2(
      provider,
      makeRequest(),
      v2Options(new AbortController().signal, { now: fakeClock().now }),
    );

    expect(result.attemptFacts[0].cost).toMatchObject({
      estimationStatus: "incomplete_usage",
      estimatedCost: null,
      incompleteReasons: ["input_cache_write"],
    });
    expect(result.aggregate).toMatchObject({
      knownUsage: {
        inputTotalTokens: "100",
        inputCacheReadTokens: "60",
        inputStandardTokens: "40",
        outputTokens: "20",
      },
      inputCacheWriteTokens: null,
      reasoningTokens: null,
      usageComplete: true,
      providerBillable: true,
      knownEstimatedCost: null,
      estimatedCost: null,
    });
    expect(result.aggregate.incompleteFields).toEqual([
      "input_cache_write",
      "reasoning",
      "estimated_cost",
    ]);
  });

  it("rejects aggregation across different frozen currencies instead of summing them", async () => {
    const first = await orchestratePolishV2(
      makeV2Provider(async () => v2Result()).provider,
      makeRequest(),
      v2Options(new AbortController().signal, { now: fakeClock().now }),
    );
    const second = await orchestratePolishV2(
      makeV2Provider(async () => v2Result()).provider,
      makeRequest(),
      v2Options(new AbortController().signal, {
        now: fakeClock().now,
        frozenPrice: { ...V2_PRICE, currency: "USD", priceVersionId: "price-usd" },
      }),
    );

    expect(() =>
      aggregatePolishAttemptFactsV2([
        first.attemptFacts[0],
        second.attemptFacts[0],
      ]),
    ).toThrow(/different frozen currencies/);
  });

  it("retains known attempt-one lower bounds when attempt two has unavailable usage", async () => {
    const outcomes: PolishInferenceAttemptOutcomeV2[] = [
      {
        kind: "completed",
        result: v2Result("not-json"),
        usageObservation: observedUsage(V2_REPORTED_USAGE) as Extract<
          PolishInferenceAttemptOutcomeV2,
          { kind: "completed" }
        >["usageObservation"],
      },
      {
        kind: "failed",
        failure: {
          code: "UPSTREAM_ERROR",
          upstreamStatus: 400,
          retryable: false,
          retryAfterMs: 0,
        },
        route: {},
        providerBillable: null,
        result: null,
        usageObservation: unavailableUsage(),
      },
    ];
    const provider: PolishInferenceProviderV2 = {
      complete: async () => {
        throw new Error("complete must not be used");
      },
      completeAttempt: async () => {
        const outcome = outcomes.shift();
        if (!outcome) throw new Error("unexpected attempt");
        return outcome;
      },
    };

    const caught = await orchestratePolishV2(
      provider,
      makeRequest(),
      v2Options(new AbortController().signal, { now: fakeClock().now }),
    ).catch((error: unknown) => error as {
      aggregate: ReturnType<typeof aggregatePolishAttemptFactsV2>;
    });

    expect(caught.aggregate).toMatchObject({
      knownUsage: {
        inputTotalTokens: "100",
        inputCacheReadTokens: "60",
        inputStandardTokens: "30",
        outputTokens: "20",
      },
      usageComplete: false,
      providerBillable: true,
      estimatedCost: null,
    });
    expect(caught.aggregate.knownEstimatedCost).not.toBeNull();
    expect(caught.aggregate.incompleteFields).toContain("attempt_usage");
    expect(caught.aggregate.incompleteFields).toContain("estimated_cost");
  });
});

describe("orchestratePolishV2 — terminal completion callback failures", () => {
  it("wraps a callback failure after success with the paid fact and start receipt", async () => {
    const callbackError = new Error("complete attempt RPC unavailable");
    const { provider, calls } = makeV2Provider(async () => v2Result());

    const caught = await orchestratePolishV2(
      provider,
      makeRequest(),
      v2Options(new AbortController().signal, {
        now: fakeClock().now,
        onAttemptStarted: () => ({ attemptId: "attempt-success-1" }),
        onAttemptCompleted: () => {
          throw callbackError;
        },
      }),
    ).catch((error: unknown) => error);

    expect(calls).toHaveLength(1);
    expect(caught).toBeInstanceOf(PolishAttemptPersistenceErrorV2);
    expect(caught).toMatchObject({
      code: "ATTEMPT_PERSISTENCE_ERROR",
      retryable: false,
      originalCause: callbackError,
      completedEvent: {
        startResult: { attemptId: "attempt-success-1" },
        completed: { status: "succeeded", providerBillable: true },
      },
      attemptFacts: [{ status: "succeeded" }],
      aggregate: { providerBillable: true, usageComplete: true },
    });
    expect((caught as Error).cause).toBe(callbackError);
    expect(Object.isFrozen((caught as PolishAttemptPersistenceErrorV2).completedEvent)).toBe(true);
    expect(Object.isFrozen((caught as PolishAttemptPersistenceErrorV2).attemptFacts)).toBe(true);
  });

  it("never retries a transport when persisting its failed fact throws", async () => {
    const callbackError = new Error("failed fact persistence unavailable");
    const { provider, calls } = makeV2Provider(async () => {
      throw Object.assign(new Error("upstream 503"), {
        code: "UPSTREAM_ERROR",
        upstreamStatus: 503,
      });
    });

    const caught = await orchestratePolishV2(
      provider,
      makeRequest(),
      v2Options(new AbortController().signal, {
        now: fakeClock().now,
        onAttemptStarted: () => "attempt-transport-1",
        onAttemptCompleted: () => {
          throw callbackError;
        },
      }),
    ).catch((error: unknown) => error);

    expect(calls).toHaveLength(1);
    expect(caught).toMatchObject({
      code: "ATTEMPT_PERSISTENCE_ERROR",
      retryable: false,
      originalCause: callbackError,
      completedEvent: {
        startResult: "attempt-transport-1",
        completed: {
          status: "failed_upstream",
          transmitted: true,
          providerBillable: null,
        },
      },
      aggregate: { usageComplete: false, providerBillable: null },
    });
  });

  it("retains a canceled in-flight fact when its completion callback throws", async () => {
    const controller = new AbortController();
    const abort = new DOMException("caller disconnected", "AbortError");
    const callbackError = new Error("cancel fact persistence unavailable");
    const { provider, calls } = makeV2Provider(async () => {
      controller.abort(abort);
      throw abort;
    });

    const caught = await orchestratePolishV2(
      provider,
      makeRequest(),
      v2Options(controller.signal, {
        now: fakeClock().now,
        onAttemptStarted: () => ({ attemptId: "attempt-cancel-1" }),
        onAttemptCompleted: () => {
          throw callbackError;
        },
      }),
    ).catch((error: unknown) => error);

    expect(calls).toHaveLength(1);
    expect(caught).toMatchObject({
      code: "ATTEMPT_PERSISTENCE_ERROR",
      retryable: false,
      originalCause: callbackError,
      completedEvent: {
        startResult: { attemptId: "attempt-cancel-1" },
        completed: {
          status: "canceled",
          transmitted: true,
          providerBillable: null,
        },
      },
      attemptFacts: [{ status: "canceled" }],
    });
  });
});

describe("aggregatePolishAttemptFactsV2 — persistence bounds", () => {
  it("fails closed when individually legal costs overflow the request bigint aggregate", async () => {
    const { provider, calls } = makeV2Provider(async () => v2Result());
    const template = await orchestratePolishV2(
      provider,
      makeRequest(),
      v2Options(new AbortController().signal, { now: fakeClock().now }),
    );
    const maxCost = Object.freeze({
      currency: "CNY",
      nanos: "9223372036854775807",
    });
    const withMaxCost = (attemptNo: number): PolishAttemptCompletedFactV2 => ({
      ...template.attemptFacts[0],
      started: {
        ...template.attemptFacts[0].started,
        attemptNo,
      },
      cost: {
        ...template.attemptFacts[0].cost,
        estimatedCost: maxCost,
      },
    });

    const first = withMaxCost(1);
    const second = withMaxCost(2);
    let caught: unknown;
    try {
      aggregatePolishAttemptFactsV2([first, second]);
    } catch (error) {
      caught = error;
    }

    expect(calls).toHaveLength(1);
    expect(caught).toBeInstanceOf(PolishUsageAggregationError);
    expect(caught).toMatchObject({
      code: "COST_AGGREGATE_OVERFLOW",
      retryable: false,
      attemptFacts: [{}, {}],
    });
    expect((caught as Error).message).not.toContain(maxCost.nanos);

    const callbackError = new Error("completion persistence unavailable");
    const persistenceError = new PolishAttemptPersistenceErrorV2(
      Object.freeze({
        started: second.started,
        startResult: "attempt-2-receipt",
        completed: second,
      }),
      [first, second],
      callbackError,
    );
    expect(persistenceError).toMatchObject({
      originalCause: callbackError,
      aggregateInvariant: { code: "COST_AGGREGATE_OVERFLOW" },
      aggregate: { knownEstimatedCost: null, estimatedCost: null },
    });
    expect(persistenceError.aggregate.incompleteFields).toContain("estimated_cost");
  });
});

describe("orchestratePolishV2 — post-transport deadline and abort ownership", () => {
  it("does not accept a valid provider result returned after the total deadline", async () => {
    const clock = fakeClock();
    const { provider, calls } = makeV2Provider(async () => {
      clock.advance(POLISH_TOTAL_DEADLINE_MS + 1);
      return v2Result();
    });

    const caught = (await orchestratePolishV2(
      provider,
      makeRequest(),
      v2Options(new AbortController().signal, { now: clock.now }),
    ).catch((error: unknown) => error)) as {
      code: string;
      attemptFacts: readonly PolishAttemptCompletedFactV2[];
      aggregate: ReturnType<typeof aggregatePolishAttemptFactsV2>;
    };

    expect(calls).toHaveLength(1);
    expect(caught.code).toBe("UPSTREAM_TIMEOUT");
    expect(caught.attemptFacts).toHaveLength(1);
    expect(caught.attemptFacts[0]).toMatchObject({
      status: "timed_out",
      transmitted: true,
      providerBillable: true,
      usageObservation: { kind: "observed", usage: V2_REPORTED_USAGE },
      route: { providerRequestId: "provider-1", actualModelId: "model-v2" },
      cost: {
        estimationStatus: "complete",
        providerReportedCost: { currency: "CNY", nanos: "999" },
      },
      latencyMs: POLISH_TOTAL_DEADLINE_MS + 1,
    });
    expect(caught.aggregate).toMatchObject({
      knownUsage: { inputTotalTokens: "100", outputTokens: "20" },
      usageComplete: true,
      providerBillable: true,
    });
  });

  it("preserves a returned result as a canceled paid fact when the signal aborted in flight", async () => {
    const controller = new AbortController();
    const abort = new DOMException("caller disconnected", "AbortError");
    const events: PolishAttemptCompletedEventV2<string>[] = [];
    const { provider, calls } = makeV2Provider(async () => {
      controller.abort(abort);
      return v2Result();
    });

    const caught = await orchestratePolishV2(
      provider,
      makeRequest(),
      v2Options(controller.signal, {
        now: fakeClock().now,
        onAttemptStarted: () => "attempt-abort-return-1",
        onAttemptCompleted: (event) => {
          events.push(event);
        },
      }),
    ).catch((error: unknown) => error);

    expect(caught).toBe(abort);
    expect(calls).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      startResult: "attempt-abort-return-1",
      completed: {
        status: "canceled",
        transmitted: true,
        providerBillable: true,
        usageObservation: { kind: "observed", usage: V2_REPORTED_USAGE },
        route: { providerRequestId: "provider-1" },
        cost: { estimationStatus: "complete" },
      },
    });
  });
});

describe("orchestratePolishV2 — deep canonical request immutability", () => {
  it("prevents attempt one from mutating nested output schema seen by attempt two", async () => {
    const callerSchema = {
      nested: {
        discriminator: "original",
      },
    };
    const { provider, calls } = makeV2Provider(
      async (call) => {
        const schema = call.request.outputContract.schema as {
          nested: { discriminator: string };
        };
        expect(Object.isFrozen(call.request)).toBe(true);
        expect(Object.isFrozen(call.request.outputContract)).toBe(true);
        expect(Object.isFrozen(schema.nested)).toBe(true);
        expect(() => {
          schema.nested.discriminator = "attempt-one-mutation";
        }).toThrow(TypeError);
        return v2Result("not-json");
      },
      async (call) => {
        const schema = call.request.outputContract.schema as {
          nested: { discriminator: string };
        };
        expect(schema.nested.discriminator).toBe("original");
        return v2Result();
      },
    );

    const result = await orchestratePolishV2(
      provider,
      makeRequest(),
      v2Options(new AbortController().signal, {
        now: fakeClock().now,
        outputContract: {
          kind: "json_object",
          schemaName: "nested_contract_v1",
          schema: callerSchema,
        },
      }),
    );

    expect(result.attemptFacts.map((fact) => fact.status)).toEqual([
      "invalid_output",
      "succeeded",
    ]);
    expect(calls).toHaveLength(2);
    expect(callerSchema.nested.discriminator).toBe("original");
    expect(Object.isFrozen(callerSchema.nested)).toBe(false);
  });
});
