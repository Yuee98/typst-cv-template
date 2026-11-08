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
  invalidResponseBody: "INVALID_RESPONSE_BODY"
} as const;

/** Current API codes plus explicit reasons; unknown execution outcomes never offer resend. */
export type PolishErrorKind = "terms_required" | "quota_exhausted" | "rate_limited" | "duplicate" | "route_changed" | "too_large" | "timeout" | "invalid_output" | "disabled" | "auth" | "stale" | "network" | "upstream" | "invalid_request" | "aborted" | "unknown" | "held" | "forbidden" | "client_update";
const KIND_BY_CODE: Record<string, PolishErrorKind> = {
  UNAUTHORIZED: "auth",
  CLIENT_UPDATE_REQUIRED: "client_update",
  QUOTA_EXCEEDED: "quota_exhausted",
  RATE_LIMITED: "rate_limited",
  INVALID_REQUEST: "invalid_request",
  NOT_READY: "disabled",
  NOT_FOUND: "invalid_request",
  INTERNAL_ERROR: "held",
  [POLISH_TRANSPORT_ERROR_CODES.clientTimeout]: "timeout",
  [POLISH_CLIENT_ERROR_CODES.invalidResponse]: "invalid_output",
  [POLISH_CLIENT_ERROR_CODES.snapshotStale]: "stale",
  [POLISH_TRANSPORT_ERROR_CODES.networkError]: "network",
  [POLISH_TRANSPORT_ERROR_CODES.invalidResponseBody]: "held",
  [POLISH_TRANSPORT_ERROR_CODES.requestAborted]: "aborted"
};
export function classifyPolishError(error: Pick<PolishError, "code" | "reason">): PolishErrorKind {
  if (error.code === "FORBIDDEN") return error.reason === "CONSENT_REQUIRED" ? "terms_required" : "forbidden";
  if (error.code === "CONFLICT") {
    if (error.reason === "CONFIG_CHANGED" || error.reason === "OPTION_UNAVAILABLE") return "route_changed";
    if (["REQUEST_IN_PROGRESS", "ALREADY_FINALIZED", "IDEMPOTENCY_PAYLOAD_CHANGED", "IDEMPOTENCY_MISMATCH"].includes(error.reason ?? "")) return "duplicate";
    return "unknown";
  }
  if (error.code === "UNAVAILABLE") {
    if (error.reason === "HELD") return "held";
    if (error.reason === "FAILED_UPSTREAM") return "upstream";
    if (error.reason === "INVALID_OUTPUT") return "invalid_output";
    if (error.reason === "CANCELED" || error.reason === "RELEASED") return "aborted";
    return "disabled";
  }
  return KIND_BY_CODE[error.code] ?? "unknown";
}
const RETRYABLE: ReadonlySet<PolishErrorKind> = new Set(["rate_limited", "invalid_output", "stale", "upstream"]);
/** Only known completed failures can become a new explicit request; no automatic transmission retry. */
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
    minute: "2-digit"
  }).format(date);
}
