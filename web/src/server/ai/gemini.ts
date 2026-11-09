import { assertNormalizedUsage, type NormalizedUsage, type NormalizedFinishReason, type PolishInferenceRequest, type PolishInferenceResult } from "./inference";
import { MAX_PROVIDER_RETRY_AFTER_MS } from "./provider-error";
import { POLISH_STABLE_PROMPT_BLOCK_ID, POLISH_VARIABLE_PROMPT_BLOCK_ID } from "./prompt";

const KIND = "gemini_interactions_v1";
const MAX_OUTPUT_TOKENS = 65536;
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, polished: { type: "string" } }, required: ["id", "polished"], additionalProperties: false }
    }
  },
  required: ["items"],
  additionalProperties: false
} as const;
export interface GeminiInteractionsAdapter {
  readonly kind: typeof KIND;
  complete(request: PolishInferenceRequest, options: { signal: AbortSignal; timeoutMs: number }): Promise<PolishInferenceResult>;
}
/** Safe metadata only; no response body, thought signature, or transport cause is retained. */
export class GeminiInteractionsAdapterError extends Error {
  readonly code: "UPSTREAM_ERROR" | "UPSTREAM_TIMEOUT";
  readonly providerRequestId?: string;
  readonly upstreamStatus?: number;
  readonly retryAfterMs?: number;
  readonly retryable?: boolean;
  constructor(code: "UPSTREAM_ERROR" | "UPSTREAM_TIMEOUT", message: string, options: { providerRequestId?: string; upstreamStatus?: number; retryAfterMs?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "GeminiInteractionsAdapterError";
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
function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) ? value : undefined;
}
function tokenCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new GeminiInteractionsAdapterError("UPSTREAM_ERROR", "Gemini Interactions contains invalid " + field);
  return value as number;
}
function normalizeUsage(raw: unknown, providerRequestId?: string): NormalizedUsage {
  try {
    if (!isRecord(raw)) throw new GeminiInteractionsAdapterError("UPSTREAM_ERROR", "Gemini Interactions usage is unavailable");
    const inputTotalTokens = tokenCount(raw.total_input_tokens, "total_input_tokens");
    const visibleOutputTokens = tokenCount(raw.total_output_tokens, "total_output_tokens");
    const reasoningTokens = tokenCount(raw.total_thought_tokens, "total_thought_tokens");
    const inputCacheReadTokens = tokenCount(raw.total_cached_tokens, "total_cached_tokens");
    const toolTokens = tokenCount(raw.total_tool_use_tokens, "total_tool_use_tokens");
    const total = tokenCount(raw.total_tokens, "total_tokens");
    // Google bills visible output PLUS thinking. Normalize once into the shared billed-output bucket.
    const outputTokens = visibleOutputTokens + reasoningTokens;
    const explained = inputTotalTokens + outputTokens;
    if (!Number.isSafeInteger(outputTokens) || !Number.isSafeInteger(explained) || total !== explained || inputCacheReadTokens > inputTotalTokens || toolTokens !== 0) throw new GeminiInteractionsAdapterError("UPSTREAM_ERROR", "Gemini Interactions usage violates the tool-free token contract");
    return assertNormalizedUsage({
      schemaVersion: "normalized_usage", inputTotalTokens, inputCacheReadTokens,
      inputCacheWriteTokens: null, inputStandardTokens: inputTotalTokens - inputCacheReadTokens,
      outputTokens, reasoningTokens, cacheUsageReporting: "unavailable", usageComplete: true
    });
  } catch (error) {
    throw new GeminiInteractionsAdapterError("UPSTREAM_ERROR", error instanceof GeminiInteractionsAdapterError ? error.message : "Gemini Interactions usage violates the normalized usage contract", { providerRequestId });
  }
}
function requestBody(request: PolishInferenceRequest, modelId: string): Record<string, unknown> {
  const { prompt, outputContract, maxOutputTokens } = request;
  const stable = prompt?.blocks?.[0], variable = prompt?.blocks?.[1];
  if (request.schemaVersion !== "polish_inference_request" || prompt?.blocks?.length !== 2 ||
      stable?.id !== POLISH_STABLE_PROMPT_BLOCK_ID || stable.role !== "developer" || stable.stability !== "stable" || typeof stable.content !== "string" || !stable.content ||
      variable?.id !== POLISH_VARIABLE_PROMPT_BLOCK_ID || variable.role !== "user" || variable.stability !== "variable" || typeof variable.content !== "string" || !variable.content ||
      prompt.explicitCacheBoundaryAfter !== POLISH_STABLE_PROMPT_BLOCK_ID || outputContract?.kind !== "json_object" || outputContract.schemaName !== "polish_items_v1" ||
      !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS) {
    throw new GeminiInteractionsAdapterError("UPSTREAM_ERROR", "Gemini request violates the canonical Interactions contract", { retryable: false });
  }
  return {
    model: modelId,
    system_instruction: stable.content,
    input: variable.content,
    stream: false,
    store: false,
    background: false,
    generation_config: { thinking_level: "low", thinking_summaries: "none", max_output_tokens: maxOutputTokens },
    response_format: { type: "text", mime_type: "application/json", schema: OUTPUT_SCHEMA }
  };
}
function extractText(record: Record<string, unknown>): { text: string; valid: boolean } {
  if (record.object !== "interaction" || !Array.isArray(record.steps)) return { text: "", valid: false };
  const parts: string[] = [];
  for (const step of record.steps) {
    if (!isRecord(step)) return { text: "", valid: false };
    // Known thinking steps are never returned to the user, retained, or sent in a later request.
    if (step.type === "thought") continue;
    if (step.type !== "model_output" || !Array.isArray(step.content)) return { text: "", valid: false };
    for (const content of step.content) {
      if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") return { text: "", valid: false };
      parts.push(content.text);
    }
  }
  return { text: parts.join(""), valid: parts.length > 0 };
}
function finishReason(record: Record<string, unknown>, validText: boolean): NormalizedFinishReason {
  if (hasErrors(record)) return "unknown";
  if (record.status === "completed") return validText ? "stop" : "unknown";
  if (record.status === "incomplete") return "length";
  return "unknown";
}
function hasErrors(record: Record<string, unknown>): boolean {
  return record.errors !== undefined && (!Array.isArray(record.errors) || record.errors.length > 0) || record.error !== undefined && record.error !== null;
}
function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (response.status !== 429 || value === null || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.floor(seconds * 1000), MAX_PROVIDER_RETRY_AFTER_MS) : undefined;
}
function transportFailure(signal: AbortSignal, timeout: AbortSignal, timeoutMs: number, providerRequestId?: string): never {
  if (signal.aborted) throw signal.reason;
  if (timeout.aborted) throw new GeminiInteractionsAdapterError("UPSTREAM_TIMEOUT", "Gemini Interactions exceeded the " + timeoutMs + "ms hard timeout", { providerRequestId });
  throw new GeminiInteractionsAdapterError("UPSTREAM_ERROR", "Gemini Interactions transport failed", { providerRequestId });
}
export function createGeminiInteractionsTransport(options: { endpoint: string; apiKey: string; modelId: string; fetch?: typeof fetch; beforeSend?: () => void }): GeminiInteractionsAdapter {
  const { endpoint, apiKey, modelId } = options;
  const fetchImpl = options.fetch ?? fetch;
  return {
    kind: KIND,
    async complete(request, { signal, timeoutMs }) {
      signal.throwIfAborted();
      const body = requestBody(request, modelId);
      const timeout = AbortSignal.timeout(timeoutMs), combined = AbortSignal.any([signal, timeout]);
      let response: Response;
      options.beforeSend?.();
      try {
        response = await fetchImpl(endpoint, {
          method: "POST", redirect: "error", headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body), signal: combined
        });
      } catch { transportFailure(signal, timeout, timeoutMs); }
      if (response.redirected || response.url.length > 0 && response.url !== endpoint) throw new GeminiInteractionsAdapterError("UPSTREAM_ERROR", "Gemini Interactions returned an unexpected redirect", { retryable: false });
      const headerId = safeToken(response.headers.get("x-goog-request-id"));
      if (!response.ok) throw new GeminiInteractionsAdapterError("UPSTREAM_ERROR", "Gemini Interactions failed with HTTP " + response.status + " (body omitted)", { upstreamStatus: response.status, retryAfterMs: retryAfter(response), providerRequestId: headerId });
      let payload: unknown;
      try { payload = await response.json(); } catch { transportFailure(signal, timeout, timeoutMs, headerId); }
      const record = isRecord(payload) ? payload : {};
      const providerRequestId = safeToken(record.id) ?? headerId;
      const usage = normalizeUsage(record.usage, providerRequestId);
      const extracted = extractText(record);
      const hasError = hasErrors(record);
      const modelMismatch = typeof record.model === "string" && record.model !== modelId;
      return {
        schemaVersion: "polish_inference_result", text: extracted.valid && !hasError && !modelMismatch ? extracted.text : "", finishReason: modelMismatch ? "unknown" : finishReason(record, extracted.valid), usage,
        route: { ...(headerId ? { gatewayRequestId: headerId } : {}), ...(providerRequestId ? { providerRequestId } : {}), actualUpstreamEndpoint: endpoint, ...(record.model === modelId ? { actualModelId: modelId } : {}) }
      };
    }
  };
}
