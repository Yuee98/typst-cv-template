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
  completePayload,
  SettlementHarness,
} from "./provider-attempt-settlement-fixtures";
import { runOwnerSql } from "./runtime-contract-fixtures";
import {
  configureFeature,
  createServiceClient,
  createTestUser,
  currentMinuteBucket,
  deleteTestUser,
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

const PROTECTED_HISTORY_TABLES = [
  "user_terms_acceptances",
  "ai_provider_profiles",
  "ai_provider_profile_versions",
  "ai_price_versions",
  "ai_price_components",
  "ai_routing_policy_versions",
  "ai_service_runtime_contract_versions",
  "ai_service_runtime_target_versions",
  "ai_service_runtime_contract_targets",
  "ai_legal_manifest_versions",
  "ai_legal_bundle_versions",
  "ai_legal_bundle_manifests",
] as const;

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function snapshotProtectedHistory(): string {
  const catalogPairs = PROTECTED_HISTORY_TABLES.map(
    (table) => String.raw`
      '${table}', (
        select pg_catalog.jsonb_build_object(
          'rowCount', pg_catalog.count(*),
          'sha256', pg_catalog.encode(
            pg_temp.protected_history_sha256_agg_v1(
              pg_catalog.to_jsonb(history_row)::text
              order by pg_catalog.to_jsonb(history_row)::text collate "C"
            ),
            'hex'
          )
        )
        from public.${table} as history_row
      )`,
  ).join(",");
  const result = runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    \pset format unaligned
    \pset tuples_only on
    create function pg_temp.protected_history_sha256_sfunc_v1(
      p_state bytea,
      p_value text
    ) returns bytea
    language sql
    immutable
    parallel safe
    set search_path = ''
    as $sha256_chain$
      select extensions.digest(
        p_state || pg_catalog.convert_to(p_value, 'UTF8'),
        'sha256'
      );
    $sha256_chain$;

    create aggregate pg_temp.protected_history_sha256_agg_v1(text) (
      sfunc = pg_temp.protected_history_sha256_sfunc_v1,
      stype = bytea,
      initcond = '\xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );

    select pg_catalog.jsonb_build_object(${catalogPairs})::text;
  `);
  const snapshot = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) => line.startsWith("{"));
  if (!snapshot) {
    throw new Error("protected history snapshot returned no fingerprints");
  }

  const fingerprints = JSON.parse(snapshot) as Record<string, unknown>;
  if (Object.keys(fingerprints).length !== PROTECTED_HISTORY_TABLES.length) {
    throw new Error("protected history snapshot returned an unexpected table set");
  }
  for (const table of PROTECTED_HISTORY_TABLES) {
    const fingerprint = fingerprints[table];
    if (
      typeof fingerprint !== "object" ||
      fingerprint === null ||
      Array.isArray(fingerprint)
    ) {
      throw new Error(`protected history snapshot omitted ${table}`);
    }
    const fields = fingerprint as Record<string, unknown>;
    if (
      Object.keys(fields).length !== 2 ||
      !Number.isSafeInteger(fields.rowCount) ||
      (fields.rowCount as number) < 0 ||
      typeof fields.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(fields.sha256)
    ) {
      throw new Error(`protected history fingerprint is invalid for ${table}`);
    }
  }
  return snapshot;
}

describe.skipIf(!RUN_DB_TESTS)("stale reconciliation & cleanup (real DB)", () => {
  let service: SupabaseClient;
  let harness: SettlementHarness;
  const users: TestUser[] = [];

  beforeAll(async () => {
    service = createServiceClient();
    harness = new SettlementHarness(service);
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
    return data as {
      releasedCount: number;
      abandonedCount: number;
      latencyOverflowCount: number;
    };
  }

  beforeEach(async () => {
    await configureFeature(service, {
      enabled: true,
      globalDailyLimit: 2000,
      allowlist: [],
    });
  });

  afterAll(async () => {
    await harness.cleanup();
    for (const user of users) {
      await deleteTestUser(service, user.id);
    }
  });

  it("freezes the zero-argument invoker cleanup contract and its exact delete scope", () => {
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      do $assertions$
      declare
        v_cleanup pg_catalog.pg_proc%rowtype;
        v_delete_targets text[];
      begin
        if (
          select pg_catalog.count(*)
          from pg_catalog.pg_proc
          where pronamespace = 'public'::pg_catalog.regnamespace
            and proname = 'cleanup_ai_polish_metadata'
        ) <> 1 then
          raise exception 'cleanup must have exactly one overload';
        end if;

        select * into strict v_cleanup
        from pg_catalog.pg_proc
        where oid = 'public.cleanup_ai_polish_metadata()'::regprocedure;

        if v_cleanup.prosecdef
           or v_cleanup.provolatile <> 'v'
           or v_cleanup.proconfig is distinct from array['search_path=""']::text[]
           or v_cleanup.prorettype <> 'jsonb'::regtype
           or v_cleanup.pronargs <> 0
           or v_cleanup.pronargdefaults <> 0 then
          raise exception 'cleanup catalog contract drifted';
        end if;
        if not pg_catalog.has_function_privilege(
          'service_role', v_cleanup.oid, 'EXECUTE'
        ) then
          raise exception 'service_role lacks cleanup execute';
        end if;
        if pg_catalog.has_function_privilege('anon', v_cleanup.oid, 'EXECUTE')
           or pg_catalog.has_function_privilege(
             'authenticated', v_cleanup.oid, 'EXECUTE'
           )
           or exists (
             select 1
             from pg_catalog.aclexplode(v_cleanup.proacl)
             where grantee = 0 and privilege_type = 'EXECUTE'
           ) then
          raise exception 'end-user role can execute cleanup';
        end if;

        select pg_catalog.array_agg(
          (matched.delete_target)[1]
          order by (matched.delete_target)[1]
        )
        into v_delete_targets
        from pg_catalog.regexp_matches(
          v_cleanup.prosrc,
          'delete[[:space:]]+from[[:space:]]+public\.([a-z0-9_]+)',
          'gi'
        ) as matched(delete_target);

        if v_delete_targets is distinct from array[
          'ai_global_usage_daily',
          'ai_profile_usage_daily',
          'ai_rate_minutes',
          'ai_request_ledger',
          'ai_usage_daily'
        ]::text[] then
          raise exception 'cleanup delete scope drifted: %', v_delete_targets;
        end if;
      end;
      $assertions$;
    `);
  });

  it("releases stale 'reserved' rows and refunds their quota", async () => {
    const user = await makeUser("stale-reserved");
    await setDailyUsageCount(service, user.id, 3);
    const reservationId = await reserveFresh(user);
    expect((await getUsageRow(service, user.id))?.request_count).toBe(4);

    await backdate(reservationId, { reserved_at: minutesAgoIso(2) });
    const result = await reconcile();
    expect(result).toEqual({
      releasedCount: 1,
      abandonedCount: 0,
      latencyOverflowCount: 0,
    });

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
    expect(await reconcile()).toEqual({
      releasedCount: 0,
      abandonedCount: 0,
      latencyOverflowCount: 0,
    });
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
    expect(result).toEqual({
      releasedCount: 0,
      abandonedCount: 1,
      latencyOverflowCount: 0,
    });

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
    expect(result).toEqual({
      releasedCount: 0,
      abandonedCount: 0,
      latencyOverflowCount: 0,
    });
    expect((await getLedgerRow(service, reservationId))?.state).toBe("reserved");
  });

  it("cleanup deletes rows past retention and keeps everything recent", async () => {
    const user = await makeUser("cleanup");
    await harness.setup();

    const cascadeUser = await harness.makeUser("cleanup-cascade");
    const cascadeReservation = await harness.reserveV2(cascadeUser);
    const cascadeAttempt = await harness.startAttempt(
      cascadeReservation.reservationId,
      1,
    );
    await harness.complete(completePayload(cascadeAttempt.attemptId));
    await harness.finalize(cascadeReservation.reservationId);
    await backdate(cascadeReservation.reservationId, {
      reserved_at: daysAgoIso(91),
      finalized_at: daysAgoIso(91),
    });

    const { data: currentAiTerms, error: currentAiTermsError } =
      await service.rpc("current_ai_terms_version");
    expect(currentAiTermsError).toBeNull();
    const { data: existingAcceptance, error: acceptanceError } = await service
      .from("user_terms_acceptances")
      .select("version")
      .eq("user_id", cascadeUser.id)
      .eq("document_key", "ai_terms")
      .single();
    expect(acceptanceError).toBeNull();
    expect(existingAcceptance?.version).toBe(currentAiTerms);

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

    const { error: oldProfileError } = await service
      .from("ai_profile_usage_daily")
      .insert({
        day: utcDaysAgo(91),
        profile_version_id: harness.fixture.profileVersionId,
        billing_currency: "CNY",
        request_count: 7,
        cost_incomplete_count: 1,
      });
    expect(oldProfileError).toBeNull();
    const { error: boundaryProfileError } = await service
      .from("ai_profile_usage_daily")
      .insert({
        day: utcDaysAgo(90),
        profile_version_id: harness.fixture.profileVersionId,
        billing_currency: "CNY",
        request_count: 8,
        cost_incomplete_count: 1,
      });
    expect(boundaryProfileError).toBeNull();

    const { data: attemptBeforeCleanup, error: attemptBeforeCleanupError } =
      await service
        .from("ai_provider_attempt_ledger")
        .select("attempt_id")
        .eq("attempt_id", cascadeAttempt.attemptId)
        .single();
    expect(attemptBeforeCleanupError).toBeNull();
    expect(attemptBeforeCleanup?.attempt_id).toBe(cascadeAttempt.attemptId);

    const historyBeforeCleanup = snapshotProtectedHistory();

    // --- run the cleanup ---
    const { data, error } = await service.rpc("cleanup_ai_polish_metadata");
    expect(error).toBeNull();
    expect(data).toEqual({
      rateMinutesDeleted: 1,
      ledgerDeleted: 2,
      usageDailyDeleted: 1,
      globalUsageDailyDeleted: 1,
      profileUsageDailyDeleted: 1,
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
    const { data: oldProfile } = await service
      .from("ai_profile_usage_daily")
      .select("*")
      .eq("day", utcDaysAgo(91))
      .eq("profile_version_id", harness.fixture.profileVersionId);
    expect(oldProfile).toEqual([]);

    expect(
      await getLedgerRow(service, cascadeReservation.reservationId),
    ).toBeNull();
    const { data: attemptAfterCleanup, error: attemptAfterCleanupError } =
      await service
        .from("ai_provider_attempt_ledger")
        .select("attempt_id")
        .eq("attempt_id", cascadeAttempt.attemptId)
        .maybeSingle();
    expect(attemptAfterCleanupError).toBeNull();
    expect(attemptAfterCleanup).toBeNull();

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

    const { data: boundaryProfile, error: boundaryProfileReadError } =
      await service
        .from("ai_profile_usage_daily")
        .select("request_count")
        .eq("day", utcDaysAgo(90))
        .eq("profile_version_id", harness.fixture.profileVersionId)
        .eq("billing_currency", "CNY")
        .single();
    expect(boundaryProfileReadError).toBeNull();
    expect(boundaryProfile?.request_count).toBe(8);

    const { data: acceptanceAfterCleanup, error: acceptanceReadError } =
      await service
        .from("user_terms_acceptances")
        .select("version")
        .eq("user_id", cascadeUser.id)
        .eq("document_key", "ai_terms")
        .single();
    expect(acceptanceReadError).toBeNull();
    expect(acceptanceAfterCleanup?.version).toBe(currentAiTerms);

    expect(snapshotProtectedHistory()).toBe(historyBeforeCleanup);
  });
});
