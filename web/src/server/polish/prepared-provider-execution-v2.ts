import "server-only";

import {
  createPreparedDeepSeekChatAdapter,
} from "./deepseek";
import {
  createPreparedMimoResponsesAdapter,
} from "./mimo";
import type { PolishInferenceProviderV2 } from "./orchestrator";
import {
  assertPreparedProviderTransportV2,
  ProviderBindingError,
  type PreparedProviderTransportV2,
} from "./provider-binding-v2";
import {
  validateProfileExecutionConfigV2,
  type ProfileExecutionConfigV2,
} from "./profile-execution-v2";

export interface PreparedProviderExecutionV2 {
  readonly schemaVersion: "prepared_provider_execution_v2";
  readonly provider: PolishInferenceProviderV2;
}

interface PreparedProviderExecutionFactsV2 {
  readonly provider: PolishInferenceProviderV2;
  readonly runtimeProvenance: Readonly<{
    runtimeBuildId: string;
    bindingManifestRevision: string;
  }>;
}

const preparedExecutions = new WeakMap<object, PreparedProviderTransportV2>();

function sameProfile(
  expected: Readonly<ProfileExecutionConfigV2>,
  actual: Readonly<ProfileExecutionConfigV2>,
): boolean {
  return JSON.stringify(expected) === JSON.stringify(actual);
}

/**
 * Create the only lifecycle-admissible V2 provider value. The provider and
 * provenance are both derived from one branded prepared transport; callers
 * cannot supply either provenance field independently.
 */
export function createPreparedProviderExecutionV2(
  prepared: PreparedProviderTransportV2,
  fetchImpl?: typeof fetch,
): PreparedProviderExecutionV2 {
  assertPreparedProviderTransportV2(prepared);
  const provider = (() => {
    switch (prepared.profile.adapterKind) {
      case "deepseek_chat_v1":
        return createPreparedDeepSeekChatAdapter(prepared, fetchImpl);
      case "mimo_responses_v1":
        return createPreparedMimoResponsesAdapter(prepared, fetchImpl);
    }
  })();
  const execution = Object.freeze({
    schemaVersion: "prepared_provider_execution_v2" as const,
    provider,
  });
  preparedExecutions.set(execution, prepared);
  return execution;
}

export function isPreparedProviderExecutionV2(
  value: unknown,
): value is PreparedProviderExecutionV2 {
  return (
    typeof value === "object" &&
    value !== null &&
    preparedExecutions.has(value)
  );
}

/** Read facts only after checking the opaque object against the DB snapshot. */
export function readPreparedProviderExecutionV2(
  value: unknown,
  expectedProfile: Readonly<ProfileExecutionConfigV2>,
): PreparedProviderExecutionFactsV2 {
  if (!isPreparedProviderExecutionV2(value)) throw new ProviderBindingError();
  const prepared = preparedExecutions.get(value);
  if (prepared === undefined) throw new ProviderBindingError();
  assertPreparedProviderTransportV2(prepared);
  const profile = validateProfileExecutionConfigV2(expectedProfile);
  if (!sameProfile(profile, prepared.profile)) {
    throw new ProviderBindingError();
  }
  return Object.freeze({
    provider: value.provider,
    runtimeProvenance: Object.freeze({
      runtimeBuildId: prepared.runtimeBuildId,
      bindingManifestRevision: prepared.bindingManifestRevision,
    }),
  });
}
