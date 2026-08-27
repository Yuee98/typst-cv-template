import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { createServiceClient, RUN_DB_TESTS } from "./helpers";
import { authorSyntheticRuntimeContract, runOwnerSql } from "./runtime-contract-fixtures";

const CHECK_VIOLATION = "23514";
const EXCLUSION_VIOLATION = "23P01";
const NOT_NULL_VIOLATION = "23502";
const PERMISSION_DENIED = "42501";
const UNIQUE_VIOLATION = "23505";

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

describe.skipIf(!RUN_DB_TESTS)("provider price lanes and provenance (real DB)", () => {
  let service: SupabaseClient;

  beforeAll(() => {
    service = createServiceClient();
  });

  async function createProfileVersion(label: string): Promise<string> {
    const profileId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    runOwnerSql(String.raw`
      begin;
      insert into public.ai_provider_profiles (
        id, profile_key, display_name, gateway_kind, model_vendor
      ) values (
        '${profileId}'::uuid,
        ${sqlLiteral(`test.price-lane.${label}.${profileId}`)},
        ${sqlLiteral(`Price lane ${label}`)},
        'direct_deepseek',
        'fixture'
      );
      insert into public.ai_provider_profile_versions (
        id, profile_id, version, adapter_kind, wire_api_kind,
        credential_alias, endpoint_alias, model_id,
        capability_contract_id, cache_policy_id, legal_manifest_id,
        display_disclosure_key, config_sha256
      ) values (
        '${versionId}'::uuid,
        '${profileId}'::uuid,
        1,
        'fixture_adapter_v1',
        'chat_completions_v1',
        'fixture_credential_v1',
        'fixture_endpoint_v1',
        'fixture-model',
        'fixture_capability_v1',
        'fixture_cache_v1',
        'fixture_legal_v1',
        'fixture-v1',
        '${"a".repeat(64)}'
      );
      commit;
    `);
    return versionId;
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

  type PriceFixture = Omit<ReturnType<typeof priceFixture>, "pricing_lane"> & {
    pricing_lane: string | null;
    provider_effective_from?: string;
    provider_effective_to?: string;
  };

  function ownerDomainProbe(sql: string, expectedSqlState?: string) {
    const result = runOwnerSql(
      String.raw`\set VERBOSITY verbose
${sql}`,
      { expectFailure: expectedSqlState !== undefined },
    );
    if (expectedSqlState !== undefined) {
      expect(result.stderr + result.stdout).toContain(expectedSqlState);
    }
    return result;
  }

  function ownerInsertPrice(
    price: PriceFixture,
    options: { omitPricingLane?: boolean; expectedSqlState?: string } = {},
  ): string {
    const id = crypto.randomUUID();
    const validTo = price.valid_to
      ? `${sqlLiteral(price.valid_to)}::timestamptz`
      : "null";
    const effectiveFrom = price.provider_effective_from
      ? `${sqlLiteral(price.provider_effective_from)}::timestamptz`
      : "null";
    const effectiveTo = price.provider_effective_to
      ? `${sqlLiteral(price.provider_effective_to)}::timestamptz`
      : "null";
    const laneColumn = options.omitPricingLane ? "" : ", pricing_lane";
    const laneValue = options.omitPricingLane
      ? ""
      : `, ${price.pricing_lane === null ? "null" : sqlLiteral(price.pricing_lane)}`;
    ownerDomainProbe(
      String.raw`
        insert into public.ai_price_versions (
          id, profile_version_id${laneColumn}, version, currency,
          calculator_kind, valid_from, valid_to, source_url,
          source_checked_at, source_snapshot_sha256, parameters,
          provider_effective_from, provider_effective_to
        ) values (
          '${id}'::uuid,
          '${price.profile_version_id}'::uuid${laneValue},
          ${price.version},
          ${sqlLiteral(price.currency)},
          ${sqlLiteral(price.calculator_kind)},
          ${sqlLiteral(price.valid_from)}::timestamptz,
          ${validTo},
          ${sqlLiteral(price.source_url)},
          ${sqlLiteral(price.source_checked_at)}::timestamptz,
          ${sqlLiteral(price.source_snapshot_sha256)},
          '{}'::jsonb,
          ${effectiveFrom},
          ${effectiveTo}
        );
      `,
      options.expectedSqlState,
    );
    return id;
  }

  it("requires an explicit, canonical pricing lane after migration", async () => {
    const profileVersionId = await createProfileVersion("required");
    const fixture = priceFixture(profileVersionId, "default");
    ownerInsertPrice(fixture, {
      omitPricingLane: true,
      expectedSqlState: NOT_NULL_VIOLATION,
    });

    ownerInsertPrice(
      { ...fixture, pricing_lane: null },
      { expectedSqlState: NOT_NULL_VIOLATION },
    );

    for (const invalidLane of ["", "Peak", " peak", "peak/window", "-peak"]) {
      ownerInsertPrice(
        { ...fixture, pricing_lane: invalidLane },
        { expectedSqlState: CHECK_VIOLATION },
      );
    }

    expect(ownerInsertPrice({ ...fixture, pricing_lane: "peak.weekday-v1" })).toBeTruthy();
  });

  it("partitions identity and overlap checks by profile plus lane", async () => {
    const profileVersionId = await createProfileVersion("overlap");
    const offpeak = priceFixture(profileVersionId, "offpeak");
    expect(ownerInsertPrice(offpeak)).toBeTruthy();

    ownerInsertPrice(
      {
        ...offpeak,
        version: 2,
        valid_from: "2026-09-01T00:00:00Z",
        valid_to: "2027-01-01T00:00:00Z",
      },
      { expectedSqlState: EXCLUSION_VIOLATION },
    );

    expect(ownerInsertPrice({ ...offpeak, pricing_lane: "peak" })).toBeTruthy();

    ownerInsertPrice(
      {
        ...offpeak,
        valid_from: "2027-01-01T00:00:00Z",
        valid_to: "2027-02-01T00:00:00Z",
      },
      { expectedSqlState: UNIQUE_VIOLATION },
    );
  });

  it("keeps nullable provider-effective provenance distinct and immutable", async () => {
    const unknownProfile = await createProfileVersion("provenance-unknown");
    const unknownId = ownerInsertPrice(priceFixture(unknownProfile, "default"));
    const { data: unknown, error: unknownError } = await service.from("ai_price_versions").select("id,provider_effective_from,provider_effective_to").eq("id", unknownId).single();
    expect(unknownError).toBeNull();
    expect(unknown).toMatchObject({
      provider_effective_from: null,
      provider_effective_to: null,
    });

    const endOnlyProfile = await createProfileVersion("provenance-end-only");
    expect(ownerInsertPrice({ ...priceFixture(endOnlyProfile, "default"), provider_effective_to: "2026-08-24T00:00:00Z" })).toBeTruthy();

    const invalidProfile = await createProfileVersion("provenance-invalid");
    ownerInsertPrice(
      {
        ...priceFixture(invalidProfile, "default"),
        provider_effective_from: "2026-08-25T00:00:00Z",
        provider_effective_to: "2026-08-24T00:00:00Z",
      },
      { expectedSqlState: CHECK_VIOLATION },
    );

    ownerDomainProbe(
      String.raw`
        update public.ai_price_versions
        set provider_effective_from = '2026-08-01T00:00:00Z'::timestamptz
        where id = '${unknown!.id}'::uuid;
      `,
      CHECK_VIOLATION,
    );
  });

  it("denies service-role direct price catalog mutation", async () => {
    const profileVersionId = await createProfileVersion("service-acl");
    const fixture = priceFixture(profileVersionId, "default");
    const priceId = ownerInsertPrice(fixture);
    ownerDomainProbe(String.raw`
      insert into public.ai_price_components (
        price_version_id, component, nanos_per_million
      ) values ('${priceId}'::uuid, 'input_standard', 1);
    `);

    const priceInsert = await service
      .from("ai_price_versions")
      .insert({ ...fixture, version: 2 });
    expect(priceInsert.error?.code).toBe(PERMISSION_DENIED);

    const priceUpdate = await service
      .from("ai_price_versions")
      .update({ source_url: "https://example.com/forbidden-update" })
      .eq("id", priceId);
    expect(priceUpdate.error?.code).toBe(PERMISSION_DENIED);

    const priceDelete = await service
      .from("ai_price_versions")
      .delete()
      .eq("id", priceId);
    expect(priceDelete.error?.code).toBe(PERMISSION_DENIED);

    const componentInsert = await service.from("ai_price_components").insert({
      price_version_id: priceId,
      component: "output",
      nanos_per_million: 1,
    });
    expect(componentInsert.error?.code).toBe(PERMISSION_DENIED);

    const componentUpdate = await service
      .from("ai_price_components")
      .update({ nanos_per_million: 2 })
      .eq("price_version_id", priceId)
      .eq("component", "input_standard");
    expect(componentUpdate.error?.code).toBe(PERMISSION_DENIED);

    const componentDelete = await service
      .from("ai_price_components")
      .delete()
      .eq("price_version_id", priceId)
      .eq("component", "input_standard");
    expect(componentDelete.error?.code).toBe(PERMISSION_DENIED);
  });

  it("allows component authoring on drafts but rejects unsealed request snapshots", async () => {
    const runtime = authorSyntheticRuntimeContract();
    const profileVersionId = await createProfileVersion("unsealed");
    const priceId = ownerInsertPrice(priceFixture(profileVersionId, "default"));
    const { data: price, error: priceError } = await service.from("ai_price_versions").select("id,components_sealed_at").eq("id", priceId).single();
    expect(priceError).toBeNull();
    expect(price?.components_sealed_at).toBeNull();

    expect(runOwnerSql(`insert into public.ai_price_components(price_version_id,component,nanos_per_million) values ('${priceId}','input_standard',1);`).status).toBe(0);

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
