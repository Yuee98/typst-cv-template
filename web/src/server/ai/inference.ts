export type NormalizedFinishReason = "stop" | "length" | "content_filter" | "insufficient_system_resource" | "unknown";
export type CacheUsageReporting = "reported" | "unavailable" | "not_applicable";
export interface NormalizedUsage {
  schemaVersion: "normalized_usage";
  inputTotalTokens: number;
  inputCacheReadTokens: number;
  inputCacheWriteTokens: number | null;
  inputStandardTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  cacheUsageReporting: CacheUsageReporting;
  usageComplete: boolean;
}
export interface PolishInferenceRequest {
  schemaVersion: "polish_inference_request";
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
  targets: ReadonlyArray<{
    id: string;
    text: string;
  }>;
}
export interface PolishInferenceResult {
  schemaVersion: "polish_inference_result";
  text: string;
  finishReason: NormalizedFinishReason;
  usage: NormalizedUsage;
  route: {
    gatewayRequestId?: string;
    providerRequestId?: string;
    actualUpstreamEndpoint?: string;
    actualModelId?: string;
  };
}
export class InferenceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferenceContractError";
  }
}
function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InferenceContractError(`${field} must be a non-negative safe integer`);
  }
}
/** Validate usage without coercing unknown, fractional, negative, or unsafe values. */
export function assertNormalizedUsage(usage: NormalizedUsage): NormalizedUsage {
  if (usage.schemaVersion !== "normalized_usage") {
    throw new InferenceContractError("unknown normalized usage schemaVersion");
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
      throw new InferenceContractError("reasoningTokens must not exceed outputTokens");
    }
  }
  if (typeof usage.usageComplete !== "boolean") {
    throw new InferenceContractError("usageComplete must be boolean");
  }
  switch (usage.cacheUsageReporting) {
    case "reported":
      {
        if (usage.inputCacheWriteTokens === null) {
          throw new InferenceContractError("reported cache usage requires inputCacheWriteTokens");
        }
        const explained = usage.inputCacheReadTokens + usage.inputCacheWriteTokens + usage.inputStandardTokens;
        if (usage.inputTotalTokens !== explained) {
          throw new InferenceContractError("reported cache usage violates input conservation");
        }
        break;
      }
    case "unavailable":
      {
        if (usage.inputCacheWriteTokens !== null) {
          throw new InferenceContractError("unavailable cache-write reporting must use null, not a numeric value");
        }
        if (usage.inputTotalTokens !== usage.inputCacheReadTokens + usage.inputStandardTokens) {
          throw new InferenceContractError("unavailable cache usage violates input conservation");
        }
        break;
      }
    case "not_applicable":
      if (usage.inputCacheReadTokens !== 0 || usage.inputCacheWriteTokens !== 0) {
        throw new InferenceContractError("not_applicable cache usage requires zero read and write buckets");
      }
      if (usage.inputTotalTokens !== usage.inputStandardTokens) {
        throw new InferenceContractError("not_applicable cache usage violates input conservation");
      }
      break;
    default:
      throw new InferenceContractError("unknown cacheUsageReporting value");
  }
  return usage;
}
