/**
 * TypeScript wrapper for the AI polish quota ledger RPCs (unit 1.3).
 *
 * Mirrors the settlement semantics in
 * supabase/migrations/20260802130000_add_ai_quota_ledger.sql
 * (reserve → provider_started → finalized, idempotent finalize, dedup).
 * Source of truth: tmp/ai-polish-roadmap.md —「架构决策：模型与配额」.
 *
 * DI style: every function takes a SupabaseClient (the service_role admin
 * client from unit 1.2) instead of creating one; unit 2.3 wires it into the
 * request lifecycle. Denials and failures are raised as PolishQuotaError so
 * the route handler can map them straight onto the API contract error codes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  POLISH_ERROR_HTTP_STATUS,
  type PolishErrorCode,
} from "@/lib/polish/contract";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class PolishQuotaError extends Error {
  readonly code: PolishErrorCode;
  readonly httpStatus: number;
  readonly resetAt?: string;
  readonly retryAfterSeconds?: number;

  constructor(
    code: PolishErrorCode,
    message: string,
    options?: { resetAt?: string; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = "PolishQuotaError";
    this.code = code;
    this.httpStatus = POLISH_ERROR_HTTP_STATUS[code];
    this.resetAt = options?.resetAt;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// RPC payload schemas (jsonb returns, camelCase keys)
// ---------------------------------------------------------------------------

const reserveResponseSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().optional(),
  message: z.string().optional(),
  reservationId: z.uuid().optional(),
  remaining: z.number().int().nonnegative().optional(),
  resetAt: z.string().optional(),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
});

const markResponseSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  attemptCount: z.number().int().nonnegative().optional(),
});

const finalizeResponseSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  alreadyFinalized: z.boolean().optional(),
  status: z.string().optional(),
  quotaCharged: z.boolean().optional(),
});

const quotaResponseSchema = z.object({
  limit: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  resetAt: z.string(),
});

// ---------------------------------------------------------------------------
// reserve
// ---------------------------------------------------------------------------

/** Denial reasons reserve_ai_polish_request can return, as contract codes. */
const RESERVE_DENIAL_CODES = [
  "AI_DISABLED",
  "SERVICE_UNAVAILABLE",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "DUPLICATE_REQUEST",
  "REQUEST_IN_PROGRESS",
] as const satisfies readonly PolishErrorCode[];

type ReserveDenialCode = (typeof RESERVE_DENIAL_CODES)[number];

function isReserveDenialCode(reason: string | undefined): reason is ReserveDenialCode {
  return (
    reason !== undefined &&
    (RESERVE_DENIAL_CODES as readonly string[]).includes(reason)
  );
}

export interface PolishReservation {
  reservationId: string;
  /** Requests left today after this reservation (DB time). */
  remaining: number;
  /** Next UTC midnight, ISO string from DB time. */
  resetAt: string;
}

/**
 * Atomically reads the runtime switch, checks global daily limit / per-user
 * daily quota / per-minute rate limit, dedups on clientRequestId, and writes
 * the ledger reservation. Throws PolishQuotaError on any denial
 * (QUOTA_EXCEEDED / RATE_LIMITED / DUPLICATE_REQUEST / REQUEST_IN_PROGRESS /
 * AI_DISABLED / SERVICE_UNAVAILABLE) or infrastructure failure
 * (INTERNAL_ERROR).
 */
export async function reservePolishRequest(
  client: SupabaseClient,
  params: { userId: string; requestId: string; clientRequestId: string },
): Promise<PolishReservation> {
  const { data, error } = await client.rpc("reserve_ai_polish_request", {
    p_user_id: params.userId,
    p_request_id: params.requestId,
    p_client_request_id: params.clientRequestId,
  });
  if (error) {
    throw new PolishQuotaError(
      "INTERNAL_ERROR",
      `reserve RPC failed: ${error.message}`,
    );
  }

  const parsed = reserveResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new PolishQuotaError(
      "INTERNAL_ERROR",
      "reserve RPC returned an unexpected payload.",
    );
  }
  const result = parsed.data;

  if (!result.allowed) {
    const code: PolishErrorCode = isReserveDenialCode(result.reason)
      ? result.reason
      : "INTERNAL_ERROR";
    throw new PolishQuotaError(
      code,
      result.message ?? `Reservation denied (${result.reason ?? "unknown"}).`,
      { resetAt: result.resetAt, retryAfterSeconds: result.retryAfterSeconds },
    );
  }

  if (
    !result.reservationId ||
    result.remaining === undefined ||
    !result.resetAt
  ) {
    throw new PolishQuotaError(
      "INTERNAL_ERROR",
      "reserve RPC succeeded without a reservation payload.",
    );
  }
  return {
    reservationId: result.reservationId,
    remaining: result.remaining,
    resetAt: result.resetAt,
  };
}

// ---------------------------------------------------------------------------
// mark provider started
// ---------------------------------------------------------------------------

export interface ProviderStartedMark {
  /** False when the reservation was already finalized (treat as aborted). */
  started: boolean;
  /** 1-based provider attempt number when started. */
  attemptCount: number | null;
}

/**
 * Transitions a reservation to provider_started (once per provider attempt)
 * and increments the global daily counter, which is never refunded. Throws
 * INTERNAL_ERROR when the reservation is unknown (ledger inconsistency).
 */
export async function markPolishProviderStarted(
  client: SupabaseClient,
  reservationId: string,
  providerRequestId?: string,
): Promise<ProviderStartedMark> {
  const { data, error } = await client.rpc("mark_ai_polish_provider_started", {
    p_reservation_id: reservationId,
    p_provider_request_id: providerRequestId ?? null,
  });
  if (error) {
    throw new PolishQuotaError(
      "INTERNAL_ERROR",
      `mark_provider_started RPC failed: ${error.message}`,
    );
  }

  const parsed = markResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new PolishQuotaError(
      "INTERNAL_ERROR",
      "mark_provider_started RPC returned an unexpected payload.",
    );
  }
  const result = parsed.data;

  if (!result.ok) {
    if (result.reason === "ALREADY_FINALIZED") {
      return { started: false, attemptCount: null };
    }
    throw new PolishQuotaError(
      "INTERNAL_ERROR",
      `mark_provider_started rejected the reservation (${result.reason ?? "unknown"}).`,
    );
  }
  return { started: true, attemptCount: result.attemptCount ?? null };
}

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

/** Settlement outcomes finalize accepts ('abandoned' is reconciler-only). */
export type PolishFinalizeStatus =
  | "succeeded"
  | "canceled"
  | "failed_upstream"
  | "invalid_output"
  | "released";

export const POLISH_FAILURE_STAGES = [
  "terms",
  "quota",
  "request_validation",
  "provider_http",
  "provider_timeout",
  "json_parse",
  "schema_validation",
  "semantic_validation",
  "canceled",
] as const;
export type PolishFailureStage = (typeof POLISH_FAILURE_STAGES)[number];

export interface PolishTokenUsage {
  inputCachedTokens: number;
  inputUncachedTokens: number;
  outputTokens: number;
  usageComplete: boolean;
}

/** Optional ledger bookkeeping fields recorded at finalize time. */
export interface PolishLedgerMetadata {
  granularity?: "item" | "entry" | "section";
  itemCount?: number;
  contextLevel?: 0 | 1 | 2;
  language?: "zh" | "en";
  model?: string;
  promptVersion?: string;
  validatorVersion?: string;
  attemptCount?: number;
  providerRequestId?: string;
  finishReason?: string;
  failureStage?: PolishFailureStage;
  latencyMs?: number;
}

export interface PolishFinalizeResult {
  /** True when the reservation was already settled (idempotent no-op). */
  alreadyFinalized: boolean;
}

/**
 * Settles a reservation exactly once (roadmap settlement table):
 * quota_charged=false refunds the user quota; token usage is always recorded
 * (per-user + global) even when refunded; repeated calls change nothing.
 * Throws INTERNAL_ERROR for unknown reservations / invalid status (caller
 * bugs) and on RPC failure.
 */
export async function finalizePolishRequest(
  client: SupabaseClient,
  params: {
    reservationId: string;
    status: PolishFinalizeStatus;
    quotaCharged: boolean;
    providerBillable?: boolean | null;
    usage?: PolishTokenUsage;
    metadata?: PolishLedgerMetadata;
  },
): Promise<PolishFinalizeResult> {
  const usage = params.usage
    ? {
        input_cached_tokens: params.usage.inputCachedTokens,
        input_uncached_tokens: params.usage.inputUncachedTokens,
        output_tokens: params.usage.outputTokens,
        usage_complete: params.usage.usageComplete,
      }
    : null;

  const m = params.metadata;
  const metadata = m
    ? {
        granularity: m.granularity,
        item_count: m.itemCount,
        context_level: m.contextLevel,
        language: m.language,
        model: m.model,
        prompt_version: m.promptVersion,
        validator_version: m.validatorVersion,
        attempt_count: m.attemptCount,
        provider_request_id: m.providerRequestId,
        finish_reason: m.finishReason,
        failure_stage: m.failureStage,
        latency_ms: m.latencyMs,
      }
    : null;

  const { data, error } = await client.rpc("finalize_ai_polish_request", {
    p_reservation_id: params.reservationId,
    p_status: params.status,
    p_quota_charged: params.quotaCharged,
    p_provider_billable: params.providerBillable ?? null,
    p_usage: usage,
    p_metadata: metadata,
  });
  if (error) {
    throw new PolishQuotaError(
      "INTERNAL_ERROR",
      `finalize RPC failed: ${error.message}`,
    );
  }

  const parsed = finalizeResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new PolishQuotaError(
      "INTERNAL_ERROR",
      "finalize RPC returned an unexpected payload.",
    );
  }
  const result = parsed.data;

  if (!result.ok) {
    throw new PolishQuotaError(
      "INTERNAL_ERROR",
      `finalize rejected the reservation (${result.reason ?? "unknown"}).`,
    );
  }
  return { alreadyFinalized: result.alreadyFinalized ?? false };
}

// ---------------------------------------------------------------------------
// remaining-quota read (GET /api/polish/quota, unit 2.3)
// ---------------------------------------------------------------------------

export interface PolishQuotaStatus {
  limit: number;
  remaining: number;
  resetAt: string;
}

export async function getPolishQuota(
  client: SupabaseClient,
  userId: string,
): Promise<PolishQuotaStatus> {
  const { data, error } = await client.rpc("get_ai_polish_quota", {
    p_user_id: userId,
  });
  if (error) {
    throw new PolishQuotaError(
      "INTERNAL_ERROR",
      `get quota RPC failed: ${error.message}`,
    );
  }

  const parsed = quotaResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new PolishQuotaError(
      "INTERNAL_ERROR",
      "get quota RPC returned an unexpected payload.",
    );
  }
  return parsed.data;
}
