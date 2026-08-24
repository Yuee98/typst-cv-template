import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServiceClient, RUN_DB_TESTS } from "./helpers";
import {
  authorSyntheticRuntimeContract,
  MIMO_LEGAL_MANIFEST_ID,
  MIMO_LEGAL_MANIFEST_SHA256,
  sealPriceAsDatabaseOwner,
  type SyntheticRuntimeContract,
} from "./runtime-contract-fixtures";

const CHECK_VIOLATION = "23514";

interface RoutingTargetFixture {
  id: string;
  priceVersionId: string;
  runtime: SyntheticRuntimeContract;
}

describe.skipIf(!RUN_DB_TESTS)("provider routing schema (real DB)", () => {
  let service: SupabaseClient;
  let legalBundleVersion: string;

  beforeAll(async () => {
    service = createServiceClient();
    const { data, error } = await service.rpc("current_ai_terms_version");
    expect(error).toBeNull();
    legalBundleVersion = data as string;
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
          routing_updated_by: "provider-routing-test-cleanup",
          routing_change_reason: `restore inactive routing pointer ${crypto.randomUUID()}`,
        })
        .eq("id", true);
    }
  });

  async function createProfileVersion(
    label: string,
    status: "draft" | "validated" | "canary" | "active",
  ): Promise<RoutingTargetFixture> {
    const profileKey = `test.routing.${label}.${crypto.randomUUID()}`;
    const { data: profile, error: profileError } = await service
      .from("ai_provider_profiles")
      .insert({
        profile_key: profileKey,
        display_name: `Routing ${label}`,
        gateway_kind: "direct_mimo",
        model_vendor: "fixture",
      })
      .select("id")
      .single();
    expect(profileError).toBeNull();

    const { data: version, error: versionError } = await service
      .from("ai_provider_profile_versions")
      .insert({
        profile_id: profile!.id,
        version: 1,
        status: "draft",
        adapter_kind: "fixture_adapter_v1",
        wire_api_kind: "responses_v1",
        credential_alias: "fixture_credential_v1",
        endpoint_alias: "fixture_endpoint_v1",
        model_id: "fixture-model",
        upstream_route: {},
        capability_contract_id: "fixture_capability_v1",
        cache_policy_id: "fixture_cache_v1",
        legal_manifest_id: MIMO_LEGAL_MANIFEST_ID,
        display_disclosure_key: "mimo.official",
        config: {},
        config_sha256: "d".repeat(64),
      })
      .select("id")
      .single();
    expect(versionError).toBeNull();

    const { data: price, error: priceError } = await service
      .from("ai_price_versions")
      .insert({
        profile_version_id: version!.id,
        pricing_lane: "default",
        version: 1,
        currency: "CNY",
        calculator_kind: "linear_token_v1",
        valid_from: new Date(Date.now() - 3_600_000).toISOString(),
        source_url: "https://example.com/provider-routing-price",
        source_checked_at: new Date().toISOString(),
        source_snapshot_sha256: "a".repeat(64),
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

    const runtime = authorSyntheticRuntimeContract({
      profileKey,
      legalManifestId: MIMO_LEGAL_MANIFEST_ID,
      manifestSha256: MIMO_LEGAL_MANIFEST_SHA256,
    });

    if (status !== "draft") {
      for (const nextStatus of ["validated", "canary", "active"] as const) {
        const transition = await service
          .from("ai_provider_profile_versions")
          .update({ status: nextStatus })
          .eq("id", version!.id);
        expect(transition.error).toBeNull();
        if (nextStatus === status) {
          break;
        }
      }
    }

    return { id: version!.id, priceVersionId: price!.id, runtime };
  }

  function strictRules(target: RoutingTargetFixture) {
    return {
      schemaVersion: "routing_rules_v1",
      defaultRoute: {
        profileVersionId: target.id,
        priceVersionId: target.priceVersionId,
      },
      windows: [],
    };
  }

  async function createPolicy(
    target: RoutingTargetFixture,
    label: string,
    status: "draft" | "validated" | "canary" | "active",
    legalVersion = legalBundleVersion,
  ) {
    const { data, error } = await service
      .from("ai_routing_policy_versions")
      .insert({
        policy_key: `test.routing.${label}.${crypto.randomUUID()}`,
        version: 1,
        status: "draft",
        timezone: "Asia/Shanghai",
        rules: strictRules(target),
        default_profile_version_id: target.id,
        legal_bundle_version: legalVersion,
        runtime_contract_id: target.runtime.runtimeContractId,
        runtime_contract_sha256: target.runtime.runtimeContractSha256,
        config_sha256: "e".repeat(64),
      })
      .select("*")
      .single();
    expect(error).toBeNull();
    if (status === "draft") {
      return data!;
    }

    let current = data!;
    for (const nextStatus of ["validated", "canary", "active"] as const) {
      const transition = await service
        .from("ai_routing_policy_versions")
        .update({ status: nextStatus })
        .eq("id", current.id)
        .select("*")
        .single();
      expect(transition.error).toBeNull();
      current = transition.data!;
      if (nextStatus === status) {
        break;
      }
    }
    return current;
  }

  it("keeps draft/off as the default and validates timezone/rules", async () => {
    const { data: config, error } = await service
      .from("ai_feature_config")
      .select("active_routing_policy_version_id,config_generation")
      .eq("id", true)
      .single();
    expect(error).toBeNull();
    expect(config?.active_routing_policy_version_id).toBeNull();
    expect(Number(config?.config_generation)).toBeGreaterThanOrEqual(0);

    const profile = await createProfileVersion("timezone", "draft");
    const invalidTimezone = await service
      .from("ai_routing_policy_versions")
      .insert({
        policy_key: `test.invalid-timezone.${crypto.randomUUID()}`,
        version: 1,
        timezone: "UTC",
        rules: strictRules(profile),
        default_profile_version_id: profile.id,
        legal_bundle_version: legalBundleVersion,
        runtime_contract_id: profile.runtime.runtimeContractId,
        runtime_contract_sha256: profile.runtime.runtimeContractSha256,
        config_sha256: "e".repeat(64),
      });
    expect(invalidTimezone.error?.code).toBe(CHECK_VIOLATION);

    const invalidRules = await service
      .from("ai_routing_policy_versions")
      .insert({
        policy_key: `test.invalid-rules.${crypto.randomUUID()}`,
        version: 1,
        timezone: "Asia/Shanghai",
        rules: [],
        default_profile_version_id: profile.id,
        legal_bundle_version: legalBundleVersion,
        runtime_contract_id: profile.runtime.runtimeContractId,
        runtime_contract_sha256: profile.runtime.runtimeContractSha256,
        config_sha256: "e".repeat(64),
      });
    expect(invalidRules.error?.code).toBe(CHECK_VIOLATION);

    for (const [index, status] of [
      "validated",
      "canary",
      "active",
      "retired",
    ].entries()) {
      const nonDraftInsert = await service
        .from("ai_routing_policy_versions")
        .insert({
          policy_key: `test.non-draft.${index}.${crypto.randomUUID()}`,
          version: 1,
          status,
          timezone: "Asia/Shanghai",
          rules: strictRules(profile),
          default_profile_version_id: profile.id,
          legal_bundle_version: legalBundleVersion,
          runtime_contract_id: profile.runtime.runtimeContractId,
          runtime_contract_sha256: profile.runtime.runtimeContractSha256,
          config_sha256: "e".repeat(64),
        });
      expect(nonDraftInsert.error?.code).toBe(CHECK_VIOLATION);
    }
  });

  it("fails closed before activation for draft profiles, draft policies, or stale legal", async () => {
    const draftProfile = await createProfileVersion("draft-profile", "draft");
    const draftProfilePolicy = await createPolicy(
      draftProfile,
      "draft-profile",
      "draft",
    );
    const invalidTransition = await service
      .from("ai_routing_policy_versions")
      .update({ status: "validated" })
      .eq("id", draftProfilePolicy.id);
    expect(invalidTransition.error?.code).toBe(CHECK_VIOLATION);

    const validatedProfile = await createProfileVersion(
      "draft-policy",
      "validated",
    );
    const draftPolicy = await createPolicy(
      validatedProfile,
      "draft-policy",
      "draft",
    );
    const draftPolicyActivation = await service
      .from("ai_feature_config")
      .update({
        active_routing_policy_version_id: draftPolicy.id,
        routing_updated_by: "provider-routing-test",
        routing_change_reason: `prove draft policy rejection ${crypto.randomUUID()}`,
      })
      .eq("id", true);
    expect(draftPolicyActivation.error?.code).toBe(CHECK_VIOLATION);

    const staleLegalPolicy = await createPolicy(
      validatedProfile,
      "stale-legal",
      "draft",
      "2026-08-04",
    );
    const staleTransition = await service
      .from("ai_routing_policy_versions")
      .update({ status: "validated" })
      .eq("id", staleLegalPolicy.id);
    expect(staleTransition.error?.code).toBe(CHECK_VIOLATION);
  });

  it("increments generation and requires audit fields for canary pointer changes", async () => {
    const profile = await createProfileVersion("activate", "canary");
    const policy = await createPolicy(profile, "activate", "canary");
    const { data: before } = await service
      .from("ai_feature_config")
      .select("config_generation")
      .eq("id", true)
      .single();

    const missingAudit = await service
      .from("ai_feature_config")
      .update({ active_routing_policy_version_id: policy.id })
      .eq("id", true);
    expect(missingAudit.error?.code).toBe(CHECK_VIOLATION);

    const activation = await service
      .from("ai_feature_config")
      .update({
        active_routing_policy_version_id: policy.id,
        routing_updated_by: "provider-routing-test",
        routing_change_reason: `activate canary fixture ${crypto.randomUUID()}`,
      })
      .eq("id", true)
      .select("active_routing_policy_version_id,config_generation,routing_updated_at")
      .single();
    expect(activation.error).toBeNull();
    expect(activation.data?.active_routing_policy_version_id).toBe(policy.id);
    expect(Number(activation.data?.config_generation)).toBe(
      Number(before?.config_generation) + 1,
    );
    expect(activation.data?.routing_updated_at).toBeTruthy();

    const spoofGeneration = await service
      .from("ai_feature_config")
      .update({ config_generation: Number(activation.data?.config_generation) + 10 })
      .eq("id", true);
    expect(spoofGeneration.error?.code).toBe(CHECK_VIOLATION);

    const rewriteAuditWithoutPointerChange = await service
      .from("ai_feature_config")
      .update({
        routing_updated_by: "different-actor",
        routing_change_reason: "rewrite audit without changing pointer",
        routing_updated_at: "2026-01-01T00:00:00Z",
      })
      .eq("id", true);
    expect(rewriteAuditWithoutPointerChange.error?.code).toBe(CHECK_VIOLATION);

    const deactivate = await service
      .from("ai_feature_config")
      .update({
        active_routing_policy_version_id: null,
        routing_updated_by: "provider-routing-test",
        routing_change_reason: `restore inactive fixture ${crypto.randomUUID()}`,
      })
      .eq("id", true)
      .select("active_routing_policy_version_id,config_generation")
      .single();
    expect(deactivate.error).toBeNull();
    expect(deactivate.data?.active_routing_policy_version_id).toBeNull();
    expect(Number(deactivate.data?.config_generation)).toBe(
      Number(activation.data?.config_generation) + 1,
    );
  });

  it("makes policy execution fields immutable", async () => {
    const profile = await createProfileVersion("immutable-policy", "validated");
    const policy = await createPolicy(profile, "immutable-policy", "validated");

    const mutate = await service
      .from("ai_routing_policy_versions")
      .update({ rules: { changed: true } })
      .eq("id", policy.id);
    expect(mutate.error?.code).toBe(CHECK_VIOLATION);

    const backwards = await service
      .from("ai_routing_policy_versions")
      .update({ status: "draft" })
      .eq("id", policy.id);
    expect(backwards.error?.code).toBe(CHECK_VIOLATION);
  });

  it("clamps policy lifecycle timestamps to monotonic row time", async () => {
    const profile = await createProfileVersion("policy-clock-clamp", "validated");
    const futureCreatedAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const { data: policy, error: insertError } = await service
      .from("ai_routing_policy_versions")
      .insert({
        policy_key: `test.routing.policy-clock-clamp.${crypto.randomUUID()}`,
        version: 1,
        status: "draft",
        timezone: "Asia/Shanghai",
        rules: strictRules(profile),
        default_profile_version_id: profile.id,
        legal_bundle_version: legalBundleVersion,
        runtime_contract_id: profile.runtime.runtimeContractId,
        runtime_contract_sha256: profile.runtime.runtimeContractSha256,
        config_sha256: "f".repeat(64),
        created_at: futureCreatedAt,
      })
      .select("id,created_at")
      .single();
    expect(insertError).toBeNull();

    const validated = await service
      .from("ai_routing_policy_versions")
      .update({ status: "validated" })
      .eq("id", policy!.id)
      .select("created_at,validated_at")
      .single();
    expect(validated.error).toBeNull();
    expect(Date.parse(validated.data!.validated_at!)).toBeGreaterThanOrEqual(
      Date.parse(validated.data!.created_at),
    );

    const profileActive = await service
      .from("ai_provider_profile_versions")
      .update({ status: "active" })
      .eq("id", profile.id);
    expect(profileActive.error).toBeNull();
    const active = await service
      .from("ai_routing_policy_versions")
      .update({ status: "active" })
      .eq("id", policy!.id)
      .select("created_at,validated_at,activated_at")
      .single();
    expect(active.error).toBeNull();
    expect(Date.parse(active.data!.activated_at!)).toBeGreaterThanOrEqual(
      Date.parse(active.data!.validated_at!),
    );

    const retired = await service
      .from("ai_routing_policy_versions")
      .update({ status: "retired" })
      .eq("id", policy!.id)
      .select("created_at,validated_at,activated_at,retired_at")
      .single();
    expect(retired.error).toBeNull();
    expect(Date.parse(retired.data!.retired_at!)).toBeGreaterThanOrEqual(
      Date.parse(retired.data!.activated_at!),
    );
  });
});
