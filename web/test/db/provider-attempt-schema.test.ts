import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import routingRulesFixture from "../fixtures/routing-rules-v1.json";
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
const GATEWAY_CORRELATION_TAG = `hmac-sha256:${"a".repeat(64)}`;
const PROVIDER_CORRELATION_TAG = `hmac-sha256:${"b".repeat(64)}`;

interface FrozenFixture {
  reservationId: string;
  snapshot: Record<string, unknown>;
  attemptAliases?: Record<string, unknown>;
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
        endpoint_alias: "deepseek_official",
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

  async function createCustomReservation(input: {
    key: string;
    gatewayKind: "direct_deepseek" | "direct_mimo";
    adapterKind: string;
    wireApiKind: "chat_completions_v1" | "responses_v1";
    endpointAlias: string;
    modelId: string;
  }): Promise<FrozenFixture> {
    const profile = await service
      .from("ai_provider_profiles")
      .insert({
        profile_key: `test.attempt.${input.key}.${crypto.randomUUID()}`,
        display_name: `${input.key} attempt schema fixture`,
        gateway_kind: input.gatewayKind,
        model_vendor: "fixture",
      })
      .select("id")
      .single();
    expect(profile.error).toBeNull();

    const credentialAlias = `${input.key}_api_key_v1`;
    const capabilityContractId = `${input.key}_capabilities_v1`;
    const cachePolicyId = "automatic_cache_v1";
    const legalManifestId = `${input.key}-legal-v1`;
    const version = await service
      .from("ai_provider_profile_versions")
      .insert({
        profile_id: profile.data!.id,
        version: 1,
        adapter_kind: input.adapterKind,
        wire_api_kind: input.wireApiKind,
        credential_alias: credentialAlias,
        endpoint_alias: input.endpointAlias,
        model_id: input.modelId,
        upstream_route: {},
        capability_contract_id: capabilityContractId,
        cache_policy_id: cachePolicyId,
        legal_manifest_id: legalManifestId,
        config: {},
        config_sha256: "d".repeat(64),
      })
      .select("id")
      .single();
    expect(version.error).toBeNull();

    const price = await service
      .from("ai_price_versions")
      .insert({
        profile_version_id: version.data!.id,
        version: 1,
        currency: "CNY",
        calculator_kind: "linear_token_v1",
        valid_from: "2026-01-01T00:00:00Z",
        source_url: `https://example.com/${input.key}-price-fixture`,
        source_checked_at: "2026-08-23T00:00:00Z",
        source_snapshot_sha256: "e".repeat(64),
        parameters: {},
      })
      .select("id")
      .single();
    expect(price.error).toBeNull();

    const components = await service.from("ai_price_components").insert([
      { price_version_id: price.data!.id, component: "input_cache_read", nanos_per_million: 20_000_000 },
      { price_version_id: price.data!.id, component: "input_standard", nanos_per_million: 1_000_000_000 },
      { price_version_id: price.data!.id, component: "output", nanos_per_million: 2_000_000_000 },
    ]);
    expect(components.error).toBeNull();

    const policy = await service
      .from("ai_routing_policy_versions")
      .insert({
        policy_key: `test.attempt.${input.key}.${crypto.randomUUID()}`,
        version: 1,
        timezone: "Asia/Shanghai",
        rules: { kind: "fixture_default_only_v1" },
        default_profile_version_id: version.data!.id,
        legal_bundle_version: legalBundleVersion,
        config_sha256: "f".repeat(64),
      })
      .select("id")
      .single();
    expect(policy.error).toBeNull();

    const snapshot = {
      route_schema_version: "route_snapshot_v1",
      config_generation: 8,
      routing_policy_version_id: policy.data!.id,
      profile_version_id: version.data!.id,
      price_version_id: price.data!.id,
      legal_bundle_version: legalBundleVersion,
      gateway_kind: input.gatewayKind,
      model_id: input.modelId,
      wire_api_kind: input.wireApiKind,
      display_disclosure_key: `${input.key}-disclosure-v1`,
    };
    const request = await service
      .from("ai_request_ledger")
      .insert({
        request_id: crypto.randomUUID(),
        client_request_id: crypto.randomUUID(),
        user_id: user.id,
        ...snapshot,
      })
      .select("reservation_id")
      .single();
    expect(request.error).toBeNull();

    return {
      reservationId: request.data!.reservation_id,
      snapshot,
      attemptAliases: {
        adapter_kind: input.adapterKind,
        credential_alias: credentialAlias,
        endpoint_alias: input.endpointAlias,
        capability_contract_id: capabilityContractId,
        cache_policy_id: cachePolicyId,
        legal_manifest_id: legalManifestId,
        calculator_kind: "linear_token_v1",
        billing_currency: "CNY",
      },
    };
  }

  function startedAttempt(fixture: FrozenFixture, attemptNo = 1) {
    return {
      reservation_id: fixture.reservationId,
      attempt_no: attemptNo,
      ...fixture.snapshot,
      ...(fixture.attemptAliases ?? {
        adapter_kind: "deepseek_chat_v1",
        credential_alias: "deepseek_api_key_v1",
        endpoint_alias: "deepseek_official",
        capability_contract_id: "deepseek_chat_capabilities_v1",
        cache_policy_id: "automatic_cache_v1",
        legal_manifest_id: "deepseek-official-2026-08-23-v1",
        calculator_kind: "linear_token_v1",
        billing_currency: "CNY",
      }),
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
      gateway_request_id: GATEWAY_CORRELATION_TAG,
      provider_request_id: PROVIDER_CORRELATION_TAG,
      actual_upstream_endpoint: "https://api.deepseek.com/chat/completions",
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

  async function finalizeReservation(reservationId: string) {
    const finalized = await service
      .from("ai_request_ledger")
      .update({
        state: "finalized",
        status: "released",
        quota_charged: false,
        provider_billable: false,
        usage_complete: false,
        finalized_at: new Date(Date.now() + 1_000).toISOString(),
      })
      .eq("reservation_id", reservationId)
      .select("state")
      .single();
    expect(finalized.error).toBeNull();
    expect(finalized.data?.state).toBe("finalized");
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

  it("admits only started attempts and only a started-to-terminal update", async () => {
    const terminalFixture = await createReservation();
    const terminalInsert = await service
      .from("ai_provider_attempt_ledger")
      .insert({
        ...startedAttempt(terminalFixture),
        ...unavailableCompletion(),
      });
    expect(terminalInsert.error?.code).toBe(CHECK_VIOLATION);

    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    expect(started.error).toBeNull();
    const startedUpdate = await service
      .from("ai_provider_attempt_ledger")
      .update({ status: "started" })
      .eq("attempt_id", started.data!.attempt_id);
    expect(startedUpdate.error?.code).toBe(CHECK_VIOLATION);
  });

  it("rejects insert, late completion, and direct child deletion after parent finalization", async () => {
    const finalizedBeforeStart = await createReservation();
    await finalizeReservation(finalizedBeforeStart.reservationId);
    const insertAfterFinalize = await service
      .from("ai_provider_attempt_ledger")
      .insert(startedAttempt(finalizedBeforeStart));
    expect(insertAfterFinalize.error?.code).toBe(CHECK_VIOLATION);

    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    expect(started.error).toBeNull();
    await finalizeReservation(fixture.reservationId);

    const lateCompletion = await service
      .from("ai_provider_attempt_ledger")
      .update(unavailableCompletion())
      .eq("attempt_id", started.data!.attempt_id);
    expect(lateCompletion.error?.code).toBe(CHECK_VIOLATION);

    const directDelete = await service
      .from("ai_provider_attempt_ledger")
      .delete()
      .eq("attempt_id", started.data!.attempt_id);
    expect(directDelete.error?.code).toBe(CHECK_VIOLATION);

    const unchanged = await service
      .from("ai_provider_attempt_ledger")
      .select("status")
      .eq("attempt_id", started.data!.attempt_id)
      .single();
    expect(unchanged.error).toBeNull();
    expect(unchanged.data?.status).toBe("started");
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

  it("accepts HMAC correlation tags plus exact frozen DeepSeek/MiMo route provenance", async () => {
    const deepseek = await createReservation();
    const routePairs = routingRulesFixture.routeObservationPairs;
    expect(routePairs.map(({ endpointAlias }) => endpointAlias).sort()).toEqual([
      "deepseek_official",
      "mimo_cn_official",
    ]);

    const mimoPair = routePairs.find(({ endpointAlias }) => endpointAlias === "mimo_cn_official");
    expect(mimoPair).toBeDefined();
    if (!mimoPair) {
      throw new Error("routing fixture is missing mimo_cn_official");
    }
    const mimo = await createCustomReservation({
      key: "mimo",
      gatewayKind: "direct_mimo",
      adapterKind: "mimo_responses_v1",
      wireApiKind: "responses_v1",
      endpointAlias: mimoPair.endpointAlias,
      modelId: mimoPair.modelId,
    });
    const modelProvenance = await createCustomReservation({
      key: "model-provenance",
      gatewayKind: "direct_deepseek",
      adapterKind: "fixture_chat_v1",
      wireApiKind: "chat_completions_v1",
      endpointAlias: "deepseek_official",
      modelId: "vendor/basic-model@2026",
    });
    const fixtureByEndpointAlias = new Map([
      ["deepseek_official", deepseek],
      ["mimo_cn_official", mimo],
    ]);
    const cases = [
      ...routePairs.map((pair) => {
        const fixture = fixtureByEndpointAlias.get(pair.endpointAlias);
        if (!fixture) {
          throw new Error(`DB route mirror is missing ${pair.endpointAlias}`);
        }
        return {
          fixture,
          modelId: pair.modelId,
          endpoint: pair.canonicalEndpoint,
        };
      }),
      {
        fixture: modelProvenance,
        modelId: "vendor/basic-model@2026",
        endpoint: "https://api.deepseek.com/chat/completions",
      },
    ];

    for (const { fixture, modelId, endpoint } of cases) {
      const started = await insertStarted(fixture);
      const completed = await service
        .from("ai_provider_attempt_ledger")
        .update(observedCompletion({
          actual_model_id: modelId,
          actual_upstream_endpoint: endpoint,
        }))
        .eq("attempt_id", started.data!.attempt_id)
        .select("gateway_request_id,provider_request_id,actual_model_id,actual_upstream_endpoint")
        .single();
      expect(completed.error).toBeNull();
      expect(completed.data).toEqual({
        gateway_request_id: GATEWAY_CORRELATION_TAG,
        provider_request_id: PROVIDER_CORRELATION_TAG,
        actual_model_id: modelId,
        actual_upstream_endpoint: endpoint,
      });
    }
  });

  it("accepts explicit NULL when no safe route observation is available", async () => {
    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    const completed = await service
      .from("ai_provider_attempt_ledger")
      .update(observedCompletion({
        gateway_request_id: null,
        provider_request_id: null,
        actual_model_id: null,
        actual_upstream_endpoint: null,
      }))
      .eq("attempt_id", started.data!.attempt_id);
    expect(completed.error).toBeNull();
  });

  it("rejects raw upstream IDs, credentials, JWTs, prose, and malformed HMAC tags", async () => {
    const unsafeRequestIds = [
      "gw-123",
      "provider-123",
      crypto.randomUUID(),
      "sk-live-do-not-store",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature",
      "ordinary request id prose",
      `hmac-sha256:${"A".repeat(64)}`,
      `HMAC-SHA256:${"a".repeat(64)}`,
      `hmac-sha256:${"a".repeat(63)}`,
      `hmac-sha256:${"a".repeat(65)}`,
      `hmac-sha256:${"g".repeat(64)}`,
      `hmac-sha256:${"a".repeat(32)}\n${"b".repeat(31)}`,
    ];

    for (const field of ["gateway_request_id", "provider_request_id"]) {
      for (const value of unsafeRequestIds) {
        const fixture = await createReservation();
        const started = await insertStarted(fixture);
        const completed = await service
          .from("ai_provider_attempt_ledger")
          .update(observedCompletion({ [field]: value }))
          .eq("attempt_id", started.data!.attempt_id);
        expect(completed.error?.code, `${field}=${JSON.stringify(value)}`).toBe(CHECK_VIOLATION);
      }
    }
  });

  it("rejects any observed model that is not the frozen reservation model", async () => {
    for (const modelId of [
      "vendor/model.v2:pro",
      "deepseek-v4-flash ",
      "DeepSeek-v4-flash",
      "sk-live-model-prose",
      "",
    ]) {
      const fixture = await createReservation();
      const started = await insertStarted(fixture);
      const completed = await service
        .from("ai_provider_attempt_ledger")
        .update(observedCompletion({ actual_model_id: modelId }))
        .eq("attempt_id", started.data!.attempt_id);
      expect(completed.error?.code, JSON.stringify(modelId)).toBe(CHECK_VIOLATION);
    }
  });

  it("rejects malformed, credential-bearing, encoded, or non-HTTPS endpoint observations", async () => {
    const unsafeEndpoints = [
      "https:///api_key=do-not-store",
      "https://api.deepseek.com/v1/chat/completions",
      "https://api.deepseek.com/chat/completions/",
      "https://api.xiaomimimo.com/v1/responses",
      "https://api.deepseek.com/chat/completions/api_key=sk-live-do-not-store",
      "https://api.deepseek.com/chat/completions/sk-live-do-not-store",
      "http://api.example.com/v1",
      "HTTPS://api.example.com/v1",
      "https://",
      "https://api",
      "https://user:pass@api.example.com/v1",
      "https://api.example.com/v1?token=secret",
      "https://api.example.com/v1#fragment",
      "https://api.example.com/with space",
      "https://api.example.com/line\nbreak",
      "https://api.example.com/path@user",
      "https://api.example.com/%40hidden-userinfo",
      "https://secret.example.com/v1",
      "https://999.999.999.999/v1",
      "https://[::1]/v1",
      "https://-api.example.com/v1",
      "https://api..example.com/v1",
      "https://api.example.123/v1",
      "https://api.example.com:0/v1",
      "https://api.example.com:65536/v1",
      `https://${"a".repeat(500)}.com/v1`,
      `https://${["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(63), "com"].join(".")}/v1`,
      `https://api.example.com/${"a".repeat(490)}`,
    ];

    for (const endpoint of unsafeEndpoints) {
      const fixture = await createReservation();
      const started = await insertStarted(fixture);
      const completed = await service
        .from("ai_provider_attempt_ledger")
        .update(observedCompletion({ actual_upstream_endpoint: endpoint }))
        .eq("attempt_id", started.data!.attempt_id);
      expect(completed.error?.code, endpoint).toBe(CHECK_VIOLATION);
    }
  });

  it("requires NULL endpoint observations for unknown aliases and alias/route mismatches", async () => {
    const cases = [
      {
        input: {
          key: "unknown-endpoint",
          gatewayKind: "direct_deepseek" as const,
          adapterKind: "fixture_chat_v1",
          wireApiKind: "chat_completions_v1" as const,
          endpointAlias: "unregistered_endpoint_v1",
          modelId: "fixture-unknown-endpoint-model",
        },
        endpoint: "https://unregistered.example.net/v1/responses",
      },
      {
        input: {
          key: "mismatched-endpoint",
          gatewayKind: "direct_deepseek" as const,
          adapterKind: "fixture_responses_v1",
          wireApiKind: "responses_v1" as const,
          endpointAlias: "deepseek_official",
          modelId: "fixture-mismatched-endpoint-model",
        },
        endpoint: "https://api.deepseek.com/chat/completions",
      },
    ];

    for (const { input, endpoint } of cases) {
      const fixture = await createCustomReservation(input);
      const started = await insertStarted(fixture);
      const nonNullEndpoint = await service
        .from("ai_provider_attempt_ledger")
        .update(observedCompletion({
          actual_model_id: input.modelId,
          actual_upstream_endpoint: endpoint,
        }))
        .eq("attempt_id", started.data!.attempt_id);
      expect(nonNullEndpoint.error?.code, input.key).toBe(CHECK_VIOLATION);

      const nullEndpoint = await service
        .from("ai_provider_attempt_ledger")
        .update(observedCompletion({
          actual_model_id: input.modelId,
          actual_upstream_endpoint: null,
        }))
        .eq("attempt_id", started.data!.attempt_id);
      expect(nullEndpoint.error, input.key).toBeNull();
    }
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

  it("keeps false distinct from unknown provider billability", async () => {
    const fixture = await createReservation();
    const started = await insertStarted(fixture);
    const completed = await service
      .from("ai_provider_attempt_ledger")
      .update({
        ...unavailableCompletion("canceled"),
        provider_billable: false,
      })
      .eq("attempt_id", started.data!.attempt_id)
      .select("provider_billable")
      .single();
    expect(completed.error).toBeNull();
    expect(completed.data?.provider_billable).toBe(false);
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

  it("reserves unknown for the reconciler's null-billable unavailable-usage shape", async () => {
    const invalidUnknownCompletions = [
      {
        label: "observed complete usage",
        completion: observedCompletion({
          status: "unknown",
          provider_billable: null,
          estimated_currency: null,
          estimated_cost_nanos: null,
          cost_reconciliation_status: "incomplete_usage",
          finish_reason: null,
        }),
      },
      {
        label: "known provider billability",
        completion: {
          ...unavailableCompletion("unknown"),
          provider_billable: false,
        },
      },
      {
        label: "known provider-reported cost",
        completion: {
          ...unavailableCompletion("unknown"),
          provider_reported_currency: "CNY",
          provider_reported_cost_nanos: 1,
        },
      },
      {
        label: "manufactured zero usage",
        completion: {
          ...unavailableCompletion("unknown"),
          usage_observation_kind: "observed",
          usage_schema_version: "normalized_usage_v2",
          input_total_tokens: 0,
          input_cache_read_tokens: 0,
          input_cache_write_tokens: 0,
          input_standard_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0,
          cache_usage_reporting: "not_applicable",
          usage_complete: true,
        },
      },
    ];

    for (const { label, completion } of invalidUnknownCompletions) {
      const fixture = await createReservation();
      const started = await insertStarted(fixture);
      const completed = await service
        .from("ai_provider_attempt_ledger")
        .update(completion)
        .eq("attempt_id", started.data!.attempt_id);
      expect(completed.error?.code, label).toBe(CHECK_VIOLATION);
    }
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
      { usage_observation_kind: null },
      { usage_schema_version: null },
      { usage_complete: null },
      { cache_usage_reporting: null },
      { input_cache_write_tokens: 0 },
      { input_standard_tokens: 41 },
      { reasoning_tokens: 21 },
      { input_total_tokens: "9007199254740992", input_cache_read_tokens: SAFE_INTEGER_MAX, input_standard_tokens: 1 },
      { route_observation_schema_version: null },
      { router_attempt_count: 0 },
      { router_attempt_count: 101 },
      { cost_observation_schema_version: null },
      { estimated_currency: null },
      { estimated_currency: "USD" },
      { provider_reported_currency: "USD", provider_reported_cost_nanos: 1234 },
      { cost_reconciliation_status: null },
      { cost_reconciliation_status: "matched", provider_reported_currency: null, provider_reported_cost_nanos: null },
      { actual_upstream_endpoint: "https://user:secret@example.com/v1" },
      { actual_upstream_endpoint: "https://api.example.com/v1?token=secret" },
      { provider_request_id: "api_key=do-not-store" },
      { failure_stage: "provider_http\nraw-message" },
      { latency_ms: null },
      { terminal_at: null },
      { terminal_at: "1970-01-01T00:00:00Z" },
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

  it("allows parent retention and user deletion cascades while leaving no orphan", async () => {
    const retentionFixture = await createReservation();
    const retentionAttempt = await insertStarted(retentionFixture);
    expect(retentionAttempt.error).toBeNull();
    await finalizeReservation(retentionFixture.reservationId);

    const deleteParent = await service
      .from("ai_request_ledger")
      .delete()
      .eq("reservation_id", retentionFixture.reservationId);
    expect(deleteParent.error).toBeNull();
    const retainedChild = await service
      .from("ai_provider_attempt_ledger")
      .select("attempt_id")
      .eq("attempt_id", retentionAttempt.data!.attempt_id)
      .maybeSingle();
    expect(retainedChild.error).toBeNull();
    expect(retainedChild.data).toBeNull();

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

    const update = await anon
      .from("ai_provider_attempt_ledger")
      .update({ status: "canceled" })
      .eq("reservation_id", fixture.reservationId);
    expect(update.error?.code).toBe(PERMISSION_DENIED);

    const remove = await anon
      .from("ai_provider_attempt_ledger")
      .delete()
      .eq("reservation_id", fixture.reservationId);
    expect(remove.error?.code).toBe(PERMISSION_DENIED);
  });
});
