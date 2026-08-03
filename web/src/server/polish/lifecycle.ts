/**
 * Request lifecycle of the polish API routes (unit 2.3) — the DI core.
 *
 *   POST /api/polish:
 *     deployment switch → auth (Bearer) → ai_terms gate → bounded reader →
 *     JSON parse → polishRequestSchema → reserve (atomic: runtime switch,
 *     dedup 409×2, global/user quota, rate limit) → mark_provider_started
 *     (per attempt, via the orchestrator hook) → orchestrator → finalize
 *     (settlement table) → response
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
  type PolishOrchestrationFailureStage,
  type PolishProvider,
  type PolishProviderUsage,
} from "./orchestrator";
import { requirePolishUser, verifyBearerUser } from "./auth";
import {
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
      return deny(error.code, error.message, {
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
  let providerStarted = false;
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
        providerStarted = true;
      },
    });

    const latencyMs = now() - startedAt;

    // 8a. Success settlement: charged, billable, all attempt tokens recorded.
    try {
      await deps.finalize({
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

    // Response quota is authoritative (post-charge), read after finalize.
    let quota: PolishQuota;
    try {
      const dbQuota = await deps.getQuota(userId);
      quota = { ...dbQuota, resetAt: toIsoUtc(dbQuota.resetAt) };
    } catch {
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
    if (isAbortError(error)) {
      await finalizeQuiet({
        status: providerStarted ? "canceled" : "released",
        quotaCharged: providerStarted,
        providerBillable: providerStarted ? true : false,
        metadata: { ...baseMetadata, failureStage: "canceled", latencyMs },
      });
      log({
        event: "polish.request.canceled",
        requestId,
        userId,
        ...requestMeta,
        latencyMs,
      });
      // The client is gone, so this response is moot; the contract has no
      // cancellation code, so a plain 500 is returned for completeness.
      return errorResponse(requestId, "INTERNAL_ERROR", "The polish request was canceled.");
    }

    // 8c. Attempt budget exhausted: refund the user quota; token costs are
    // still recorded (roadmap settlement table). invalid_output is always
    // billable (content WAS returned); failed_upstream is billable when any
    // attempt reported usage.
    if (error instanceof PolishOrchestrationError) {
      const status: PolishFinalizeStatus =
        error.code === "INVALID_MODEL_OUTPUT" ? "invalid_output" : "failed_upstream";
      const providerBillable =
        error.code === "INVALID_MODEL_OUTPUT" ? true : hasBillableUsage(error.usage);
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

    // 8d. Infrastructure failure (mark/finalize RPCs and unknown errors):
    // release the reservation (provider attempt accounting unknown at this
    // point → user refunded, failure recorded as quota-stage).
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
    await finalizeQuiet({
      status: "released",
      quotaCharged: false,
      providerBillable: false,
      metadata: { ...baseMetadata, failureStage: "quota", latencyMs },
    });
    return errorResponse(
      requestId,
      "INTERNAL_ERROR",
      error instanceof PolishQuotaError ? error.message : "Internal error while polishing.",
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
