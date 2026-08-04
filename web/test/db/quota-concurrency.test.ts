/**
 * Real-DB concurrency tests for the quota ledger (unit 1.4, plan card 1.4).
 *
 * Runs against a local Supabase (skipped otherwise). Covers:
 *   - concurrent reserves of one user never overshoot the daily quota
 *     (the ai_usage_daily row lock serializes them);
 *   - the per-minute fixed-window rate limit holds under a concurrent burst;
 *   - the global daily circuit breaker: exact counting under concurrent
 *     provider starts, and ATOMIC denial once the limit is reached (relay
 *     #2: the mark RPC is the authoritative gate — it locks the global row,
 *     re-reads the config and rechecks capacity before incrementing);
 *   - concurrent duplicate clientRequestIds are serialized by the reserve
 *     advisory lock (relay #9), so they always get a 409 code — never a
 *     misleading quota/rate denial from racing the winner's insert.
 *
 * The free-tier limits (20/day, 3/min) are compiled-in constants of
 * reserve_ai_polish_request(), so the tests shrink the EFFECTIVE remaining
 * quota by pre-warming counters via the service role instead.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  finalizePolishRequest,
  getPolishQuota,
  markPolishProviderStarted,
  PolishQuotaError,
} from "@/server/polish/quota";

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

  it("enforces the global daily limit atomically at provider start: one slot, a racing burst, exactly one mark succeeds", async () => {
    // Relay #2: the reserve-time global check is only a cheap pre-filter —
    // all four reserves below pass with a single slot left — but
    // mark_ai_polish_provider_started locks the day's global row FOR UPDATE,
    // re-reads the config and rechecks capacity before incrementing, so the
    // burst racing the last global slot lets exactly ONE mark through.
    const current = await getGlobalStartedCount(service);
    await configureFeature(service, { globalDailyLimit: current + 1 });

    const group = await Promise.all(
      Array.from({ length: 4 }, (_, i) => makeUser(`global-race-${i}`)),
    );
    const outcomes = await Promise.all(
      group.map((user) => tryReserve(service, user.id)),
    );
    const succeeded = outcomes.filter((o) => o.ok);
    expect(succeeded).toHaveLength(4); // cheap pre-filter admits them all…

    const marks = await Promise.all(
      succeeded.map((outcome) =>
        markPolishProviderStarted(
          service,
          (outcome as { reservationId: string }).reservationId,
        ).catch((error: unknown) => error),
      ),
    );
    const started = marks.filter((m) => !(m instanceof Error));
    const denied = marks.filter((m) => m instanceof PolishQuotaError);
    expect(started).toHaveLength(1); // …but the atomic gate admits exactly one
    expect(denied).toHaveLength(3);
    for (const mark of denied) {
      expect((mark as PolishQuotaError).code).toBe("SERVICE_UNAVAILABLE");
      expect((mark as PolishQuotaError).httpStatus).toBe(503);
    }
    expect(await getGlobalStartedCount(service)).toBe(current + 1);
  });

  it("denies the mark with SERVICE_UNAVAILABLE once the global daily limit is reached (retry path)", async () => {
    // The same gate protects retries: a reservation made before the limit
    // was reached must still be denied at provider start once it is full.
    const user = await makeUser("global-mark-late");
    const outcome = await tryReserve(service, user.id);
    expect(outcome.ok).toBe(true);

    const current = await getGlobalStartedCount(service);
    await configureFeature(service, { globalDailyLimit: current });

    const error = await markPolishProviderStarted(
      service,
      (outcome as { reservationId: string }).reservationId,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PolishQuotaError);
    expect((error as PolishQuotaError).code).toBe("SERVICE_UNAVAILABLE");
    expect(await getGlobalStartedCount(service)).toBe(current);
  });
});

// Relay #9: concurrent duplicate clientRequestIds are serialized by the
// reserve advisory lock (pg_advisory_xact_lock on user_id:client_request_id),
// so the loser always re-runs the dedup lookup AFTER the winner commits and
// gets the correct 409 code — never QUOTA_EXCEEDED/RATE_LIMITED from a check
// that raced the winner's insert.
describe.skipIf(!RUN_DB_TESTS)("concurrent duplicate clientRequestId (real DB)", () => {
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

  it("last daily slot: the loser gets REQUEST_IN_PROGRESS, never QUOTA_EXCEEDED", async () => {
    const user = await makeUser("dedup-daily-race");
    // Exactly one daily slot left; both requests race for it with the SAME
    // clientRequestId.
    await setDailyUsageCount(service, user.id, DAILY_LIMIT - 1);
    await clearCurrentRateBucket(service, user.id);
    const clientRequestId = crypto.randomUUID();

    const outcomes = await Promise.all([
      tryReserve(service, user.id, clientRequestId),
      tryReserve(service, user.id, clientRequestId),
    ]);

    const succeeded = outcomes.filter((o) => o.ok);
    const failed = outcomes.filter((o) => !o.ok);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(!failed[0].ok && failed[0].error.code).toBe("REQUEST_IN_PROGRESS");
    expect(!failed[0].ok && failed[0].error.httpStatus).toBe(409);

    // Exactly one slot consumed, exactly one ledger row.
    expect((await getUsageRow(service, user.id))?.request_count).toBe(DAILY_LIMIT);
    expect(await getLedgerRows(service, user.id)).toHaveLength(1);
  });

  it("last minute slot: the loser gets REQUEST_IN_PROGRESS, never RATE_LIMITED", async () => {
    const user = await makeUser("dedup-minute-race");
    await settleAwayFromMinuteBoundary();
    // Exactly one minute-window slot left; daily quota is untouched.
    await setCurrentRateBucketCount(service, user.id, MINUTE_LIMIT - 1);
    const clientRequestId = crypto.randomUUID();

    const outcomes = await Promise.all([
      tryReserve(service, user.id, clientRequestId),
      tryReserve(service, user.id, clientRequestId),
    ]);

    const succeeded = outcomes.filter((o) => o.ok);
    const failed = outcomes.filter((o) => !o.ok);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(!failed[0].ok && failed[0].error.code).toBe("REQUEST_IN_PROGRESS");
    expect(!failed[0].ok && failed[0].error.httpStatus).toBe(409);

    expect(await getLedgerRows(service, user.id)).toHaveLength(1);
  });

  it("before vs after finalization: in-flight loser gets REQUEST_IN_PROGRESS, settled loser gets DUPLICATE_REQUEST", async () => {
    const user = await makeUser("dedup-settled-race");
    await clearCurrentRateBucket(service, user.id);
    const clientRequestId = crypto.randomUUID();

    // In-flight: two concurrent duplicates → one wins, one 409s in-progress.
    const inflight = await Promise.all([
      tryReserve(service, user.id, clientRequestId),
      tryReserve(service, user.id, clientRequestId),
    ]);
    const winner = inflight.find((o) => o.ok);
    const inflightLoser = inflight.find((o) => !o.ok);
    expect(winner).toBeTruthy();
    expect(inflightLoser).toBeTruthy();
    expect(!inflightLoser!.ok && inflightLoser!.error.code).toBe("REQUEST_IN_PROGRESS");

    // Settle the winner, then two more concurrent duplicates → both must
    // observe the finalized row and get DUPLICATE_REQUEST.
    await finalizePolishRequest(service, {
      reservationId: (winner as { reservationId: string }).reservationId,
      status: "released",
      quotaCharged: false,
    });
    await clearCurrentRateBucket(service, user.id);
    const settled = await Promise.all([
      tryReserve(service, user.id, clientRequestId),
      tryReserve(service, user.id, clientRequestId),
    ]);
    for (const outcome of settled) {
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.error.code).toBe("DUPLICATE_REQUEST");
      expect(!outcome.ok && outcome.error.httpStatus).toBe(409);
    }
  });
});
