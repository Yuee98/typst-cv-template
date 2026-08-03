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
 * - at most 2 attempts; transport failures (provider threw) and validation
 *   failures share the same attempt budget
 * - attempt 2 carries the previous failure reason in the retry prompt
 * - usage is accumulated across attempts and returned/surfaced on BOTH
 *   success and failure (roadmap Invariant 7: all retry tokens count)
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
  /** Time source, injectable for deterministic deadline tests. Defaults to Date.now. */
  now?: () => number;
}

const MAX_TRANSPORT_REASON_CHARS = 200;

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
} {
  const fields = error instanceof Error ? (error as Partial<PolishProviderError>) : {};
  const code = fields.code === "UPSTREAM_TIMEOUT" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR";
  const detail = error instanceof Error ? error.message : String(error);
  const reason = `transport failure (${code}): ${detail}`.slice(0, MAX_TRANSPORT_REASON_CHARS);
  return {
    code,
    reason,
    providerRequestId:
      typeof fields.providerRequestId === "string" ? fields.providerRequestId : undefined,
    upstreamStatus: typeof fields.upstreamStatus === "number" ? fields.upstreamStatus : undefined,
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
  let lastFailure: {
    code: PolishOrchestrationErrorCode;
    stage: PolishOrchestrationFailureStage;
    reason: string;
    providerRequestId?: string;
    upstreamStatus?: number;
  } | null = null;

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

    let result: PolishProviderResult;
    try {
      result = await provider.complete(
        {
          messages,
          maxOutputTokens,
          providerUserId: options.providerUserId,
          targets,
        },
        { signal: options.signal, timeoutMs: remainingMs },
      );
    } catch (error) {
      if (options.signal.aborted) {
        // Cancellation: propagate as-is, not a failed attempt, never retried.
        throw error;
      }
      const transport = classifyTransportError(error);
      lastFailure = {
        code: transport.code,
        stage: "transport",
        reason: transport.reason,
        providerRequestId: transport.providerRequestId,
        upstreamStatus: transport.upstreamStatus,
      };
      continue;
    }

    usage = addPolishUsage(usage, result.usage);

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
