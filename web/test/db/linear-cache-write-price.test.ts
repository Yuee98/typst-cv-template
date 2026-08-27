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
    const profileId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const priceId = crypto.randomUUID();
    const profileKey = `test.linear-cache-write.${label}.${profileId}`;
    const componentSql = components
      .map(({ component, nanosPerMillion }) =>
        `('${priceId}'::uuid, '${component}', ${nanosPerMillion})`,
      )
      .join(",");
    runOwnerSql(`begin;
      insert into public.ai_provider_profiles(id,profile_key,display_name,gateway_kind,model_vendor)
        values ('${profileId}'::uuid,'${profileKey}','Linear cache write ${label}','direct_mimo','fixture');
      insert into public.ai_provider_profile_versions(id,profile_id,version,adapter_kind,wire_api_kind,credential_alias,endpoint_alias,model_id,capability_contract_id,cache_policy_id,legal_manifest_id,display_disclosure_key,config_sha256)
        values ('${versionId}'::uuid,'${profileId}'::uuid,1,'fixture_adapter_v1','responses_v1','fixture_credential_v1','fixture_endpoint_v1','fixture-model','fixture_capability_v1','fixture_cache_v1','fixture_legal_v1','fixture-v1','${"a".repeat(64)}');
      insert into public.ai_price_versions(id,profile_version_id,pricing_lane,version,currency,calculator_kind,valid_from,source_url,source_checked_at,source_snapshot_sha256,parameters)
        values ('${priceId}'::uuid,'${versionId}'::uuid,'default',1,'CNY','linear_token_v1','2026-08-25T00:00:00Z','https://example.com/linear-cache-write-fixture','2026-08-25T00:00:00Z','${"b".repeat(64)}','{}'::jsonb);
      insert into public.ai_price_components(price_version_id,component,nanos_per_million) values ${componentSql};
      commit;`);
    expect(priceId).toMatch(UUID);
    return priceId;
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
