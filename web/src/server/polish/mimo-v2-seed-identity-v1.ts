/**
 * Accepted, dark-only CFG-002 identity facts for the first MiMo V2 profile.
 *
 * This module intentionally freezes only stable catalog identities and the
 * reviewed profile tuple. The price UUID is reserved for later CFG-002 work;
 * no price source, validity interval, component, or seed authorization is
 * represented here.
 */

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

const PROFILE_CONFIG = {
  reasoningEffort: "none",
  structuredOutput: "prompt_only",
  sendProviderSubjectId: false,
} as const;

export const MIMO_V2_SEED_IDENTITY_V1 = deepFreeze({
  schemaVersion: "mimo_v2_seed_identity_v1",
  profile: {
    id: "22222222-2222-4222-8222-222222222220",
    profileVersionId: "22222222-2222-4222-8222-222222222221",
    profileKey: "mimo.cn.mimo-v2.5-pro.responses.v1",
    displayName: "MiMo V2.5 Pro",
    gatewayKind: "direct_mimo",
    modelVendor: "xiaomi-mimo",
    version: 1,
    status: "draft",
    adapterKind: "mimo_responses_v1",
    wireApiKind: "responses_v1",
    credentialAlias: "mimo_api_key",
    endpointAlias: "mimo_cn_official",
    canonicalEndpointUrl: "https://api.xiaomimimo.com/v1/responses",
    modelId: "mimo-v2.5-pro",
    modelSnapshot: null,
    upstreamRoute: {},
    capabilityContractId: "mimo_responses_output_text_v1",
    cachePolicyId: "mimo_automatic_prompt_cache_v1",
    legalManifestId: "mimo-cn-2026-08-23-v1",
    routeDescriptorId: "route.mimo.cn.official.v1",
    displayDisclosureKey: "mimo-cn-v1",
    calculatorKind: "linear_token_v1",
    config: PROFILE_CONFIG,
    configJcsUtf8Hex:
      "7b22726561736f6e696e674566666f7274223a226e6f6e65222c2273656e6450726f76696465725375626a6563744964223a66616c73652c22737472756374757265644f7574707574223a2270726f6d70745f6f6e6c79227d",
    configSha256:
      "319316de510f767885fdb94d75d067a7383c11f513b908026a2ab4ec68c8a121",
  },
  runtime: {
    runtimeTargetId: "runtime-target.mimo.cn.mimo-v2.5-pro.responses.v1",
    runtimeContractId: "runtime.deepseek-v2-mimo-v2.5-pro.v2",
  },
  pricing: {
    reservedDefaultPriceVersionId: "22222222-2222-4222-8222-222222222222",
  },
});
