import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import routingRulesFixture from "../fixtures/routing-rules-v1.json";
import { createServiceClient, RUN_DB_TESTS } from "./helpers";
import {
  authorSyntheticRuntimeContract,
  DEEPSEEK_LEGAL_MANIFEST_ID,
  INITIAL_LEGAL_BUNDLE_VERSION,
  runOwnerSql,
  sealPriceAsDatabaseOwner,
  transitionPolicyAsDatabaseOwner,
  type SyntheticRuntimeContract,
} from "./runtime-contract-fixtures";

const CHECK_VIOLATION = "23514";
const PERMISSION_DENIED = "42501";

interface RouteFixture {
  profileId: string;
  profileKey: string;
  profileVersionId: string;
  priceVersionId: string;
  runtime: SyntheticRuntimeContract;
}

const FIXTURE_PROFILE_VERSION_IDS = new Set(
  Object.values(routingRulesFixture.routes).map(({ profileVersionId }) =>
    profileVersionId,
  ),
);
const FIXTURE_PRICE_VERSION_IDS = new Set(
  Object.values(routingRulesFixture.routes).map(({ priceVersionId }) =>
    priceVersionId,
  ),
);

function mapFixtureRouteIds(value: unknown, route: RouteFixture): unknown {
  if (typeof value === "string") {
    if (FIXTURE_PROFILE_VERSION_IDS.has(value)) {
      return route.profileVersionId;
    }
    if (FIXTURE_PRICE_VERSION_IDS.has(value)) {
      return route.priceVersionId;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => mapFixtureRouteIds(entry, route));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        mapFixtureRouteIds(entry, route),
      ]),
    );
  }
  return value;
}

describe.skipIf(!RUN_DB_TESTS)("routing runtime validator (real DB)", () => {
  let service: SupabaseClient;

  beforeAll(() => {
    service = createServiceClient();
  });

  afterAll(async () => {
    const { data } = await service
      .from("ai_feature_config")
      .select("active_routing_policy_version_id")
      .eq("id", true)
      .single();
    if (data?.active_routing_policy_version_id) {
      await service
        .from("ai_feature_config")
        .update({
          active_routing_policy_version_id: null,
          routing_updated_by: "runtime-validator-cleanup",
          routing_change_reason: `runtime validator cleanup ${crypto.randomUUID()}`,
        })
        .eq("id", true);
    }
  });

  async function createRouteFixture(options: {
    label: string;
    displayDisclosureKey?: string | null;
    legalManifestId?: string;
    validFrom?: string;
    extraComponent?: boolean;
  }): Promise<RouteFixture> {
    const suffix = crypto.randomUUID();
    const profileKey = `test.validator.${options.label}.${suffix}`;
    const { data: profile, error: profileError } = await service
      .from("ai_provider_profiles")
      .insert({
        profile_key: profileKey,
        display_name: `Validator ${options.label}`,
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
        upstream_route: {},
        capability_contract_id: "polish_v2",
        cache_policy_id: "automatic_cache_v1",
        legal_manifest_id:
          options.legalManifestId ?? DEEPSEEK_LEGAL_MANIFEST_ID,
        display_disclosure_key:
          options.displayDisclosureKey === undefined
            ? "deepseek.official"
            : options.displayDisclosureKey,
        config: {},
        config_sha256: "1".repeat(64),
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
        valid_from:
          options.validFrom ?? new Date(Date.now() - 3_600_000).toISOString(),
        source_url: "https://example.com/validator-price",
        source_checked_at: new Date().toISOString(),
        source_snapshot_sha256: "2".repeat(64),
        parameters: {},
      })
      .select("id")
      .single();
    expect(priceError).toBeNull();

    const components = [
      "input_standard",
      "input_cache_read",
      "output",
      ...(options.extraComponent ? ["input_cache_write"] : []),
    ].map((component) => ({
      price_version_id: price!.id,
      component,
      nanos_per_million: 1,
    }));
    const componentInsert = await service
      .from("ai_price_components")
      .insert(components);
    expect(componentInsert.error).toBeNull();

    const runtime = authorSyntheticRuntimeContract({
      profileKey,
      legalManifestId: DEEPSEEK_LEGAL_MANIFEST_ID,
    });

    return {
      profileId: profile!.id,
      profileKey,
      profileVersionId: version!.id,
      priceVersionId: price!.id,
      runtime,
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
  ) {
    const { data, error } = await service
      .from("ai_routing_policy_versions")
      .insert({
        policy_key: `test.validator.policy.${crypto.randomUUID()}`,
        version: 1,
        timezone: "Asia/Shanghai",
        rules,
        default_profile_version_id: route.profileVersionId,
        legal_bundle_version: INITIAL_LEGAL_BUNDLE_VERSION,
        runtime_contract_id: route.runtime.runtimeContractId,
        runtime_contract_sha256: route.runtime.runtimeContractSha256,
        config_sha256: "3".repeat(64),
      })
      .select("id,status")
      .single();
    expect(error).toBeNull();
    return data!;
  }

  async function validateProfile(route: RouteFixture) {
    const result = await service
      .from("ai_provider_profile_versions")
      .update({ status: "validated" })
      .eq("id", route.profileVersionId);
    expect(result.error).toBeNull();
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
    expect(directValidated.error?.code).toBe(CHECK_VIOLATION);
    expect(directValidated.error?.message).toContain(
      "direct routing policy lifecycle transitions await DB-013 authority",
    );

    const unauthorizedTransition = await service.rpc(
      "transition_ai_routing_policy_v1",
      {
        p_policy_id: policy.id,
        p_to_status: "validated",
      },
    );
    expect(unauthorizedTransition.error?.code).toBe(PERMISSION_DENIED);

    transitionPolicyAsDatabaseOwner(policy.id, "validated");

    const validatedPointer = await service
      .from("ai_feature_config")
      .update({
        active_routing_policy_version_id: policy.id,
        routing_updated_by: "runtime-validator",
        routing_change_reason: `reject validated ${crypto.randomUUID()}`,
      })
      .eq("id", true);
    expect(validatedPointer.error?.code).toBe(CHECK_VIOLATION);

    const canaryProfile = await service
      .from("ai_provider_profile_versions")
      .update({ status: "canary" })
      .eq("id", route.profileVersionId);
    expect(canaryProfile.error).toBeNull();
    transitionPolicyAsDatabaseOwner(policy.id, "canary");

    const activation = await service
      .from("ai_feature_config")
      .update({
        active_routing_policy_version_id: policy.id,
        routing_updated_by: "runtime-validator",
        routing_change_reason: `activate canary ${crypto.randomUUID()}`,
      })
      .eq("id", true);
    expect(activation.error).toBeNull();

    const unauthorizedAssert = await service.rpc(
      "assert_ai_routing_policy_v1",
      {
        p_policy_id: policy.id,
        p_phase: "reserve",
        p_at: new Date().toISOString(),
      },
    );
    expect(unauthorizedAssert.error?.code).toBe(PERMISSION_DENIED);

    const cleanup = await service
      .from("ai_feature_config")
      .update({
        active_routing_policy_version_id: null,
        routing_updated_by: "runtime-validator",
        routing_change_reason: `deactivate canary ${crypto.randomUUID()}`,
      })
      .eq("id", true);
    expect(cleanup.error).toBeNull();
  });

  it("matches every shared routing-rules shape and window-count case", async () => {
    const route = await createRouteFixture({ label: "shared-rules-parity" });
    sealPriceAsDatabaseOwner(route.priceVersionId);
    await validateProfile(route);

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
        route,
      ) as Record<string, unknown>;
      const policy = await createPolicy(route, rules);
      expect(() =>
        transitionPolicyAsDatabaseOwner(policy.id, "validated"),
      ).not.toThrow();
    }

    for (const sharedCase of routingRulesFixture.invalidCases) {
      const rules = mapFixtureRouteIds(
        sharedCase.value,
        route,
      ) as Record<string, unknown>;
      const policy = await createPolicy(route, rules);
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
            profileVersionId: route.profileVersionId,
            priceVersionId: route.priceVersionId,
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

    const profileCanary = await service
      .from("ai_provider_profile_versions")
      .update({ status: "canary" })
      .eq("id", route.profileVersionId);
    expect(profileCanary.error).toBeNull();
    const canary = transitionPolicyAsDatabaseOwner(policy.id, "canary", {
      expectFailure: true,
    });
    expect(canary.stderr).toMatch(/price is unavailable/i);
  });

  it("uses owner intent authority and rejects service-role nested-trigger forgery", async () => {
    const route = await createRouteFixture({ label: "seal-authority" });

    const directSeal = await service
      .from("ai_price_versions")
      .update({ components_sealed_at: new Date().toISOString() })
      .eq("id", route.priceVersionId);
    expect(directSeal.error?.code).toBe(CHECK_VIOLATION);

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

  it("rejects incomplete or extra linear-token component sets before sealing", async () => {
    const route = await createRouteFixture({
      label: "extra-component",
      extraComponent: true,
    });
    expect(() => sealPriceAsDatabaseOwner(route.priceVersionId)).toThrow(
      /exactly input_standard, input_cache_read, and output/i,
    );

    const { data: price } = await service
      .from("ai_price_versions")
      .select("components_sealed_at")
      .eq("id", route.priceVersionId)
      .single();
    expect(price?.components_sealed_at).toBeNull();
  });
});
