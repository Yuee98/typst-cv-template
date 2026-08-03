/**
 * Deterministic fake polish provider (unit 0.4), selected when
 * POLISH_FAKE_LLM=true — vitest suites and local/CI runs without a DeepSeek
 * key.
 *
 * Output is a pure function of the request: no randomness and no wall-clock
 * dependence beyond the simulated delay, so tests can assert exact values.
 * The returned text is always shaped as `{"items":[{"id":...,"polished":...}]}`,
 * matching the prompt contract the orchestrator (unit 2.2) validates against.
 * Each target's ORIGINAL text is echoed unchanged (taken from the structured
 * `targets` metadata, never parsed back out of the prompt strings), so the
 * fake's success path survives the language / protected-span / length
 * validation pipeline exactly like a real polished response must.
 *
 * Codewords scanned across all message contents:
 * - FAIL_UPSTREAM → throws PolishProviderError(UPSTREAM_ERROR)
 * - FAIL_JSON     → resolves with malformed JSON text (exercises the
 *                   orchestrator's JSON-parse failure path)
 * - SLOW          → simulates a call that outlasts `timeoutMs`
 *                   (timeoutMs + FAKE_SLOW_EXTRA_DELAY_MS), so the fake's
 *                   own single-attempt timeout fires first (exercises the
 *                   orchestrator's timeout path)
 *
 * Timeout contract (same as every provider): `timeoutMs` is the hard timeout
 * of this single call. The fake races it against the caller's signal — its
 * own timeout rejects with PolishProviderError("UPSTREAM_TIMEOUT", …), while
 * caller cancellation rejects with the signal's AbortError. The
 * orchestrator's overall multi-attempt deadline is a separate concern (unit
 * 2.2) and is not simulated here.
 *
 * `maxOutputTokens` and `providerUserId` are accepted but ignored: the
 * fake's output is far below any realistic cap, and the id only matters for
 * the real provider's upstream mapping (unit 2.1).
 */

import {
  PolishProviderError,
  type PolishProvider,
  type PolishProviderRequest,
  type PolishProviderResult,
  type PolishProviderUsage,
} from "./provider";

export const FAKE_PROVIDER_CODEWORDS = {
  failUpstream: "FAIL_UPSTREAM",
  failJson: "FAIL_JSON",
  slow: "SLOW",
} as const;

export const DEFAULT_FAKE_DELAY_MS = 20;

/**
 * Extra delay added on top of `timeoutMs` when the SLOW codeword is present,
 * so the fake's own timeout always fires before the simulated latency ends.
 */
export const FAKE_SLOW_EXTRA_DELAY_MS = 1000;

export interface FakePolishProviderOptions {
  /** Simulated per-call latency in milliseconds (SLOW overrides it). */
  delayMs?: number;
}

/**
 * Waits `ms`, racing the fake's own hard `timeoutMs` against caller
 * cancellation: the fake's timeout rejects with UPSTREAM_TIMEOUT, a caller
 * abort rejects with the signal's reason (AbortError).
 */
function sleep(ms: number, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const cleanup = () => {
      clearTimeout(delayTimer);
      clearTimeout(timeoutTimer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const delayTimer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const timeoutTimer = setTimeout(() => {
      cleanup();
      reject(
        new PolishProviderError(
          "UPSTREAM_TIMEOUT",
          `fake polish provider: single call exceeded its hard timeoutMs (${timeoutMs}ms)`,
        ),
      );
    }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Synthetic, deterministic usage estimate (≈4 chars per token). */
function fakeUsage(request: PolishProviderRequest, outputText: string): PolishProviderUsage {
  const promptChars = request.messages.reduce((sum, m) => sum + m.content.length, 0);
  const promptTokens = Math.ceil(promptChars / 4);
  return {
    promptTokens,
    completionTokens: Math.ceil(outputText.length / 4),
    cachedReadTokens: 0,
    uncachedReadTokens: promptTokens,
  };
}

export function createFakePolishProvider(options: FakePolishProviderOptions = {}): PolishProvider {
  const delayMs = options.delayMs ?? DEFAULT_FAKE_DELAY_MS;

  return {
    async complete(
      request: PolishProviderRequest,
      { signal, timeoutMs }: { signal: AbortSignal; timeoutMs: number },
    ): Promise<PolishProviderResult> {
      // Cancellation is rethrown as-is (AbortError), never wrapped in a
      // PolishProviderError — the orchestrator distinguishes the two.
      signal.throwIfAborted();

      const corpus = request.messages.map((m) => m.content).join("\n");

      if (corpus.includes(FAKE_PROVIDER_CODEWORDS.failUpstream)) {
        throw new PolishProviderError(
          "UPSTREAM_ERROR",
          "fake polish provider: FAIL_UPSTREAM codeword present in request",
        );
      }

      const slow = corpus.includes(FAKE_PROVIDER_CODEWORDS.slow);
      await sleep(slow ? timeoutMs + FAKE_SLOW_EXTRA_DELAY_MS : delayMs, signal, timeoutMs);

      let text: string;
      if (corpus.includes(FAKE_PROVIDER_CODEWORDS.failJson)) {
        // Malformed on purpose: truncated mid-string, unrecoverable by JSON.parse.
        text = '{"items":[{"id":"i0","polished":"truncated';
      } else {
        const items = request.targets.map((target) => ({ id: target.id, polished: target.text }));
        text = JSON.stringify({ items });
      }

      return { text, finishReason: "stop", usage: fakeUsage(request, text) };
    },
  };
}
