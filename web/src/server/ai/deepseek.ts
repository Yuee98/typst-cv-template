import { assertNormalizedUsage, type NormalizedUsage, type NormalizedFinishReason, type PolishInferenceRequest, type PolishInferenceResult } from "./inference";
import { MAX_PROVIDER_RETRY_AFTER_MS } from "./provider-error";
import { POLISH_STABLE_PROMPT_BLOCK_ID, POLISH_VARIABLE_PROMPT_BLOCK_ID } from "./prompt";
const DEEPSEEK_RESPONSES_ADAPTER_KIND = "deepseek_responses_v1";
const MAX_OUTPUT_TOKENS = 393216;
export interface DeepSeekResponsesAdapter {
  readonly kind: typeof DEEPSEEK_RESPONSES_ADAPTER_KIND;
  complete(request: PolishInferenceRequest, options: {
    signal: AbortSignal;
    timeoutMs: number;
  }): Promise<PolishInferenceResult>;
}
/** Safe structured metadata only. Provider bodies and transport causes are never retained. */
export class DeepSeekResponsesAdapterError extends Error {
  readonly code: "UPSTREAM_ERROR" | "UPSTREAM_TIMEOUT";
  readonly providerRequestId?: string;
  readonly upstreamStatus?: number;
  readonly retryAfterMs?: number;
  readonly retryable?: boolean;
  constructor(code: "UPSTREAM_ERROR" | "UPSTREAM_TIMEOUT", message: string, options: {
    providerRequestId?: string;
    upstreamStatus?: number;
    retryAfterMs?: number;
    retryable?: boolean;
  } = {}) {
    super(message);
    this.name = "DeepSeekResponsesAdapterError";
    this.code = code;
    this.providerRequestId = options.providerRequestId;
    this.upstreamStatus = options.upstreamStatus;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safeRouteToken(value: unknown, maxLength = 256): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value) ? value : undefined;
}
function tokenCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || value as number < 0) throw new DeepSeekResponsesAdapterError("UPSTREAM_ERROR", "DeepSeek Responses contains invalid " + field);
  return value as number;
}
function normalizeUsage(raw: unknown, providerRequestId?: string): NormalizedUsage {
  try {
    if (!isRecord(raw) || !isRecord(raw.input_tokens_details)) throw new DeepSeekResponsesAdapterError("UPSTREAM_ERROR", "DeepSeek Responses usage is unavailable");
    const inputTotalTokens = tokenCount(raw.input_tokens, "input_tokens");
    const outputTokens = tokenCount(raw.output_tokens, "output_tokens");
    const totalTokens = tokenCount(raw.total_tokens, "total_tokens");
    // Automatic cache reads are reported explicitly. An absent count is not evidence of zero.
    const inputCacheReadTokens = tokenCount(raw.input_tokens_details.cached_tokens, "cached_tokens");
    let reasoningTokens: number | null = null;
    if (raw.output_tokens_details !== undefined) {
      if (!isRecord(raw.output_tokens_details)) throw new DeepSeekResponsesAdapterError("UPSTREAM_ERROR", "DeepSeek Responses usage details are malformed");
      if (raw.output_tokens_details.reasoning_tokens !== undefined) reasoningTokens = tokenCount(raw.output_tokens_details.reasoning_tokens, "reasoning_tokens");
    }
    const explainedTotal = inputTotalTokens + outputTokens;
    if (!Number.isSafeInteger(explainedTotal) || totalTokens !== explainedTotal || inputCacheReadTokens > inputTotalTokens) throw new DeepSeekResponsesAdapterError("UPSTREAM_ERROR", "DeepSeek Responses usage violates token conservation");
    return assertNormalizedUsage({
      schemaVersion: "normalized_usage",
      inputTotalTokens,
      inputCacheReadTokens,
      // Responses has no separately reported cache-write bucket; preserve that uncertainty.
      inputCacheWriteTokens: null,
      inputStandardTokens: inputTotalTokens - inputCacheReadTokens,
      outputTokens,
      reasoningTokens,
      cacheUsageReporting: "unavailable",
      usageComplete: true
    });
  } catch (error) {
    throw new DeepSeekResponsesAdapterError("UPSTREAM_ERROR", error instanceof DeepSeekResponsesAdapterError ? error.message : "DeepSeek Responses usage violates the normalized usage contract", {
      providerRequestId
    });
  }
}
function requestBody(request: PolishInferenceRequest, modelId: string): Record<string, unknown> {
  const {
    prompt,
    outputContract,
    maxOutputTokens,
    providerSubjectId
  } = request;
  const stable = prompt?.blocks?.[0],
    variable = prompt?.blocks?.[1];
  if (request.schemaVersion !== "polish_inference_request" || prompt?.blocks?.length !== 2 || stable?.id !== POLISH_STABLE_PROMPT_BLOCK_ID || stable.role !== "developer" || stable.stability !== "stable" || typeof stable.content !== "string" || !stable.content || variable?.id !== POLISH_VARIABLE_PROMPT_BLOCK_ID || variable.role !== "user" || variable.stability !== "variable" || typeof variable.content !== "string" || !variable.content || prompt.explicitCacheBoundaryAfter !== POLISH_STABLE_PROMPT_BLOCK_ID || outputContract?.kind !== "json_object" || outputContract.schemaName !== "polish_items_v1" || !isRecord(outputContract.schema) || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS || typeof providerSubjectId !== "string" || !/^[0-9a-f]{64}$/.test(providerSubjectId)) {
    throw new DeepSeekResponsesAdapterError("UPSTREAM_ERROR", "DeepSeek request violates the canonical Responses contract", {
      retryable: false
    });
  }
  return {
    model: modelId,
    // Instructions is system-level. DeepSeek treats an input developer role as a user role.
    instructions: stable.content,
    input: variable.content,
    max_output_tokens: maxOutputTokens,
    stream: false,
    reasoning: {
      effort: "none"
    },
    text: {
      format: {
        type: "json_object"
      }
    },
    user: providerSubjectId
    // No store/previous_response_id: DeepSeek Responses is stateless and does not support them.
  };
}
function extractOutput(payload: Record<string, unknown>): {
  text: string;
  valid: boolean;
} {
  if (payload.object !== "response" || !Array.isArray(payload.output)) return {
    text: "",
    valid: false
  };
  const chunks: string[] = [];
  for (const item of payload.output) {
    if (!isRecord(item)) return {
      text: "",
      valid: false
    };
    if (item.type === "reasoning") continue;
    const terminalMessage = item.status === "completed" || payload.status !== "completed" && (item.status === "incomplete" || item.status === "in_progress");
    if (item.type !== "message" || item.role !== "assistant" || !terminalMessage || !Array.isArray(item.content)) return {
      text: "",
      valid: false
    };
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== "output_text" || typeof part.text !== "string") return {
        text: "",
        valid: false
      };
      chunks.push(part.text);
    }
  }
  return {
    text: chunks.join(""),
    valid: chunks.length > 0
  };
}
function finishReason(payload: Record<string, unknown>, hasText: boolean): NormalizedFinishReason {
  if (payload.error !== undefined && payload.error !== null) return "unknown";
  if (payload.status === "completed") return hasText ? "stop" : "unknown";
  if (payload.status === "incomplete" && isRecord(payload.incomplete_details)) {
    if (payload.incomplete_details.reason === "max_output_tokens") return "length";
    if (payload.incomplete_details.reason === "content_filter") return "content_filter";
  }
  return "unknown";
}
function readRetryAfterMs(response: Response): number | undefined {
  if (response.status !== 429) return undefined;
  const raw = response.headers.get("retry-after");
  if (raw === null || !/^\d+(?:\.\d+)?$/u.test(raw.trim())) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.floor(seconds * 1000), MAX_PROVIDER_RETRY_AFTER_MS) : undefined;
}
function transportFailure(callerSignal: AbortSignal, timeoutSignal: AbortSignal, timeoutMs: number, providerRequestId?: string): never {
  if (callerSignal.aborted) throw callerSignal.reason;
  if (timeoutSignal.aborted) throw new DeepSeekResponsesAdapterError("UPSTREAM_TIMEOUT", "DeepSeek Responses exceeded the " + timeoutMs + "ms hard timeout", {
    providerRequestId
  });
  throw new DeepSeekResponsesAdapterError("UPSTREAM_ERROR", "DeepSeek Responses transport failed", {
    providerRequestId
  });
}
export function createDeepSeekResponsesTransport(options: {
  endpoint: string;
  apiKey: string;
  modelId: string;
  fetch?: typeof fetch;
  beforeSend?: () => void;
}): DeepSeekResponsesAdapter {
  const {
    endpoint,
    apiKey,
    modelId
  } = options;
  const fetchImpl = options.fetch ?? fetch;
  return {
    kind: DEEPSEEK_RESPONSES_ADAPTER_KIND,
    async complete(request, {
      signal,
      timeoutMs
    }) {
      signal.throwIfAborted();
      const body = requestBody(request, modelId);
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
      let response: Response;
      options.beforeSend?.();
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: "Bearer " + apiKey,
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify(body),
          signal: combinedSignal
        });
      } catch {
        transportFailure(signal, timeoutSignal, timeoutMs);
      }
      if (response.redirected || response.url.length > 0 && response.url !== endpoint) throw new DeepSeekResponsesAdapterError("UPSTREAM_ERROR", "DeepSeek Responses returned an unexpected redirect", {
        retryable: false
      });
      const headerRequestId = safeRouteToken(response.headers.get("x-request-id"));
      if (!response.ok) throw new DeepSeekResponsesAdapterError("UPSTREAM_ERROR", "DeepSeek Responses failed with HTTP " + response.status + " (body omitted)", {
        providerRequestId: headerRequestId,
        upstreamStatus: response.status,
        retryAfterMs: readRetryAfterMs(response)
      });
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        transportFailure(signal, timeoutSignal, timeoutMs, headerRequestId);
      }
      const record = isRecord(payload) ? payload : {};
      const providerRequestId = safeRouteToken(record.id) ?? headerRequestId;
      const usage = normalizeUsage(record.usage, providerRequestId);
      const output = extractOutput(record);
      const bodyHasError = record.error !== undefined && record.error !== null;
      const modelMismatch = typeof record.model === "string" && record.model !== modelId;
      return {
        schemaVersion: "polish_inference_result",
        text: output.valid && !bodyHasError && !modelMismatch ? output.text : "",
        finishReason: modelMismatch ? "unknown" : finishReason(record, output.valid),
        usage,
        route: {
          ...(headerRequestId ? {
            gatewayRequestId: headerRequestId
          } : {}),
          ...(providerRequestId ? {
            providerRequestId
          } : {}),
          actualUpstreamEndpoint: endpoint,
          ...(record.model === modelId ? {
            actualModelId: modelId
          } : {})
        }
      };
    }
  };
}
