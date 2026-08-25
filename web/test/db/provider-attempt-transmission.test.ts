import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createServiceClient,
  deleteTestUser,
  getGlobalUsageRow,
  getGlobalStartedCount,
  getUsageRow,
  RUN_DB_TESTS,
} from "./helpers";
import {
  attemptMetadata,
  completePayload,
  costObservation,
  SettlementHarness,
} from "./provider-attempt-settlement-fixtures";
import { runOwnerSql } from "./runtime-contract-fixtures";

describe.skipIf(!RUN_DB_TESTS)(
  "durable attempt transmission and quota derivation (real DB)",
  () => {
    let service: SupabaseClient;
    let harness: SettlementHarness;

    beforeAll(async () => {
      service = createServiceClient();
      harness = new SettlementHarness(service);
      await harness.setup();
    });

    afterEach(async () => {
      for (const user of harness.users.splice(0)) {
        await deleteTestUser(service, user.id);
      }
    });

    afterAll(async () => {
      await harness.cleanup();
    });

    async function reserveAndStart(label: string, attemptNo: 1 | 2 = 1) {
      const user = await harness.makeUser(label);
      const reservation = await harness.reserveV2(user);
      const attempt = await harness.startAttempt(reservation.reservationId, attemptNo);
      return { user, reservation, attempt };
    }

    const unavailableCompletion = {
      p_usage: null,
      p_cost: costObservation({
        estimated_currency: null,
        estimated_cost_nanos: null,
        reconciliation_status: "incomplete_usage",
      }),
      p_metadata: attemptMetadata({
        finish_reason: null,
        failure_stage: "provider_http",
      }),
    } as const;

    it("persists pre-entry false and compares transmission on completion replay", async () => {
      const { attempt } = await reserveAndStart("durable-transmission-replay");
      const payload = completePayload(attempt.attemptId, {
        ...unavailableCompletion,
        p_status: "canceled",
        p_transmitted: false,
        p_provider_billable: false,
      });

      expect(await harness.complete(payload)).toMatchObject({
        ok: true,
        alreadyCompleted: false,
      });
      expect(await harness.complete(payload)).toMatchObject({
        ok: true,
        alreadyCompleted: true,
      });
      expect(
        await harness.complete({ ...payload, p_transmitted: true }),
      ).toEqual({ ok: false, reason: "ATTEMPT_COMPLETION_CONFLICT" });

      const row = await service
        .from("ai_provider_attempt_ledger")
        .select("status,transmitted")
        .eq("attempt_id", attempt.attemptId)
        .single();
      expect(row.error).toBeNull();
      expect(row.data).toEqual({ status: "canceled", transmitted: false });
    });

    it("rejects direct retry fact mutation and keeps terminal replay exact", async () => {
      const value = await reserveAndStart("durable-retry-immutable");
      const payload = completePayload(value.attempt.attemptId, {
        ...unavailableCompletion,
        p_status: "failed_upstream",
        p_retry_eligible: true,
        p_provider_billable: null,
      });
      expect(await harness.complete(payload)).toMatchObject({ ok: true });
      const direct = runOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        update public.ai_provider_attempt_ledger
        set retry_eligible = false
        where attempt_id = '${value.attempt.attemptId}'::uuid;
      `, { expectFailure: true });
      expect(direct.stderr).toContain("retry eligibility is immutable");
      expect(await harness.complete(payload)).toMatchObject({
        ok: true,
        alreadyCompleted: true,
      });
      const row = await service
        .from("ai_provider_attempt_ledger")
        .select("retry_eligible")
        .eq("attempt_id", value.attempt.attemptId)
        .single();
      expect(row.data).toEqual({ retry_eligible: true });
    });

    it("makes request cancellation RPC-owned, monotonic and replayable", async () => {
      const user = await harness.makeUser("durable-cancellation-guard");
      const reservation = await harness.reserveV2(user);
      const direct = await service
        .from("ai_request_ledger")
        .update({ cancellation_state: "ambiguous" })
        .eq("reservation_id", reservation.reservationId);
      expect(direct.error?.code).toBe("23514");
      const ambiguous = await service.rpc("record_ai_polish_request_cancellation", {
        p_reservation_id: reservation.reservationId,
        p_observation: "ambiguous",
      });
      expect(ambiguous.data).toMatchObject({ ok: true, state: "ambiguous" });
      const observed = await service.rpc("record_ai_polish_request_cancellation", {
        p_reservation_id: reservation.reservationId,
        p_observation: "observed",
      });
      expect(observed.data).toMatchObject({ ok: true, state: "observed" });
      const downgrade = await service
        .from("ai_request_ledger")
        .update({ cancellation_state: "ambiguous" })
        .eq("reservation_id", reservation.reservationId);
      expect(downgrade.error?.code).toBe("23514");
      const clear = await service
        .from("ai_request_ledger")
        .update({ cancellation_state: null, cancellation_observed_at: null })
        .eq("reservation_id", reservation.reservationId);
      expect(clear.error?.code).toBe("23514");
    });

    it("derives any-transmitted cancellation and rejects hostile quota assertions", async () => {
      const first = await reserveAndStart("durable-any-transmitted");
      await harness.complete(
        completePayload(first.attempt.attemptId, {
          ...unavailableCompletion,
          p_status: "failed_upstream",
          p_transmitted: true,
          p_retry_eligible: true,
          p_provider_billable: null,
        }),
      );
      const second = await harness.startAttempt(first.reservation.reservationId, 2);
      const secondReplay = await service.rpc("start_ai_polish_provider_attempt", {
        p_reservation_id: first.reservation.reservationId,
        p_attempt_no: 2,
      });
      expect(secondReplay.error).toBeNull();
      expect(secondReplay.data).toMatchObject({
        ok: true,
        attemptId: second.attemptId,
        attemptNo: 2,
        alreadyStarted: true,
      });
      await harness.complete(
        completePayload(second.attemptId, {
          ...unavailableCompletion,
          p_status: "canceled",
          p_transmitted: false,
          p_provider_billable: false,
        }),
      );

      expect(
        await harness.finalize(first.reservation.reservationId, {
          status: "canceled",
          quotaCharged: false,
          providerBillable: null,
        }),
      ).toEqual({ ok: false, reason: "SETTLEMENT_ASSERTION_CONFLICT" });

      const chargedCancellation = await harness.finalize(
        first.reservation.reservationId,
        {
          status: "canceled",
          quotaCharged: true,
          providerBillable: null,
        },
      );
      expect(chargedCancellation).toMatchObject({
        ok: true,
        alreadyFinalized: false,
        status: "canceled",
        quotaCharged: true,
      });
    });

    it.each([
      ["started", null],
      ["succeeded", { p_status: "succeeded" }],
      ["canceled", { ...unavailableCompletion, p_status: "canceled", p_transmitted: false, p_provider_billable: false }],
      ["failed-nonretry", { ...unavailableCompletion, p_status: "failed_upstream", p_transmitted: true, p_provider_billable: null }],
      ["timed-out-nonretry", { ...unavailableCompletion, p_status: "timed_out", p_transmitted: true, p_provider_billable: null }],
      ["invalid-nonretry", { p_status: "invalid_output", p_transmitted: true, p_provider_billable: true }],
    ] as const)("rejects attempt 2 after %s attempt 1 with zero mutation", async (label, completion) => {
      const value = await reserveAndStart(`retry-denied-${label}`);
      if (completion !== null) {
        await harness.complete(
          completePayload(value.attempt.attemptId, {
            ...completion,
            p_retry_eligible: false,
          }),
        );
      }
      const before = {
        global: await getGlobalStartedCount(service),
        request: await getUsageRow(service, value.user.id),
      };
      const denied = await service.rpc("start_ai_polish_provider_attempt", {
        p_reservation_id: value.reservation.reservationId,
        p_attempt_no: 2,
      });
      expect(denied.error).toBeNull();
      expect(denied.data).toEqual({ ok: false, reason: "RETRY_SEQUENCE_REJECTED" });
      const children = await service
        .from("ai_provider_attempt_ledger")
        .select("attempt_no,status,retry_eligible")
        .eq("reservation_id", value.reservation.reservationId)
        .order("attempt_no");
      expect(children.error).toBeNull();
      expect(children.data).toHaveLength(1);
      expect(await getGlobalStartedCount(service)).toBe(before.global);
      expect(await getUsageRow(service, value.user.id)).toEqual(before.request);
    });

    it("rejects an unknown predecessor and fails closed on a corrupt two-child retry edge", async () => {
      const unknown = await reserveAndStart("retry-denied-unknown");
      await harness.complete(
        completePayload(unknown.attempt.attemptId, {
          ...unavailableCompletion,
          p_status: "failed_upstream",
          p_provider_billable: null,
        }),
      );
      runOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        set session_replication_role = replica;
        update public.ai_provider_attempt_ledger
        set status = 'unknown', transmitted = null, retry_eligible = null
        where attempt_id = '${unknown.attempt.attemptId}'::uuid;
        set session_replication_role = origin;
      `);
      const denied = await service.rpc("start_ai_polish_provider_attempt", {
        p_reservation_id: unknown.reservation.reservationId,
        p_attempt_no: 2,
      });
      expect(denied.data).toEqual({ ok: false, reason: "RETRY_SEQUENCE_REJECTED" });

      const valid = await reserveAndStart("retry-corrupt-two-child");
      await harness.complete(
        completePayload(valid.attempt.attemptId, {
          ...unavailableCompletion,
          p_status: "failed_upstream",
          p_retry_eligible: true,
          p_provider_billable: null,
        }),
      );
      const second = await harness.startAttempt(valid.reservation.reservationId, 2);
      await harness.complete(completePayload(second.attemptId));
      runOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        set session_replication_role = replica;
        update public.ai_provider_attempt_ledger
        set retry_eligible = false
        where attempt_id = '${valid.attempt.attemptId}'::uuid;
        set session_replication_role = origin;
      `);
      const before = await getUsageRow(service, valid.user.id);
      expect(
        await harness.finalize(valid.reservation.reservationId),
      ).toMatchObject({
        ok: false,
        reason: "TRANSMISSION_UNKNOWN_HELD",
        detail: "INVALID_RETRY_EDGE",
      });
      expect(await getUsageRow(service, valid.user.id)).toEqual(before);

      for (const [label, firstStatus] of [
        ["earlier-success", "succeeded"],
        ["earlier-charged-cancel", "canceled"],
      ] as const) {
        const corrupt = await reserveAndStart(`retry-corrupt-${label}`);
        await harness.complete(
          completePayload(corrupt.attempt.attemptId, {
            ...unavailableCompletion,
            p_status: "failed_upstream",
            p_retry_eligible: true,
            p_provider_billable: null,
          }),
        );
        const corruptSecond = await harness.startAttempt(
          corrupt.reservation.reservationId,
          2,
        );
        await harness.complete(completePayload(corruptSecond.attemptId));
        runOwnerSql(String.raw`
          \set ON_ERROR_STOP on
          set session_replication_role = replica;
          update public.ai_provider_attempt_ledger
          set started_at = transaction_timestamp() - interval '3 minutes',
              terminal_at = transaction_timestamp() - interval '2 minutes'
          where reservation_id = '${corrupt.reservation.reservationId}'::uuid;
          update public.ai_provider_attempt_ledger
          set status = '${firstStatus}', transmitted = true
          where reservation_id = '${corrupt.reservation.reservationId}'::uuid
            and attempt_no = 1;
          set session_replication_role = origin;
        `);
        const corruptBefore = await getUsageRow(service, corrupt.user.id);
        expect(
          await harness.finalize(corrupt.reservation.reservationId),
        ).toMatchObject({
          ok: false,
          reason: "TRANSMISSION_UNKNOWN_HELD",
          detail: "INVALID_RETRY_EDGE",
        });
        const reconciled = await service.rpc(
          "reconcile_stale_ai_polish_reservations",
          { p_stale_after: "60 seconds" },
        );
        expect(reconciled.error).toBeNull();
        expect((reconciled.data as { heldUnknownCount?: number }).heldUnknownCount)
          .toBeGreaterThanOrEqual(1);
        expect(await getUsageRow(service, corrupt.user.id)).toEqual(corruptBefore);
      }
    });

    it("serializes attempt-1 completion against attempt-2 admission", async () => {
      const value = await reserveAndStart("retry-complete-start-race");
      const completion = completePayload(value.attempt.attemptId, {
        ...unavailableCompletion,
        p_status: "failed_upstream",
        p_retry_eligible: true,
        p_provider_billable: null,
      });
      const [completed, started] = await Promise.all([
        service.rpc("complete_ai_polish_provider_attempt", completion),
        service.rpc("start_ai_polish_provider_attempt", {
          p_reservation_id: value.reservation.reservationId,
          p_attempt_no: 2,
        }),
      ]);
      expect(completed.error).toBeNull();
      expect(completed.data).toMatchObject({ ok: true });
      expect(started.error).toBeNull();
      expect(started.data).toMatchObject({ ok: expect.any(Boolean) });
      const children = await service
        .from("ai_provider_attempt_ledger")
        .select("attempt_no,status,retry_eligible")
        .eq("reservation_id", value.reservation.reservationId)
        .order("attempt_no");
      expect(children.error).toBeNull();
      expect(children.data?.[0]).toEqual({
        attempt_no: 1,
        status: "failed_upstream",
        retry_eligible: true,
      });
      if ((started.data as { ok: boolean }).ok) {
        expect(children.data?.[1]).toEqual({
          attempt_no: 2,
          status: "started",
          retry_eligible: null,
        });
      } else {
        expect(children.data).toHaveLength(1);
        expect(started.data).toEqual({
          ok: false,
          reason: "RETRY_SEQUENCE_REJECTED",
        });
      }
    });

    it.each([
      ["succeeded", true, true],
      ["failed_upstream", true, false],
      ["invalid_output", true, false],
      ["failed_upstream", false, false],
      ["canceled", false, false],
      ["canceled", true, true],
    ] as const)(
      "derives %s transmitted=%s as quotaCharged=%s",
      async (requestStatus, transmitted, quotaCharged) => {
        const value = await reserveAndStart(
          `durable-policy-${requestStatus}-${transmitted}-${crypto.randomUUID()}`,
        );
        const attemptStatus =
          requestStatus === "failed_upstream" && !transmitted
            ? "timed_out"
            : requestStatus;
        const hasUsage = requestStatus === "succeeded" || requestStatus === "invalid_output";
        await harness.complete(
          completePayload(value.attempt.attemptId, {
            ...(hasUsage ? {} : unavailableCompletion),
            p_status: attemptStatus,
            p_transmitted: transmitted,
            p_provider_billable: hasUsage ? true : transmitted ? null : false,
          }),
        );
        const providerBillable = hasUsage ? true : transmitted ? null : false;
        expect(
          await harness.finalize(value.reservation.reservationId, {
            status: requestStatus,
            quotaCharged,
            providerBillable,
          }),
        ).toMatchObject({
          ok: true,
          status: requestStatus,
          quotaCharged,
        });
      },
    );

    it("releases zero-child reservations and replays finalize exactly", async () => {
      const user = await harness.makeUser("durable-zero-child");
      const reservation = await harness.reserveV2(user);
      const first = await harness.finalize(reservation.reservationId, {
        status: "released",
        quotaCharged: false,
        providerBillable: false,
        metadata: null,
      });
      expect(first).toMatchObject({
        ok: true,
        alreadyFinalized: false,
        status: "released",
        quotaCharged: false,
      });
      expect(
        await harness.finalize(reservation.reservationId, {
          status: "released",
          quotaCharged: false,
          providerBillable: false,
          metadata: null,
        }),
      ).toMatchObject({ ok: true, alreadyFinalized: true });
      expect(
        await harness.finalize(reservation.reservationId, {
          status: "released",
          quotaCharged: true,
          providerBillable: false,
          metadata: null,
        }),
      ).toEqual({ ok: false, reason: "FINALIZE_CONFLICT" });
    });

    it("reconciles a committed transmitted cancellation without refunding", async () => {
      const value = await reserveAndStart("durable-completion-loss");
      await harness.complete(
        completePayload(value.attempt.attemptId, {
          ...unavailableCompletion,
          p_status: "canceled",
          p_transmitted: true,
          p_provider_billable: null,
        }),
      );
      const cancellation = await service.rpc(
        "record_ai_polish_request_cancellation",
        {
          p_reservation_id: value.reservation.reservationId,
          p_observation: "observed",
        },
      );
      expect(cancellation.error).toBeNull();
      expect(cancellation.data).toMatchObject({ ok: true, state: "observed" });
      runOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        set session_replication_role = replica;
        update public.ai_request_ledger
        set reserved_at = transaction_timestamp() - interval '2 minutes'
        where reservation_id = '${value.reservation.reservationId}'::uuid;
        update public.ai_provider_attempt_ledger
        set started_at = transaction_timestamp() - interval '3 minutes',
            terminal_at = transaction_timestamp() - interval '2 minutes'
        where attempt_id = '${value.attempt.attemptId}'::uuid;
        set session_replication_role = origin;
      `);

      const reconciled = await service.rpc("reconcile_stale_ai_polish_reservations", {
        p_stale_after: "60 seconds",
      });
      expect(reconciled.error).toBeNull();
      expect(reconciled.data).toMatchObject({ abandonedCount: 1 });
      const request = await service
        .from("ai_request_ledger")
        .select("state,status,quota_charged")
        .eq("reservation_id", value.reservation.reservationId)
        .single();
      expect(request.error).toBeNull();
      expect(request.data).toEqual({
        state: "finalized",
        status: "canceled",
        quota_charged: true,
      });
    });

    it("holds nonretryable terminal process loss when every cancellation write is noncommitting", async () => {
      const value = await reserveAndStart("durable-cancel-all-writes-lost");
      await harness.complete(
        completePayload(value.attempt.attemptId, {
          ...unavailableCompletion,
          p_status: "failed_upstream",
          p_transmitted: true,
          p_retry_eligible: false,
          p_provider_billable: null,
        }),
      );
      runOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        set session_replication_role = replica;
        update public.ai_provider_attempt_ledger
        set started_at = transaction_timestamp() - interval '3 minutes',
            terminal_at = transaction_timestamp() - interval '2 minutes'
        where attempt_id = '${value.attempt.attemptId}'::uuid;
        set session_replication_role = origin;
      `);
      const beforeUsage = await getUsageRow(service, value.user.id);
      for (let replay = 0; replay < 2; replay += 1) {
        const reconciled = await service.rpc(
          "reconcile_stale_ai_polish_reservations",
          { p_stale_after: "60 seconds" },
        );
        expect(reconciled.error).toBeNull();
        expect(reconciled.data).toMatchObject({
          abandonedCount: 0,
          heldUnknownCount: 1,
        });
      }
      const request = await service
        .from("ai_request_ledger")
        .select("state,status,quota_charged,cancellation_state")
        .eq("reservation_id", value.reservation.reservationId)
        .single();
      expect(request.data).toEqual({
        state: "reserved",
        status: null,
        quota_charged: null,
        cancellation_state: null,
      });
      expect(await getUsageRow(service, value.user.id)).toEqual(beforeUsage);
    });

    it("holds stale started reservations charged without mutating known facts", async () => {
      const value = await reserveAndStart("durable-unknown-hold");
      runOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        set session_replication_role = replica;
        update public.ai_request_ledger
        set reserved_at = transaction_timestamp() - interval '2 minutes'
        where reservation_id = '${value.reservation.reservationId}'::uuid;
        update public.ai_provider_attempt_ledger
        set started_at = transaction_timestamp() - interval '2 minutes'
        where attempt_id = '${value.attempt.attemptId}'::uuid;
        set session_replication_role = origin;
      `);

      for (let observation = 0; observation < 2; observation += 1) {
        const reconciled = await service.rpc("reconcile_stale_ai_polish_reservations", {
          p_stale_after: "60 seconds",
        });
        expect(reconciled.error).toBeNull();
        expect(reconciled.data).toMatchObject({
          heldUnknownCount: 1,
          abandonedCount: 0,
        });
      }
      const [request, attempt] = await Promise.all([
        service
          .from("ai_request_ledger")
          .select("state,status,quota_charged")
          .eq("reservation_id", value.reservation.reservationId)
          .single(),
        service
          .from("ai_provider_attempt_ledger")
          .select("status,transmitted")
          .eq("attempt_id", value.attempt.attemptId)
          .single(),
      ]);
      expect(request.error).toBeNull();
      expect(attempt.error).toBeNull();
      expect(request.data).toEqual({
        state: "reserved",
        status: null,
        quota_charged: null,
      });
      expect(attempt.data).toEqual({ status: "started", transmitted: null });
    });

    it("holds legacy terminal null transmission across single and mixed attempts", async () => {
      const single = await reserveAndStart("durable-legacy-null-failure");
      await harness.complete(
        completePayload(single.attempt.attemptId, {
          ...unavailableCompletion,
          p_status: "failed_upstream",
          p_transmitted: true,
          p_retry_eligible: true,
          p_provider_billable: null,
        }),
      );

      const mixed = await reserveAndStart("durable-legacy-null-mixed");
      await harness.complete(
        completePayload(mixed.attempt.attemptId, {
          ...unavailableCompletion,
          p_status: "failed_upstream",
          p_transmitted: true,
          p_retry_eligible: true,
          p_provider_billable: null,
        }),
      );
      const mixedSecond = await harness.startAttempt(
        mixed.reservation.reservationId,
        2,
      );
      await harness.complete(
        completePayload(mixedSecond.attemptId, {
          ...unavailableCompletion,
          p_status: "canceled",
          p_transmitted: false,
          p_provider_billable: false,
        }),
      );

      runOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        set session_replication_role = replica;
        update public.ai_request_ledger
        set reserved_at = transaction_timestamp() - interval '2 minutes'
        where reservation_id in (
          '${single.reservation.reservationId}'::uuid,
          '${mixed.reservation.reservationId}'::uuid
        );
        update public.ai_provider_attempt_ledger
        set started_at = transaction_timestamp() - interval '3 minutes',
            terminal_at = transaction_timestamp() - interval '2 minutes'
        where reservation_id in (
          '${single.reservation.reservationId}'::uuid,
          '${mixed.reservation.reservationId}'::uuid
        );
        update public.ai_provider_attempt_ledger
        set transmitted = null
        where attempt_id in (
          '${single.attempt.attemptId}'::uuid,
          '${mixedSecond.attemptId}'::uuid
        );
        set session_replication_role = origin;
      `);

      async function snapshot() {
        const [requests, attempts, singleUser, mixedUser, global] =
          await Promise.all([
            service
              .from("ai_request_ledger")
              .select("*")
              .in("reservation_id", [
                single.reservation.reservationId,
                mixed.reservation.reservationId,
              ])
              .order("reservation_id"),
            service
              .from("ai_provider_attempt_ledger")
              .select("*")
              .in("reservation_id", [
                single.reservation.reservationId,
                mixed.reservation.reservationId,
              ])
              .order("reservation_id")
              .order("attempt_no"),
            getUsageRow(service, single.user.id),
            getUsageRow(service, mixed.user.id),
            getGlobalUsageRow(service),
          ]);
        expect(requests.error).toBeNull();
        expect(attempts.error).toBeNull();
        return {
          requests: requests.data,
          attempts: attempts.data,
          singleUser,
          mixedUser,
          global,
        };
      }

      const before = await snapshot();
      for (let observation = 0; observation < 2; observation += 1) {
        const reconciled = await service.rpc(
          "reconcile_stale_ai_polish_reservations",
          { p_stale_after: "60 seconds" },
        );
        expect(reconciled.error).toBeNull();
        expect(reconciled.data).toEqual({
          releasedCount: 0,
          abandonedCount: 0,
          heldUnknownCount: 2,
          latencyOverflowCount: 0,
        });
        expect(await snapshot()).toEqual(before);
      }
    });
  },
);
