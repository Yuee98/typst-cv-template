import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import routingRulesFixture from "../fixtures/routing-rules-v1.json";
import { createServiceClient, RUN_DB_TESTS } from "./helpers";
import {
  authorSyntheticRuntimeContract,
  authorSyntheticRuntimeContractSet,
  DEEPSEEK_LEGAL_MANIFEST_ID,
  DEEPSEEK_LEGAL_MANIFEST_SHA256,
  INITIAL_LEGAL_BUNDLE_VERSION,
  MIMO_LEGAL_MANIFEST_ID,
  MIMO_LEGAL_MANIFEST_SHA256,
  readLifecycleEvidenceRoot,
  runOwnerSql,
  sealPriceAsDatabaseOwner,
  transitionPolicyAsDatabaseOwner,
  type SyntheticRuntimeContractSet,
} from "./runtime-contract-fixtures";

const PERMISSION_DENIED = "42501";

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNullableLiteral(value: string | null): string {
  return value === null ? "null" : sqlLiteral(value);
}

function sqlJson(value: unknown): string {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

interface RuntimeContractPair {
  runtimeContractId: string;
  runtimeContractSha256: string;
}

interface RouteFixture {
  profileId: string;
  profileKey: string;
  profileVersionId: string;
  priceVersionId: string;
  runtime: RuntimeContractPair;
}

interface SharedRoutingFixtureGraph {
  deepseek: {
    profileId: string;
    profileKey: string;
    profileVersionId: string;
    offpeakPriceVersionId: string;
    peakPriceVersionId: string;
  };
  mimo: {
    profileId: string;
    profileKey: string;
    profileVersionId: string;
    defaultPriceVersionId: string;
  };
  runtime: SyntheticRuntimeContractSet;
  exactIdMap: ReadonlyMap<string, string>;
}

function mapFixtureRouteIds(
  value: unknown,
  exactIdMap: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") {
    return exactIdMap.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => mapFixtureRouteIds(entry, exactIdMap));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        mapFixtureRouteIds(entry, exactIdMap),
      ]),
    );
  }
  return value;
}

describe.skipIf(!RUN_DB_TESTS)("routing runtime validator (real DB)", () => {
  let service: SupabaseClient;
  let activePolicyId: string | null = null;

  beforeAll(() => {
    service = createServiceClient();
  });

  afterAll(() => {
    if (activePolicyId === null) {
      return;
    }
    const cleanup = runOwnerSql(String.raw`
      update public.ai_feature_config
      set active_routing_policy_version_id = null,
          routing_updated_by = 'runtime-validator-cleanup',
          routing_change_reason = ${sqlLiteral(`runtime validator cleanup ${crypto.randomUUID()}`)}
      where id = true
        and active_routing_policy_version_id = '${activePolicyId}'::uuid;
    `);
    expect(cleanup.status).toBe(0);
  });

  function lifecycleEvidence(
    runtime: RuntimeContractPair,
    reason: string,
    priceVersionIds: readonly string[],
  ): Record<string, string> {
    const root = readLifecycleEvidenceRoot({
      runtimeContractId: runtime.runtimeContractId,
      runtimeContractSha256: runtime.runtimeContractSha256,
      priceVersionIds,
    });
    return {
      p_runtime_contract_id: runtime.runtimeContractId,
      p_runtime_contract_sha256: runtime.runtimeContractSha256,
      p_actor: "routing-runtime-validator",
      p_reason: reason,
      p_reviewed_source_commit_oid: root.reviewedSourceCommitOid,
      p_reviewed_source_sha256: runtime.runtimeContractSha256,
      p_rechecked_at: root.recheckedAt,
      p_rechecked_sha256: runtime.runtimeContractSha256,
    };
  }

  async function createRouteFixture(options: {
    label: string;
    displayDisclosureKey?: string | null;
    legalManifestId?: string;
    validFrom?: string;
    includeCacheWrite?: boolean;
  }): Promise<RouteFixture> {
    const suffix = crypto.randomUUID();
    const profileKey = `test.validator.${options.label}.${suffix}`;
    const profileId = crypto.randomUUID();
    const profileVersionId = crypto.randomUUID();
    const priceVersionId = crypto.randomUUID();
    const displayDisclosureKey =
      options.displayDisclosureKey === undefined
        ? "deepseek.official"
        : options.displayDisclosureKey;
    const validFrom =
      options.validFrom ?? new Date(Date.now() - 3_600_000).toISOString();
    const sourceCheckedAt = new Date().toISOString();

    const components = [
      "input_standard",
      "input_cache_read",
      "output",
      ...(options.includeCacheWrite ? ["input_cache_write"] : []),
    ].map((component) => ({
      price_version_id: priceVersionId,
      component,
      nanos_per_million: 1,
    }));
    const authored = runOwnerSql(String.raw`
      begin;
      insert into public.ai_provider_profiles (
        id, profile_key, display_name, gateway_kind, model_vendor
      ) values (
        '${profileId}'::uuid,
        ${sqlLiteral(profileKey)},
        ${sqlLiteral(`Validator ${options.label}`)},
        'direct_deepseek',
        'deepseek'
      );
      insert into public.ai_provider_profile_versions (
        id, profile_id, version, adapter_kind, wire_api_kind,
        credential_alias, endpoint_alias, model_id, upstream_route,
        capability_contract_id, cache_policy_id, legal_manifest_id,
        display_disclosure_key, config, config_sha256
      ) values (
        '${profileVersionId}'::uuid,
        '${profileId}'::uuid,
        1,
        'deepseek_chat_v1',
        'chat_completions_v1',
        'deepseek_api_key',
        'deepseek_official',
        'deepseek-v4-flash',
        '{}'::jsonb,
        'polish_v2',
        'automatic_cache_v1',
        ${sqlLiteral(options.legalManifestId ?? DEEPSEEK_LEGAL_MANIFEST_ID)},
        ${sqlNullableLiteral(displayDisclosureKey)},
        '{}'::jsonb,
        '${"1".repeat(64)}'
      );
      insert into public.ai_price_versions (
        id, profile_version_id, version, pricing_lane, currency,
        calculator_kind, valid_from, source_url, source_checked_at,
        source_snapshot_sha256, parameters
      ) values (
        '${priceVersionId}'::uuid,
        '${profileVersionId}'::uuid,
        1,
        'default',
        'CNY',
        'linear_token_v1',
        ${sqlLiteral(validFrom)}::timestamptz,
        'https://example.com/validator-price',
        ${sqlLiteral(sourceCheckedAt)}::timestamptz,
        '${"2".repeat(64)}',
        '{}'::jsonb
      );
      insert into public.ai_price_components (
        price_version_id, component, nanos_per_million
      ) values
        ${components
          .map(
            ({ component, nanos_per_million: nanosPerMillion }) =>
              `('${priceVersionId}'::uuid, ${sqlLiteral(component)}, ${nanosPerMillion})`,
          )
          .join(",\n        ")};
      commit;
    `);
    expect(authored.status).toBe(0);

    const runtime = authorSyntheticRuntimeContract({
      profileKey,
      legalManifestId: DEEPSEEK_LEGAL_MANIFEST_ID,
    });

    return {
      profileId,
      profileKey,
      profileVersionId,
      priceVersionId,
      runtime,
    };
  }

  async function createSharedProfileVersion(input: {
    profileKey: string;
    displayName: string;
    gatewayKind: "direct_deepseek" | "direct_mimo";
    modelVendor: string;
    adapterKind: string;
    wireApiKind: "chat_completions_v1" | "responses_v1";
    credentialAlias: string;
    endpointAlias: string;
    modelId: string;
    legalManifestId: string;
    displayDisclosureKey: string;
    configHashCharacter: string;
  }) {
    const profileId = crypto.randomUUID();
    const profileVersionId = crypto.randomUUID();
    const authored = runOwnerSql(String.raw`
      begin;
      insert into public.ai_provider_profiles (
        id, profile_key, display_name, gateway_kind, model_vendor
      ) values (
        '${profileId}'::uuid,
        ${sqlLiteral(input.profileKey)},
        ${sqlLiteral(input.displayName)},
        ${sqlLiteral(input.gatewayKind)},
        ${sqlLiteral(input.modelVendor)}
      );
      insert into public.ai_provider_profile_versions (
        id, profile_id, version, adapter_kind, wire_api_kind,
        credential_alias, endpoint_alias, model_id, upstream_route,
        capability_contract_id, cache_policy_id, legal_manifest_id,
        display_disclosure_key, config, config_sha256
      ) values (
        '${profileVersionId}'::uuid,
        '${profileId}'::uuid,
        1,
        ${sqlLiteral(input.adapterKind)},
        ${sqlLiteral(input.wireApiKind)},
        ${sqlLiteral(input.credentialAlias)},
        ${sqlLiteral(input.endpointAlias)},
        ${sqlLiteral(input.modelId)},
        '{}'::jsonb,
        'polish_v2',
        'automatic_cache_v1',
        ${sqlLiteral(input.legalManifestId)},
        ${sqlLiteral(input.displayDisclosureKey)},
        '{}'::jsonb,
        ${sqlLiteral(input.configHashCharacter.repeat(64))}
      );
      update public.ai_provider_profile_versions
      set status = 'validated'
      where id = '${profileVersionId}'::uuid;
      commit;
    `);
    expect(authored.status).toBe(0);

    return {
      profileId,
      profileKey: input.profileKey,
      profileVersionId,
    };
  }

  async function createSharedPriceVersion(input: {
    profileVersionId: string;
    pricingLane: "offpeak" | "peak" | "default";
    snapshotHashCharacter: string;
  }): Promise<string> {
    const priceVersionId = crypto.randomUUID();
    const validFrom = new Date(Date.now() - 3_600_000).toISOString();
    const sourceCheckedAt = new Date().toISOString();
    const authored = runOwnerSql(String.raw`
      begin;
      insert into public.ai_price_versions (
        id, profile_version_id, pricing_lane, version, currency,
        calculator_kind, valid_from, source_url, source_checked_at,
        source_snapshot_sha256, parameters
      ) values (
        '${priceVersionId}'::uuid,
        '${input.profileVersionId}'::uuid,
        ${sqlLiteral(input.pricingLane)},
        1,
        'CNY',
        'linear_token_v1',
        ${sqlLiteral(validFrom)}::timestamptz,
        ${sqlLiteral(`https://example.com/shared-${input.pricingLane}-price`)},
        ${sqlLiteral(sourceCheckedAt)}::timestamptz,
        ${sqlLiteral(input.snapshotHashCharacter.repeat(64))},
        '{}'::jsonb
      );
      insert into public.ai_price_components (
        price_version_id, component, nanos_per_million
      ) values
        ('${priceVersionId}'::uuid, 'input_standard', 1),
        ('${priceVersionId}'::uuid, 'input_cache_read', 1),
        ('${priceVersionId}'::uuid, 'output', 1);
      commit;
    `);
    expect(authored.status).toBe(0);
    sealPriceAsDatabaseOwner(priceVersionId);
    return priceVersionId;
  }

  async function createSharedRoutingFixtureGraph(): Promise<SharedRoutingFixtureGraph> {
    const suffix = crypto.randomUUID();
    const deepseek = await createSharedProfileVersion({
      profileKey: `test.validator.shared.deepseek.${suffix}`,
      displayName: "Shared DeepSeek route",
      gatewayKind: "direct_deepseek",
      modelVendor: "deepseek",
      adapterKind: "deepseek_chat_v1",
      wireApiKind: "chat_completions_v1",
      credentialAlias: "deepseek_api_key",
      endpointAlias: "deepseek_official",
      modelId: "deepseek-v4-flash",
      legalManifestId: DEEPSEEK_LEGAL_MANIFEST_ID,
      displayDisclosureKey: "deepseek.official",
      configHashCharacter: "4",
    });
    const mimo = await createSharedProfileVersion({
      profileKey: `test.validator.shared.mimo.${suffix}`,
      displayName: "Shared MiMo route",
      gatewayKind: "direct_mimo",
      modelVendor: "mimo",
      adapterKind: "mimo_responses_v1",
      wireApiKind: "responses_v1",
      credentialAlias: "mimo_api_key",
      endpointAlias: "mimo_cn_official",
      modelId: "mimo-v2.5-pro",
      legalManifestId: MIMO_LEGAL_MANIFEST_ID,
      displayDisclosureKey: "mimo.official",
      configHashCharacter: "5",
    });

    const offpeakPriceVersionId = await createSharedPriceVersion({
      profileVersionId: deepseek.profileVersionId,
      pricingLane: "offpeak",
      snapshotHashCharacter: "6",
    });
    const peakPriceVersionId = await createSharedPriceVersion({
      profileVersionId: deepseek.profileVersionId,
      pricingLane: "peak",
      snapshotHashCharacter: "7",
    });
    const defaultPriceVersionId = await createSharedPriceVersion({
      profileVersionId: mimo.profileVersionId,
      pricingLane: "default",
      snapshotHashCharacter: "8",
    });

    const runtime = authorSyntheticRuntimeContractSet([
      {
        profileKey: deepseek.profileKey,
        legalManifestId: DEEPSEEK_LEGAL_MANIFEST_ID,
        manifestSha256: DEEPSEEK_LEGAL_MANIFEST_SHA256,
      },
      {
        profileKey: mimo.profileKey,
        legalManifestId: MIMO_LEGAL_MANIFEST_ID,
        manifestSha256: MIMO_LEGAL_MANIFEST_SHA256,
      },
    ]);
    const exactIdMap = new Map<string, string>([
      [
        routingRulesFixture.routes.deepseekOffpeak.profileVersionId,
        deepseek.profileVersionId,
      ],
      [
        routingRulesFixture.routes.deepseekOffpeak.priceVersionId,
        offpeakPriceVersionId,
      ],
      [
        routingRulesFixture.routes.deepseekPeak.priceVersionId,
        peakPriceVersionId,
      ],
      [
        routingRulesFixture.routes.mimoDefault.profileVersionId,
        mimo.profileVersionId,
      ],
      [
        routingRulesFixture.routes.mimoDefault.priceVersionId,
        defaultPriceVersionId,
      ],
    ]);

    return {
      deepseek: {
        ...deepseek,
        offpeakPriceVersionId,
        peakPriceVersionId,
      },
      mimo: {
        ...mimo,
        defaultPriceVersionId,
      },
      runtime,
      exactIdMap,
    };
  }

  function validRules(route: RouteFixture): Record<string, unknown> {
    return {
      schemaVersion: "routing_rules_v1",
      defaultRoute: {
        profileVersionId: route.profileVersionId,
        priceVersionId: route.priceVersionId,
      },
      windows: [],
    };
  }

  async function createPolicy(
    route: RouteFixture,
    rules: Record<string, unknown> = validRules(route),
    options: {
      runtime?: RuntimeContractPair;
      missingDefaultProfileVersionId?: string;
    } = {},
  ) {
    const defaultRoute = rules.defaultRoute;
    const mappedDefaultProfileVersionId =
      typeof defaultRoute === "object" &&
      defaultRoute !== null &&
      "profileVersionId" in defaultRoute &&
      typeof defaultRoute.profileVersionId === "string"
        ? defaultRoute.profileVersionId
        : options.missingDefaultProfileVersionId;
    if (mappedDefaultProfileVersionId === undefined) {
      throw new Error(
        "policy fixture requires a mapped defaultRoute profile or explicit malformed-case fallback",
      );
    }
    const runtime = options.runtime ?? route.runtime;
    const policyId = crypto.randomUUID();
    const authored = runOwnerSql(String.raw`
      insert into public.ai_routing_policy_versions (
        id, policy_key, version, timezone, rules,
        default_profile_version_id, legal_bundle_version,
        runtime_contract_id, runtime_contract_sha256, config_sha256
      ) values (
        '${policyId}'::uuid,
        ${sqlLiteral(`test.validator.policy.${crypto.randomUUID()}`)},
        1,
        'Asia/Shanghai',
        ${sqlJson(rules)},
        '${mappedDefaultProfileVersionId}'::uuid,
        ${sqlLiteral(INITIAL_LEGAL_BUNDLE_VERSION)},
        ${sqlLiteral(runtime.runtimeContractId)},
        ${sqlLiteral(runtime.runtimeContractSha256)},
        '${"3".repeat(64)}'
      );
    `);
    expect(authored.status).toBe(0);
    return { id: policyId, status: "draft" };
  }

  function validateProfile(route: RouteFixture) {
    const result = runOwnerSql(String.raw`
      update public.ai_provider_profile_versions
      set status = 'validated'
      where id = '${route.profileVersionId}'::uuid;
    `);
    expect(result.status).toBe(0);
  }

  it("accepts exact rules, then requires canary/active for the pointer", async () => {
    const route = await createRouteFixture({ label: "valid" });
    sealPriceAsDatabaseOwner(route.priceVersionId);
    await validateProfile(route);
    const policy = await createPolicy(route);

    const directValidated = await service
      .from("ai_routing_policy_versions")
      .update({ status: "validated" })
      .eq("id", policy.id);
    expect(directValidated.error?.code).toBe(PERMISSION_DENIED);

    const unauthorizedTransition = await service.rpc(
      "transition_ai_routing_policy_v1",
      {
        p_policy_id: policy.id,
        p_to_status: "validated",
      },
    );
    expect(unauthorizedTransition.error?.code).toBe(PERMISSION_DENIED);

    transitionPolicyAsDatabaseOwner(policy.id, "validated");

    const validatedPointer = runOwnerSql(
      String.raw`
        \set VERBOSITY verbose
        update public.ai_feature_config
        set active_routing_policy_version_id = '${policy.id}'::uuid,
            routing_updated_by = 'runtime-validator',
            routing_change_reason = ${sqlLiteral(`reject validated ${crypto.randomUUID()}`)}
        where id = true;
      `,
      { expectFailure: true },
    );
    expect(validatedPointer.stderr + validatedPointer.stdout).toContain("23514");
    expect(validatedPointer.stderr).toMatch(/canary|active/i);

    const canaryProfile = runOwnerSql(String.raw`
      update public.ai_provider_profile_versions
      set status = 'canary'
      where id = '${route.profileVersionId}'::uuid;
    `);
    expect(canaryProfile.status).toBe(0);
    transitionPolicyAsDatabaseOwner(policy.id, "canary");

    const activationReason = `activate canary ${crypto.randomUUID()}`;
    const activation = await service.rpc("set_ai_routing_policy_pointer_v1", {
      p_policy_version_id: policy.id,
      ...(await lifecycleEvidence(
        route.runtime,
        activationReason,
        [route.priceVersionId],
      )),
    });
    expect(activation.error).toBeNull();
    activePolicyId = policy.id;

    const unauthorizedAssert = await service.rpc(
      "assert_ai_routing_policy_v1",
      {
        p_policy_id: policy.id,
        p_phase: "reserve",
        p_at: new Date().toISOString(),
      },
    );
    expect(unauthorizedAssert.error?.code).toBe(PERMISSION_DENIED);

    const cleanupReason = `deactivate canary ${crypto.randomUUID()}`;
    const cleanup = await service.rpc("clear_ai_routing_policy_pointer_v1", {
      p_expected_policy_version_id: policy.id,
      ...(await lifecycleEvidence(
        route.runtime,
        cleanupReason,
        [route.priceVersionId],
      )),
    });
    expect(cleanup.error).toBeNull();
    activePolicyId = null;
  });

  it("matches every shared routing-rules shape and window-count case", async () => {
    const graph = await createSharedRoutingFixtureGraph();
    const route: RouteFixture = {
      profileId: graph.deepseek.profileId,
      profileKey: graph.deepseek.profileKey,
      profileVersionId: graph.deepseek.profileVersionId,
      priceVersionId: graph.deepseek.offpeakPriceVersionId,
      runtime: graph.runtime,
    };
    const priceIds = [
      graph.deepseek.offpeakPriceVersionId,
      graph.deepseek.peakPriceVersionId,
      graph.mimo.defaultPriceVersionId,
    ];
    expect(graph.deepseek.profileVersionId).not.toBe(
      graph.mimo.profileVersionId,
    );
    expect(new Set(priceIds).size).toBe(3);
    expect(graph.runtime.targets).toHaveLength(2);
    expect(graph.runtime.targets.map(({ profileKey }) => profileKey).sort()).toEqual(
      [graph.deepseek.profileKey, graph.mimo.profileKey].sort(),
    );
    expect(
      graph.runtime.targets
        .map(({ profileKey, legalManifestId, manifestSha256 }) => ({
          profileKey,
          legalManifestId,
          manifestSha256,
        }))
        .sort((left, right) => left.profileKey.localeCompare(right.profileKey)),
    ).toEqual(
      [
        {
          profileKey: graph.deepseek.profileKey,
          legalManifestId: DEEPSEEK_LEGAL_MANIFEST_ID,
          manifestSha256: DEEPSEEK_LEGAL_MANIFEST_SHA256,
        },
        {
          profileKey: graph.mimo.profileKey,
          legalManifestId: MIMO_LEGAL_MANIFEST_ID,
          manifestSha256: MIMO_LEGAL_MANIFEST_SHA256,
        },
      ].sort((left, right) => left.profileKey.localeCompare(right.profileKey)),
    );

    const exactPlaceholderIds = new Set([
      routingRulesFixture.routes.deepseekOffpeak.profileVersionId,
      routingRulesFixture.routes.deepseekOffpeak.priceVersionId,
      routingRulesFixture.routes.deepseekPeak.profileVersionId,
      routingRulesFixture.routes.deepseekPeak.priceVersionId,
      routingRulesFixture.routes.mimoDefault.profileVersionId,
      routingRulesFixture.routes.mimoDefault.priceVersionId,
    ]);
    expect(graph.exactIdMap.size).toBe(5);
    expect([...graph.exactIdMap.keys()].sort()).toEqual(
      [...exactPlaceholderIds].sort(),
    );
    const unknownUuid = crypto.randomUUID();
    expect(mapFixtureRouteIds(unknownUuid, graph.exactIdMap)).toBe(unknownUuid);
    expect(
      mapFixtureRouteIds(
        "11111111-1111-4111-8111-11111111111A",
        graph.exactIdMap,
      ),
    ).toBe("11111111-1111-4111-8111-11111111111A");

    const { data: prices, error: pricesError } = await service
      .from("ai_price_versions")
      .select("id,profile_version_id,pricing_lane,components_sealed_at")
      .in("id", priceIds);
    expect(pricesError).toBeNull();
    expect(prices).toHaveLength(3);
    const priceById = new Map(prices!.map((price) => [price.id, price]));
    expect(priceById.get(graph.deepseek.offpeakPriceVersionId)).toMatchObject({
      profile_version_id: graph.deepseek.profileVersionId,
      pricing_lane: "offpeak",
    });
    expect(priceById.get(graph.deepseek.peakPriceVersionId)).toMatchObject({
      profile_version_id: graph.deepseek.profileVersionId,
      pricing_lane: "peak",
    });
    expect(priceById.get(graph.mimo.defaultPriceVersionId)).toMatchObject({
      profile_version_id: graph.mimo.profileVersionId,
      pricing_lane: "default",
    });
    for (const price of prices!) {
      expect(price.components_sealed_at).toBeTruthy();
    }

    const sharedValidCases = [
      ...Object.entries(routingRulesFixture.validRules).map(([name, value]) => ({
        name,
        value,
      })),
      ...routingRulesFixture.validShapeCases,
    ];
    for (const sharedCase of sharedValidCases) {
      const rules = mapFixtureRouteIds(
        sharedCase.value,
        graph.exactIdMap,
      ) as Record<string, unknown>;
      const policy = await createPolicy(route, rules);
      expect(() =>
        transitionPolicyAsDatabaseOwner(policy.id, "validated"),
      ).not.toThrow();
    }

    for (const sharedCase of routingRulesFixture.invalidCases) {
      const rules = mapFixtureRouteIds(
        sharedCase.value,
        graph.exactIdMap,
      ) as Record<string, unknown>;
      const policy = await createPolicy(route, rules, {
        missingDefaultProfileVersionId: graph.deepseek.profileVersionId,
      });
      const transition = transitionPolicyAsDatabaseOwner(
        policy.id,
        "validated",
        { expectFailure: true },
      );
      expect(
        transition.stderr,
        `shared invalid DB case unexpectedly passed: ${sharedCase.name}`,
      ).toMatch(/routing_rules_v1|windows overlap/i);
    }

    for (const sharedCase of routingRulesFixture.generatedWindowCountCases) {
      const rules = {
        ...validRules(route),
        windows: Array.from({ length: sharedCase.count }, (_, index) => ({
          weekdays: [1],
          startMinute: index,
          endMinute: index + 1,
          route: {
            profileVersionId: graph.deepseek.profileVersionId,
            priceVersionId: graph.deepseek.offpeakPriceVersionId,
          },
        })),
      };
      const policy = await createPolicy(route, rules);
      if (sharedCase.accepted) {
        expect(() =>
          transitionPolicyAsDatabaseOwner(policy.id, "validated"),
        ).not.toThrow();
      } else {
        const transition = transitionPolicyAsDatabaseOwner(
          policy.id,
          "validated",
          { expectFailure: true },
        );
        expect(transition.stderr).toMatch(/top-level shape is invalid/i);
      }
    }

    const wrongOwnershipRules = mapFixtureRouteIds(
      routingRulesFixture.validRules.g4InitialProvider,
      graph.exactIdMap,
    ) as Record<string, unknown>;
    const wrongOwnershipWindows = wrongOwnershipRules.windows as Array<{
      route: { profileVersionId: string; priceVersionId: string };
    }>;
    wrongOwnershipWindows[0].route.priceVersionId =
      graph.deepseek.peakPriceVersionId;
    const wrongOwnershipPolicy = await createPolicy(route, wrongOwnershipRules);
    const wrongOwnershipTransition = transitionPolicyAsDatabaseOwner(
      wrongOwnershipPolicy.id,
      "validated",
      { expectFailure: true },
    );
    expect(wrongOwnershipTransition.stderr).toMatch(/price is unavailable/i);

    const deepseekOnlyRuntime = authorSyntheticRuntimeContract({
      profileKey: graph.deepseek.profileKey,
      legalManifestId: DEEPSEEK_LEGAL_MANIFEST_ID,
      manifestSha256: DEEPSEEK_LEGAL_MANIFEST_SHA256,
    });
    const missingMimoRules = mapFixtureRouteIds(
      routingRulesFixture.validRules.g4InitialProvider,
      graph.exactIdMap,
    ) as Record<string, unknown>;
    const missingMimoPolicy = await createPolicy(route, missingMimoRules, {
      runtime: deepseekOnlyRuntime,
    });
    const missingMimoTransition = transitionPolicyAsDatabaseOwner(
      missingMimoPolicy.id,
      "validated",
      { expectFailure: true },
    );
    expect(missingMimoTransition.stderr).toMatch(/legal\/runtime coverage/i);
  });

  it("requires exact runtime profile/manifest coverage and disclosure", async () => {
    const missingDisclosure = await createRouteFixture({
      label: "missing-disclosure",
      displayDisclosureKey: null,
    });
    sealPriceAsDatabaseOwner(missingDisclosure.priceVersionId);
    await validateProfile(missingDisclosure);
    const missingDisclosurePolicy = await createPolicy(missingDisclosure);
    const disclosureTransition = transitionPolicyAsDatabaseOwner(
      missingDisclosurePolicy.id,
      "validated",
      { expectFailure: true },
    );
    expect(disclosureTransition.stderr).toMatch(/profile is unavailable/i);

    const mismatchedRuntime = await createRouteFixture({
      label: "runtime-mismatch",
    });
    sealPriceAsDatabaseOwner(mismatchedRuntime.priceVersionId);
    await validateProfile(mismatchedRuntime);
    const unrelatedRuntime = authorSyntheticRuntimeContract();
    mismatchedRuntime.runtime = unrelatedRuntime;
    const mismatchedPolicy = await createPolicy(mismatchedRuntime);
    const runtimeTransition = transitionPolicyAsDatabaseOwner(
      mismatchedPolicy.id,
      "validated",
      { expectFailure: true },
    );
    expect(runtimeTransition.stderr).toMatch(/legal\/runtime coverage/i);

    const mismatchedManifest = await createRouteFixture({
      label: "manifest-mismatch",
      legalManifestId: "mimo-cn-2026-08-23-v1",
    });
    sealPriceAsDatabaseOwner(mismatchedManifest.priceVersionId);
    await validateProfile(mismatchedManifest);
    const manifestPolicy = await createPolicy(mismatchedManifest);
    const manifestTransition = transitionPolicyAsDatabaseOwner(
      manifestPolicy.id,
      "validated",
      { expectFailure: true },
    );
    expect(manifestTransition.stderr).toMatch(/legal\/runtime coverage/i);
  });

  it("allows future price validation but rejects canary before lower bounds", async () => {
    const route = await createRouteFixture({
      label: "future-price",
      validFrom: new Date(Date.now() + 86_400_000).toISOString(),
    });
    sealPriceAsDatabaseOwner(route.priceVersionId);
    await validateProfile(route);
    const policy = await createPolicy(route);

    transitionPolicyAsDatabaseOwner(policy.id, "validated");

    const profileCanary = runOwnerSql(String.raw`
      update public.ai_provider_profile_versions
      set status = 'canary'
      where id = '${route.profileVersionId}'::uuid;
    `);
    expect(profileCanary.status).toBe(0);
    const canary = transitionPolicyAsDatabaseOwner(policy.id, "canary", {
      expectFailure: true,
    });
    expect(canary.stderr).toMatch(/price is unavailable/i);
  });

  it("uses owner intent authority and structurally rejects direct seal forgery", async () => {
    const route = await createRouteFixture({ label: "seal-authority" });

    // The service role retains the narrow column-level UPDATE needed by the
    // route-snapshot guard's row lock. Directly setting the seal is therefore
    // denied structurally by the trigger/intent contract, not by ACL.
    const directSeal = runOwnerSql(
      String.raw`
        \set VERBOSITY verbose
        update public.ai_price_versions
        set components_sealed_at = greatest(clock_timestamp(), created_at)
        where id = '${route.priceVersionId}'::uuid;
      `,
      { expectFailure: true },
    );
    expect(directSeal.stderr).toContain("23514");
    const unsealed = await service
      .from("ai_price_versions")
      .select("components_sealed_at")
      .eq("id", route.priceVersionId)
      .single();
    expect(unsealed.error).toBeNull();
    expect(unsealed.data?.components_sealed_at).toBeNull();

    const unauthorizedHelper = await service.rpc("seal_ai_price_components_v1", {
      p_price_version_ids: [route.priceVersionId],
      p_sealed_at: new Date().toISOString(),
    });
    expect(unauthorizedHelper.error?.code).toBe(PERMISSION_DENIED);

    const nestedForgery = runOwnerSql(
      String.raw`
        \set ON_ERROR_STOP on
        begin;
        set local role service_role;
        create temporary table forged_price_seal (
          price_version_id uuid not null
        ) on commit drop;
        create function pg_temp.forge_price_seal()
        returns trigger
        language plpgsql
        set search_path = ''
        as $function$
        begin
          update public.ai_price_versions
          set components_sealed_at = greatest(clock_timestamp(), created_at)
          where id = new.price_version_id;
          return new;
        end;
        $function$;
        create trigger forge_price_seal
        after insert on forged_price_seal
        for each row execute function pg_temp.forge_price_seal();
        insert into forged_price_seal values ('${route.priceVersionId}'::uuid);
        commit;
      `,
      { expectFailure: true },
    );
    expect(nestedForgery.stderr).toMatch(/permission denied|owner-authorized/i);

    sealPriceAsDatabaseOwner(route.priceVersionId);
    const sealed = await service
      .from("ai_price_versions")
      .select("components_sealed_at")
      .eq("id", route.priceVersionId)
      .single();
    expect(sealed.error).toBeNull();
    expect(sealed.data?.components_sealed_at).toBeTruthy();
  });

  it("accepts the single optional linear cache-write component when sealing", async () => {
    const route = await createRouteFixture({
      label: "cache-write-component",
      includeCacheWrite: true,
    });
    sealPriceAsDatabaseOwner(route.priceVersionId);

    const { data: price, error: priceError } = await service
      .from("ai_price_versions")
      .select("components_sealed_at")
      .eq("id", route.priceVersionId)
      .single();
    expect(priceError).toBeNull();
    expect(price?.components_sealed_at).toBeTruthy();
    const { data: cacheWrite, error: componentError } = await service
      .from("ai_price_components")
      .select("nanos_per_million")
      .eq("price_version_id", route.priceVersionId)
      .eq("component", "input_cache_write")
      .single();
    expect(componentError).toBeNull();
    expect(cacheWrite?.nanos_per_million).toBe(1);
  });

  it("rejects retired combined-v1 authority and leaves CFG-003 dark candidates non-operational", () => {
    const oldCombined = runOwnerSql(String.raw`
      \pset tuples_only on
      \pset format unaligned
      select count(*) from public.ai_service_runtime_contract_versions
      where runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v1';
    `);
    expect(oldCombined.stdout.trim()).toBe("0");

    const darkValidation = runOwnerSql(String.raw`
      begin;
      select public.assert_ai_routing_policy_v1(
        '33333333-3333-4333-8333-333333333333'::uuid,
        'validated',
        clock_timestamp()
      );
      rollback;
    `, { expectFailure: true });
    expect(darkValidation.stderr).toMatch(/ERROR:\s+(?:23514|P0001):/u);
  });
});
