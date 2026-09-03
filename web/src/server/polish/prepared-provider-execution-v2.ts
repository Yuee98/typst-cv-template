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
}

interface PreparedProviderExecutionFactsV2 {
  readonly provider: PolishInferenceProviderV2;
  readonly runtimeProvenance: Readonly<{
    runtimeBuildId: string;
    bindingManifestRevision: string;
  }>;
}

interface StoredPreparedProviderExecutionV2 {
  readonly prepared: PreparedProviderTransportV2;
  readonly provider: PolishInferenceProviderV2;
}

const preparedExecutions = new WeakMap<
  object,
  StoredPreparedProviderExecutionV2
>();

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
  const immutableProvider = Object.freeze(provider);
  const execution = Object.freeze({
    schemaVersion: "prepared_provider_execution_v2" as const,
  });
  preparedExecutions.set(
    execution,
    Object.freeze({ prepared, provider: immutableProvider }),
  );
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
  const stored = preparedExecutions.get(value);
  if (stored === undefined) throw new ProviderBindingError();
  assertPreparedProviderTransportV2(stored.prepared);
  const profile = validateProfileExecutionConfigV2(expectedProfile);
  if (!sameProfile(profile, stored.prepared.profile)) {
    throw new ProviderBindingError();
  }
  return Object.freeze({
    provider: stored.provider,
    runtimeProvenance: Object.freeze({
      runtimeBuildId: stored.prepared.runtimeBuildId,
      bindingManifestRevision: stored.prepared.bindingManifestRevision,
    }),
  });
}
