import type {
  PolishProviderRequest,
  PolishProviderResult,
  PolishProviderUsage,
} from "./provider";

export type NormalizedFinishReason =
  | "stop"
  | "length"
  | "content_filter"
  | "insufficient_system_resource"
  | "unknown";

export type CacheUsageReporting = "reported" | "unavailable" | "not_applicable";

export interface NormalizedUsageV2 {
  schemaVersion: "normalized_usage_v2";
  inputTotalTokens: number;
  inputCacheReadTokens: number;
  inputCacheWriteTokens: number | null;
  inputStandardTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  cacheUsageReporting: CacheUsageReporting;
  usageComplete: boolean;
}

export type AttemptUsageObservationV1 =
  | { kind: "observed"; usage: NormalizedUsageV2 }
  | { kind: "unavailable"; usage: null; usageComplete: false };

export interface PolishInferenceRequestV2 {
  schemaVersion: "polish_inference_request_v2";
  prompt: {
    blocks: Array<{
      id: string;
      role: "developer" | "user";
      stability: "stable" | "variable";
      content: string;
    }>;
    explicitCacheBoundaryAfter?: string;
  };
  outputContract: {
    kind: "json_schema" | "json_object";
    schemaName: string;
    schema: unknown;
  };
  maxOutputTokens: number;
  providerSubjectId: string;
  promptVersion: string;
  validatorVersion: string;
  language: "zh" | "en";
  targets: ReadonlyArray<{ id: string; text: string }>;
}

export interface PolishInferenceResultV2 {
  schemaVersion: "polish_inference_result_v2";
  text: string;
  finishReason: NormalizedFinishReason;
  usage: NormalizedUsageV2;
  route: {
    gatewayRequestId?: string;
    providerRequestId?: string;
    actualUpstreamEndpoint?: string;
    actualModelId?: string;
    routerAttemptCount?: number;
  };
  providerReportedCost?: { currency: string; nanos: string };
}

export class InferenceV2ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferenceV2ContractError";
  }
}

function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InferenceV2ContractError(`${field} must be a non-negative safe integer`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new InferenceV2ContractError(`${field} must not be empty`);
  }
}

/** Validate usage without coercing unknown, fractional, negative, or unsafe values. */
export function assertNormalizedUsageV2(usage: NormalizedUsageV2): NormalizedUsageV2 {
  if (usage.schemaVersion !== "normalized_usage_v2") {
    throw new InferenceV2ContractError("unknown normalized usage schemaVersion");
  }

  assertNonNegativeSafeInteger(usage.inputTotalTokens, "inputTotalTokens");
  assertNonNegativeSafeInteger(usage.inputCacheReadTokens, "inputCacheReadTokens");
  assertNonNegativeSafeInteger(usage.inputStandardTokens, "inputStandardTokens");
  assertNonNegativeSafeInteger(usage.outputTokens, "outputTokens");

  if (usage.inputCacheWriteTokens !== null) {
    assertNonNegativeSafeInteger(usage.inputCacheWriteTokens, "inputCacheWriteTokens");
  }
  if (usage.reasoningTokens !== null) {
    assertNonNegativeSafeInteger(usage.reasoningTokens, "reasoningTokens");
    if (usage.reasoningTokens > usage.outputTokens) {
      throw new InferenceV2ContractError("reasoningTokens must not exceed outputTokens");
    }
  }
  if (typeof usage.usageComplete !== "boolean") {
    throw new InferenceV2ContractError("usageComplete must be boolean");
  }

  switch (usage.cacheUsageReporting) {
    case "reported": {
      if (usage.inputCacheWriteTokens === null) {
        throw new InferenceV2ContractError(
          "reported cache usage requires inputCacheWriteTokens",
        );
      }
      const explained =
        usage.inputCacheReadTokens +
        usage.inputCacheWriteTokens +
        usage.inputStandardTokens;
      if (usage.inputTotalTokens !== explained) {
        throw new InferenceV2ContractError("reported cache usage violates input conservation");
      }
      break;
    }
    case "unavailable": {
      if (usage.inputCacheWriteTokens !== null) {
        throw new InferenceV2ContractError(
          "unavailable cache-write reporting must use null, not a numeric value",
        );
      }
      if (
        usage.inputTotalTokens !==
        usage.inputCacheReadTokens + usage.inputStandardTokens
      ) {
        throw new InferenceV2ContractError("unavailable cache usage violates input conservation");
      }
      break;
    }
    case "not_applicable":
      if (usage.inputCacheReadTokens !== 0 || usage.inputCacheWriteTokens !== 0) {
        throw new InferenceV2ContractError(
          "not_applicable cache usage requires zero read and write buckets",
        );
      }
      if (usage.inputTotalTokens !== usage.inputStandardTokens) {
        throw new InferenceV2ContractError("not_applicable cache usage violates input conservation");
      }
      break;
    default:
      throw new InferenceV2ContractError("unknown cacheUsageReporting value");
  }

  return usage;
}

export function observedUsage(usage: NormalizedUsageV2): AttemptUsageObservationV1 {
  return { kind: "observed", usage: assertNormalizedUsageV2(usage) };
}

export function unavailableUsage(): AttemptUsageObservationV1 {
  return { kind: "unavailable", usage: null, usageComplete: false };
}

/**
 * Convert the legacy three-bucket input split to V2. Legacy data has no
 * cache-write observation, so that field remains explicitly unknown.
 */
export function toNormalizedUsageV2(usage: PolishProviderUsage): NormalizedUsageV2 {
  assertNonNegativeSafeInteger(usage.promptTokens, "promptTokens");
  assertNonNegativeSafeInteger(usage.completionTokens, "completionTokens");
  assertNonNegativeSafeInteger(usage.cachedReadTokens, "cachedReadTokens");
  assertNonNegativeSafeInteger(usage.uncachedReadTokens, "uncachedReadTokens");
  if (usage.promptTokens !== usage.cachedReadTokens + usage.uncachedReadTokens) {
    throw new InferenceV2ContractError("legacy usage violates input conservation");
  }

  return assertNormalizedUsageV2({
    schemaVersion: "normalized_usage_v2",
    inputTotalTokens: usage.promptTokens,
    inputCacheReadTokens: usage.cachedReadTokens,
    inputCacheWriteTokens: null,
    inputStandardTokens: usage.uncachedReadTokens,
    outputTokens: usage.completionTokens,
    reasoningTokens: null,
    cacheUsageReporting: "unavailable",
    usageComplete: true,
  });
}

/** Convert only V2 observations whose semantics the legacy shape can retain. */
export function toLegacyProviderUsage(usage: NormalizedUsageV2): PolishProviderUsage {
  assertNormalizedUsageV2(usage);
  if (
    usage.cacheUsageReporting !== "unavailable" ||
    usage.inputCacheWriteTokens !== null ||
    usage.reasoningTokens !== null ||
    !usage.usageComplete
  ) {
    throw new InferenceV2ContractError("V2 usage is not representable by the legacy contract");
  }
  return {
    promptTokens: usage.inputTotalTokens,
    completionTokens: usage.outputTokens,
    cachedReadTokens: usage.inputCacheReadTokens,
    uncachedReadTokens: usage.inputStandardTokens,
  };
}

export interface LegacyRequestV2Metadata {
  outputContract: PolishInferenceRequestV2["outputContract"];
  promptVersion: string;
  validatorVersion: string;
  language: "zh" | "en";
}

export function toInferenceRequestV2(
  request: PolishProviderRequest,
  metadata: LegacyRequestV2Metadata,
): PolishInferenceRequestV2 {
  assertNonNegativeSafeInteger(request.maxOutputTokens, "maxOutputTokens");
  assertNonEmpty(request.providerUserId, "providerUserId");
  assertNonEmpty(metadata.outputContract.schemaName, "outputContract.schemaName");
  assertNonEmpty(metadata.promptVersion, "promptVersion");
  assertNonEmpty(metadata.validatorVersion, "validatorVersion");

  const blocks = request.messages.map((message, index) => ({
    id: `legacy-message-${index + 1}`,
    role: message.role === "system" ? ("developer" as const) : ("user" as const),
    stability: message.role === "system" ? ("stable" as const) : ("variable" as const),
    content: message.content,
  }));
  const lastStable = blocks.findLast((block) => block.stability === "stable");

  return {
    schemaVersion: "polish_inference_request_v2",
    prompt: {
      blocks,
      ...(lastStable ? { explicitCacheBoundaryAfter: lastStable.id } : {}),
    },
    outputContract: metadata.outputContract,
    maxOutputTokens: request.maxOutputTokens,
    providerSubjectId: request.providerUserId,
    promptVersion: metadata.promptVersion,
    validatorVersion: metadata.validatorVersion,
    language: metadata.language,
    targets: request.targets,
  };
}

/** Adapt a V2 request only when the legacy Chat boundary can preserve it. */
export function toLegacyProviderRequest(request: PolishInferenceRequestV2): PolishProviderRequest {
  if (request.schemaVersion !== "polish_inference_request_v2") {
    throw new InferenceV2ContractError("unknown inference request schemaVersion");
  }
  assertNonNegativeSafeInteger(request.maxOutputTokens, "maxOutputTokens");
  assertNonEmpty(request.providerSubjectId, "providerSubjectId");
  if (request.outputContract.kind !== "json_object") {
    throw new InferenceV2ContractError("legacy provider cannot preserve json_schema output contract");
  }

  for (const block of request.prompt.blocks) {
    assertNonEmpty(block.id, "prompt block id");
    if (
      (block.role === "developer" && block.stability !== "stable") ||
      (block.role === "user" && block.stability !== "variable")
    ) {
      throw new InferenceV2ContractError(
        "legacy provider cannot preserve this role/stability combination",
      );
    }
  }
  const ids = new Set(request.prompt.blocks.map((block) => block.id));
  if (ids.size !== request.prompt.blocks.length) {
    throw new InferenceV2ContractError("prompt block ids must be unique");
  }
  if (
    request.prompt.explicitCacheBoundaryAfter !== undefined &&
    !ids.has(request.prompt.explicitCacheBoundaryAfter)
  ) {
    throw new InferenceV2ContractError("explicit cache boundary must reference a prompt block");
  }

  return {
    messages: request.prompt.blocks.map((block) => ({
      role: block.role === "developer" ? ("system" as const) : ("user" as const),
      content: block.content,
    })),
    maxOutputTokens: request.maxOutputTokens,
    providerUserId: request.providerSubjectId,
    targets: request.targets,
  };
}

export function toInferenceResultV2(result: PolishProviderResult): PolishInferenceResultV2 {
  return {
    schemaVersion: "polish_inference_result_v2",
    text: result.text,
    finishReason: result.finishReason,
    usage: toNormalizedUsageV2(result.usage),
    route: result.providerRequestId ? { providerRequestId: result.providerRequestId } : {},
  };
}

/** Convert only results that do not carry V2-only route or cost facts. */
export function toLegacyProviderResult(result: PolishInferenceResultV2): PolishProviderResult {
  if (result.schemaVersion !== "polish_inference_result_v2") {
    throw new InferenceV2ContractError("unknown inference result schemaVersion");
  }
  if (
    result.providerReportedCost !== undefined ||
    result.route.gatewayRequestId !== undefined ||
    result.route.actualUpstreamEndpoint !== undefined ||
    result.route.actualModelId !== undefined ||
    result.route.routerAttemptCount !== undefined
  ) {
    throw new InferenceV2ContractError("V2 result is not representable by the legacy contract");
  }
  return {
    text: result.text,
    finishReason: result.finishReason,
    usage: toLegacyProviderUsage(result.usage),
    ...(result.route.providerRequestId
      ? { providerRequestId: result.route.providerRequestId }
      : {}),
  };
}
