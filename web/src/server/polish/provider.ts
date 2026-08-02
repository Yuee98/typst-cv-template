/**
 * Polish LLM provider interface — the single-transmission boundary (unit 0.4).
 *
 * Responsibility split (roadmap「系统 prompt 与输出验证」职责边界): a provider
 * performs ONE upstream call — request/response mapping, usage extraction,
 * and transport error normalization. Retry attempts and the overall deadline
 * are owned by the orchestrator (unit 2.2), never by an implementation of
 * this interface. `timeoutMs` is the hard timeout of this single call and
 * works together with `signal`.
 *
 * The four interfaces below are PINNED: unit 2.2 structurally mirrors this
 * exact definition and unit 2.3 deduplicates them. Do not rename, add, or
 * reshape any field without coordinating both units.
 */

import type { PolishErrorCode } from "@/lib/polish/contract";
import { createFakePolishProvider } from "./provider-fake";

export interface PolishProviderRequest {
  /** Fully assembled chat messages (system + user), already level-trimmed. */
  messages: { role: "system" | "user"; content: string }[];
  /** Hard output cap computed by the orchestrator (dynamic max_tokens). */
  maxOutputTokens: number;
}

export interface PolishProviderUsage {
  promptTokens: number;
  completionTokens: number;
  cachedReadTokens: number;
  uncachedReadTokens: number;
}

export interface PolishProviderResult {
  /** Raw text body of the first choice (expected to be JSON per prompt contract). */
  text: string;
  /** Normalized finish reason. */
  finishReason: "stop" | "length" | "content_filter" | "insufficient_system_resource" | "unknown";
  usage: PolishProviderUsage;
}

export interface PolishProvider {
  complete(
    request: PolishProviderRequest,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<PolishProviderResult>;
}

// ---------------------------------------------------------------------------
// Transport error normalization
// ---------------------------------------------------------------------------

/**
 * Error codes a provider may report, reused from the shared contract so the
 * orchestrator/handler can map a failure straight to an API response:
 * `UPSTREAM_ERROR` (HTTP/transport failure) and `UPSTREAM_TIMEOUT` (the
 * single call exceeded its hard `timeoutMs`).
 */
export type PolishProviderErrorCode = Extract<
  PolishErrorCode,
  "UPSTREAM_ERROR" | "UPSTREAM_TIMEOUT"
>;

/**
 * Normalized transport failure thrown by a provider implementation.
 *
 * Cancellation via the AbortSignal is deliberately NOT wrapped in this
 * error: providers rethrow the signal's reason (an AbortError) as-is so the
 * orchestrator can tell user cancellation apart from transport failure.
 */
export class PolishProviderError extends Error {
  readonly code: PolishProviderErrorCode;

  constructor(code: PolishProviderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PolishProviderError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

/**
 * Resolve the configured polish provider.
 *
 * - `POLISH_FAKE_LLM=true` → the deterministic fake (unit 0.4), for tests
 *   and local/CI runs without a real DeepSeek key.
 * - otherwise → throws until the real provider lands (unit 2.1).
 *
 * Fail-loud in production: `POLISH_FAKE_LLM=true` combined with
 * `NODE_ENV=production` throws here, before any request can be served by a
 * fake (the fake returns synthetic output and must never run in production).
 * Callers (the unit 2.3 handler) must resolve the provider once at module
 * scope so this misconfiguration refuses startup instead of failing
 * per-request.
 *
 * `env` is injectable for tests; production callers use the default
 * `process.env`.
 */
export function getPolishProvider(
  env: Record<string, string | undefined> = process.env,
): PolishProvider {
  const fakeRequested = env.POLISH_FAKE_LLM === "true";
  if (fakeRequested) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "POLISH_FAKE_LLM=true is forbidden with NODE_ENV=production: the fake polish provider " +
          "returns synthetic output. Refusing to start.",
      );
    }
    return createFakePolishProvider();
  }
  throw new Error(
    "No polish LLM provider is wired yet (the real DeepSeek provider lands in unit 2.1). " +
      "Set POLISH_FAKE_LLM=true to use the deterministic fake in non-production environments.",
  );
}
