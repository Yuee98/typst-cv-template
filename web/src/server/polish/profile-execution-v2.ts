import { z } from "zod";
import {
  ADAPTER_KINDS, CALCULATOR_KINDS, ProviderRegistryError,
  resolveAdapter, resolveCapability, resolveCachePolicy, resolveCalculator, validateAdapterConfig,
} from "./adapter-registry";
import { validateProfileExecutionConfig, type ProfileExecutionConfigV1 } from "./profile-registry";

const codeId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,199}$/);
export const credentialEnvNameSchema = z.string().regex(/^AI_PROVIDER_KEY_[A-Z0-9_]{1,160}$/);

/** Shape and implemented semantics only. Admission still requires exact DB
 * legal/price/runtime target evidence and deployment destination approval. */
const shape = z.strictObject({
  schemaVersion: z.literal("profile_execution_config_v2"),
  profileKey: codeId,
  providerId: z.string().uuid(),
  gatewayKind: z.enum(["direct_deepseek", "direct_mimo"]),
  adapterKind: z.enum(ADAPTER_KINDS),
  wireApiKind: z.enum(["chat_completions_v1", "responses_v1"]),
  endpointUrl: z.string().min(10).max(512),
  credentialEnvName: credentialEnvNameSchema,
  modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/),
  capabilityContractId: codeId,
  cachePolicyId: codeId,
  legalManifestId: codeId,
  calculatorKind: z.enum(CALCULATOR_KINDS),
  displayDisclosureKey: codeId,
  config: z.unknown(),
});

// These are implementation capabilities, not the catalog of Provider models
// or mutable profile defaults. New semantics require a reviewed adapter.
const semantics = {
  deepseek_chat_v1: {
    gateway: "direct_deepseek", capability: "deepseek_chat_json_object_v1",
    cache: "deepseek_automatic_context_cache_v1", calculator: "linear_token_v1",
  },
  mimo_responses_v1: {
    gateway: "direct_mimo", capability: "mimo_responses_output_text_v1",
    cache: "mimo_automatic_prompt_cache_v1", calculator: "linear_token_v1",
  },
} as const;

export function validateProfileExecutionConfigV2(value: unknown) {
  const parsed = shape.safeParse(value);
  if (!parsed.success) throw new ProviderRegistryError("invalid v2 execution configuration");
  const profile = parsed.data;
  const adapter = resolveAdapter(profile.adapterKind);
  const supported = semantics[profile.adapterKind];
  if (adapter.wireApiKind !== profile.wireApiKind || supported.gateway !== profile.gatewayKind
    || supported.capability !== profile.capabilityContractId || supported.cache !== profile.cachePolicyId
    || supported.calculator !== profile.calculatorKind) {
    throw new ProviderRegistryError("unsupported v2 execution semantics");
  }
  resolveCapability(profile.capabilityContractId);
  resolveCachePolicy(profile.cachePolicyId);
  resolveCalculator(profile.calculatorKind);
  const config = validateAdapterConfig(profile.adapterKind, profile.config);
  return Object.freeze({ ...profile, config: Object.freeze(config) });
}
export type ProfileExecutionConfigV2 = ReturnType<typeof validateProfileExecutionConfigV2>;
export type ProfileExecutionConfig = ProfileExecutionConfigV1 | ProfileExecutionConfigV2;

export function validateVersionedProfileExecutionConfig(value: unknown): ProfileExecutionConfig {
  if (typeof value === "object" && value !== null && "schemaVersion" in value
    && value.schemaVersion === "profile_execution_config_v2") return validateProfileExecutionConfigV2(value);
  // The original validator still strictly rejects unknown/missing versions;
  // a malformed v2 value never retries through the v1 registry.
  return validateProfileExecutionConfig(value);
}
