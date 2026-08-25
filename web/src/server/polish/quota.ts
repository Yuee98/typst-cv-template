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
  MAX_ITEMS,
  POLISH_ERROR_HTTP_STATUS,
  POLISH_GRANULARITIES,
  type PolishErrorCode,
  type PolishGranularity,
} from "@/lib/polish/contract";
import { resolveEndpoint } from "./adapter-registry";
import { assertNormalizedUsageV2 } from "./inference-v2";
import {
  PolishLifecycleV2ContractError,
  observeRouteIdentifierV1,
  parseAttemptCompleteRpcResultV2,
  parseAttemptStartRpcResultV2,
  parseExecutionSnapshotV1,
  parseExpectedRouteV1,
  parseFinalizeRpcResultV2,
  parseReserveRpcResultV2,
  parseRouteSnapshotV1,
  sameRouteSnapshotV1,
  type AttemptCompleteRpcResultV2,
  type AttemptStartRpcResultV2,
  type ExecutionSnapshotFailureReasonV1,
  type ExecutionSnapshotResultV1,
  type ExpectedRouteV1,
  type FinalizeRpcResultV2,
  type ReserveRpcResultV2,
  type RouteSnapshotV1,
  type RuntimeTargetResolverV1,
} from "./lifecycle-v2-contract";
import type {
  PolishAttemptCompletedFactV2,
  PolishAttemptStatusV2,
} from "./orchestrator";
import {
  validateProfileExecutionConfig,
  type ProfileExecutionConfigV1,
} from "./profile-registry";
import { POLISH_VALIDATION_FAILURE_STAGES } from "./validate";

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

/**
 * Fixed client-facing message for INTERNAL_ERROR quota failures (relay #10):
 * raw PostgREST/DB error text (function names, schema details, connection
 * errors) is a server-side diagnostic only — it stays in the thrown error's
 * message for logs and NEVER crosses the API boundary.
 */
export const INTERNAL_QUOTA_SERVICE_MESSAGE = "Internal quota service error.";

// ---------------------------------------------------------------------------
// RPC payload schemas (jsonb returns, camelCase keys)
// ---------------------------------------------------------------------------

const reserveResponseSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().optional(),
  message: z.string().optional(),
  reservationId: z.uuid().optional(),
  limit: z.number().int().nonnegative().optional(),
  remaining: z.number().int().nonnegative().optional(),
  resetAt: z.string().optional(),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
});

const markResponseSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  attemptCount: z.number().int().nonnegative().optional(),
});

const quotaResponseSchema = z.object({
  limit: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  resetAt: z.string(),
});

const finalizeResponseSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  alreadyFinalized: z.boolean().optional(),
  status: z.string().optional(),
  quotaCharged: z.boolean().optional(),
  // Post-settlement quota snapshot, returned atomically since relay #8.
  quota: quotaResponseSchema.optional(),
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
  /** Daily free-tier limit (DB constant), for snapshot fallbacks. */
  limit?: number;
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
    limit: result.limit,
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
 * and increments the global daily counter, which is never refunded.
 *
 * This RPC is the authoritative atomic gate of the global daily circuit
 * breaker (relay #2): it locks the day's global row, re-reads the runtime
 * config and rechecks enabled/allowlist/capacity before incrementing.
 * Denials are raised as PolishQuotaError(SERVICE_UNAVAILABLE) — global
 * capacity exhausted — or PolishQuotaError(AI_DISABLED) — kill switch /
 * allowlist flipped after reserve — so the lifecycle can refund the user
 * quota, keep earlier-attempt usage and answer 503 instead of a generic
 * 500. ALREADY_FINALIZED returns { started: false } (treat as aborted);
 * other failures (unknown reservation) throw INTERNAL_ERROR.
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
    if (result.reason === "SERVICE_UNAVAILABLE") {
      throw new PolishQuotaError(
        "SERVICE_UNAVAILABLE",
        "AI polish is temporarily unavailable (daily capacity reached).",
      );
    }
    if (result.reason === "AI_DISABLED") {
      throw new PolishQuotaError(
        "AI_DISABLED",
        "AI polish is currently disabled.",
      );
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
  granularity?: PolishGranularity;
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
  /**
   * Persisted settlement status, returned by the RPC on both fresh and
   * idempotent-finalized calls. Internal bookkeeping (round-2 #3): the
   * lifecycle uses it to distinguish a confirmed success commit from a
   * conflicting prior settlement after a lost finalize response.
   */
  status?: string;
  /**
   * Whether the persisted settlement charged the user quota. Paired with
   * `status` for the lost-response retry check (round-2 #3).
   */
  quotaCharged?: boolean;
  /**
   * Post-settlement per-user quota snapshot, returned atomically by the
   * finalize RPC (relay #8) so the success path never needs a separate
   * quota read after irreversible settlement.
   */
  quota?: PolishQuotaStatus;
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
  return {
    alreadyFinalized: result.alreadyFinalized ?? false,
    status: result.status,
    quotaCharged: result.quotaCharged,
    quota: result.quota,
  };
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

// ---------------------------------------------------------------------------
// Dormant V2 persistence boundary (RT-009)
// ---------------------------------------------------------------------------

const CANONICAL_UUID_V2 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CANONICAL_NANOS_V2 = /^(?:0|[1-9][0-9]*)$/u;
const CURRENCY_V2 = /^[A-Z]{3}$/u;
const CODE_VERSION_V2 = /^[a-z0-9][a-z0-9._-]{0,199}$/u;
const MAX_POSTGRES_BIGINT_V2 = BigInt("9223372036854775807");
const MAX_POSTGRES_INTEGER_V2 = 2_147_483_647;
const ATTEMPT_STATUSES_V2 = new Set<PolishAttemptStatusV2>([
  "succeeded",
  "invalid_output",
  "failed_upstream",
  "timed_out",
  "canceled",
]);
const FINISH_REASONS_V2 = new Set([
  "stop",
  "length",
  "content_filter",
  "insufficient_system_resource",
  "unknown",
]);
const FAILURE_STAGES_V2: ReadonlySet<string> = new Set([
  "transport",
  ...POLISH_VALIDATION_FAILURE_STAGES,
  "provider_contract",
]);
const COST_INCOMPLETE_REASONS_V2 = new Set([
  "invalid_usage",
  "usage_incomplete",
  "unknown_calculator",
  "invalid_price_snapshot",
  "missing_price_component",
  "input_cache_write",
  "cost_overflow",
]);

export type PolishLifecycleV2RpcErrorKind =
  | "LOCAL_CONTRACT_REJECTED"
  | "RESERVE_DENIED"
  | "RESERVE_UNKNOWN"
  | "SNAPSHOT_DENIED"
  | "SNAPSHOT_INVALID"
  | "SNAPSHOT_UNAVAILABLE"
  | "ATTEMPT_START_DENIED"
  | "ATTEMPT_START_REPLAY"
  | "ATTEMPT_START_UNKNOWN"
  | "ATTEMPT_COMPLETE_REJECTED"
  | "ATTEMPT_COMPLETE_UNKNOWN"
  | "CANCELLATION_REJECTED"
  | "CANCELLATION_UNKNOWN"
  | "FINALIZE_REJECTED"
  | "FINALIZE_CONFLICT"
  | "FINALIZE_UNKNOWN";

const V2_RPC_ERROR_MESSAGES: Readonly<Record<PolishLifecycleV2RpcErrorKind, string>> = {
  LOCAL_CONTRACT_REJECTED: "AI lifecycle data failed local validation.",
  RESERVE_DENIED: "AI polish reservation was denied.",
  RESERVE_UNKNOWN: "AI polish reservation state is unknown.",
  SNAPSHOT_DENIED: "AI polish execution snapshot was denied.",
  SNAPSHOT_INVALID: "AI polish execution snapshot is invalid.",
  SNAPSHOT_UNAVAILABLE: "AI polish execution snapshot is unavailable.",
  ATTEMPT_START_DENIED: "AI provider attempt admission was denied.",
  ATTEMPT_START_REPLAY: "AI provider attempt admission was already observed.",
  ATTEMPT_START_UNKNOWN: "AI provider attempt admission state is unknown.",
  ATTEMPT_COMPLETE_REJECTED: "AI provider attempt completion was rejected.",
  ATTEMPT_COMPLETE_UNKNOWN: "AI provider attempt completion state is unknown.",
  CANCELLATION_REJECTED: "AI polish cancellation observation was rejected.",
  CANCELLATION_UNKNOWN: "AI polish cancellation observation state is unknown.",
  FINALIZE_REJECTED: "AI polish settlement was rejected.",
  FINALIZE_CONFLICT: "AI polish settlement conflicts with persisted state.",
  FINALIZE_UNKNOWN: "AI polish settlement state is unknown.",
};

/**
 * Safe lifecycle error. The message and reason are fixed codes; raw
 * PostgREST/DB text is retained only as an internal cause and must never be
 * projected into logs or HTTP responses by callers.
 */
export class PolishLifecycleV2RpcError extends Error {
  readonly kind: PolishLifecycleV2RpcErrorKind;
  readonly reason?: string;
  readonly resetAt?: string;
  readonly retryAfterSeconds?: number;
  readonly remaining?: number;
  readonly retryable = false;
  readonly originalCause: unknown;

  constructor(
    kind: PolishLifecycleV2RpcErrorKind,
    options?: {
      reason?: string;
      resetAt?: string;
      retryAfterSeconds?: number;
      remaining?: number;
      cause?: unknown;
    },
  ) {
    super(V2_RPC_ERROR_MESSAGES[kind], { cause: options?.cause });
    this.name = "PolishLifecycleV2RpcError";
    this.kind = kind;
    this.reason = options?.reason;
    this.resetAt = options?.resetAt;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    this.remaining = options?.remaining;
    this.originalCause = options?.cause;
  }
}

type ReserveSuccessV2 = Extract<ReserveRpcResultV2, { allowed: true }>;
type ExecutionSnapshotSuccessV1 = Extract<ExecutionSnapshotResultV1, { ok: true }>;
export type ProviderAttemptStartV2 = Extract<AttemptStartRpcResultV2, { ok: true }>;
export type ProviderAttemptCompleteV2 = Extract<
  AttemptCompleteRpcResultV2,
  { ok: true }
>;
export type PolishFinalizeResultV2 = Extract<FinalizeRpcResultV2, { ok: true }>;

type RpcObservationV2 =
  | Readonly<{ kind: "response"; data: unknown }>
  | Readonly<{ kind: "ambiguous"; cause: unknown }>;

function localContractErrorV2(cause?: unknown): PolishLifecycleV2RpcError {
  return new PolishLifecycleV2RpcError("LOCAL_CONTRACT_REJECTED", {
    reason: "LOCAL_CONTRACT",
    cause,
  });
}

function requireCanonicalUuidV2(value: string): string {
  if (typeof value !== "string" || !CANONICAL_UUID_V2.test(value)) {
    throw localContractErrorV2();
  }
  return value;
}

function freezeRpcValueV2<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeRpcValueV2(child, seen);
  return Object.freeze(value);
}

async function observeRpcV2(
  client: SupabaseClient,
  functionName: string,
  args: object,
): Promise<RpcObservationV2> {
  try {
    const { data, error } = await client.rpc(functionName, args);
    if (error) return Object.freeze({ kind: "ambiguous", cause: error });
    return Object.freeze({ kind: "response", data });
  } catch (cause) {
    return Object.freeze({ kind: "ambiguous", cause });
  }
}

function parseExpectedRouteInputV2(value: ExpectedRouteV1): ExpectedRouteV1 {
  try {
    return parseExpectedRouteV1(value);
  } catch (cause) {
    throw localContractErrorV2(cause);
  }
}

function parseRouteSnapshotInputV2(value: RouteSnapshotV1): RouteSnapshotV1 {
  try {
    return parseRouteSnapshotV1(value);
  } catch (cause) {
    throw localContractErrorV2(cause);
  }
}

function routeMatchesExpectedV2(
  route: RouteSnapshotV1,
  expected: ExpectedRouteV1,
): boolean {
  return (
    route.configGeneration === expected.configGeneration &&
    route.profileVersionId === expected.profileVersionId &&
    route.legalBundleVersion === expected.legalBundleVersion &&
    route.runtimeContractId === expected.runtimeContractId &&
    route.runtimeContractSha256 === expected.runtimeContractSha256
  );
}

/** V2 reserve is intentionally single-shot: a response loss may have admitted. */
export async function reservePolishRequestV2(
  client: SupabaseClient,
  params: {
    userId: string;
    requestId: string;
    clientRequestId: string;
    expectedRoute: ExpectedRouteV1;
  },
): Promise<ReserveSuccessV2> {
  const expectedRoute = parseExpectedRouteInputV2(params.expectedRoute);
  const args = freezeRpcValueV2({
    p_user_id: requireCanonicalUuidV2(params.userId),
    p_request_id: requireCanonicalUuidV2(params.requestId),
    p_client_request_id: requireCanonicalUuidV2(params.clientRequestId),
    p_expected_route: {
      schema_version: expectedRoute.schemaVersion,
      config_generation: expectedRoute.configGeneration,
      profile_version_id: expectedRoute.profileVersionId,
      legal_bundle_version: expectedRoute.legalBundleVersion,
      runtime_contract_id: expectedRoute.runtimeContractId,
      runtime_contract_sha256: expectedRoute.runtimeContractSha256,
    },
  });
  const observation = await observeRpcV2(client, "reserve_ai_polish_request_v2", args);
  if (observation.kind === "ambiguous") {
    throw new PolishLifecycleV2RpcError("RESERVE_UNKNOWN", {
      reason: "RPC_ERROR",
      cause: observation.cause,
    });
  }

  let result: ReserveRpcResultV2;
  try {
    result = parseReserveRpcResultV2(observation.data);
  } catch (cause) {
    throw new PolishLifecycleV2RpcError("RESERVE_UNKNOWN", {
      reason: "MALFORMED_RESPONSE",
      cause,
    });
  }
  if (!result.allowed) {
    throw new PolishLifecycleV2RpcError("RESERVE_DENIED", {
      reason: result.reason,
      resetAt: "resetAt" in result ? result.resetAt : undefined,
      retryAfterSeconds:
        "retryAfterSeconds" in result ? result.retryAfterSeconds : undefined,
      remaining: "remaining" in result ? result.remaining : undefined,
    });
  }
  if (!routeMatchesExpectedV2(result.routeSnapshot, expectedRoute)) {
    throw new PolishLifecycleV2RpcError("RESERVE_UNKNOWN", {
      reason: "ROUTE_MISMATCH",
    });
  }
  return result;
}

export async function getPolishExecutionSnapshotV1(
  client: SupabaseClient,
  params: {
    reservationId: string;
    userId: string;
    reserveRoute: RouteSnapshotV1;
    runtimeTargetResolver: RuntimeTargetResolverV1;
  },
): Promise<ExecutionSnapshotSuccessV1> {
  const reservationId = requireCanonicalUuidV2(params.reservationId);
  const userId = requireCanonicalUuidV2(params.userId);
  const reserveRoute = parseRouteSnapshotInputV2(params.reserveRoute);
  const observation = await observeRpcV2(
    client,
    "get_ai_polish_execution_snapshot_v1",
    freezeRpcValueV2({
      p_reservation_id: reservationId,
      p_user_id: userId,
    }),
  );
  if (observation.kind === "ambiguous") {
    throw new PolishLifecycleV2RpcError("SNAPSHOT_UNAVAILABLE", {
      reason: "RPC_ERROR",
      cause: observation.cause,
    });
  }

  let result: ExecutionSnapshotResultV1;
  try {
    result = parseExecutionSnapshotV1(observation.data, {
      reservationId,
      reserveRoute,
      runtimeTargetResolver: params.runtimeTargetResolver,
    });
  } catch (cause) {
    const kind =
      cause instanceof PolishLifecycleV2ContractError &&
      cause.code === "RUNTIME_TARGET_UNAVAILABLE"
        ? "SNAPSHOT_UNAVAILABLE"
        : "SNAPSHOT_INVALID";
    throw new PolishLifecycleV2RpcError(kind, {
      reason:
        cause instanceof PolishLifecycleV2ContractError ? cause.code : "LOCAL_CONTRACT",
      cause,
    });
  }
  if (!result.ok) {
    const unavailable: ExecutionSnapshotFailureReasonV1 = "SERVICE_UNAVAILABLE";
    throw new PolishLifecycleV2RpcError(
      result.reason === unavailable ? "SNAPSHOT_UNAVAILABLE" : "SNAPSHOT_DENIED",
      { reason: result.reason },
    );
  }
  return result;
}

function startReadbackMatchesV2(
  result: ProviderAttemptStartV2,
  attemptNo: 1 | 2,
  route: RouteSnapshotV1,
): boolean {
  return (
    result.attemptNo === attemptNo &&
    result.status === "started" &&
    sameRouteSnapshotV1(result.routeSnapshot, route)
  );
}

/**
 * Admits one attempt. Only an ambiguous first observation is replayed. A
 * first-observation alreadyStarted receipt can belong to another execution
 * and is therefore never transmission authority.
 */
export async function startPolishProviderAttemptV2(
  client: SupabaseClient,
  params: {
    reservationId: string;
    attemptNo: 1 | 2;
    expectedRoute: RouteSnapshotV1;
  },
): Promise<ProviderAttemptStartV2> {
  const reservationId = requireCanonicalUuidV2(params.reservationId);
  if (params.attemptNo !== 1 && params.attemptNo !== 2) {
    throw localContractErrorV2();
  }
  const expectedRoute = parseRouteSnapshotInputV2(params.expectedRoute);
  const args = freezeRpcValueV2({
    p_reservation_id: reservationId,
    p_attempt_no: params.attemptNo,
  });

  const first = await observeRpcV2(client, "start_ai_polish_provider_attempt", args);
  let firstAmbiguity: unknown;
  if (first.kind === "response") {
    try {
      const result = parseAttemptStartRpcResultV2(first.data);
      if (!result.ok) {
        throw new PolishLifecycleV2RpcError("ATTEMPT_START_DENIED", {
          reason: result.reason,
        });
      }
      if (result.alreadyStarted) {
        throw new PolishLifecycleV2RpcError("ATTEMPT_START_REPLAY", {
          reason: "FIRST_OBSERVATION_REPLAY",
        });
      }
      if (startReadbackMatchesV2(result, params.attemptNo, expectedRoute)) {
        return result;
      }
      firstAmbiguity = new Error("attempt start readback mismatch");
    } catch (cause) {
      if (cause instanceof PolishLifecycleV2RpcError) throw cause;
      firstAmbiguity = cause;
    }
  } else {
    firstAmbiguity = first.cause;
  }

  const second = await observeRpcV2(client, "start_ai_polish_provider_attempt", args);
  if (second.kind === "ambiguous") {
    throw new PolishLifecycleV2RpcError("ATTEMPT_START_UNKNOWN", {
      reason: "RPC_ERROR",
      cause: second.cause ?? firstAmbiguity,
    });
  }
  try {
    const result = parseAttemptStartRpcResultV2(second.data);
    if (!result.ok) {
      throw new PolishLifecycleV2RpcError("ATTEMPT_START_UNKNOWN", {
        reason: result.reason,
        cause: firstAmbiguity,
      });
    }
    if (!startReadbackMatchesV2(result, params.attemptNo, expectedRoute)) {
      throw new PolishLifecycleV2RpcError("ATTEMPT_START_UNKNOWN", {
        reason: "READBACK_MISMATCH",
        cause: firstAmbiguity,
      });
    }
    return result;
  } catch (cause) {
    if (cause instanceof PolishLifecycleV2RpcError) throw cause;
    throw new PolishLifecycleV2RpcError("ATTEMPT_START_UNKNOWN", {
      reason: "MALFORMED_RESPONSE",
      cause,
    });
  }
}

export interface PolishAttemptCompletionRpcPayloadV2 {
  readonly p_attempt_id: string;
  readonly p_status: PolishAttemptStatusV2;
  /** Durable adapter-entry observation persisted with the terminal fact. */
  readonly p_transmitted: boolean;
  readonly p_retry_eligible: boolean;
  readonly p_provider_billable: boolean | null;
  readonly p_usage: Readonly<{
    schema_version: "normalized_usage_v2";
    input_total_tokens: number;
    input_cache_read_tokens: number;
    input_cache_write_tokens: number | null;
    input_standard_tokens: number;
    output_tokens: number;
    reasoning_tokens: number | null;
    cache_usage_reporting: "reported" | "unavailable" | "not_applicable";
    usage_complete: boolean;
  }> | null;
  readonly p_route: Readonly<{
    schema_version: "route_observation_v1";
    gateway_request_id: string | null;
    provider_request_id: string | null;
    actual_upstream_endpoint: string | null;
    actual_model_id: string | null;
    router_attempt_count: number | null;
  }>;
  readonly p_cost: Readonly<{
    schema_version: "cost_observation_v1";
    estimated_currency: string | null;
    estimated_cost_nanos: string | null;
    provider_reported_currency: string | null;
    provider_reported_cost_nanos: string | null;
    reconciliation_status:
      | "incomplete_usage"
      | "not_available"
      | "matched"
      | "mismatch";
  }>;
  readonly p_metadata: Readonly<{
    schema_version: "attempt_metadata_v1";
    finish_reason: string | null;
    failure_stage: string | null;
    latency_ms: number;
  }>;
}

function requireNullableNonEmptyStringV2(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw localContractErrorV2();
  }
  return value;
}

function requireMoneyV2(
  value: unknown,
  billingCurrency: string,
): Readonly<{ currency: string; nanos: string }> | null {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) throw localContractErrorV2();
  const money = value as { currency?: unknown; nanos?: unknown };
  if (
    typeof money.currency !== "string" ||
    money.currency !== billingCurrency ||
    typeof money.nanos !== "string" ||
    money.nanos.length > 19 ||
    !CANONICAL_NANOS_V2.test(money.nanos) ||
    BigInt(money.nanos) > MAX_POSTGRES_BIGINT_V2
  ) {
    throw localContractErrorV2();
  }
  return Object.freeze({ currency: money.currency, nanos: money.nanos });
}

function taggedRouteIdV2(
  value: unknown,
  fieldKind: "gateway_request_id" | "provider_request_id",
  secret: unknown,
): string | null {
  const observation = observeRouteIdentifierV1(value, fieldKind, secret);
  return observation.kind === "tagged" ? observation.value : null;
}

/** Pure, strict serializer for the nine-argument terminal-attempt RPC. */
export function serializePolishAttemptCompletionV2(params: {
  attempt: ProviderAttemptStartV2;
  fact: PolishAttemptCompletedFactV2;
  profileExecutionConfig: ProfileExecutionConfigV1;
  billingCurrency: string;
  routeObservationSecret: unknown;
}): PolishAttemptCompletionRpcPayloadV2 {
  try {
    const attempt = parseAttemptStartRpcResultV2(params.attempt);
    if (!attempt.ok || attempt.status !== "started") throw localContractErrorV2();
    const profile = validateProfileExecutionConfig(params.profileExecutionConfig);
    if (
      attempt.routeSnapshot.gatewayKind !== profile.gatewayKind ||
      attempt.routeSnapshot.modelId !== profile.modelId ||
      attempt.routeSnapshot.wireApiKind !== profile.wireApiKind ||
      attempt.routeSnapshot.displayDisclosureKey !== profile.displayDisclosureKey
    ) {
      throw localContractErrorV2();
    }
    const expectedUpstreamEndpoint = resolveEndpoint(profile.endpointAlias).url;
    if (!CURRENCY_V2.test(params.billingCurrency)) throw localContractErrorV2();

    const fact = params.fact;
    if (
      fact.schemaVersion !== "polish_attempt_completed_v2" ||
      fact.started.schemaVersion !== "polish_attempt_started_v2" ||
      fact.started.attemptNo !== attempt.attemptNo ||
      !ATTEMPT_STATUSES_V2.has(fact.status) ||
      typeof fact.retryEligible !== "boolean" ||
      (fact.retryEligible &&
        (fact.started.attemptNo !== 1 ||
          !["failed_upstream", "timed_out", "invalid_output"].includes(
            fact.status,
          ))) ||
      (fact.started.attemptNo === 2 && fact.retryEligible) ||
      (fact.providerBillable !== null && typeof fact.providerBillable !== "boolean")
    ) {
      throw localContractErrorV2();
    }

    let usage: PolishAttemptCompletionRpcPayloadV2["p_usage"];
    let usageComplete = false;
    if (fact.usageObservation.kind === "observed") {
      const observed = assertNormalizedUsageV2(fact.usageObservation.usage);
      usageComplete = observed.usageComplete;
      usage = {
        schema_version: "normalized_usage_v2",
        input_total_tokens: observed.inputTotalTokens,
        input_cache_read_tokens: observed.inputCacheReadTokens,
        input_cache_write_tokens: observed.inputCacheWriteTokens,
        input_standard_tokens: observed.inputStandardTokens,
        output_tokens: observed.outputTokens,
        reasoning_tokens: observed.reasoningTokens,
        cache_usage_reporting: observed.cacheUsageReporting,
        usage_complete: observed.usageComplete,
      };
    } else if (
      fact.usageObservation.kind === "unavailable" &&
      fact.usageObservation.usage === null &&
      fact.usageObservation.usageComplete === false
    ) {
      usage = null;
    } else {
      throw localContractErrorV2();
    }

    if (
      fact.route.schemaVersion !== "route_observation_v1" ||
      (fact.route.routerAttemptCount !== null &&
        (!Number.isInteger(fact.route.routerAttemptCount) ||
          fact.route.routerAttemptCount < 1 ||
          fact.route.routerAttemptCount > 100))
    ) {
      throw localContractErrorV2();
    }
    const actualUpstreamEndpoint = requireNullableNonEmptyStringV2(
      fact.route.actualUpstreamEndpoint,
    );
    if (
      actualUpstreamEndpoint !== null &&
      actualUpstreamEndpoint !== expectedUpstreamEndpoint
    ) {
      throw localContractErrorV2();
    }
    const actualModelId = requireNullableNonEmptyStringV2(fact.route.actualModelId);
    if (actualModelId !== null && actualModelId !== attempt.routeSnapshot.modelId) {
      throw localContractErrorV2();
    }

    if (fact.cost.schemaVersion !== "cost_observation_v1") {
      throw localContractErrorV2();
    }
    const estimated = requireMoneyV2(fact.cost.estimatedCost, params.billingCurrency);
    const providerReported = requireMoneyV2(
      fact.cost.providerReportedCost,
      params.billingCurrency,
    );
    const incompleteReasons = fact.cost.incompleteReasons;
    if (
      !Array.isArray(incompleteReasons) ||
      incompleteReasons.some(
        (reason) =>
          typeof reason !== "string" || !COST_INCOMPLETE_REASONS_V2.has(reason),
      ) ||
      new Set(incompleteReasons).size !== incompleteReasons.length ||
      (fact.cost.estimationStatus === "complete" &&
        (estimated === null || incompleteReasons.length !== 0)) ||
      (fact.cost.estimationStatus === "incomplete_usage" &&
        (estimated !== null || incompleteReasons.length === 0)) ||
      (fact.cost.estimationStatus !== "complete" &&
        fact.cost.estimationStatus !== "incomplete_usage") ||
      (usage === null && estimated !== null) ||
      (!usageComplete && estimated !== null) ||
      (fact.providerBillable === false &&
        providerReported !== null &&
        providerReported.nanos !== "0")
    ) {
      throw localContractErrorV2();
    }

    if (
      (fact.finishReason !== null && !FINISH_REASONS_V2.has(fact.finishReason)) ||
      (fact.failureStage !== null && !FAILURE_STAGES_V2.has(fact.failureStage)) ||
      !Number.isInteger(fact.latencyMs) ||
      fact.latencyMs < 0 ||
      fact.latencyMs > MAX_POSTGRES_INTEGER_V2
    ) {
      throw localContractErrorV2();
    }

    const reconciliationStatus =
      estimated === null
        ? "incomplete_usage"
        : providerReported === null
          ? "not_available"
          : estimated.nanos === providerReported.nanos
            ? "matched"
            : "mismatch";
    const payload: PolishAttemptCompletionRpcPayloadV2 = {
      p_attempt_id: requireCanonicalUuidV2(attempt.attemptId),
      p_status: fact.status,
      p_transmitted: fact.transmitted,
      p_retry_eligible: fact.retryEligible,
      p_provider_billable: fact.providerBillable,
      p_usage: usage,
      p_route: {
        schema_version: "route_observation_v1",
        gateway_request_id: taggedRouteIdV2(
          fact.route.gatewayRequestId,
          "gateway_request_id",
          params.routeObservationSecret,
        ),
        provider_request_id: taggedRouteIdV2(
          fact.route.providerRequestId,
          "provider_request_id",
          params.routeObservationSecret,
        ),
        actual_upstream_endpoint: actualUpstreamEndpoint,
        actual_model_id: actualModelId,
        router_attempt_count: fact.route.routerAttemptCount,
      },
      p_cost: {
        schema_version: "cost_observation_v1",
        estimated_currency: estimated?.currency ?? null,
        estimated_cost_nanos: estimated?.nanos ?? null,
        provider_reported_currency: providerReported?.currency ?? null,
        provider_reported_cost_nanos: providerReported?.nanos ?? null,
        reconciliation_status: reconciliationStatus,
      },
      p_metadata: {
        schema_version: "attempt_metadata_v1",
        finish_reason: fact.finishReason,
        failure_stage: fact.failureStage,
        latency_ms: fact.latencyMs,
      },
    };
    return freezeRpcValueV2(payload);
  } catch (cause) {
    if (cause instanceof PolishLifecycleV2RpcError) throw cause;
    throw localContractErrorV2(cause);
  }
}

function completionReadbackMatchesV2(
  result: ProviderAttemptCompleteV2,
  payload: PolishAttemptCompletionRpcPayloadV2,
): boolean {
  return (
    result.status === payload.p_status &&
    result.usageComplete === (payload.p_usage?.usage_complete ?? false)
  );
}

export async function completePolishProviderAttemptV2(
  client: SupabaseClient,
  params: Parameters<typeof serializePolishAttemptCompletionV2>[0],
): Promise<ProviderAttemptCompleteV2> {
  const payload = serializePolishAttemptCompletionV2(params);
  const first = await observeRpcV2(
    client,
    "complete_ai_polish_provider_attempt",
    payload,
  );
  let firstAmbiguity: unknown;
  if (first.kind === "response") {
    try {
      const result = parseAttemptCompleteRpcResultV2(first.data);
      if (!result.ok) {
        throw new PolishLifecycleV2RpcError("ATTEMPT_COMPLETE_REJECTED", {
          reason: result.reason,
        });
      }
      if (!completionReadbackMatchesV2(result, payload)) {
        throw new PolishLifecycleV2RpcError("ATTEMPT_COMPLETE_REJECTED", {
          reason: "READBACK_MISMATCH",
        });
      }
      return result;
    } catch (cause) {
      if (cause instanceof PolishLifecycleV2RpcError) throw cause;
      firstAmbiguity = cause;
    }
  } else {
    firstAmbiguity = first.cause;
  }

  const second = await observeRpcV2(
    client,
    "complete_ai_polish_provider_attempt",
    payload,
  );
  if (second.kind === "ambiguous") {
    throw new PolishLifecycleV2RpcError("ATTEMPT_COMPLETE_UNKNOWN", {
      reason: "RPC_ERROR",
      cause: second.cause ?? firstAmbiguity,
    });
  }
  try {
    const result = parseAttemptCompleteRpcResultV2(second.data);
    if (!result.ok) {
      throw new PolishLifecycleV2RpcError("ATTEMPT_COMPLETE_UNKNOWN", {
        reason: result.reason,
        cause: firstAmbiguity,
      });
    }
    if (!completionReadbackMatchesV2(result, payload)) {
      throw new PolishLifecycleV2RpcError("ATTEMPT_COMPLETE_REJECTED", {
        reason: "READBACK_MISMATCH",
      });
    }
    return result;
  } catch (cause) {
    if (cause instanceof PolishLifecycleV2RpcError) throw cause;
    throw new PolishLifecycleV2RpcError("ATTEMPT_COMPLETE_UNKNOWN", {
      reason: "MALFORMED_RESPONSE",
      cause,
    });
  }
}

type CancellationObservationV2 = Readonly<{
  ok: true;
  reservationId: string;
  state: "observed" | "ambiguous";
}>;

function parseCancellationObservationV2(
  value: unknown,
  expectedReservationId: string,
): CancellationObservationV2 {
  if (typeof value !== "object" || value === null) throw localContractErrorV2();
  const row = value as {
    ok?: unknown;
    reservationId?: unknown;
    state?: unknown;
    reason?: unknown;
  };
  const keys = Object.keys(row).sort().join(",");
  if (
    keys === "ok,reason" &&
    row.ok === false &&
    typeof row.reason === "string" &&
    row.reason.length > 0
  ) {
    throw new PolishLifecycleV2RpcError("CANCELLATION_REJECTED", {
      reason: row.reason,
    });
  }
  if (
    keys !== "ok,reservationId,state" ||
    row.ok !== true ||
    row.reservationId !== expectedReservationId ||
    !CANONICAL_UUID_V2.test(row.reservationId) ||
    (row.state !== "observed" && row.state !== "ambiguous")
  ) {
    throw localContractErrorV2();
  }
  return Object.freeze({
    ok: true,
    reservationId: row.reservationId,
    state: row.state,
  });
}

/**
 * Durably serializes request cancellation with the parent ledger row. An
 * ambiguous observed-write is followed by an exact readback/replay and then
 * a monotonic fail-closed marker; callers must not finalize when no observed
 * receipt is returned.
 */
export async function recordPolishRequestCancellationV2(
  client: SupabaseClient,
  params: { reservationId: string },
): Promise<CancellationObservationV2> {
  const reservationId = requireCanonicalUuidV2(params.reservationId);
  const observedArgs = freezeRpcValueV2({
    p_reservation_id: reservationId,
    p_observation: "observed",
  });
  let firstCause: unknown;
  for (let observationNo = 0; observationNo < 2; observationNo += 1) {
    const observation = await observeRpcV2(
      client,
      "record_ai_polish_request_cancellation",
      observedArgs,
    );
    if (observation.kind === "response") {
      let result: CancellationObservationV2;
      try {
        result = parseCancellationObservationV2(
          observation.data,
          reservationId,
        );
      } catch (cause) {
        if (
          cause instanceof PolishLifecycleV2RpcError &&
          cause.kind === "CANCELLATION_REJECTED"
        ) {
          throw cause;
        }
        firstCause ??= cause;
        continue;
      }
      if (result.state !== "observed") {
        throw new PolishLifecycleV2RpcError("CANCELLATION_UNKNOWN", {
          reason: "READBACK_MISMATCH",
          cause: firstCause,
        });
      }
      return result;
    }
    firstCause ??= observation.cause;
  }

  const held = await observeRpcV2(
    client,
    "record_ai_polish_request_cancellation",
    freezeRpcValueV2({
      p_reservation_id: reservationId,
      p_observation: "ambiguous",
    }),
  );
  if (held.kind === "response") {
    try {
      const result = parseCancellationObservationV2(held.data, reservationId);
      if (result.state === "observed") return result;
    } catch (cause) {
      throw new PolishLifecycleV2RpcError("CANCELLATION_UNKNOWN", {
        reason: "AMBIGUOUS_MARK_REJECTED",
        cause,
      });
    }
  }
  throw new PolishLifecycleV2RpcError("CANCELLATION_UNKNOWN", {
    reason: "RPC_ERROR",
    cause: held.kind === "ambiguous" ? held.cause : firstCause,
  });
}

export interface PolishFinalizeMetadataV2 {
  readonly granularity: PolishGranularity;
  readonly itemCount: number;
  readonly contextLevel: 0 | 1 | 2;
  readonly language: "zh" | "en";
  readonly promptVersion: string;
  readonly validatorVersion: string;
}

export type PolishFinalizeRequestV2 =
  | Readonly<{
      settlementKind: "attempt_v2";
      reservationId: string;
      status: "succeeded" | "canceled" | "failed_upstream" | "invalid_output";
      /**
       * Process-local assertion used only to build p_quota_charged. The DB
       * independently derives and verifies it from durable child facts.
       */
      transmitted: boolean;
      providerBillable: boolean | null;
      metadata: PolishFinalizeMetadataV2;
    }>
  | Readonly<{
      settlementKind: "zero_child_release";
      reservationId: string;
      metadata?: PolishFinalizeMetadataV2;
    }>;

export interface PolishFinalizeCallOptionsV2 {
  /**
   * Cancellation does not abort an in-flight DB RPC. It prevents an
   * ambiguous first observation from launching a second settlement write
   * while request cancellation is racing for the same parent-row lock.
   */
  readonly signal?: AbortSignal;
}

export interface PolishFinalizeRpcPayloadV2 {
  readonly p_reservation_id: string;
  readonly p_status:
    | "succeeded"
    | "canceled"
    | "failed_upstream"
    | "invalid_output"
    | "released";
  readonly p_quota_charged: boolean;
  readonly p_provider_billable: boolean | null;
  readonly p_usage: null;
  readonly p_metadata: Readonly<Record<string, string | number>> | null;
  /** Selects the DB-authoritative durable cancellation/sequence path. */
  readonly p_settlement_contract: "durable_cancellation_sequence_v1";
}

function serializeFinalizeMetadataV2(
  metadata: PolishFinalizeMetadataV2,
): Readonly<{
  granularity: PolishGranularity;
  item_count: number;
  context_level: 0 | 1 | 2;
  language: "zh" | "en";
  prompt_version: string;
  validator_version: string;
}> {
  if (
    !(POLISH_GRANULARITIES as readonly string[]).includes(metadata.granularity) ||
    !Number.isInteger(metadata.itemCount) ||
    metadata.itemCount < 1 ||
    metadata.itemCount > MAX_ITEMS ||
    !([0, 1, 2] as const).includes(metadata.contextLevel) ||
    (metadata.language !== "zh" && metadata.language !== "en") ||
    !CODE_VERSION_V2.test(metadata.promptVersion) ||
    !CODE_VERSION_V2.test(metadata.validatorVersion)
  ) {
    throw localContractErrorV2();
  }
  return Object.freeze({
    granularity: metadata.granularity,
    item_count: metadata.itemCount,
    context_level: metadata.contextLevel,
    language: metadata.language,
    prompt_version: metadata.promptVersion,
    validator_version: metadata.validatorVersion,
  });
}

/**
 * Serializes the mutually exclusive V2 settlement sources. Attempt-backed
 * settlement always selects child aggregation and zero-child release never
 * includes that selector. p_quota_charged is an assertion, not authority: the
 * audited DB signature recomputes it from locked attempt rows.
 */
export function serializePolishFinalizeV2(
  params: PolishFinalizeRequestV2,
): PolishFinalizeRpcPayloadV2 {
  try {
    const reservationId = requireCanonicalUuidV2(params.reservationId);
    if (params.settlementKind === "zero_child_release") {
      const metadata = params.metadata
        ? serializeFinalizeMetadataV2(params.metadata)
        : null;
      return freezeRpcValueV2({
        p_reservation_id: reservationId,
        p_status: "released" as const,
        p_quota_charged: false,
        p_provider_billable: false,
        p_usage: null,
        p_metadata: metadata,
        p_settlement_contract: "durable_cancellation_sequence_v1",
      });
    }

    if (
      !(["succeeded", "canceled", "failed_upstream", "invalid_output"] as const).includes(
        params.status,
      ) ||
      typeof params.transmitted !== "boolean" ||
      (params.providerBillable !== null && typeof params.providerBillable !== "boolean")
    ) {
      throw localContractErrorV2();
    }
    const metadata = serializeFinalizeMetadataV2(params.metadata);
    return freezeRpcValueV2({
      p_reservation_id: reservationId,
      p_status: params.status,
      p_quota_charged:
        params.status === "succeeded" ||
        (params.status === "canceled" && params.transmitted),
      p_provider_billable: params.providerBillable,
      p_usage: null,
      p_metadata: {
        usage_schema_version: "attempt_v2",
        ...metadata,
      },
      p_settlement_contract: "durable_cancellation_sequence_v1",
    });
  } catch (cause) {
    if (cause instanceof PolishLifecycleV2RpcError) throw cause;
    throw localContractErrorV2(cause);
  }
}

function finalizeReadbackMatchesV2(
  result: PolishFinalizeResultV2,
  payload: PolishFinalizeRpcPayloadV2,
): boolean {
  return (
    result.status === payload.p_status &&
    result.quotaCharged === payload.p_quota_charged
  );
}

export async function finalizePolishRequestV2(
  client: SupabaseClient,
  params: PolishFinalizeRequestV2,
  options: PolishFinalizeCallOptionsV2 = {},
): Promise<PolishFinalizeResultV2> {
  const payload = serializePolishFinalizeV2(params);
  const first = await observeRpcV2(client, "finalize_ai_polish_request", payload);
  let firstAmbiguity: unknown;
  if (first.kind === "response") {
    try {
      const result = parseFinalizeRpcResultV2(first.data);
      if (!result.ok) {
        throw new PolishLifecycleV2RpcError("FINALIZE_REJECTED", {
          reason: result.reason,
        });
      }
      if (!finalizeReadbackMatchesV2(result, payload)) {
        throw new PolishLifecycleV2RpcError("FINALIZE_CONFLICT", {
          reason: "READBACK_MISMATCH",
        });
      }
      return result;
    } catch (cause) {
      if (cause instanceof PolishLifecycleV2RpcError) throw cause;
      firstAmbiguity = cause;
    }
  } else {
    firstAmbiguity = first.cause;
  }

  if (options.signal?.aborted) {
    throw new PolishLifecycleV2RpcError("FINALIZE_UNKNOWN", {
      reason: "CANCELED_BEFORE_RETRY",
      cause: firstAmbiguity,
    });
  }

  const second = await observeRpcV2(client, "finalize_ai_polish_request", payload);
  if (second.kind === "ambiguous") {
    throw new PolishLifecycleV2RpcError("FINALIZE_UNKNOWN", {
      reason: "RPC_ERROR",
      cause: second.cause ?? firstAmbiguity,
    });
  }
  try {
    const result = parseFinalizeRpcResultV2(second.data);
    if (!result.ok) {
      throw new PolishLifecycleV2RpcError("FINALIZE_UNKNOWN", {
        reason: result.reason,
        cause: firstAmbiguity,
      });
    }
    if (!finalizeReadbackMatchesV2(result, payload)) {
      throw new PolishLifecycleV2RpcError("FINALIZE_CONFLICT", {
        reason: "READBACK_MISMATCH",
      });
    }
    return result;
  } catch (cause) {
    if (cause instanceof PolishLifecycleV2RpcError) throw cause;
    throw new PolishLifecycleV2RpcError("FINALIZE_UNKNOWN", {
      reason: "MALFORMED_RESPONSE",
      cause,
    });
  }
}
