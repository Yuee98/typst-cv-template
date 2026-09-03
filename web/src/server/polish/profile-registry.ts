import {
  ProviderRegistryError,
  resolveAdapter,
  resolveCachePolicy,
  resolveCalculator,
  resolveCapability,
  resolveCredential,
  resolveDisplayDisclosure,
  resolveEndpoint,
  resolveLegalManifest,
  validateAdapterConfig,
  type AdapterKind,
  type CalculatorKind,
  type CapabilityContractId,
  type CachePolicyId,
  type CredentialAlias,
  type DisplayDisclosureKey,
  type EndpointAlias,
  type GatewayKind,
  type LegalManifestId,
  type RegisteredAdapterConfig,
  type WireApiKind,
} from "./adapter-registry";

export const INITIAL_LEGAL_BUNDLE_VERSION = "2026-08-23-multi-provider-v1" as const;

export const PROFILE_KEYS = [
  "deepseek.official.deepseek-v4-flash.chat.v1",
  "mimo.cn.mimo-v2.5-pro.responses.v1",
] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];

export interface ProfileExecutionConfigV1 {
  schemaVersion: "profile_execution_config_v1";
  profileKey: ProfileKey;
  gatewayKind: GatewayKind;
  adapterKind: AdapterKind;
  wireApiKind: WireApiKind;
  credentialAlias: CredentialAlias;
  endpointAlias: EndpointAlias;
  modelId: string;
  capabilityContractId: CapabilityContractId;
  cachePolicyId: CachePolicyId;
  legalManifestId: LegalManifestId;
  calculatorKind: CalculatorKind;
  displayDisclosureKey: DisplayDisclosureKey;
  config: RegisteredAdapterConfig;
}

type ProfileRegistration = Omit<ProfileExecutionConfigV1, "schemaVersion">;

const PROFILE_REGISTRY: Record<ProfileKey, ProfileRegistration> = {
  "deepseek.official.deepseek-v4-flash.chat.v1": {
    profileKey: "deepseek.official.deepseek-v4-flash.chat.v1",
    gatewayKind: "direct_deepseek",
    adapterKind: "deepseek_chat_v1",
    wireApiKind: "chat_completions_v1",
    credentialAlias: "deepseek_api_key",
    endpointAlias: "deepseek_official",
    modelId: "deepseek-v4-flash",
    capabilityContractId: "deepseek_chat_json_object_v1",
    cachePolicyId: "deepseek_automatic_context_cache_v1",
    legalManifestId: "deepseek-official-2026-08-23-v1",
    calculatorKind: "linear_token_v1",
    displayDisclosureKey: "deepseek-official-v1",
    config: {
      thinking: "disabled",
      structuredOutput: "json_object",
      providerSubjectField: "user_id",
    },
  },
  "mimo.cn.mimo-v2.5-pro.responses.v1": {
    profileKey: "mimo.cn.mimo-v2.5-pro.responses.v1",
    gatewayKind: "direct_mimo",
    adapterKind: "mimo_responses_v1",
    wireApiKind: "responses_v1",
    credentialAlias: "mimo_api_key",
    endpointAlias: "mimo_cn_official",
    modelId: "mimo-v2.5-pro",
    capabilityContractId: "mimo_responses_output_text_v1",
    cachePolicyId: "mimo_automatic_prompt_cache_v1",
    legalManifestId: "mimo-cn-2026-08-23-v1",
    calculatorKind: "linear_token_v1",
    displayDisclosureKey: "mimo-cn-v1",
    config: {
      reasoningEffort: "none",
      structuredOutput: "prompt_only",
      sendProviderSubjectId: false,
    },
  },
};

const EXECUTION_KEYS = [
  "schemaVersion",
  "profileKey",
  "gatewayKind",
  "adapterKind",
  "wireApiKind",
  "credentialAlias",
  "endpointAlias",
  "modelId",
  "capabilityContractId",
  "cachePolicyId",
  "legalManifestId",
  "calculatorKind",
  "displayDisclosureKey",
  "config",
] as const;

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderRegistryError("profile execution config must be an object");
  }
}

function assertExactExecutionKeys(value: Record<string, unknown>): void {
  const expected = new Set<string>(EXECUTION_KEYS);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = EXECUTION_KEYS.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new ProviderRegistryError(
      `profile execution config keys mismatch (unknown: ${unknown.join(",") || "none"}; missing: ${missing.join(",") || "none"})`,
    );
  }
}

function assertRegisteredValue(
  actual: unknown,
  expected: unknown,
  field: keyof ProfileRegistration,
): void {
  if (actual !== expected) {
    throw new ProviderRegistryError(`${field} does not match the code-owned profile registration`);
  }
}

/**
 * Validate the DB execution projection against an immutable code registration.
 * Arbitrary URLs and environment-variable names are not part of this schema.
 */
export function validateProfileExecutionConfig(value: unknown): ProfileExecutionConfigV1 {
  assertRecord(value);
  assertExactExecutionKeys(value);
  if (value.schemaVersion !== "profile_execution_config_v1") {
    throw new ProviderRegistryError("unknown profile execution config schemaVersion");
  }
  if (typeof value.profileKey !== "string") {
    throw new ProviderRegistryError("profileKey must be a string");
  }
  const registration = PROFILE_REGISTRY[value.profileKey as ProfileKey];
  if (registration === undefined) {
    throw new ProviderRegistryError(`unknown profile key: ${value.profileKey}`);
  }

  for (const field of [
    "gatewayKind",
    "adapterKind",
    "wireApiKind",
    "credentialAlias",
    "endpointAlias",
    "modelId",
    "capabilityContractId",
    "cachePolicyId",
    "legalManifestId",
    "calculatorKind",
    "displayDisclosureKey",
  ] as const) {
    assertRegisteredValue(value[field], registration[field], field);
  }

  const adapter = resolveAdapter(registration.adapterKind);
  const endpoint = resolveEndpoint(registration.endpointAlias);
  resolveCredential(registration.credentialAlias);
  const capability = resolveCapability(registration.capabilityContractId);
  resolveCachePolicy(registration.cachePolicyId);
  resolveLegalManifest(registration.legalManifestId);
  resolveCalculator(registration.calculatorKind);
  resolveDisplayDisclosure(registration.displayDisclosureKey);
  if (
    adapter.wireApiKind !== registration.wireApiKind ||
    capability.wireApiKind !== registration.wireApiKind
  ) {
    throw new ProviderRegistryError("registered adapter/capability wire API mismatch");
  }
  if (new URL(endpoint.url).protocol !== "https:") {
    throw new ProviderRegistryError("profile endpoint must be HTTPS");
  }

  return {
    schemaVersion: "profile_execution_config_v1",
    ...registration,
    config: validateAdapterConfig(registration.adapterKind, value.config),
  };
}

export function resolveProfile(profileKey: string): ProfileExecutionConfigV1 {
  const registration = PROFILE_REGISTRY[profileKey as ProfileKey];
  if (registration === undefined) {
    throw new ProviderRegistryError(`unknown profile key: ${profileKey}`);
  }
  return validateProfileExecutionConfig({
    schemaVersion: "profile_execution_config_v1",
    ...registration,
  });
}

export function legalBundleContainsManifest(
  bundleVersion: string,
  manifestId: string,
): boolean {
  if (bundleVersion !== INITIAL_LEGAL_BUNDLE_VERSION) {
    return false;
  }
  return (
    manifestId === "deepseek-official-2026-08-23-v1" ||
    manifestId === "mimo-cn-2026-08-23-v1"
  );
}
