/**
 * Error taxonomy for the polish dialog: classify every error code that can
 * reach the UI — server codes from the API contract, the reducer's
 * client-side codes, and the client layer's transport codes — into a small
 * set of UI kinds with a retryable flag (roadmap「错误态细分」).
 *
 * The dialog renders `PolishDialog.errors.<kind>` and, when present, the
 * structured `resetAt` / `retryAfterSeconds` fields carried by the error.
 * This module owns no message strings; it only decides WHICH message and
 * whether a retry button makes sense.
 */

import type { PolishError } from "./polish-reducer";
import { POLISH_CLIENT_ERROR_CODES } from "./polish-reducer";

/**
 * Transport/client-layer error codes produced by polish-client.ts. Server
 * error codes from the API contract and the reducer's POLISH_CLIENT_ERROR_CODES
 * complete the set of codes a PolishError may carry.
 */
export const POLISH_TRANSPORT_ERROR_CODES = {
  /** fetch rejected (offline, DNS, CORS, …) — no response was received. */
  networkError: "NETWORK_ERROR",
  /** The caller's AbortSignal fired (user cancel / dialog closed). */
  requestAborted: "REQUEST_ABORTED",
  /** The client-side hard timeout fired before any response. */
  clientTimeout: "CLIENT_TIMEOUT",
  /** A response arrived but failed schema validation (not the contract shape). */
  invalidResponseBody: "INVALID_RESPONSE_BODY",
} as const;

export type PolishErrorKind =
  /** 403 AI_TERMS_REQUIRED — re-show the config checkbox in red, not the error phase. */
  | "terms_required"
  /** 429 QUOTA_EXCEEDED — show resetAt; not retryable until reset. */
  | "quota_exhausted"
  /** 429 RATE_LIMITED — show retryAfterSeconds; retryable after the wait. */
  | "rate_limited"
  /** 409 REQUEST_IN_PROGRESS / DUPLICATE_REQUEST — dedup conflict. */
  | "duplicate"
  /** 413 PAYLOAD_TOO_LARGE — narrow the scope; not retryable as-is. */
  | "too_large"
  /** 504 UPSTREAM_TIMEOUT or the client-side hard timeout; retryable. */
  | "timeout"
  /** 502 INVALID_MODEL_OUTPUT / reducer INVALID_RESPONSE; retryable. */
  | "invalid_output"
  /** 503 AI_DISABLED / SERVICE_UNAVAILABLE (kill switch); not retryable. */
  | "disabled"
  /** 401 UNAUTHORIZED — session expired; re-sign-in, not retryable. */
  | "auth"
  /** Reducer SNAPSHOT_STALE — the form changed underneath; rerun rebuilds. */
  | "stale"
  /** Transport failure without a response; retryable. */
  | "network"
  /** 502 UPSTREAM_ERROR / 500 INTERNAL_ERROR; retryable. */
  | "upstream"
  /** 400 INVALID_REQUEST / unparseable response body; not retryable. */
  | "invalid_request"
  /** The user cancelled; normally never rendered. */
  | "aborted"
  /** Anything else; not retryable. */
  | "unknown";

const KIND_BY_CODE: Record<string, PolishErrorKind> = {
  AI_TERMS_REQUIRED: "terms_required",
  QUOTA_EXCEEDED: "quota_exhausted",
  RATE_LIMITED: "rate_limited",
  REQUEST_IN_PROGRESS: "duplicate",
  DUPLICATE_REQUEST: "duplicate",
  PAYLOAD_TOO_LARGE: "too_large",
  UPSTREAM_TIMEOUT: "timeout",
  [POLISH_TRANSPORT_ERROR_CODES.clientTimeout]: "timeout",
  INVALID_MODEL_OUTPUT: "invalid_output",
  [POLISH_CLIENT_ERROR_CODES.invalidResponse]: "invalid_output",
  AI_DISABLED: "disabled",
  SERVICE_UNAVAILABLE: "disabled",
  UNAUTHORIZED: "auth",
  [POLISH_CLIENT_ERROR_CODES.snapshotStale]: "stale",
  [POLISH_TRANSPORT_ERROR_CODES.networkError]: "network",
  UPSTREAM_ERROR: "upstream",
  INTERNAL_ERROR: "upstream",
  INVALID_REQUEST: "invalid_request",
  [POLISH_TRANSPORT_ERROR_CODES.invalidResponseBody]: "invalid_request",
  [POLISH_TRANSPORT_ERROR_CODES.requestAborted]: "aborted",
};

export function classifyPolishError(error: Pick<PolishError, "code">): PolishErrorKind {
  return KIND_BY_CODE[error.code] ?? "unknown";
}

const RETRYABLE: ReadonlySet<PolishErrorKind> = new Set([
  "rate_limited",
  "timeout",
  "invalid_output",
  "stale",
  "network",
  "upstream",
]);

/**
 * Whether "try again" is a meaningful offer. A retry always mints a fresh
 * clientRequestId and rebuilds the snapshot from the current form, so stale
 * and transient failures recover; quota/dedup/size/auth failures do not.
 */
export function isRetryablePolishError(kind: PolishErrorKind): boolean {
  return RETRYABLE.has(kind);
}

/**
 * Format an ISO resetAt for the error detail line; falls back to the raw
 * string when it does not parse (server data is not trusted blindly).
 */
export function formatResetAt(resetAt: string, locale: string): string {
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return resetAt;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
