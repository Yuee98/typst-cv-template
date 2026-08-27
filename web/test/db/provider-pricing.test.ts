import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { createServiceClient, RUN_DB_TESTS } from "./helpers";
import { runOwnerSql } from "./runtime-contract-fixtures";

const CHECK_VIOLATION = "23514";
const EXCLUSION_VIOLATION = "23P01";

describe.skipIf(!RUN_DB_TESTS)("provider native-currency pricing (real DB)", () => {
  let service: SupabaseClient;

  beforeAll(() => {
    service = createServiceClient();
  });

  async function createProfileVersion(label: string) {
    const profileId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const suffix = crypto.randomUUID();
    runOwnerSql(`begin;
      insert into public.ai_provider_profiles(id,profile_key,display_name,gateway_kind,model_vendor)
        values ('${profileId}'::uuid,'test.pricing.${label}.${suffix}','Pricing ${label}','direct_deepseek','fixture');
      insert into public.ai_provider_profile_versions(id,profile_id,version,adapter_kind,wire_api_kind,credential_alias,endpoint_alias,model_id,upstream_route,capability_contract_id,cache_policy_id,legal_manifest_id,config,config_sha256)
        values ('${versionId}'::uuid,'${profileId}'::uuid,1,'fixture_adapter_v1','chat_completions_v1','fixture_credential_v1','fixture_endpoint_v1','fixture-model','{}'::jsonb,'fixture_capability_v1','fixture_cache_v1','fixture_legal_v1','{}'::jsonb,'${"b".repeat(64)}');
      commit;`);
    return versionId;
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

  function ownerInsertPrice(fixture: ReturnType<typeof priceFixture>): string {
    const id = crypto.randomUUID();
    const validTo = fixture.valid_to === null ? "null" : `'${fixture.valid_to}'`;
    runOwnerSql(`insert into public.ai_price_versions(id,profile_version_id,pricing_lane,version,currency,calculator_kind,valid_from,valid_to,source_url,source_checked_at,source_snapshot_sha256,parameters)
      values ('${id}'::uuid,'${fixture.profile_version_id}'::uuid,'${fixture.pricing_lane}',${fixture.version},'${fixture.currency}','${fixture.calculator_kind}','${fixture.valid_from}',${validTo},'${fixture.source_url}','${fixture.source_checked_at}','${fixture.source_snapshot_sha256}','{}'::jsonb);`);
    return id;
  }

  function ownerInsertComponents(priceId: string, rows: readonly { component: string; nanos_per_million: number }[]): void {
    runOwnerSql(`insert into public.ai_price_components(price_version_id,component,nanos_per_million) values ${rows.map((row) => `('${priceId}'::uuid,'${row.component}',${row.nanos_per_million})`).join(",")};`);
  }

  function expectOwnerSqlState(sql: string, expectedSqlState: string): void {
    const result = runOwnerSql(
      String.raw`\set VERBOSITY verbose
${sql}`,
      { expectFailure: true },
    );
    expect(result.stderr + result.stdout).toContain(expectedSqlState);
  }

  it("stores the legacy CNY three-bucket and GPT USD four-bucket shapes", async () => {
    const legacyProfile = await createProfileVersion("legacy-cny");
    const legacyPriceId = ownerInsertPrice(priceFixture(legacyProfile,1,"2026-01-01T00:00:00Z","2026-02-01T00:00:00Z"));
    ownerInsertComponents(legacyPriceId, [
      { component: "input_cache_read", nanos_per_million: 20_000_000 },
      { component: "input_standard", nanos_per_million: 1_000_000_000 },
      { component: "output", nanos_per_million: 2_000_000_000 },
    ]);

    const gptProfile = await createProfileVersion("gpt-usd");
    const gptPriceId = ownerInsertPrice(priceFixture(gptProfile,1,"2026-01-01T00:00:00Z",null,"USD"));
    ownerInsertComponents(gptPriceId,
      ["input_standard", "input_cache_read", "input_cache_write", "output"].map(
        (component, index) => ({
          component,
          nanos_per_million: (index + 1) * 100,
        }),
      ),
    );

    const { data: prices, error: priceError } = await service
      .from("ai_price_versions")
      .select("id,currency")
      .in("id", [legacyPriceId, gptPriceId]);
    expect(priceError).toBeNull();
    expect(new Map(prices!.map((price) => [price.id, price.currency]))).toEqual(
      new Map([
        [legacyPriceId, "CNY"],
        [gptPriceId, "USD"],
      ]),
    );

    const { data: components, error: componentError } = await service
      .from("ai_price_components")
      .select("price_version_id,component,nanos_per_million")
      .in("price_version_id", [legacyPriceId, gptPriceId]);
    expect(componentError).toBeNull();
    expect(
      components!.filter(({ price_version_id: id }) => id === legacyPriceId),
    ).toHaveLength(3);
    expect(
      components!.filter(({ price_version_id: id }) => id === gptPriceId),
    ).toHaveLength(4);
    expect(
      components!.find(
        ({ price_version_id: id, component }) =>
          id === gptPriceId && component === "input_cache_write",
      )?.nanos_per_million,
    ).toBe(300);
  });

  it("rejects overlapping effective ranges and accepts adjacent ranges", async () => {
    const profileVersionId = await createProfileVersion("ranges");
    ownerInsertPrice(priceFixture(profileVersionId,1,"2026-01-01T00:00:00Z","2026-02-01T00:00:00Z"));
    expectOwnerSqlState(
      `insert into public.ai_price_versions(profile_version_id,pricing_lane,version,currency,calculator_kind,valid_from,valid_to,source_url,source_checked_at,source_snapshot_sha256,parameters)
      values ('${profileVersionId}'::uuid,'default',2,'CNY','linear_token_v1','2026-01-15T00:00:00Z','2026-03-01T00:00:00Z','https://example.com/pricing-fixture','2026-08-23T00:00:00Z','${"c".repeat(64)}','{}'::jsonb);`,
      EXCLUSION_VIOLATION,
    );
    ownerInsertPrice(priceFixture(profileVersionId,3,"2026-02-01T00:00:00Z","2026-03-01T00:00:00Z"));
  });

  it("keeps price facts immutable while allowing one-time interval closure", async () => {
    const profileVersionId = await createProfileVersion("immutable");
    const priceId = ownerInsertPrice(priceFixture(profileVersionId,1,"2026-01-01T00:00:00Z",null));
    runOwnerSql(`update public.ai_price_versions set valid_to='2026-02-01T00:00:00Z' where id='${priceId}'::uuid;`);
    expectOwnerSqlState(
      `update public.ai_price_versions set valid_to='2026-01-15T00:00:00Z' where id='${priceId}'::uuid;`,
      CHECK_VIOLATION,
    );
    expectOwnerSqlState(
      `update public.ai_price_versions set calculator_kind='changed' where id='${priceId}'::uuid;`,
      CHECK_VIOLATION,
    );
    expectOwnerSqlState(
      `update public.ai_price_versions set components_sealed_at='2026-01-02T00:00:00Z' where id='${priceId}'::uuid;`,
      CHECK_VIOLATION,
    );

    const presealed = priceFixture(await createProfileVersion("presealed"),1,"2026-01-01T00:00:00Z",null);
    expectOwnerSqlState(
      `insert into public.ai_price_versions(profile_version_id,pricing_lane,version,currency,calculator_kind,valid_from,source_url,source_checked_at,source_snapshot_sha256,parameters,components_sealed_at)
      values ('${presealed.profile_version_id}'::uuid,'default',1,'CNY','linear_token_v1','2026-01-01T00:00:00Z','https://example.com/pricing-fixture','2026-08-23T00:00:00Z','${"c".repeat(64)}','{}'::jsonb,'2026-01-02T00:00:00Z');`,
      CHECK_VIOLATION,
    );
  });

  it("rejects unknown or negative price components and component mutation", async () => {
    const profileVersionId = await createProfileVersion("components");
    const priceId = ownerInsertPrice(priceFixture(profileVersionId,1,"2026-01-01T00:00:00Z",null));
    expectOwnerSqlState(
      `insert into public.ai_price_components(price_version_id,component,nanos_per_million) values ('${priceId}'::uuid,'reasoning',1);`,
      CHECK_VIOLATION,
    );
    expectOwnerSqlState(
      `insert into public.ai_price_components(price_version_id,component,nanos_per_million) values ('${priceId}'::uuid,'output',-1);`,
      CHECK_VIOLATION,
    );
    ownerInsertComponents(priceId, [{ component: "output", nanos_per_million: 10 }]);
    expectOwnerSqlState(
      `update public.ai_price_components set nanos_per_million=11 where price_version_id='${priceId}'::uuid and component='output';`,
      CHECK_VIOLATION,
    );
  });
});
