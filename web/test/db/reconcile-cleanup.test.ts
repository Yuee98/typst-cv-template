/**
 * Real-DB tests for the stale-reservation reconciler and the retention
 * cleanup (unit 1.4, plan card 1.4).
 *
 * Cron-vs-test interference: the local stack schedules
 * reconcile_stale_ai_polish_reservations with the DEFAULT 10-minute staleness
 * every 5 minutes (pg_cron). To stay deterministic, staleness is induced by
 * backdating rows by only 2 minutes and the manual reconciler call passes
 * p_stale_after = 60 seconds — the cron job's 10-minute threshold never
 * matches these rows while the test file runs. The one backdated-beyond-
 * 10-minutes row (cleanup retention probe) is asserted by EXISTENCE only, so
 * a cron finalization in between cannot flake it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { markPolishProviderStarted } from "@/server/polish/quota";

import {
  configureFeature,
  createServiceClient,
  createTestUser,
  currentMinuteBucket,
  deleteTestUser,
  FEATURE_CONFIG_DEFAULTS,
  getGlobalStartedCount,
  getLedgerRow,
  getUsageRow,
  minutesAgoIso,
  RUN_DB_TESTS,
  setDailyUsageCount,
  tryReserve,
  utcDaysAgo,
  type TestUser,
} from "./helpers";

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

describe.skipIf(!RUN_DB_TESTS)("stale reconciliation & cleanup (real DB)", () => {
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

  async function reserveFresh(user: TestUser): Promise<string> {
    const outcome = await tryReserve(service, user.id);
    if (!outcome.ok) {
      throw new Error(`reserve failed unexpectedly: ${outcome.error.code}`);
    }
    return outcome.reservationId;
  }

  async function backdate(reservationId: string, fields: Record<string, string>) {
    const { error } = await service
      .from("ai_request_ledger")
      .update(fields)
      .eq("reservation_id", reservationId);
    if (error) {
      throw new Error(`backdate failed: ${error.message}`);
    }
  }

  async function reconcile(staleAfter = "60 seconds") {
    const { data, error } = await service.rpc(
      "reconcile_stale_ai_polish_reservations",
      { p_stale_after: staleAfter },
    );
    if (error) {
      throw new Error(`reconcile failed: ${error.message}`);
    }
    return data as { releasedCount: number; abandonedCount: number };
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

  it("releases stale 'reserved' rows and refunds their quota", async () => {
    const user = await makeUser("stale-reserved");
    await setDailyUsageCount(service, user.id, 3);
    const reservationId = await reserveFresh(user);
    expect((await getUsageRow(service, user.id))?.request_count).toBe(4);

    await backdate(reservationId, { reserved_at: minutesAgoIso(2) });
    const result = await reconcile();
    expect(result).toEqual({ releasedCount: 1, abandonedCount: 0 });

    const row = await getLedgerRow(service, reservationId);
    expect(row).toMatchObject({
      state: "finalized",
      status: "released",
      quota_charged: false,
      provider_billable: false,
    });
    expect(row?.finalized_at).toBeTruthy();

    // Refund goes back to the reservation's day.
    expect((await getUsageRow(service, user.id))?.request_count).toBe(3);

    // Idempotent: nothing left to reconcile.
    expect(await reconcile()).toEqual({ releasedCount: 0, abandonedCount: 0 });
  });

  it("abandons stale 'provider_started' rows, refunds quota, keeps the global count", async () => {
    const user = await makeUser("stale-started");
    const reservationId = await reserveFresh(user);
    const started = await markPolishProviderStarted(service, reservationId);
    expect(started.started).toBe(true);
    const globalAfterStart = await getGlobalStartedCount(service);

    await backdate(reservationId, {
      reserved_at: minutesAgoIso(3),
      provider_started_at: minutesAgoIso(2),
    });
    const result = await reconcile();
    expect(result).toEqual({ releasedCount: 0, abandonedCount: 1 });

    const row = await getLedgerRow(service, reservationId);
    expect(row).toMatchObject({
      state: "finalized",
      status: "abandoned",
      quota_charged: false,
      provider_billable: null, // cost unknown — never guessed
      usage_complete: false,
    });

    // Quota refunded, but the global provider-attempt counter is a cost fact
    // and is never decremented (roadmap invariant 7).
    expect((await getUsageRow(service, user.id))?.request_count).toBe(0);
    expect(await getGlobalStartedCount(service)).toBe(globalAfterStart);
  });

  it("leaves fresh reservations untouched", async () => {
    const user = await makeUser("stale-fresh");
    const reservationId = await reserveFresh(user);

    const result = await reconcile();
    expect(result).toEqual({ releasedCount: 0, abandonedCount: 0 });
    expect((await getLedgerRow(service, reservationId))?.state).toBe("reserved");
  });

  it("cleanup deletes rows past retention and keeps everything recent", async () => {
    const user = await makeUser("cleanup");

    // --- seed old + recent rows directly (service_role) ---
    // rate_minutes: 2-day retention.
    const { error: oldBucketError } = await service.from("ai_rate_minutes").insert({
      user_id: user.id,
      minute_bucket: daysAgoIso(3),
      count: 1,
    });
    expect(oldBucketError).toBeNull();
    const { error: freshBucketError } = await service.from("ai_rate_minutes").insert({
      user_id: user.id,
      minute_bucket: currentMinuteBucket(),
      count: 1,
    });
    expect(freshBucketError).toBeNull();

    // ledger: finalized rows age out after 90 days; unfinished rows are kept
    // regardless of age (they belong to the reconciler, not retention).
    const oldFinalizedId = crypto.randomUUID();
    const { error: oldLedgerError } = await service.from("ai_request_ledger").insert({
      reservation_id: oldFinalizedId,
      request_id: crypto.randomUUID(),
      client_request_id: crypto.randomUUID(),
      user_id: user.id,
      state: "finalized",
      status: "succeeded",
      quota_charged: true,
      reserved_at: daysAgoIso(91),
      finalized_at: daysAgoIso(91),
    });
    expect(oldLedgerError).toBeNull();

    const recentFinalizedId = crypto.randomUUID();
    const { error: recentLedgerError } = await service.from("ai_request_ledger").insert({
      reservation_id: recentFinalizedId,
      request_id: crypto.randomUUID(),
      client_request_id: crypto.randomUUID(),
      user_id: user.id,
      state: "finalized",
      status: "released",
      quota_charged: false,
      reserved_at: minutesAgoIso(5),
      finalized_at: minutesAgoIso(4),
    });
    expect(recentLedgerError).toBeNull();

    const oldReservedId = crypto.randomUUID();
    const { error: oldReservedError } = await service.from("ai_request_ledger").insert({
      reservation_id: oldReservedId,
      request_id: crypto.randomUUID(),
      client_request_id: crypto.randomUUID(),
      user_id: user.id,
      state: "reserved",
      reserved_at: daysAgoIso(91),
    });
    expect(oldReservedError).toBeNull();

    // usage_daily / global_usage_daily: 90-day retention.
    const { error: oldUsageError } = await service.from("ai_usage_daily").insert({
      user_id: user.id,
      day: utcDaysAgo(91),
      request_count: 1,
    });
    expect(oldUsageError).toBeNull();
    const { error: oldGlobalError } = await service.from("ai_global_usage_daily").insert({
      day: utcDaysAgo(91),
      provider_started_count: 1,
    });
    expect(oldGlobalError).toBeNull();

    // --- run the cleanup ---
    const { data, error } = await service.rpc("cleanup_ai_polish_metadata");
    expect(error).toBeNull();
    expect(data).toMatchObject({
      rateMinutesDeleted: 1,
      ledgerDeleted: 1,
      usageDailyDeleted: 1,
      globalUsageDailyDeleted: 1,
    });

    // --- old rows gone ---
    expect(await getLedgerRow(service, oldFinalizedId)).toBeNull();
    const { data: oldBuckets } = await service
      .from("ai_rate_minutes")
      .select("*")
      .eq("user_id", user.id)
      .lt("minute_bucket", daysAgoIso(2));
    expect(oldBuckets).toEqual([]);
    const { data: oldUsage } = await service
      .from("ai_usage_daily")
      .select("*")
      .eq("user_id", user.id)
      .eq("day", utcDaysAgo(91));
    expect(oldUsage).toEqual([]);
    const { data: oldGlobal } = await service
      .from("ai_global_usage_daily")
      .select("*")
      .eq("day", utcDaysAgo(91));
    expect(oldGlobal).toEqual([]);

    // --- recent rows kept ---
    expect(await getLedgerRow(service, recentFinalizedId)).not.toBeNull();
    // The aged-but-unfinished row is retention-exempt; assert existence only
    // (the 5-minute cron reconciler may have released it in the meantime —
    // either way cleanup must not delete it).
    expect(await getLedgerRow(service, oldReservedId)).not.toBeNull();
    const { data: freshBuckets } = await service
      .from("ai_rate_minutes")
      .select("*")
      .eq("user_id", user.id)
      .eq("minute_bucket", currentMinuteBucket());
    expect(freshBuckets).toHaveLength(1);
  });
});
