/**
 * DeepSeek polish provider (unit 2.1) — the real single-transmission
 * implementation of the pinned PolishProvider interface.
 *
 * Responsibility boundary (roadmap「系统 prompt 与输出验证」): this performs ONE
 * HTTP call to the DeepSeek chat completions API — request/response mapping,
 * usage extraction, and transport error normalization. No retries and no
 * overall deadline live here: those belong to the orchestrator (unit 2.2).
 * `timeoutMs` is the hard timeout of this single call and composes with the
 * caller's `signal` (either one cancels the call; the caller's signal wins
 * when attributing the failure).
 *
 * Pinned upstream parameters (roadmap「模型与配额」/「DeepSeek 参数」):
 * - model: deepseek-v4-flash
 * - thinking: { type: "disabled" } — V4 enables thinking by default
 * - response_format: { type: "json_object" } — JSON mode
 * - max_tokens = request.maxOutputTokens (dynamic cap computed upstream)
 * - user = request.providerUserId — the pseudonymous HMAC identifier,
 *   computed once per request by the handler
 *   (HMAC_SHA256(AI_USER_ID_HMAC_SECRET, supabaseUserId), hex) and forwarded
 *   here UNCHANGED: this provider applies no privacy logic of its own
 *   (roadmap「发给 DeepSeek 的 user 标识」). The raw UUID/email never enters
 *   this module.
 *
 * `request.targets` is internal validation/fake metadata per the pinned
 * interface: it is NEVER forwarded upstream (the same texts already appear
 * inside `request.messages`).
 *
 * Environment:
 * - DEEPSEEK_API_KEY (required — construction throws when missing)
 * - DEEPSEEK_BASE_URL (optional; defaults to the official origin)
 */

import {
  PolishProviderError,
  type PolishProvider,
  type PolishProviderRequest,
  type PolishProviderResult,
  type PolishProviderUsage,
} from "./provider";

/** Model selected by roadmap「模型与配额」. */
export const DEEPSEEK_POLISH_MODEL = "deepseek-v4-flash";

/**
 * Official API origin (OpenAI-compatible). DEEPSEEK_BASE_URL overrides it,
 * e.g. to route through a proxy or gateway; trailing slashes are stripped.
 */
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export interface DeepSeekPolishProviderOptions {
  /** Injectable for tests; production callers use the default process.env. */
  env?: Record<string, string | undefined>;
}

interface DeepSeekProviderConfig {
  apiKey: string;
  baseUrl: string;
}

function resolveConfig(
  env: Record<string, string | undefined>,
): DeepSeekProviderConfig {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "DEEPSEEK_API_KEY is required for the DeepSeek polish provider. " +
        "Set POLISH_FAKE_LLM=true to use the deterministic fake in non-production environments.",
    );
  }
  const baseUrl = (env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, "");
  return { apiKey, baseUrl };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/**
 * Map a DeepSeek finish_reason onto the pinned union (roadmap「finish_reason
 * 语义」: only "stop" proceeds to normal validation; "length" means truncated;
 * "content_filter"/"tool_calls" are invalid output; "insufficient_system_resource"
 * is an upstream failure).
 *
 * "tool_calls" has no dedicated union member: we never send tools, so it can
 * only mean unexpected model behavior. Normalizing it to "unknown" keeps the
 * orchestrator on the invalid-output path (never the upstream-failure path),
 * which is exactly the roadmap's "按无效输出" semantics. Unrecognized values
 * also map to "unknown".
 */
function normalizeFinishReason(raw: unknown): PolishProviderResult["finishReason"] {
  switch (raw) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    case "insufficient_system_resource":
      return "insufficient_system_resource";
    default:
      return "unknown";
  }
}

/**
 * Extract token usage. DeepSeek context caching reports cached reads
 * (`prompt_cache_hit_tokens`) separately from uncached reads
 * (`prompt_cache_miss_tokens`) — a 50x price difference — so they map 1:1
 * onto the pinned usage fields. A missing/partial usage block degrades to
 * zeros (the cost record is degraded rather than failing a request whose
 * tokens were already consumed).
 */
function normalizeUsage(raw: unknown): PolishProviderUsage {
  const usage = isRecord(raw) ? raw : {};
  return {
    promptTokens: toNonNegativeInt(usage.prompt_tokens),
    completionTokens: toNonNegativeInt(usage.completion_tokens),
    cachedReadTokens: toNonNegativeInt(usage.prompt_cache_hit_tokens),
    uncachedReadTokens: toNonNegativeInt(usage.prompt_cache_miss_tokens),
  };
}

/**
 * Normalize a fetch/body-read rejection. Caller cancellation is rethrown
 * verbatim (the signal's reason, typically an AbortError) — never wrapped in
 * a PolishProviderError, so the orchestrator can tell user cancellation apart
 * from transport failure. The hard single-call timeout maps to
 * UPSTREAM_TIMEOUT; everything else (DNS, connection reset, malformed JSON
 * body, …) maps to UPSTREAM_ERROR.
 */
function normalizeTransportFailure(
  error: unknown,
  callerSignal: AbortSignal,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
): never {
  if (callerSignal.aborted) {
    throw callerSignal.reason;
  }
  if (timeoutSignal.aborted) {
    throw new PolishProviderError(
      "UPSTREAM_TIMEOUT",
      `DeepSeek chat completions exceeded the ${timeoutMs}ms hard timeout`,
      { cause: error },
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  throw new PolishProviderError(
    "UPSTREAM_ERROR",
    `DeepSeek chat completions request failed: ${detail}`,
    { cause: error },
  );
}

export function createDeepSeekPolishProvider(
  options: DeepSeekPolishProviderOptions = {},
): PolishProvider {
  const config = resolveConfig(options.env ?? process.env);

  return {
    async complete(
      request: PolishProviderRequest,
      { signal, timeoutMs }: { signal: AbortSignal; timeoutMs: number },
    ): Promise<PolishProviderResult> {
      // Cancellation is rethrown as-is (never wrapped), per the interface contract.
      signal.throwIfAborted();

      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      // Either source cancels this single call; on attribution the caller's
      // signal has priority (checked first in normalizeTransportFailure).
      const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

      let response: Response;
      try {
        response = await fetch(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          // Field-by-field: `targets` metadata is deliberately NOT forwarded —
          // the target texts already appear inside `messages`, and the pinned
          // interface restricts `targets` to validation/fake echo use.
          body: JSON.stringify({
            model: DEEPSEEK_POLISH_MODEL,
            messages: request.messages,
            thinking: { type: "disabled" },
            response_format: { type: "json_object" },
            max_tokens: request.maxOutputTokens,
            // Pseudonymous id computed by the caller (handler); forwarded
            // unchanged, never a raw supabase user id.
            user: request.providerUserId,
          }),
          signal: combinedSignal,
        });
      } catch (error) {
        normalizeTransportFailure(error, signal, timeoutSignal, timeoutMs);
      }

      // Correlation metadata is safe to surface (status codes and request ids
      // are structured log fields, not content); the error BODY is on the
      // roadmap no-store list (it may echo sensitive detail) and is never read.
      const correlationId = response.headers.get("x-request-id") ?? undefined;

      if (!response.ok) {
        throw new PolishProviderError(
          "UPSTREAM_ERROR",
          `DeepSeek chat completions failed with HTTP ${response.status} ` +
            "(response body omitted by design)",
          { providerRequestId: correlationId, upstreamStatus: response.status },
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        normalizeTransportFailure(error, signal, timeoutSignal, timeoutMs);
      }

      // Envelope sanity only. Validating the model's *content* (JSON parse of
      // `text`, zod schema, id exact-set, length caps, protected spans) is the
      // orchestrator's job; the raw text is passed through untouched.
      const choices = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : [];
      const firstChoice = isRecord(choices[0]) ? choices[0] : undefined;
      const message = firstChoice && isRecord(firstChoice.message) ? firstChoice.message : undefined;
      const content = message?.content;
      if (typeof content !== "string") {
        throw new PolishProviderError(
          "UPSTREAM_ERROR",
          "DeepSeek response envelope is missing choices[0].message.content",
          { providerRequestId: correlationId },
        );
      }

      return {
        // May be "" — the orchestrator owns the non-empty check.
        text: content,
        finishReason: normalizeFinishReason(firstChoice?.finish_reason),
        usage: normalizeUsage(isRecord(payload) ? payload.usage : undefined),
        // The completion id is the provider-side correlation id; fall back to
        // the HTTP x-request-id header when the body omits it.
        providerRequestId:
          isRecord(payload) && typeof payload.id === "string" && payload.id.length > 0
            ? payload.id
            : correlationId,
      };
    },
  };
}
