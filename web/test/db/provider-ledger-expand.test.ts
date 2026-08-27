import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAnonClient,
  createServiceClient,
  createTestUser,
  deleteTestUser,
  RUN_DB_TESTS,
  signInAsUser,
  type TestUser,
} from "./helpers";
import {
  authorSyntheticRuntimeContract,
  MIMO_LEGAL_MANIFEST_ID,
  MIMO_LEGAL_MANIFEST_SHA256,
  runOwnerSql,
  sealPriceAsDatabaseOwner,
  transitionPolicyAsDatabaseOwner,
} from "./runtime-contract-fixtures";

const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const PERMISSION_DENIED = "42501";
const LEGAL_BUNDLE_VERSION = "2026-08-23-multi-provider-v1";

interface RouteFixture {
  profileVersionId: string;
  priceVersionId: string;
  policyVersionId: string;
  runtimeContractId: string;
  runtimeContractSha256: string;
  displayDisclosureKey: string;
}

describe.skipIf(!RUN_DB_TESTS)("provider request-ledger expand (real DB)", () => {
  let service: SupabaseClient;
  let user: TestUser;
  let route: RouteFixture;

  beforeAll(async () => {
    service = createServiceClient();
    user = await createTestUser(service, "provider-ledger");
    route = await createRouteFixture("primary");
  });

  afterAll(async () => {
    await deleteTestUser(service, user.id);
  });

  async function createRouteFixture(
    label: string,
    sealPrice = true,
  ): Promise<RouteFixture> {
    const profileKey = `test.ledger.${label}.${crypto.randomUUID()}`;
    const profileId = crypto.randomUUID();
    const profileVersionId = crypto.randomUUID();
    const priceVersionId = crypto.randomUUID();
    const authorCatalog = runOwnerSql(String.raw`
      begin;
      insert into public.ai_provider_profiles (
        id, profile_key, display_name, gateway_kind, model_vendor
      ) values (
        '${profileId}', '${profileKey}', 'Ledger ${label}', 'direct_mimo', 'fixture'
      );
      insert into public.ai_provider_profile_versions (
        id, profile_id, version, adapter_kind, wire_api_kind, credential_alias,
        endpoint_alias, model_id, upstream_route, capability_contract_id,
        cache_policy_id, legal_manifest_id, display_disclosure_key, config, config_sha256
      ) values (
        '${profileVersionId}', '${profileId}', 1, 'fixture_adapter_v1', 'responses_v1',
        'fixture_credential_v1', 'fixture_endpoint_v1', 'fixture-model', '{}'::jsonb,
        'fixture_capability_v1', 'fixture_cache_v1', '${MIMO_LEGAL_MANIFEST_ID}',
        'mimo.official', '{}'::jsonb, '${"f".repeat(64)}'
      );
      update public.ai_provider_profile_versions set status='validated'
      where id='${profileVersionId}'::uuid;
      insert into public.ai_price_versions (
        id, profile_version_id, pricing_lane, version, currency, calculator_kind,
        valid_from, source_url, source_checked_at, source_snapshot_sha256, parameters
      ) values (
        '${priceVersionId}', '${profileVersionId}', 'default', 1, 'CNY', 'linear_token_v1',
        '2026-01-01T00:00:00Z', 'https://example.com/ledger-pricing',
        '2026-08-23T00:00:00Z', '${"1".repeat(64)}', '{}'::jsonb
      );
      commit;
    `);
    expect(authorCatalog.status).toBe(0);
    if (sealPrice) {
      expect(runOwnerSql(String.raw`
        insert into public.ai_price_components (price_version_id, component, nanos_per_million)
        values
          ('${priceVersionId}', 'input_standard', 1),
          ('${priceVersionId}', 'input_cache_read', 1),
          ('${priceVersionId}', 'output', 1);
      `).status).toBe(0);
      sealPriceAsDatabaseOwner(priceVersionId);
    }

    const runtime = authorSyntheticRuntimeContract({
      profileKey,
      legalManifestId: MIMO_LEGAL_MANIFEST_ID,
      manifestSha256: MIMO_LEGAL_MANIFEST_SHA256,
    });

    const policyVersionId = crypto.randomUUID();
    expect(runOwnerSql(String.raw`
      insert into public.ai_routing_policy_versions (
        id, policy_key, version, timezone, rules, default_profile_version_id,
        legal_bundle_version, runtime_contract_id, runtime_contract_sha256, config_sha256
      ) values (
        '${policyVersionId}', 'test.ledger.${label}.${crypto.randomUUID()}', 1, 'Asia/Shanghai',
        pg_catalog.jsonb_build_object(
          'schemaVersion', 'routing_rules_v1',
          'defaultRoute', pg_catalog.jsonb_build_object('profileVersionId', '${profileVersionId}', 'priceVersionId', '${priceVersionId}'),
          'windows', '[]'::jsonb
        ), '${profileVersionId}', '${LEGAL_BUNDLE_VERSION}',
        '${runtime.runtimeContractId}', '${runtime.runtimeContractSha256}', '${"2".repeat(64)}'
      );
    `).status).toBe(0);
    if (sealPrice) {
      transitionPolicyAsDatabaseOwner(policyVersionId, "validated");
    }

    return {
      profileVersionId,
      priceVersionId,
      policyVersionId,
      runtimeContractId: runtime.runtimeContractId,
      runtimeContractSha256: runtime.runtimeContractSha256,
      displayDisclosureKey: "mimo.official",
    };
  }

  function requestIdentity() {
    return {
      request_id: crypto.randomUUID(),
      client_request_id: crypto.randomUUID(),
      user_id: user.id,
    };
  }

  function routeSnapshot(fixture = route) {
    return {
      route_schema_version: "route_snapshot_v1",
      config_generation: 7,
      routing_policy_version_id: fixture.policyVersionId,
      profile_version_id: fixture.profileVersionId,
      price_version_id: fixture.priceVersionId,
      legal_bundle_version: LEGAL_BUNDLE_VERSION,
      runtime_contract_id: fixture.runtimeContractId,
      runtime_contract_sha256: fixture.runtimeContractSha256,
      gateway_kind: "direct_mimo",
      model_id: "fixture-model",
      wire_api_kind: "responses_v1",
      display_disclosure_key: fixture.displayDisclosureKey,
    };
  }

  function completeUsageAggregate() {
    return {
      usage_schema_version: "request_usage_aggregate_v2",
      input_total_tokens: 100,
      input_cache_read_tokens: 60,
      input_cache_write_tokens: 0,
      input_standard_tokens: 40,
      output_tokens: 20,
      reasoning_tokens: 5,
      cache_usage_reporting: "reported",
      incomplete_fields: [] as string[],
      usage_complete: true,
      provider_billable: false,
      cost_basis: "frozen_price_version_v1",
      billing_currency: "CNY",
      known_estimated_cost_nanos: 100,
      estimated_cost_nanos: 100,
      cost_reconciliation_status: "not_available",
    };
  }

  it("keeps legacy rows and the legacy finalize RPC compatible", async () => {
    const { data: legacy, error: insertError } = await service
      .from("ai_request_ledger")
      .insert(requestIdentity())
      .select("reservation_id,route_schema_version,profile_version_id,billing_currency")
      .single();
    expect(insertError).toBeNull();
    expect(legacy).toMatchObject({
      route_schema_version: null,
      profile_version_id: null,
      billing_currency: null,
    });

    const finalized = await service.rpc("finalize_ai_polish_request", {
      p_reservation_id: legacy!.reservation_id,
      p_status: "released",
      p_quota_charged: false,
      p_provider_billable: false,
      p_usage: null,
      p_metadata: null,
    });
    expect(finalized.error).toBeNull();
    expect(finalized.data).toMatchObject({ ok: true, status: "released" });

    const { data: row, error: readError } = await service
      .from("ai_request_ledger")
      .select("state,status,route_schema_version,profile_version_id")
      .eq("reservation_id", legacy!.reservation_id)
      .single();
    expect(readError).toBeNull();
    expect(row).toMatchObject({
      state: "finalized",
      status: "released",
      route_schema_version: null,
      profile_version_id: null,
    });
  });

  it("round-trips unavailable cache-write as null and preserves known cost", async () => {
    const { data, error } = await service
      .from("ai_request_ledger")
      .insert({
        ...requestIdentity(),
        ...routeSnapshot(),
        usage_schema_version: "request_usage_aggregate_v2",
        input_total_tokens: 100,
        input_cache_read_tokens: 60,
        input_cache_write_tokens: null,
        input_standard_tokens: 40,
        output_tokens: 20,
        reasoning_tokens: 5,
        cache_usage_reporting: "unavailable",
        incomplete_fields: ["input_cache_write"],
        usage_complete: true,
        provider_billable: false,
        cost_basis: "frozen_price_version_v1",
        billing_currency: "CNY",
        known_estimated_cost_nanos: 1234,
        estimated_cost_nanos: 1234,
        cost_reconciliation_status: "not_available",
      })
      .select("*")
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({
      route_schema_version: "route_snapshot_v1",
      input_total_tokens: 100,
      input_cache_read_tokens: 60,
      input_cache_write_tokens: null,
      input_standard_tokens: 40,
      reasoning_tokens: 5,
      cache_usage_reporting: "unavailable",
      billing_currency: "CNY",
      known_estimated_cost_nanos: 1234,
      estimated_cost_nanos: 1234,
    });
  });

  it("rejects partial/mixed snapshots and freezes a complete snapshot", async () => {
    const partial = await service.from("ai_request_ledger").insert({
      ...requestIdentity(),
      route_schema_version: "route_snapshot_v1",
    });
    expect(partial.error?.code).toBe(CHECK_VIOLATION);

    const nullSchemaWithConfig = await service
      .from("ai_request_ledger")
      .insert({
        ...requestIdentity(),
        config_generation: 7,
      });
    expect(nullSchemaWithConfig.error?.code).toBe(CHECK_VIOLATION);

    const mismatchedDisclosure = await service.from("ai_request_ledger").insert({
      ...requestIdentity(),
      ...routeSnapshot(),
      display_disclosure_key: "mimo.unreviewed",
    });
    expect(mismatchedDisclosure.error?.code).toBe(CHECK_VIOLATION);
    expect(mismatchedDisclosure.error?.message).toContain(
      "request route disclosure differs from immutable profile disclosure",
    );

    const otherRoute = await createRouteFixture("other-profile");
    const mixed = await service.from("ai_request_ledger").insert({
      ...requestIdentity(),
      ...routeSnapshot(),
      profile_version_id: otherRoute.profileVersionId,
    });
    expect(mixed.error?.code).toBe(FOREIGN_KEY_VIOLATION);

    const { data: empty, error: emptyError } = await service
      .from("ai_request_ledger")
      .insert(requestIdentity())
      .select("reservation_id")
      .single();
    expect(emptyError).toBeNull();

    const { data: frozen, error: frozenError } = await service
      .from("ai_request_ledger")
      .update(routeSnapshot())
      .eq("reservation_id", empty!.reservation_id)
      .select("reservation_id,route_schema_version,price_version_id")
      .single();
    expect(frozenError).toBeNull();
    expect(frozen).toMatchObject({
      route_schema_version: "route_snapshot_v1",
      price_version_id: route.priceVersionId,
    });

    const mutate = await service
      .from("ai_request_ledger")
      .update({ model_id: "changed-model" })
      .eq("reservation_id", frozen!.reservation_id);
    expect(mutate.error?.code).toBe(CHECK_VIOLATION);
  });

  it("blocks price components after an audited price seal", async () => {
    const componentRoute = await createRouteFixture("component-freeze", false);
    const components = runOwnerSql(String.raw`
      insert into public.ai_price_components (
        price_version_id, component, nanos_per_million
      ) values
        ('${componentRoute.priceVersionId}'::uuid, 'input_standard', 100),
        ('${componentRoute.priceVersionId}'::uuid, 'input_cache_read', 50),
        ('${componentRoute.priceVersionId}'::uuid, 'output', 200);
    `);
    expect(components.status).toBe(0);
    sealPriceAsDatabaseOwner(componentRoute.priceVersionId);

    const reference = await service
      .from("ai_request_ledger")
      .insert({
        ...requestIdentity(),
        ...routeSnapshot(componentRoute),
      })
      .select("reservation_id")
      .single();
    expect(reference.error).toBeNull();

    const { error: cleanupError } = await service
      .from("ai_request_ledger")
      .delete()
      .eq("reservation_id", reference.data!.reservation_id);
    expect(cleanupError).toBeNull();

    const { data: sealedPrice, error: sealReadError } = await service
      .from("ai_price_versions")
      .select("components_sealed_at")
      .eq("id", componentRoute.priceVersionId)
      .single();
    expect(sealReadError).toBeNull();
    expect(sealedPrice?.components_sealed_at).toBeTruthy();

    const afterCleanup = runOwnerSql(
      String.raw`
        \set VERBOSITY verbose
        insert into public.ai_price_components (
          price_version_id, component, nanos_per_million
        ) values (
          '${componentRoute.priceVersionId}'::uuid,
          'input_cache_write',
          200
        );
      `,
      { expectFailure: true },
    );
    expect(afterCleanup.stderr + afterCleanup.stdout).toContain(CHECK_VIOLATION);
  });

  it("enforces reported/unavailable usage conservation and reasoning detail", async () => {
    const unavailableWithZeroWrite = await service
      .from("ai_request_ledger")
      .insert({
        ...requestIdentity(),
        usage_schema_version: "request_usage_aggregate_v2",
        input_total_tokens: 100,
        input_cache_read_tokens: 60,
        input_cache_write_tokens: 0,
        input_standard_tokens: 40,
        output_tokens: 20,
        reasoning_tokens: 5,
        cache_usage_reporting: "unavailable",
        incomplete_fields: ["input_cache_write"],
      });
    expect(unavailableWithZeroWrite.error?.code).toBe(CHECK_VIOLATION);

    const brokenReportedConservation = await service
      .from("ai_request_ledger")
      .insert({
        ...requestIdentity(),
        usage_schema_version: "request_usage_aggregate_v2",
        input_total_tokens: 100,
        input_cache_read_tokens: 60,
        input_cache_write_tokens: 10,
        input_standard_tokens: 40,
        output_tokens: 20,
        reasoning_tokens: 5,
        cache_usage_reporting: "reported",
        incomplete_fields: [],
      });
    expect(brokenReportedConservation.error?.code).toBe(CHECK_VIOLATION);

    const excessiveReasoning = await service.from("ai_request_ledger").insert({
      ...requestIdentity(),
      usage_schema_version: "request_usage_aggregate_v2",
      input_total_tokens: 100,
      input_cache_read_tokens: 60,
      input_cache_write_tokens: 0,
      input_standard_tokens: 40,
      output_tokens: 20,
      reasoning_tokens: 21,
      cache_usage_reporting: "reported",
      incomplete_fields: [],
    });
    expect(excessiveReasoning.error?.code).toBe(CHECK_VIOLATION);

    const unpairedReportedCost = await service
      .from("ai_request_ledger")
      .insert({
        ...requestIdentity(),
        provider_reported_currency: "CNY",
        provider_reported_cost_nanos: null,
      });
    expect(unpairedReportedCost.error?.code).toBe(CHECK_VIOLATION);

    const estimatedDiffersFromKnown = await service
      .from("ai_request_ledger")
      .insert({
        ...requestIdentity(),
        billing_currency: "CNY",
        known_estimated_cost_nanos: 100,
        estimated_cost_nanos: 101,
      });
    expect(estimatedDiffersFromKnown.error?.code).toBe(CHECK_VIOLATION);
  });

  it("binds V2 unknown fields bidirectionally to incomplete_fields", async () => {
    const invalidAggregates = [
      {
        label: "usage complete but attempt_usage is present",
        patch: { incomplete_fields: ["attempt_usage"], usage_complete: true },
      },
      {
        label: "usage incomplete but attempt_usage is absent",
        patch: { incomplete_fields: [], usage_complete: false },
      },
      {
        label: "cache write unknown without marker",
        patch: {
          input_cache_write_tokens: null,
          cache_usage_reporting: "unavailable",
          incomplete_fields: [],
        },
      },
      {
        label: "known cache write with marker",
        patch: { incomplete_fields: ["input_cache_write"] },
      },
      {
        label: "reasoning unknown without marker",
        patch: { reasoning_tokens: null, incomplete_fields: [] },
      },
      {
        label: "known reasoning with marker",
        patch: { incomplete_fields: ["reasoning"] },
      },
      {
        label: "provider billability unknown without marker",
        patch: { provider_billable: null, incomplete_fields: [] },
      },
      {
        label: "known provider billability with marker",
        patch: { incomplete_fields: ["provider_billable"] },
      },
      {
        label: "estimated cost unknown without marker",
        patch: { estimated_cost_nanos: null, incomplete_fields: [] },
      },
      {
        label: "known estimated cost with marker",
        patch: { incomplete_fields: ["estimated_cost"] },
      },
      {
        label: "duplicate marker",
        patch: {
          provider_billable: null,
          incomplete_fields: ["provider_billable", "provider_billable"],
        },
      },
    ];

    for (const fixture of invalidAggregates) {
      const { error } = await service.from("ai_request_ledger").insert({
        ...requestIdentity(),
        ...completeUsageAggregate(),
        ...fixture.patch,
      });
      expect(error?.code, fixture.label).toBe(CHECK_VIOLATION);
    }
  });

  it("preserves known lower bounds while unknown V2 facts remain null", async () => {
    const { data, error } = await service
      .from("ai_request_ledger")
      .insert({
        ...requestIdentity(),
        ...completeUsageAggregate(),
        input_cache_write_tokens: null,
        reasoning_tokens: null,
        cache_usage_reporting: "unavailable",
        usage_complete: false,
        provider_billable: null,
        known_estimated_cost_nanos: 50,
        estimated_cost_nanos: null,
        cost_reconciliation_status: "incomplete_usage",
        incomplete_fields: [
          "attempt_usage",
          "input_cache_write",
          "reasoning",
          "provider_billable",
          "estimated_cost",
        ],
      })
      .select(
        "input_total_tokens,input_cache_write_tokens,reasoning_tokens,provider_billable,known_estimated_cost_nanos,estimated_cost_nanos,incomplete_fields",
      )
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({
      input_total_tokens: 100,
      input_cache_write_tokens: null,
      reasoning_tokens: null,
      provider_billable: null,
      known_estimated_cost_nanos: 50,
      estimated_cost_nanos: null,
    });
    expect(data?.incomplete_fields).toEqual([
      "attempt_usage",
      "input_cache_write",
      "reasoning",
      "provider_billable",
      "estimated_cost",
    ]);
  });

  it("validates matched and mismatch cost reconciliation facts", async () => {
    const invalidReconciliations = [
      {
        cost_reconciliation_status: "matched",
        provider_reported_currency: null,
        provider_reported_cost_nanos: null,
      },
      {
        cost_reconciliation_status: "matched",
        provider_reported_currency: "CNY",
        provider_reported_cost_nanos: 101,
      },
      {
        cost_reconciliation_status: "mismatch",
        provider_reported_currency: "CNY",
        provider_reported_cost_nanos: 100,
      },
    ];
    for (const reconciliation of invalidReconciliations) {
      const { error } = await service.from("ai_request_ledger").insert({
        ...requestIdentity(),
        ...completeUsageAggregate(),
        ...reconciliation,
      });
      expect(error?.code).toBe(CHECK_VIOLATION);
    }

    for (const reconciliation of [
      {
        cost_reconciliation_status: "matched",
        provider_reported_currency: "CNY",
        provider_reported_cost_nanos: 100,
      },
      {
        cost_reconciliation_status: "mismatch",
        provider_reported_currency: "CNY",
        provider_reported_cost_nanos: 101,
      },
    ]) {
      const { error } = await service.from("ai_request_ledger").insert({
        ...requestIdentity(),
        ...completeUsageAggregate(),
        ...reconciliation,
      });
      expect(error).toBeNull();
    }
  });

  it("enforces the complete reconciliation-status truth table", async () => {
    const invalidStates = [
      {
        label: "V2 aggregate omits reconciliation status",
        patch: { cost_reconciliation_status: null },
      },
      {
        label: "not_available carries provider-reported cost",
        patch: {
          cost_reconciliation_status: "not_available",
          provider_reported_currency: "CNY",
          provider_reported_cost_nanos: 100,
        },
      },
      {
        label: "not_available hides incomplete local cost",
        patch: {
          cost_reconciliation_status: "not_available",
          reasoning_tokens: null,
          estimated_cost_nanos: null,
          incomplete_fields: ["reasoning", "estimated_cost"],
        },
      },
      {
        label: "pending already carries provider-reported cost",
        patch: {
          cost_reconciliation_status: "pending",
          provider_reported_currency: "CNY",
          provider_reported_cost_nanos: 100,
        },
      },
      {
        label: "incomplete_usage keeps a complete local estimate",
        patch: { cost_reconciliation_status: "incomplete_usage" },
      },
      {
        label: "incomplete_usage omits the estimated-cost marker",
        patch: {
          cost_reconciliation_status: "incomplete_usage",
          estimated_cost_nanos: null,
          incomplete_fields: [],
        },
      },
    ];
    for (const fixture of invalidStates) {
      const { error } = await service.from("ai_request_ledger").insert({
        ...requestIdentity(),
        ...completeUsageAggregate(),
        ...fixture.patch,
      });
      expect(error?.code, fixture.label).toBe(CHECK_VIOLATION);
    }

    const validStates = [
      { cost_reconciliation_status: "not_available" },
      { cost_reconciliation_status: "pending" },
      {
        cost_reconciliation_status: "matched",
        provider_reported_currency: "CNY",
        provider_reported_cost_nanos: 100,
      },
      {
        cost_reconciliation_status: "mismatch",
        provider_reported_currency: "CNY",
        provider_reported_cost_nanos: 101,
      },
      {
        cost_reconciliation_status: "incomplete_usage",
        reasoning_tokens: null,
        estimated_cost_nanos: null,
        incomplete_fields: ["reasoning", "estimated_cost"],
      },
      {
        cost_reconciliation_status: "incomplete_usage",
        reasoning_tokens: null,
        estimated_cost_nanos: null,
        provider_reported_currency: "CNY",
        provider_reported_cost_nanos: 100,
        incomplete_fields: ["reasoning", "estimated_cost"],
      },
    ];
    for (const state of validStates) {
      const { error } = await service.from("ai_request_ledger").insert({
        ...requestIdentity(),
        ...completeUsageAggregate(),
        ...state,
      });
      expect(error).toBeNull();
    }
  });

  it("accepts contract_incomplete_cost_only", async () => {
    const { data, error } = await service
      .from("ai_request_ledger")
      .insert({
        ...requestIdentity(),
        ...completeUsageAggregate(),
        cost_reconciliation_status: "incomplete_usage",
        estimated_cost_nanos: null,
        incomplete_fields: ["estimated_cost"],
      })
      .select(
        "usage_complete, known_estimated_cost_nanos, estimated_cost_nanos, incomplete_fields, cost_reconciliation_status",
      )
      .single();

    expect(error).toBeNull();
    expect(data).toEqual({
      usage_complete: true,
      known_estimated_cost_nanos: 100,
      estimated_cost_nanos: null,
      incomplete_fields: ["estimated_cost"],
      cost_reconciliation_status: "incomplete_usage",
    });
  });

  it("keeps profile aggregates split by native currency", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const rows = [
      {
        day,
        profile_version_id: route.profileVersionId,
        billing_currency: "CNY",
        request_count: 1,
        known_estimated_cost_nanos: 100,
        estimated_cost_nanos: 100,
      },
      {
        day,
        profile_version_id: route.profileVersionId,
        billing_currency: "USD",
        request_count: 1,
        known_estimated_cost_nanos: 200,
        estimated_cost_nanos: 200,
      },
    ];
    const { error: insertError } = await service
      .from("ai_profile_usage_daily")
      .insert(rows);
    expect(insertError).toBeNull();

    const { data, error } = await service
      .from("ai_profile_usage_daily")
      .select("billing_currency,known_estimated_cost_nanos")
      .eq("day", day)
      .eq("profile_version_id", route.profileVersionId)
      .order("billing_currency");
    expect(error).toBeNull();
    expect(data).toEqual([
      { billing_currency: "CNY", known_estimated_cost_nanos: 100 },
      { billing_currency: "USD", known_estimated_cost_nanos: 200 },
    ]);
  });

  it("keeps profile/currency aggregates service-role only", async () => {
    const anon = createAnonClient();
    const authed = await signInAsUser(user);

    for (const client of [anon, authed]) {
      const { data, error } = await client
        .from("ai_profile_usage_daily")
        .select("*")
        .limit(1);
      expect(data).toBeNull();
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
  });
});
