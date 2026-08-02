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
 * - maxOutputTokens is dynamic: min(POLISH_MAX_OUTPUT_TOKENS,
 *   totalTargetChars × 1.5 + JSON overhead), per roadmap「总输出预算」
 */

import { POLISH_MAX_OUTPUT_TOKENS, type PolishRequest } from "@/lib/polish/contract";
import { buildPolishMessages, POLISH_PROMPT_VERSION, type PolishPromptInput } from "./prompt";
import {
  POLISH_VALIDATOR_VERSION,
  validatePolishOutput,
  type PolishValidationFailureStage,
} from "./validate";

export { POLISH_PROMPT_VERSION, POLISH_VALIDATOR_VERSION };

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

// TODO(2.3): import from "./provider" once the foundation branch lands (structural duplicate, pinned)
export interface PolishProviderRequest {
  /** Fully assembled chat messages (system + user), already level-trimmed. */
  messages: { role: "system" | "user"; content: string }[];
  /** Hard output cap computed by the orchestrator (dynamic max_tokens). */
  maxOutputTokens: number;
}

export interface PolishProviderUsage {
  promptTokens: number;
  completionTokens: number;
  cachedReadTokens: number;
  uncachedReadTokens: number;
}

export interface PolishProviderResult {
  /** Raw text body of the first choice (expected to be JSON per prompt contract). */
  text: string;
  /** Normalized finish reason. */
  finishReason: "stop" | "length" | "content_filter" | "insufficient_system_resource" | "unknown";
  usage: PolishProviderUsage;
}

export interface PolishProvider {
  complete(
    request: PolishProviderRequest,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<PolishProviderResult>;
}

// ---------------------------------------------------------------------------
// Budget constants
// ---------------------------------------------------------------------------

/** Total deadline for the whole polish operation (roadmap: 45s). */
export const POLISH_TOTAL_DEADLINE_MS = 45_000;
/** Retry at most once (roadmap: 失败重试 1 次). */
export const POLISH_MAX_ATTEMPTS = 2;
/** Below this remaining budget a retry is pointless for an LLM round-trip. */
export const MIN_RETRY_BUDGET_MS = 5_000;

/**
 * JSON structure overhead for the dynamic max_tokens computation
 * ({"items":[{"id":"...","polished":"..."}]}, ids ≤32 chars, escaping
 * margin). Worst case within contract limits: 32 + 30 × 24 = 752 tokens,
 * keeping MAX_TOTAL_POLISHED_CHARS + overhead ≤ POLISH_MAX_OUTPUT_TOKENS.
 */
const JSON_ENVELOPE_TOKENS = 32;
const JSON_TOKENS_PER_ITEM = 24;

/** Dynamic max_tokens: min(POLISH_MAX_OUTPUT_TOKENS, totalTargetChars × 1.5 + JSON overhead). */
export function computeMaxOutputTokens(totalTargetChars: number, itemCount: number): number {
  const overhead = JSON_ENVELOPE_TOKENS + itemCount * JSON_TOKENS_PER_ITEM;
  return Math.min(POLISH_MAX_OUTPUT_TOKENS, Math.ceil(totalTargetChars * 1.5) + overhead);
}

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

  constructor(
    code: PolishOrchestrationErrorCode,
    failureStage: PolishOrchestrationFailureStage,
    usage: PolishProviderUsage,
    attempts: number,
    message: string,
  ) {
    super(message);
    this.name = "PolishOrchestrationError";
    this.code = code;
    this.failureStage = failureStage;
    this.usage = usage;
    this.attempts = attempts;
  }
}

export interface PolishOrchestratorSuccess {
  items: { id: string; polished: string }[];
  /** Summed usage across all attempts made. */
  usage: PolishProviderUsage;
  attempts: number;
}

export interface PolishOrchestrateOptions {
  /** Caller cancellation (client disconnect / user abort). Propagated, never retried. */
  signal: AbortSignal;
  /** Time source, injectable for deterministic deadline tests. Defaults to Date.now. */
  now?: () => number;
}

const MAX_TRANSPORT_REASON_CHARS = 200;

/**
 * Transport failures are classified as "the provider threw" (its errors are
 * normalized PolishProviderError with code UPSTREAM_ERROR/UPSTREAM_TIMEOUT);
 * the code is read structurally without importing the provider module.
 */
function classifyTransportError(error: unknown): {
  code: "UPSTREAM_ERROR" | "UPSTREAM_TIMEOUT";
  reason: string;
} {
  const providerCode =
    error instanceof Error ? (error as { code?: unknown }).code : undefined;
  const code = providerCode === "UPSTREAM_TIMEOUT" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR";
  const detail = error instanceof Error ? error.message : String(error);
  const reason = `transport failure (${code}): ${detail}`.slice(0, MAX_TRANSPORT_REASON_CHARS);
  return { code, reason };
}

/**
 * Run the polish operation for an already contract-validated request.
 * Resolves with the validated items + accumulated usage; rejects with
 * PolishOrchestrationError on budget exhaustion, or rethrows the abort error
 * unchanged on cancellation.
 */
export async function orchestratePolish(
  provider: PolishProvider,
  request: PolishRequest,
  options: PolishOrchestrateOptions,
): Promise<PolishOrchestratorSuccess> {
  const now = options.now ?? Date.now;
  const deadline = now() + POLISH_TOTAL_DEADLINE_MS;

  const totalTargetChars = request.items.reduce((sum, item) => sum + item.text.length, 0);
  const maxOutputTokens = computeMaxOutputTokens(totalTargetChars, request.items.length);

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

    let result: PolishProviderResult;
    try {
      result = await provider.complete(
        { messages, maxOutputTokens },
        { signal: options.signal, timeoutMs: remainingMs },
      );
    } catch (error) {
      if (options.signal.aborted) {
        // Cancellation: propagate as-is, not a failed attempt, never retried.
        throw error;
      }
      const transport = classifyTransportError(error);
      lastFailure = { code: transport.code, stage: "transport", reason: transport.reason };
      continue;
    }

    usage = addPolishUsage(usage, result.usage);

    const validation = validatePolishOutput(result, {
      items: request.items,
      language: request.language,
    });
    if (validation.ok) {
      return { items: validation.items, usage, attempts };
    }
    lastFailure = {
      // insufficient_system_resource is classified "upstream" by the
      // validator (roadmap: treated as an upstream fault, quota refundable).
      code: validation.classification === "upstream" ? "UPSTREAM_ERROR" : "INVALID_MODEL_OUTPUT",
      stage: validation.stage,
      reason: validation.reason,
    };
  }

  throw new PolishOrchestrationError(
    lastFailure?.code ?? "UPSTREAM_ERROR",
    lastFailure?.stage ?? "transport",
    usage,
    attempts,
    `polish failed after ${attempts} attempt(s): ${lastFailure?.reason ?? "no attempt could be started within the deadline"}`,
  );
}
