import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAnonClient,
  createServiceClient,
  createTestUser,
  DB_TEST_ENV,
  deleteTestUser,
  RUN_DB_TESTS,
  type TestUser,
} from "./helpers";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const PERMISSION_DENIED = "42501";
const SAFE_INTEGER_MAX = "9007199254740991";

interface FrozenFixture {
  reservationId: string;
  snapshot: Record<string, unknown>;
}

describe.skipIf(!RUN_DB_TESTS)("provider attempt ledger schema (real DB)", () => {
  let service: SupabaseClient;
  let anon: SupabaseClient;
  let user: TestUser;
  let profileVersionId: string;
  let priceVersionId: string;
  let policyVersionId: string;
  let legalBundleVersion: string;

  beforeAll(async () => {
    service = createServiceClient();
    anon = createAnonClient();
    user = await createTestUser(service, "provider-attempt-schema");

    const currentLegal = await service.rpc("current_ai_terms_version");
    expect(currentLegal.error).toBeNull();
    legalBundleVersion = currentLegal.data as string;

    const profile = await service
      .from("ai_provider_profiles")
      .insert({
        profile_key: `test.attempt.${crypto.randomUUID()}`,
        display_name: "Attempt schema fixture",
        gateway_kind: "direct_deepseek",
        model_vendor: "fixture",
      })
      .select("id")
      .single();
    expect(profile.error).toBeNull();

    const version = await service
      .from("ai_provider_profile_versions")
      .insert({
        profile_id: profile.data!.id,
        version: 1,
        adapter_kind: "deepseek_chat_v1",
        wire_api_kind: "chat_completions_v1",
        credential_alias: "deepseek_api_key_v1",
        endpoint_alias: "deepseek_official_api_v1",
        model_id: "deepseek-v4-flash",
        upstream_route: {},
        capability_contract_id: "deepseek_chat_capabilities_v1",
        cache_policy_id: "automatic_cache_v1",
        legal_manifest_id: "deepseek-official-2026-08-23-v1",
        config: {},
        config_sha256: "a".repeat(64),
      })
      .select("id")
      .single();
    expect(version.error).toBeNull();
    profileVersionId = version.data!.id;

    const price = await service
      .from("ai_price_versions")
      .insert({
        profile_version_id: profileVersionId,
        version: 1,
        currency: "CNY",
        calculator_kind: "linear_token_v1",
        valid_from: "2026-01-01T00:00:00Z",
        source_url: "https://example.com/attempt-price-fixture",
        source_checked_at: "2026-08-23T00:00:00Z",
        source_snapshot_sha256: "b".repeat(64),
        parameters: {},
      })
      .select("id")
      .single();
    expect(price.error).toBeNull();
    priceVersionId = price.data!.id;

    const components = await service.from("ai_price_components").insert([
      { price_version_id: priceVersionId, component: "input_cache_read", nanos_per_million: 20_000_000 },
      { price_version_id: priceVersionId, component: "input_standard", nanos_per_million: 1_000_000_000 },
      { price_version_id: priceVersionId, component: "output", nanos_per_million: 2_000_000_000 },
    ]);
    expect(components.error).toBeNull();

    const policy = await service
      .from("ai_routing_policy_versions")
      .insert({
        policy_key: `test.attempt.${crypto.randomUUID()}`,
        version: 1,
        timezone: "Asia/Shanghai",
        rules: { kind: "fixture_default_only_v1" },
        default_profile_version_id: profileVersionId,
        legal_bundle_version: legalBundleVersion,
        config_sha256: "c".repeat(64),
      })
      .select("id")
      .single();
    expect(policy.error).toBeNull();
    policyVersionId = policy.data!.id;
  });

  afterAll(async () => {
    await deleteTestUser(service, user.id);
  });

  async function createReservation(owner = user): Promise<FrozenFixture> {
    const snapshot = {
      route_schema_version: "route_snapshot_v1",
      config_generation: 7,
      routing_policy_version_id: policyVersionId,
      profile_version_id: profileVersionId,
      price_version_id: priceVersionId,
      legal_bundle_version: legalBundleVersion,
      gateway_kind: "direct_deepseek",
      model_id: "deepseek-v4-flash",
      wire_api_kind: "chat_completions_v1",
      display_disclosure_key: "deepseek-official-v1",
    };
    const request = await service
      .from("ai_request_ledger")
      .insert({
        request_id: crypto.randomUUID(),
        client_request_id: crypto.randomUUID(),
        user_id: owner.id,
        ...snapshot,
      })
      .select("reservation_id")
      .single();
    expect(request.error).toBeNull();
    return { reservationId: request.data!.reservation_id, snapshot };
  }

  function startedAttempt(fixture: FrozenFixture, attemptNo = 1) {
    return {
      reservation_id: fixture.reservationId,
      attempt_no: attemptNo,
      ...fixture.snapshot,
      adapter_kind: "deepseek_chat_v1",
      credential_alias: "deepseek_api_key_v1",
      endpoint_alias: "deepseek_official_api_v1",
      capability_contract_id: "deepseek_chat_capabilities_v1",
      cache_policy_id: "automatic_cache_v1",
      legal_manifest_id: "deepseek-official-2026-08-23-v1",
      calculator_kind: "linear_token_v1",
      billing_currency: "CNY",
    };
  }

  function observedCompletion(overrides: Record<string, unknown> = {}) {
    return {
      status: "succeeded",
      // DB and host clocks can differ by a few milliseconds on Windows.
      terminal_at: new Date(Date.now() + 1_000).toISOString(),
      provider_billable: true,
      usage_observation_kind: "observed",
      usage_schema_version: "normalized_usage_v2",
      input_total_tokens: 100,
      input_cache_read_tokens: 60,
      input_cache_write_tokens: null,
      input_standard_tokens: 40,
      output_tokens: 20,
      reasoning_tokens: 5,
      cache_usage_reporting: "unavailable",
      usage_complete: true,
      route_observation_schema_version: "route_observation_v1",
      gateway_request_id: "gw-123",
      provider_request_id: "provider-123",
      actual_upstream_endpoint: "https://api.deepseek.com/v1/chat/completions",
      actual_model_id: "deepseek-v4-flash",
      router_attempt_count: null,
      cost_observation_schema_version: "cost_observation_v1",
      estimated_currency: "CNY",
      estimated_cost_nanos: 1234,
      provider_reported_currency: null,
      provider_reported_cost_nanos: null,
      cost_reconciliation_status: "not_available",
      finish_reason: "stop",
      failure_stage: null,
      latency_ms: 1234,
      ...overrides,
    };
  }

  function unavailableCompletion(status = "failed_upstream") {
    return observedCompletion({
      status,
      provider_billable: null,
      usage_observation_kind: "unavailable",
      usage_schema_version: null,
      input_total_tokens: null,
      input_cache_read_tokens: null,
      input_cache_write_tokens: null,
      input_standard_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cache_usage_reporting: null,
      usage_complete: false,
      estimated_currency: null,
      estimated_cost_nanos: null,
      cost_reconciliation_status: "incomplete_usage",
      finish_reason: null,
      failure_stage: "provider_http",
    });
  }

  async function insertStarted(fixture: FrozenFixture, attemptNo = 1) {
    return service
      .from("ai_provider_attempt_ledger")
      .insert(startedAttempt(fixture, attemptNo))
      .select("attempt_id,status")
      .single();
  }

  it("stores a frozen started attempt and rejects duplicate caller identity", async () => {
    const fixture = await createReservation();
    const first = await insertStarted(fixture);
    expect(first.error).toBeNull();
    expect(first.data?.status).toBe("started");

    const duplicate = await service
      .from("ai_provider_attempt_ledger")
      .insert(startedAttempt(fixture));
    expect(duplicate.error?.code).toBe(UNIQUE_VIOLATION);
  });

  it("preserves observed automatic-cache usage as NULL + unavailable", async () => {
    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    const completed = await service
      .from("ai_provider_attempt_ledger")
      .update(observedCompletion())
      .eq("attempt_id", started.data!.attempt_id)
      .select("*")
      .single();
    expect(completed.error).toBeNull();
    expect(completed.data).toMatchObject({
      usage_observation_kind: "observed",
      input_total_tokens: 100,
      input_cache_read_tokens: 60,
      input_cache_write_tokens: null,
      input_standard_tokens: 40,
      usage_complete: true,
      cost_reconciliation_status: "not_available",
    });

    const overwrite = await service
      .from("ai_provider_attempt_ledger")
      .update({ input_cache_write_tokens: 0 })
      .eq("attempt_id", started.data!.attempt_id);
    expect(overwrite.error?.code).toBe(CHECK_VIOLATION);
  });

  it("stores wholly unavailable usage without manufacturing zero tokens or cost", async () => {
    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    const completed = await service
      .from("ai_provider_attempt_ledger")
      .update(unavailableCompletion())
      .eq("attempt_id", started.data!.attempt_id)
      .select("usage_observation_kind,input_total_tokens,input_cache_write_tokens,usage_complete,provider_billable,estimated_cost_nanos,cost_reconciliation_status")
      .single();
    expect(completed.error).toBeNull();
    expect(completed.data).toEqual({
      usage_observation_kind: "unavailable",
      input_total_tokens: null,
      input_cache_write_tokens: null,
      usage_complete: false,
      provider_billable: null,
      estimated_cost_nanos: null,
      cost_reconciliation_status: "incomplete_usage",
    });
  });

  it.each([
    "succeeded",
    "invalid_output",
    "failed_upstream",
    "timed_out",
    "canceled",
    "unknown",
  ])("accepts terminal lifecycle status %s exactly once", async (status) => {
    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    const completed = await service
      .from("ai_provider_attempt_ledger")
      .update(unavailableCompletion(status))
      .eq("attempt_id", started.data!.attempt_id);
    expect(completed.error).toBeNull();

    const secondCompletion = await service
      .from("ai_provider_attempt_ledger")
      .update({ latency_ms: 9999 })
      .eq("attempt_id", started.data!.attempt_id);
    expect(secondCompletion.error?.code).toBe(CHECK_VIOLATION);
  });

  it.each([
    ["reported", 10, 20, 30, 60],
    ["not_applicable", 0, 0, 60, 60],
  ] as const)("accepts conserved %s cache usage", async (reporting, read, write, standard, total) => {
    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    const completed = await service
      .from("ai_provider_attempt_ledger")
      .update(observedCompletion({
        cache_usage_reporting: reporting,
        input_cache_read_tokens: read,
        input_cache_write_tokens: write,
        input_standard_tokens: standard,
        input_total_tokens: total,
      }))
      .eq("attempt_id", started.data!.attempt_id);
    expect(completed.error).toBeNull();
  });

  it.each([
    ["pending", { estimated_currency: "CNY", estimated_cost_nanos: 10 }],
    ["matched", { estimated_currency: "CNY", estimated_cost_nanos: 10, provider_reported_currency: "CNY", provider_reported_cost_nanos: 10 }],
    ["mismatch", { estimated_currency: "CNY", estimated_cost_nanos: 10, provider_reported_currency: "CNY", provider_reported_cost_nanos: 11 }],
    ["incomplete_usage", { estimated_currency: null, estimated_cost_nanos: null }],
  ] as const)("accepts canonical %s cost reconciliation", async (reconciliation, cost) => {
    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    const completed = await service
      .from("ai_provider_attempt_ledger")
      .update(observedCompletion({
        cost_reconciliation_status: reconciliation,
        ...cost,
      }))
      .eq("attempt_id", started.data!.attempt_id);
    expect(completed.error).toBeNull();
  });

  it("rejects partial/UNKNOWN-shaped facts, unsafe route metadata, and numeric overflow", async () => {
    const cases: Array<Record<string, unknown>> = [
      { usage_schema_version: null },
      { cache_usage_reporting: null },
      { input_cache_write_tokens: 0 },
      { input_standard_tokens: 41 },
      { reasoning_tokens: 21 },
      { input_total_tokens: "9007199254740992", input_cache_read_tokens: SAFE_INTEGER_MAX, input_standard_tokens: 1 },
      { estimated_currency: null },
      { estimated_currency: "USD" },
      { provider_reported_currency: "USD", provider_reported_cost_nanos: 1234 },
      { cost_reconciliation_status: "matched", provider_reported_currency: null, provider_reported_cost_nanos: null },
      { actual_upstream_endpoint: "https://user:secret@example.com/v1" },
      { actual_upstream_endpoint: "https://api.example.com/v1?token=secret" },
      { provider_request_id: "api_key=do-not-store" },
      { failure_stage: "provider_http\nraw-message" },
      { terminal_at: null },
    ];

    for (const invalid of cases) {
      const fixture = await createReservation();
      const started = await insertStarted(fixture);
      const completed = await service
        .from("ai_provider_attempt_ledger")
        .update(observedCompletion(invalid))
        .eq("attempt_id", started.data!.attempt_id);
      expect(completed.error?.code, JSON.stringify(invalid)).toBe(CHECK_VIOLATION);
    }
  });

  it("rejects snapshot/profile/price alias drift and attempts for legacy parents", async () => {
    const fixture = await createReservation();
    for (const drift of [
      { model_id: "different-model" },
      { config_generation: 8 },
      { endpoint_alias: "other_endpoint_v1" },
      { calculator_kind: "other_calculator_v1" },
      { billing_currency: "USD" },
    ]) {
      const result = await service
        .from("ai_provider_attempt_ledger")
        .insert({ ...startedAttempt(fixture), ...drift });
      expect(result.error?.code, JSON.stringify(drift)).toBe(CHECK_VIOLATION);
    }

    const legacy = await service
      .from("ai_request_ledger")
      .insert({
        request_id: crypto.randomUUID(),
        client_request_id: crypto.randomUUID(),
        user_id: user.id,
      })
      .select("reservation_id")
      .single();
    expect(legacy.error).toBeNull();

    const historicalAttempts = await service
      .from("ai_provider_attempt_ledger")
      .select("attempt_id", { count: "exact" })
      .eq("reservation_id", legacy.data!.reservation_id);
    expect(historicalAttempts.error).toBeNull();
    expect(historicalAttempts.count).toBe(0);

    const forged = await service
      .from("ai_provider_attempt_ledger")
      .insert({
        ...startedAttempt(fixture),
        reservation_id: legacy.data!.reservation_id,
      });
    expect(forged.error?.code).toBe(CHECK_VIOLATION);
  });

  it("cascades attempts with their request/user and leaves no orphan", async () => {
    const cascadeUser = await createTestUser(service, "attempt-cascade");
    const fixture = await createReservation(cascadeUser);
    const started = await insertStarted(fixture);
    expect(started.error).toBeNull();

    await deleteTestUser(service, cascadeUser.id);
    const remaining = await service
      .from("ai_provider_attempt_ledger")
      .select("attempt_id")
      .eq("attempt_id", started.data!.attempt_id)
      .maybeSingle();
    expect(remaining.error).toBeNull();
    expect(remaining.data).toBeNull();
  });

  it("exposes no content-bearing/raw-provider columns", async () => {
    const response = await fetch(`${DB_TEST_ENV!.url}/rest/v1/`, {
      headers: {
        apikey: DB_TEST_ENV!.secretKey,
        authorization: `Bearer ${DB_TEST_ENV!.secretKey}`,
        accept: "application/openapi+json",
      },
    });
    expect(response.ok).toBe(true);
    const openApi = await response.json() as {
      definitions?: Record<string, { properties?: Record<string, unknown> }>;
    };
    const columns = Object.keys(
      openApi.definitions?.ai_provider_attempt_ledger?.properties ?? {},
    );
    expect(columns).toContain("output_tokens");
    expect(columns.filter((column) =>
      /(^|_)(prompt|cv|content|body|message|raw|text)($|_)/.test(column),
    )).toEqual([]);
  });

  it("keeps attempt facts service-role only", async () => {
    const read = await anon
      .from("ai_provider_attempt_ledger")
      .select("attempt_id")
      .limit(1);
    expect(read.data).toBeNull();
    expect(read.error?.code).toBe(PERMISSION_DENIED);

    const fixture = await createReservation();
    const write = await anon
      .from("ai_provider_attempt_ledger")
      .insert(startedAttempt(fixture));
    expect(write.error?.code).toBe(PERMISSION_DENIED);
  });
});
