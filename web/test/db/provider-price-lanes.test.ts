import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { createServiceClient, RUN_DB_TESTS } from "./helpers";
import { authorSyntheticRuntimeContract } from "./runtime-contract-fixtures";

const CHECK_VIOLATION = "23514";
const EXCLUSION_VIOLATION = "23P01";
const NOT_NULL_VIOLATION = "23502";

describe.skipIf(!RUN_DB_TESTS)("provider price lanes and provenance (real DB)", () => {
  let service: SupabaseClient;

  beforeAll(() => {
    service = createServiceClient();
  });

  async function createProfileVersion(label: string): Promise<string> {
    const { data: profile, error: profileError } = await service
      .from("ai_provider_profiles")
      .insert({
        profile_key: `test.price-lane.${label}.${crypto.randomUUID()}`,
        display_name: `Price lane ${label}`,
        gateway_kind: "direct_deepseek",
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
        adapter_kind: "fixture_adapter_v1",
        wire_api_kind: "chat_completions_v1",
        credential_alias: "fixture_credential_v1",
        endpoint_alias: "fixture_endpoint_v1",
        model_id: "fixture-model",
        capability_contract_id: "fixture_capability_v1",
        cache_policy_id: "fixture_cache_v1",
        legal_manifest_id: "fixture_legal_v1",
        display_disclosure_key: "fixture-v1",
        config_sha256: "a".repeat(64),
      })
      .select("id")
      .single();
    expect(versionError).toBeNull();
    return version!.id as string;
  }

  function priceFixture(
    profileVersionId: string,
    pricingLane: string,
    version = 1,
  ) {
    return {
      profile_version_id: profileVersionId,
      pricing_lane: pricingLane,
      version,
      currency: "CNY",
      calculator_kind: "linear_token_v1",
      valid_from: "2026-08-24T00:00:00Z",
      valid_to: "2026-12-01T00:00:00Z",
      source_url: "https://example.com/price-lane-fixture",
      source_checked_at: "2026-08-24T00:00:00Z",
      source_snapshot_sha256: "b".repeat(64),
      parameters: {},
    };
  }

  it("requires an explicit, canonical pricing lane after migration", async () => {
    const profileVersionId = await createProfileVersion("required");
    const fixture = priceFixture(profileVersionId, "default");
    const withoutLane = { ...fixture } as Partial<typeof fixture>;
    delete withoutLane.pricing_lane;

    const missing = await service.from("ai_price_versions").insert(withoutLane);
    expect(missing.error?.code).toBe(NOT_NULL_VIOLATION);

    const explicitNull = await service
      .from("ai_price_versions")
      .insert({ ...fixture, pricing_lane: null });
    expect(explicitNull.error?.code).toBe(NOT_NULL_VIOLATION);

    for (const invalidLane of ["", "Peak", " peak", "peak/window", "-peak"]) {
      const invalid = await service.from("ai_price_versions").insert({
        ...fixture,
        pricing_lane: invalidLane,
      });
      expect(invalid.error?.code, invalidLane).toBe(CHECK_VIOLATION);
    }

    const valid = await service
      .from("ai_price_versions")
      .insert({ ...fixture, pricing_lane: "peak.weekday-v1" });
    expect(valid.error).toBeNull();
  });

  it("partitions identity and overlap checks by profile plus lane", async () => {
    const profileVersionId = await createProfileVersion("overlap");
    const offpeak = priceFixture(profileVersionId, "offpeak");
    expect((await service.from("ai_price_versions").insert(offpeak)).error).toBeNull();

    const sameLaneOverlap = await service.from("ai_price_versions").insert({
      ...offpeak,
      version: 2,
      valid_from: "2026-09-01T00:00:00Z",
      valid_to: "2027-01-01T00:00:00Z",
    });
    expect(sameLaneOverlap.error?.code).toBe(EXCLUSION_VIOLATION);

    const otherLaneOverlap = await service.from("ai_price_versions").insert({
      ...offpeak,
      pricing_lane: "peak",
    });
    expect(otherLaneOverlap.error).toBeNull();

    const duplicateLaneVersion = await service.from("ai_price_versions").insert({
      ...offpeak,
      valid_from: "2027-01-01T00:00:00Z",
      valid_to: "2027-02-01T00:00:00Z",
    });
    expect(duplicateLaneVersion.error?.code).toBe("23505");
  });

  it("keeps nullable provider-effective provenance distinct and immutable", async () => {
    const unknownProfile = await createProfileVersion("provenance-unknown");
    const { data: unknown, error: unknownError } = await service
      .from("ai_price_versions")
      .insert(priceFixture(unknownProfile, "default"))
      .select("id,provider_effective_from,provider_effective_to")
      .single();
    expect(unknownError).toBeNull();
    expect(unknown).toMatchObject({
      provider_effective_from: null,
      provider_effective_to: null,
    });

    const endOnlyProfile = await createProfileVersion("provenance-end-only");
    const endOnly = await service.from("ai_price_versions").insert({
      ...priceFixture(endOnlyProfile, "default"),
      provider_effective_to: "2026-08-24T00:00:00Z",
    });
    expect(endOnly.error).toBeNull();

    const invalidProfile = await createProfileVersion("provenance-invalid");
    const invalidRange = await service.from("ai_price_versions").insert({
      ...priceFixture(invalidProfile, "default"),
      provider_effective_from: "2026-08-25T00:00:00Z",
      provider_effective_to: "2026-08-24T00:00:00Z",
    });
    expect(invalidRange.error?.code).toBe(CHECK_VIOLATION);

    const mutate = await service
      .from("ai_price_versions")
      .update({ provider_effective_from: "2026-08-01T00:00:00Z" })
      .eq("id", unknown!.id);
    expect(mutate.error?.code).toBe(CHECK_VIOLATION);
  });

  it("allows component authoring on drafts but rejects unsealed request snapshots", async () => {
    const runtime = authorSyntheticRuntimeContract();
    const profileVersionId = await createProfileVersion("unsealed");
    const { data: price, error: priceError } = await service
      .from("ai_price_versions")
      .insert(priceFixture(profileVersionId, "default"))
      .select("id,components_sealed_at")
      .single();
    expect(priceError).toBeNull();
    expect(price?.components_sealed_at).toBeNull();

    const component = await service.from("ai_price_components").insert({
      price_version_id: price!.id,
      component: "input_standard",
      nanos_per_million: 1,
    });
    expect(component.error).toBeNull();

    const request = await service.from("ai_request_ledger").insert({
      request_id: crypto.randomUUID(),
      client_request_id: crypto.randomUUID(),
      user_id: crypto.randomUUID(),
      route_schema_version: "route_snapshot_v1",
      config_generation: 1,
      routing_policy_version_id: crypto.randomUUID(),
      profile_version_id: profileVersionId,
      price_version_id: price!.id,
      legal_bundle_version: "fixture-v1",
      runtime_contract_id: runtime.runtimeContractId,
      runtime_contract_sha256: runtime.runtimeContractSha256,
      gateway_kind: "direct_deepseek",
      model_id: "fixture-model",
      wire_api_kind: "chat_completions_v1",
      display_disclosure_key: "fixture-v1",
    });
    expect(request.error?.code).toBe(CHECK_VIOLATION);

    const { data: stillDraft, error: readError } = await service
      .from("ai_price_versions")
      .select("components_sealed_at")
      .eq("id", price!.id)
      .single();
    expect(readError).toBeNull();
    expect(stillDraft?.components_sealed_at).toBeNull();
  });
});
