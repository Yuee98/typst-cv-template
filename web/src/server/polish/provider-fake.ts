/**
 * Deterministic fake polish provider (unit 0.4), selected when
 * POLISH_FAKE_LLM=true — vitest suites and local/CI runs without a DeepSeek
 * key.
 *
 * Output is a pure function of the request: no randomness and no wall-clock
 * dependence beyond the simulated delay, so tests can assert exact values.
 * The returned text is always shaped as `{"items":[{"id":...,"polished":...}]}`,
 * matching the prompt contract the orchestrator (unit 2.2) validates against.
 *
 * Codewords scanned across all message contents:
 * - FAIL_UPSTREAM → throws PolishProviderError(UPSTREAM_ERROR)
 * - FAIL_JSON     → resolves with malformed JSON text (exercises the
 *                   orchestrator's JSON-parse failure path)
 * - SLOW          → resolves only after timeoutMs + FAKE_SLOW_EXTRA_DELAY_MS
 *                   (exercises the orchestrator's timeout path); still
 *                   rejects immediately on signal abort
 *
 * `maxOutputTokens` is accepted but ignored: the fake's output is far below
 * any realistic cap, and the cap only matters for the real provider's
 * max_tokens mapping (unit 2.1).
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

/** Extra delay added on top of `timeoutMs` when the SLOW codeword is present. */
export const FAKE_SLOW_EXTRA_DELAY_MS = 1000;

export interface FakePolishProviderOptions {
  /** Simulated per-call latency in milliseconds (SLOW overrides it). */
  delayMs?: number;
}

/** Matches `"id":"..."` JSON fragments (contract ITEM_ID_PATTERN charset). */
const ITEM_ID_FRAGMENT = /"id"\s*:\s*"([A-Za-z0-9_-]{1,32})"/g;

/**
 * Best-effort echo of the item ids embedded in the request messages. Prompt
 * assembly (unit 2.2) serializes items as JSON with `"id"` fields, so this
 * picks them up in order, deduplicated. When no id fragment is found (e.g.
 * hand-written test messages), a single generic placeholder id is used so
 * the output stays well-formed.
 */
function extractItemIds(corpus: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of corpus.matchAll(ITEM_ID_FRAGMENT)) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      ids.push(match[1]);
    }
  }
  return ids.length > 0 ? ids : ["i0"];
}

/** Rejects with the signal's reason (AbortError) if the signal fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
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
      await sleep(slow ? timeoutMs + FAKE_SLOW_EXTRA_DELAY_MS : delayMs, signal);

      let text: string;
      if (corpus.includes(FAKE_PROVIDER_CODEWORDS.failJson)) {
        // Malformed on purpose: truncated mid-string, unrecoverable by JSON.parse.
        text = '{"items":[{"id":"i0","polished":"truncated';
      } else {
        const items = extractItemIds(corpus).map((id) => ({
          id,
          polished: `[FAKE] polished ${id}`,
        }));
        text = JSON.stringify({ items });
      }

      return { text, finishReason: "stop", usage: fakeUsage(request, text) };
    },
  };
}
