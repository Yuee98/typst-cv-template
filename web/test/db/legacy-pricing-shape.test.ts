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
import { runOwnerSql, sealPriceAsDatabaseOwner } from "./runtime-contract-fixtures";

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

    const profileId = crypto.randomUUID();
    profileVersionId = crypto.randomUUID();
    priceVersionId = crypto.randomUUID();
    policyVersionId = crypto.randomUUID();
    const suffix = crypto.randomUUID();
    runOwnerSql(`begin;
      insert into public.ai_provider_profiles(id,profile_key,display_name,gateway_kind,model_vendor)
        values ('${profileId}'::uuid,'test.legacy-pricing.${suffix}','Legacy pricing fixture','direct_deepseek','fixture');
      insert into public.ai_provider_profile_versions(id,profile_id,version,adapter_kind,wire_api_kind,credential_alias,endpoint_alias,model_id,capability_contract_id,cache_policy_id,legal_manifest_id,config_sha256)
        values ('${profileVersionId}'::uuid,'${profileId}'::uuid,1,'fixture_adapter_v1','chat_completions_v1','fixture_credential_v1','fixture_endpoint_v1','fixture-model','fixture_capability_v1','fixture_cache_v1','fixture_legal_v1','${"c".repeat(64)}');
      insert into public.ai_price_versions(id,profile_version_id,pricing_lane,version,currency,calculator_kind,valid_from,valid_to,source_url,source_checked_at,source_snapshot_sha256)
        values ('${priceVersionId}'::uuid,'${profileVersionId}'::uuid,'legacy',1,'CNY','linear_token_v1','2026-01-01T00:00:00Z','2026-08-24T00:00:00Z','https://example.com/legacy-pricing-fixture','2026-08-24T00:00:00Z','${"d".repeat(64)}');
      insert into public.ai_price_components(price_version_id,component,nanos_per_million) values
        ('${priceVersionId}'::uuid,'input_cache_read',20000000),('${priceVersionId}'::uuid,'input_standard',1000000000),('${priceVersionId}'::uuid,'output',2000000000);
      insert into public.ai_routing_policy_versions(id,policy_key,version,timezone,rules,default_profile_version_id,legal_bundle_version,config_sha256)
        values ('${policyVersionId}'::uuid,'test.legacy-pricing.${suffix}',1,'Asia/Shanghai','{}'::jsonb,'${profileVersionId}'::uuid,'fixture-v1','${"e".repeat(64)}');
      commit;`);

    sealPriceAsDatabaseOwner(priceVersionId);

    const { data: sealedPrice, error: sealedPriceError } = await service
      .from("ai_price_versions")
      .select("components_sealed_at")
      .eq("id", priceVersionId)
      .single();
    expect(sealedPriceError).toBeNull();
    expect(sealedPrice?.components_sealed_at).toBeTruthy();
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

  it("rejects direct service-role promotion of a bare row to historical pricing", async () => {
    const { data: row, error: rowError } = await service
      .from("ai_request_ledger")
      .insert(identity())
      .select("reservation_id")
      .single();
    expect(rowError).toBeNull();

    const directHistoricalBinding = await service
      .from("ai_request_ledger")
      .update(exactLegacyShape())
      .eq("reservation_id", row!.reservation_id);
    expect(directHistoricalBinding.error?.code).toBe(CHECK_VIOLATION);
    expect(directHistoricalBinding.error?.message).toContain(
      "legacy pricing bindings cannot be created by direct ledger writes",
    );

    const unchanged = await service
      .from("ai_request_ledger")
      .select("route_schema_version,profile_version_id,price_version_id")
      .eq("reservation_id", row!.reservation_id)
      .single();
    expect(unchanged.error).toBeNull();
    expect(unchanged.data).toEqual({
      route_schema_version: null,
      profile_version_id: null,
      price_version_id: null,
    });
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
