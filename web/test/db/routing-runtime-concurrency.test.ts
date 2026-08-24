import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  configureFeature,
  createServiceClient,
  createTestUser,
  deleteTestUser,
  getLedgerRows,
  getRateBuckets,
  getUsageRow,
  RUN_DB_TESTS,
  sleep,
} from "./helpers";
import {
  authorSyntheticRuntimeContract,
  DEEPSEEK_LEGAL_MANIFEST_ID,
  DEEPSEEK_LEGAL_MANIFEST_SHA256,
  INITIAL_LEGAL_BUNDLE_SHA256,
  INITIAL_LEGAL_BUNDLE_VERSION,
  runOwnerSql,
  sealPriceAsDatabaseOwner,
  startOwnerSql,
  transitionPolicyAsDatabaseOwner,
} from "./runtime-contract-fixtures";

interface LiveRoute {
  profileId: string;
  profileVersionId: string;
  priceVersionId: string;
  policyVersionId: string;
  runtimeContractId: string;
  runtimeContractSha256: string;
  configGeneration: string | null;
}

interface RuntimeRaceTarget {
  id: string;
  hash: string;
  profileKey: string;
  routeId: string;
  routeHash: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function targetSetHash(targets: RuntimeRaceTarget[]): string {
  return hash(
    [...targets]
      .sort((left, right) => Buffer.from(left.id).compare(Buffer.from(right.id)))
      .map(
        (target) =>
          `${Buffer.byteLength(target.id, "utf8")}:${target.id}:${target.hash}`,
      )
      .join("\n"),
  );
}

async function interleave(firstSql: string, secondSql: string) {
  const first = startOwnerSql(firstSql);
  await sleep(150);
  const second = startOwnerSql(secondSql);
  return Promise.all([first, second]);
}

describe.skipIf(!RUN_DB_TESTS)("routing/runtime lock concurrency (real DB)", () => {
  let service: SupabaseClient;

  beforeAll(() => {
    service = createServiceClient();
  });

  async function clearPointer(label: string) {
    const { data } = await service
      .from("ai_feature_config")
      .select("active_routing_policy_version_id")
      .eq("id", true)
      .single();
    if (data?.active_routing_policy_version_id) {
      const cleared = await service
        .from("ai_feature_config")
        .update({
          active_routing_policy_version_id: null,
          routing_updated_by: "runtime-concurrency",
          routing_change_reason: `${label} ${crypto.randomUUID()}`,
        })
        .eq("id", true);
      expect(cleared.error).toBeNull();
    }
  }

  async function createLiveRoute(
    label: string,
    options: { activateCanary?: boolean } = {},
  ): Promise<LiveRoute> {
    await clearPointer(`prepare ${label}`);
    const suffix = crypto.randomUUID();
    const profileKey = `test.concurrent.${label}.${suffix}`;
    const { data: profile, error: profileError } = await service
      .from("ai_provider_profiles")
      .insert({
        profile_key: profileKey,
        display_name: `Concurrent ${label}`,
        gateway_kind: "direct_deepseek",
        model_vendor: "deepseek",
      })
      .select("id")
      .single();
    expect(profileError).toBeNull();
    const { data: version, error: versionError } = await service
      .from("ai_provider_profile_versions")
      .insert({
        profile_id: profile!.id,
        version: 1,
        adapter_kind: "deepseek_chat_v1",
        wire_api_kind: "chat_completions_v1",
        credential_alias: "deepseek_api_key",
        endpoint_alias: "deepseek_official",
        model_id: "deepseek-v4-flash",
        capability_contract_id: "polish_v2",
        cache_policy_id: "automatic_cache_v1",
        legal_manifest_id: DEEPSEEK_LEGAL_MANIFEST_ID,
        display_disclosure_key: "deepseek.official",
        config: {},
        config_sha256: "a".repeat(64),
      })
      .select("id")
      .single();
    expect(versionError).toBeNull();
    const { data: price, error: priceError } = await service
      .from("ai_price_versions")
      .insert({
        profile_version_id: version!.id,
        version: 1,
        pricing_lane: "default",
        currency: "CNY",
        calculator_kind: "linear_token_v1",
        valid_from: new Date(Date.now() - 3_600_000).toISOString(),
        source_url: "https://example.com/concurrency-price",
        source_checked_at: new Date().toISOString(),
        source_snapshot_sha256: "b".repeat(64),
        parameters: {},
      })
      .select("id")
      .single();
    expect(priceError).toBeNull();
    const components = await service.from("ai_price_components").insert(
      ["input_standard", "input_cache_read", "output"].map((component) => ({
        price_version_id: price!.id,
        component,
        nanos_per_million: 1,
      })),
    );
    expect(components.error).toBeNull();
    sealPriceAsDatabaseOwner(price!.id);

    const runtime = authorSyntheticRuntimeContract({ profileKey });
    const profileValidated = await service
      .from("ai_provider_profile_versions")
      .update({ status: "validated" })
      .eq("id", version!.id);
    expect(profileValidated.error).toBeNull();
    const { data: policy, error: policyError } = await service
      .from("ai_routing_policy_versions")
      .insert({
        policy_key: `test.concurrent.policy.${suffix}`,
        version: 1,
        timezone: "Asia/Shanghai",
        rules: {
          schemaVersion: "routing_rules_v1",
          defaultRoute: {
            profileVersionId: version!.id,
            priceVersionId: price!.id,
          },
          windows: [],
        },
        default_profile_version_id: version!.id,
        legal_bundle_version: INITIAL_LEGAL_BUNDLE_VERSION,
        runtime_contract_id: runtime.runtimeContractId,
        runtime_contract_sha256: runtime.runtimeContractSha256,
        config_sha256: "c".repeat(64),
      })
      .select("id")
      .single();
    expect(policyError).toBeNull();
    if (options.activateCanary !== false) {
      transitionPolicyAsDatabaseOwner(policy!.id, "validated");
      expect(
        (
          await service
            .from("ai_provider_profile_versions")
            .update({ status: "canary" })
            .eq("id", version!.id)
        ).error,
      ).toBeNull();
      transitionPolicyAsDatabaseOwner(policy!.id, "canary");
      const pointer = await service
        .from("ai_feature_config")
        .update({
          active_routing_policy_version_id: policy!.id,
          routing_updated_by: "runtime-concurrency",
          routing_change_reason: `activate ${label} ${suffix}`,
        })
        .eq("id", true);
      expect(pointer.error).toBeNull();
    }

    let configGeneration: string | null = null;
    if (options.activateCanary !== false) {
      const { data: config, error: configError } = await service
        .from("ai_feature_config")
        .select("config_generation")
        .eq("id", true)
        .single();
      expect(configError).toBeNull();
      configGeneration = String(config!.config_generation);
    }

    return {
      profileId: profile!.id,
      profileVersionId: version!.id,
      priceVersionId: price!.id,
      policyVersionId: policy!.id,
      runtimeContractId: runtime.runtimeContractId,
      runtimeContractSha256: runtime.runtimeContractSha256,
      configGeneration,
    };
  }

  function reserveV2Sql(
    route: LiveRoute,
    userId: string,
    holdSeconds: number,
    lockTimeoutMs?: number,
  ) {
    if (route.configGeneration === null) {
      throw new Error("V2 concurrency route must be active");
    }
    const expectedRoute = JSON.stringify({
      schema_version: "expected_route_v1",
      config_generation: route.configGeneration,
      profile_version_id: route.profileVersionId,
      legal_bundle_version: INITIAL_LEGAL_BUNDLE_VERSION,
      runtime_contract_id: route.runtimeContractId,
      runtime_contract_sha256: route.runtimeContractSha256,
    });
    return String.raw`
      \set ON_ERROR_STOP on
      \pset format unaligned
      \pset tuples_only on
      insert into public.user_terms_acceptances (
        user_id, document_key, version
      ) values (
        '${userId}'::uuid, 'ai_terms', '${INITIAL_LEGAL_BUNDLE_VERSION}'
      ) on conflict (user_id, document_key, version) do nothing;
      begin;
      set local statement_timeout = '10s';
      ${
        lockTimeoutMs === undefined
          ? ""
          : `set local lock_timeout = '${lockTimeoutMs}ms';`
      }
      set local role service_role;
      select public.reserve_ai_polish_request_v2(
        '${userId}'::uuid,
        '${crypto.randomUUID()}'::uuid,
        '${crypto.randomUUID()}'::uuid,
        '${expectedRoute}'::jsonb
      );
      reset role;
      select pg_sleep(${holdSeconds});
      commit;
    `;
  }

  async function expectCoherentV2Snapshot(route: LiveRoute, userId: string) {
    const rows = await getLedgerRows(service, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      route_schema_version: "route_snapshot_v1",
      config_generation: Number(route.configGeneration),
      routing_policy_version_id: route.policyVersionId,
      profile_version_id: route.profileVersionId,
      price_version_id: route.priceVersionId,
      legal_bundle_version: INITIAL_LEGAL_BUNDLE_VERSION,
      runtime_contract_id: route.runtimeContractId,
      runtime_contract_sha256: route.runtimeContractSha256,
    });
  }

  async function expectNoV2Admission(userId: string) {
    expect(await getLedgerRows(service, userId)).toEqual([]);
    expect(await getUsageRow(service, userId)).toBeNull();
    expect(await getRateBuckets(service, userId)).toEqual([]);
  }

  function assertReserveSql(route: LiveRoute, holdSeconds: number) {
    return String.raw`
      \set ON_ERROR_STOP on
      begin;
      set local statement_timeout = '10s';
      select public.assert_ai_routing_policy_v1(
        '${route.policyVersionId}'::uuid,
        'reserve',
        clock_timestamp()
      );
      select pg_sleep(${holdSeconds});
      commit;
    `;
  }

  function clearPointerSql(label: string, holdSeconds: number) {
    return String.raw`
      \set ON_ERROR_STOP on
      begin;
      set local statement_timeout = '10s';
      update public.ai_feature_config
      set active_routing_policy_version_id = null,
          routing_updated_by = 'runtime-concurrency',
          routing_change_reason = '${label}.${crypto.randomUUID()}'
      where id = true;
      select pg_sleep(${holdSeconds});
      commit;
    `;
  }

  function switchPointerSql(
    replacement: LiveRoute,
    label: string,
    holdSeconds: number,
  ) {
    return String.raw`
      \set ON_ERROR_STOP on
      begin;
      set local statement_timeout = '10s';
      update public.ai_feature_config
      set active_routing_policy_version_id = '${replacement.policyVersionId}'::uuid,
          routing_updated_by = 'runtime-concurrency',
          routing_change_reason = '${label}.${crypto.randomUUID()}'
      where id = true;
      select pg_sleep(${holdSeconds});
      commit;
    `;
  }

  async function createPointerRacePair(label: string) {
    const current = await createLiveRoute(`${label}-current`);
    const replacement = await createLiveRoute(`${label}-replacement`, {
      activateCanary: false,
    });
    transitionPolicyAsDatabaseOwner(replacement.policyVersionId, "validated");
    const replacementCanary = await service
      .from("ai_provider_profile_versions")
      .update({ status: "canary" })
      .eq("id", replacement.profileVersionId);
    expect(replacementCanary.error).toBeNull();
    transitionPolicyAsDatabaseOwner(replacement.policyVersionId, "canary");

    const restoreCurrent = await service
      .from("ai_feature_config")
      .update({
        active_routing_policy_version_id: current.policyVersionId,
        routing_updated_by: "runtime-concurrency",
        routing_change_reason: `restore current ${label} ${crypto.randomUUID()}`,
      })
      .eq("id", true);
    expect(restoreCurrent.error).toBeNull();
    const { data: config, error: configError } = await service
      .from("ai_feature_config")
      .select("config_generation")
      .eq("id", true)
      .single();
    expect(configError).toBeNull();
    current.configGeneration = String(config!.config_generation);
    return { current, replacement };
  }

  function promotePolicySql(route: LiveRoute, holdSeconds: number) {
    return String.raw`
      \set ON_ERROR_STOP on
      begin;
      set local statement_timeout = '10s';
      select public.transition_ai_routing_policy_v1(
        '${route.policyVersionId}'::uuid,
        'validated'
      );
      select pg_sleep(${holdSeconds});
      commit;
    `;
  }

  function retireProfileSql(route: LiveRoute, holdSeconds: number) {
    return String.raw`
      \set ON_ERROR_STOP on
      begin;
      set local statement_timeout = '10s';
      update public.ai_provider_profiles
      set retired_at = greatest(clock_timestamp(), created_at)
      where id = '${route.profileId}'::uuid;
      select pg_sleep(${holdSeconds});
      commit;
    `;
  }

  function closePriceSql(route: LiveRoute, holdSeconds: number) {
    return String.raw`
      \set ON_ERROR_STOP on
      begin;
      set local statement_timeout = '10s';
      update public.ai_price_versions
      set valid_to = greatest(clock_timestamp(), valid_from + interval '1 microsecond')
      where id = '${route.priceVersionId}'::uuid;
      select pg_sleep(${holdSeconds});
      commit;
    `;
  }

  it("serializes reserve assertion and pointer switch in both orders", async () => {
    const assertionFirst = await createLiveRoute("pointer-assert-first");
    const [assertion, pointer] = await interleave(
      assertReserveSql(assertionFirst, 0.6),
      clearPointerSql("pointer-after-assert", 0),
    );
    expect(assertion.status, assertion.stderr).toBe(0);
    expect(pointer.status, pointer.stderr).toBe(0);

    const pointerFirst = await createLiveRoute("pointer-switch-first");
    const [switched, staleAssertion] = await interleave(
      clearPointerSql("pointer-before-assert", 0.6),
      assertReserveSql(pointerFirst, 0),
    );
    expect(switched.status, switched.stderr).toBe(0);
    expect(staleAssertion.status).not.toBe(0);
    expect(staleAssertion.stderr).toMatch(/current routing pointer/i);
  });

  it("serializes actual V2 reserve and pointer switch in both orders", async () => {
    const reserveFirst = await createPointerRacePair("v2-pointer-reserve-first");
    await configureFeature(service, { enabled: true, globalDailyLimit: 2000 });
    const firstUser = await createTestUser(service, "v2-pointer-reserve-first");
    try {
      const [reserved, switched] = await interleave(
        reserveV2Sql(reserveFirst.current, firstUser.id, 0.6),
        switchPointerSql(
          reserveFirst.replacement,
          "v2-pointer-after-reserve",
          0,
        ),
      );
      expect(reserved.status, reserved.stderr).toBe(0);
      expect(reserved.stdout).toContain('"allowed": true');
      expect(switched.status, switched.stderr).toBe(0);
      await expectCoherentV2Snapshot(reserveFirst.current, firstUser.id);
    } finally {
      await deleteTestUser(service, firstUser.id);
    }

    const switchFirst = await createPointerRacePair("v2-pointer-switch-first");
    await configureFeature(service, { enabled: true, globalDailyLimit: 2000 });
    const secondUser = await createTestUser(service, "v2-pointer-switch-first");
    try {
      const [switched, denied] = await interleave(
        switchPointerSql(
          switchFirst.replacement,
          "v2-pointer-before-reserve",
          0.6,
        ),
        reserveV2Sql(switchFirst.current, secondUser.id, 0),
      );
      expect(switched.status, switched.stderr).toBe(0);
      expect(denied.status, denied.stderr).toBe(0);
      expect(denied.stdout).toContain('"reason": "AI_ROUTE_CHANGED"');
      await expectNoV2Admission(secondUser.id);
    } finally {
      await deleteTestUser(service, secondUser.id);
      await configureFeature(service, { enabled: false });
    }
  });

  it("keeps same-price V2 reservations on compatible shared locks", async () => {
    const route = await createLiveRoute("v2-shared-price-locks");
    await configureFeature(service, { enabled: true, globalDailyLimit: 2000 });
    const firstUser = await createTestUser(service, "v2-shared-price-lock-a");
    const secondUser = await createTestUser(service, "v2-shared-price-lock-b");
    try {
      const [first, second] = await interleave(
        reserveV2Sql(route, firstUser.id, 0.6),
        reserveV2Sql(route, secondUser.id, 0, 250),
      );
      expect(first.status, first.stderr).toBe(0);
      expect(second.status, second.stderr).toBe(0);
      expect(first.stdout).toContain('"allowed": true');
      expect(second.stdout).toContain('"allowed": true');
      await expectCoherentV2Snapshot(route, firstUser.id);
      await expectCoherentV2Snapshot(route, secondUser.id);
    } finally {
      await deleteTestUser(service, firstUser.id);
      await deleteTestUser(service, secondUser.id);
      await clearPointer("V2 shared price lock cleanup");
      await configureFeature(service, { enabled: false });
    }
  });

  it("locks profile parents before authoritative reserve revalidation", async () => {
    const assertionFirst = await createLiveRoute("profile-assert-first");
    const retireAfterAssert = String.raw`
      \set ON_ERROR_STOP on
      begin;
      set local statement_timeout = '10s';
      update public.ai_provider_profiles
      set retired_at = greatest(clock_timestamp(), created_at)
      where id = '${assertionFirst.profileId}'::uuid;
      commit;
    `;
    const [assertion, retired] = await interleave(
      assertReserveSql(assertionFirst, 0.6),
      retireAfterAssert,
    );
    expect(assertion.status, assertion.stderr).toBe(0);
    expect(retired.status, retired.stderr).toBe(0);

    const retirementFirst = await createLiveRoute("profile-retire-first");
    const retireAndHold = String.raw`
      \set ON_ERROR_STOP on
      begin;
      set local statement_timeout = '10s';
      update public.ai_provider_profiles
      set retired_at = greatest(clock_timestamp(), created_at)
      where id = '${retirementFirst.profileId}'::uuid;
      select pg_sleep(0.6);
      commit;
    `;
    const [retirement, staleAssertion] = await interleave(
      retireAndHold,
      assertReserveSql(retirementFirst, 0),
    );
    expect(retirement.status, retirement.stderr).toBe(0);
    expect(staleAssertion.status).not.toBe(0);
    expect(staleAssertion.stderr).toMatch(/profile is unavailable/i);
    await clearPointer("profile concurrency cleanup");
  });

  it("serializes actual V2 reserve and profile retirement in both orders", async () => {
    const reserveFirst = await createLiveRoute("v2-profile-reserve-first");
    await configureFeature(service, { enabled: true, globalDailyLimit: 2000 });
    const firstUser = await createTestUser(service, "v2-profile-reserve-first");
    try {
      const [reserved, retired] = await interleave(
        reserveV2Sql(reserveFirst, firstUser.id, 0.6),
        retireProfileSql(reserveFirst, 0),
      );
      expect(reserved.status, reserved.stderr).toBe(0);
      expect(reserved.stdout).toContain('"allowed": true');
      expect(retired.status, retired.stderr).toBe(0);
      await expectCoherentV2Snapshot(reserveFirst, firstUser.id);
    } finally {
      await deleteTestUser(service, firstUser.id);
    }

    const retirementFirst = await createLiveRoute("v2-profile-retire-first");
    await configureFeature(service, { enabled: true, globalDailyLimit: 2000 });
    const secondUser = await createTestUser(service, "v2-profile-retire-first");
    try {
      const [retired, denied] = await interleave(
        retireProfileSql(retirementFirst, 0.6),
        reserveV2Sql(retirementFirst, secondUser.id, 0),
      );
      expect(retired.status, retired.stderr).toBe(0);
      expect(denied.status, denied.stderr).toBe(0);
      expect(denied.stdout).toContain('"reason": "SERVICE_UNAVAILABLE"');
      await expectNoV2Admission(secondUser.id);
      await clearPointer("V2 profile race cleanup");
    } finally {
      await deleteTestUser(service, secondUser.id);
      await configureFeature(service, { enabled: false });
    }
  });

  it("serializes price closure and reserve assertion in both orders", async () => {
    const assertionFirst = await createLiveRoute("price-assert-first");
    const closeAfterAssert = String.raw`
      \set ON_ERROR_STOP on
      begin;
      set local statement_timeout = '10s';
      update public.ai_price_versions
      set valid_to = greatest(clock_timestamp(), valid_from + interval '1 microsecond')
      where id = '${assertionFirst.priceVersionId}'::uuid;
      commit;
    `;
    const [assertion, closed] = await interleave(
      assertReserveSql(assertionFirst, 0.6),
      closeAfterAssert,
    );
    expect(assertion.status, assertion.stderr).toBe(0);
    expect(closed.status, closed.stderr).toBe(0);

    const closureFirst = await createLiveRoute("price-close-first");
    const closeAndHold = String.raw`
      \set ON_ERROR_STOP on
      begin;
      set local statement_timeout = '10s';
      update public.ai_price_versions
      set valid_to = greatest(clock_timestamp(), valid_from + interval '1 microsecond')
      where id = '${closureFirst.priceVersionId}'::uuid;
      select pg_sleep(0.6);
      commit;
    `;
    const [closure, staleAssertion] = await interleave(
      closeAndHold,
      assertReserveSql(closureFirst, 0),
    );
    expect(closure.status, closure.stderr).toBe(0);
    expect(staleAssertion.status).not.toBe(0);
    expect(staleAssertion.stderr).toMatch(/price is unavailable/i);
    await clearPointer("price concurrency cleanup");
  });

  it("serializes actual V2 reserve and price closure in both orders", async () => {
    const reserveFirst = await createLiveRoute("v2-price-reserve-first");
    await configureFeature(service, { enabled: true, globalDailyLimit: 2000 });
    const firstUser = await createTestUser(service, "v2-price-reserve-first");
    try {
      const [reserved, closed] = await interleave(
        reserveV2Sql(reserveFirst, firstUser.id, 0.6),
        closePriceSql(reserveFirst, 0),
      );
      expect(reserved.status, reserved.stderr).toBe(0);
      expect(reserved.stdout).toContain('"allowed": true');
      expect(closed.status, closed.stderr).toBe(0);
      await expectCoherentV2Snapshot(reserveFirst, firstUser.id);
    } finally {
      await deleteTestUser(service, firstUser.id);
    }

    const closureFirst = await createLiveRoute("v2-price-close-first");
    await configureFeature(service, { enabled: true, globalDailyLimit: 2000 });
    const secondUser = await createTestUser(service, "v2-price-close-first");
    try {
      const [closed, denied] = await interleave(
        closePriceSql(closureFirst, 0.6),
        reserveV2Sql(closureFirst, secondUser.id, 0),
      );
      expect(closed.status, closed.stderr).toBe(0);
      expect(denied.status, denied.stderr).toBe(0);
      expect(denied.stdout).toContain('"reason": "SERVICE_UNAVAILABLE"');
      await expectNoV2Admission(secondUser.id);
      await clearPointer("V2 price race cleanup");
    } finally {
      await deleteTestUser(service, secondUser.id);
      await configureFeature(service, { enabled: false });
    }
  });

  it("serializes owner policy promotion and profile retirement in both orders", async () => {
    const promotionFirst = await createLiveRoute("promote-before-retire", {
      activateCanary: false,
    });
    const [promoted, retired] = await interleave(
      promotePolicySql(promotionFirst, 0.6),
      retireProfileSql(promotionFirst, 0),
    );
    expect(promoted.status, promoted.stderr).toBe(0);
    expect(retired.status, retired.stderr).toBe(0);

    const retirementFirst = await createLiveRoute("retire-before-promote", {
      activateCanary: false,
    });
    const [retirement, rejectedPromotion] = await interleave(
      retireProfileSql(retirementFirst, 0.6),
      promotePolicySql(retirementFirst, 0),
    );
    expect(retirement.status, retirement.stderr).toBe(0);
    expect(rejectedPromotion.status).not.toBe(0);
    expect(rejectedPromotion.stderr).toMatch(/profile is unavailable/i);

    const { data: unchangedPolicy, error } = await service
      .from("ai_routing_policy_versions")
      .select("status")
      .eq("id", retirementFirst.policyVersionId)
      .single();
    expect(error).toBeNull();
    expect(unchangedPolicy?.status).toBe("draft");
  });

  it("serializes owner policy promotion and price closure in both orders", async () => {
    const promotionFirst = await createLiveRoute("promote-before-close", {
      activateCanary: false,
    });
    const [promoted, closed] = await interleave(
      promotePolicySql(promotionFirst, 0.6),
      closePriceSql(promotionFirst, 0),
    );
    expect(promoted.status, promoted.stderr).toBe(0);
    expect(closed.status, closed.stderr).toBe(0);

    const closureFirst = await createLiveRoute("close-before-promote", {
      activateCanary: false,
    });
    const [closure, rejectedPromotion] = await interleave(
      closePriceSql(closureFirst, 0.6),
      promotePolicySql(closureFirst, 0),
    );
    expect(closure.status, closure.stderr).toBe(0);
    expect(rejectedPromotion.status).not.toBe(0);
    expect(rejectedPromotion.stderr).toMatch(/price is unavailable/i);

    const { data: unchangedPolicy, error } = await service
      .from("ai_routing_policy_versions")
      .select("status")
      .eq("id", closureFirst.policyVersionId)
      .single();
    expect(error).toBeNull();
    expect(unchangedPolicy?.status).toBe("draft");
  });

  function createRaceTarget(suffix: string, label: string): RuntimeRaceTarget {
    const id = `test-race-target.${label}.${suffix}`;
    const routeId = `test-race-route.${label}.${suffix}`;
    return {
      id,
      hash: hash(id),
      profileKey: `test.race.profile.${label}.${suffix}`,
      routeId,
      routeHash: hash(routeId),
    };
  }

  function createRuntimeRaceRoot(
    label: string,
    initialTargets: RuntimeRaceTarget[],
    expectedFinalTargets: RuntimeRaceTarget[],
    catalogTargets: RuntimeRaceTarget[] = [],
  ) {
    const suffix = crypto.randomUUID();
    const rootId = `test-race-root.${label}.${suffix}`;
    const rootHash = hash(rootId);
    const allTargets = new Map(
      [...initialTargets, ...expectedFinalTargets, ...catalogTargets].map((target) => [
        target.id,
        target,
      ]),
    );
    const targetValues = [...allTargets.values()]
      .map(
        (target) => String.raw`(
          '${target.id}', '${target.hash}', '${target.profileKey}',
          '${DEEPSEEK_LEGAL_MANIFEST_ID}', '${DEEPSEEK_LEGAL_MANIFEST_SHA256}',
          '${target.routeId}', '${target.routeHash}'
        )`,
      )
      .join(",\n");
    const membershipValues = initialTargets
      .map(
        (target) => String.raw`(
          '${rootId}', '${rootHash}', '${target.id}', '${target.hash}',
          '${target.profileKey}', '${DEEPSEEK_LEGAL_MANIFEST_ID}',
          '${DEEPSEEK_LEGAL_MANIFEST_SHA256}', '${target.routeId}',
          '${target.routeHash}'
        )`,
      )
      .join(",\n");

    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      begin;
      insert into public.ai_service_runtime_target_versions (
        runtime_target_id, runtime_target_sha256, profile_key,
        legal_manifest_id, manifest_sha256,
        route_descriptor_id, route_descriptor_sha256
      ) values ${targetValues}
      on conflict (runtime_target_id) do nothing;
      insert into public.ai_service_runtime_contract_versions (
        runtime_contract_id,
        runtime_contract_sha256,
        reviewed_source_commit_oid,
        legal_bundle_version,
        bundle_contract_sha256,
        runtime_target_set_sha256
      ) values (
        '${rootId}',
        '${rootHash}',
        'sha1:0123456789abcdef0123456789abcdef01234567',
        '${INITIAL_LEGAL_BUNDLE_VERSION}',
        '${INITIAL_LEGAL_BUNDLE_SHA256}',
        '${targetSetHash(expectedFinalTargets)}'
      );
      ${
        initialTargets.length > 0
          ? String.raw`insert into public.ai_service_runtime_contract_targets (
              runtime_contract_id, runtime_contract_sha256,
              runtime_target_id, runtime_target_sha256, profile_key,
              legal_manifest_id, manifest_sha256,
              route_descriptor_id, route_descriptor_sha256
            ) values ${membershipValues};`
          : ""
      }
      commit;
    `);
    return { rootId, rootHash };
  }

  function membershipValues(rootId: string, rootHash: string, target: RuntimeRaceTarget) {
    return String.raw`(
      '${rootId}', '${rootHash}', '${target.id}', '${target.hash}',
      '${target.profileKey}', '${DEEPSEEK_LEGAL_MANIFEST_ID}',
      '${DEEPSEEK_LEGAL_MANIFEST_SHA256}', '${target.routeId}',
      '${target.routeHash}'
    )`;
  }

  function sealRootSql(rootId: string, holdSeconds: number) {
    return String.raw`
      \set ON_ERROR_STOP on
      begin;
      set local statement_timeout = '10s';
      update public.ai_service_runtime_contract_versions
      set sealed_at = greatest(clock_timestamp(), created_at)
      where runtime_contract_id = '${rootId}';
      select pg_sleep(${holdSeconds});
      commit;
    `;
  }

  it("serializes membership insert/update/delete against root sealing in both orders", async () => {
    const operations = ["insert", "update", "delete"] as const;
    for (const operation of operations) {
      const suffix = crypto.randomUUID();
      const first = createRaceTarget(suffix, "first");
      const second = createRaceTarget(suffix, "second");
      const third = createRaceTarget(suffix, "third");
      const initial =
        operation === "insert"
          ? []
          : operation === "update"
            ? [first]
            : [first, second];
      const final =
        operation === "insert"
          ? [first]
          : operation === "update"
            ? [second]
            : [second];
      const mutationFirstRoot = createRuntimeRaceRoot(
        `${operation}-mutation-first`,
        initial,
        final,
        [first, second, third],
      );
      const mutationSql =
        operation === "insert"
          ? String.raw`insert into public.ai_service_runtime_contract_targets (
              runtime_contract_id, runtime_contract_sha256,
              runtime_target_id, runtime_target_sha256, profile_key,
              legal_manifest_id, manifest_sha256,
              route_descriptor_id, route_descriptor_sha256
            ) values ${membershipValues(mutationFirstRoot.rootId, mutationFirstRoot.rootHash, first)};`
          : operation === "update"
            ? String.raw`update public.ai_service_runtime_contract_targets
                set runtime_target_id = '${second.id}',
                    runtime_target_sha256 = '${second.hash}',
                    profile_key = '${second.profileKey}',
                    route_descriptor_id = '${second.routeId}',
                    route_descriptor_sha256 = '${second.routeHash}'
                where runtime_contract_id = '${mutationFirstRoot.rootId}'
                  and runtime_target_id = '${first.id}';`
            : String.raw`delete from public.ai_service_runtime_contract_targets
                where runtime_contract_id = '${mutationFirstRoot.rootId}'
                  and runtime_target_id = '${first.id}';`;
      const mutationAndHold = String.raw`
        \set ON_ERROR_STOP on
        begin;
        set local statement_timeout = '10s';
        ${mutationSql}
        select pg_sleep(0.45);
        commit;
      `;
      const [mutation, sealedAfterMutation] = await interleave(
        mutationAndHold,
        sealRootSql(mutationFirstRoot.rootId, 0),
      );
      expect(mutation.status, mutation.stderr).toBe(0);
      expect(sealedAfterMutation.status, sealedAfterMutation.stderr).toBe(0);

      const sealFirstInitial =
        operation === "insert"
          ? [first]
          : operation === "update"
            ? [first]
            : [first, second];
      const sealFirstRoot = createRuntimeRaceRoot(
        `${operation}-seal-first`,
        sealFirstInitial,
        sealFirstInitial,
        [first, second, third],
      );
      const sealFirstMutation =
        operation === "insert"
          ? String.raw`insert into public.ai_service_runtime_contract_targets (
              runtime_contract_id, runtime_contract_sha256,
              runtime_target_id, runtime_target_sha256, profile_key,
              legal_manifest_id, manifest_sha256,
              route_descriptor_id, route_descriptor_sha256
            ) values ${membershipValues(sealFirstRoot.rootId, sealFirstRoot.rootHash, third)};`
          : operation === "update"
            ? String.raw`update public.ai_service_runtime_contract_targets
                set runtime_target_id = '${second.id}',
                    runtime_target_sha256 = '${second.hash}',
                    profile_key = '${second.profileKey}',
                    route_descriptor_id = '${second.routeId}',
                    route_descriptor_sha256 = '${second.routeHash}'
                where runtime_contract_id = '${sealFirstRoot.rootId}'
                  and runtime_target_id = '${first.id}';`
            : String.raw`delete from public.ai_service_runtime_contract_targets
                where runtime_contract_id = '${sealFirstRoot.rootId}'
                  and runtime_target_id = '${first.id}';`;
      const mutationAfterSeal = String.raw`
        \set ON_ERROR_STOP on
        begin;
        set local statement_timeout = '10s';
        ${sealFirstMutation}
        commit;
      `;
      const [sealedFirst, rejectedMutation] = await interleave(
        sealRootSql(sealFirstRoot.rootId, 0.45),
        mutationAfterSeal,
      );
      expect(sealedFirst.status, sealedFirst.stderr).toBe(0);
      expect(rejectedMutation.status).not.toBe(0);
      expect(rejectedMutation.stderr).toMatch(/sealed runtime contract/i);
    }
  });
});
