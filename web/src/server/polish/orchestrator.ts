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
import { buildPolishMessages, POLISH_PROMPT_VERSION, type PolishPromptInput } from "./prompt";
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
