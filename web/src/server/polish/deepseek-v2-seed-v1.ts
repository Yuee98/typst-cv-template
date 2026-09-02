/**
 * Reviewed, dark-only CFG-001 seed facts for the first DeepSeek V2 profile.
 *
 * This module deliberately contains literals instead of deriving catalog rows
 * from a mutable registry or from a "latest" lookup. The companion tests bind
 * these facts back to the code-owned registries and independently reproduce the
 * frozen RFC 8785 vectors before the SQL migration may consume them.
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
  thinking: "disabled",
  structuredOutput: "json_object",
  providerSubjectField: "user_id",
} as const;

const G2_DEEPSEEK_ONLY_RULES = {
  schemaVersion: "routing_rules_v1",
  defaultRoute: {
    profileVersionId: "11111111-1111-4111-8111-111111111111",
    priceVersionId: "11111111-1111-4111-8111-111111111112",
  },
  windows: [
    {
      weekdays: [1, 2, 3, 4, 5],
      startMinute: 540,
      endMinute: 720,
      route: {
        profileVersionId: "11111111-1111-4111-8111-111111111111",
        priceVersionId: "11111111-1111-4111-8111-111111111113",
      },
    },
    {
      weekdays: [1, 2, 3, 4, 5],
      startMinute: 840,
      endMinute: 1080,
      route: {
        profileVersionId: "11111111-1111-4111-8111-111111111111",
        priceVersionId: "11111111-1111-4111-8111-111111111113",
      },
    },
  ],
} as const;

const POLICY_JCS_INPUT = {
  schemaVersion: "routing_policy_config_v1",
  policyKey: "polish.deepseek-only.g2.v1",
  version: 1,
  timezone: "Asia/Shanghai",
  rules: G2_DEEPSEEK_ONLY_RULES,
  defaultProfileVersionId: "11111111-1111-4111-8111-111111111111",
  legalBundleVersion: "2026-08-23-multi-provider-v1",
  runtimeContractId: "runtime.deepseek-v2.v1",
} as const;

export const DEEPSEEK_V2_SEED_V1 = deepFreeze({
  schemaVersion: "deepseek_v2_seed_v1",
  legalBundle: {
    version: "2026-08-23-multi-provider-v1",
    contractSha256:
      "fc26d1e1a016fda055fbe6a0b79b48d804fd7610e03bd5aa29389be37359ca18",
  },
  profile: {
    id: "11111111-1111-4111-8111-111111111110",
    profileVersionId: "11111111-1111-4111-8111-111111111111",
    profileKey: "deepseek.official.deepseek-v4-flash.chat.v1",
    displayName: "DeepSeek V4 Flash",
    gatewayKind: "direct_deepseek",
    modelVendor: "deepseek",
    version: 1,
    status: "draft",
    adapterKind: "deepseek_chat_v1",
    wireApiKind: "chat_completions_v1",
    credentialAlias: "deepseek_api_key",
    endpointAlias: "deepseek_official",
    canonicalEndpointUrl: "https://api.deepseek.com/chat/completions",
    modelId: "deepseek-v4-flash",
    modelSnapshot: "DeepSeek-V4-Flash-0731",
    upstreamRoute: {},
    capabilityContractId: "deepseek_chat_json_object_v1",
    cachePolicyId: "deepseek_automatic_context_cache_v1",
    legalManifestId: "deepseek-official-2026-08-23-v1",
    routeDescriptorId: "route.deepseek.official.v1",
    displayDisclosureKey: "deepseek-official-v1",
    calculatorKind: "linear_token_v1",
    config: PROFILE_CONFIG,
    configJcsUtf8Hex:
      "7b2270726f76696465725375626a6563744669656c64223a22757365725f6964222c22737472756374757265644f7574707574223a226a736f6e5f6f626a656374222c227468696e6b696e67223a2264697361626c6564227d",
    configSha256:
      "a79bbbaa5934d7f4890b2e97e13e7768f031e99625fe11446ba437feeffc8fa9",
  },
  pricing: {
    sourceUrl: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
    sourceCheckedAt: "2026-08-28T08:05:41.804Z",
    sourceSnapshotSha256:
      "899affbdbc33d0be620d8dea59e86f5036c11b5410b14d060b8d2874c74f38e5",
    rows: [
      {
        id: "11111111-1111-4111-8111-111111111112",
        pricingLane: "offpeak",
        version: 1,
        currency: "CNY",
        calculatorKind: "linear_token_v1",
        validFrom: "2026-08-25T06:45:15.787Z",
        validTo: null,
        providerEffectiveFrom: "2026-08-16T16:00:00.000Z",
        providerEffectiveTo: null,
        parameters: {},
        componentsSealedAt: null,
        components: [
          { component: "input_cache_read", nanosPerMillion: 50_000_000 },
          { component: "input_standard", nanosPerMillion: 1_500_000_000 },
          { component: "output", nanosPerMillion: 4_500_000_000 },
        ],
      },
      {
        id: "11111111-1111-4111-8111-111111111113",
        pricingLane: "peak",
        version: 1,
        currency: "CNY",
        calculatorKind: "linear_token_v1",
        validFrom: "2026-08-25T06:45:15.787Z",
        validTo: null,
        providerEffectiveFrom: "2026-08-16T16:00:00.000Z",
        providerEffectiveTo: null,
        parameters: {},
        componentsSealedAt: null,
        components: [
          { component: "input_cache_read", nanosPerMillion: 100_000_000 },
          { component: "input_standard", nanosPerMillion: 3_000_000_000 },
          { component: "output", nanosPerMillion: 9_000_000_000 },
        ],
      },
    ],
  },
  runtime: {
    schemaVersion: "service_runtime_contract_db_fixture_v1",
    contract: {
      runtimeContractId: "runtime.deepseek-v2.v1",
      legalBundleVersion: "2026-08-23-multi-provider-v1",
      bundleContractSha256:
        "fc26d1e1a016fda055fbe6a0b79b48d804fd7610e03bd5aa29389be37359ca18",
      runtimeTargetSetSha256:
        "5b7f5f2cd9d21c3c7409f02d7b65eda03999309c0ba3939e50fb81caca2c9340",
    },
    targets: [
      {
        runtimeTargetId:
          "runtime-target.deepseek.official.deepseek-v4-flash.chat.v1",
        runtimeTargetSha256:
          "aa4948f6f0060a08ada1d0b831babd17c37287be02a9a8f2f9ec69c0f2bed119",
        profileVersionId: "11111111-1111-4111-8111-111111111111",
        profileKey: "deepseek.official.deepseek-v4-flash.chat.v1",
        legalManifestId: "deepseek-official-2026-08-23-v1",
        manifestSha256:
          "0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b",
        routeDescriptorId: "route.deepseek.official.v1",
        routeDescriptorSha256:
          "ddd46ac3d94fa9a3d4293f5f59faa52ee93a418927d13a01798f0802ccc99d79",
      },
    ],
  },
  policy: {
    id: "33333333-3333-4333-8333-333333333332",
    policyKey: "polish.deepseek-only.g2.v1",
    version: 1,
    status: "draft",
    timezone: "Asia/Shanghai",
    rules: G2_DEEPSEEK_ONLY_RULES,
    defaultProfileVersionId: "11111111-1111-4111-8111-111111111111",
    legalBundleVersion: "2026-08-23-multi-provider-v1",
    runtimeContractId: "runtime.deepseek-v2.v1",
    jcsInput: POLICY_JCS_INPUT,
    jcsUtf8Hex:
      "7b2264656661756c7450726f66696c6556657273696f6e4964223a2231313131313131312d313131312d343131312d383131312d313131313131313131313131222c226c6567616c42756e646c6556657273696f6e223a22323032362d30382d32332d6d756c74692d70726f76696465722d7631222c22706f6c6963794b6579223a22706f6c6973682e646565707365656b2d6f6e6c792e67322e7631222c2272756c6573223a7b2264656661756c74526f757465223a7b22707269636556657273696f6e4964223a2231313131313131312d313131312d343131312d383131312d313131313131313131313132222c2270726f66696c6556657273696f6e4964223a2231313131313131312d313131312d343131312d383131312d313131313131313131313131227d2c22736368656d6156657273696f6e223a22726f7574696e675f72756c65735f7631222c2277696e646f7773223a5b7b22656e644d696e757465223a3732302c22726f757465223a7b22707269636556657273696f6e4964223a2231313131313131312d313131312d343131312d383131312d313131313131313131313133222c2270726f66696c6556657273696f6e4964223a2231313131313131312d313131312d343131312d383131312d313131313131313131313131227d2c2273746172744d696e757465223a3534302c227765656b64617973223a5b312c322c332c342c355d7d2c7b22656e644d696e757465223a313038302c22726f757465223a7b22707269636556657273696f6e4964223a2231313131313131312d313131312d343131312d383131312d313131313131313131313133222c2270726f66696c6556657273696f6e4964223a2231313131313131312d313131312d343131312d383131312d313131313131313131313131227d2c2273746172744d696e757465223a3834302c227765656b64617973223a5b312c322c332c342c355d7d5d7d2c2272756e74696d65436f6e74726163744964223a2272756e74696d652e646565707365656b2d76322e7631222c22736368656d6156657273696f6e223a22726f7574696e675f706f6c6963795f636f6e6669675f7631222c2274696d657a6f6e65223a22417369612f5368616e67686169222c2276657273696f6e223a317d",
    configSha256:
      "40c9be17c5ad25e60640adc537526d2e6bf9e38424a344967ba6e5b2ceaf9cc4",
  },
});
