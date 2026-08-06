import {
  PolishOrchestrationError,
  type PolishOrchestrationFailureStage,
  type PolishOrchestrationProgress,
  type PolishProviderUsage,
} from "./orchestrator";
import type { PolishLedgerMetadata, PolishTokenUsage } from "./quota";

export function toLedgerFailureStage(
  stage: PolishOrchestrationFailureStage,
  code: PolishOrchestrationError["code"],
): NonNullable<PolishLedgerMetadata["failureStage"]> {
  if (stage === "transport") return code === "UPSTREAM_TIMEOUT" ? "provider_timeout" : "provider_http";
  if (stage === "json_parse") return "json_parse";
  if (stage === "schema_validation" || stage === "id_set_mismatch") return "schema_validation";
  return "semantic_validation";
}

export function isAbortError(error: unknown): boolean {
  const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === "AbortError" || name === "ResponseAborted";
}

export function toTokenUsage(usage: PolishProviderUsage, usageComplete: boolean): PolishTokenUsage {
  return {
    inputCachedTokens: usage.cachedReadTokens,
    inputUncachedTokens: usage.uncachedReadTokens,
    outputTokens: usage.completionTokens,
    usageComplete,
  };
}

export function hasBillableUsage(usage: PolishProviderUsage): boolean {
  return usage.promptTokens > 0 || usage.completionTokens > 0;
}

export function progressUsageComplete(progress: PolishOrchestrationProgress): boolean {
  return progress.usageComplete && !progress.providerCallInFlight && progress.enteredAttempts === progress.usageReturnedAttempts;
}

export function progressSettlement(progress: PolishOrchestrationProgress): { providerBillable: boolean | null; usage?: PolishTokenUsage } {
  const hasUsage = hasBillableUsage(progress.cumulativeUsage);
  return {
    providerBillable: hasUsage ? true : progress.enteredAttempts > 0 ? null : false,
    usage: hasUsage ? toTokenUsage(progress.cumulativeUsage, progressUsageComplete(progress)) : undefined,
  };
}
