import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAnonClient, createServiceClient, RUN_DB_TESTS } from "./helpers";
import {
  attemptMetadata,
  completePayload,
  costObservation,
  observedUsage,
  routeObservation,
  SettlementHarness,
} from "./provider-attempt-settlement-fixtures";
import { runOwnerSql } from "./runtime-contract-fixtures";

describe.skipIf(!RUN_DB_TESTS)("provider attempt completion RPC (real DB)", () => {
  let service: SupabaseClient;
  let anon: SupabaseClient;
  let harness: SettlementHarness;

  beforeAll(async () => {
    service = createServiceClient();
    anon = createAnonClient();
    harness = new SettlementHarness(service);
    await harness.setup();
  });

  beforeEach(async () => {
    await harness.resetFeature();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  async function startedAttempt(label: string) {
    const user = await harness.makeUser(label);
    const reservation = await harness.reserveV2(user);
    const attempt = await harness.startAttempt(reservation.reservationId, 1);
    return { user, reservation, attempt };
  }

  it("freezes the exact definer signature and service-role-only ACL", async () => {
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      do $assertions$
      declare
        v_complete pg_catalog.pg_proc%rowtype;
      begin
        if (
          select count(*)
          from pg_catalog.pg_proc
          where pronamespace = 'public'::pg_catalog.regnamespace
            and proname = 'complete_ai_polish_provider_attempt'
        ) <> 1 then
          raise exception 'complete RPC must have exactly one overload';
        end if;

        select * into v_complete
        from pg_catalog.pg_proc
        where oid = 'public.complete_ai_polish_provider_attempt(uuid,text,boolean,jsonb,jsonb,jsonb,jsonb)'::pg_catalog.regprocedure;

        if not v_complete.prosecdef
           or v_complete.proconfig is distinct from array['search_path=""']::text[]
           or v_complete.pronargdefaults <> 0
           or pg_catalog.pg_get_function_identity_arguments(v_complete.oid)
             is distinct from 'p_attempt_id uuid, p_status text, p_provider_billable boolean, p_usage jsonb, p_route jsonb, p_cost jsonb, p_metadata jsonb'
           or pg_catalog.pg_get_function_result(v_complete.oid) is distinct from 'jsonb'
           or pg_catalog.regexp_count(
             pg_catalog.pg_get_functiondef(v_complete.oid),
             'clock_timestamp\(\)'
           ) <> 1 then
          raise exception 'complete RPC definition drifted';
        end if;

        if not pg_catalog.has_function_privilege(
             'service_role', v_complete.oid, 'EXECUTE'
           )
           or pg_catalog.has_function_privilege('anon', v_complete.oid, 'EXECUTE')
           or pg_catalog.has_function_privilege(
             'authenticated', v_complete.oid, 'EXECUTE'
           )
           or exists (
             select 1
             from pg_catalog.aclexplode(v_complete.proacl)
             where grantee = 0
           ) then
          raise exception 'complete RPC ACL drifted';
        end if;
      end
      $assertions$;
    `);

    const denied = await anon.rpc("complete_ai_polish_provider_attempt", {
      p_attempt_id: crypto.randomUUID(),
      p_status: "succeeded",
      p_provider_billable: true,
      p_usage: observedUsage(),
      p_route: routeObservation(),
      p_cost: costObservation(),
      p_metadata: attemptMetadata(),
    });
    expect(denied.data).toBeNull();
    expect(denied.error?.code).toBe("42501");
  });

  it("persists every public terminal status while leaving parent and aggregates untouched", async () => {
    for (const status of [
      "succeeded",
      "invalid_output",
      "failed_upstream",
      "timed_out",
      "canceled",
    ]) {
      const { user, reservation, attempt } = await startedAttempt(
        `attempt-complete-${status}`,
      );
      const beforeUser = await service
        .from("ai_usage_daily")
        .select("*")
        .eq("user_id", user.id)
        .order("day");
      const beforeGlobal = await service
        .from("ai_global_usage_daily")
        .select("*")
        .order("day");
      const beforeProfile = await service
        .from("ai_profile_usage_daily")
        .select("*")
        .eq("profile_version_id", harness.fixture.profileVersionId);

      expect(
        await harness.complete(
          completePayload(attempt.attemptId, { p_status: status }),
        ),
      ).toEqual({
        ok: true,
        alreadyCompleted: false,
        status,
        usageComplete: true,
      });

      const row = await service
        .from("ai_provider_attempt_ledger")
        .select("*")
        .eq("attempt_id", attempt.attemptId)
        .single();
      expect(row.error).toBeNull();
      expect(row.data).toMatchObject({
        reservation_id: reservation.reservationId,
        attempt_no: 1,
        status,
        provider_billable: true,
        usage_observation_kind: "observed",
        usage_schema_version: "normalized_usage_v2",
        input_total_tokens: 100,
        input_cache_read_tokens: 60,
        input_cache_write_tokens: 10,
        input_standard_tokens: 30,
        output_tokens: 20,
        reasoning_tokens: 5,
        cache_usage_reporting: "reported",
        usage_complete: true,
        route_observation_schema_version: "route_observation_v1",
        cost_observation_schema_version: "cost_observation_v1",
        estimated_currency: "CNY",
        estimated_cost_nanos: 1234,
        provider_reported_currency: null,
        provider_reported_cost_nanos: null,
        cost_reconciliation_status: "not_available",
        finish_reason: "stop",
        failure_stage: null,
        latency_ms: 1234,
      });
      expect(Date.parse(row.data!.terminal_at)).toBeGreaterThanOrEqual(
        Date.parse(row.data!.started_at),
      );

      const parent = await service
        .from("ai_request_ledger")
        .select("state,provider_started_at,attempt_count,status")
        .eq("reservation_id", reservation.reservationId)
        .single();
      expect(parent.data).toEqual({
        state: "reserved",
        provider_started_at: null,
        attempt_count: 1,
        status: null,
      });
      expect(
        await service
          .from("ai_usage_daily")
          .select("*")
          .eq("user_id", user.id)
          .order("day"),
      ).toEqual(beforeUser);
      expect(
        await service.from("ai_global_usage_daily").select("*").order("day"),
      ).toEqual(beforeGlobal);
      expect(
        await service
          .from("ai_profile_usage_daily")
          .select("*")
          .eq("profile_version_id", harness.fixture.profileVersionId),
      ).toEqual(beforeProfile);
    }
  });

  it("canonicalizes unavailable usage and safe route metadata", async () => {
    const { reservation, attempt } = await startedAttempt(
      "attempt-complete-unavailable",
    );
    const payload = completePayload(attempt.attemptId, {
      p_status: "canceled",
      p_provider_billable: false,
      p_usage: null,
      p_route: routeObservation({
        gateway_request_id: `hmac-sha256:${"a".repeat(64)}`,
        provider_request_id: `hmac-sha256:${"b".repeat(64)}`,
        actual_upstream_endpoint: "https://api.deepseek.com/chat/completions",
        actual_model_id: harness.fixture.modelId,
        router_attempt_count: 1,
      }),
      p_cost: costObservation({
        estimated_currency: null,
        estimated_cost_nanos: null,
        reconciliation_status: "incomplete_usage",
      }),
      p_metadata: attemptMetadata({
        finish_reason: null,
        failure_stage: "canceled",
        latency_ms: 0,
      }),
    });

    expect(await harness.complete(payload)).toEqual({
      ok: true,
      alreadyCompleted: false,
      status: "canceled",
      usageComplete: false,
    });
    const row = await service
      .from("ai_provider_attempt_ledger")
      .select("*")
      .eq("attempt_id", attempt.attemptId)
      .single();
    expect(row.data).toMatchObject({
      reservation_id: reservation.reservationId,
      usage_observation_kind: "unavailable",
      usage_schema_version: null,
      input_total_tokens: null,
      usage_complete: false,
      provider_billable: false,
      estimated_currency: null,
      estimated_cost_nanos: null,
      cost_reconciliation_status: "incomplete_usage",
      actual_upstream_endpoint: "https://api.deepseek.com/chat/completions",
      actual_model_id: harness.fixture.modelId,
      router_attempt_count: 1,
      failure_stage: "canceled",
      latency_ms: 0,
    });
  });

  it("derives cost reconciliation and treats caller status only as an assertion", async () => {
    const cases = [
      {
        label: "incomplete",
        cost: costObservation({
          estimated_currency: null,
          estimated_cost_nanos: null,
          reconciliation_status: null,
        }),
        expected: "incomplete_usage",
      },
      {
        label: "not-available",
        cost: costObservation({ reconciliation_status: null }),
        expected: "not_available",
      },
      {
        label: "matched",
        cost: costObservation({
          provider_reported_currency: "CNY",
          provider_reported_cost_nanos: "1234",
          reconciliation_status: "matched",
        }),
        expected: "matched",
      },
      {
        label: "mismatch",
        cost: costObservation({
          provider_reported_currency: "CNY",
          provider_reported_cost_nanos: "1235",
          reconciliation_status: "mismatch",
        }),
        expected: "mismatch",
      },
    ];

    for (const entry of cases) {
      const { attempt } = await startedAttempt(`attempt-complete-${entry.label}`);
      expect(
        await harness.complete(
          completePayload(attempt.attemptId, { p_cost: entry.cost }),
        ),
      ).toMatchObject({ ok: true, alreadyCompleted: false });
      const row = await service
        .from("ai_provider_attempt_ledger")
        .select("cost_reconciliation_status")
        .eq("attempt_id", attempt.attemptId)
        .single();
      expect(row.data?.cost_reconciliation_status).toBe(entry.expected);
    }

    const { attempt } = await startedAttempt("attempt-complete-conflicting-cost");
    expect(
      await harness.complete(
        completePayload(attempt.attemptId, {
          p_cost: costObservation({ reconciliation_status: "pending" }),
        }),
      ),
    ).toEqual({ ok: false, reason: "INTERNAL_ERROR" });
    const unchanged = await service
      .from("ai_provider_attempt_ledger")
      .select("status,terminal_at")
      .eq("attempt_id", attempt.attemptId)
      .single();
    expect(unchanged.data).toEqual({ status: "started", terminal_at: null });
  });

  it("allows explicit-false null/zero reports and rejects nonzero or foreign-currency reports", async () => {
    for (const [label, providerCost] of [
      [null, null],
      ["0", "0"],
    ] as const) {
      const { attempt } = await startedAttempt(
        `attempt-complete-false-${label ?? "null"}`,
      );
      const cost = costObservation(
        providerCost === null
          ? {}
          : {
              provider_reported_currency: "CNY",
              provider_reported_cost_nanos: providerCost,
              reconciliation_status: "mismatch",
            },
      );
      expect(
        await harness.complete(
          completePayload(attempt.attemptId, {
            p_provider_billable: false,
            p_cost: cost,
          }),
        ),
      ).toMatchObject({ ok: true });
    }

    for (const [label, patch] of [
      [
        "nonzero",
        {
          provider_reported_currency: "CNY",
          provider_reported_cost_nanos: "1",
          reconciliation_status: "mismatch",
        },
      ],
      [
        "foreign",
        {
          provider_reported_currency: "USD",
          provider_reported_cost_nanos: "0",
          reconciliation_status: "mismatch",
        },
      ],
    ] as const) {
      const { attempt } = await startedAttempt(`attempt-complete-false-${label}`);
      expect(
        await harness.complete(
          completePayload(attempt.attemptId, {
            p_provider_billable: false,
            p_cost: costObservation(patch),
          }),
        ),
      ).toEqual({ ok: false, reason: "INTERNAL_ERROR" });
      const row = await service
        .from("ai_provider_attempt_ledger")
        .select("status")
        .eq("attempt_id", attempt.attemptId)
        .single();
      expect(row.data?.status).toBe("started");
    }
  });

  it("rejects malformed schemas, keys, scalar types, unsafe integers, and conservation failures without mutation", async () => {
    const invalidPatches = [
      { p_usage: {} },
      { p_usage: [] },
      { p_usage: "normalized_usage_v2" },
      { p_usage: observedUsage({ extra: 1 }) },
      { p_usage: observedUsage({ schema_version: "unknown" }) },
      { p_usage: observedUsage({ input_total_tokens: 9_007_199_254_740_992 }) },
      { p_usage: observedUsage({ input_total_tokens: 101 }) },
      { p_usage: observedUsage({ reasoning_tokens: 21 }) },
      { p_route: routeObservation({ provider_request_id: "raw-provider-id" }) },
      { p_route: routeObservation({ actual_model_id: "other-model" }) },
      { p_route: routeObservation({ router_attempt_count: 0 }) },
      { p_cost: costObservation({ estimated_cost_nanos: "01" }) },
      { p_cost: costObservation({ estimated_cost_nanos: "9223372036854775808" }) },
      { p_metadata: attemptMetadata({ latency_ms: -1 }) },
      { p_metadata: attemptMetadata({ failure_stage: "Bad Stage" }) },
      { p_metadata: attemptMetadata({ unknown: null }) },
    ];

    for (const [index, patch] of invalidPatches.entries()) {
      const { attempt } = await startedAttempt(`attempt-complete-parser-${index}`);
      expect(
        await harness.complete(completePayload(attempt.attemptId, patch)),
      ).toEqual({ ok: false, reason: "INTERNAL_ERROR" });
      const row = await service
        .from("ai_provider_attempt_ledger")
        .select("status,terminal_at")
        .eq("attempt_id", attempt.attemptId)
        .single();
      expect(row.data).toEqual({ status: "started", terminal_at: null });
    }
  });

  it("replays a canonical completion and rejects any changed field", async () => {
    const { attempt } = await startedAttempt("attempt-complete-replay");
    const payload = completePayload(attempt.attemptId, {
      p_route: routeObservation({
        provider_request_id: `hmac-sha256:${"c".repeat(64)}`,
      }),
    });
    const first = await harness.complete(payload);
    expect(first).toEqual({
      ok: true,
      alreadyCompleted: false,
      status: "succeeded",
      usageComplete: true,
    });
    const before = await service
      .from("ai_provider_attempt_ledger")
      .select("*")
      .eq("attempt_id", attempt.attemptId)
      .single();

    expect(await harness.complete(payload)).toEqual({
      ...first,
      alreadyCompleted: true,
    });
    const reordered = {
      ...(payload.p_route as Record<string, unknown>),
      schema_version: "route_observation_v1",
    };
    expect(
      await harness.complete({ ...payload, p_route: reordered }),
    ).toMatchObject({ ok: true, alreadyCompleted: true });
    expect(
      await harness.complete({
        ...payload,
        p_metadata: attemptMetadata({ latency_ms: 1235 }),
      }),
    ).toEqual({ ok: false, reason: "ATTEMPT_COMPLETION_CONFLICT" });

    const after = await service
      .from("ai_provider_attempt_ledger")
      .select("*")
      .eq("attempt_id", attempt.attemptId)
      .single();
    expect(after.data).toEqual(before.data);
  });

  it("returns finalized denial before parsing a hostile late payload", async () => {
    const { reservation, attempt } = await startedAttempt(
      "attempt-complete-finalized-hostile",
    );
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
      .eq("reservation_id", reservation.reservationId);
    expect(finalized.error).toBeNull();

    expect(
      await harness.complete({
        p_attempt_id: attempt.attemptId,
        p_status: "unknown-hostile",
        p_provider_billable: true,
        p_usage: { hostile: true },
        p_route: [],
        p_cost: "bad",
        p_metadata: 1,
      }),
    ).toEqual({ ok: false, reason: "REQUEST_ALREADY_FINALIZED" });
    const row = await service
      .from("ai_provider_attempt_ledger")
      .select("status,terminal_at")
      .eq("attempt_id", attempt.attemptId)
      .single();
    expect(row.data).toEqual({ status: "started", terminal_at: null });
  });
});
