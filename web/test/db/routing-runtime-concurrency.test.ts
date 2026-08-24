import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { createServiceClient, RUN_DB_TESTS, sleep } from "./helpers";
import {
  authorSyntheticRuntimeContract,
  DEEPSEEK_LEGAL_MANIFEST_ID,
  DEEPSEEK_LEGAL_MANIFEST_SHA256,
  INITIAL_LEGAL_BUNDLE_SHA256,
  INITIAL_LEGAL_BUNDLE_VERSION,
  runOwnerSql,
  sealPriceAsDatabaseOwner,
  startOwnerSql,
} from "./runtime-contract-fixtures";

interface LiveRoute {
  profileId: string;
  profileVersionId: string;
  priceVersionId: string;
  policyVersionId: string;
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

  async function createLiveRoute(label: string): Promise<LiveRoute> {
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
    expect(
      (
        await service
          .from("ai_routing_policy_versions")
          .update({ status: "validated" })
          .eq("id", policy!.id)
      ).error,
    ).toBeNull();
    expect(
      (
        await service
          .from("ai_provider_profile_versions")
          .update({ status: "canary" })
          .eq("id", version!.id)
      ).error,
    ).toBeNull();
    expect(
      (
        await service
          .from("ai_routing_policy_versions")
          .update({ status: "canary" })
          .eq("id", policy!.id)
      ).error,
    ).toBeNull();
    const pointer = await service
      .from("ai_feature_config")
      .update({
        active_routing_policy_version_id: policy!.id,
        routing_updated_by: "runtime-concurrency",
        routing_change_reason: `activate ${label} ${suffix}`,
      })
      .eq("id", true);
    expect(pointer.error).toBeNull();

    return {
      profileId: profile!.id,
      profileVersionId: version!.id,
      priceVersionId: price!.id,
      policyVersionId: policy!.id,
    };
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
