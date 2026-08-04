/**
 * Real-DB tests for finalize idempotency and client_request_id dedup
 * (unit 1.4, plan card 1.4).
 *
 * Settlement semantics asserted against the actual tables:
 *   - finalize settles a reservation exactly once; repeated calls are no-ops
 *     and never double-charge, double-refund or double-record token usage
 *     (double-refund is made OBSERVABLE by pre-warming the usage counter
 *     above zero, so greatest(0, ...) cannot mask it);
 *   - quota refunds go back exactly once for uncharged outcomes
 *     (failed_upstream / invalid_output / released), never for charged ones
 *     (succeeded / canceled);
 *   - token usage is a cost fact: recorded even when quota is refunded, and
 *     global totals are never decremented;
 *   - dedup: same (user, client_request_id) -> REQUEST_IN_PROGRESS while
 *     in-flight, DUPLICATE_REQUEST once finalized; a different user can reuse
 *     the same client_request_id.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  finalizePolishRequest,
  markPolishProviderStarted,
  PolishQuotaError,
  reservePolishRequest,
} from "@/server/polish/quota";

import {
  clearCurrentRateBucket,
  configureFeature,
  createServiceClient,
  createTestUser,
  deleteTestUser,
  FEATURE_CONFIG_DEFAULTS,
  getGlobalUsageRow,
  getLedgerRow,
  getUsageRow,
  RUN_DB_TESTS,
  setDailyUsageCount,
  tryReserve,
  utcDaysAgo,
  type TestUser,
} from "./helpers";

const USAGE = {
  inputCachedTokens: 10,
  inputUncachedTokens: 20,
  outputTokens: 5,
  usageComplete: true,
};

describe.skipIf(!RUN_DB_TESTS)("finalize idempotency & dedup (real DB)", () => {
  let service: SupabaseClient;
  const users: TestUser[] = [];

  beforeAll(async () => {
    service = createServiceClient();
  });

  async function makeUser(label: string): Promise<TestUser> {
    const user = await createTestUser(service, label);
    users.push(user);
    return user;
  }

  async function reserveFresh(user: TestUser) {
    await clearCurrentRateBucket(service, user.id);
    const outcome = await tryReserve(service, user.id);
    if (!outcome.ok) {
      throw new Error(`reserve failed unexpectedly: ${outcome.error.code}`);
    }
    return outcome.reservationId;
  }

  beforeEach(async () => {
    await configureFeature(service, {
      enabled: true,
      globalDailyLimit: 2000,
      allowlist: [],
    });
  });

  afterAll(async () => {
    await configureFeature(service, { ...FEATURE_CONFIG_DEFAULTS });
    for (const user of users) {
      await deleteTestUser(service, user.id);
    }
  });

  it("settles a succeeded reservation exactly once", async () => {
    const user = await makeUser("fin-succeeded");
    const reservationId = await reserveFresh(user);
    const globalBefore = await getGlobalUsageRow(service);

    const first = await finalizePolishRequest(service, {
      reservationId,
      status: "succeeded",
      quotaCharged: true,
      providerBillable: true,
      usage: USAGE,
      metadata: { model: "deepseek-chat", latencyMs: 1234 },
    });
    expect(first.alreadyFinalized).toBe(false);

    const row = await getLedgerRow(service, reservationId);
    expect(row).toMatchObject({
      state: "finalized",
      status: "succeeded",
      quota_charged: true,
      provider_billable: true,
      usage_complete: true,
      input_cached_tokens: 10,
      input_uncached_tokens: 20,
      output_tokens: 5,
      model: "deepseek-chat",
      latency_ms: 1234,
    });
    expect(row?.finalized_at).toBeTruthy();

    // Charged: no refund; usage tokens recorded once (per-user + global).
    let usage = await getUsageRow(service, user.id);
    expect(usage).toMatchObject({
      request_count: 1,
      input_cached_tokens: 10,
      input_uncached_tokens: 20,
      output_tokens: 5,
    });
    let global = await getGlobalUsageRow(service);
    expect(global?.input_cached_tokens).toBe(
      (globalBefore?.input_cached_tokens ?? 0) + 10,
    );
    expect(global?.output_tokens).toBe((globalBefore?.output_tokens ?? 0) + 5);

    // Repeat with a DIFFERENT outcome: must be a complete no-op.
    const second = await finalizePolishRequest(service, {
      reservationId,
      status: "failed_upstream",
      quotaCharged: false,
      usage: {
        inputCachedTokens: 999,
        inputUncachedTokens: 999,
        outputTokens: 999,
        usageComplete: false,
      },
    });
    expect(second.alreadyFinalized).toBe(true);

    const rowAfter = await getLedgerRow(service, reservationId);
    expect(rowAfter).toMatchObject({
      state: "finalized",
      status: "succeeded",
      quota_charged: true,
      input_cached_tokens: 10,
    });
    usage = await getUsageRow(service, user.id);
    expect(usage?.request_count).toBe(1);
    expect(usage?.input_cached_tokens).toBe(10);
    global = await getGlobalUsageRow(service);
    expect(global?.input_cached_tokens).toBe(
      (globalBefore?.input_cached_tokens ?? 0) + 10,
    );
  });

  it("refunds an uncharged failure exactly once (double refund observable)", async () => {
    const user = await makeUser("fin-refund");
    // Pre-warm above zero: a buggy second refund would show up as 4.
    await setDailyUsageCount(service, user.id, 5);
    const reservationId = await reserveFresh(user);
    expect((await getUsageRow(service, user.id))?.request_count).toBe(6);
    const globalBefore = await getGlobalUsageRow(service);

    const first = await finalizePolishRequest(service, {
      reservationId,
      status: "failed_upstream",
      quotaCharged: false,
      providerBillable: false,
      usage: {
        inputCachedTokens: 3,
        inputUncachedTokens: 4,
        outputTokens: 5,
        usageComplete: true,
      },
    });
    expect(first.alreadyFinalized).toBe(false);

    let usage = await getUsageRow(service, user.id);
    // Refunded once: 6 -> 5. Token cost still recorded (invariant 7).
    expect(usage?.request_count).toBe(5);
    expect(usage).toMatchObject({
      input_cached_tokens: 3,
      input_uncached_tokens: 4,
      output_tokens: 5,
    });

    const second = await finalizePolishRequest(service, {
      reservationId,
      status: "failed_upstream",
      quotaCharged: false,
      providerBillable: false,
      usage: {
        inputCachedTokens: 3,
        inputUncachedTokens: 4,
        outputTokens: 5,
        usageComplete: true,
      },
    });
    expect(second.alreadyFinalized).toBe(true);

    usage = await getUsageRow(service, user.id);
    expect(usage?.request_count).toBe(5);
    expect(usage?.input_cached_tokens).toBe(3);

    const global = await getGlobalUsageRow(service);
    expect(global?.input_cached_tokens).toBe(
      (globalBefore?.input_cached_tokens ?? 0) + 3,
    );

    const row = await getLedgerRow(service, reservationId);
    expect(row).toMatchObject({
      state: "finalized",
      status: "failed_upstream",
      quota_charged: false,
      provider_billable: false,
    });
  });

  it("releases a reservation that never reached the provider, refunding once", async () => {
    const user = await makeUser("fin-released");
    await setDailyUsageCount(service, user.id, 2);
    const reservationId = await reserveFresh(user);
    expect((await getUsageRow(service, user.id))?.request_count).toBe(3);

    const first = await finalizePolishRequest(service, {
      reservationId,
      status: "released",
      quotaCharged: false,
    });
    expect(first.alreadyFinalized).toBe(false);

    const row = await getLedgerRow(service, reservationId);
    expect(row).toMatchObject({
      state: "finalized",
      status: "released",
      quota_charged: false,
      provider_billable: null,
      usage_complete: false,
      input_cached_tokens: null,
      attempt_count: 0,
    });
    expect((await getUsageRow(service, user.id))?.request_count).toBe(2);

    const second = await finalizePolishRequest(service, {
      reservationId,
      status: "released",
      quotaCharged: false,
    });
    expect(second.alreadyFinalized).toBe(true);
    expect((await getUsageRow(service, user.id))?.request_count).toBe(2);
  });

  it("charges a canceled-after-provider-start request and keeps it billable", async () => {
    const user = await makeUser("fin-canceled");
    await setDailyUsageCount(service, user.id, 5);
    const reservationId = await reserveFresh(user);
    expect((await getUsageRow(service, user.id))?.request_count).toBe(6);

    const started = await markPolishProviderStarted(service, reservationId);
    expect(started).toEqual({ started: true, attemptCount: 1 });

    const first = await finalizePolishRequest(service, {
      reservationId,
      status: "canceled",
      quotaCharged: true,
      providerBillable: true,
      usage: {
        inputCachedTokens: 1,
        inputUncachedTokens: 1,
        outputTokens: 1,
        usageComplete: false,
      },
      metadata: { failureStage: "canceled" },
    });
    expect(first.alreadyFinalized).toBe(false);

    const row = await getLedgerRow(service, reservationId);
    expect(row).toMatchObject({
      state: "finalized",
      status: "canceled",
      quota_charged: true,
      provider_billable: true,
      failure_stage: "canceled",
      attempt_count: 1,
    });
    // Charged: count stays at 6 (no refund).
    expect((await getUsageRow(service, user.id))?.request_count).toBe(6);

    const second = await finalizePolishRequest(service, {
      reservationId,
      status: "canceled",
      quotaCharged: true,
      providerBillable: true,
    });
    expect(second.alreadyFinalized).toBe(true);
    expect((await getUsageRow(service, user.id))?.request_count).toBe(6);
  });

  it("refuses to mark provider_started after finalization", async () => {
    const user = await makeUser("fin-mark-late");
    const reservationId = await reserveFresh(user);
    await finalizePolishRequest(service, {
      reservationId,
      status: "released",
      quotaCharged: false,
    });

    const globalBefore = (await getGlobalUsageRow(service))?.provider_started_count ?? 0;
    const mark = await markPolishProviderStarted(service, reservationId);
    expect(mark).toEqual({ started: false, attemptCount: null });

    const globalAfter = (await getGlobalUsageRow(service))?.provider_started_count ?? 0;
    expect(globalAfter).toBe(globalBefore);
    expect((await getLedgerRow(service, reservationId))?.attempt_count).toBe(0);
  });

  it("dedups on (user, client_request_id): in-flight 409, settled 409, other user unaffected", async () => {
    const userA = await makeUser("dedup-a");
    const userB = await makeUser("dedup-b");
    const clientRequestId = crypto.randomUUID();

    const first = await reservePolishRequest(service, {
      userId: userA.id,
      requestId: crypto.randomUUID(),
      clientRequestId,
    });
    expect(first.reservationId).toBeTruthy();

    // Same id, different server request id, still in-flight -> 409 REQUEST_IN_PROGRESS.
    const inflight = await reservePolishRequest(service, {
      userId: userA.id,
      requestId: crypto.randomUUID(),
      clientRequestId,
    }).catch((e: unknown) => e);
    expect(inflight).toBeInstanceOf(PolishQuotaError);
    expect((inflight as PolishQuotaError).code).toBe("REQUEST_IN_PROGRESS");
    expect((inflight as PolishQuotaError).httpStatus).toBe(409);

    // Settle it, then retry with the same id -> 409 DUPLICATE_REQUEST.
    await finalizePolishRequest(service, {
      reservationId: first.reservationId,
      status: "released",
      quotaCharged: false,
    });
    const settled = await reservePolishRequest(service, {
      userId: userA.id,
      requestId: crypto.randomUUID(),
      clientRequestId,
    }).catch((e: unknown) => e);
    expect(settled).toBeInstanceOf(PolishQuotaError);
    expect((settled as PolishQuotaError).code).toBe("DUPLICATE_REQUEST");
    expect((settled as PolishQuotaError).httpStatus).toBe(409);

    // The quota refund from 'released' really came back: a fresh id reserves fine.
    const fresh = await reservePolishRequest(service, {
      userId: userA.id,
      requestId: crypto.randomUUID(),
      clientRequestId: crypto.randomUUID(),
    });
    expect(fresh.reservationId).toBeTruthy();

    // Dedup is per user: user B can reuse the same client_request_id.
    const otherUser = await reservePolishRequest(service, {
      userId: userB.id,
      requestId: crypto.randomUUID(),
      clientRequestId,
    });
    expect(otherUser.reservationId).toBeTruthy();
  });

  it("rejects reconciler-only status 'abandoned' at the DB level", async () => {
    const user = await makeUser("fin-abandoned");
    const reservationId = await reserveFresh(user);

    const { data, error } = await service.rpc("finalize_ai_polish_request", {
      p_reservation_id: reservationId,
      p_status: "abandoned",
      p_quota_charged: false,
      p_provider_billable: null,
      p_usage: null,
      p_metadata: null,
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ ok: false, reason: "INVALID_STATUS" });

    // The reservation must remain untouched.
    expect((await getLedgerRow(service, reservationId))?.state).toBe("reserved");
  });

  it("maps an unknown reservation id to INTERNAL_ERROR", async () => {
    const error = await finalizePolishRequest(service, {
      reservationId: crypto.randomUUID(),
      status: "released",
      quotaCharged: false,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolishQuotaError);
    expect((error as PolishQuotaError).code).toBe("INTERNAL_ERROR");
  });

  it("returns the post-settlement quota snapshot atomically (relay #8)", async () => {
    const user = await makeUser("fin-quota-snapshot");
    const reservationId = await reserveFresh(user);
    // reserve consumed 1 of 20 → charged success leaves 19.
    const first = await finalizePolishRequest(service, {
      reservationId,
      status: "succeeded",
      quotaCharged: true,
      providerBillable: true,
      usage: USAGE,
    });
    expect(first.quota).toMatchObject({ limit: 20, remaining: 19 });
    expect(first.quota?.resetAt).toBeTruthy();

    // The idempotent repeat recomputes the same snapshot.
    const second = await finalizePolishRequest(service, {
      reservationId,
      status: "succeeded",
      quotaCharged: true,
    });
    expect(second.quota).toMatchObject({ limit: 20, remaining: 19 });

    // A refunded outcome reports the count AFTER the refund went back.
    const user2 = await makeUser("fin-quota-snapshot-refund");
    const reservationId2 = await reserveFresh(user2);
    const refunded = await finalizePolishRequest(service, {
      reservationId: reservationId2,
      status: "failed_upstream",
      quotaCharged: false,
      providerBillable: false,
    });
    expect(refunded.quota).toMatchObject({ limit: 20, remaining: 20 });
  });

  it("upserts per-user token usage when a request crosses UTC midnight (relay #5)", async () => {
    const user = await makeUser("fin-midnight");
    // A reservation attributed to the PREVIOUS UTC day (as if reserved just
    // before midnight): the usage row exists for THAT day, but there is no
    // row for the finalization day — the finalize must create it via upsert
    // instead of dropping the tokens with a zero-row UPDATE.
    const yesterday = utcDaysAgo(1);
    const { error: usageError } = await service
      .from("ai_usage_daily")
      .upsert({ user_id: user.id, day: yesterday, request_count: 1 });
    expect(usageError).toBeNull();

    const reservationId = crypto.randomUUID();
    const { error: ledgerError } = await service.from("ai_request_ledger").insert({
      reservation_id: reservationId,
      request_id: crypto.randomUUID(),
      client_request_id: crypto.randomUUID(),
      user_id: user.id,
      reserved_at: `${yesterday}T23:59:30+00:00`,
    });
    expect(ledgerError).toBeNull();

    const result = await finalizePolishRequest(service, {
      reservationId,
      status: "succeeded",
      quotaCharged: true,
      providerBillable: true,
      usage: USAGE,
    });
    expect(result.alreadyFinalized).toBe(false);

    // Charged requests are not refunded: yesterday's count is untouched.
    const { data: yesterdayRow } = await service
      .from("ai_usage_daily")
      .select("*")
      .eq("user_id", user.id)
      .eq("day", yesterday)
      .maybeSingle();
    expect(yesterdayRow?.request_count).toBe(1);

    // The finalization-day row was CREATED by the upsert with the full token
    // cost (usage day attribution: the finalization day — see the migration
    // comment), never silently dropped.
    const todayRow = await getUsageRow(service, user.id);
    expect(todayRow).toMatchObject({
      request_count: 0,
      input_cached_tokens: USAGE.inputCachedTokens,
      input_uncached_tokens: USAGE.inputUncachedTokens,
      output_tokens: USAGE.outputTokens,
    });

    // The quota snapshot reflects the finalization day (no reservation was
    // consumed there) — per-user and global accounting stay consistent.
    expect(result.quota).toMatchObject({ limit: 20, remaining: 20 });
  });
});
