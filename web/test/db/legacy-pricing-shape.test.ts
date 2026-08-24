import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  configureFeature,
  createServiceClient,
  createTestUser,
  deleteTestUser,
  FEATURE_CONFIG_DEFAULTS,
  RUN_DB_TESTS,
  type TestUser,
} from "./helpers";
import { sealPriceAsDatabaseOwner } from "./runtime-contract-fixtures";

const CHECK_VIOLATION = "23514";

describe.skipIf(!RUN_DB_TESTS)("legacy pricing request discriminator (real DB)", () => {
  let service: SupabaseClient;
  let user: TestUser;
  let profileVersionId: string;
  let priceVersionId: string;
  let policyVersionId: string;

  beforeAll(async () => {
    service = createServiceClient();
    user = await createTestUser(service, "legacy-pricing-shape");

    const { data: profile, error: profileError } = await service
      .from("ai_provider_profiles")
      .insert({
        profile_key: `test.legacy-pricing.${crypto.randomUUID()}`,
        display_name: "Legacy pricing fixture",
        gateway_kind: "direct_deepseek",
        model_vendor: "fixture",
      })
      .select("id")
      .single();
    expect(profileError).toBeNull();

    const { data: profileVersion, error: profileVersionError } = await service
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
        config_sha256: "c".repeat(64),
      })
      .select("id")
      .single();
    expect(profileVersionError).toBeNull();
    profileVersionId = profileVersion!.id as string;

    const { data: price, error: priceError } = await service
      .from("ai_price_versions")
      .insert({
        profile_version_id: profileVersionId,
        pricing_lane: "legacy",
        version: 1,
        currency: "CNY",
        calculator_kind: "linear_token_v1",
        valid_from: "2026-01-01T00:00:00Z",
        valid_to: "2026-08-24T00:00:00Z",
        source_url: "https://example.com/legacy-pricing-fixture",
        source_checked_at: "2026-08-24T00:00:00Z",
        source_snapshot_sha256: "d".repeat(64),
      })
      .select("id")
      .single();
    expect(priceError).toBeNull();
    priceVersionId = price!.id as string;

    const components = await service.from("ai_price_components").insert([
      {
        price_version_id: priceVersionId,
        component: "input_cache_read",
        nanos_per_million: 20_000_000,
      },
      {
        price_version_id: priceVersionId,
        component: "input_standard",
        nanos_per_million: 1_000_000_000,
      },
      {
        price_version_id: priceVersionId,
        component: "output",
        nanos_per_million: 2_000_000_000,
      },
    ]);
    expect(components.error).toBeNull();

    sealPriceAsDatabaseOwner(priceVersionId);

    const { data: sealedPrice, error: sealedPriceError } = await service
      .from("ai_price_versions")
      .select("components_sealed_at")
      .eq("id", priceVersionId)
      .single();
    expect(sealedPriceError).toBeNull();
    expect(sealedPrice?.components_sealed_at).toBeTruthy();

    const { data: policy, error: policyError } = await service
      .from("ai_routing_policy_versions")
      .insert({
        policy_key: `test.legacy-pricing.${crypto.randomUUID()}`,
        version: 1,
        timezone: "Asia/Shanghai",
        rules: {},
        default_profile_version_id: profileVersionId,
        legal_bundle_version: "fixture-v1",
        config_sha256: "e".repeat(64),
      })
      .select("id")
      .single();
    expect(policyError).toBeNull();
    policyVersionId = policy!.id as string;
  });

  afterAll(async () => {
    await configureFeature(service, FEATURE_CONFIG_DEFAULTS);
    await deleteTestUser(service, user.id);
  });

  function identity() {
    return {
      request_id: crypto.randomUUID(),
      client_request_id: crypto.randomUUID(),
      user_id: user.id,
    };
  }

  function exactLegacyShape() {
    return {
      route_schema_version: "legacy_pricing_v1",
      profile_version_id: profileVersionId,
      price_version_id: priceVersionId,
      config_generation: null,
      routing_policy_version_id: null,
      legal_bundle_version: null,
      gateway_kind: null,
      model_id: null,
      wire_api_kind: null,
      display_disclosure_key: null,
      usage_schema_version: "legacy_v1",
      cost_basis: "legacy_request_aggregate",
    };
  }

  it("rejects reservation INSERT creation of the legacy discriminator", async () => {
    const directInsert = await service.from("ai_request_ledger").insert({
      ...identity(),
      ...exactLegacyShape(),
    });
    expect(directInsert.error?.code).toBe(CHECK_VIOLATION);
  });

  it("rejects partial or fabricated current-route facts", async () => {
    const { data: row, error: rowError } = await service
      .from("ai_request_ledger")
      .insert(identity())
      .select("reservation_id")
      .single();
    expect(rowError).toBeNull();

    const partialUsage = await service
      .from("ai_request_ledger")
      .update({
        ...exactLegacyShape(),
        usage_schema_version: null,
      })
      .eq("reservation_id", row!.reservation_id);
    expect(partialUsage.error?.code).toBe(CHECK_VIOLATION);
    expect(partialUsage.error?.message).toContain(
      "ai_request_ledger_legacy_pricing_shape_check",
    );

    const partialCost = await service
      .from("ai_request_ledger")
      .update({
        ...exactLegacyShape(),
        cost_basis: null,
      })
      .eq("reservation_id", row!.reservation_id);
    expect(partialCost.error?.code).toBe(CHECK_VIOLATION);
    expect(partialCost.error?.message).toContain(
      "ai_request_ledger_legacy_pricing_shape_check",
    );

    for (const fabricated of [
      { config_generation: 1 },
      { routing_policy_version_id: crypto.randomUUID() },
      { legal_bundle_version: "fabricated-v1" },
      { gateway_kind: "direct_deepseek" },
      { model_id: "fixture-model" },
      { wire_api_kind: "chat_completions_v1" },
      { display_disclosure_key: "fixture-v1" },
    ]) {
      const result = await service
        .from("ai_request_ledger")
        .update({ ...exactLegacyShape(), ...fabricated })
        .eq("reservation_id", row!.reservation_id);
      expect(result.error?.code, JSON.stringify(fabricated)).toBe(CHECK_VIOLATION);
    }
  });

  it("accepts only the complete sealed historical shape and freezes its binding", async () => {
    const { data: row, error: rowError } = await service
      .from("ai_request_ledger")
      .insert(identity())
      .select("reservation_id")
      .single();
    expect(rowError).toBeNull();

    const completeBinding = await service
      .from("ai_request_ledger")
      .update(exactLegacyShape())
      .eq("reservation_id", row!.reservation_id)
      .select(
        "route_schema_version,profile_version_id,price_version_id,usage_schema_version,cost_basis",
      )
      .single();
    expect(completeBinding.error).toBeNull();
    expect(completeBinding.data).toEqual({
      route_schema_version: "legacy_pricing_v1",
      profile_version_id: profileVersionId,
      price_version_id: priceVersionId,
      usage_schema_version: "legacy_v1",
      cost_basis: "legacy_request_aggregate",
    });

    const mutateBinding = await service
      .from("ai_request_ledger")
      .update({ profile_version_id: crypto.randomUUID() })
      .eq("reservation_id", row!.reservation_id);
    expect(mutateBinding.error?.code).toBe(CHECK_VIOLATION);
    expect(mutateBinding.error?.message).toContain(
      "ai_request_ledger route binding is immutable once frozen",
    );
  });

  it("treats a NULL route discriminator with all current facts as invalid", async () => {
    const invalid = await service.from("ai_request_ledger").insert({
      ...identity(),
      route_schema_version: null,
      config_generation: 1,
      routing_policy_version_id: policyVersionId,
      profile_version_id: profileVersionId,
      price_version_id: priceVersionId,
      legal_bundle_version: "fixture-v1",
      gateway_kind: "direct_deepseek",
      model_id: "fixture-model",
      wire_api_kind: "chat_completions_v1",
      display_disclosure_key: "fixture-v1",
    });
    expect(invalid.error?.code).toBe(CHECK_VIOLATION);
    expect(invalid.error?.message).toContain(
      "ai_request_ledger_route_snapshot_check",
    );
  });

  it("keeps Reserve V1 byte-compatible and unable to create legacy pricing", async () => {
    await configureFeature(service, {
      enabled: true,
      globalDailyLimit: 2_000,
      allowlist: [],
    });

    const reserved = await service.rpc("reserve_ai_polish_request", {
      p_user_id: user.id,
      p_request_id: crypto.randomUUID(),
      p_client_request_id: crypto.randomUUID(),
    });
    expect(reserved.error).toBeNull();
    expect(reserved.data).toMatchObject({ allowed: true });

    const { data: ledger, error: ledgerError } = await service
      .from("ai_request_ledger")
      .select(
        "route_schema_version,profile_version_id,price_version_id,config_generation,routing_policy_version_id,legal_bundle_version",
      )
      .eq("reservation_id", reserved.data.reservationId)
      .single();
    expect(ledgerError).toBeNull();
    expect(ledger).toEqual({
      route_schema_version: null,
      profile_version_id: null,
      price_version_id: null,
      config_generation: null,
      routing_policy_version_id: null,
      legal_bundle_version: null,
    });
  });
});
