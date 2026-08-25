/**
 * Xiaomi MiMo Responses adapter.
 *
 * One `complete` call performs exactly one non-streaming transmission to the
 * code-owned pay-as-you-go endpoint. Retry, deadline and output validation
 * remain orchestrator responsibilities. Only fields documented by the MiMo
 * Responses reference are sent or consumed; raw error bodies, undocumented
 * request-id headers and SDK-only convenience fields are not authority.
 */

import {
  assertNormalizedUsageV2,
  type NormalizedFinishReason,
  type NormalizedUsageV2,
  type PolishInferenceRequestV2,
  type PolishInferenceResultV2,
} from "./inference-v2";
import {
  resolveCredentialSecret,
  resolveEndpoint,
} from "./adapter-registry";
import { MAX_PROVIDER_RETRY_AFTER_MS } from "./provider-error";
import { resolveProfile } from "./profile-registry";

export const MIMO_RESPONSES_V1_ADAPTER_KIND = "mimo_responses_v1" as const;
export const MIMO_RESPONSES_V1_PROFILE_KEY =
  "mimo.cn.mimo-v2.5-pro.responses.v1" as const;
export const MIMO_RESPONSES_MAX_OUTPUT_TOKENS = 131_072;

export interface MimoResponsesV1AdapterOptions {
  /** Secrets are resolved only through the code-owned credential alias. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Injectable one-call transport for unit and later live-conformance tests. */
  fetch?: typeof fetch;
}

export interface MimoResponsesV1Adapter {
  readonly kind: typeof MIMO_RESPONSES_V1_ADAPTER_KIND;
  complete(
    request: PolishInferenceRequestV2,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<PolishInferenceResultV2>;
}

/** Safe structured metadata only; upstream bodies/messages/causes are absent. */
export class MimoResponsesV1AdapterError extends Error {
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
    this.name = "MimoResponsesV1AdapterError";
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
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
    ? value
    : undefined;
}

function readTokenCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new MimoResponsesV1AdapterError(
      "UPSTREAM_ERROR",
      `MiMo response contains invalid ${field}`,
    );
  }
  return value as number;
}

function readOptionalDetail(
  container: unknown,
  field: string,
  providerRequestId?: string,
): number | null {
  if (container === undefined) return null;
  if (!isRecord(container)) {
    throw new MimoResponsesV1AdapterError(
      "UPSTREAM_ERROR",
      "MiMo response usage details are malformed",
      { providerRequestId },
    );
  }
  if (container[field] === undefined) return null;
  try {
    return readTokenCount(container[field], field);
  } catch (error) {
    if (error instanceof MimoResponsesV1AdapterError) {
      throw new MimoResponsesV1AdapterError(error.code, error.message, {
        providerRequestId,
      });
    }
    throw error;
  }
}

function normalizeUsage(
  raw: unknown,
  providerRequestId?: string,
): NormalizedUsageV2 {
  if (!isRecord(raw)) {
    throw new MimoResponsesV1AdapterError(
      "UPSTREAM_ERROR",
      "MiMo response usage is unavailable",
      { providerRequestId },
    );
  }

  let inputTotalTokens: number;
  let outputTokens: number;
  let totalTokens: number;
  try {
    inputTotalTokens = readTokenCount(raw.input_tokens, "input_tokens");
    outputTokens = readTokenCount(raw.output_tokens, "output_tokens");
    totalTokens = readTokenCount(raw.total_tokens, "total_tokens");
  } catch (error) {
    if (error instanceof MimoResponsesV1AdapterError) {
      throw new MimoResponsesV1AdapterError(error.code, error.message, {
        providerRequestId,
      });
    }
    throw error;
  }

  const inputCacheReadTokens =
    readOptionalDetail(
      raw.input_tokens_details,
      "cached_tokens",
      providerRequestId,
    ) ?? 0;
  const reasoningTokens = readOptionalDetail(
    raw.output_tokens_details,
    "reasoning_tokens",
    providerRequestId,
  );

  const explainedTotal = inputTotalTokens + outputTokens;
  if (
    !Number.isSafeInteger(explainedTotal) ||
    totalTokens !== explainedTotal ||
    inputCacheReadTokens > inputTotalTokens
  ) {
    throw new MimoResponsesV1AdapterError(
      "UPSTREAM_ERROR",
      "MiMo response usage violates token conservation",
      { providerRequestId },
    );
  }

  try {
    return assertNormalizedUsageV2({
      schemaVersion: "normalized_usage_v2",
      inputTotalTokens,
      inputCacheReadTokens,
      // MiMo prices cache writes as limited-time free, but its Responses usage
      // does not report a distinct write bucket. Keep it unknown rather than 0.
      inputCacheWriteTokens: null,
      inputStandardTokens: inputTotalTokens - inputCacheReadTokens,
      outputTokens,
      reasoningTokens,
      cacheUsageReporting: "unavailable",
      usageComplete: true,
    });
  } catch {
    throw new MimoResponsesV1AdapterError(
      "UPSTREAM_ERROR",
      "MiMo response usage violates the normalized usage contract",
      { providerRequestId },
    );
  }
}

function assertRequestAndBuildBody(
  request: PolishInferenceRequestV2,
  modelId: string,
): Record<string, unknown> {
  if (request.schemaVersion !== "polish_inference_request_v2") {
    throw new MimoResponsesV1AdapterError(
      "UPSTREAM_ERROR",
      "MiMo request uses an unknown inference schema",
      { retryable: false },
    );
  }
  if (request.outputContract.kind !== "json_object") {
    throw new MimoResponsesV1AdapterError(
      "UPSTREAM_ERROR",
      "MiMo prompt-only adapter cannot preserve this output contract",
      { retryable: false },
    );
  }
  if (
    !Number.isSafeInteger(request.maxOutputTokens) ||
    request.maxOutputTokens < 1 ||
    request.maxOutputTokens > MIMO_RESPONSES_MAX_OUTPUT_TOKENS
  ) {
    throw new MimoResponsesV1AdapterError(
      "UPSTREAM_ERROR",
      "MiMo maxOutputTokens is outside the documented range",
      { retryable: false },
    );
  }

  const [stable, variable] = request.prompt.blocks;
  if (
    request.prompt.blocks.length !== 2 ||
    stable?.role !== "developer" ||
    stable.stability !== "stable" ||
    variable?.role !== "user" ||
    variable.stability !== "variable" ||
    stable.id.length === 0 ||
    variable.id.length === 0 ||
    stable.id === variable.id ||
    stable.content.length === 0 ||
    variable.content.length === 0 ||
    request.prompt.explicitCacheBoundaryAfter !== stable.id
  ) {
    throw new MimoResponsesV1AdapterError(
      "UPSTREAM_ERROR",
      "MiMo request does not use the canonical stable-prefix prompt",
      { retryable: false },
    );
  }

  return {
    model: modelId,
    // MiMo documents `instructions` and string `input`. The code-owned stable
    // instructions precede the variable user suffix, preserving auto-cache
    // prefix semantics without sending undocumented cache controls.
    instructions: stable.content,
    input: variable.content,
    max_output_tokens: request.maxOutputTokens,
    stream: false,
    reasoning: { effort: "none" },
  };
}

function extractOutputText(payload: Record<string, unknown>): {
  text: string;
  hasOutputText: boolean;
} {
  if (!Array.isArray(payload.output)) return { text: "", hasOutputText: false };

  const chunks: string[] = [];
  for (const item of payload.output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
  }
  return { text: chunks.join(""), hasOutputText: chunks.length > 0 };
}

function normalizeFinishReason(
  payload: Record<string, unknown>,
  hasOutputText: boolean,
): NormalizedFinishReason {
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

function throwTransportFailure(
  callerSignal: AbortSignal,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
): never {
  if (callerSignal.aborted) throw callerSignal.reason;
  if (timeoutSignal.aborted) {
    throw new MimoResponsesV1AdapterError(
      "UPSTREAM_TIMEOUT",
      `MiMo Responses exceeded its hard timeoutMs (${timeoutMs}ms)`,
    );
  }
  throw new MimoResponsesV1AdapterError(
    "UPSTREAM_ERROR",
    "MiMo Responses transport failed (raw error omitted)",
  );
}

export function createMimoResponsesV1Adapter(
  options: MimoResponsesV1AdapterOptions = {},
): MimoResponsesV1Adapter {
  const env = options.env ?? process.env;
  const profile = resolveProfile(MIMO_RESPONSES_V1_PROFILE_KEY);
  if (profile.adapterKind !== MIMO_RESPONSES_V1_ADAPTER_KIND) {
    throw new Error("MiMo profile is not bound to mimo_responses_v1");
  }
  const endpoint = resolveEndpoint(profile.endpointAlias).url;
  const apiKey = resolveCredentialSecret(profile.credentialAlias, env);
  const fetchImpl = options.fetch ?? fetch;

  return {
    kind: MIMO_RESPONSES_V1_ADAPTER_KIND,
    async complete(
      request: PolishInferenceRequestV2,
      { signal, timeoutMs }: { signal: AbortSignal; timeoutMs: number },
    ): Promise<PolishInferenceResultV2> {
      signal.throwIfAborted();
      const body = assertRequestAndBuildBody(request, profile.modelId);
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
            Accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: combinedSignal,
        });
      } catch {
        throwTransportFailure(signal, timeoutSignal, timeoutMs);
      }

      if (
        response.redirected ||
        (response.url.length > 0 && response.url !== endpoint)
      ) {
        throw new MimoResponsesV1AdapterError(
          "UPSTREAM_ERROR",
          "MiMo Responses returned an unexpected redirect",
          { retryable: false },
        );
      }

      if (!response.ok) {
        throw new MimoResponsesV1AdapterError(
          "UPSTREAM_ERROR",
          `MiMo Responses failed with HTTP ${response.status} (body omitted)`,
          {
            upstreamStatus: response.status,
            retryAfterMs: readRetryAfterMs(response),
          },
        );
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
      const observedModelId = safeRouteToken(payloadRecord?.model, 128);
      const actualModelId = observedModelId === profile.modelId ? observedModelId : undefined;
      const bodyHasError = payloadRecord?.error !== undefined && payloadRecord.error !== null;
      const extracted = payloadRecord
        ? extractOutputText(payloadRecord)
        : { text: "", hasOutputText: false };

      return {
        schemaVersion: "polish_inference_result_v2",
        text: bodyHasError ? "" : extracted.text,
        finishReason: bodyHasError
          ? "unknown"
          : normalizeFinishReason(payloadRecord ?? {}, extracted.hasOutputText),
        usage,
        route: {
          ...(providerRequestId ? { providerRequestId } : {}),
          actualUpstreamEndpoint: endpoint,
          ...(actualModelId ? { actualModelId } : {}),
        },
      };
    },
  };
}
