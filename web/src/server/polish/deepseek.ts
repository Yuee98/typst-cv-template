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
 * - user_id = request.providerUserId — the pseudonymous HMAC identifier,
 *   computed once per request by the handler
 *   (HMAC_SHA256(AI_USER_ID_HMAC_SECRET, supabaseUserId), hex) and forwarded
 *   here UNCHANGED: this provider applies no privacy logic of its own
 *   (roadmap「发给 DeepSeek 的 user 标识」). DeepSeek documents `user_id`
 *   (NOT `user`) as the field used for identity distinction, KV-cache
 *   privacy isolation and scheduling isolation. The raw UUID/email never
 *   enters this module.
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
import {
  assertNormalizedUsageV2,
  toLegacyProviderRequest,
  type NormalizedUsageV2,
  type PolishInferenceRequestV2,
  type PolishInferenceResultV2,
} from "./inference-v2";
import { MAX_PROVIDER_RETRY_AFTER_MS } from "./provider-error";
import {
  resolveCredentialSecret,
  resolveEndpoint,
} from "./adapter-registry";
import { resolveProfile } from "./profile-registry";
import { assertPreparedProviderTransportV2, type PreparedProviderTransportV2 } from "./provider-binding-v2";

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
  /** Injectable transport for unit tests; production callers use global fetch. */
  fetch?: typeof fetch;
}

export const DEEPSEEK_CHAT_V1_ADAPTER_KIND = "deepseek_chat_v1" as const;
export const DEEPSEEK_CHAT_V1_PROFILE_KEY =
  "deepseek.official.deepseek-v4-flash.chat.v1" as const;

export interface DeepSeekChatV1AdapterOptions {
  /** Secrets are resolved through the code-owned credential alias. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Injectable transport for unit tests; never retries internally. */
  fetch?: typeof fetch;
}

export interface DeepSeekChatV1Adapter {
  readonly kind: typeof DEEPSEEK_CHAT_V1_ADAPTER_KIND;
  complete(
    request: PolishInferenceRequestV2,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<PolishInferenceResultV2>;
}

/**
 * Safe structured error emitted only by the V2 adapter. Raw response bodies,
 * transport messages and causes are deliberately absent.
 */
export class DeepSeekChatV1AdapterError extends Error {
  readonly code: "UPSTREAM_ERROR" | "UPSTREAM_TIMEOUT";
  readonly providerRequestId?: string;
  readonly upstreamStatus?: number;
  readonly retryAfterMs?: number;
  readonly retryable?: boolean;

  constructor(
    code: "UPSTREAM_ERROR" | "UPSTREAM_TIMEOUT",
    message: string,
    options: {
      providerRequestId?: string;
      upstreamStatus?: number;
      retryAfterMs?: number;
      retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "DeepSeekChatV1AdapterError";
    this.code = code;
    this.providerRequestId = options.providerRequestId;
    this.upstreamStatus = options.upstreamStatus;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable;
  }
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

function buildDeepSeekChatBody(request: PolishProviderRequest, modelId = DEEPSEEK_POLISH_MODEL): Record<string, unknown> {
  return {
    model: modelId,
    messages: request.messages,
    thinking: { type: "disabled" },
    response_format: { type: "json_object" },
    max_tokens: request.maxOutputTokens,
    user_id: request.providerUserId,
  };
}

function readRequiredTokenCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DeepSeekChatV1AdapterError(
      "UPSTREAM_ERROR",
      `DeepSeek response contains invalid ${field}`,
    );
  }
  return value as number;
}

function readOptionalTokenCount(value: unknown, field: string): number {
  return value === undefined ? 0 : readRequiredTokenCount(value, field);
}

function normalizeUsageV2(raw: unknown, providerRequestId?: string): NormalizedUsageV2 {
  if (!isRecord(raw)) {
    throw new DeepSeekChatV1AdapterError(
      "UPSTREAM_ERROR",
      "DeepSeek response usage is unavailable",
      { providerRequestId },
    );
  }

  let inputTotalTokens: number;
  let outputTokens: number;
  let inputCacheReadTokens: number;
  let reportedStandardTokens: number;
  let reasoningTokens: number | null = null;
  try {
    inputTotalTokens = readRequiredTokenCount(raw.prompt_tokens, "prompt_tokens");
    outputTokens = readRequiredTokenCount(raw.completion_tokens, "completion_tokens");
    inputCacheReadTokens = readOptionalTokenCount(
      raw.prompt_cache_hit_tokens,
      "prompt_cache_hit_tokens",
    );
    reportedStandardTokens = readOptionalTokenCount(
      raw.prompt_cache_miss_tokens,
      "prompt_cache_miss_tokens",
    );
    if (isRecord(raw.completion_tokens_details)) {
      const rawReasoning = raw.completion_tokens_details.reasoning_tokens;
      if (rawReasoning !== undefined) {
        reasoningTokens = readRequiredTokenCount(rawReasoning, "reasoning_tokens");
      }
    }
  } catch (error) {
    if (error instanceof DeepSeekChatV1AdapterError && providerRequestId !== undefined) {
      throw new DeepSeekChatV1AdapterError(error.code, error.message, {
        providerRequestId,
      });
    }
    throw error;
  }

  const explainedInput = inputCacheReadTokens + reportedStandardTokens;
  if (!Number.isSafeInteger(explainedInput) || explainedInput > inputTotalTokens) {
    throw new DeepSeekChatV1AdapterError(
      "UPSTREAM_ERROR",
      "DeepSeek response cache usage violates input conservation",
      { providerRequestId },
    );
  }

  try {
    return assertNormalizedUsageV2({
      schemaVersion: "normalized_usage_v2",
      inputTotalTokens,
      inputCacheReadTokens,
      inputCacheWriteTokens: null,
      inputStandardTokens: reportedStandardTokens + (inputTotalTokens - explainedInput),
      outputTokens,
      reasoningTokens,
      cacheUsageReporting: "unavailable",
      usageComplete: true,
    });
  } catch {
    throw new DeepSeekChatV1AdapterError(
      "UPSTREAM_ERROR",
      "DeepSeek response usage violates the normalized usage contract",
      { providerRequestId },
    );
  }
}

function safeRouteToken(value: unknown, maxLength = 256): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
    ? value
    : undefined;
}

function readRetryAfterMs(response: Response): number | undefined {
  if (response.status !== 429) return undefined;
  const raw = response.headers.get("retry-after");
  if (raw === null || !/^\d+(?:\.\d+)?$/u.test(raw.trim())) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(Math.floor(seconds * 1000), MAX_PROVIDER_RETRY_AFTER_MS);
}

function normalizeV2TransportFailure(
  callerSignal: AbortSignal,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
  providerRequestId?: string,
): never {
  if (callerSignal.aborted) throw callerSignal.reason;
  if (timeoutSignal.aborted) {
    throw new DeepSeekChatV1AdapterError(
      "UPSTREAM_TIMEOUT",
      `DeepSeek chat completions exceeded the ${timeoutMs}ms hard timeout`,
    );
  }
  throw new DeepSeekChatV1AdapterError(
    "UPSTREAM_ERROR",
    "DeepSeek chat completions transport failed",
    { providerRequestId },
  );
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
 * onto the pinned usage fields.
 *
 * Conservation (DeepSeek schema: prompt_tokens = hit + miss): any prompt
 * tokens NOT explained by the cache split are booked as UNCACHED reads —
 * the cost-conservative classification — so a response that omits the cache
 * fields can never record a nonzero request as zero billable input.
 *
 * A missing usage block, or one missing the required totals
 * (prompt_tokens / completion_tokens), is NOT degraded to a zero-usage
 * success: the envelope is rejected with a controlled UPSTREAM_ERROR, which
 * the orchestrator treats as an ordinary transport failure (retry once,
 * then failed_upstream). Absence of usage is not proof that no cost was
 * incurred, so faking a complete zero is never acceptable.
 */
function normalizeUsage(raw: unknown, providerRequestId?: string): PolishProviderUsage {
  const usage = isRecord(raw) ? raw : undefined;
  if (
    usage === undefined ||
    typeof usage.prompt_tokens !== "number" ||
    typeof usage.completion_tokens !== "number"
  ) {
    throw new PolishProviderError(
      "UPSTREAM_ERROR",
      "DeepSeek response is missing the usage block or its required totals",
      { providerRequestId },
    );
  }
  const promptTokens = toNonNegativeInt(usage.prompt_tokens);
  const cachedReadTokens = toNonNegativeInt(usage.prompt_cache_hit_tokens);
  const reportedUncached = toNonNegativeInt(usage.prompt_cache_miss_tokens);
  const explained = cachedReadTokens + reportedUncached;
  return {
    promptTokens,
    completionTokens: toNonNegativeInt(usage.completion_tokens),
    cachedReadTokens,
    // Unexplained prompt tokens are uncached (cost-conservative).
    uncachedReadTokens:
      explained < promptTokens
        ? reportedUncached + (promptTokens - explained)
        : reportedUncached,
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
  const injectedFetch = options.fetch;

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
        response = await (injectedFetch ?? fetch)(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          // Field-by-field: `targets` metadata is deliberately NOT forwarded —
          // the target texts already appear inside `messages`, and the pinned
          // interface restricts `targets` to validation/fake echo use.
          body: JSON.stringify(buildDeepSeekChatBody(request)),
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
      //
      // Extraction order matters (round-2 #2): the correlation id and the
      // token usage are normalized BEFORE the content check, because a
      // malformed envelope (missing/empty choices, non-string content) still
      // carries billable usage that must reach the ledger.
      const providerRequestId =
        isRecord(payload) && typeof payload.id === "string" && payload.id.length > 0
          ? payload.id
          : correlationId;
      // A missing usage block stays a hard UPSTREAM_ERROR (absence of usage
      // is not proof that no cost was incurred) — thrown with the request id.
      const usage = normalizeUsage(isRecord(payload) ? payload.usage : undefined, providerRequestId);

      const choices = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : [];
      const firstChoice = isRecord(choices[0]) ? choices[0] : undefined;
      const message = firstChoice && isRecord(firstChoice.message) ? firstChoice.message : undefined;
      const content = message?.content;
      if (typeof content !== "string") {
        // Malformed envelope WITH a valid usage block: not a transport
        // failure. Return an empty text with finishReason "unknown" so the
        // orchestrator's validator rejects it as invalid output (retryable,
        // classification invalid_output) while the usage is accumulated and
        // recorded — never dropped on the floor (round-2 #2).
        return { text: "", finishReason: "unknown", usage, providerRequestId };
      }

      return {
        // May be "" — the orchestrator owns the non-empty check.
        text: content,
        finishReason: normalizeFinishReason(firstChoice?.finish_reason),
        usage,
        providerRequestId,
      };
    },
  };
}

/**
 * Code-owned `deepseek_chat_v1` V2 adapter. It preserves the legacy Chat wire
 * bytes as the rollback path while exposing normalized V2 usage and route
 * observations. One call means exactly one transmission; retry/fallback stay
 * outside this module.
 */
export function createDeepSeekChatV1Adapter(
  options: DeepSeekChatV1AdapterOptions = {},
): DeepSeekChatV1Adapter {
  const env = options.env ?? process.env;
  const profile = resolveProfile(DEEPSEEK_CHAT_V1_PROFILE_KEY);
  const endpoint = resolveEndpoint(profile.endpointAlias).url;
  const apiKey = resolveCredentialSecret(profile.credentialAlias, env);
  return createDeepSeekChatTransport({ endpoint, apiKey, modelId: profile.modelId, fetch: options.fetch });
}

export function createPreparedDeepSeekChatAdapter(
  prepared: PreparedProviderTransportV2, fetchImpl?: typeof fetch,
): DeepSeekChatV1Adapter {
  assertPreparedProviderTransportV2(prepared);
  if (prepared.profile.adapterKind !== DEEPSEEK_CHAT_V1_ADAPTER_KIND) throw new Error("Unsupported prepared adapter");
  return createDeepSeekChatTransport({
    endpoint: prepared.endpoint, apiKey: prepared.apiKey, modelId: prepared.profile.modelId,
    fetch: fetchImpl, exactModelObservation: true, beforeSend: () => assertPreparedProviderTransportV2(prepared),
  });
}

function createDeepSeekChatTransport(options: {
  endpoint: string; apiKey: string; modelId: string; fetch?: typeof fetch;
  exactModelObservation?: boolean; beforeSend?: () => void;
}): DeepSeekChatV1Adapter {
  const { endpoint, apiKey, modelId } = options;
  const fetchImpl = options.fetch ?? fetch;

  return {
    kind: DEEPSEEK_CHAT_V1_ADAPTER_KIND,
    async complete(
      request: PolishInferenceRequestV2,
      { signal, timeoutMs }: { signal: AbortSignal; timeoutMs: number },
    ): Promise<PolishInferenceResultV2> {
      signal.throwIfAborted();
      options.beforeSend?.();
      const legacyRequest = toLegacyProviderRequest(request);
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          // Never forward the bearer token or request body to a redirect
          // target. The observed route remains the exact code-owned endpoint.
          redirect: "error",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(buildDeepSeekChatBody(legacyRequest, modelId)),
          signal: combinedSignal,
        });
      } catch {
        normalizeV2TransportFailure(signal, timeoutSignal, timeoutMs);
      }

      if (
        response.redirected ||
        (response.url.length > 0 && response.url !== endpoint)
      ) {
        throw new DeepSeekChatV1AdapterError(
          "UPSTREAM_ERROR",
          "DeepSeek chat completions returned an unexpected redirect",
          { retryable: false },
        );
      }

      const headerRequestId = safeRouteToken(response.headers.get("x-request-id"));
      if (!response.ok) {
        throw new DeepSeekChatV1AdapterError(
          "UPSTREAM_ERROR",
          `DeepSeek chat completions failed with HTTP ${response.status} (body omitted)`,
          {
            providerRequestId: headerRequestId,
            upstreamStatus: response.status,
            retryAfterMs: readRetryAfterMs(response),
          },
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        normalizeV2TransportFailure(signal, timeoutSignal, timeoutMs, headerRequestId);
      }

      const payloadRecord = isRecord(payload) ? payload : undefined;
      const bodyRequestId = safeRouteToken(payloadRecord?.id);
      const providerRequestId = bodyRequestId ?? headerRequestId;
      const usage = normalizeUsageV2(payloadRecord?.usage, providerRequestId);
      const choices = Array.isArray(payloadRecord?.choices) ? payloadRecord.choices : [];
      const firstChoice = isRecord(choices[0]) ? choices[0] : undefined;
      const message = firstChoice && isRecord(firstChoice.message) ? firstChoice.message : undefined;
      const content = message?.content;
      const contentIsString = typeof content === "string";
      const observedModelId = options.exactModelObservation
        ? (payloadRecord?.model === modelId ? modelId : undefined)
        : safeRouteToken(payloadRecord?.model, 128);
      // `modelId` is the expected frozen model, not evidence of what
      // served this response. Record an actual-model observation only when
      // the upstream explicitly reports the same safe identifier.
      const actualModelId = observedModelId === modelId ? observedModelId : undefined;

      return {
        schemaVersion: "polish_inference_result_v2",
        text: contentIsString ? content : "",
        finishReason: contentIsString
          ? normalizeFinishReason(firstChoice?.finish_reason)
          : "unknown",
        usage,
        route: {
          ...(headerRequestId ? { gatewayRequestId: headerRequestId } : {}),
          ...(providerRequestId ? { providerRequestId } : {}),
          actualUpstreamEndpoint: endpoint,
          ...(actualModelId ? { actualModelId } : {}),
        },
      };
    },
  };
}
