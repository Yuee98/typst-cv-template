import { randomUUID } from "node:crypto";
import { polishRequestSchema, type PolishErrorCode, type PolishQuota, type PolishSuccessResponse } from "@/lib/polish/contract";
import {
  orchestratePolish,
  PolishOrchestrationError,
  POLISH_PROMPT_VERSION,
  POLISH_VALIDATOR_VERSION,
  zeroPolishUsage,
  type PolishOrchestrationProgress,
} from "./orchestrator";
import { requirePolishUser } from "./auth";
import {
  INTERNAL_QUOTA_SERVICE_MESSAGE,
  PolishQuotaError,
  type PolishLedgerMetadata,
  type PolishQuotaStatus,
  type PolishFinalizeStatus,
  type PolishReservation,
} from "./quota";
import { baseHeaders, errorResponse, POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS, readBoundedBody, secondsUntil, toIsoUtc } from "./lifecycle-http";
import { hasBillableUsage, isAbortError, progressSettlement, progressUsageComplete, toLedgerFailureStage, toTokenUsage } from "./lifecycle-settlement";
import type { PolishFinalizeCall, PolishRouteDeps } from "./lifecycle-types";

// ---------------------------------------------------------------------------
// POST /api/polish
// ---------------------------------------------------------------------------

export async function handlePolishPost(request: Request, deps: PolishRouteDeps): Promise<Response> {
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
  //    Terminal progress (relay #3, round-2 #1/#5): the orchestrator
  //    publishes a snapshot when a provider call is ENTERED, after EVERY
  //    provider result, and after every transport failure, so every exit
  //    path below — success, budget exhaustion, cancellation, attempt-start
  //    hook failure, global-gate denial — settles with the known cumulative
  //    usage, the REAL usageComplete accounting state (never re-derived from
  //    the last failure stage), the entered-attempt count and the last
  //    provider request id (a successful ledger mark alone is NOT proof of
  //    an upstream call).
  const progress: PolishOrchestrationProgress = {
    enteredAttempts: 0,
    usageReturnedAttempts: 0,
    cumulativeUsage: zeroPolishUsage(),
    usageComplete: true,
    lastProviderRequestId: undefined,
    providerCallInFlight: false,
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

  const progressUsageCompleteForRequest = () => progressUsageComplete(progress);
  const progressSettlementForRequest = () => progressSettlement(progress);

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
        // progress.providerCallInFlight only when the call is really entered.
      },
      onProgress: (update) => {
        Object.assign(progress, update);
      },
    });

    const latencyMs = now() - startedAt;

    // 8a. Success settlement: charged, billable, all attempt tokens recorded.
    //    usageComplete is the REAL accounting state from the progress
    //    snapshot (round-2 #1): a retry that succeeded after a usage-less
    //    transport failure still settles with usageComplete=false.
    //    The finalize RPC returns the post-charge quota snapshot atomically
    //    (relay #8): settlement and the response quota can never disagree,
    //    and no read happens after irreversible settlement.
    const successFinalize: Omit<PolishFinalizeCall, "reservationId"> = {
      status: "succeeded",
      quotaCharged: true,
      providerBillable: true,
      usage: toTokenUsage(result.usage, progressUsageCompleteForRequest()),
      metadata: {
        ...baseMetadata,
        attemptCount: result.attempts,
        providerRequestId: result.providerRequestId,
        finishReason: "stop",
        latencyMs,
      },
    };
    let settledQuota: PolishQuotaStatus | undefined;
    try {
      const settled = await deps.finalize({
        reservationId: reservation.reservationId,
        ...successFinalize,
      });
      settledQuota = settled.quota;
    } catch {
      // The finalize may have COMMITTED while its response was lost (round-2
      // #3): retry the idempotent RPC once before concluding anything.
      const retried = await deps
        .finalize({ reservationId: reservation.reservationId, ...successFinalize })
        .catch(() => undefined);
      if (retried === undefined) {
        // Both calls failed: the settlement state is UNKNOWN. Return the
        // verified output anyway — the user gets what they paid for, the
        // response quota falls back to the reserve-time snapshot below, and
        // the reconciler settles/refunds the stale ledger row later
        // (verdict option b). Logged loudly; never silent.
        log({
          event: "polish.finalize_failed",
          requestId,
          userId,
          ...requestMeta,
          attempts: result.attempts,
          providerRequestId: result.providerRequestId,
          latencyMs,
        });
      } else if (
        !retried.alreadyFinalized ||
        (retried.status === "succeeded" && retried.quotaCharged === true)
      ) {
        // The retry itself committed the charge (first call never landed),
        // or it confirmed the first call's commit: succeeded + charged.
        settledQuota = retried.quota;
      } else {
        // The reservation was ALREADY settled in a conflicting state (not
        // succeeded / not charged — e.g. the reconciler released it): the
        // user was not charged for this output, so it must not be served.
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
    }

    // Response quota: the finalize snapshot is authoritative (post-charge).
    // Fallbacks, in order: a direct quota read (older/fake wirings without
    // the snapshot, or an uncertain settlement where both finalize calls
    // failed — round-2 #3 option b), then the reserve-time point-in-time
    // snapshot (relay #8 minimum fallback) — a charged user must never lose
    // a valid result to an ancillary read failure.
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
    // (progress.enteredAttempts > 0) — a successful ledger mark alone does
    // not charge (relay #3.3). Known usage from completed attempts is always
    // recorded (#3.1); its completeness is the REAL accounting state from
    // the progress snapshot (round-2 #1): incomplete while a call is in
    // flight or after any usage-less transport failure, complete otherwise.
    if (isAbortError(error)) {
      const entered = progress.enteredAttempts > 0;
      const settled = progressSettlementForRequest();
      await finalizeQuiet({
        status: entered ? "canceled" : "released",
        quotaCharged: entered,
        providerBillable: settled.providerBillable,
        usage: settled.usage,
        metadata: {
          ...baseMetadata,
          attemptCount: progress.enteredAttempts,
          providerRequestId: progress.lastProviderRequestId,
          failureStage: "canceled",
          latencyMs,
        },
      });
      log({
        event: "polish.request.canceled",
        requestId,
        userId,
        ...requestMeta,
        attempts: progress.enteredAttempts,
        providerRequestId: progress.lastProviderRequestId,
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
    // usageComplete comes from the progress snapshot (round-2 #1), never
    // from the last failure stage: attempt-1 transport without usage +
    // attempt-2 invalid WITH usage settles usageComplete=false.
    if (error instanceof PolishOrchestrationError) {
      const status: PolishFinalizeStatus =
        error.code === "INVALID_MODEL_OUTPUT" ? "invalid_output" : "failed_upstream";
      const providerBillable =
        error.code === "INVALID_MODEL_OUTPUT"
          ? true
          : hasBillableUsage(error.usage)
            ? true
            : progress.enteredAttempts > 0
              ? null
              : false;
      await finalizeQuiet({
        status,
        quotaCharged: false,
        providerBillable,
        usage: toTokenUsage(error.usage, progressUsageCompleteForRequest()),
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
      const settled = progressSettlementForRequest();
      await finalizeQuiet({
        status: progress.enteredAttempts > 0 ? "failed_upstream" : "released",
        quotaCharged: false,
        providerBillable: settled.providerBillable,
        usage: settled.usage,
        metadata: {
          ...baseMetadata,
          attemptCount: progress.enteredAttempts,
          providerRequestId: progress.lastProviderRequestId,
          failureStage: "quota",
          latencyMs,
        },
      });
      log({
        event: "polish.request.denied",
        requestId,
        userId,
        code: error.code,
        ...requestMeta,
        attempts: progress.enteredAttempts,
        providerRequestId: progress.lastProviderRequestId,
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
        attempts: progress.enteredAttempts,
        providerRequestId: progress.lastProviderRequestId,
        latencyMs,
      });
    }
    const settled = progressSettlementForRequest();
    await finalizeQuiet({
      status: progress.enteredAttempts > 0 ? "failed_upstream" : "released",
      quotaCharged: false,
      providerBillable: settled.providerBillable,
      usage: settled.usage,
      metadata: {
        ...baseMetadata,
        attemptCount: progress.enteredAttempts,
        providerRequestId: progress.lastProviderRequestId,
        failureStage: "quota",
        latencyMs,
      },
    });
    return errorResponse(
      requestId,
      "INTERNAL_ERROR",
      error instanceof PolishQuotaError ? INTERNAL_QUOTA_SERVICE_MESSAGE : "Internal error while polishing.",
    );
  }
}

