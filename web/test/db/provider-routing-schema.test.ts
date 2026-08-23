import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServiceClient, RUN_DB_TESTS } from "./helpers";

const CHECK_VIOLATION = "23514";

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
          routing_change_reason: "restore inactive routing pointer",
        })
        .eq("id", true);
    }
  });

  async function createProfileVersion(label: string, status: "draft" | "validated") {
    const { data: profile, error: profileError } = await service
      .from("ai_provider_profiles")
      .insert({
        profile_key: `test.routing.${label}.${crypto.randomUUID()}`,
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
        status,
        adapter_kind: "fixture_adapter_v1",
        wire_api_kind: "responses_v1",
        credential_alias: "fixture_credential_v1",
        endpoint_alias: "fixture_endpoint_v1",
        model_id: "fixture-model",
        upstream_route: {},
        capability_contract_id: "fixture_capability_v1",
        cache_policy_id: "fixture_cache_v1",
        legal_manifest_id: "fixture_legal_v1",
        config: {},
        config_sha256: "d".repeat(64),
      })
      .select("id,status,validated_at")
      .single();
    expect(versionError).toBeNull();
    return version!;
  }

  async function createPolicy(
    profileVersionId: string,
    label: string,
    status: "draft" | "validated",
    legalVersion = legalBundleVersion,
  ) {
    const { data, error } = await service
      .from("ai_routing_policy_versions")
      .insert({
        policy_key: `test.routing.${label}.${crypto.randomUUID()}`,
        version: 1,
        status,
        timezone: "Asia/Shanghai",
        rules: { kind: "fixture_default_only_v1" },
        default_profile_version_id: profileVersionId,
        legal_bundle_version: legalVersion,
        config_sha256: "e".repeat(64),
      })
      .select("*")
      .single();
    expect(error).toBeNull();
    return data!;
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
        rules: {},
        default_profile_version_id: profile.id,
        legal_bundle_version: legalBundleVersion,
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
        config_sha256: "e".repeat(64),
      });
    expect(invalidRules.error?.code).toBe(CHECK_VIOLATION);
  });

  it("fails closed for draft profiles, draft policies, or stale legal bundles", async () => {
    const draftProfile = await createProfileVersion("draft-profile", "draft");
    const validatedPolicy = await createPolicy(
      draftProfile.id,
      "draft-profile",
      "validated",
    );
    const draftProfileActivation = await service
      .from("ai_feature_config")
      .update({
        active_routing_policy_version_id: validatedPolicy.id,
        routing_updated_by: "provider-routing-test",
        routing_change_reason: "prove draft profile rejection",
      })
      .eq("id", true);
    expect(draftProfileActivation.error?.code).toBe(CHECK_VIOLATION);

    const validatedProfile = await createProfileVersion("draft-policy", "validated");
    const draftPolicy = await createPolicy(
      validatedProfile.id,
      "draft-policy",
      "draft",
    );
    const draftPolicyActivation = await service
      .from("ai_feature_config")
      .update({
        active_routing_policy_version_id: draftPolicy.id,
        routing_updated_by: "provider-routing-test",
        routing_change_reason: "prove draft policy rejection",
      })
      .eq("id", true);
    expect(draftPolicyActivation.error?.code).toBe(CHECK_VIOLATION);

    const staleLegalPolicy = await createPolicy(
      validatedProfile.id,
      "stale-legal",
      "validated",
      "2026-08-04",
    );
    const staleLegalActivation = await service
      .from("ai_feature_config")
      .update({
        active_routing_policy_version_id: staleLegalPolicy.id,
        routing_updated_by: "provider-routing-test",
        routing_change_reason: "prove exact legal bundle rejection",
      })
      .eq("id", true);
    expect(staleLegalActivation.error?.code).toBe(CHECK_VIOLATION);
  });

  it("increments generation and requires audit fields for pointer changes", async () => {
    const profile = await createProfileVersion("activate", "validated");
    const policy = await createPolicy(profile.id, "activate", "validated");
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
        routing_change_reason: "activate validated fixture",
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

    const deactivate = await service
      .from("ai_feature_config")
      .update({
        active_routing_policy_version_id: null,
        routing_updated_by: "provider-routing-test",
        routing_change_reason: "restore inactive fixture",
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
    const policy = await createPolicy(profile.id, "immutable-policy", "validated");

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
});
