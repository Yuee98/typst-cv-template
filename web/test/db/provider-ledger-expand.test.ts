import { spawnSync } from "node:child_process";

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

const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const PERMISSION_DENIED = "42501";
const LEGAL_BUNDLE_VERSION = "2026-08-23-multi-provider-v1";

function sealPriceAsDatabaseOwner(priceId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(priceId)) {
    throw new Error("test price id is not a canonical UUID");
  }

  const sql = String.raw`
    \set ON_ERROR_STOP on
    begin;
    create temporary table ledger_price_seal_fixture (
      price_version_id uuid not null
    ) on commit drop;
    create function pg_temp.ledger_seal_price_fixture()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    begin
      update public.ai_price_versions
      set components_sealed_at = greatest(clock_timestamp(), created_at)
      where id = new.price_version_id;
      return new;
    end;
    $function$;
    create trigger ledger_seal_price_fixture
    after insert on ledger_price_seal_fixture
    for each row execute function pg_temp.ledger_seal_price_fixture();
    insert into ledger_price_seal_fixture (price_version_id)
    values (:'price_id'::uuid);
    commit;
  `;
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      "supabase_db_typst-cv-template",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "--set",
      "ON_ERROR_STOP=1",
      "--set",
      `price_id=${priceId}`,
    ],
    { input: sql, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `database-owner ledger price seal failed: ${result.stderr || result.stdout}`,
    );
  }
}

interface RouteFixture {
  profileVersionId: string;
  priceVersionId: string;
  policyVersionId: string;
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
    const { data: profile, error: profileError } = await service
      .from("ai_provider_profiles")
      .insert({
        profile_key: `test.ledger.${label}.${crypto.randomUUID()}`,
        display_name: `Ledger ${label}`,
        gateway_kind: "direct_mimo",
        model_vendor: "fixture",
      })
      .select("id")
      .single();
    expect(profileError).toBeNull();

    const { data: profileVersion, error: versionError } = await service
      .from("ai_provider_profile_versions")
      .insert({
        profile_id: profile!.id,
        version: 1,
        status: "draft",
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
        config_sha256: "f".repeat(64),
      })
      .select("id")
      .single();
    expect(versionError).toBeNull();
    const { error: validateVersionError } = await service
      .from("ai_provider_profile_versions")
      .update({ status: "validated" })
      .eq("id", profileVersion!.id);
    expect(validateVersionError).toBeNull();

    const { data: price, error: priceError } = await service
      .from("ai_price_versions")
      .insert({
        profile_version_id: profileVersion!.id,
        pricing_lane: "default",
        version: 1,
        currency: "CNY",
        calculator_kind: "linear_token_v1",
        valid_from: "2026-01-01T00:00:00Z",
        valid_to: null,
        source_url: "https://example.com/ledger-pricing",
        source_checked_at: "2026-08-23T00:00:00Z",
        source_snapshot_sha256: "1".repeat(64),
        parameters: {},
      })
      .select("id")
      .single();
    expect(priceError).toBeNull();
    if (sealPrice) {
      sealPriceAsDatabaseOwner(price!.id);
    }

    const { data: policy, error: policyError } = await service
      .from("ai_routing_policy_versions")
      .insert({
        policy_key: `test.ledger.${label}.${crypto.randomUUID()}`,
        version: 1,
        status: "draft",
        timezone: "Asia/Shanghai",
        rules: { kind: "fixture_default_only_v1" },
        default_profile_version_id: profileVersion!.id,
        legal_bundle_version: LEGAL_BUNDLE_VERSION,
        config_sha256: "2".repeat(64),
      })
      .select("id")
      .single();
    expect(policyError).toBeNull();
    const { error: validatePolicyError } = await service
      .from("ai_routing_policy_versions")
      .update({ status: "validated" })
      .eq("id", policy!.id);
    expect(validatePolicyError).toBeNull();

    return {
      profileVersionId: profileVersion!.id,
      priceVersionId: price!.id,
      policyVersionId: policy!.id,
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
      gateway_kind: "direct_mimo",
      model_id: "fixture-model",
      wire_api_kind: "responses_v1",
      display_disclosure_key: "fixture-disclosure-v1",
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
    const beforeReference = await service.from("ai_price_components").insert({
      price_version_id: componentRoute.priceVersionId,
      component: "input_standard",
      nanos_per_million: 100,
    });
    expect(beforeReference.error).toBeNull();
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

    const afterCleanup = await service.from("ai_price_components").insert({
      price_version_id: componentRoute.priceVersionId,
      component: "output",
      nanos_per_million: 200,
    });
    expect(afterCleanup.error?.code).toBe(CHECK_VIOLATION);
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
