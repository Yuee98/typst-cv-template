import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createServiceClient,
  getGlobalUsageRow,
  getLedgerRow,
  getUsageRow,
  RUN_DB_TESTS,
  tryReserve,
} from "./helpers";
import {
  attemptMetadata,
  completePayload,
  costObservation,
  observedUsage,
  SettlementHarness,
} from "./provider-attempt-settlement-fixtures";
import { runOwnerSql } from "./runtime-contract-fixtures";

describe.skipIf(!RUN_DB_TESTS)("provider attempt request settlement (real DB)", () => {
  let service: SupabaseClient;
  let harness: SettlementHarness;

  beforeAll(async () => {
    service = createServiceClient();
    harness = new SettlementHarness(service);
    await harness.setup();
  });

  beforeEach(async () => {
    await harness.resetFeature();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  async function started(label: string, attemptNo: 1 | 2 = 1) {
    const user = await harness.makeUser(label);
    const reservation = await harness.reserveV2(user);
    const attempt = await harness.startAttempt(
      reservation.reservationId,
      attemptNo,
    );
    return { user, reservation, attempt };
  }

  async function completed(
    label: string,
    overrides: Parameters<typeof completePayload>[1] = {},
  ) {
    const value = await started(label);
    expect(
      await harness.complete(completePayload(value.attempt.attemptId, overrides)),
    ).toMatchObject({ ok: true, alreadyCompleted: false });
    return value;
  }

  it("keeps the exact public finalize definition, defaults, invoker boundary, and ACL", () => {
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      do $assertions$
      declare
        v_finalize pg_catalog.pg_proc%rowtype;
      begin
        if (
          select count(*)
          from pg_catalog.pg_proc
          where pronamespace = 'public'::pg_catalog.regnamespace
            and proname = 'finalize_ai_polish_request'
        ) <> 1 then
          raise exception 'finalize RPC must have one overload';
        end if;

        select * into v_finalize
        from pg_catalog.pg_proc
        where oid = 'public.finalize_ai_polish_request(uuid,text,boolean,boolean,jsonb,jsonb)'::pg_catalog.regprocedure;

        if v_finalize.prosecdef
           or v_finalize.proconfig is distinct from array['search_path=""']::text[]
           or v_finalize.pronargdefaults <> 3
           or pg_catalog.pg_get_function_identity_arguments(v_finalize.oid)
             is distinct from 'p_reservation_id uuid, p_status text, p_quota_charged boolean, p_provider_billable boolean, p_usage jsonb, p_metadata jsonb'
           or pg_catalog.pg_get_function_result(v_finalize.oid) is distinct from 'jsonb' then
          raise exception 'finalize RPC definition drifted';
        end if;

        if not pg_catalog.has_function_privilege(
             'service_role', v_finalize.oid, 'EXECUTE'
           )
           or pg_catalog.has_function_privilege('anon', v_finalize.oid, 'EXECUTE')
           or pg_catalog.has_function_privilege(
             'authenticated', v_finalize.oid, 'EXECUTE'
           )
           or exists (
             select 1
             from pg_catalog.aclexplode(v_finalize.proacl)
             where grantee = 0
           ) then
          raise exception 'finalize RPC ACL drifted';
        end if;
      end
      $assertions$;
    `);
  });

  it("preserves canonical V1 usage, metadata, attempt_count, refund, and replay behavior", async () => {
    const user = await harness.makeUser("finalize-v1-regression");
    const reserve = await tryReserve(service, user.id);
    expect(reserve.ok).toBe(true);
    const reservationId = (reserve as { reservationId: string }).reservationId;

    const first = await service.rpc("finalize_ai_polish_request", {
      p_reservation_id: reservationId,
      p_status: "failed_upstream",
      p_quota_charged: false,
      p_provider_billable: true,
      p_usage: {
        input_cached_tokens: 11,
        input_uncached_tokens: 22,
        output_tokens: 33,
        usage_complete: true,
      },
      p_metadata: {
        granularity: "item",
        item_count: 2,
        context_level: 1,
        language: "zh",
        model: "legacy-model",
        prompt_version: "legacy-prompt",
        validator_version: "legacy-validator",
        attempt_count: 7,
        provider_request_id: "legacy-provider-request",
        finish_reason: "stop",
        failure_stage: "provider_http",
        latency_ms: 123,
      },
    });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({
      ok: true,
      alreadyFinalized: false,
      status: "failed_upstream",
      quotaCharged: false,
    });

    expect(await getLedgerRow(service, reservationId)).toMatchObject({
      route_schema_version: null,
      state: "finalized",
      status: "failed_upstream",
      quota_charged: false,
      provider_billable: true,
      input_cached_tokens: 11,
      input_uncached_tokens: 22,
      output_tokens: 33,
      usage_complete: true,
      granularity: "item",
      item_count: 2,
      context_level: 1,
      language: "zh",
      model: "legacy-model",
      prompt_version: "legacy-prompt",
      validator_version: "legacy-validator",
      attempt_count: 7,
      provider_request_id: "legacy-provider-request",
      finish_reason: "stop",
      failure_stage: "provider_http",
      latency_ms: 123,
    });

    const beforeReplay = {
      request: await getLedgerRow(service, reservationId),
      usage: await getUsageRow(service, user.id),
      global: await getGlobalUsageRow(service),
    };
    const replay = await service.rpc("finalize_ai_polish_request", {
      p_reservation_id: reservationId,
      p_status: "hostile",
      p_quota_charged: true,
      p_provider_billable: false,
      p_usage: "hostile",
      p_metadata: 7,
    });
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual({
      ...first.data,
      alreadyFinalized: true,
    });
    expect({
      request: await getLedgerRow(service, reservationId),
      usage: await getUsageRow(service, user.id),
      global: await getGlobalUsageRow(service),
    }).toEqual(beforeReplay);
  });

  it("only releases a clean zero-attempt V2 tuple and never manufactures usage", async () => {
    const user = await harness.makeUser("finalize-zero-release");
    const reservation = await harness.reserveV2(user);
    const beforeUsage = await getUsageRow(service, user.id);
    expect(beforeUsage?.request_count).toBe(1);

    expect(
      await harness.finalize(reservation.reservationId, {
        status: "released",
        quotaCharged: false,
        providerBillable: false,
        usage: null,
        metadata: null,
      }),
    ).toMatchObject({
      ok: true,
      alreadyFinalized: false,
      status: "released",
      quotaCharged: false,
    });

    expect(await getLedgerRow(service, reservation.reservationId)).toMatchObject({
      state: "finalized",
      status: "released",
      attempt_count: 0,
      usage_schema_version: null,
      input_cached_tokens: null,
      input_total_tokens: null,
      cost_basis: null,
      billing_currency: null,
    });
    expect((await getUsageRow(service, user.id))?.request_count).toBe(0);
    const profileDaily = await service
      .from("ai_profile_usage_daily")
      .select("*")
      .eq("profile_version_id", harness.fixture.profileVersionId);
    expect(profileDaily.error).toBeNull();
    expect(profileDaily.data).toEqual([]);
  });

  it("rejects zero-attempt attempt_v2 and every non-clean legacy tuple without mutation", async () => {
    const cases = [
      {
        label: "attempt-v2",
        options: {},
        expected: "NO_PROVIDER_ATTEMPTS",
      },
      {
        label: "status",
        options: {
          status: "succeeded",
          quotaCharged: false,
          providerBillable: false,
          metadata: null,
        },
        expected: "INTERNAL_ERROR",
      },
      {
        label: "quota",
        options: {
          status: "released",
          quotaCharged: true,
          providerBillable: false,
          metadata: null,
        },
        expected: "INTERNAL_ERROR",
      },
      {
        label: "billable",
        options: {
          status: "released",
          quotaCharged: false,
          providerBillable: null,
          metadata: null,
        },
        expected: "INTERNAL_ERROR",
      },
      {
        label: "usage-object",
        options: {
          status: "released",
          quotaCharged: false,
          providerBillable: false,
          usage: {},
          metadata: null,
        },
        expected: "INTERNAL_ERROR",
      },
    ];

    for (const entry of cases) {
      const user = await harness.makeUser(`finalize-zero-${entry.label}`);
      const reservation = await harness.reserveV2(user);
      const before = {
        request: await getLedgerRow(service, reservation.reservationId),
        usage: await getUsageRow(service, user.id),
      };
      expect(
        await harness.finalize(reservation.reservationId, entry.options),
      ).toEqual({ ok: false, reason: entry.expected });
      expect({
        request: await getLedgerRow(service, reservation.reservationId),
        usage: await getUsageRow(service, user.id),
      }).toEqual(before);
    }
  });

  it("requires attempt_v2 with absent usage once a child exists", async () => {
    const { user, reservation, attempt } = await completed(
      "finalize-source-guards",
    );
    const before = {
      request: await getLedgerRow(service, reservation.reservationId),
      usage: await getUsageRow(service, user.id),
    };

    expect(
      await harness.finalize(reservation.reservationId, { metadata: null }),
    ).toEqual({ ok: false, reason: "ATTEMPT_USAGE_SOURCE_REQUIRED" });
    expect(
      await harness.finalize(reservation.reservationId, {
        metadata: { usage_schema_version: "legacy_v1" },
      }),
    ).toEqual({ ok: false, reason: "ATTEMPT_USAGE_SOURCE_REQUIRED" });
    expect(
      await harness.finalize(reservation.reservationId, {
        usage: observedUsage(),
      }),
    ).toEqual({ ok: false, reason: "AMBIGUOUS_USAGE_SOURCE" });
    for (const metadata of [
      { usage_schema_version: "unknown" },
      { usage_schema_version: 1 },
      [],
      "attempt_v2",
      1,
    ]) {
      expect(
        await harness.finalize(reservation.reservationId, { metadata }),
      ).toEqual({ ok: false, reason: "INTERNAL_ERROR" });
    }

    expect({
      request: await getLedgerRow(service, reservation.reservationId),
      usage: await getUsageRow(service, user.id),
    }).toEqual(before);
    const child = await service
      .from("ai_provider_attempt_ledger")
      .select("status")
      .eq("attempt_id", attempt.attemptId)
      .single();
    expect(child.data?.status).toBe("succeeded");
  });

  it("rejects an in-progress attempt and parent count drift before settlement", async () => {
    const inProgress = await started("finalize-in-progress");
    expect(
      await harness.finalize(inProgress.reservation.reservationId),
    ).toEqual({ ok: false, reason: "SERVICE_UNAVAILABLE" });
    expect(await getLedgerRow(service, inProgress.reservation.reservationId)).toMatchObject({
      state: "reserved",
      attempt_count: 1,
    });

    const drift = await completed("finalize-count-drift");
    const update = await service
      .from("ai_request_ledger")
      .update({ attempt_count: 2 })
      .eq("reservation_id", drift.reservation.reservationId);
    expect(update.error).toBeNull();
    expect(await harness.finalize(drift.reservation.reservationId)).toEqual({
      ok: false,
      reason: "SERVICE_UNAVAILABLE",
    });
    expect(await getLedgerRow(service, drift.reservation.reservationId)).toMatchObject({
      state: "reserved",
      attempt_count: 2,
    });
  });

  it("settles one reported attempt into V2 and legacy ledgers exactly once", async () => {
    const { user, reservation } = await completed("finalize-one-reported");
    const usageBefore = await getUsageRow(service, user.id);
    const globalBefore = await getGlobalUsageRow(service);

    const result = await harness.finalize(reservation.reservationId);
    expect(result).toMatchObject({
      ok: true,
      alreadyFinalized: false,
      status: "succeeded",
      quotaCharged: true,
    });
    expect(await getLedgerRow(service, reservation.reservationId)).toMatchObject({
      state: "finalized",
      status: "succeeded",
      usage_schema_version: "request_usage_aggregate_v2",
      input_total_tokens: 100,
      input_cache_read_tokens: 60,
      input_cache_write_tokens: 10,
      input_standard_tokens: 30,
      output_tokens: 20,
      reasoning_tokens: 5,
      cache_usage_reporting: "reported",
      incomplete_fields: [],
      usage_complete: true,
      provider_billable: true,
      cost_basis: "frozen_price_version_v1",
      billing_currency: "CNY",
      known_estimated_cost_nanos: 1234,
      estimated_cost_nanos: 1234,
      provider_reported_currency: null,
      provider_reported_cost_nanos: null,
      cost_reconciliation_status: "not_available",
      input_cached_tokens: 60,
      input_uncached_tokens: 40,
    });

    expect(await getUsageRow(service, user.id)).toMatchObject({
      request_count: usageBefore!.request_count,
      input_cached_tokens: usageBefore!.input_cached_tokens + 60,
      input_uncached_tokens: usageBefore!.input_uncached_tokens + 40,
      output_tokens: usageBefore!.output_tokens + 20,
    });
    expect(await getGlobalUsageRow(service)).toMatchObject({
      provider_started_count: globalBefore!.provider_started_count,
      input_cached_tokens: globalBefore!.input_cached_tokens + 60,
      input_uncached_tokens: globalBefore!.input_uncached_tokens + 40,
      output_tokens: globalBefore!.output_tokens + 20,
    });
    const profile = await service
      .from("ai_profile_usage_daily")
      .select("*")
      .eq("profile_version_id", harness.fixture.profileVersionId)
      .eq("billing_currency", "CNY")
      .single();
    expect(profile.error).toBeNull();
    expect(profile.data).toMatchObject({
      request_count: 1,
      usage_incomplete_count: 0,
      cost_incomplete_count: 0,
      provider_report_incomplete_count: 1,
      input_total_tokens: 100,
      input_cache_read_tokens: 60,
      input_cache_write_tokens: 10,
      input_standard_tokens: 30,
      output_tokens: 20,
      reasoning_tokens: 5,
      known_estimated_cost_nanos: 1234,
      estimated_cost_nanos: 1234,
      provider_reported_cost_nanos: null,
    });

    const beforeReplay = {
      request: await getLedgerRow(service, reservation.reservationId),
      usage: await getUsageRow(service, user.id),
      global: await getGlobalUsageRow(service),
      profile: profile.data,
    };
    expect(
      await harness.finalize(reservation.reservationId, {
        status: "released",
        quotaCharged: false,
        providerBillable: false,
        usage: { hostile: true },
        metadata: 9,
      }),
    ).toEqual({ ...result, alreadyFinalized: true });
    const profileAfter = await service
      .from("ai_profile_usage_daily")
      .select("*")
      .eq("profile_version_id", harness.fixture.profileVersionId)
      .eq("billing_currency", "CNY")
      .single();
    expect({
      request: await getLedgerRow(service, reservation.reservationId),
      usage: await getUsageRow(service, user.id),
      global: await getGlobalUsageRow(service),
      profile: profileAfter.data,
    }).toEqual(beforeReplay);
  });

  it("keeps mixed cache-write and reasoning unknown while preserving core and legacy totals", async () => {
    const user = await harness.makeUser("finalize-mixed-cache");
    const reservation = await harness.reserveV2(user);
    const first = await harness.startAttempt(reservation.reservationId, 1);
    await harness.complete(completePayload(first.attemptId));
    const second = await harness.startAttempt(reservation.reservationId, 2);
    await harness.complete(
      completePayload(second.attemptId, {
        p_usage: observedUsage({
          input_total_tokens: 60,
          input_cache_read_tokens: 20,
          input_cache_write_tokens: null,
          input_standard_tokens: 40,
          output_tokens: 10,
          reasoning_tokens: null,
          cache_usage_reporting: "unavailable",
        }),
        p_cost: costObservation({
          estimated_cost_nanos: "100",
        }),
        p_metadata: attemptMetadata({ latency_ms: 20 }),
      }),
    );

    expect(await harness.finalize(reservation.reservationId)).toMatchObject({
      ok: true,
      alreadyFinalized: false,
    });
    expect(await getLedgerRow(service, reservation.reservationId)).toMatchObject({
      input_total_tokens: 160,
      input_cache_read_tokens: 80,
      input_cache_write_tokens: null,
      input_standard_tokens: 70,
      output_tokens: 30,
      reasoning_tokens: null,
      cache_usage_reporting: "unavailable",
      incomplete_fields: ["input_cache_write", "reasoning"],
      usage_complete: true,
      input_cached_tokens: 80,
      input_uncached_tokens: 80,
      known_estimated_cost_nanos: 1334,
      estimated_cost_nanos: 1334,
    });
    expect(await getUsageRow(service, user.id)).toMatchObject({
      input_cached_tokens: 80,
      input_uncached_tokens: 80,
      output_tokens: 30,
    });
    const global = await getGlobalUsageRow(service);
    expect(global).toMatchObject({
      input_cached_tokens: expect.any(Number),
      input_uncached_tokens: expect.any(Number),
    });
    const profile = await service
      .from("ai_profile_usage_daily")
      .select("input_total_tokens,input_cache_read_tokens,input_cache_write_tokens,input_standard_tokens,output_tokens,reasoning_tokens")
      .eq("profile_version_id", harness.fixture.profileVersionId)
      .eq("billing_currency", "CNY")
      .single();
    expect(profile.data).toMatchObject({
      input_total_tokens: expect.any(Number),
      input_cache_write_tokens: null,
      reasoning_tokens: null,
    });
  });

  it("preserves observed lower bounds beside unavailable or incomplete usage", async () => {
    for (const [label, secondUsage] of [
      ["unavailable", null],
      ["observed-incomplete", observedUsage({ usage_complete: false })],
    ] as const) {
      const user = await harness.makeUser(`finalize-lower-bound-${label}`);
      const reservation = await harness.reserveV2(user);
      const first = await harness.startAttempt(reservation.reservationId, 1);
      await harness.complete(completePayload(first.attemptId));
      const second = await harness.startAttempt(reservation.reservationId, 2);
      await harness.complete(
        completePayload(second.attemptId, {
          p_status: "failed_upstream",
          p_provider_billable: secondUsage === null ? false : true,
          p_usage: secondUsage,
          p_cost:
            secondUsage === null
              ? costObservation({
                  estimated_currency: null,
                  estimated_cost_nanos: null,
                  reconciliation_status: "incomplete_usage",
                })
              : costObservation(),
          p_metadata: attemptMetadata({ finish_reason: null }),
        }),
      );
      expect(
        await harness.finalize(reservation.reservationId, {
          status: "failed_upstream",
          quotaCharged: false,
          providerBillable: true,
        }),
      ).toMatchObject({ ok: true });
      const row = await getLedgerRow(service, reservation.reservationId);
      expect(row).toMatchObject({
        input_total_tokens: secondUsage === null ? 100 : 200,
        input_cache_read_tokens: secondUsage === null ? 60 : 120,
        output_tokens: secondUsage === null ? 20 : 40,
        usage_complete: false,
      });
      expect(row!.incomplete_fields).toContain("attempt_usage");
    }
  });

  it("derives true, false, and null billability and rejects caller mismatches", async () => {
    const trueCase = await completed("finalize-billable-true");
    expect(
      await harness.finalize(trueCase.reservation.reservationId, {
        providerBillable: false,
      }),
    ).toEqual({ ok: false, reason: "INTERNAL_ERROR" });
    expect(await getLedgerRow(service, trueCase.reservation.reservationId)).toMatchObject({
      state: "reserved",
    });

    const falseCase = await completed("finalize-billable-false", {
      p_status: "canceled",
      p_provider_billable: false,
      p_usage: null,
      p_cost: costObservation({
        estimated_currency: null,
        estimated_cost_nanos: null,
        reconciliation_status: "incomplete_usage",
      }),
      p_metadata: attemptMetadata({ finish_reason: null }),
    });
    expect(
      await harness.finalize(falseCase.reservation.reservationId, {
        status: "canceled",
        providerBillable: false,
      }),
    ).toMatchObject({ ok: true });
    expect(await getLedgerRow(service, falseCase.reservation.reservationId)).toMatchObject({
      provider_billable: false,
      known_estimated_cost_nanos: null,
      estimated_cost_nanos: null,
      billing_currency: "CNY",
      cost_reconciliation_status: "not_available",
    });
    expect(
      (await getLedgerRow(service, falseCase.reservation.reservationId))!
        .incomplete_fields,
    ).not.toContain("estimated_cost");

    const nullCase = await completed("finalize-billable-null", {
      p_provider_billable: null,
      p_cost: costObservation({
        estimated_currency: null,
        estimated_cost_nanos: null,
        reconciliation_status: "incomplete_usage",
      }),
    });
    expect(
      await harness.finalize(nullCase.reservation.reservationId, {
        providerBillable: null,
      }),
    ).toMatchObject({ ok: true });
    expect(await getLedgerRow(service, nullCase.reservation.reservationId)).toMatchObject({
      provider_billable: null,
      estimated_cost_nanos: null,
      cost_reconciliation_status: "incomplete_usage",
    });
    expect(
      (await getLedgerRow(service, nullCase.reservation.reservationId))!
        .incomplete_fields,
    ).toEqual(expect.arrayContaining(["provider_billable", "estimated_cost"]));
  });

  it("denies direct service-role abandoned but permits the exact owner-OID child-backed branch", async () => {
    const direct = await completed("finalize-abandoned-direct");
    const directBefore = await getLedgerRow(service, direct.reservation.reservationId);
    expect(
      await harness.finalize(direct.reservation.reservationId, {
        status: "abandoned",
        quotaCharged: false,
        providerBillable: true,
      }),
    ).toEqual({ ok: false, reason: "INVALID_STATUS" });
    expect(await getLedgerRow(service, direct.reservation.reservationId)).toEqual(
      directBefore,
    );

    const owner = await completed("finalize-abandoned-owner");
    const result = runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      \pset format unaligned
      \pset tuples_only on
      select public.finalize_ai_polish_request(
        '${owner.reservation.reservationId}'::uuid,
        'abandoned',
        false,
        true,
        null,
        '{"usage_schema_version":"attempt_v2"}'::jsonb
      );
    `);
    expect(result.stdout).toContain('"ok": true');
    expect(result.stdout).toContain('"status": "abandoned"');
    expect(await getLedgerRow(service, owner.reservation.reservationId)).toMatchObject({
      state: "finalized",
      status: "abandoned",
      quota_charged: false,
      usage_schema_version: "request_usage_aggregate_v2",
    });
  });

  it("returns exact finalized readback before unknown selector, scalar metadata, usage, or billability parsing", async () => {
    const { user, reservation } = await completed("finalize-hostile-replay");
    const first = await harness.finalize(reservation.reservationId);
    const before = {
      request: await getLedgerRow(service, reservation.reservationId),
      usage: await getUsageRow(service, user.id),
      global: await getGlobalUsageRow(service),
      profile: await service
        .from("ai_profile_usage_daily")
        .select("*")
        .eq("profile_version_id", harness.fixture.profileVersionId),
    };

    expect(
      await harness.finalize(reservation.reservationId, {
        status: "abandoned",
        quotaCharged: false,
        providerBillable: false,
        usage: { hostile: true },
        metadata: "unknown-source",
      }),
    ).toEqual({ ...first, alreadyFinalized: true });
    expect({
      request: await getLedgerRow(service, reservation.reservationId),
      usage: await getUsageRow(service, user.id),
      global: await getGlobalUsageRow(service),
      profile: await service
        .from("ai_profile_usage_daily")
        .select("*")
        .eq("profile_version_id", harness.fixture.profileVersionId),
    }).toEqual(before);
  });
});
