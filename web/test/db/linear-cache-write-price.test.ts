import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { createServiceClient, RUN_DB_TESTS } from "./helpers";
import { runOwnerSql, sealPriceAsDatabaseOwner } from "./runtime-contract-fixtures";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REQUIRED_COMPONENTS = [
  "input_standard",
  "input_cache_read",
  "output",
] as const;

describe.skipIf(!RUN_DB_TESTS)("optional linear cache-write pricing (real DB)", () => {
  let service: SupabaseClient;

  beforeAll(() => {
    service = createServiceClient();
  });

  async function createPrice(
    label: string,
    components: readonly { component: string; nanosPerMillion: number }[],
  ): Promise<string> {
    const { data: profile, error: profileError } = await service
      .from("ai_provider_profiles")
      .insert({
        profile_key: `test.linear-cache-write.${label}.${crypto.randomUUID()}`,
        display_name: `Linear cache write ${label}`,
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
        adapter_kind: "fixture_adapter_v1",
        wire_api_kind: "responses_v1",
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

    const { data: price, error: priceError } = await service
      .from("ai_price_versions")
      .insert({
        profile_version_id: version!.id,
        pricing_lane: "default",
        version: 1,
        currency: "CNY",
        calculator_kind: "linear_token_v1",
        valid_from: "2026-08-25T00:00:00Z",
        valid_to: null,
        source_url: "https://example.com/linear-cache-write-fixture",
        source_checked_at: "2026-08-25T00:00:00Z",
        source_snapshot_sha256: "b".repeat(64),
        parameters: {},
      })
      .select("id")
      .single();
    expect(priceError).toBeNull();
    expect(price!.id).toMatch(UUID);

    const { error: componentsError } = await service.from("ai_price_components").insert(
      components.map(({ component, nanosPerMillion }) => ({
        price_version_id: price!.id,
        component,
        nanos_per_million: nanosPerMillion,
      })),
    );
    expect(componentsError).toBeNull();
    return price!.id as string;
  }

  async function expectSealed(priceId: string): Promise<void> {
    const { data, error } = await service
      .from("ai_price_versions")
      .select("components_sealed_at")
      .eq("id", priceId)
      .single();
    expect(error).toBeNull();
    expect(data?.components_sealed_at).toBeTruthy();
  }

  async function expectUnsealed(priceId: string): Promise<void> {
    const { data, error } = await service
      .from("ai_price_versions")
      .select("components_sealed_at")
      .eq("id", priceId)
      .single();
    expect(error).toBeNull();
    expect(data?.components_sealed_at).toBeNull();
  }

  function expectOwnerSealFailure(priceId: string): void {
    expect(priceId).toMatch(UUID);
    const result = runOwnerSql(
      `select public.seal_ai_price_components_v1(
         array['${priceId}'::uuid],
         greatest(
           pg_catalog.clock_timestamp(),
           (select created_at from public.ai_price_versions where id = '${priceId}'::uuid)
         )
       );`,
      { expectFailure: true },
    );
    expect(result.stderr).toContain(
      "linear_token_v1 requires input_standard, input_cache_read, and output",
    );
  }

  it.each([
    ["legacy-three-bucket", null],
    ["explicit-free-write", 0],
    ["priced-write", 250_000_000],
  ] as const)("seals %s linear prices", async (label, cacheWriteNanos) => {
    const components: { component: string; nanosPerMillion: number }[] =
      REQUIRED_COMPONENTS.map((component, index) => ({
        component,
        nanosPerMillion: (index + 1) * 100,
      }));
    if (cacheWriteNanos !== null) {
      components.push({
        component: "input_cache_write",
        nanosPerMillion: cacheWriteNanos,
      });
    }
    const priceId = await createPrice(label, components);

    sealPriceAsDatabaseOwner(priceId);

    await expectSealed(priceId);
    const { data: stored, error } = await service
      .from("ai_price_components")
      .select("component,nanos_per_million")
      .eq("price_version_id", priceId)
      .order("component");
    expect(error).toBeNull();
    expect(stored).toHaveLength(cacheWriteNanos === null ? 3 : 4);
    if (cacheWriteNanos !== null) {
      expect(stored).toContainEqual({
        component: "input_cache_write",
        nanos_per_million: cacheWriteNanos,
      });
    }
  });

  it.each(REQUIRED_COMPONENTS)(
    "rejects a cache-write price that omits required %s",
    async (missing) => {
      const components: { component: string; nanosPerMillion: number }[] =
        REQUIRED_COMPONENTS.filter((component) => component !== missing).map(
          (component, index) => ({
            component,
            nanosPerMillion: (index + 1) * 100,
          }),
        );
      components.push({ component: "input_cache_write", nanosPerMillion: 0 });
      const priceId = await createPrice(`missing-${missing}`, components);

      expectOwnerSealFailure(priceId);

      await expectUnsealed(priceId);
    },
  );
});
