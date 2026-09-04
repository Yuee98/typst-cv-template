import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminAnalyticsSchema } from "@/lib/admin/contract";
import {
  createServiceClient,
  createAnonClient,
  createTestUser,
  deleteTestUser,
  RUN_DB_TESTS,
  signInAsUser,
  type TestUser,
} from "./helpers";
import { runOwnerSql } from "./runtime-contract-fixtures";

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const base = { p_environment: "local", p_project_ref: "local" };

describe.skipIf(!RUN_DB_TESTS)("Admin analytics projection", () => {
  let service: SupabaseClient;
  let admin: SupabaseClient;
  let ordinary: SupabaseClient;
  let adminUser: TestUser;
  let ordinaryUser: TestUser;
  let ownsEnvironment = false;
  const requestA = "a1000000-0000-4000-8000-000000000001";
  const requestB = "a1000000-0000-4000-8000-000000000002";

  beforeAll(async () => {
    service = createServiceClient();
    adminUser = await createTestUser(service, "analytics-admin");
    ordinaryUser = await createTestUser(service, "analytics-ordinary");
    admin = await signInAsUser(adminUser);
    ordinary = await signInAsUser(ordinaryUser);
    const token = (await admin.auth.getSession()).data.session?.access_token;
    if (!token) throw new Error("analytics admin session missing");
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    ) as { iss?: string };
    const exists = runOwnerSql(
      "select count(*) from public.admin_environment;",
    ).stdout.match(/\n\s*(\d+)\s*\n/)?.[1];
    if (exists !== "0") {
      throw new Error("analytics test requires an uninitialized admin environment");
    }
    runOwnerSql(
      `select public.admin_bootstrap_v1(${literal(adminUser.id)},'local','local',${literal(claims.iss ?? "")},'analytics test bootstrap');`,
    );
    ownsEnvironment = true;
    runOwnerSql(String.raw`
      begin;
      set local session_replication_role = replica;
      insert into public.ai_request_ledger(
        reservation_id, request_id, client_request_id, user_id,
        attempt_count, state, status, latency_ms, quota_charged,
        provider_billable, usage_complete, reserved_at, finalized_at,
        billing_currency, known_estimated_cost_nanos, estimated_cost_nanos,
        provider_reported_currency, provider_reported_cost_nanos,
        cost_reconciliation_status
      ) values (
        '${requestA}'::uuid, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
        '${adminUser.id}'::uuid, 2, 'finalized', 'succeeded', 120, true,
        true, true, clock_timestamp() - interval '2 hours',
        clock_timestamp() - interval '1 hour', 'USD', 100, 100, 'USD', 110,
        'mismatch'
      );
      insert into public.ai_request_ledger(
        reservation_id, request_id, client_request_id, user_id,
        attempt_count, state, provider_started_at, reserved_at,
        billing_currency, known_estimated_cost_nanos, estimated_cost_nanos,
        cost_reconciliation_status
      ) values (
        '${requestB}'::uuid, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
        '${adminUser.id}'::uuid, 1, 'provider_started',
        clock_timestamp() - interval '12 minutes',
        clock_timestamp() - interval '13 minutes', 'CNY', 0, 0, 'pending'
      );

      insert into public.ai_provider_attempt_ledger(
        attempt_id, reservation_id, attempt_no, route_schema_version,
        config_generation, routing_policy_version_id, profile_version_id,
        price_version_id, legal_bundle_version, runtime_contract_id,
        gateway_kind, model_id, wire_api_kind, display_disclosure_key,
        adapter_kind, credential_alias, endpoint_alias, capability_contract_id,
        cache_policy_id, legal_manifest_id, calculator_kind, billing_currency,
        status, started_at, terminal_at, provider_billable,
        usage_observation_kind, usage_complete, route_observation_schema_version,
        actual_model_id, router_attempt_count, cost_observation_schema_version,
        cost_reconciliation_status, failure_stage, latency_ms, transmitted,
        retry_eligible, usage_schema_version, input_total_tokens,
        input_cache_read_tokens, input_cache_write_tokens,
        input_standard_tokens, output_tokens, reasoning_tokens,
        cache_usage_reporting, estimated_currency, estimated_cost_nanos,
        provider_reported_currency, provider_reported_cost_nanos
      ) values (
        'a2000000-0000-4000-8000-000000000001'::uuid, '${requestA}'::uuid,
        1, 'route_snapshot_v1', 1, extensions.gen_random_uuid(),
        extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'legal.bundle',
        'runtime.contract', 'direct_deepseek', 'deepseek-v4-flash',
        'chat_completions_v1', 'deepseek-display', 'deepseek_chat_v1',
        'deepseek_key', 'deepseek_endpoint', 'capability.v1', 'cache.v1',
        'legal.manifest', 'linear_token_v1', 'USD', 'failed_upstream',
        clock_timestamp() - interval '100 minutes',
        clock_timestamp() - interval '99 minutes', true, 'unavailable', false,
        'route_observation_v1', 'deepseek-v4-flash', 1,
        'cost_observation_v1', 'incomplete_usage', 'provider_http', 60, true, true,
        null, null, null, null, null, null, null, null, null, null, null, null
      ), (
        'a2000000-0000-4000-8000-000000000002'::uuid, '${requestA}'::uuid,
        2, 'route_snapshot_v1', 1, extensions.gen_random_uuid(),
        extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'legal.bundle',
        'runtime.contract', 'direct_deepseek', 'deepseek-v4-flash',
        'chat_completions_v1', 'deepseek-display', 'deepseek_chat_v1',
        'deepseek_key', 'deepseek_endpoint', 'capability.v1', 'cache.v1',
        'legal.manifest', 'linear_token_v1', 'USD', 'succeeded',
        clock_timestamp() - interval '90 minutes',
        clock_timestamp() - interval '89 minutes', true, 'observed', true,
        'route_observation_v1', 'deepseek-v4-flash', 2,
        'cost_observation_v1', 'matched', null, 80, true, false,
        'normalized_usage_v2', 15, 2, 0, 13, 5, 1, 'reported',
        'USD', 100, 'USD', 100
      );
      insert into public.ai_provider_attempt_ledger(
        attempt_id, reservation_id, attempt_no, route_schema_version,
        config_generation, routing_policy_version_id, profile_version_id,
        price_version_id, legal_bundle_version, runtime_contract_id,
        gateway_kind, model_id, wire_api_kind, display_disclosure_key,
        adapter_kind, credential_alias, endpoint_alias, capability_contract_id,
        cache_policy_id, legal_manifest_id, calculator_kind, billing_currency,
        status, started_at, transmitted, retry_eligible
      ) values (
        'a2000000-0000-4000-8000-000000000003'::uuid, '${requestB}'::uuid,
        1, 'route_snapshot_v1', 1, extensions.gen_random_uuid(),
        extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'legal.bundle',
        'runtime.contract', 'direct_mimo', 'mimo-v2.5-pro', 'responses_v1',
        'mimo-display', 'mimo_responses_v1', 'mimo_key', 'mimo_endpoint',
        'capability.v1', 'cache.v1', 'legal.manifest', 'linear_token_v1', 'CNY',
        'started', clock_timestamp() - interval '11 minutes', false, false
      );
      commit;
    `);
  });

  afterAll(async () => {
    if (ownsEnvironment) {
      runOwnerSql(
        `delete from public.ai_request_ledger where reservation_id in (${literal(requestA)}::uuid,${literal(requestB)}::uuid);
         delete from public.admin_principals where user_id=${literal(adminUser.id)};
         delete from public.admin_environment where id=true;`,
      );
    }
    if (adminUser) await deleteTestUser(service, adminUser.id);
    if (ordinaryUser) await deleteTestUser(service, ordinaryUser.id);
  });

  async function read(from: Date, to: Date, client = admin) {
    const result = await client.rpc("admin_get_ai_analytics_v1", {
      ...base,
      p_from: from.toISOString(),
      p_to: to.toISOString(),
    });
    return result;
  }

  it("returns the bounded content-free request, attempt, usage, cost and route projection", async () => {
    const to = new Date();
    const result = await read(new Date(to.getTime() - 7 * 86_400_000), to);
    expect(result.error).toBeNull();
    const analytics = adminAnalyticsSchema.parse(result.data);
    expect(analytics.range).toMatchObject({
      timezone: "UTC",
      retentionDays: 90,
      requestTimeField: "reserved_at",
      attemptTimeField: "started_at",
    });
    expect(analytics.requests).toMatchObject({ total: 2, finalized: 1, succeeded: 1, retried: 1 });
    expect(analytics.attempts).toMatchObject({ total: 3, transmitted: 2, succeeded: 1, failedUpstream: 1, unsettled: 1 });
    expect(analytics.usage).toMatchObject({ completeRows: 1, incompleteRows: 2, inputCacheReadTokens: "2", inputStandardTokens: "13", outputTokens: "5", reasoningTokens: "1" });
    expect(analytics.costsByCurrency).toEqual([
      expect.objectContaining({ currency: "CNY", requestRows: 1, incompleteRows: 1 }),
      expect.objectContaining({ currency: "USD", requestRows: 1, knownEstimatedNanos: "100", estimatedNanos: "100", providerReportedNanos: "110", mismatchRows: 1 }),
    ]);
    expect(analytics.routes).toEqual([
      expect.objectContaining({ gatewayKind: "direct_deepseek", modelId: "deepseek-v4-flash", attempts: 2, succeeded: 1, transmitted: 2 }),
      expect.objectContaining({ gatewayKind: "direct_mimo", modelId: "mimo-v2.5-pro", attempts: 1, succeeded: 0, transmitted: 0 }),
    ]);
    expect(analytics.costsByCurrency.length).toBeLessThanOrEqual(16);
    expect(analytics.routes.length).toBeLessThanOrEqual(128);
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toMatch(/promptText|resume|email|secret|api[_-]?key|providerRequestId|actualUpstreamEndpoint/i);
  });

  it("accepts one and 31 day windows and marks data older than retention", async () => {
    const to = new Date();
    for (const days of [1, 31]) {
      const result = await read(new Date(to.getTime() - days * 86_400_000), to);
      expect(result.error, `${days}-day window`).toBeNull();
      expect(adminAnalyticsSchema.parse(result.data).range.rangeMayBeTruncated).toBe(false);
    }
    const old = await read(
      new Date(to.getTime() - 91 * 86_400_000),
      new Date(to.getTime() - 90 * 86_400_000),
    );
    expect(old.error).toBeNull();
    expect(adminAnalyticsSchema.parse(old.data).range.rangeMayBeTruncated).toBe(true);
  });

  it("rejects invalid ranges and unauthorized callers", async () => {
    const to = new Date();
    for (const [from, end] of [
      [new Date(to.getTime() - 32 * 86_400_000), to],
      [to, new Date(to.getTime() - 1_000)],
      [new Date(to.getTime() - 86_400_000), new Date(to.getTime() + 2 * 60_000)],
    ]) {
      expect((await read(from, end)).error).not.toBeNull();
    }
    expect((await ordinary.rpc("admin_get_ai_analytics_v1", {
      ...base,
      p_from: new Date(to.getTime() - 86_400_000).toISOString(),
      p_to: to.toISOString(),
    })).error?.code).toBe("42501");
    expect((await createAnonClient().rpc("admin_get_ai_analytics_v1", {
      ...base,
      p_from: new Date(to.getTime() - 86_400_000).toISOString(),
      p_to: to.toISOString(),
    })).error?.code).toBe("42501");
    expect((await admin.rpc("admin_get_ai_analytics_v1", {
      p_environment: "preview",
      p_project_ref: "local",
      p_from: new Date(to.getTime() - 86_400_000).toISOString(),
      p_to: to.toISOString(),
    })).error?.message).toBe("ENVIRONMENT_MISMATCH");
  });
});
