/**
 * Frozen CFG-003 routing-policy facts. These are deliberately literal: the
 * seed must not discover a current profile, price, runtime, or fallback.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const DEEPSEEK_PROFILE_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const DEEPSEEK_OFFPEAK_PRICE_VERSION_ID = "11111111-1111-4111-8111-111111111112";
const DEEPSEEK_PEAK_PRICE_VERSION_ID = "11111111-1111-4111-8111-111111111113";
const MIMO_PROFILE_VERSION_ID = "22222222-2222-4222-8222-222222222221";
const MIMO_DEFAULT_PRICE_VERSION_ID = "22222222-2222-4222-8222-222222222222";
const DAILY_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

const G4_RULES = {
  schemaVersion: "routing_rules_v1",
  defaultRoute: {
    profileVersionId: DEEPSEEK_PROFILE_VERSION_ID,
    priceVersionId: DEEPSEEK_OFFPEAK_PRICE_VERSION_ID,
  },
  windows: [
    {
      weekdays: DAILY_WEEKDAYS,
      startMinute: 540,
      endMinute: 720,
      route: {
        profileVersionId: MIMO_PROFILE_VERSION_ID,
        priceVersionId: MIMO_DEFAULT_PRICE_VERSION_ID,
      },
    },
    {
      weekdays: DAILY_WEEKDAYS,
      startMinute: 840,
      endMinute: 1080,
      route: {
        profileVersionId: MIMO_PROFILE_VERSION_ID,
        priceVersionId: MIMO_DEFAULT_PRICE_VERSION_ID,
      },
    },
  ],
} as const;

const ROLLBACK_RULES = {
  schemaVersion: "routing_rules_v1",
  defaultRoute: {
    profileVersionId: DEEPSEEK_PROFILE_VERSION_ID,
    priceVersionId: DEEPSEEK_OFFPEAK_PRICE_VERSION_ID,
  },
  windows: [
    {
      weekdays: DAILY_WEEKDAYS,
      startMinute: 540,
      endMinute: 720,
      route: {
        profileVersionId: DEEPSEEK_PROFILE_VERSION_ID,
        priceVersionId: DEEPSEEK_PEAK_PRICE_VERSION_ID,
      },
    },
    {
      weekdays: DAILY_WEEKDAYS,
      startMinute: 840,
      endMinute: 1080,
      route: {
        profileVersionId: DEEPSEEK_PROFILE_VERSION_ID,
        priceVersionId: DEEPSEEK_PEAK_PRICE_VERSION_ID,
      },
    },
  ],
} as const;

function policyJcsInput(
  policyKey: string,
  rules: typeof G4_RULES | typeof ROLLBACK_RULES,
  runtimeContractId: string,
  runtimeContractSha256: string,
) {
  return {
    schemaVersion: "routing_policy_config_v1",
    policyKey,
    version: 1,
    timezone: "Asia/Shanghai",
    rules,
    defaultProfileVersionId: DEEPSEEK_PROFILE_VERSION_ID,
    legalBundleVersion: "2026-08-23-multi-provider-v1",
    runtimeContractId,
    runtimeContractSha256,
  } as const;
}

export const G4_ROUTING_POLICY_SEED_V1 = deepFreeze({
  schemaVersion: "g4_routing_policy_seed_v1",
  legalBundleVersion: "2026-08-23-multi-provider-v1",
  policies: {
    g4: {
      id: "33333333-3333-4333-8333-333333333333",
      policyKey: "polish.deepseek-mimo.daily.g4.v1",
      version: 1,
      status: "draft",
      timezone: "Asia/Shanghai",
      rules: G4_RULES,
      defaultProfileVersionId: DEEPSEEK_PROFILE_VERSION_ID,
      runtimeContractId: "runtime.deepseek-v2-mimo-v2.5-pro.v2",
      runtimeContractSha256:
        "510fb411fdbbf2de5822e8becd508d7bb5da458392162f55244a5d3ab016721c",
      jcsInput: policyJcsInput(
        "polish.deepseek-mimo.daily.g4.v1",
        G4_RULES,
        "runtime.deepseek-v2-mimo-v2.5-pro.v2",
        "510fb411fdbbf2de5822e8becd508d7bb5da458392162f55244a5d3ab016721c",
      ),
      configSha256:
        "8c64daa9d7e9165417294e2d854b6ca77a2c7ba1db0611f15f9af7a67682bbe3",
    },
    rollback: {
      id: "33333333-3333-4333-8333-333333333334",
      policyKey: "polish.deepseek-only.daily.rollback.v1",
      version: 1,
      status: "draft",
      timezone: "Asia/Shanghai",
      rules: ROLLBACK_RULES,
      defaultProfileVersionId: DEEPSEEK_PROFILE_VERSION_ID,
      runtimeContractId: "runtime.deepseek-v2.v1",
      runtimeContractSha256:
        "229ee6ca2b1ff78c81fc5748f01a285ac5936c1f8f06961c6c339ca808752ca9",
      jcsInput: policyJcsInput(
        "polish.deepseek-only.daily.rollback.v1",
        ROLLBACK_RULES,
        "runtime.deepseek-v2.v1",
        "229ee6ca2b1ff78c81fc5748f01a285ac5936c1f8f06961c6c339ca808752ca9",
      ),
      configSha256:
        "4bd1a83446b0b19903f9c08aece54e2418cb3f880b49b63f30cbea6c7b4e40dd",
    },
  },
});
