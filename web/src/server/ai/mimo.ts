import { assertNormalizedUsage, type NormalizedFinishReason, type NormalizedUsage, type PolishInferenceRequest, type PolishInferenceResult } from "./inference";
import { MAX_PROVIDER_RETRY_AFTER_MS } from "./provider-error";
import { POLISH_STABLE_PROMPT_BLOCK_ID, POLISH_VARIABLE_PROMPT_BLOCK_ID } from "./prompt";
const MIMO_RESPONSES_ADAPTER_KIND = "mimo_responses_v1";
export const MIMO_RESPONSES_MAX_OUTPUT_TOKENS = 131072;
const POLISH_OUTPUT_SCHEMA_NAME = "polish_items_v1";
const MISSING_DATA_PROPERTY = Symbol("missing-data-property");
export interface MimoResponsesAdapter {
  readonly kind: typeof MIMO_RESPONSES_ADAPTER_KIND;
  complete(request: PolishInferenceRequest, options: {
    signal: AbortSignal;
    timeoutMs: number;
  }): Promise<PolishInferenceResult>;
}
/** Safe structured metadata only; upstream bodies/messages/causes are absent. */
export class MimoResponsesAdapterError extends Error {
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
    this.name = "MimoResponsesAdapterError";
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
function ownDataProperty(value: Record<string, unknown>, property: string): unknown | typeof MISSING_DATA_PROPERTY {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : MISSING_DATA_PROPERTY;
}
function malformedRequest(): MimoResponsesAdapterError {
  return new MimoResponsesAdapterError("UPSTREAM_ERROR", "MiMo request violates the canonical prompt-only contract", {
    retryable: false
  });
}
function safeRouteToken(value: unknown, maxLength = 256): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value) ? value : undefined;
}
function readTokenCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || value as number < 0) {
    throw new MimoResponsesAdapterError("UPSTREAM_ERROR", `MiMo response contains invalid ${field}`);
  }
  return value as number;
}
function readOptionalDetail(container: unknown, field: string, providerRequestId?: string): number | null {
  if (container === undefined) return null;
  if (!isRecord(container)) {
    throw new MimoResponsesAdapterError("UPSTREAM_ERROR", "MiMo response usage details are malformed", {
      providerRequestId
    });
  }
  if (container[field] === undefined) return null;
  try {
    return readTokenCount(container[field], field);
  } catch (error) {
    if (error instanceof MimoResponsesAdapterError) {
      throw new MimoResponsesAdapterError(error.code, error.message, {
        providerRequestId
      });
    }
    throw error;
  }
}
function normalizeUsage(raw: unknown, providerRequestId?: string): NormalizedUsage {
  if (!isRecord(raw)) {
    throw new MimoResponsesAdapterError("UPSTREAM_ERROR", "MiMo response usage is unavailable", {
      providerRequestId
    });
  }
  let inputTotalTokens: number;
  let outputTokens: number;
  let totalTokens: number;
  try {
    inputTotalTokens = readTokenCount(raw.input_tokens, "input_tokens");
    outputTokens = readTokenCount(raw.output_tokens, "output_tokens");
    totalTokens = readTokenCount(raw.total_tokens, "total_tokens");
  } catch (error) {
    if (error instanceof MimoResponsesAdapterError) {
      throw new MimoResponsesAdapterError(error.code, error.message, {
        providerRequestId
      });
    }
    throw error;
  }
  const inputCacheReadTokens = readOptionalDetail(raw.input_tokens_details, "cached_tokens", providerRequestId) ?? 0;
  const reasoningTokens = readOptionalDetail(raw.output_tokens_details, "reasoning_tokens", providerRequestId);
  const explainedTotal = inputTotalTokens + outputTokens;
  if (!Number.isSafeInteger(explainedTotal) || totalTokens !== explainedTotal || inputCacheReadTokens > inputTotalTokens) {
    throw new MimoResponsesAdapterError("UPSTREAM_ERROR", "MiMo response usage violates token conservation", {
      providerRequestId
    });
  }
  try {
    return assertNormalizedUsage({
      schemaVersion: "normalized_usage",
      inputTotalTokens,
      inputCacheReadTokens,
      // MiMo prices cache writes as limited-time free, but its Responses usage
      // does not report a distinct write bucket. Keep it unknown rather than 0.
      inputCacheWriteTokens: null,
      inputStandardTokens: inputTotalTokens - inputCacheReadTokens,
      outputTokens,
      reasoningTokens,
      cacheUsageReporting: "unavailable",
      usageComplete: true
    });
  } catch {
    throw new MimoResponsesAdapterError("UPSTREAM_ERROR", "MiMo response usage violates the normalized usage contract", {
      providerRequestId
    });
  }
}
function assertRequestAndBuildBody(request: PolishInferenceRequest, modelId: string): Record<string, unknown> {
  try {
    const requestRecord = request as unknown;
    if (!isRecord(requestRecord)) throw malformedRequest();
    const schemaVersion = ownDataProperty(requestRecord, "schemaVersion");
    const prompt = ownDataProperty(requestRecord, "prompt");
    const outputContract = ownDataProperty(requestRecord, "outputContract");
    const maxOutputTokens = ownDataProperty(requestRecord, "maxOutputTokens");
    if (schemaVersion !== "polish_inference_request" || !isRecord(prompt) || !isRecord(outputContract) || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens as number < 1 || maxOutputTokens as number > MIMO_RESPONSES_MAX_OUTPUT_TOKENS) {
      throw malformedRequest();
    }
    const blocks = ownDataProperty(prompt, "blocks");
    const boundary = ownDataProperty(prompt, "explicitCacheBoundaryAfter");
    if (!Array.isArray(blocks) || blocks.length !== 2 || !Object.hasOwn(blocks, 0) || !Object.hasOwn(blocks, 1)) {
      throw malformedRequest();
    }
    const stableDescriptor = Object.getOwnPropertyDescriptor(blocks, "0");
    const variableDescriptor = Object.getOwnPropertyDescriptor(blocks, "1");
    const stable = stableDescriptor !== undefined && "value" in stableDescriptor ? stableDescriptor.value : MISSING_DATA_PROPERTY;
    const variable = variableDescriptor !== undefined && "value" in variableDescriptor ? variableDescriptor.value : MISSING_DATA_PROPERTY;
    if (!isRecord(stable) || !isRecord(variable)) throw malformedRequest();
    const stableId = ownDataProperty(stable, "id");
    const stableRole = ownDataProperty(stable, "role");
    const stableStability = ownDataProperty(stable, "stability");
    const stableContent = ownDataProperty(stable, "content");
    const variableId = ownDataProperty(variable, "id");
    const variableRole = ownDataProperty(variable, "role");
    const variableStability = ownDataProperty(variable, "stability");
    const variableContent = ownDataProperty(variable, "content");
    const outputKind = ownDataProperty(outputContract, "kind");
    const schemaName = ownDataProperty(outputContract, "schemaName");
    const outputSchema = ownDataProperty(outputContract, "schema");
    if (stableId !== POLISH_STABLE_PROMPT_BLOCK_ID || stableRole !== "developer" || stableStability !== "stable" || typeof stableContent !== "string" || stableContent.length === 0 || variableId !== POLISH_VARIABLE_PROMPT_BLOCK_ID || variableRole !== "user" || variableStability !== "variable" || typeof variableContent !== "string" || variableContent.length === 0 || boundary !== stableId || outputKind !== "json_object" || schemaName !== POLISH_OUTPUT_SCHEMA_NAME || !isRecord(outputSchema)) {
      throw malformedRequest();
    }
    return {
      model: modelId,
      // MiMo documents `instructions` and string `input`. The code-owned stable
      // instructions precede the variable user suffix, preserving auto-cache
      // prefix semantics without sending undocumented cache controls.
      instructions: stableContent,
      input: variableContent,
      max_output_tokens: maxOutputTokens,
      stream: false,
      reasoning: {
        effort: "none"
      }
    };
  } catch (error) {
    if (error instanceof MimoResponsesAdapterError) throw error;
    throw malformedRequest();
  }
}
function extractOutputText(payload: Record<string, unknown>): {
  text: string;
  hasOutputText: boolean;
  structurallyValid: boolean;
} {
  if (payload.object !== "response" || !Array.isArray(payload.output)) {
    return {
      text: "",
      hasOutputText: false,
      structurallyValid: false
    };
  }
  const chunks: string[] = [];
  let hasOutputText = false;
  let structurallyValid = true;
  for (const item of payload.output) {
    if (!isRecord(item)) {
      structurallyValid = false;
      continue;
    }
    if (item.type === "reasoning") continue;
    const terminalMessage = item.status === "completed" || payload.status !== "completed" && (item.status === "in_progress" || item.status === "incomplete");
    if (item.type !== "message" || item.role !== "assistant" || !terminalMessage || !Array.isArray(item.content)) {
      structurallyValid = false;
      continue;
    }
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== "output_text" || typeof part.text !== "string") {
        structurallyValid = false;
        continue;
      }
      hasOutputText ||= part.text.length > 0;
      chunks.push(part.text);
    }
  }
  return structurallyValid ? {
    text: chunks.join(""),
    hasOutputText,
    structurallyValid: true
  } : {
    text: "",
    hasOutputText: false,
    structurallyValid: false
  };
}
function normalizeFinishReason(payload: Record<string, unknown>, hasOutputText: boolean): NormalizedFinishReason {
  if (payload.status === "completed") return hasOutputText ? "stop" : "unknown";
  if (payload.status !== "incomplete" || !isRecord(payload.incomplete_details)) {
    return "unknown";
  }
  switch (payload.incomplete_details.reason) {
    case "max_output_tokens":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "unknown";
  }
}
function readRetryAfterMs(response: Response): number | undefined {
  if (response.status !== 429) return undefined;
  const raw = response.headers.get("retry-after");
  if (raw === null || !/^\d+(?:\.\d+)?$/u.test(raw.trim())) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(Math.floor(seconds * 1000), MAX_PROVIDER_RETRY_AFTER_MS);
}
function throwTransportFailure(callerSignal: AbortSignal, timeoutSignal: AbortSignal, timeoutMs: number): never {
  if (callerSignal.aborted) throw callerSignal.reason;
  if (timeoutSignal.aborted) {
    throw new MimoResponsesAdapterError("UPSTREAM_TIMEOUT", `MiMo Responses exceeded its hard timeoutMs (${timeoutMs}ms)`);
  }
  throw new MimoResponsesAdapterError("UPSTREAM_ERROR", "MiMo Responses transport failed (raw error omitted)");
}
export function createMimoResponsesTransport(options: {
  endpoint: string;
  apiKey: string;
  modelId: string;
  fetch?: typeof fetch;
  beforeSend?: () => void;
}): MimoResponsesAdapter {
  const {
    endpoint,
    apiKey,
    modelId
  } = options;
  const fetchImpl = options.fetch ?? fetch;
  return {
    kind: MIMO_RESPONSES_ADAPTER_KIND,
    async complete(request: PolishInferenceRequest, {
      signal,
      timeoutMs
    }: {
      signal: AbortSignal;
      timeoutMs: number;
    }): Promise<PolishInferenceResult> {
      signal.throwIfAborted();
      options.beforeSend?.();
      const body = assertRequestAndBuildBody(request, modelId);
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            "api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify(body),
          signal: combinedSignal
        });
      } catch {
        throwTransportFailure(signal, timeoutSignal, timeoutMs);
      }
      if (response.redirected || response.url.length > 0 && response.url !== endpoint) {
        throw new MimoResponsesAdapterError("UPSTREAM_ERROR", "MiMo Responses returned an unexpected redirect", {
          retryable: false
        });
      }
      if (!response.ok) {
        throw new MimoResponsesAdapterError("UPSTREAM_ERROR", `MiMo Responses failed with HTTP ${response.status} (body omitted)`, {
          upstreamStatus: response.status,
          retryAfterMs: readRetryAfterMs(response)
        });
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throwTransportFailure(signal, timeoutSignal, timeoutMs);
      }
      const payloadRecord = isRecord(payload) ? payload : undefined;
      const providerRequestId = safeRouteToken(payloadRecord?.id);
      const usage = normalizeUsage(payloadRecord?.usage, providerRequestId);
      const actualModelId = payloadRecord?.model === modelId ? modelId : undefined;
      const bodyHasError = payloadRecord?.error !== undefined && payloadRecord.error !== null;
      const modelMismatch = typeof payloadRecord?.model === "string" && payloadRecord.model !== modelId;
      const extracted = payloadRecord ? extractOutputText(payloadRecord) : {
        text: "",
        hasOutputText: false,
        structurallyValid: false
      };
      return {
        schemaVersion: "polish_inference_result",
        text: bodyHasError || modelMismatch || !extracted.structurallyValid ? "" : extracted.text,
        finishReason: bodyHasError || modelMismatch || !extracted.structurallyValid ? "unknown" : normalizeFinishReason(payloadRecord ?? {}, extracted.hasOutputText),
        usage,
        route: {
          ...(providerRequestId ? {
            providerRequestId
          } : {}),
          actualUpstreamEndpoint: endpoint,
          ...(actualModelId ? {
            actualModelId
          } : {})
        }
      };
    }
  };
}
