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
 * - user = HMAC-SHA256 hex of the verified supabase user id, keyed by the
 *   server-side AI_USER_ID_HMAC_SECRET — the raw UUID, email, or name is
 *   never sent (roadmap「发给 DeepSeek 的 user 标识」)
 *
 * Environment:
 * - DEEPSEEK_API_KEY (required — construction throws when missing)
 * - AI_USER_ID_HMAC_SECRET (required — keys the user-id HMAC)
 * - DEEPSEEK_BASE_URL (optional; defaults to the official origin)
 */

import { createHmac } from "node:crypto";
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
  /**
   * Verified supabase user id of the request being served. Required: it is
   * HMAC'd into the upstream `user` abuse-tracking field, so the provider can
   * only be constructed per authenticated request — never with a raw id sent
   * upstream, and never anonymously.
   */
  userId?: string;
}

interface DeepSeekProviderConfig {
  apiKey: string;
  baseUrl: string;
  /** HMAC-SHA256 hex (64 chars) of the supabase user id. */
  userHmac: string;
}

function resolveConfig(
  env: Record<string, string | undefined>,
  userId: string | undefined,
): DeepSeekProviderConfig {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "DEEPSEEK_API_KEY is required for the DeepSeek polish provider. " +
        "Set POLISH_FAKE_LLM=true to use the deterministic fake in non-production environments.",
    );
  }
  if (!userId) {
    throw new Error(
      "The DeepSeek polish provider requires the verified supabase user id " +
        "(options.userId) to derive the HMAC `user` field. Resolve the provider per " +
        "authenticated request, after auth.",
    );
  }
  const hmacSecret = env.AI_USER_ID_HMAC_SECRET;
  if (!hmacSecret) {
    throw new Error(
      "AI_USER_ID_HMAC_SECRET is required for the DeepSeek polish provider: the upstream " +
        "`user` field is HMAC-SHA256(secret, userId) and the raw user id must never be sent.",
    );
  }
  const baseUrl = (env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, "");
  return {
    apiKey,
    baseUrl,
    userHmac: createHmac("sha256", hmacSecret).update(userId).digest("hex"),
  };
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
  const config = resolveConfig(options.env ?? process.env, options.userId);

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
          body: JSON.stringify({
            model: DEEPSEEK_POLISH_MODEL,
            messages: request.messages,
            thinking: { type: "disabled" },
            response_format: { type: "json_object" },
            max_tokens: request.maxOutputTokens,
            user: config.userHmac,
          }),
          signal: combinedSignal,
        });
      } catch (error) {
        normalizeTransportFailure(error, signal, timeoutSignal, timeoutMs);
      }

      if (!response.ok) {
        // The upstream error body is on the roadmap no-store list (it may echo
        // sensitive detail), so only the status code is surfaced — enough for
        // diagnosis without persisting provider error payloads.
        throw new PolishProviderError(
          "UPSTREAM_ERROR",
          `DeepSeek chat completions failed with HTTP ${response.status} ` +
            "(response body omitted by design)",
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
        );
      }

      return {
        // May be "" — the orchestrator owns the non-empty check.
        text: content,
        finishReason: normalizeFinishReason(firstChoice?.finish_reason),
        usage: normalizeUsage(isRecord(payload) ? payload.usage : undefined),
      };
    },
  };
}
