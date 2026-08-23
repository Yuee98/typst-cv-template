/**
 * Safe provider retry policy shared by every adapter.
 *
 * Adapters still normalize transport failures, but the orchestrator owns the
 * retry decision and total deadline. This module intentionally uses only
 * structured metadata: provider error messages/bodies never participate in
 * classification, logging, or retry prompts.
 */

export const MAX_PROVIDER_RETRY_AFTER_MS = 5_000;

export interface ProviderRetryErrorMetadata {
  code?: unknown;
  upstreamStatus?: unknown;
  retryable?: unknown;
  retryAfterMs?: unknown;
}

export interface ProviderRetryDecision {
  retryable: boolean;
  retryAfterMs: number;
}

function asHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function boundedRetryAfterMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MAX_PROVIDER_RETRY_AFTER_MS);
}

/**
 * Decide whether one more call to the SAME frozen profile is safe.
 *
 * - malformed/auth/payment/policy/content 4xx failures are terminal;
 * - 408/425/429, 5xx, network failures and timeouts may retry;
 * - an adapter may conservatively force `retryable=false`, but cannot make a
 *   terminal 4xx retryable;
 * - Retry-After delay is honored only for 429 and is capped.
 */
export function classifyProviderRetry(
  metadata: ProviderRetryErrorMetadata,
): ProviderRetryDecision {
  const status = asHttpStatus(metadata.upstreamStatus);

  let retryable: boolean;
  if (status !== undefined) {
    retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  } else {
    // No HTTP response normally means a network failure. Explicit provider
    // timeouts also arrive without a status and share the same retry budget.
    retryable = metadata.code === "UPSTREAM_TIMEOUT" || metadata.code === "UPSTREAM_ERROR";
  }

  if (metadata.retryable === false) retryable = false;

  return {
    retryable,
    retryAfterMs:
      retryable && status === 429 ? boundedRetryAfterMs(metadata.retryAfterMs) : 0,
  };
}
