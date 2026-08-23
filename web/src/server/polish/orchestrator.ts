/**
 * Polish orchestrator (unit 2.2): prompt assembly + output validation +
 * retry policy, on top of a single-transport provider injected by the
 * handler (roadmap「职责边界」: provider = one HTTP call; orchestrator =
 * prompt + validation + total deadline + at most 2 attempts + usage
 * accumulation; handler = request lifecycle).
 *
 * Policy (roadmap「输出与验证流水线」):
 * - total deadline 45s; each attempt gets the remaining budget as its
 *   timeout; a retry is only started if at least MIN_RETRY_BUDGET_MS remains
 * - at most 2 attempts; retryable transport failures and validation failures
 *   share the same attempt budget; terminal provider 4xx failures stop after
 *   one attempt, while a bounded 429 Retry-After consumes the same deadline
 * - attempt 2 carries the previous failure reason in the retry prompt
 * - usage is accumulated across attempts and returned/surfaced on BOTH
 *   success and failure (roadmap Invariant 7: all retry tokens count);
 *   additionally it is PUBLISHED via onProgress after every provider
 *   result, so cancellation and attempt-start hook failures still settle
 *   with the known cumulative usage (relay #3)
 * - the ledger mark is not proof of an upstream call: after
 *   onProviderAttemptStart the loop rechecks signal.aborted and recomputes
 *   the remaining deadline — the provider is never entered with an
 *   aborted signal or a zero budget (relay #3.3/#3.4)
 * - AbortSignal cancellation propagates upward as-is: it is not counted as
 *   a failed attempt and never triggers a retry
 * - maxOutputTokens is dynamic, computed by the contract's single-source
 *   helper computePolishMaxOutputTokens (roadmap「总输出预算」). CP1 round3:
 *   the helper assumes ALREADY-VALIDATED request items — this module only
 *   accepts a PolishRequest that passed polishRequestSchema in the handler,
 *   and the helper is never called with anything else.
 * - finishReason "length" is an ordinary invalid-output/retry condition
 *   (the token budget is a conservative estimate, CP1 round3), handled by
 *   the validator like any other non-"stop" finish reason — never an
 *   impossible state.
 */

import {
  computePolishMaxOutputTokens,
  type PolishRequest,
} from "@/lib/polish/contract";
import {
  buildPolishMessages,
  buildPolishPromptBlocks,
  POLISH_PROMPT_VERSION,
  type PolishPromptInput,
} from "./prompt";
import {
  assertNormalizedUsageV2,
  observedUsage,
  unavailableUsage,
  type AttemptUsageObservationV1,
  type NormalizedFinishReason,
  type NormalizedUsageV2,
  type PolishInferenceRequestV2,
  type PolishInferenceResultV2,
} from "./inference-v2";
import {
  calculateEstimatedCost,
  type CostCalculationIncompleteReason,
  type FrozenPriceSnapshotV1,
  type MoneyNanosV1,
} from "./pricing";
import {
  PolishProviderError,
  type PolishProvider,
  type PolishProviderRequest,
  type PolishProviderResult,
  type PolishProviderUsage,
} from "./provider";
import { classifyProviderRetry } from "./provider-error";
import {
  POLISH_VALIDATOR_VERSION,
  validatePolishOutput,
  type PolishValidationFailureStage,
} from "./validate";

export { POLISH_PROMPT_VERSION, POLISH_VALIDATOR_VERSION };
export type {
  PolishProvider,
  PolishProviderRequest,
  PolishProviderResult,
  PolishProviderUsage,
};

// ---------------------------------------------------------------------------
// Budget constants
// ---------------------------------------------------------------------------

/** Total deadline for the whole polish operation (roadmap: 45s). */
export const POLISH_TOTAL_DEADLINE_MS = 45_000;
/** Retry at most once (roadmap: 失败重试 1 次). */
export const POLISH_MAX_ATTEMPTS = 2;
/** Below this remaining budget a retry is pointless for an LLM round-trip. */
export const MIN_RETRY_BUDGET_MS = 5_000;

// ---------------------------------------------------------------------------
// Usage accumulation
// ---------------------------------------------------------------------------

export function zeroPolishUsage(): PolishProviderUsage {
  return { promptTokens: 0, completionTokens: 0, cachedReadTokens: 0, uncachedReadTokens: 0 };
}

export function addPolishUsage(a: PolishProviderUsage, b: PolishProviderUsage): PolishProviderUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cachedReadTokens: a.cachedReadTokens + b.cachedReadTokens,
    uncachedReadTokens: a.uncachedReadTokens + b.uncachedReadTokens,
  };
}

// ---------------------------------------------------------------------------
// Failure surface (consumed by the handler in unit 2.3)
// ---------------------------------------------------------------------------

export type PolishOrchestrationErrorCode =
  | "UPSTREAM_ERROR"
  | "UPSTREAM_TIMEOUT"
  | "INVALID_MODEL_OUTPUT";

export type PolishOrchestrationFailureStage = "transport" | PolishValidationFailureStage;

/**
 * Thrown when the attempt budget is exhausted. Carries everything the
 * handler needs for finalize + response mapping: the API error code, the
 * failure stage (ledger failure_stage), accumulated usage across attempts
 * (token cost is recorded even on failure), and the attempt count. The
 * message is a server-side diagnostic; the client gets a generic message.
 */
export class PolishOrchestrationError extends Error {
  readonly code: PolishOrchestrationErrorCode;
  readonly failureStage: PolishOrchestrationFailureStage;
  readonly usage: PolishProviderUsage;
  readonly attempts: number;
  /** Provider-side correlation id of the last attempt, when known (safe structured log metadata). */
  readonly providerRequestId?: string;
  /** Upstream HTTP status of the last attempt, when the failure came with one. */
  readonly upstreamStatus?: number;

  constructor(
    code: PolishOrchestrationErrorCode,
    failureStage: PolishOrchestrationFailureStage,
    usage: PolishProviderUsage,
    attempts: number,
    message: string,
    options?: { providerRequestId?: string; upstreamStatus?: number },
  ) {
    super(message);
    this.name = "PolishOrchestrationError";
    this.code = code;
    this.failureStage = failureStage;
    this.usage = usage;
    this.attempts = attempts;
    this.providerRequestId = options?.providerRequestId;
    this.upstreamStatus = options?.upstreamStatus;
  }
}

export interface PolishOrchestratorSuccess {
  items: { id: string; polished: string }[];
  /** Summed usage across all attempts made. */
  usage: PolishProviderUsage;
  attempts: number;
  /** Provider-side correlation id of the successful attempt, when the upstream returned one. */
  providerRequestId?: string;
}

/**
 * Terminal progress snapshot (relay #3, round-2 usage accounting): published
 * via onProgress so the handler's settlement survives EVERY exit path —
 * success, budget exhaustion, cancellation, and attempt-start hook failures.
 * This is the usage-accounting source of truth for settlement:
 *
 * - `cumulativeUsage` sums every provider result received so far (roadmap
 *   invariant 7: retry tokens are recorded even when the request later
 *   fails or is canceled);
 * - `enteredAttempts` distinguishes "a provider call was actually entered"
 *   from "only the ledger mark succeeded" — the roadmap charges
 *   cancellations only after the upstream request was sent;
 * - `usageComplete` is the REAL accounting state across attempts: it goes
 *   permanently false when an entered provider call fails without returning
 *   usage (transport failure — the provider may still have generated tokens
 *   we cannot account for). Settlement must never re-derive it from the
 *   last failure stage; a retry that later succeeds does NOT restore it.
 */
export interface PolishOrchestrationProgress {
  /** Attempts that entered `provider.complete` (whether they returned or not). */
  enteredAttempts: number;
  /** Attempts whose provider call returned with token usage. */
  usageReturnedAttempts: number;
  cumulativeUsage: PolishProviderUsage;
  /**
   * False permanently once an entered provider call fails without usage;
   * also effectively incomplete while a call is in flight or an entered
   * call has not returned usage yet (enteredAttempts > usageReturnedAttempts).
   */
  usageComplete: boolean;
  lastProviderRequestId?: string;
  /** True while a provider call is in flight (set before awaiting it). */
  providerCallInFlight: boolean;
}

export interface PolishOrchestrateOptions {
  /** Caller cancellation (client disconnect / user abort). Propagated, never retried. */
  signal: AbortSignal;
  /**
   * Pseudonymous provider user identifier, computed by the handler
   * (HMAC_SHA256(AI_USER_ID_HMAC_SECRET, userId), hex) and forwarded to the
   * provider unchanged. The raw supabase user id never enters this module.
   */
  providerUserId: string;
  /**
   * Called before every provider attempt (1-based). The handler uses it for
   * the ledger's mark_provider_started transition (global cost accounting
   * counts EVERY attempt — roadmap invariant 7). Errors thrown here
   * propagate unchanged: they are infrastructure failures, never classified
   * as transport failures and never retried by this loop.
   */
  onProviderAttemptStart?: (attempt: number) => Promise<void>;
  /**
   * Synchronous progress sink (relay #3): fired when a provider call is
   * ENTERED (providerCallInFlight flips true), after EVERY provider result
   * (cumulative usage published), and after every transport failure (the
   * usageComplete flag and the transport error's providerRequestId reach the
   * handler even when no result came back). The handler keeps the latest
   * snapshot and settles from it on cancellation / hook failures.
   */
  onProgress?: (progress: PolishOrchestrationProgress) => void;
  /** Time source, injectable for deterministic deadline tests. Defaults to Date.now. */
  now?: () => number;
  /** Abort-aware retry delay, injectable for deterministic Retry-After tests. */
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

function sleepWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Transport failures are classified as "the provider threw" (its errors are
 * normalized PolishProviderError with code UPSTREAM_ERROR/UPSTREAM_TIMEOUT).
 * The code and structured correlation metadata are read STRUCTURALLY so test
 * doubles (plain Errors with attached fields) classify the same way.
 */
function classifyTransportError(error: unknown): {
  code: "UPSTREAM_ERROR" | "UPSTREAM_TIMEOUT";
  reason: string;
  providerRequestId?: string;
  upstreamStatus?: number;
  retryable: boolean;
  retryAfterMs: number;
} {
  const fields = error instanceof Error
    ? (error as Partial<PolishProviderError> & {
        retryable?: unknown;
        retryAfterMs?: unknown;
      })
    : {};
  const code = fields.code === "UPSTREAM_TIMEOUT" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR";
  const upstreamStatus =
    typeof fields.upstreamStatus === "number" ? fields.upstreamStatus : undefined;
  const retry = classifyProviderRetry({
    code,
    upstreamStatus,
    retryable: fields.retryable,
    retryAfterMs: fields.retryAfterMs,
  });
  // Never copy provider error text/body into logs, retry prompts or the
  // terminal orchestration error. Only bounded structured metadata survives.
  const reason = `transport failure (${code}${upstreamStatus === undefined ? "" : `, HTTP ${upstreamStatus}`})`;
  return {
    code,
    reason,
    providerRequestId:
      typeof fields.providerRequestId === "string" ? fields.providerRequestId : undefined,
    upstreamStatus,
    retryable: retry.retryable,
    retryAfterMs: retry.retryAfterMs,
  };
}

/**
 * Run the polish operation for an already contract-validated request.
 * Resolves with the validated items + accumulated usage; rejects with
 * PolishOrchestrationError on budget exhaustion, or rethrows the abort error
 * unchanged on cancellation.
 *
 * CP1 round3: the request MUST already have passed polishRequestSchema —
 * computePolishMaxOutputTokens assumes schema-valid items and is never
 * called with anything else.
 */
export async function orchestratePolish(
  provider: PolishProvider,
  request: PolishRequest,
  options: PolishOrchestrateOptions,
): Promise<PolishOrchestratorSuccess> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepWithAbort;
  const deadline = now() + POLISH_TOTAL_DEADLINE_MS;

  // Dynamic output budget from the contract's single-source helper (per-item
  // ceilings incl. slack → aggregate clamp → envelope → absolute token cap).
  const maxOutputTokens = computePolishMaxOutputTokens(request.items);
  // Fake-echo / validation metadata pinned by the provider interface; the
  // real provider must not forward it upstream (the texts are in messages).
  const targets = request.items.map((item) => ({ id: item.id, text: item.text }));

  // Narrow prompt input picked field-by-field: clientRequestId is a dedup
  // key and is never sent to the provider.
  const promptInput: PolishPromptInput = {
    language: request.language,
    sectionId: request.sectionId,
    granularity: request.granularity,
    items: request.items,
    contextLevel: request.context.level,
    references: request.context.references,
    stylePreset: request.stylePreset,
    styleInstruction: request.styleInstruction,
  };

  let usage = zeroPolishUsage();
  let attempts = 0;
  let enteredAttempts = 0;
  let usageReturnedAttempts = 0;
  let usageComplete = true;
  let providerCallInFlight = false;
  let lastProviderRequestId: string | undefined;
  let lastFailure: {
    code: PolishOrchestrationErrorCode;
    stage: PolishOrchestrationFailureStage;
    reason: string;
    providerRequestId?: string;
    upstreamStatus?: number;
  } | null = null;

  /** Publish the terminal progress snapshot (relay #3) — sync, never throws. */
  const publishProgress = (): void => {
    options.onProgress?.({
      enteredAttempts,
      usageReturnedAttempts,
      cumulativeUsage: usage,
      usageComplete,
      lastProviderRequestId,
      providerCallInFlight,
    });
  };

  while (attempts < POLISH_MAX_ATTEMPTS) {
    if (options.signal.aborted) {
      throw new DOMException("The polish request was aborted.", "AbortError");
    }
    const remainingMs = deadline - now();
    if (attempts > 0 && remainingMs < MIN_RETRY_BUDGET_MS) break;
    if (remainingMs <= 0) break;

    attempts += 1;
    const messages = buildPolishMessages({
      ...promptInput,
      retryFeedback: attempts > 1 ? lastFailure?.reason : undefined,
    });

    // Ledger hook (mark_provider_started) runs outside the try below: its
    // failures are infrastructure errors and must propagate unchanged, never
    // degrade into a retried "transport failure".
    await options.onProviderAttemptStart?.(attempts);

    // Post-mark rechecks (relay #3.3/#3.4, round-2 #4): the mark RPC takes
    // real time, so the caller may have aborted DURING it and the deadline
    // may have moved. A successful ledger mark is NOT evidence that an
    // upstream call was sent — never enter the provider with an
    // already-aborted signal, and never call it with no budget left.
    if (options.signal.aborted) {
      throw new DOMException("The polish request was aborted.", "AbortError");
    }
    const postMarkRemainingMs = deadline - now();
    // A retry (attempt 2) also needs the full MIN_RETRY_BUDGET_MS to be
    // worth starting: the mark itself consumes budget, so the pre-mark
    // check at the top of the loop is not sufficient on its own (#4).
    if (postMarkRemainingMs <= 0 || (attempts > 1 && postMarkRemainingMs < MIN_RETRY_BUDGET_MS)) {
      // The mark RPC consumed the rest of the deadline: the provider must
      // not be called with no budget (#3.4). Keep any earlier failure as
      // the reported cause; a first-attempt exhaustion reads as a timeout.
      lastFailure ??= {
        code: "UPSTREAM_TIMEOUT",
        stage: "transport",
        reason: "total deadline exhausted before the provider call could start",
      };
      break;
    }

    let result: PolishProviderResult;
    try {
      enteredAttempts += 1;
      providerCallInFlight = true;
      publishProgress();
      result = await provider.complete(
        {
          messages,
          maxOutputTokens,
          providerUserId: options.providerUserId,
          targets,
        },
        { signal: options.signal, timeoutMs: postMarkRemainingMs },
      );
    } catch (error) {
      if (options.signal.aborted) {
        // Cancellation: propagate as-is, not a failed attempt, never retried.
        // providerCallInFlight deliberately stays true: the upstream call may
        // still be running, so its usage is unknowable to settlement.
        throw error;
      }
      const transport = classifyTransportError(error);
      // An entered call that failed WITHOUT returning usage permanently
      // poisons the accounting state (round-2 #1): the provider may have
      // generated tokens we cannot see, so settlement must report
      // usageComplete=false from now on — even if a later attempt succeeds.
      providerCallInFlight = false;
      usageComplete = false;
      // The transport error's correlation id is progress metadata too (#5):
      // cancellation/infra settlements after a transport-only run still name
      // the last upstream request.
      lastProviderRequestId = transport.providerRequestId ?? lastProviderRequestId;
      publishProgress();
      lastFailure = {
        code: transport.code,
        stage: "transport",
        reason: transport.reason,
        providerRequestId: transport.providerRequestId,
        upstreamStatus: transport.upstreamStatus,
      };
      if (!transport.retryable) break;
      if (transport.retryAfterMs > 0) {
        // Do not sleep into a guaranteed-dead retry. The same total deadline
        // and minimum useful budget apply to provider-directed backoff.
        if (deadline - now() - transport.retryAfterMs < MIN_RETRY_BUDGET_MS) break;
        await sleep(transport.retryAfterMs, options.signal);
      }
      continue;
    }

    providerCallInFlight = false;
    usageReturnedAttempts += 1;
    usage = addPolishUsage(usage, result.usage);
    lastProviderRequestId = result.providerRequestId ?? lastProviderRequestId;
    // Cumulative usage is published after EVERY provider result, so a later
    // cancellation or attempt-start failure still settles with it (#3.1/#3.2).
    publishProgress();

    const validation = validatePolishOutput(result, {
      items: request.items,
      language: request.language,
    });
    if (validation.ok) {
      return {
        items: validation.items,
        usage,
        attempts,
        providerRequestId: result.providerRequestId,
      };
    }
    lastFailure = {
      // insufficient_system_resource is classified "upstream" by the
      // validator (roadmap: treated as an upstream fault, quota refundable).
      code: validation.classification === "upstream" ? "UPSTREAM_ERROR" : "INVALID_MODEL_OUTPUT",
      stage: validation.stage,
      reason: validation.reason,
      providerRequestId: result.providerRequestId,
    };
  }

  throw new PolishOrchestrationError(
    lastFailure?.code ?? "UPSTREAM_ERROR",
    lastFailure?.stage ?? "transport",
    usage,
    attempts,
    `polish failed after ${attempts} attempt(s): ${lastFailure?.reason ?? "no attempt could be started within the deadline"}`,
    {
      providerRequestId: lastFailure?.providerRequestId,
      upstreamStatus: lastFailure?.upstreamStatus,
    },
  );
}

// ---------------------------------------------------------------------------
// Additive V2 attempt orchestration
// ---------------------------------------------------------------------------

/**
 * The V2 path deliberately lives beside the pinned V1 API above.  Callers can
 * therefore stage the attempt ledger without changing the current production
 * handler, while adapters still retain the one-transmission responsibility.
 */

export const POLISH_OUTPUT_CONTRACT_V2: Readonly<
  PolishInferenceRequestV2["outputContract"]
> = Object.freeze({
  kind: "json_object",
  schemaName: "polish_items_v1",
  schema: Object.freeze({}),
});

export interface PolishInferenceFailureV2 {
  code: "UPSTREAM_ERROR" | "UPSTREAM_TIMEOUT";
  upstreamStatus?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  providerRequestId?: string;
}

/**
 * Orchestrator-owned outcome seam.  Ordinary production adapters only need
 * `complete`; deterministic/conformance adapters may expose `completeAttempt`
 * to return an explicit missing-usage observation without throwing it away.
 */
export type PolishInferenceAttemptOutcomeV2 =
  | {
      kind: "completed";
      result: PolishInferenceResultV2;
      usageObservation: Extract<AttemptUsageObservationV1, { kind: "observed" }>;
    }
  | {
      kind: "failed";
      failure: PolishInferenceFailureV2;
      route: PolishInferenceResultV2["route"];
      providerBillable: boolean | null;
      result: null;
      usageObservation: AttemptUsageObservationV1;
      providerReportedCost?: MoneyNanosV1;
    };

export interface PolishInferenceProviderV2 {
  complete(
    request: PolishInferenceRequestV2,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<PolishInferenceResultV2>;
  completeAttempt?(
    request: PolishInferenceRequestV2,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<PolishInferenceAttemptOutcomeV2>;
}

export type PolishAttemptStatusV2 =
  | "succeeded"
  | "invalid_output"
  | "failed_upstream"
  | "timed_out"
  | "canceled";

export interface PolishRouteObservationV1 {
  readonly schemaVersion: "route_observation_v1";
  readonly gatewayRequestId: string | null;
  readonly providerRequestId: string | null;
  readonly actualUpstreamEndpoint: string | null;
  readonly actualModelId: string | null;
  readonly routerAttemptCount: number | null;
}

export type PolishAttemptUsageObservationV2 =
  | {
      readonly kind: "observed";
      readonly usage: Readonly<NormalizedUsageV2>;
    }
  | {
      readonly kind: "unavailable";
      readonly usage: null;
      readonly usageComplete: false;
    };

export interface PolishAttemptCostObservationV2 {
  readonly schemaVersion: "cost_observation_v1";
  readonly estimatedCost: Readonly<MoneyNanosV1> | null;
  readonly estimationStatus: "complete" | "incomplete_usage";
  readonly incompleteReasons: readonly CostCalculationIncompleteReason[];
  readonly providerReportedCost: Readonly<MoneyNanosV1> | null;
}

export interface PolishAttemptErrorObservationV2 {
  readonly code: PolishOrchestrationErrorCode;
  readonly upstreamStatus: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number;
}

export interface PolishAttemptStartedFactV2 {
  readonly schemaVersion: "polish_attempt_started_v2";
  readonly attemptNo: number;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
}

export interface PolishAttemptCompletedFactV2 {
  readonly schemaVersion: "polish_attempt_completed_v2";
  readonly started: PolishAttemptStartedFactV2;
  readonly status: PolishAttemptStatusV2;
  /** Admission/start is not transmission evidence; this flips only at adapter entry. */
  readonly transmitted: boolean;
  readonly providerBillable: boolean | null;
  readonly usageObservation: PolishAttemptUsageObservationV2;
  readonly route: PolishRouteObservationV1;
  readonly cost: PolishAttemptCostObservationV2;
  readonly finishReason: NormalizedFinishReason | null;
  readonly failureStage: PolishOrchestrationFailureStage | "provider_contract" | null;
  readonly error: PolishAttemptErrorObservationV2 | null;
  readonly transportStartedAtMs: number | null;
  readonly completedAtMs: number;
  readonly latencyMs: number;
}

export interface PolishAttemptCompletedEventV2<TStartResult> {
  readonly started: PolishAttemptStartedFactV2;
  /**
   * Opaque caller receipt (normally an attempt id) returned by the successful
   * admission hook.  It is carried by identity even when transport throws or
   * is canceled, so the caller can complete the same admitted attempt.
   */
  readonly startResult: TStartResult | undefined;
  readonly completed: PolishAttemptCompletedFactV2;
}

export interface RequestUsageAggregateV2 {
  readonly schemaVersion: "request_usage_aggregate_v2";
  readonly knownUsage: {
    readonly inputTotalTokens: string;
    readonly inputCacheReadTokens: string;
    readonly inputStandardTokens: string;
    readonly outputTokens: string;
  };
  readonly inputCacheWriteTokens: string | null;
  readonly reasoningTokens: string | null;
  readonly incompleteFields: readonly (
    | "attempt_usage"
    | "input_cache_write"
    | "reasoning"
    | "provider_billable"
    | "estimated_cost"
  )[];
  readonly usageComplete: boolean;
  readonly providerBillable: boolean | null;
  readonly knownEstimatedCost: Readonly<MoneyNanosV1> | null;
  readonly estimatedCost: Readonly<MoneyNanosV1> | null;
}

export interface PolishOrchestrateV2Options<TStartResult = unknown> {
  signal: AbortSignal;
  /** HMAC-derived subject; raw application user ids must not enter this API. */
  providerSubjectId: string;
  /** Reservation-frozen, exact price version used for every admitted attempt. */
  frozenPrice: FrozenPriceSnapshotV1;
  /** Defaults to the legacy-compatible JSON object contract. */
  outputContract?: PolishInferenceRequestV2["outputContract"];
  /** Admission hook. A successful return still does not prove transmission. */
  onAttemptStarted?: (
    fact: PolishAttemptStartedFactV2,
  ) => TStartResult | Promise<TStartResult>;
  /** Receives the immutable terminal fact and the exact admission receipt. */
  onAttemptCompleted?: (
    event: PolishAttemptCompletedEventV2<TStartResult>,
  ) => void | Promise<void>;
  now?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface PolishOrchestratorSuccessV2 {
  readonly items: readonly { id: string; polished: string }[];
  readonly attemptFacts: readonly PolishAttemptCompletedFactV2[];
  readonly aggregate: RequestUsageAggregateV2;
  readonly winningRoute: PolishRouteObservationV1;
}

export class PolishUsageAggregationError extends Error {
  readonly code: "MIXED_CURRENCY" | "COST_AGGREGATE_OVERFLOW" | "INVALID_COST";
  readonly retryable = false;
  readonly attemptFacts: readonly PolishAttemptCompletedFactV2[];

  constructor(
    code: "MIXED_CURRENCY" | "COST_AGGREGATE_OVERFLOW" | "INVALID_COST",
    message: string,
    attemptFacts: readonly PolishAttemptCompletedFactV2[] = [],
  ) {
    super(message);
    this.name = "PolishUsageAggregationError";
    this.code = code;
    this.attemptFacts = Object.freeze([...attemptFacts]);
  }
}

export class PolishOrchestrationErrorV2 extends Error {
  readonly code: PolishOrchestrationErrorCode;
  readonly failureStage: PolishAttemptCompletedFactV2["failureStage"];
  readonly attemptFacts: readonly PolishAttemptCompletedFactV2[];
  readonly aggregate: RequestUsageAggregateV2;

  constructor(
    code: PolishOrchestrationErrorCode,
    failureStage: PolishAttemptCompletedFactV2["failureStage"],
    attemptFacts: readonly PolishAttemptCompletedFactV2[],
    message: string,
  ) {
    super(message);
    this.name = "PolishOrchestrationErrorV2";
    this.code = code;
    this.failureStage = failureStage;
    this.attemptFacts = Object.freeze([...attemptFacts]);
    this.aggregate = aggregatePolishAttemptFactsV2(this.attemptFacts);
  }
}

/**
 * A terminal lifecycle failure after an immutable attempt fact already
 * exists. It is deliberately non-retryable: retransmitting would duplicate a
 * possibly paid attempt merely because persistence/callback delivery failed.
 */
export class PolishAttemptPersistenceErrorV2<TStartResult = unknown> extends Error {
  readonly code = "ATTEMPT_PERSISTENCE_ERROR" as const;
  readonly retryable = false;
  readonly completedEvent: PolishAttemptCompletedEventV2<TStartResult>;
  readonly attemptFacts: readonly PolishAttemptCompletedFactV2[];
  readonly aggregate: RequestUsageAggregateV2;
  readonly aggregateInvariant: PolishUsageAggregationError | null;
  readonly originalCause: unknown;

  constructor(
    completedEvent: PolishAttemptCompletedEventV2<TStartResult>,
    attemptFacts: readonly PolishAttemptCompletedFactV2[],
    cause: unknown,
  ) {
    super("attempt completion persistence callback failed; retransmission is forbidden", {
      cause,
    });
    this.name = "PolishAttemptPersistenceErrorV2";
    this.completedEvent = completedEvent;
    this.attemptFacts = Object.freeze([...attemptFacts]);
    try {
      this.aggregate = aggregatePolishAttemptFactsV2(this.attemptFacts);
      this.aggregateInvariant = null;
    } catch (error) {
      if (!(error instanceof PolishUsageAggregationError)) throw error;
      this.aggregate = aggregatePolishAttemptFactsConservativeV2(this.attemptFacts);
      this.aggregateInvariant = error;
    }
    this.originalCause = cause;
  }
}

class ProviderOutcomeContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderOutcomeContractError";
  }
}

const NORMALIZED_FINISH_REASONS: ReadonlySet<string> = new Set([
  "stop",
  "length",
  "content_filter",
  "insufficient_system_resource",
  "unknown",
]);
const MAX_ROUTE_TOKEN_LENGTH = 512;
const MAX_ROUTE_ENDPOINT_LENGTH = 2_048;
const MAX_ROUTER_ATTEMPTS = 100;
const MAX_POSTGRES_BIGINT = BigInt("9223372036854775807");

function isRecordV2(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreezeV2<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return value;
  }
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    deepFreezeV2(Reflect.get(object, key), seen);
  }
  return Object.freeze(value);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The polish request was aborted.", "AbortError");
}

function assertSafeRouteTokenV2(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ROUTE_TOKEN_LENGTH ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f\s]/u.test(value) ||
    /(?:bearer|basic)\s+|(?:api[_-]?key|password|secret)\s*[:=]/iu.test(value)
  ) {
    throw new ProviderOutcomeContractError(`unsafe ${field}`);
  }
  return value;
}

function normalizeRouteObservationV2(
  value: unknown,
  fallbackProviderRequestId?: unknown,
): PolishRouteObservationV1 {
  const route = isRecordV2(value) ? value : {};
  const token = (field: string): string | null => {
    const candidate = route[field];
    return candidate === undefined
      ? null
      : assertSafeRouteTokenV2(candidate, `route.${field}`);
  };
  const gatewayRequestId = token("gatewayRequestId");
  let providerRequestId = token("providerRequestId");
  if (providerRequestId === null && fallbackProviderRequestId !== undefined) {
    providerRequestId = assertSafeRouteTokenV2(
      fallbackProviderRequestId,
      "providerRequestId",
    );
  }
  const actualModelId = token("actualModelId");

  let actualUpstreamEndpoint: string | null = null;
  if (route.actualUpstreamEndpoint !== undefined) {
    const raw = route.actualUpstreamEndpoint;
    if (
      typeof raw !== "string" ||
      raw.length === 0 ||
      raw.length > MAX_ROUTE_ENDPOINT_LENGTH ||
      raw.trim() !== raw ||
      /[\u0000-\u001f\u007f\s]/u.test(raw)
    ) {
      throw new ProviderOutcomeContractError("unsafe route.actualUpstreamEndpoint");
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new ProviderOutcomeContractError("invalid route.actualUpstreamEndpoint");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.length === 0 ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new ProviderOutcomeContractError("invalid route.actualUpstreamEndpoint");
    }
    actualUpstreamEndpoint = parsed.toString().replace(/\/$/u, "");
  }

  let routerAttemptCount: number | null = null;
  if (route.routerAttemptCount !== undefined) {
    const count = route.routerAttemptCount;
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > MAX_ROUTER_ATTEMPTS
    ) {
      throw new ProviderOutcomeContractError("invalid route.routerAttemptCount");
    }
    routerAttemptCount = count;
  }

  return Object.freeze({
    schemaVersion: "route_observation_v1",
    gatewayRequestId,
    providerRequestId,
    actualUpstreamEndpoint,
    actualModelId,
    routerAttemptCount,
  });
}

function emptyRouteObservationV2(providerRequestId?: unknown): PolishRouteObservationV1 {
  try {
    return normalizeRouteObservationV2({}, providerRequestId);
  } catch {
    return normalizeRouteObservationV2({});
  }
}

function normalizeMoneyV2(value: unknown, field: string): Readonly<MoneyNanosV1> | null {
  if (value === undefined || value === null) return null;
  if (
    !isRecordV2(value) ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/u.test(value.currency)
  ) {
    throw new ProviderOutcomeContractError(`invalid ${field}.currency`);
  }
  if (typeof value.nanos !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value.nanos)) {
    throw new ProviderOutcomeContractError(`invalid ${field}.nanos`);
  }
  const nanos = BigInt(value.nanos);
  if (nanos > MAX_POSTGRES_BIGINT) {
    throw new ProviderOutcomeContractError(`${field}.nanos exceeds bigint`);
  }
  return Object.freeze({ currency: value.currency, nanos: nanos.toString() });
}

function cloneObservedUsageV2(value: unknown): PolishAttemptUsageObservationV2 {
  if (!isRecordV2(value)) {
    throw new ProviderOutcomeContractError("observed usage must be an object");
  }
  const usage = assertNormalizedUsageV2({
    schemaVersion: value.schemaVersion as NormalizedUsageV2["schemaVersion"],
    inputTotalTokens: value.inputTotalTokens as number,
    inputCacheReadTokens: value.inputCacheReadTokens as number,
    inputCacheWriteTokens: value.inputCacheWriteTokens as number | null,
    inputStandardTokens: value.inputStandardTokens as number,
    outputTokens: value.outputTokens as number,
    reasoningTokens: value.reasoningTokens as number | null,
    cacheUsageReporting: value.cacheUsageReporting as NormalizedUsageV2["cacheUsageReporting"],
    usageComplete: value.usageComplete as boolean,
  });
  const checked = observedUsage(usage);
  if (checked.kind !== "observed") {
    throw new ProviderOutcomeContractError("validated usage became unavailable");
  }
  const usageSnapshot: NormalizedUsageV2 = { ...checked.usage };
  return Object.freeze({
    kind: "observed",
    usage: Object.freeze(usageSnapshot),
  });
}

function cloneUsageObservationV2(value: unknown): PolishAttemptUsageObservationV2 {
  if (!isRecordV2(value)) {
    throw new ProviderOutcomeContractError("usage observation must be an object");
  }
  if (value.kind === "observed") return cloneObservedUsageV2(value.usage);
  if (
    value.kind === "unavailable" &&
    value.usage === null &&
    value.usageComplete === false
  ) {
    const unavailable = unavailableUsage();
    return Object.freeze({ ...unavailable });
  }
  throw new ProviderOutcomeContractError("invalid usage observation");
}

function unavailableUsageObservationV2(): PolishAttemptUsageObservationV2 {
  return cloneUsageObservationV2(unavailableUsage());
}

function sameUsageV2(a: Readonly<NormalizedUsageV2>, b: Readonly<NormalizedUsageV2>): boolean {
  return (
    a.schemaVersion === b.schemaVersion &&
    a.inputTotalTokens === b.inputTotalTokens &&
    a.inputCacheReadTokens === b.inputCacheReadTokens &&
    a.inputCacheWriteTokens === b.inputCacheWriteTokens &&
    a.inputStandardTokens === b.inputStandardTokens &&
    a.outputTokens === b.outputTokens &&
    a.reasoningTokens === b.reasoningTokens &&
    a.cacheUsageReporting === b.cacheUsageReporting &&
    a.usageComplete === b.usageComplete
  );
}

function costObservationV2(
  usageObservation: PolishAttemptUsageObservationV2,
  frozenPrice: FrozenPriceSnapshotV1,
  providerReportedCost: unknown,
): PolishAttemptCostObservationV2 {
  const reported = normalizeMoneyV2(providerReportedCost, "providerReportedCost");
  if (usageObservation.kind === "unavailable") {
    return Object.freeze({
      schemaVersion: "cost_observation_v1",
      estimatedCost: null,
      estimationStatus: "incomplete_usage",
      incompleteReasons: Object.freeze([
        "usage_incomplete" as CostCalculationIncompleteReason,
      ]),
      providerReportedCost: reported,
    });
  }
  const calculation = calculateEstimatedCost(usageObservation.usage, frozenPrice);
  return Object.freeze({
    schemaVersion: "cost_observation_v1",
    estimatedCost:
      calculation.estimatedCost === null
        ? null
        : Object.freeze({ ...calculation.estimatedCost }),
    estimationStatus: calculation.status,
    incompleteReasons: Object.freeze([...calculation.incompleteReasons]),
    providerReportedCost: reported,
  });
}

function freezeAttemptStartedV2(
  attemptNo: number,
  startedAtMs: number,
  deadlineAtMs: number,
): PolishAttemptStartedFactV2 {
  return Object.freeze({
    schemaVersion: "polish_attempt_started_v2",
    attemptNo,
    startedAtMs,
    deadlineAtMs,
  });
}

interface CompletedFactInputV2 {
  started: PolishAttemptStartedFactV2;
  status: PolishAttemptStatusV2;
  transmitted: boolean;
  providerBillable: boolean | null;
  usageObservation: PolishAttemptUsageObservationV2;
  route: PolishRouteObservationV1;
  cost: PolishAttemptCostObservationV2;
  finishReason: NormalizedFinishReason | null;
  failureStage: PolishAttemptCompletedFactV2["failureStage"];
  error: PolishAttemptErrorObservationV2 | null;
  transportStartedAtMs: number | null;
  completedAtMs: number;
}

function freezeAttemptCompletedV2(input: CompletedFactInputV2): PolishAttemptCompletedFactV2 {
  const latencyMs =
    input.transportStartedAtMs === null
      ? 0
      : Math.max(0, Math.floor(input.completedAtMs - input.transportStartedAtMs));
  return Object.freeze({
    schemaVersion: "polish_attempt_completed_v2",
    ...input,
    error: input.error === null ? null : Object.freeze({ ...input.error }),
    latencyMs,
  });
}

function addDecimal(target: bigint, value: number): bigint {
  return target + BigInt(value);
}

/**
 * Pure request-level converter. It preserves known lower bounds, never
 * manufactures zero observations, and rejects mixed frozen currencies.
 */
export function aggregatePolishAttemptFactsV2(
  attemptFacts: readonly PolishAttemptCompletedFactV2[],
): RequestUsageAggregateV2 {
  let inputTotalTokens = BigInt(0);
  let inputCacheReadTokens = BigInt(0);
  let inputStandardTokens = BigInt(0);
  let outputTokens = BigInt(0);
  let inputCacheWriteTokens = BigInt(0);
  let reasoningTokens = BigInt(0);
  let allCacheWriteObserved = attemptFacts.length > 0;
  let allReasoningObserved = attemptFacts.length > 0;
  let usageComplete = true;

  let knownCostCurrency: string | null = null;
  let knownCostNanos = BigInt(0);
  let knownCostCount = 0;
  let estimatedCostUnknown = false;

  for (const attempt of attemptFacts) {
    if (attempt.usageObservation.kind === "unavailable") {
      usageComplete = false;
      allCacheWriteObserved = false;
      allReasoningObserved = false;
    } else {
      const usage = assertNormalizedUsageV2(
        attempt.usageObservation.usage as NormalizedUsageV2,
      );
      inputTotalTokens = addDecimal(inputTotalTokens, usage.inputTotalTokens);
      inputCacheReadTokens = addDecimal(inputCacheReadTokens, usage.inputCacheReadTokens);
      inputStandardTokens = addDecimal(inputStandardTokens, usage.inputStandardTokens);
      outputTokens = addDecimal(outputTokens, usage.outputTokens);
      usageComplete &&= usage.usageComplete;
      if (usage.inputCacheWriteTokens === null) {
        allCacheWriteObserved = false;
      } else {
        inputCacheWriteTokens = addDecimal(
          inputCacheWriteTokens,
          usage.inputCacheWriteTokens,
        );
      }
      if (usage.reasoningTokens === null) {
        allReasoningObserved = false;
      } else {
        reasoningTokens = addDecimal(reasoningTokens, usage.reasoningTokens);
      }
    }

    const estimated = attempt.cost.estimatedCost;
    if (estimated !== null) {
      const normalized = normalizeMoneyV2(estimated, "estimatedCost");
      if (normalized === null) {
        throw new PolishUsageAggregationError(
          "INVALID_COST",
          "known estimated cost unexpectedly missing",
          attemptFacts,
        );
      }
      if (knownCostCurrency !== null && normalized.currency !== knownCostCurrency) {
        throw new PolishUsageAggregationError(
          "MIXED_CURRENCY",
          "attempt estimated costs use different frozen currencies",
          attemptFacts,
        );
      }
      knownCostCurrency = normalized.currency;
      const nextKnownCostNanos = knownCostNanos + BigInt(normalized.nanos);
      if (nextKnownCostNanos > MAX_POSTGRES_BIGINT) {
        throw new PolishUsageAggregationError(
          "COST_AGGREGATE_OVERFLOW",
          "attempt estimated cost aggregate exceeds PostgreSQL bigint",
          attemptFacts,
        );
      }
      knownCostNanos = nextKnownCostNanos;
      knownCostCount += 1;
    } else if (attempt.providerBillable !== false) {
      estimatedCostUnknown = true;
    }
  }

  const providerBillable = attemptFacts.some((attempt) => attempt.providerBillable === true)
    ? true
    : attemptFacts.length > 0 && attemptFacts.every((attempt) => attempt.providerBillable === false)
      ? false
      : null;

  const knownEstimatedCost =
    knownCostCount === 0 || knownCostCurrency === null
      ? null
      : Object.freeze({
          currency: knownCostCurrency,
          nanos: knownCostNanos.toString(),
        });
  const estimatedCost = estimatedCostUnknown ? null : knownEstimatedCost;

  const incompleteFields: RequestUsageAggregateV2["incompleteFields"][number][] = [];
  if (!usageComplete) incompleteFields.push("attempt_usage");
  if (!allCacheWriteObserved) incompleteFields.push("input_cache_write");
  if (!allReasoningObserved) incompleteFields.push("reasoning");
  if (providerBillable === null) incompleteFields.push("provider_billable");
  if (estimatedCostUnknown) incompleteFields.push("estimated_cost");

  return Object.freeze({
    schemaVersion: "request_usage_aggregate_v2",
    knownUsage: Object.freeze({
      inputTotalTokens: inputTotalTokens.toString(),
      inputCacheReadTokens: inputCacheReadTokens.toString(),
      inputStandardTokens: inputStandardTokens.toString(),
      outputTokens: outputTokens.toString(),
    }),
    inputCacheWriteTokens: allCacheWriteObserved ? inputCacheWriteTokens.toString() : null,
    reasoningTokens: allReasoningObserved ? reasoningTokens.toString() : null,
    incompleteFields: Object.freeze(incompleteFields),
    usageComplete,
    providerBillable,
    knownEstimatedCost,
    estimatedCost,
  });
}

/**
 * Error-only projection used when exact cost aggregation itself violates a
 * persistence invariant. Per-attempt cost facts remain on the error; the
 * request projection drops the unpersistable cost total and marks it
 * incomplete instead of clamping or wrapping the bigint.
 */
function aggregatePolishAttemptFactsConservativeV2(
  attemptFacts: readonly PolishAttemptCompletedFactV2[],
): RequestUsageAggregateV2 {
  const withoutAggregateCost = attemptFacts.map((attempt) => ({
    ...attempt,
    cost: {
      ...attempt.cost,
      estimatedCost: null,
    },
  }));
  return aggregatePolishAttemptFactsV2(withoutAggregateCost);
}

function classifyTransportMetadataV2(error: unknown): ReturnType<typeof classifyTransportError> {
  const fields = isRecordV2(error) || error instanceof Error
    ? (error as Record<string, unknown>)
    : {};
  const code = fields.code === "UPSTREAM_TIMEOUT" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR";
  const upstreamStatus =
    typeof fields.upstreamStatus === "number" &&
    Number.isInteger(fields.upstreamStatus) &&
    fields.upstreamStatus >= 100 &&
    fields.upstreamStatus <= 599
      ? fields.upstreamStatus
      : undefined;
  const retry = classifyProviderRetry({
    code,
    upstreamStatus,
    retryable: fields.retryable,
    retryAfterMs: fields.retryAfterMs,
  });
  return {
    code,
    reason: `transport failure (${code}${upstreamStatus === undefined ? "" : `, HTTP ${upstreamStatus}`})`,
    providerRequestId:
      typeof fields.providerRequestId === "string" ? fields.providerRequestId : undefined,
    upstreamStatus,
    retryable: retry.retryable,
    retryAfterMs: retry.retryAfterMs,
  };
}

async function invokeProviderAttemptV2(
  provider: PolishInferenceProviderV2,
  request: PolishInferenceRequestV2,
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<PolishInferenceAttemptOutcomeV2> {
  if (typeof provider.completeAttempt === "function") {
    return provider.completeAttempt(request, options);
  }
  const result = await provider.complete(request, options);
  return {
    kind: "completed",
    result,
    // Deliberately do not validate here. The caller validates the result and
    // can still retain a valid usage observation if another result field is malformed.
    usageObservation: { kind: "observed", usage: result.usage },
  };
}

function normalizeInferenceResultV2(result: unknown): {
  text: string;
  finishReason: NormalizedFinishReason;
  usageObservation: Extract<PolishAttemptUsageObservationV2, { kind: "observed" }>;
  route: PolishRouteObservationV1;
  providerReportedCost: Readonly<MoneyNanosV1> | null;
} {
  if (!isRecordV2(result) || result.schemaVersion !== "polish_inference_result_v2") {
    throw new ProviderOutcomeContractError("invalid inference result schemaVersion");
  }
  if (typeof result.text !== "string") {
    throw new ProviderOutcomeContractError("inference result text must be a string");
  }
  if (typeof result.finishReason !== "string" || !NORMALIZED_FINISH_REASONS.has(result.finishReason)) {
    throw new ProviderOutcomeContractError("invalid inference result finishReason");
  }
  return {
    text: result.text,
    finishReason: result.finishReason as NormalizedFinishReason,
    usageObservation: cloneObservedUsageV2(result.usage) as Extract<
      PolishAttemptUsageObservationV2,
      { kind: "observed" }
    >,
    route: normalizeRouteObservationV2(result.route),
    providerReportedCost: normalizeMoneyV2(
      result.providerReportedCost,
      "providerReportedCost",
    ),
  };
}

function tryObservedResultUsageV2(result: unknown): PolishAttemptUsageObservationV2 {
  try {
    return isRecordV2(result)
      ? cloneObservedUsageV2(result.usage)
      : unavailableUsageObservationV2();
  } catch {
    return unavailableUsageObservationV2();
  }
}

function tryResultRouteV2(result: unknown): PolishRouteObservationV1 {
  try {
    return isRecordV2(result)
      ? normalizeRouteObservationV2(result.route)
      : emptyRouteObservationV2();
  } catch {
    return emptyRouteObservationV2();
  }
}

function tryProviderReportedCostV2(result: unknown): Readonly<MoneyNanosV1> | null {
  try {
    return isRecordV2(result)
      ? normalizeMoneyV2(result.providerReportedCost, "providerReportedCost")
      : null;
  } catch {
    return null;
  }
}

function buildInferenceRequestForAttemptV2(
  request: PolishRequest,
  promptInput: PolishPromptInput,
  providerSubjectId: string,
  outputContract: PolishInferenceRequestV2["outputContract"],
  retryFeedback: string | undefined,
): PolishInferenceRequestV2 {
  if (providerSubjectId.length === 0) {
    throw new Error("providerSubjectId must not be empty");
  }
  if (
    (outputContract.kind !== "json_object" && outputContract.kind !== "json_schema") ||
    outputContract.schemaName.length === 0
  ) {
    throw new Error("invalid polish output contract");
  }
  const prompt = buildPolishPromptBlocks({ ...promptInput, retryFeedback });
  const blocks = prompt.blocks.map((block) => ({ ...block }));
  const targets = request.items.map((item) => ({ id: item.id, text: item.text }));
  for (const block of blocks) Object.freeze(block);
  for (const target of targets) Object.freeze(target);
  Object.freeze(blocks);
  Object.freeze(targets);
  const inferenceRequest: PolishInferenceRequestV2 = {
    schemaVersion: "polish_inference_request_v2",
    prompt: Object.freeze({
      blocks,
      explicitCacheBoundaryAfter: prompt.explicitCacheBoundaryAfter,
    }),
    outputContract: Object.freeze({ ...outputContract }),
    maxOutputTokens: computePolishMaxOutputTokens(request.items),
    providerSubjectId,
    promptVersion: POLISH_PROMPT_VERSION,
    validatorVersion: POLISH_VALIDATOR_VERSION,
    language: request.language,
    targets,
  };
  return deepFreezeV2(inferenceRequest);
}

async function emitCompletedAttemptV2<TStartResult>(
  facts: PolishAttemptCompletedFactV2[],
  started: PolishAttemptStartedFactV2,
  startResult: TStartResult | undefined,
  completed: PolishAttemptCompletedFactV2,
  callback: PolishOrchestrateV2Options<TStartResult>["onAttemptCompleted"],
): Promise<void> {
  facts.push(completed);
  const event = Object.freeze({
    started,
    startResult,
    completed,
  });
  try {
    await callback?.(event);
  } catch (cause) {
    throw new PolishAttemptPersistenceErrorV2(event, facts, cause);
  }
}

function transportErrorObservationV2(
  transport: ReturnType<typeof classifyTransportError>,
): PolishAttemptErrorObservationV2 {
  return Object.freeze({
    code: transport.code,
    upstreamStatus: transport.upstreamStatus ?? null,
    retryable: transport.retryable,
    retryAfterMs: transport.retryAfterMs,
  });
}

function deadlineErrorObservationV2(): PolishAttemptErrorObservationV2 {
  return Object.freeze({
    code: "UPSTREAM_TIMEOUT",
    upstreamStatus: null,
    retryable: false,
    retryAfterMs: 0,
  });
}

/**
 * Execute one frozen profile with the V2 attempt facts. No DB or provider
 * selection happens here; callbacks are the only lifecycle seam.
 */
export async function orchestratePolishV2<TStartResult = unknown>(
  provider: PolishInferenceProviderV2,
  request: PolishRequest,
  options: PolishOrchestrateV2Options<TStartResult>,
): Promise<PolishOrchestratorSuccessV2> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepWithAbort;
  const deadline = now() + POLISH_TOTAL_DEADLINE_MS;
  // Snapshot caller-owned JSON once. Retries cannot observe later mutation of
  // the reservation-frozen price or output contract.
  const frozenPrice = deepFreezeV2(structuredClone(options.frozenPrice));
  const outputContract = deepFreezeV2(
    structuredClone(options.outputContract ?? POLISH_OUTPUT_CONTRACT_V2),
  );
  const facts: PolishAttemptCompletedFactV2[] = [];
  const promptInput: PolishPromptInput = {
    language: request.language,
    sectionId: request.sectionId,
    granularity: request.granularity,
    items: request.items,
    contextLevel: request.context.level,
    references: request.context.references,
    stylePreset: request.stylePreset,
    styleInstruction: request.styleInstruction,
  };

  let attemptNo = 0;
  let lastFailure: {
    code: PolishOrchestrationErrorCode;
    stage: PolishAttemptCompletedFactV2["failureStage"];
    reason: string;
  } | null = null;

  while (attemptNo < POLISH_MAX_ATTEMPTS) {
    if (options.signal.aborted) throw abortReason(options.signal);
    const remainingBeforeStart = deadline - now();
    if (remainingBeforeStart <= 0) break;
    if (attemptNo > 0 && remainingBeforeStart < MIN_RETRY_BUDGET_MS) break;

    attemptNo += 1;
    const started = freezeAttemptStartedV2(attemptNo, now(), deadline);
    const inferenceRequest = buildInferenceRequestForAttemptV2(
      request,
      promptInput,
      options.providerSubjectId,
      outputContract,
      attemptNo > 1 ? lastFailure?.reason : undefined,
    );

    // The result is intentionally retained in this scope and passed to the
    // completion callback on every post-admission exit path.
    const startResult = await options.onAttemptStarted?.(started);

    if (options.signal.aborted) {
      const completedAtMs = now();
      const usageObservation = unavailableUsageObservationV2();
      const completed = freezeAttemptCompletedV2({
        started,
        status: "canceled",
        transmitted: false,
        providerBillable: false,
        usageObservation,
        route: emptyRouteObservationV2(),
        cost: costObservationV2(usageObservation, frozenPrice, undefined),
        finishReason: null,
        failureStage: "transport",
        error: null,
        transportStartedAtMs: null,
        completedAtMs,
      });
      await emitCompletedAttemptV2(
        facts,
        started,
        startResult,
        completed,
        options.onAttemptCompleted,
      );
      throw abortReason(options.signal);
    }

    const postStartRemainingMs = deadline - now();
    if (
      postStartRemainingMs <= 0 ||
      (attemptNo > 1 && postStartRemainingMs < MIN_RETRY_BUDGET_MS)
    ) {
      const completedAtMs = now();
      const usageObservation = unavailableUsageObservationV2();
      const completed = freezeAttemptCompletedV2({
        started,
        status: "timed_out",
        transmitted: false,
        providerBillable: false,
        usageObservation,
        route: emptyRouteObservationV2(),
        cost: costObservationV2(usageObservation, frozenPrice, undefined),
        finishReason: null,
        failureStage: "transport",
        error: Object.freeze({
          code: "UPSTREAM_TIMEOUT",
          upstreamStatus: null,
          retryable: false,
          retryAfterMs: 0,
        }),
        transportStartedAtMs: null,
        completedAtMs,
      });
      await emitCompletedAttemptV2(
        facts,
        started,
        startResult,
        completed,
        options.onAttemptCompleted,
      );
      lastFailure ??= {
        code: "UPSTREAM_TIMEOUT",
        stage: "transport",
        reason: "total deadline exhausted before the provider call could start",
      };
      break;
    }

    const transportStartedAtMs = now();
    let outcome: PolishInferenceAttemptOutcomeV2;
    try {
      outcome = await invokeProviderAttemptV2(provider, inferenceRequest, {
        signal: options.signal,
        timeoutMs: postStartRemainingMs,
      });
    } catch (error) {
      const completedAtMs = now();
      if (options.signal.aborted) {
        const usageObservation = unavailableUsageObservationV2();
        const completed = freezeAttemptCompletedV2({
          started,
          status: "canceled",
          transmitted: true,
          providerBillable: null,
          usageObservation,
          route: emptyRouteObservationV2(
            isRecordV2(error) || error instanceof Error
              ? (error as Record<string, unknown>).providerRequestId
              : undefined,
          ),
          cost: costObservationV2(usageObservation, frozenPrice, undefined),
          finishReason: null,
          failureStage: "transport",
          error: null,
          transportStartedAtMs,
          completedAtMs,
        });
        await emitCompletedAttemptV2(
          facts,
          started,
          startResult,
          completed,
          options.onAttemptCompleted,
        );
        throw error;
      }

      const transport = classifyTransportMetadataV2(error);
      const deadlineExpired = completedAtMs >= deadline;
      const usageObservation = unavailableUsageObservationV2();
      const completed = freezeAttemptCompletedV2({
        started,
        status:
          deadlineExpired || transport.code === "UPSTREAM_TIMEOUT"
            ? "timed_out"
            : "failed_upstream",
        transmitted: true,
        providerBillable: null,
        usageObservation,
        route: emptyRouteObservationV2(transport.providerRequestId),
        cost: costObservationV2(usageObservation, frozenPrice, undefined),
        finishReason: null,
        failureStage: "transport",
        error: deadlineExpired
          ? deadlineErrorObservationV2()
          : transportErrorObservationV2(transport),
        transportStartedAtMs,
        completedAtMs,
      });
      await emitCompletedAttemptV2(
        facts,
        started,
        startResult,
        completed,
        options.onAttemptCompleted,
      );
      if (deadlineExpired) {
        lastFailure = {
          code: "UPSTREAM_TIMEOUT",
          stage: "transport",
          reason: "total deadline expired before the provider attempt settled",
        };
        break;
      }
      lastFailure = {
        code: transport.code,
        stage: "transport",
        reason: transport.reason,
      };
      if (!transport.retryable) break;
      if (transport.retryAfterMs > 0) {
        if (deadline - now() - transport.retryAfterMs < MIN_RETRY_BUDGET_MS) break;
        await sleep(transport.retryAfterMs, options.signal);
      }
      continue;
    }

    const transportCompletedAtMs = now();
    const postTransportAborted = options.signal.aborted;
    const postTransportDeadlineExpired = transportCompletedAtMs >= deadline;

    if (outcome.kind === "failed") {
      let usageObservation: PolishAttemptUsageObservationV2;
      try {
        usageObservation = cloneUsageObservationV2(outcome.usageObservation);
      } catch {
        usageObservation = unavailableUsageObservationV2();
      }
      let route: PolishRouteObservationV1;
      try {
        route = normalizeRouteObservationV2(
          outcome.route,
          outcome.failure.providerRequestId,
        );
      } catch {
        route = emptyRouteObservationV2(outcome.failure.providerRequestId);
      }
      let providerReportedCost: Readonly<MoneyNanosV1> | null;
      try {
        providerReportedCost = normalizeMoneyV2(
          outcome.providerReportedCost,
          "providerReportedCost",
        );
      } catch {
        providerReportedCost = null;
      }
      const providerBillable =
        outcome.providerBillable === true || outcome.providerBillable === false
          ? outcome.providerBillable
          : null;
      const transport = classifyTransportMetadataV2(outcome.failure);
      const completed = freezeAttemptCompletedV2({
        started,
        status: postTransportAborted
          ? "canceled"
          : postTransportDeadlineExpired || transport.code === "UPSTREAM_TIMEOUT"
            ? "timed_out"
            : "failed_upstream",
        transmitted: true,
        providerBillable,
        usageObservation,
        route,
        cost: costObservationV2(
          usageObservation,
          frozenPrice,
          providerReportedCost,
        ),
        finishReason: null,
        failureStage: "transport",
        error: postTransportAborted
          ? null
          : postTransportDeadlineExpired
            ? deadlineErrorObservationV2()
            : transportErrorObservationV2(transport),
        transportStartedAtMs,
        completedAtMs: transportCompletedAtMs,
      });
      await emitCompletedAttemptV2(
        facts,
        started,
        startResult,
        completed,
        options.onAttemptCompleted,
      );
      if (postTransportAborted) throw abortReason(options.signal);
      if (postTransportDeadlineExpired) {
        lastFailure = {
          code: "UPSTREAM_TIMEOUT",
          stage: "transport",
          reason: "total deadline expired before the provider attempt settled",
        };
        break;
      }
      lastFailure = {
        code: transport.code,
        stage: "transport",
        reason: transport.reason,
      };
      if (!transport.retryable) break;
      if (transport.retryAfterMs > 0) {
        if (deadline - now() - transport.retryAfterMs < MIN_RETRY_BUDGET_MS) break;
        await sleep(transport.retryAfterMs, options.signal);
      }
      continue;
    }

    let normalized: ReturnType<typeof normalizeInferenceResultV2>;
    try {
      normalized = normalizeInferenceResultV2(outcome.result);
      const outcomeUsage = cloneUsageObservationV2(outcome.usageObservation);
      if (
        outcomeUsage.kind !== "observed" ||
        !sameUsageV2(normalized.usageObservation.usage, outcomeUsage.usage)
      ) {
        throw new ProviderOutcomeContractError(
          "completed outcome usage observation does not match result usage",
        );
      }
    } catch {
      // A valid usage object remains a known lower bound even when another
      // adapter/result field violates the contract.
      const usageObservation = tryObservedResultUsageV2(outcome.result);
      const providerReportedCost = tryProviderReportedCostV2(outcome.result);
      const completed = freezeAttemptCompletedV2({
        started,
        status: postTransportAborted
          ? "canceled"
          : postTransportDeadlineExpired
            ? "timed_out"
            : "failed_upstream",
        transmitted: true,
        providerBillable: usageObservation.kind === "observed" ? true : null,
        usageObservation,
        route: tryResultRouteV2(outcome.result),
        cost: costObservationV2(
          usageObservation,
          frozenPrice,
          providerReportedCost,
        ),
        finishReason: null,
        failureStage: postTransportAborted || postTransportDeadlineExpired
          ? "transport"
          : "provider_contract",
        error: postTransportAborted
          ? null
          : postTransportDeadlineExpired
            ? deadlineErrorObservationV2()
            : Object.freeze({
                code: "UPSTREAM_ERROR",
                upstreamStatus: null,
                retryable: false,
                retryAfterMs: 0,
              }),
        transportStartedAtMs,
        completedAtMs: transportCompletedAtMs,
      });
      await emitCompletedAttemptV2(
        facts,
        started,
        startResult,
        completed,
        options.onAttemptCompleted,
      );
      if (postTransportAborted) throw abortReason(options.signal);
      if (postTransportDeadlineExpired) {
        lastFailure = {
          code: "UPSTREAM_TIMEOUT",
          stage: "transport",
          reason: "total deadline expired before the provider attempt settled",
        };
        break;
      }
      lastFailure = {
        code: "UPSTREAM_ERROR",
        stage: "provider_contract",
        reason: "provider result violated the canonical inference contract",
      };
      break;
    }

    if (postTransportAborted || postTransportDeadlineExpired) {
      const completed = freezeAttemptCompletedV2({
        started,
        status: postTransportAborted ? "canceled" : "timed_out",
        transmitted: true,
        providerBillable: true,
        usageObservation: normalized.usageObservation,
        route: normalized.route,
        cost: costObservationV2(
          normalized.usageObservation,
          frozenPrice,
          normalized.providerReportedCost,
        ),
        finishReason: normalized.finishReason,
        failureStage: "transport",
        error: postTransportAborted ? null : deadlineErrorObservationV2(),
        transportStartedAtMs,
        completedAtMs: transportCompletedAtMs,
      });
      await emitCompletedAttemptV2(
        facts,
        started,
        startResult,
        completed,
        options.onAttemptCompleted,
      );
      if (postTransportAborted) throw abortReason(options.signal);
      lastFailure = {
        code: "UPSTREAM_TIMEOUT",
        stage: "transport",
        reason: "total deadline expired before the provider attempt settled",
      };
      break;
    }

    const validation = validatePolishOutput(
      { text: normalized.text, finishReason: normalized.finishReason },
      { items: request.items, language: request.language },
    );
    const succeeded = validation.ok;
    const upstreamValidationFailure =
      !validation.ok && validation.classification === "upstream";
    const code: PolishOrchestrationErrorCode = upstreamValidationFailure
      ? "UPSTREAM_ERROR"
      : "INVALID_MODEL_OUTPUT";
    const status: PolishAttemptStatusV2 = succeeded
      ? "succeeded"
      : upstreamValidationFailure
        ? "failed_upstream"
        : "invalid_output";
    const completed = freezeAttemptCompletedV2({
      started,
      status,
      transmitted: true,
      providerBillable: true,
      usageObservation: normalized.usageObservation,
      route: normalized.route,
      cost: costObservationV2(
        normalized.usageObservation,
        frozenPrice,
        normalized.providerReportedCost,
      ),
      finishReason: normalized.finishReason,
      failureStage: succeeded ? null : validation.stage,
      error: succeeded
        ? null
        : Object.freeze({
            code,
            upstreamStatus: null,
            retryable: true,
            retryAfterMs: 0,
          }),
      transportStartedAtMs,
      completedAtMs: transportCompletedAtMs,
    });
    await emitCompletedAttemptV2(
      facts,
      started,
      startResult,
      completed,
      options.onAttemptCompleted,
    );

    if (validation.ok) {
      return Object.freeze({
        items: Object.freeze(
          validation.items.map((item) => Object.freeze({ ...item })),
        ),
        attemptFacts: Object.freeze([...facts]),
        aggregate: aggregatePolishAttemptFactsV2(facts),
        winningRoute: normalized.route,
      });
    }
    lastFailure = {
      code,
      stage: validation.stage,
      reason: validation.reason,
    };
  }

  throw new PolishOrchestrationErrorV2(
    lastFailure?.code ?? "UPSTREAM_ERROR",
    lastFailure?.stage ?? "transport",
    facts,
    `polish V2 failed after ${facts.length} admitted attempt(s): ${lastFailure?.reason ?? "no attempt could be started within the deadline"}`,
  );
}
