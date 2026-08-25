import { spawn } from "node:child_process";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  createServiceClient,
  deleteTestUser,
  getGlobalUsageRow,
  getUsageRow,
  RUN_DB_TESTS,
  sleep,
} from "./helpers";
import {
  attemptMetadata,
  completePayload,
  costObservation,
  observedUsage,
  routeObservation,
  SettlementHarness,
} from "./provider-attempt-settlement-fixtures";
import {
  runOwnerSql,
  type OwnerSqlResult,
} from "./runtime-contract-fixtures";

const INT_MAX = 2_147_483_647;
const DB_CONTAINER = "supabase_db_typst-cv-template";
const LOCK_OBSERVATION_MS = 150;
const NONBLOCKING_TIMEOUT_MS = 2_000;

interface BarrierSqlProcess {
  ready: Promise<void>;
  result: Promise<OwnerSqlResult>;
  release: () => void;
}

function startOwnerSqlWithBarrier(
  sql: string,
  marker: string,
  releaseSql?: string,
): BarrierSqlProcess {
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let readySettled = false;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  let released = releaseSql === undefined;
  let release = () => undefined;
  const result = new Promise<OwnerSqlResult>((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        DB_CONTAINER,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "--set",
        "ON_ERROR_STOP=1",
        "--no-psqlrc",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const observe = () => {
      if (!readySettled && `${stdout}\n${stderr}`.includes(marker)) {
        readySettled = true;
        resolveReady();
      }
    };
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      observe();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      observe();
    });
    child.on("error", (error) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
      reject(error);
    });
    child.on("close", (status) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(
          new Error(`owner SQL exited before barrier ${marker}: ${stderr || stdout}`),
        );
      }
      resolve({ status: status ?? -1, stdout, stderr });
    });
    release = () => {
      if (released) {
        return;
      }
      released = true;
      child.stdin.end(releaseSql);
    };
    if (releaseSql === undefined) {
      child.stdin.end(sql);
    } else {
      child.stdin.write(sql);
    }
  });

  return { ready, result, release };
}

function jsonbSql(value: unknown): string {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

function completeAttemptSql(
  attemptId: string,
  options: { markerBefore?: string; markerAfter?: string; commit?: boolean } = {},
): string {
  return String.raw`
    \set ON_ERROR_STOP on
    \pset format unaligned
    \pset tuples_only on
    begin;
    set local statement_timeout = '10s';
    set local role service_role;
    ${options.markerBefore ? `\\echo ${options.markerBefore}` : ""}
    select public.complete_ai_polish_provider_attempt(
      '${attemptId}'::uuid,
      'succeeded',
      true,
      true,
      ${jsonbSql(observedUsage())},
      ${jsonbSql(routeObservation())},
      ${jsonbSql(costObservation())},
      ${jsonbSql(attemptMetadata())}
    );
    reset role;
    ${options.markerAfter ? `\\echo ${options.markerAfter}` : ""}
    ${options.commit === false ? "" : "commit;"}
  `;
}

function reconcileSql(
  options: { markerBefore?: string; markerAfter?: string; commit?: boolean } = {},
): string {
  return String.raw`
    \set ON_ERROR_STOP on
    \pset format unaligned
    \pset tuples_only on
    begin;
    set local statement_timeout = '10s';
    set local role service_role;
    ${options.markerBefore ? `\\echo ${options.markerBefore}` : ""}
    select public.reconcile_stale_ai_polish_reservations(interval '60 seconds');
    reset role;
    ${options.markerAfter ? `\\echo ${options.markerAfter}` : ""}
    ${options.commit === false ? "" : "commit;"}
  `;
}

function finalizeAttemptSql(
  reservationId: string,
  options: { markerBefore?: string; markerAfter?: string; commit?: boolean } = {},
): string {
  return String.raw`
    \set ON_ERROR_STOP on
    \pset format unaligned
    \pset tuples_only on
    begin;
    set local statement_timeout = '10s';
    set local role service_role;
    ${options.markerBefore ? `\\echo ${options.markerBefore}` : ""}
    select public.finalize_ai_polish_request(
      '${reservationId}'::uuid,
      'succeeded',
      true,
      true,
      null,
      '{"usage_schema_version":"attempt_v2"}'::jsonb,
      'durable_transmission_v1'
    );
    reset role;
    ${options.markerAfter ? `\\echo ${options.markerAfter}` : ""}
    ${options.commit === false ? "" : "commit;"}
  `;
}

function staleReconcileSnapshotSql(
  attemptId: string,
  isolation: "repeatable read" | "serializable",
  marker: string,
): string {
  return String.raw`
    \set ON_ERROR_STOP on
    \set VERBOSITY verbose
    \pset format unaligned
    \pset tuples_only on
    begin isolation level ${isolation};
    set local statement_timeout = '10s';
    set local role service_role;
    select status
    from public.ai_provider_attempt_ledger
    where attempt_id = '${attemptId}'::uuid;
    \echo ${marker}
  `;
}

const RECONCILE_AND_COMMIT_SQL = String.raw`
  select public.reconcile_stale_ai_polish_reservations(interval '60 seconds');
  reset role;
  commit;
`;

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function ownerRewriteAttempt(
  attemptId: string,
  assignments: string,
): void {
  runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    begin;
    alter table public.ai_provider_attempt_ledger
      disable trigger guard_ai_provider_attempt_ledger;
    update public.ai_provider_attempt_ledger
    set ${assignments}
    where attempt_id = ${sqlLiteral(attemptId)}::uuid;
    alter table public.ai_provider_attempt_ledger
      enable trigger guard_ai_provider_attempt_ledger;
    commit;
  `);
}

function ownerCorruptRequestAsLegacyProviderStarted(reservationId: string): void {
  runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    begin;
    alter table public.ai_request_ledger
      disable trigger guard_ai_request_route_snapshot;
    update public.ai_request_ledger
    set route_schema_version = null,
        config_generation = null,
        routing_policy_version_id = null,
        profile_version_id = null,
        price_version_id = null,
        legal_bundle_version = null,
        runtime_contract_id = null,
        runtime_contract_sha256 = null,
        gateway_kind = null,
        model_id = null,
        wire_api_kind = null,
        display_disclosure_key = null,
        state = 'provider_started',
        provider_started_at = pg_catalog.transaction_timestamp() - interval '2 minutes'
    where reservation_id = ${sqlLiteral(reservationId)}::uuid;
    alter table public.ai_request_ledger
      enable trigger guard_ai_request_route_snapshot;
    commit;
  `);
}

describe.skipIf(!RUN_DB_TESTS)("secure provider-attempt reconciler (real DB)", () => {
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

  afterEach(async () => {
    for (const user of harness.users.splice(0)) {
      await deleteTestUser(service, user.id);
    }
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  async function reconcile(staleAfter: string | null = "60 seconds") {
    const result = await service.rpc("reconcile_stale_ai_polish_reservations", {
      p_stale_after: staleAfter,
    });
    return result;
  }

  async function attempt(attemptId: string) {
    const result = await service
      .from("ai_provider_attempt_ledger")
      .select("*")
      .eq("attempt_id", attemptId)
      .single();
    expect(result.error).toBeNull();
    return result.data!;
  }

  async function request(reservationId: string) {
    const result = await service
      .from("ai_request_ledger")
      .select("*")
      .eq("reservation_id", reservationId)
      .single();
    expect(result.error).toBeNull();
    return result.data!;
  }

  async function settlementSnapshot(
    userId: string,
    reservationId: string,
    profileVersionId: string,
  ) {
    const profile = await service
      .from("ai_profile_usage_daily")
      .select("*")
      .eq("profile_version_id", profileVersionId)
      .eq("billing_currency", "CNY")
      .order("day");
    expect(profile.error).toBeNull();
    return {
      request: await request(reservationId),
      user: await getUsageRow(service, userId),
      global: await getGlobalUsageRow(service),
      profile: profile.data,
    };
  }

  async function staleStarted(label: string) {
    const user = await harness.makeUser(label);
    const reservation = await harness.reserveV2(user);
    const started = await harness.startAttempt(reservation.reservationId, 1);
    ownerRewriteAttempt(
      started.attemptId,
      "started_at = pg_catalog.transaction_timestamp() - interval '2 minutes'",
    );
    return { user, reservation, started };
  }

  it("freezes the exact definer owner, ACL, signature, search path, and additive response", async () => {
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      do $assertions$
      declare
        v_reconcile pg_catalog.pg_proc%rowtype;
        v_finalize pg_catalog.pg_proc%rowtype;
        v_owner_name text;
      begin
        if (
          select count(*)
          from pg_catalog.pg_proc
          where pronamespace = 'public'::pg_catalog.regnamespace
            and proname = 'reconcile_stale_ai_polish_reservations'
        ) <> 1 then
          raise exception 'reconciler must have one overload';
        end if;

        select * into strict v_reconcile
        from pg_catalog.pg_proc
        where oid =
          'public.reconcile_stale_ai_polish_reservations(interval)'::regprocedure;
        select * into strict v_finalize
        from pg_catalog.pg_proc
        where oid =
          'public.finalize_ai_polish_request(uuid,text,boolean,boolean,jsonb,jsonb)'::regprocedure;
        select rolname into strict v_owner_name
        from pg_catalog.pg_roles
        where oid = v_reconcile.proowner;

        if not v_reconcile.prosecdef
           or v_reconcile.proconfig is distinct from array['search_path=""']::text[]
           or v_reconcile.prorettype <> 'jsonb'::regtype
           or v_reconcile.pronargdefaults <> 1
           or v_reconcile.proowner <> v_finalize.proowner then
          raise exception 'reconciler catalog contract drifted';
        end if;
        if v_owner_name = any(array[
          'service_role', 'anon', 'authenticated', 'authenticator'
        ]) then
          raise exception 'reconciler owner is an API role';
        end if;
        if pg_catalog.pg_has_role('service_role', v_reconcile.proowner, 'SET') then
          raise exception 'service_role can set role to reconciler owner';
        end if;
        if not pg_catalog.has_function_privilege(
          'service_role',
          v_reconcile.oid,
          'EXECUTE'
        ) then
          raise exception 'service_role lacks reconcile execute';
        end if;
        if pg_catalog.has_function_privilege('anon', v_reconcile.oid, 'EXECUTE')
           or pg_catalog.has_function_privilege(
             'authenticated', v_reconcile.oid, 'EXECUTE'
           )
           or exists (
             select 1
             from pg_catalog.aclexplode(v_reconcile.proacl)
             where grantee = 0 and privilege_type = 'EXECUTE'
           ) then
          raise exception 'end-user role can execute reconciler';
        end if;
      end;
      $assertions$;
    `);

    const result = await reconcile();
    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      releasedCount: 0,
      abandonedCount: 0,
      latencyOverflowCount: 0,
    });
  });

  it("rejects invalid intervals with 22023 before any database state changes", async () => {
    const user = await harness.makeUser("reconcile-invalid-interval");
    const reservation = await harness.reserveV2(user);
    const started = await harness.startAttempt(reservation.reservationId, 1);
    const beforeAttempt = await attempt(started.attemptId);
    const beforeRequest = await request(reservation.reservationId);

    for (const invalid of [
      null,
      "0 seconds",
      "-1 second",
      "100000000 years",
    ]) {
      const result = await reconcile(invalid);
      expect(result.error?.code, String(invalid)).toBe("22023");
      expect(await attempt(started.attemptId)).toEqual(beforeAttempt);
      expect(await request(reservation.reservationId)).toEqual(beforeRequest);
    }

    const composite = runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      begin;
      select public.reconcile_stale_ai_polish_reservations(
        pg_catalog.make_interval(
          months => -12,
          days => (
            (pg_catalog.transaction_timestamp() + interval '12 months')::date
            - pg_catalog.transaction_timestamp()::date
          )
        ) - interval '1 microsecond'
      );
      rollback;
    `, { expectFailure: true });
    expect(composite.stderr).toContain(
      "stale interval must produce a finite past cutoff",
    );
    expect(await attempt(started.attemptId)).toEqual(beforeAttempt);
    expect(await request(reservation.reservationId)).toEqual(beforeRequest);
  });

  it("releases only an exact stale zero-child V2 request and rejects parent drift", async () => {
    const cleanUser = await harness.makeUser("reconcile-zero-child-clean");
    const clean = await harness.reserveV2(cleanUser);
    const cleanBackdate = await service
      .from("ai_request_ledger")
      .update({ reserved_at: new Date(Date.now() - 120_000).toISOString() })
      .eq("reservation_id", clean.reservationId);
    expect(cleanBackdate.error).toBeNull();

    const countDriftUser = await harness.makeUser("reconcile-zero-child-count-drift");
    const countDrift = await harness.reserveV2(countDriftUser);
    const countDriftBackdate = await service
      .from("ai_request_ledger")
      .update({
        reserved_at: new Date(Date.now() - 120_000).toISOString(),
        attempt_count: 1,
      })
      .eq("reservation_id", countDrift.reservationId);
    expect(countDriftBackdate.error).toBeNull();

    const startDriftUser = await harness.makeUser("reconcile-zero-child-start-drift");
    const startDrift = await harness.reserveV2(startDriftUser);
    const startDriftBackdate = await service
      .from("ai_request_ledger")
      .update({
        state: "provider_started",
        reserved_at: new Date(Date.now() - 120_000).toISOString(),
        provider_started_at: new Date(Date.now() - 120_000).toISOString(),
      })
      .eq("reservation_id", startDrift.reservationId);
    expect(startDriftBackdate.error).toBeNull();

    const result = await reconcile();
    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      releasedCount: 1,
      abandonedCount: 0,
      latencyOverflowCount: 0,
    });
    expect(await request(clean.reservationId)).toMatchObject({
      state: "finalized",
      status: "released",
      quota_charged: false,
      provider_billable: false,
      attempt_count: 0,
    });
    expect(await request(countDrift.reservationId)).toMatchObject({
      state: "reserved",
      attempt_count: 1,
      provider_started_at: null,
    });
    expect(await request(startDrift.reservationId)).toMatchObject({
      state: "provider_started",
      attempt_count: 0,
    });
    expect((await request(startDrift.reservationId)).provider_started_at).toBeTruthy();
  });

  it("fails closed when a route-null provider-started parent owns any attempt child", async () => {
    for (const childState of ["started", "terminal-known"] as const) {
      const user = await harness.makeUser(`reconcile-v1-child-corruption-${childState}`);
      const reservation = await harness.reserveV2(user);
      const child = await harness.startAttempt(reservation.reservationId, 1);
      if (childState === "terminal-known") {
        expect(await harness.complete(completePayload(child.attemptId))).toMatchObject({
          ok: true,
          alreadyCompleted: false,
          status: "succeeded",
        });
      }

      ownerCorruptRequestAsLegacyProviderStarted(reservation.reservationId);
      const before = {
        settlement: await settlementSnapshot(
          user.id,
          reservation.reservationId,
          reservation.routeSnapshot.profileVersionId,
        ),
        attempt: await attempt(child.attemptId),
      };

      const result = await reconcile();
      expect(result.error).toBeNull();
      expect(result.data).toEqual({
        releasedCount: 0,
        abandonedCount: 0,
        latencyOverflowCount: 0,
      });
      expect({
        settlement: await settlementSnapshot(
          user.id,
          reservation.reservationId,
          reservation.routeSnapshot.profileVersionId,
        ),
        attempt: await attempt(child.attemptId),
      }).toEqual(before);
    }
  });

  it("holds a stale started attempt charged without fabricating terminal facts", async () => {
    const user = await harness.makeUser("reconcile-canonical-unknown");
    const reservation = await harness.reserveV2(user);
    const started = await harness.startAttempt(reservation.reservationId, 1);
    const frozen = await attempt(started.attemptId);
    ownerRewriteAttempt(
      started.attemptId,
      "started_at = pg_catalog.transaction_timestamp() - interval '2 minutes'",
    );

    const result = await reconcile();
    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      releasedCount: 0,
      abandonedCount: 0,
      heldUnknownCount: 1,
      latencyOverflowCount: 0,
    });

    const held = await attempt(started.attemptId);
    expect(held).toMatchObject({
      status: "started",
      transmitted: null,
      terminal_at: null,
      provider_billable: null,
    });
    for (const key of [
      "route_schema_version",
      "config_generation",
      "routing_policy_version_id",
      "profile_version_id",
      "price_version_id",
      "legal_bundle_version",
      "runtime_contract_id",
      "runtime_contract_sha256",
      "gateway_kind",
      "model_id",
      "wire_api_kind",
      "display_disclosure_key",
      "adapter_kind",
      "credential_alias",
      "endpoint_alias",
      "capability_contract_id",
      "cache_policy_id",
      "legal_manifest_id",
      "calculator_kind",
      "billing_currency",
    ]) {
      expect(held[key], key).toEqual(frozen[key]);
    }

    expect(await request(reservation.reservationId)).toMatchObject({
      state: "reserved",
      status: null,
      quota_charged: null,
    });
    expect(
      await service
        .from("ai_profile_usage_daily")
        .select("*")
        .eq("profile_version_id", reservation.routeSnapshot.profileVersionId),
    ).toMatchObject({ error: null, data: [] });

    const duplicate = await reconcile();
    expect(duplicate.data).toEqual({
      releasedCount: 0,
      abandonedCount: 0,
      heldUnknownCount: 1,
      latencyOverflowCount: 0,
    });
    expect(await attempt(started.attemptId)).toEqual(held);
  });

  it("uses a strict whole-reservation terminal watermark and preserves a live completion path", async () => {
    const user = await harness.makeUser("reconcile-whole-reservation");
    const reservation = await harness.reserveV2(user);
    const first = await harness.startAttempt(reservation.reservationId, 1);
    await harness.complete(completePayload(first.attemptId));
    const second = await harness.startAttempt(reservation.reservationId, 2);
    ownerRewriteAttempt(
      second.attemptId,
      "started_at = pg_catalog.transaction_timestamp() - interval '2 minutes'",
    );

    const skipped = await reconcile();
    expect(skipped.data).toEqual({
      releasedCount: 0,
      abandonedCount: 0,
      latencyOverflowCount: 0,
    });
    expect(await attempt(second.attemptId)).toMatchObject({ status: "started" });
    expect(await request(reservation.reservationId)).toMatchObject({
      state: "reserved",
      attempt_count: 2,
    });

    const completed = await harness.complete(completePayload(second.attemptId));
    expect(completed).toMatchObject({ ok: true, status: "succeeded" });
    const finalized = await harness.finalize(reservation.reservationId);
    expect(finalized).toMatchObject({
      ok: true,
      alreadyFinalized: false,
      status: "succeeded",
    });
  });

  it("holds mixed known terminal and stale started siblings without double accounting", async () => {
    await harness.activateFreshRouteFixture();
    const user = await harness.makeUser("reconcile-mixed-known-unknown");
    const reservation = await harness.reserveV2(user);
    const first = await harness.startAttempt(reservation.reservationId, 1);
    expect(await harness.complete(completePayload(first.attemptId))).toMatchObject({
      ok: true,
      alreadyCompleted: false,
      status: "succeeded",
    });
    const second = await harness.startAttempt(reservation.reservationId, 2);
    ownerRewriteAttempt(
      first.attemptId,
      "started_at = pg_catalog.transaction_timestamp() - interval '3 minutes', terminal_at = pg_catalog.transaction_timestamp() - interval '2 minutes'",
    );
    ownerRewriteAttempt(
      second.attemptId,
      "started_at = pg_catalog.transaction_timestamp() - interval '2 minutes'",
    );
    const firstBeforeReconcile = await attempt(first.attemptId);

    const result = await reconcile();
    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      releasedCount: 0,
      abandonedCount: 0,
      heldUnknownCount: 1,
      latencyOverflowCount: 0,
    });
    expect(await attempt(first.attemptId)).toEqual(firstBeforeReconcile);
    expect(await attempt(second.attemptId)).toMatchObject({
      status: "started",
      transmitted: null,
      terminal_at: null,
      provider_billable: null,
    });

    expect(await request(reservation.reservationId)).toMatchObject({
      state: "reserved",
      status: null,
      quota_charged: null,
    });
    expect(
      await service
        .from("ai_profile_usage_daily")
        .select("*")
        .eq("profile_version_id", reservation.routeSnapshot.profileVersionId),
    ).toMatchObject({ error: null, data: [] });

    const afterSettlement = {
      settlement: await settlementSnapshot(
        user.id,
        reservation.reservationId,
        reservation.routeSnapshot.profileVersionId,
      ),
      first: await attempt(first.attemptId),
      second: await attempt(second.attemptId),
    };
    expect((await reconcile()).data).toEqual({
      releasedCount: 0,
      abandonedCount: 0,
      heldUnknownCount: 1,
      latencyOverflowCount: 0,
    });
    expect({
      settlement: await settlementSnapshot(
        user.id,
        reservation.reservationId,
        reservation.routeSnapshot.profileVersionId,
      ),
      first: await attempt(first.attemptId),
      second: await attempt(second.attemptId),
    }).toEqual(afterSettlement);
  });

  it("requires every pre-existing terminal child to be strictly older than the cutoff", async () => {
    const user = await harness.makeUser("reconcile-all-terminal-watermark");
    const reservation = await harness.reserveV2(user);
    const started = await harness.startAttempt(reservation.reservationId, 1);
    await harness.complete(completePayload(started.attemptId));

    const equality = runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      \pset format unaligned
      \pset tuples_only on
      begin;
      alter table public.ai_provider_attempt_ledger
        disable trigger guard_ai_provider_attempt_ledger;
      update public.ai_provider_attempt_ledger
      set started_at = pg_catalog.transaction_timestamp() - interval '2 minutes',
          terminal_at = pg_catalog.transaction_timestamp() - interval '60 seconds'
      where attempt_id = ${sqlLiteral(started.attemptId)}::uuid;
      alter table public.ai_provider_attempt_ledger
        enable trigger guard_ai_provider_attempt_ledger;
      select public.reconcile_stale_ai_polish_reservations(interval '60 seconds');
      commit;
    `);
    expect(equality.stdout).toContain('"abandonedCount": 0');
    expect(await request(reservation.reservationId)).toMatchObject({
      state: "reserved",
    });

    ownerRewriteAttempt(
      started.attemptId,
      "terminal_at = pg_catalog.transaction_timestamp() - interval '2 minutes'",
    );
    const stale = await reconcile();
    expect(stale.data).toEqual({
      releasedCount: 0,
      abandonedCount: 1,
      latencyOverflowCount: 0,
    });
    expect(await attempt(started.attemptId)).toMatchObject({
      status: "succeeded",
      provider_billable: true,
    });
    expect(await request(reservation.reservationId)).toMatchObject({
      state: "finalized",
      status: "succeeded",
      quota_charged: true,
      provider_billable: true,
    });
  });

  it("uses one transaction clock for strict cutoff equality and exact INT_MAX latency", async () => {
    const equalityUser = await harness.makeUser("reconcile-equality");
    const equalityReservation = await harness.reserveV2(equalityUser);
    const equalityAttempt = await harness.startAttempt(
      equalityReservation.reservationId,
      1,
    );
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      begin;
      alter table public.ai_provider_attempt_ledger
        disable trigger guard_ai_provider_attempt_ledger;
      update public.ai_provider_attempt_ledger
      set started_at = pg_catalog.transaction_timestamp() - interval '60 seconds'
      where attempt_id = ${sqlLiteral(equalityAttempt.attemptId)}::uuid;
      alter table public.ai_provider_attempt_ledger
        enable trigger guard_ai_provider_attempt_ledger;
      select public.reconcile_stale_ai_polish_reservations(interval '60 seconds');
      commit;
    `);
    expect(await attempt(equalityAttempt.attemptId)).toMatchObject({
      status: "started",
      terminal_at: null,
    });

    const maxUser = await harness.makeUser("reconcile-int-max");
    const maxReservation = await harness.reserveV2(maxUser);
    const maxAttempt = await harness.startAttempt(maxReservation.reservationId, 1);
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      begin;
      alter table public.ai_provider_attempt_ledger
        disable trigger guard_ai_provider_attempt_ledger;
      update public.ai_provider_attempt_ledger
      set started_at = pg_catalog.transaction_timestamp()
        - interval '${INT_MAX} milliseconds'
      where attempt_id = ${sqlLiteral(maxAttempt.attemptId)}::uuid;
      alter table public.ai_provider_attempt_ledger
        enable trigger guard_ai_provider_attempt_ledger;
      select public.reconcile_stale_ai_polish_reservations(interval '1 second');
      commit;
    `);
    expect(await attempt(maxAttempt.attemptId)).toMatchObject({
      status: "started",
      terminal_at: null,
      latency_ms: null,
    });
  });

  it("skips latency overflow without blocking a valid reservation in the same batch", async () => {
    const overflowUser = await harness.makeUser("reconcile-overflow");
    const overflowReservation = await harness.reserveV2(overflowUser);
    const overflowAttempt = await harness.startAttempt(
      overflowReservation.reservationId,
      1,
    );
    const validUser = await harness.makeUser("reconcile-valid-batch");
    const validReservation = await harness.reserveV2(validUser);
    const validAttempt = await harness.startAttempt(validReservation.reservationId, 1);
    ownerRewriteAttempt(
      overflowAttempt.attemptId,
      `started_at = pg_catalog.transaction_timestamp() - interval '${INT_MAX + 1} milliseconds'`,
    );
    ownerRewriteAttempt(
      validAttempt.attemptId,
      "started_at = pg_catalog.transaction_timestamp() - interval '2 minutes'",
    );

    const result = await reconcile();
    expect(result.data).toEqual({
      releasedCount: 0,
      abandonedCount: 0,
      heldUnknownCount: 1,
      latencyOverflowCount: 1,
    });
    expect(await attempt(overflowAttempt.attemptId)).toMatchObject({
      status: "started",
      terminal_at: null,
      latency_ms: null,
    });
    expect(await request(overflowReservation.reservationId)).toMatchObject({
      state: "reserved",
    });
    expect(await request(validReservation.reservationId)).toMatchObject({
      state: "reserved",
      status: null,
    });

    const overflowAttemptBeforeRetry = await attempt(overflowAttempt.attemptId);
    const overflowRequestBeforeRetry = await request(
      overflowReservation.reservationId,
    );

    const warning = runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      select public.reconcile_stale_ai_polish_reservations(interval '1 second');
    `);
    expect(warning.stderr).toContain(
      "WARNING:  stale provider attempt latency is not representable",
    );
    expect(warning.stderr).not.toContain(overflowReservation.reservationId);
    expect(warning.stderr).not.toContain(overflowAttempt.attemptId);
    expect(await attempt(overflowAttempt.attemptId)).toEqual(
      overflowAttemptBeforeRetry,
    );
    expect(await request(overflowReservation.reservationId)).toEqual(
      overflowRequestBeforeRetry,
    );
  });

  it("does not inspect or mutate corrupt route aliases on an unknown hold", async () => {
    const user = await harness.makeUser("reconcile-nested-rollback");
    const reservation = await harness.reserveV2(user);
    const started = await harness.startAttempt(reservation.reservationId, 1);
    ownerRewriteAttempt(
      started.attemptId,
      "started_at = pg_catalog.transaction_timestamp() - interval '2 minutes', adapter_kind = 'corrupt_adapter_v1'",
    );
    const beforeSettlement = await settlementSnapshot(
      user.id,
      reservation.reservationId,
      reservation.routeSnapshot.profileVersionId,
    );

    const result = await reconcile();
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ heldUnknownCount: 1 });
    expect(await attempt(started.attemptId)).toMatchObject({
      status: "started",
      terminal_at: null,
      adapter_kind: "corrupt_adapter_v1",
    });
    expect(
      await settlementSnapshot(
        user.id,
        reservation.reservationId,
        reservation.routeSnapshot.profileVersionId,
      ),
    ).toEqual(beforeSettlement);
  });

  it("observably serializes complete-first and reconcile-first without losing a terminal fact", async () => {
    const completeFirst = await staleStarted("reconcile-complete-first");
    const completeReady = "DB011_COMPLETE_FIRST_READY";
    const reconcileAfterCompleteReady = "DB011_RECONCILE_AFTER_COMPLETE_READY";
    const completeHolder = startOwnerSqlWithBarrier(
      completeAttemptSql(completeFirst.started.attemptId, {
        markerAfter: completeReady,
        commit: false,
      }),
      completeReady,
      "commit;\n",
    );
    let reconcileAfterComplete: BarrierSqlProcess | undefined;
    try {
      await completeHolder.ready;
      reconcileAfterComplete = startOwnerSqlWithBarrier(
        reconcileSql({ markerBefore: reconcileAfterCompleteReady }),
        reconcileAfterCompleteReady,
      );
      await reconcileAfterComplete.ready;
      const reconciled = await reconcileAfterComplete.result;
      expect(reconciled.status, reconciled.stderr).toBe(0);
      expect(reconciled.stdout).toContain('"abandonedCount": 0');
      completeHolder.release();
      const completed = await completeHolder.result;
      expect(completed.status, completed.stderr).toBe(0);
      expect(completed.stdout).toContain('"status": "succeeded"');
    } finally {
      completeHolder.release();
      await Promise.allSettled([
        completeHolder.result,
        ...(reconcileAfterComplete ? [reconcileAfterComplete.result] : []),
      ]);
    }
    expect(await attempt(completeFirst.started.attemptId)).toMatchObject({
      status: "succeeded",
    });
    expect(await harness.finalize(completeFirst.reservation.reservationId)).toMatchObject({
      ok: true,
      alreadyFinalized: false,
      status: "succeeded",
    });

    const reconcileFirst = await staleStarted("reconcile-first-complete-late");
    const reconcileReady = "DB011_RECONCILE_FIRST_READY";
    const completeAfterReconcileReady = "DB011_COMPLETE_AFTER_RECONCILE_READY";
    const reconcileHolder = startOwnerSqlWithBarrier(
      reconcileSql({ markerAfter: reconcileReady, commit: false }),
      reconcileReady,
      "commit;\n",
    );
    let completeAfterReconcile: BarrierSqlProcess | undefined;
    try {
      await reconcileHolder.ready;
      completeAfterReconcile = startOwnerSqlWithBarrier(
        completeAttemptSql(reconcileFirst.started.attemptId, {
          markerBefore: completeAfterReconcileReady,
        }),
        completeAfterReconcileReady,
      );
      await completeAfterReconcile.ready;
      let contenderSettled = false;
      const contenderResult = completeAfterReconcile.result.then((result) => {
        contenderSettled = true;
        return result;
      });
      await sleep(LOCK_OBSERVATION_MS);
      expect(contenderSettled).toBe(false);

      reconcileHolder.release();
      const [reconciled, completed] = await Promise.all([
        reconcileHolder.result,
        contenderResult,
      ]);
      expect(reconciled.status, reconciled.stderr).toBe(0);
      expect(reconciled.stdout).toContain('"heldUnknownCount": 1');
      expect(completed.status, completed.stderr).toBe(0);
      expect(completed.stdout).toContain('"status": "succeeded"');
    } finally {
      reconcileHolder.release();
      await Promise.allSettled([
        reconcileHolder.result,
        ...(completeAfterReconcile ? [completeAfterReconcile.result] : []),
      ]);
    }
    expect(await attempt(reconcileFirst.started.attemptId)).toMatchObject({
      status: "succeeded",
      transmitted: true,
    });
    expect(await request(reconcileFirst.reservation.reservationId)).toMatchObject({
      state: "reserved",
      status: null,
    });
    expect((await reconcile()).data).toEqual({
      releasedCount: 0,
      abandonedCount: 0,
      latencyOverflowCount: 0,
    });
  });

  it("observably serializes finalize-first and reconcile-first without duplicate settlement", async () => {
    const finalizeFirst = await staleStarted("reconcile-finalize-first");
    const finalizeReady = "DB011_FINALIZE_FIRST_READY";
    const reconcileAfterFinalizeReady = "DB011_RECONCILE_AFTER_FINALIZE_READY";
    const finalizeHolder = startOwnerSqlWithBarrier(
      finalizeAttemptSql(finalizeFirst.reservation.reservationId, {
        markerAfter: finalizeReady,
        commit: false,
      }),
      finalizeReady,
      "commit;\n",
    );
    let reconcileAfterFinalize: BarrierSqlProcess | undefined;
    try {
      await finalizeHolder.ready;
      reconcileAfterFinalize = startOwnerSqlWithBarrier(
        reconcileSql({ markerBefore: reconcileAfterFinalizeReady }),
        reconcileAfterFinalizeReady,
      );
      await reconcileAfterFinalize.ready;
      const reconciled = await reconcileAfterFinalize.result;
      expect(reconciled.status, reconciled.stderr).toBe(0);
      expect(reconciled.stdout).toContain('"abandonedCount": 0');
      finalizeHolder.release();
      const finalized = await finalizeHolder.result;
      expect(finalized.status, finalized.stderr).toBe(0);
      expect(finalized.stdout).toContain('"reason": "ATTEMPT_IN_PROGRESS"');
    } finally {
      finalizeHolder.release();
      await Promise.allSettled([
        finalizeHolder.result,
        ...(reconcileAfterFinalize ? [reconcileAfterFinalize.result] : []),
      ]);
    }
    expect(await request(finalizeFirst.reservation.reservationId)).toMatchObject({
      state: "reserved",
    });
    expect((await reconcile()).data).toEqual({
      releasedCount: 0,
      abandonedCount: 0,
      heldUnknownCount: 1,
      latencyOverflowCount: 0,
    });
    expect(await request(finalizeFirst.reservation.reservationId)).toMatchObject({
      state: "reserved",
      status: null,
    });

    const reconcileFirst = await staleStarted("reconcile-first-finalize-late");
    const reconcileReady = "DB011_RECONCILE_BEFORE_FINALIZE_READY";
    const finalizeAfterReconcileReady = "DB011_FINALIZE_AFTER_RECONCILE_READY";
    const reconcileHolder = startOwnerSqlWithBarrier(
      reconcileSql({ markerAfter: reconcileReady, commit: false }),
      reconcileReady,
      "commit;\n",
    );
    let finalizeAfterReconcile: BarrierSqlProcess | undefined;
    try {
      await reconcileHolder.ready;
      finalizeAfterReconcile = startOwnerSqlWithBarrier(
        finalizeAttemptSql(reconcileFirst.reservation.reservationId, {
          markerBefore: finalizeAfterReconcileReady,
        }),
        finalizeAfterReconcileReady,
      );
      await finalizeAfterReconcile.ready;
      let contenderSettled = false;
      const contenderResult = finalizeAfterReconcile.result.then((result) => {
        contenderSettled = true;
        return result;
      });
      await sleep(LOCK_OBSERVATION_MS);
      expect(contenderSettled).toBe(false);

      reconcileHolder.release();
      const [reconciled, finalized] = await Promise.all([
        reconcileHolder.result,
        contenderResult,
      ]);
      expect(reconciled.status, reconciled.stderr).toBe(0);
      expect(reconciled.stdout).toContain('"heldUnknownCount": 2');
      expect(finalized.status, finalized.stderr).toBe(0);
      expect(finalized.stdout).toContain('"reason": "ATTEMPT_IN_PROGRESS"');
    } finally {
      reconcileHolder.release();
      await Promise.allSettled([
        reconcileHolder.result,
        ...(finalizeAfterReconcile ? [finalizeAfterReconcile.result] : []),
      ]);
    }
    expect(await request(reconcileFirst.reservation.reservationId)).toMatchObject({
      state: "reserved",
      status: null,
    });
    expect((await reconcile()).data).toEqual({
      releasedCount: 0,
      abandonedCount: 0,
      heldUnknownCount: 2,
      latencyOverflowCount: 0,
    });
  });

  it("fails closed on stale high-isolation snapshots and preserves completed facts", async () => {
    for (const isolation of ["repeatable read", "serializable"] as const) {
      const value = await staleStarted(
        `reconcile-stale-${isolation.replaceAll(" ", "-")}`,
      );
      const beforeSettlement = await settlementSnapshot(
        value.user.id,
        value.reservation.reservationId,
        value.reservation.routeSnapshot.profileVersionId,
      );
      const marker = `DB011_${isolation.replaceAll(" ", "_").toUpperCase()}_SNAPSHOT_READY`;
      const staleReconciler = startOwnerSqlWithBarrier(
        staleReconcileSnapshotSql(value.started.attemptId, isolation, marker),
        marker,
        RECONCILE_AND_COMMIT_SQL,
      );
      let released = false;
      try {
        await staleReconciler.ready;
        expect(await harness.complete(completePayload(value.started.attemptId))).toMatchObject({
          ok: true,
          alreadyCompleted: false,
          status: "succeeded",
        });

        staleReconciler.release();
        released = true;
        const staleResult = await staleReconciler.result;
        const safeStaleOutcome =
          (staleResult.status === 0 &&
            staleResult.stdout.includes('"abandonedCount": 0')) ||
          (staleResult.status !== 0 && staleResult.stderr.includes("40001"));
        expect(safeStaleOutcome, staleResult.stderr || staleResult.stdout).toBe(true);
      } finally {
        if (!released) {
          staleReconciler.release();
        }
      }

      expect(await attempt(value.started.attemptId)).toMatchObject({
        status: "succeeded",
      });
      expect(
        await settlementSnapshot(
          value.user.id,
          value.reservation.reservationId,
          value.reservation.routeSnapshot.profileVersionId,
        ),
      ).toEqual(beforeSettlement);
      expect(await harness.finalize(value.reservation.reservationId)).toMatchObject({
        ok: true,
        alreadyFinalized: false,
        status: "succeeded",
      });
      expect((await reconcile()).data).toEqual({
        releasedCount: 0,
        abandonedCount: 0,
        latencyOverflowCount: 0,
      });
    }
  });

  it("proves a second reconciler skips the first transaction's locked parent", async () => {
    await harness.activateFreshRouteFixture();
    const user = await harness.makeUser("reconcile-double");
    const reservation = await harness.reserveV2(user);
    const started = await harness.startAttempt(reservation.reservationId, 1);
    ownerRewriteAttempt(
      started.attemptId,
      "started_at = pg_catalog.transaction_timestamp() - interval '2 minutes'",
    );

    const firstReady = "DB011_FIRST_RECONCILER_HOLDS_PARENT";
    const secondReady = "DB011_SECOND_RECONCILER_SKIPPED_PARENT";
    const first = startOwnerSqlWithBarrier(
      reconcileSql({ markerAfter: firstReady, commit: false }),
      firstReady,
      "commit;\n",
    );
    let second: BarrierSqlProcess | undefined;
    try {
      await first.ready;
      second = startOwnerSqlWithBarrier(
        reconcileSql({ markerAfter: secondReady }),
        secondReady,
      );
      await Promise.race([
        second.ready,
        sleep(NONBLOCKING_TIMEOUT_MS).then(() => {
          throw new Error("second reconciler did not skip the locked parent promptly");
        }),
      ]);
      const skipped = await second.result;
      expect(skipped.status, skipped.stderr).toBe(0);
      expect(skipped.stdout).toContain('"abandonedCount": 0');

      first.release();
      const settled = await first.result;
      expect(settled.status, settled.stderr).toBe(0);
      expect(settled.stdout).toContain('"heldUnknownCount": 1');
    } finally {
      first.release();
      await Promise.allSettled([
        first.result,
        ...(second ? [second.result] : []),
      ]);
    }

    const settledSnapshot = await settlementSnapshot(
      user.id,
      reservation.reservationId,
      reservation.routeSnapshot.profileVersionId,
    );
    expect(settledSnapshot.request).toMatchObject({
      state: "reserved",
      status: null,
      quota_charged: null,
    });
    expect(settledSnapshot.profile).toEqual([]);

    const late = await service.rpc("complete_ai_polish_provider_attempt", {
      ...completePayload(started.attemptId),
      p_usage: observedUsage(),
      p_route: routeObservation(),
    });
    expect(late.error).toBeNull();
    expect(late.data).toMatchObject({
      ok: true,
      alreadyCompleted: false,
      status: "succeeded",
    });
    expect((await reconcile()).data).toEqual({
      releasedCount: 0,
      abandonedCount: 0,
      latencyOverflowCount: 0,
    });
    expect(await request(reservation.reservationId)).toMatchObject({
      state: "reserved",
      status: null,
    });
    expect(await attempt(started.attemptId)).toMatchObject({
      status: "succeeded",
      transmitted: true,
    });
  });
});
