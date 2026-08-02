import { describe, expect, it } from "vitest";
import type { PolishRequest } from "@/lib/polish/contract";
import {
  addPolishUsage,
  computeMaxOutputTokens,
  MIN_RETRY_BUDGET_MS,
  orchestratePolish,
  POLISH_MAX_ATTEMPTS,
  POLISH_TOTAL_DEADLINE_MS,
  zeroPolishUsage,
  type PolishProvider,
  type PolishProviderRequest,
  type PolishProviderResult,
  type PolishProviderUsage,
} from "./orchestrator";

const VALID_ZH_POLISHED = "负责后端核心服务的开发与优化，将 P99 延迟降低 40%。";

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

function providerError(code: "UPSTREAM_ERROR" | "UPSTREAM_TIMEOUT", message: string): Error {
  return Object.assign(new Error(message), { code });
}

function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("computeMaxOutputTokens", () => {
  it("is totalTargetChars × 1.5 + JSON overhead below the hard cap", () => {
    // 1 item × 100 chars: ceil(150) + 32 + 24 = 206
    expect(computeMaxOutputTokens(100, 1)).toBe(206);
  });

  it("is capped at POLISH_MAX_OUTPUT_TOKENS for large requests", () => {
    expect(computeMaxOutputTokens(5000, 30)).toBe(8192);
  });
});

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
    const result = await orchestratePolish(provider, makeRequest(), {
      signal: new AbortController().signal,
      now: fakeClock().now,
    });

    expect(result.items).toEqual([{ id: "i0", polished: VALID_ZH_POLISHED }]);
    expect(result.usage).toEqual(usage());
    expect(result.attempts).toBe(1);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.options.timeoutMs).toBe(POLISH_TOTAL_DEADLINE_MS);
    // dynamic max_tokens: 1 item, 24 original chars → ceil(36) + 32 + 24 = 92
    expect(call.request.maxOutputTokens).toBe(computeMaxOutputTokens(24, 1));
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

    const result = await orchestratePolish(provider, makeRequest(), {
      signal: new AbortController().signal,
      now: fakeClock().now,
    });

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

    const result = await orchestratePolish(provider, makeRequest(), {
      signal: new AbortController().signal,
      now: fakeClock().now,
    });

    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    // the failed transport attempt contributed no usage
    expect(result.usage).toEqual(usage());
    expect(calls[1].request.messages[1].content).toContain("UPSTREAM_ERROR");
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

    const error = await orchestratePolish(provider, makeRequest(), {
      signal: new AbortController().signal,
      now: fakeClock().now,
    }).catch((caught: unknown) => caught);

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

    const error = await orchestratePolish(provider, makeRequest(), {
      signal: new AbortController().signal,
      now: fakeClock().now,
    }).catch((caught: unknown) => caught);

    expect(calls).toHaveLength(2);
    expect(error).toMatchObject({ code: "UPSTREAM_TIMEOUT", failureStage: "transport", attempts: 2 });
  });

  it("maps insufficient_system_resource to UPSTREAM_ERROR after retry", async () => {
    const insufficient: PolishProviderResult = { text: "", finishReason: "insufficient_system_resource", usage: usage() };
    const { provider } = makeMockProvider(resolveWith(insufficient), resolveWith(insufficient));

    const error = await orchestratePolish(provider, makeRequest(), {
      signal: new AbortController().signal,
      now: fakeClock().now,
    }).catch((caught: unknown) => caught);

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

    const result = await orchestratePolish(provider, makeRequest(), {
      signal: new AbortController().signal,
      now: clock.now,
    });

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

    const error = await orchestratePolish(provider, makeRequest(), {
      signal: new AbortController().signal,
      now: clock.now,
    }).catch((caught: unknown) => caught);

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

    await orchestratePolish(provider, makeRequest(), { signal: new AbortController().signal, now: clock.now });
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

    const error = await orchestratePolish(provider, makeRequest(), {
      signal: controller.signal,
      now: fakeClock().now,
    }).catch((caught: unknown) => caught);

    expect(calls).toHaveLength(1);
    expect(error).toBe(abortError);
  });

  it("throws AbortError before the first attempt when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider, calls } = makeMockProvider(resolveWith(successResult()));

    const error = await orchestratePolish(provider, makeRequest(), {
      signal: controller.signal,
      now: fakeClock().now,
    }).catch((caught: unknown) => caught);

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
      { signal: new AbortController().signal, now: fakeClock().now },
    );

    const userMessage = calls[0].request.messages[1].content;
    expect(userMessage).toContain("允许出现的 sibling 内容");
    expect(userMessage).not.toContain("不应出现的 profile 内容");
  });

  it("caps maxOutputTokens at POLISH_MAX_OUTPUT_TOKENS for a maximal request", async () => {
    const bigItems = Array.from({ length: 30 }, (_, index) => ({
      id: `i${index}`,
      kind: "experience_bullet" as const,
      text: "原".repeat(166),
    }));
    // total 4980 chars → ceil(7470) + 32 + 30×24 = 8222 > 8192 → capped
    const { provider, calls } = makeMockProvider((call) => {
      void call;
      return Promise.resolve({
        text: JSON.stringify({ items: bigItems.map((item) => ({ id: item.id, polished: item.text })) }),
        finishReason: "stop" as const,
        usage: usage(),
      });
    });

    await orchestratePolish(provider, makeRequest({ items: bigItems }), {
      signal: new AbortController().signal,
      now: fakeClock().now,
    });
    expect(calls[0].request.maxOutputTokens).toBe(8192);
    expect(computeMaxOutputTokens(4980, 30)).toBe(8192);
  });
});
