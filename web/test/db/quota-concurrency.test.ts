/**
 * Real-DB concurrency tests for the quota ledger (unit 1.4, plan card 1.4).
 *
 * Runs against a local Supabase (skipped otherwise). Covers:
 *   - concurrent reserves of one user never overshoot the daily quota
 *     (the ai_usage_daily row lock serializes them);
 *   - the per-minute fixed-window rate limit holds under a concurrent burst;
 *   - the global daily circuit breaker: exact counting under concurrent
 *     provider starts, and denial once the limit is reached.
 *
 * The free-tier limits (20/day, 3/min) are compiled-in constants of
 * reserve_ai_polish_request(), so the tests shrink the EFFECTIVE remaining
 * quota by pre-warming counters via the service role instead.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getPolishQuota, markPolishProviderStarted } from "@/server/polish/quota";

import {
  clearCurrentRateBucket,
  configureFeature,
  createServiceClient,
  createTestUser,
  deleteTestUser,
  FEATURE_CONFIG_DEFAULTS,
  getGlobalStartedCount,
  getLedgerRows,
  getRateBuckets,
  getUsageRow,
  RUN_DB_TESTS,
  setCurrentRateBucketCount,
  setDailyUsageCount,
  settleAwayFromMinuteBoundary,
  tryReserve,
  type TestUser,
} from "./helpers";

const DAILY_LIMIT = 20;
const MINUTE_LIMIT = 3;

describe.skipIf(!RUN_DB_TESTS)("quota concurrency (real DB)", () => {
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

  beforeEach(async () => {
    // Every test starts from a known runtime-switch state: feature on, high
    // global limit, no allowlist restriction.
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

  it("never overshoots the daily quota under concurrent reserves", async () => {
    const user = await makeUser("daily-cap");
    // Leave exactly one daily slot; the burst below races for it.
    await setDailyUsageCount(service, user.id, DAILY_LIMIT - 1);
    await clearCurrentRateBucket(service, user.id);

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => tryReserve(service, user.id)),
    );

    const succeeded = outcomes.filter((o) => o.ok);
    const failed = outcomes.filter((o) => !o.ok);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(4);
    for (const outcome of failed) {
      expect(!outcome.ok && outcome.error.code).toBe("QUOTA_EXCEEDED");
    }

    const usage = await getUsageRow(service, user.id);
    expect(usage?.request_count).toBe(DAILY_LIMIT);
    const ledger = await getLedgerRows(service, user.id);
    expect(ledger).toHaveLength(1);
  });

  it("counts remaining quota down to zero and then denies", async () => {
    const user = await makeUser("daily-countdown");
    await setDailyUsageCount(service, user.id, DAILY_LIMIT - 2);
    await clearCurrentRateBucket(service, user.id);

    const first = await tryReserve(service, user.id);
    expect(first.ok && first.remaining).toBe(1);

    await clearCurrentRateBucket(service, user.id);
    const second = await tryReserve(service, user.id);
    expect(second.ok && second.remaining).toBe(0);

    // The daily check fires before the minute check, so no bucket clearing
    // is needed here: the third reserve must hit the exhausted daily quota.
    const third = await tryReserve(service, user.id);
    expect(third.ok).toBe(false);
    expect(!third.ok && third.error.code).toBe("QUOTA_EXCEEDED");
    expect(!third.ok && third.error.resetAt).toBeTruthy();

    const quota = await getPolishQuota(service, user.id);
    expect(quota.limit).toBe(DAILY_LIMIT);
    expect(quota.remaining).toBe(0);
    expect(quota.resetAt).toBeTruthy();
  });

  it("keeps the per-minute window at <= 3 successes under a 10-way burst", async () => {
    const user = await makeUser("minute-burst");

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => tryReserve(service, user.id)),
    );
    const succeeded = outcomes.filter((o) => o.ok);
    const failed = outcomes.filter((o) => !o.ok);

    // A burst straddling a minute boundary may fill two windows (<= 6
    // successes); either way every failure must be a rate-limit denial.
    expect(succeeded.length).toBeGreaterThanOrEqual(MINUTE_LIMIT);
    expect(succeeded.length).toBeLessThanOrEqual(2 * MINUTE_LIMIT);
    for (const outcome of failed) {
      expect(!outcome.ok && outcome.error.code).toBe("RATE_LIMITED");
    }

    // The invariant that actually matters: no window ever exceeds 3, and the
    // ledger/usage accounting matches the number of successes exactly.
    const buckets = await getRateBuckets(service, user.id);
    expect(buckets.length).toBeGreaterThanOrEqual(1);
    for (const bucket of buckets) {
      expect(bucket.count).toBeLessThanOrEqual(MINUTE_LIMIT);
    }
    const bucketTotal = buckets.reduce((sum, b) => sum + b.count, 0);
    expect(bucketTotal).toBe(succeeded.length);

    const usage = await getUsageRow(service, user.id);
    expect(usage?.request_count).toBe(succeeded.length);
    const ledger = await getLedgerRows(service, user.id);
    expect(ledger).toHaveLength(succeeded.length);
  });

  it("denies with RATE_LIMITED once the current minute window is full", async () => {
    const user = await makeUser("minute-full");
    await settleAwayFromMinuteBoundary();
    await setCurrentRateBucketCount(service, user.id, MINUTE_LIMIT);

    const outcome = await tryReserve(service, user.id);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe("RATE_LIMITED");
    expect(!outcome.ok && outcome.error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(!outcome.ok && outcome.error.retryAfterSeconds).toBeLessThanOrEqual(60);

    // A rate-limit denial must not consume daily quota or write the ledger.
    // (The reserve RPC pre-creates the ai_usage_daily row via INSERT ... ON
    // CONFLICT DO NOTHING before the rate check, so a zero-count row may
    // exist — what matters is that the count is never incremented.)
    const usage = await getUsageRow(service, user.id);
    expect(usage?.request_count ?? 0).toBe(0);
    expect(await getLedgerRows(service, user.id)).toHaveLength(0);
  });

  it("counts concurrent provider starts exactly (no lost updates)", async () => {
    const baseline = await getGlobalStartedCount(service);
    const group = await Promise.all(
      Array.from({ length: 6 }, (_, i) => makeUser(`global-inc-${i}`)),
    );
    const reservations = await Promise.all(
      group.map((user) => tryReserve(service, user.id)),
    );
    for (const outcome of reservations) {
      expect(outcome.ok).toBe(true);
    }

    const firstAttempts = await Promise.all(
      reservations.map((outcome) =>
        markPolishProviderStarted(
          service,
          (outcome as { reservationId: string }).reservationId,
        ),
      ),
    );
    for (const attempt of firstAttempts) {
      expect(attempt).toEqual({ started: true, attemptCount: 1 });
    }
    expect(await getGlobalStartedCount(service)).toBe(baseline + 6);

    // A second provider attempt (retry) counts again — the global counter is
    // per attempt, never refunded.
    const secondAttempts = await Promise.all(
      reservations.map((outcome) =>
        markPolishProviderStarted(
          service,
          (outcome as { reservationId: string }).reservationId,
        ),
      ),
    );
    for (const attempt of secondAttempts) {
      expect(attempt).toEqual({ started: true, attemptCount: 2 });
    }
    expect(await getGlobalStartedCount(service)).toBe(baseline + 12);
  });

  it("denies every reserve with SERVICE_UNAVAILABLE once the global daily limit is reached", async () => {
    // Trip the breaker exactly: with global_daily_limit set to the current
    // count, the >= comparison denies every new reserve.
    const current = await getGlobalStartedCount(service);
    await configureFeature(service, { globalDailyLimit: current });

    const group = await Promise.all(
      Array.from({ length: 3 }, (_, i) => makeUser(`global-full-${i}`)),
    );
    const outcomes = await Promise.all(
      group.map((user) => tryReserve(service, user.id)),
    );
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.error.code).toBe("SERVICE_UNAVAILABLE");
    }
  });

  it("documents the non-atomic global pre-check: concurrent reserves can overshoot the last global slot", async () => {
    // DEVIATION (documented, asserted as actual behavior): the global daily
    // check in reserve_ai_polish_request() is a plain SELECT (no FOR UPDATE)
    // and the counter only moves later in mark_ai_polish_provider_started(),
    // so N concurrent reserves can ALL pass with a single global slot left.
    // The strict guarantee lives one step later: once provider_started_count
    // reaches the limit, every new reserve is denied (tested above). This is
    // acceptable for a soft circuit breaker but worth an explicit record.
    const current = await getGlobalStartedCount(service);
    await configureFeature(service, { globalDailyLimit: current + 1 });

    const group = await Promise.all(
      Array.from({ length: 4 }, (_, i) => makeUser(`global-race-${i}`)),
    );
    const outcomes = await Promise.all(
      group.map((user) => tryReserve(service, user.id)),
    );
    const succeeded = outcomes.filter((o) => o.ok);
    expect(succeeded).toHaveLength(4);
  });
});
