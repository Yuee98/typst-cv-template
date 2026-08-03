/**
 * Request lifecycle of the polish API routes (unit 2.3) — the DI core.
 *
 *   POST /api/polish:
 *     deployment switch → auth (Bearer) → ai_terms gate → bounded reader →
 *     JSON parse → polishRequestSchema → reserve (atomic: runtime switch,
 *     dedup 409×2 under an advisory lock, global pre-filter, user quota,
 *     rate limit) → mark_provider_started per attempt (authoritative
 *     atomic global-cap gate, via the orchestrator hook) → orchestrator
 *     (publishes terminal progress: cumulative usage + providerCallEntered)
 *     → finalize (settlement table + atomic post-settlement quota snapshot)
 *     → response
 *
 *   GET /api/polish/quota:
 *     deployment switch → login check ONLY (no ai_terms gate) → quota read
 *
 * This module is dependency-injected and side-effect free: it reads no env
 * and creates no clients, so vitest never touches real services. The live
 * wiring (module-scope resolution with refuse-to-start semantics) lives in
 * handler.ts.
 *
 * Logging obeys the roadmap no-store list (禁存清单): only requestId, the
 * internal userId, providerRequestId, usage numbers, error codes, latency
 * and request metadata are logged — never prompt text, response text,
 * styleInstruction, headers, tokens, or provider raw bodies. The
 * PolishLogEvent type carries no field that could hold content.
 */

import { randomUUID } from "node:crypto";

import {
  MAX_BODY_BYTES,
  POLISH_ERROR_HTTP_STATUS,
  polishRequestSchema,
  type PolishErrorCode,
  type PolishErrorResponse,
  type PolishQuota,
  type PolishQuotaResponse,
  type PolishSuccessResponse,
} from "@/lib/polish/contract";
import {
  orchestratePolish,
  PolishOrchestrationError,
  POLISH_PROMPT_VERSION,
  POLISH_VALIDATOR_VERSION,
  zeroPolishUsage,
  type PolishOrchestrationFailureStage,
  type PolishOrchestrationProgress,
  type PolishProvider,
  type PolishProviderUsage,
} from "./orchestrator";
import { requirePolishUser, verifyBearerUser } from "./auth";
import {
  INTERNAL_QUOTA_SERVICE_MESSAGE,
  PolishQuotaError,
  type PolishFinalizeResult,
  type PolishFinalizeStatus,
  type PolishLedgerMetadata,
  type PolishQuotaStatus,
  type PolishReservation,
  type PolishTokenUsage,
  type ProviderStartedMark,
} from "./quota";

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

export interface PolishFinalizeCall {
  reservationId: string;
  status: PolishFinalizeStatus;
  quotaCharged: boolean;
  providerBillable?: boolean | null;
  usage?: PolishTokenUsage;
  metadata?: PolishLedgerMetadata;
}

export interface PolishRouteDeps {
  /** Resolves a user access token to a user id, or null when invalid/expired. */
  verifyAccessToken(token: string): Promise<string | null>;
  hasAcceptedCurrentAiTerms(userId: string): Promise<boolean>;
  /** Atomic runtime-switch + dedup + quota + rate-limit reservation (1.3). */
  reserve(params: {
    userId: string;
    requestId: string;
    clientRequestId: string;
  }): Promise<PolishReservation>;
  /** reserved → provider_started, once per provider attempt. */
  markProviderStarted(
    reservationId: string,
    providerRequestId?: string,
  ): Promise<ProviderStartedMark>;
  /** Idempotent settlement (roadmap settlement table). */
  finalize(params: PolishFinalizeCall): Promise<PolishFinalizeResult>;
  getQuota(userId: string): Promise<PolishQuotaStatus>;
  provider: PolishProvider;
  /** Pseudonymous provider id: HMAC_SHA256(AI_USER_ID_HMAC_SECRET, userId), hex. */
  providerUserId(userId: string): string;
  /** Model id recorded in ledger metadata (DEEPSEEK_POLISH_MODEL / "fake-llm"). */
  model: string;
  /** Deployment-level hard switch (AI_POLISH_ENABLED); off → 503 everything. */
  aiPolishEnabled: boolean;
  /** Time source, injectable for deterministic latency/Retry-After tests. */
  now?: () => number;
  /** requestId factory, injectable for tests. Defaults to crypto.randomUUID. */
  createRequestId?: () => string;
  /** Structured metadata logger; defaults to a no-op in tests. */
  logger?: (event: PolishLogEvent) => void;
}

/**
 * Structured log event — metadata only, by construction. There is no field
 * for CV text, polished output, style instructions, headers, tokens, or
 * provider bodies, so a conforming logger cannot violate the no-store list.
 */
export interface PolishLogEvent {
  event:
    | "polish.request.completed"
    | "polish.request.failed"
    | "polish.request.denied"
    | "polish.request.canceled"
    | "polish.finalize_failed"
    | "polish.quota_read_failed"
    | "polish.quota.served"
    | "polish.quota.denied";
  requestId: string;
  /** Internal supabase user id (roadmap explicitly allows it in server logs). */
  userId?: string;
  code?: PolishErrorCode;
  failureStage?: string;
  granularity?: string;
  itemCount?: number;
  contextLevel?: number;
  language?: string;
  attempts?: number;
  providerRequestId?: string;
  upstreamStatus?: number;
  inputCachedTokens?: number;
  inputUncachedTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
}

// ---------------------------------------------------------------------------
// Response helpers — every response carries no-store + X-Request-Id
// ---------------------------------------------------------------------------

/** Retry-After hint (seconds) for 503s, which carry no RPC-provided timing. */
export const POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS = 300;

function baseHeaders(requestId: string): Record<string, string> {
  return { "Cache-Control": "no-store", "X-Request-Id": requestId };
}

function errorResponse(
  requestId: string,
  code: PolishErrorCode,
  message: string,
  options?: { resetAt?: string; retryAfterSeconds?: number },
): Response {
  const body: PolishErrorResponse = {
    requestId,
    error: {
      code,
      message,
      ...(options?.resetAt !== undefined ? { resetAt: options.resetAt } : {}),
      ...(options?.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: options.retryAfterSeconds }
        : {}),
    },
  };
  const headers = baseHeaders(requestId);
  if (options?.retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(options.retryAfterSeconds);
  }
  return Response.json(body, {
    status: POLISH_ERROR_HTTP_STATUS[code],
    headers,
  });
}

// ---------------------------------------------------------------------------
// Bounded body reader (roadmap「真 bounded body reader」)
// ---------------------------------------------------------------------------

type BoundedBody =
  | { ok: true; text: string }
  | { ok: false; code: "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE"; message: string };

function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mime = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mime === "application/json";
}

/**
 * Reads at most MAX_BODY_BYTES from the request body: the Content-Length
 * pre-check rejects oversized bodies before any read, then the stream is
 * consumed incrementally and cancelled as soon as the cap is exceeded.
 * `request.text()` is never used — it would buffer the whole body first.
 */
async function readBoundedBody(request: Request): Promise<BoundedBody> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Content-Type must be application/json.",
    };
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return {
        ok: false,
        code: "PAYLOAD_TOO_LARGE",
        message: `Request body exceeds the ${MAX_BODY_BYTES}-byte limit.`,
      };
    }
  }

  if (request.body === null) {
    return { ok: true, text: "" };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          code: "PAYLOAD_TOO_LARGE",
          message: `Request body exceeds the ${MAX_BODY_BYTES}-byte limit.`,
        };
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return { ok: true, text: chunks.join("") };
}

// ---------------------------------------------------------------------------
// Failure-stage mapping: orchestrator stage → ledger failure_stage enum
// ---------------------------------------------------------------------------

function toLedgerFailureStage(
  stage: PolishOrchestrationFailureStage,
  code: PolishOrchestrationError["code"],
): NonNullable<PolishLedgerMetadata["failureStage"]> {
  if (stage === "transport") {
    return code === "UPSTREAM_TIMEOUT" ? "provider_timeout" : "provider_http";
  }
  if (stage === "json_parse") return "json_parse";
  if (stage === "schema_validation" || stage === "id_set_mismatch") {
    return "schema_validation";
  }
  // finish_reason / empty_content / empty_item / length_cap /
  // total_length_cap / language_mismatch / protected_spans
  return "semantic_validation";
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function toTokenUsage(usage: PolishProviderUsage, usageComplete: boolean): PolishTokenUsage {
  return {
    inputCachedTokens: usage.cachedReadTokens,
    inputUncachedTokens: usage.uncachedReadTokens,
    outputTokens: usage.completionTokens,
    usageComplete,
  };
}

function hasBillableUsage(usage: PolishProviderUsage): boolean {
  return (
    usage.promptTokens > 0 || usage.completionTokens > 0
  );
}

/** Seconds until an ISO instant, at least 1 — for Retry-After on 429s. */
function secondsUntil(iso: string, now: number): number {
  return Math.max(1, Math.ceil((Date.parse(iso) - now) / 1000));
}

/**
 * PostgREST serializes timestamptz with a "+00:00" offset, but the frozen
 * wire schema (polishQuotaSchema / polishErrorResponseSchema) only accepts
 * ISO UTC datetimes ("Z" suffix) — normalize at the response boundary.
 */
function toIsoUtc(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toISOString();
}

// ---------------------------------------------------------------------------
// POST /api/polish
// ---------------------------------------------------------------------------

async function handlePolishPost(request: Request, deps: PolishRouteDeps): Promise<Response> {
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? (() => undefined);
  const requestId = deps.createRequestId?.() ?? randomUUID();
  const startedAt = now();

  const deny = (
    code: PolishErrorCode,
    message: string,
    options?: { resetAt?: string; retryAfterSeconds?: number; userId?: string },
  ): Response => {
    log({ event: "polish.request.denied", requestId, userId: options?.userId, code, latencyMs: now() - startedAt });
    return errorResponse(requestId, code, message, options);
  };

  // 1. Deployment-level hard switch (default off): 503 before any work,
  //    exactly like the Phase 0 stub did for every request.
  if (!deps.aiPolishEnabled) {
    return deny("AI_DISABLED", "AI polish is not available.", {
      retryAfterSeconds: POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS,
    });
  }

  // 2. Bearer auth + ai_terms gate (1.2).
  const auth = await requirePolishUser(request.headers.get("authorization"), deps);
  if (!auth.ok) {
    return deny(auth.error.code, auth.error.message);
  }
  const userId = auth.userId;

  // 3. Bounded read (413) → 4. JSON parse (400) → 5. schema validation (400).
  //    computePolishMaxOutputTokens is only ever reached AFTER
  //    polishRequestSchema succeeds (inside the orchestrator) — CP1 round3.
  const body = await readBoundedBody(request);
  if (!body.ok) {
    return deny(body.code, body.message, { userId });
  }

  let rawBody: unknown;
  try {
    rawBody = JSON.parse(body.text);
  } catch {
    return deny("INVALID_REQUEST", "Request body must be a valid JSON object.", { userId });
  }

  const parsed = polishRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return deny(
      "INVALID_REQUEST",
      `Request failed validation (${path}${issue?.message ?? "invalid"}).`,
      { userId },
    );
  }
  const polishRequest = parsed.data;
  const requestMeta = {
    granularity: polishRequest.granularity,
    itemCount: polishRequest.items.length,
    contextLevel: polishRequest.context.level,
    language: polishRequest.language,
  } as const;

  // 6. Reserve: atomic runtime kill switch + global daily limit + per-user
  //    quota + rate limit + clientRequestId dedup (409×2). Denials arrive as
  //    PolishQuotaError carrying the contract code (+ resetAt / retryAfter).
  let reservation: PolishReservation;
  try {
    reservation = await deps.reserve({
      userId,
      requestId,
      clientRequestId: polishRequest.clientRequestId,
    });
  } catch (error) {
    if (error instanceof PolishQuotaError) {
      const retryAfterSeconds =
        error.code === "QUOTA_EXCEEDED" && error.resetAt
          ? secondsUntil(error.resetAt, now())
          : (error.retryAfterSeconds ??
            (error.code === "AI_DISABLED" || error.code === "SERVICE_UNAVAILABLE"
              ? POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS
              : undefined));
      return deny(error.code, error.code === "INTERNAL_ERROR" ? INTERNAL_QUOTA_SERVICE_MESSAGE : error.message, {
        resetAt: error.resetAt === undefined ? undefined : toIsoUtc(error.resetAt),
        retryAfterSeconds,
        userId,
      });
    }
    log({
      event: "polish.request.failed",
      requestId,
      userId,
      code: "INTERNAL_ERROR",
      latencyMs: now() - startedAt,
    });
    return errorResponse(requestId, "INTERNAL_ERROR", "Failed to reserve the polish request.");
  }

  // 7. Orchestrate (prompt + validation + ≤2 attempts inside the 45s
  //    deadline). mark_provider_started fires per attempt via the hook so the
  //    global cost counter counts every transmission (roadmap invariant 7).
  //
  //    Terminal progress (relay #3): the orchestrator publishes a snapshot
  //    when a provider call is ENTERED and after EVERY provider result, so
  //    every exit path below — success, budget exhaustion, cancellation,
  //    attempt-start hook failure, global-gate denial — settles with the
  //    known cumulative usage and the true providerCallEntered flag (a
  //    successful ledger mark alone is NOT proof of an upstream call).
  const progress: PolishOrchestrationProgress = {
    completedAttempts: 0,
    cumulativeUsage: zeroPolishUsage(),
    lastProviderRequestId: undefined,
    providerCallEntered: false,
  };
  const baseMetadata: PolishLedgerMetadata = {
    ...requestMeta,
    model: deps.model,
    promptVersion: POLISH_PROMPT_VERSION,
    validatorVersion: POLISH_VALIDATOR_VERSION,
  };

  /** Settlement that never masks the primary outcome (logged on failure). */
  const finalizeQuiet = async (params: Omit<PolishFinalizeCall, "reservationId">): Promise<void> => {
    try {
      await deps.finalize({ reservationId: reservation.reservationId, ...params });
    } catch {
      log({
        event: "polish.finalize_failed",
        requestId,
        userId,
        ...requestMeta,
        latencyMs: now() - startedAt,
      });
    }
  };

  /**
   * Shared terminal-settlement facts derived from the progress snapshot:
   * usage known from completed provider attempts is ALWAYS recorded
   * (roadmap invariant 7), and billability reflects what is actually known —
   * content returned → billable; a call entered with no usage back →
   * unknown (null, relay #4); never entered → not billable.
   */
  const progressSettlement = (): {
    providerBillable: boolean | null;
    usage?: PolishTokenUsage;
  } => {
    const hasUsage = hasBillableUsage(progress.cumulativeUsage);
    return {
      providerBillable: hasUsage ? true : progress.providerCallEntered ? null : false,
      usage: hasUsage
        ? // The recorded attempts' usage is complete; an in-flight attempt's
          // can never be, so a cancellation is reported usageComplete=false
          // by the caller via the override below.
          toTokenUsage(progress.cumulativeUsage, true)
        : undefined,
    };
  };

  try {
    const result = await orchestratePolish(deps.provider, polishRequest, {
      signal: request.signal,
      providerUserId: deps.providerUserId(userId),
      onProviderAttemptStart: async () => {
        const mark = await deps.markProviderStarted(reservation.reservationId);
        if (!mark.started) {
          // The reservation was settled concurrently (reconciler): the ledger
          // considers this request dead, so serving it would be unaccounted.
          throw new PolishQuotaError(
            "INTERNAL_ERROR",
            "The polish reservation was already settled.",
          );
        }
        // NOTE: a successful mark is NOT provider-call evidence — the
        // orchestrator rechecks signal/deadline after this hook and flips
        // progress.providerCallEntered only when the call is really entered.
      },
      onProgress: (update) => {
        Object.assign(progress, update);
      },
    });

    const latencyMs = now() - startedAt;

    // 8a. Success settlement: charged, billable, all attempt tokens recorded.
    //    The finalize RPC returns the post-charge quota snapshot atomically
    //    (relay #8): settlement and the response quota can never disagree,
    //    and no read happens after irreversible settlement.
    let settledQuota: PolishQuotaStatus | undefined;
    try {
      const settled = await deps.finalize({
        reservationId: reservation.reservationId,
        status: "succeeded",
        quotaCharged: true,
        providerBillable: true,
        usage: toTokenUsage(result.usage, true),
        metadata: {
          ...baseMetadata,
          attemptCount: result.attempts,
          providerRequestId: result.providerRequestId,
          finishReason: "stop",
          latencyMs,
        },
      });
      settledQuota = settled.quota;
    } catch {
      // Settlement failed after a successful polish: the reconciler refunds
      // the user (stale provider_started → abandoned), so answering 500 is
      // honest and never double-charges. The output is deliberately NOT
      // returned — an unsettled request must not look successful.
      log({
        event: "polish.finalize_failed",
        requestId,
        userId,
        ...requestMeta,
        attempts: result.attempts,
        providerRequestId: result.providerRequestId,
        latencyMs,
      });
      return errorResponse(requestId, "INTERNAL_ERROR", "Failed to settle the polish request.");
    }

    // Response quota: the finalize snapshot is authoritative (post-charge).
    // Fallbacks, in order: a direct quota read (older/fake wirings without
    // the snapshot), then the reserve-time point-in-time snapshot (relay #8
    // minimum fallback) — a charged user must never lose a valid result to
    // an ancillary read failure.
    let quota: PolishQuota;
    if (settledQuota !== undefined) {
      quota = { ...settledQuota, resetAt: toIsoUtc(settledQuota.resetAt) };
    } else {
      let readQuota: PolishQuotaStatus | undefined;
      try {
        readQuota = await deps.getQuota(userId);
      } catch {
        log({
          event: "polish.quota_read_failed",
          requestId,
          userId,
          ...requestMeta,
          latencyMs: now() - startedAt,
        });
      }
      if (readQuota !== undefined) {
        quota = { ...readQuota, resetAt: toIsoUtc(readQuota.resetAt) };
      } else if (reservation.limit !== undefined) {
        quota = {
          limit: reservation.limit,
          remaining: reservation.remaining,
          resetAt: toIsoUtc(reservation.resetAt),
        };
      } else {
        log({
          event: "polish.request.failed",
          requestId,
          userId,
          code: "INTERNAL_ERROR",
          ...requestMeta,
          latencyMs: now() - startedAt,
        });
        return errorResponse(requestId, "INTERNAL_ERROR", "Failed to read the remaining quota.");
      }
    }

    log({
      event: "polish.request.completed",
      requestId,
      userId,
      ...requestMeta,
      attempts: result.attempts,
      providerRequestId: result.providerRequestId,
      inputCachedTokens: result.usage.cachedReadTokens,
      inputUncachedTokens: result.usage.uncachedReadTokens,
      outputTokens: result.usage.completionTokens,
      latencyMs,
    });

    const body200: PolishSuccessResponse = { requestId, items: result.items, quota };
    return Response.json(body200, { status: 200, headers: baseHeaders(requestId) });
  } catch (error) {
    const latencyMs = now() - startedAt;

    // 8b. Cancellation (client disconnect / user abort): the settlement table
    // charges the user once the provider was reached, releases otherwise.
    // "Reached" means a provider call was actually ENTERED
    // (progress.providerCallEntered) — a successful ledger mark alone does
    // not charge (relay #3.3). Known usage from completed attempts is always
    // recorded (#3.1).
    if (isAbortError(error)) {
      const entered = progress.providerCallEntered;
      const settled = progressSettlement();
      await finalizeQuiet({
        status: entered ? "canceled" : "released",
        quotaCharged: entered,
        providerBillable: settled.providerBillable,
        // An in-flight attempt's tokens are unknowable → not complete.
        usage: settled.usage ? { ...settled.usage, usageComplete: false } : undefined,
        metadata: { ...baseMetadata, failureStage: "canceled", latencyMs },
      });
      log({
        event: "polish.request.canceled",
        requestId,
        userId,
        ...requestMeta,
        inputCachedTokens: progress.cumulativeUsage.cachedReadTokens,
        inputUncachedTokens: progress.cumulativeUsage.uncachedReadTokens,
        outputTokens: progress.cumulativeUsage.completionTokens,
        latencyMs,
      });
      // The client is gone, so this response is moot; the contract has no
      // cancellation code, so a plain 500 is returned for completeness.
      return errorResponse(requestId, "INTERNAL_ERROR", "The polish request was canceled.");
    }

    // 8c. Attempt budget exhausted: refund the user quota; token costs are
    // still recorded (roadmap settlement table). invalid_output is always
    // billable (content WAS returned); failed_upstream is billable when any
    // attempt reported usage — a started upstream call that returned no
    // usage is billability UNKNOWN (null, relay #4), not provably free.
    if (error instanceof PolishOrchestrationError) {
      const status: PolishFinalizeStatus =
        error.code === "INVALID_MODEL_OUTPUT" ? "invalid_output" : "failed_upstream";
      const providerBillable =
        error.code === "INVALID_MODEL_OUTPUT"
          ? true
          : hasBillableUsage(error.usage)
            ? true
            : progress.providerCallEntered
              ? null
              : false;
      await finalizeQuiet({
        status,
        quotaCharged: false,
        providerBillable,
        usage: toTokenUsage(error.usage, error.failureStage !== "transport"),
        metadata: {
          ...baseMetadata,
          attemptCount: error.attempts,
          providerRequestId: error.providerRequestId,
          failureStage: toLedgerFailureStage(error.failureStage, error.code),
          latencyMs,
        },
      });
      log({
        event: "polish.request.failed",
        requestId,
        userId,
        code: error.code,
        failureStage: error.failureStage,
        ...requestMeta,
        attempts: error.attempts,
        providerRequestId: error.providerRequestId,
        upstreamStatus: error.upstreamStatus,
        inputCachedTokens: error.usage.cachedReadTokens,
        inputUncachedTokens: error.usage.uncachedReadTokens,
        outputTokens: error.usage.completionTokens,
        latencyMs,
      });
      const messages: Record<PolishOrchestrationError["code"], string> = {
        UPSTREAM_TIMEOUT: "The AI provider timed out; please try again.",
        UPSTREAM_ERROR: "The AI provider failed; please try again.",
        INVALID_MODEL_OUTPUT: "The AI returned unusable output; please try again.",
      };
      return errorResponse(requestId, error.code, messages[error.code]);
    }

    // 8d. Global-gate / kill-switch denial at provider start (relay #2): the
    // authoritative mark-time gate rejected an attempt (global daily cap
    // reached, or the runtime switch/allowlist flipped after reserve). The
    // provider was NOT called for this attempt: refund the user quota, keep
    // the earlier attempts' usage record, and report 503 — never a 500.
    if (
      error instanceof PolishQuotaError &&
      (error.code === "SERVICE_UNAVAILABLE" || error.code === "AI_DISABLED")
    ) {
      const settled = progressSettlement();
      await finalizeQuiet({
        status: progress.providerCallEntered ? "failed_upstream" : "released",
        quotaCharged: false,
        providerBillable: settled.providerBillable,
        usage: settled.usage,
        metadata: { ...baseMetadata, failureStage: "quota", latencyMs },
      });
      log({
        event: "polish.request.denied",
        requestId,
        userId,
        code: error.code,
        ...requestMeta,
        inputCachedTokens: progress.cumulativeUsage.cachedReadTokens,
        inputUncachedTokens: progress.cumulativeUsage.uncachedReadTokens,
        outputTokens: progress.cumulativeUsage.completionTokens,
        latencyMs,
      });
      return errorResponse(requestId, error.code, error.message, {
        retryAfterSeconds: POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS,
      });
    }

    // 8e. Infrastructure failure (mark/finalize RPCs and unknown errors):
    // refund the user, but NEVER pretend earlier provider contact did not
    // happen (#3.2): usage known from completed attempts is recorded and
    // stays billable, and providerBillable is null (unknown) when a call
    // was entered without usage coming back. Client messages are fixed
    // strings — raw RPC/PostgREST detail never crosses the API (#10).
    if (!(error instanceof PolishQuotaError)) {
      log({
        event: "polish.request.failed",
        requestId,
        userId,
        code: "INTERNAL_ERROR",
        ...requestMeta,
        latencyMs,
      });
    }
    const settled = progressSettlement();
    await finalizeQuiet({
      status: progress.providerCallEntered ? "failed_upstream" : "released",
      quotaCharged: false,
      providerBillable: settled.providerBillable,
      usage: settled.usage,
      metadata: { ...baseMetadata, failureStage: "quota", latencyMs },
    });
    return errorResponse(
      requestId,
      "INTERNAL_ERROR",
      error instanceof PolishQuotaError ? INTERNAL_QUOTA_SERVICE_MESSAGE : "Internal error while polishing.",
    );
  }
}

// ---------------------------------------------------------------------------
// GET /api/polish/quota — login only, never the ai_terms gate
// ---------------------------------------------------------------------------

async function handleQuotaGet(request: Request, deps: PolishRouteDeps): Promise<Response> {
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? (() => undefined);
  const requestId = deps.createRequestId?.() ?? randomUUID();
  const startedAt = now();

  const deny = (
    code: PolishErrorCode,
    message: string,
    options?: { retryAfterSeconds?: number; userId?: string },
  ): Response => {
    log({ event: "polish.quota.denied", requestId, userId: options?.userId, code, latencyMs: now() - startedAt });
    return errorResponse(requestId, code, message, options);
  };

  if (!deps.aiPolishEnabled) {
    return deny("AI_DISABLED", "AI polish is not available.", {
      retryAfterSeconds: POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS,
    });
  }

  // Login check only (roadmap: the quota read must not require ai_terms).
  const auth = await verifyBearerUser(request.headers.get("authorization"), deps);
  if (!auth.ok) {
    return deny(auth.error.code, auth.error.message);
  }

  try {
    const dbQuota = await deps.getQuota(auth.userId);
    const quota: PolishQuota = { ...dbQuota, resetAt: toIsoUtc(dbQuota.resetAt) };
    log({
      event: "polish.quota.served",
      requestId,
      userId: auth.userId,
      latencyMs: now() - startedAt,
    });
    const body: PolishQuotaResponse = { requestId, quota };
    return Response.json(body, { status: 200, headers: baseHeaders(requestId) });
  } catch {
    return deny("INTERNAL_ERROR", "Failed to read the remaining quota.", { userId: auth.userId });
  }
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export interface PolishRouteHandlers {
  POST(request: Request): Promise<Response>;
  GET(request: Request): Promise<Response>;
}

export function createPolishHandlers(deps: PolishRouteDeps): PolishRouteHandlers {
  return {
    POST: (request) => handlePolishPost(request, deps),
    GET: (request) => handleQuotaGet(request, deps),
  };
}
