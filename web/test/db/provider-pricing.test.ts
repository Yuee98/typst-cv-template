import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { createServiceClient, RUN_DB_TESTS } from "./helpers";

const CHECK_VIOLATION = "23514";
const EXCLUSION_VIOLATION = "23P01";

describe.skipIf(!RUN_DB_TESTS)("provider native-currency pricing (real DB)", () => {
  let service: SupabaseClient;

  beforeAll(() => {
    service = createServiceClient();
  });

  async function createProfileVersion(label: string) {
    const { data: profile, error: profileError } = await service
      .from("ai_provider_profiles")
      .insert({
        profile_key: `test.pricing.${label}.${crypto.randomUUID()}`,
        display_name: `Pricing ${label}`,
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
        upstream_route: {},
        capability_contract_id: "fixture_capability_v1",
        cache_policy_id: "fixture_cache_v1",
        legal_manifest_id: "fixture_legal_v1",
        config: {},
        config_sha256: "b".repeat(64),
      })
      .select("id")
      .single();
    expect(versionError).toBeNull();
    return version!.id as string;
  }

  function priceFixture(
    profileVersionId: string,
    version: number,
    validFrom: string,
    validTo: string | null,
    currency = "CNY",
  ) {
    return {
      profile_version_id: profileVersionId,
      pricing_lane: "default",
      version,
      currency,
      calculator_kind: "linear_token_v1",
      valid_from: validFrom,
      valid_to: validTo,
      source_url: "https://example.com/pricing-fixture",
      source_checked_at: "2026-08-23T00:00:00Z",
      source_snapshot_sha256: "c".repeat(64),
      parameters: {},
    };
  }

  it("stores the legacy CNY three-bucket and GPT USD four-bucket shapes", async () => {
    const legacyProfile = await createProfileVersion("legacy-cny");
    const { data: legacyPrice, error: legacyPriceError } = await service
      .from("ai_price_versions")
      .insert(
        priceFixture(
          legacyProfile,
          1,
          "2026-01-01T00:00:00Z",
          "2026-02-01T00:00:00Z",
        ),
      )
      .select("id,currency")
      .single();
    expect(legacyPriceError).toBeNull();
    expect(legacyPrice?.currency).toBe("CNY");
    const { error: legacyComponentsError } = await service
      .from("ai_price_components")
      .insert([
        { price_version_id: legacyPrice!.id, component: "input_cache_read", nanos_per_million: 20_000_000 },
        { price_version_id: legacyPrice!.id, component: "input_standard", nanos_per_million: 1_000_000_000 },
        { price_version_id: legacyPrice!.id, component: "output", nanos_per_million: 2_000_000_000 },
      ]);
    expect(legacyComponentsError).toBeNull();

    const gptProfile = await createProfileVersion("gpt-usd");
    const { data: gptPrice, error: gptPriceError } = await service
      .from("ai_price_versions")
      .insert(
        priceFixture(
          gptProfile,
          1,
          "2026-01-01T00:00:00Z",
          null,
          "USD",
        ),
      )
      .select("id,currency")
      .single();
    expect(gptPriceError).toBeNull();
    expect(gptPrice?.currency).toBe("USD");
    const { data: gptComponents, error: gptComponentsError } = await service
      .from("ai_price_components")
      .insert(
        ["input_standard", "input_cache_read", "input_cache_write", "output"].map(
          (component, index) => ({
            price_version_id: gptPrice!.id,
            component,
            nanos_per_million: (index + 1) * 100,
          }),
        ),
      )
      .select("component");
    expect(gptComponentsError).toBeNull();
    expect(gptComponents).toHaveLength(4);
  });

  it("rejects overlapping effective ranges and accepts adjacent ranges", async () => {
    const profileVersionId = await createProfileVersion("ranges");
    const first = await service
      .from("ai_price_versions")
      .insert(
        priceFixture(
          profileVersionId,
          1,
          "2026-01-01T00:00:00Z",
          "2026-02-01T00:00:00Z",
        ),
      );
    expect(first.error).toBeNull();

    const overlap = await service
      .from("ai_price_versions")
      .insert(
        priceFixture(
          profileVersionId,
          2,
          "2026-01-15T00:00:00Z",
          "2026-03-01T00:00:00Z",
        ),
      );
    expect(overlap.error?.code).toBe(EXCLUSION_VIOLATION);

    const adjacent = await service
      .from("ai_price_versions")
      .insert(
        priceFixture(
          profileVersionId,
          3,
          "2026-02-01T00:00:00Z",
          "2026-03-01T00:00:00Z",
        ),
      );
    expect(adjacent.error).toBeNull();
  });

  it("keeps price facts immutable while allowing one-time interval closure", async () => {
    const profileVersionId = await createProfileVersion("immutable");
    const { data: price, error } = await service
      .from("ai_price_versions")
      .insert(
        priceFixture(
          profileVersionId,
          1,
          "2026-01-01T00:00:00Z",
          null,
        ),
      )
      .select("id")
      .single();
    expect(error).toBeNull();

    const close = await service
      .from("ai_price_versions")
      .update({ valid_to: "2026-02-01T00:00:00Z" })
      .eq("id", price!.id);
    expect(close.error).toBeNull();

    const reclose = await service
      .from("ai_price_versions")
      .update({ valid_to: "2026-01-15T00:00:00Z" })
      .eq("id", price!.id);
    expect(reclose.error?.code).toBe(CHECK_VIOLATION);

    const mutate = await service
      .from("ai_price_versions")
      .update({ calculator_kind: "changed", valid_to: "2026-02-01T00:00:00Z" })
      .eq("id", price!.id);
    expect(mutate.error?.code).toBe(CHECK_VIOLATION);

    const directSeal = await service
      .from("ai_price_versions")
      .update({ components_sealed_at: "2026-01-02T00:00:00Z" })
      .eq("id", price!.id);
    expect(directSeal.error?.code).toBe(CHECK_VIOLATION);

    const insertSealed = await service.from("ai_price_versions").insert({
      ...priceFixture(
        await createProfileVersion("presealed"),
        1,
        "2026-01-01T00:00:00Z",
        null,
      ),
      components_sealed_at: "2026-01-02T00:00:00Z",
    });
    expect(insertSealed.error?.code).toBe(CHECK_VIOLATION);
  });

  it("rejects unknown or negative price components and component mutation", async () => {
    const profileVersionId = await createProfileVersion("components");
    const { data: price } = await service
      .from("ai_price_versions")
      .insert(
        priceFixture(
          profileVersionId,
          1,
          "2026-01-01T00:00:00Z",
          null,
        ),
      )
      .select("id")
      .single();

    const unknown = await service.from("ai_price_components").insert({
      price_version_id: price!.id,
      component: "reasoning",
      nanos_per_million: 1,
    });
    expect(unknown.error?.code).toBe(CHECK_VIOLATION);

    const negative = await service.from("ai_price_components").insert({
      price_version_id: price!.id,
      component: "output",
      nanos_per_million: -1,
    });
    expect(negative.error?.code).toBe(CHECK_VIOLATION);

    const { error: insertError } = await service
      .from("ai_price_components")
      .insert({
        price_version_id: price!.id,
        component: "output",
        nanos_per_million: 10,
      });
    expect(insertError).toBeNull();

    const immutable = await service
      .from("ai_price_components")
      .update({ nanos_per_million: 11 })
      .eq("price_version_id", price!.id)
      .eq("component", "output");
    expect(immutable.error?.code).toBe(CHECK_VIOLATION);
  });
});
