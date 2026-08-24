import { spawn } from "node:child_process";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  configureFeature,
  createAnonClient,
  createServiceClient,
  createTestUser,
  deleteTestUser,
  FEATURE_CONFIG_DEFAULTS,
  getGlobalStartedCount,
  getLedgerRow,
  RUN_DB_TESTS,
  sleep,
  tryReserve,
  type TestUser,
} from "./helpers";
import {
  authorSyntheticRuntimeContract,
  DEEPSEEK_LEGAL_MANIFEST_ID,
  INITIAL_LEGAL_BUNDLE_VERSION,
  runOwnerSql,
  sealPriceAsDatabaseOwner,
  transitionPolicyAsDatabaseOwner,
  type OwnerSqlResult,
} from "./runtime-contract-fixtures";

const V1_MARK_SHA256 =
  "85b5d5b362e4b116f03d43217667c4e6c342d1f45f0a23e1d78424eab63179a6";
const LARGE_GLOBAL_LIMIT = 2_000_000;
const DB_CONTAINER = "supabase_db_typst-cv-template";
const HOLDER_READY = "DB009_HOLDER_READY";
const CONTENDER_READY = "DB009_CONTENDER_READY";
const CHILD_LOCK_READY = "DB009_CHILD_LOCK_READY";
const ADVISORY_GATE_READY = "DB009_ADVISORY_GATE_READY";
const CHILD_LOCK_GATE_KEY = 9_009_009;
const LOCK_HOLD_SECONDS = 0.8;

interface RouteSnapshot {
  schemaVersion: "route_snapshot_v1";
  configGeneration: string;
  routingPolicyVersionId: string;
  profileVersionId: string;
  priceVersionId: string;
  legalBundleVersion: string;
  runtimeContractId: string;
  runtimeContractSha256: string;
  gatewayKind: "direct_deepseek";
  modelId: string;
  wireApiKind: "chat_completions_v1";
  displayDisclosureKey: string;
}

interface RouteFixture {
  profileId: string;
  profileVersionId: string;
  priceVersionId: string;
  policyVersionId: string;
  runtimeContractId: string;
  runtimeContractSha256: string;
  modelId: string;
  displayDisclosureKey: string;
}

interface ReservationReceipt {
  reservationId: string;
  routeSnapshot: RouteSnapshot;
}

interface StartReceipt {
  ok: true;
  attemptId: string;
  attemptNo: number;
  alreadyStarted: boolean;
  status: string;
  routeSnapshot: RouteSnapshot;
}

interface StartDenial {
  ok: false;
  reason: string;
}

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
  let release: () => void = () => undefined;
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
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!readySettled && `${stdout}\n${stderr}`.includes(marker)) {
        readySettled = true;
        resolveReady();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (!readySettled && `${stdout}\n${stderr}`.includes(marker)) {
        readySettled = true;
        resolveReady();
      }
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
          new Error(
            `owner SQL exited before barrier ${marker}: ${stderr || stdout}`,
          ),
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

  return { ready, release: () => release(), result };
}

function startOwnerAdvisoryGate(
  lockKey: number,
  marker: string,
): BarrierSqlProcess {
  return startOwnerSqlWithBarrier(
    String.raw`
      \set ON_ERROR_STOP on
      select pg_catalog.pg_advisory_lock(${lockKey});
      \echo ${marker}
    `,
    marker,
    String.raw`
      select pg_catalog.pg_advisory_unlock(${lockKey});
    `,
  );
}

function databaseClockMs(): number {
  const result = runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    \pset format unaligned
    \pset tuples_only on
    select floor(
      extract(epoch from pg_catalog.clock_timestamp()) * 1000
    )::bigint;
  `);
  const value = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /^\d+$/u.test(line));
  if (!value) {
    throw new Error(
      `database clock query returned no epoch milliseconds: ${result.stdout}`,
    );
  }
  return Number(value);
}

async function runObservedBlockedRace(
  holderSql: string,
  contenderSql: string,
): Promise<{ holder: OwnerSqlResult; contender: OwnerSqlResult }> {
  const holder = startOwnerSqlWithBarrier(holderSql, HOLDER_READY);
  await holder.ready;

  const contender = startOwnerSqlWithBarrier(contenderSql, CONTENDER_READY);
  let contenderSettled = false;
  const contenderResult = contender.result.then((result) => {
    contenderSettled = true;
    return result;
  });
  await contender.ready;
  await sleep(150);
  expect(contenderSettled).toBe(false);

  const holderResult = await holder.result;
  const completedContender = await contenderResult;
  return { holder: holderResult, contender: completedContender };
}

describe.skipIf(!RUN_DB_TESTS)("V2 provider attempt start RPC (real DB)", () => {
  let service: SupabaseClient;
  let anon: SupabaseClient;
  let fixture: RouteFixture;
  const users: TestUser[] = [];

  beforeAll(async () => {
    service = createServiceClient();
    anon = createAnonClient();
    fixture = await createActiveRouteFixture();
  });

  beforeEach(async () => {
    await configureFeature(service, {
      enabled: true,
      globalDailyLimit: LARGE_GLOBAL_LIMIT,
      allowlist: [],
    });
  });

  afterAll(async () => {
    const pointer = await service
      .from("ai_feature_config")
      .update({
        active_routing_policy_version_id: null,
        routing_updated_by: "provider-attempt-start-test",
        routing_change_reason: `provider attempt start cleanup ${crypto.randomUUID()}`,
      })
      .eq("id", true);
    expect(pointer.error).toBeNull();

    await configureFeature(service, { ...FEATURE_CONFIG_DEFAULTS });
    for (const user of users) {
      await deleteTestUser(service, user.id);
    }
  });

  async function createActiveRouteFixture(): Promise<RouteFixture> {
    const suffix = crypto.randomUUID();
    const profileKey = `test.attempt-start.${suffix}`;
    const modelId = "deepseek-v4-flash";
    const displayDisclosureKey = "deepseek.official";

    const profile = await service
      .from("ai_provider_profiles")
      .insert({
        profile_key: profileKey,
        display_name: "Provider attempt start fixture",
        gateway_kind: "direct_deepseek",
        model_vendor: "deepseek",
      })
      .select("id")
      .single();
    expect(profile.error).toBeNull();

    const version = await service
      .from("ai_provider_profile_versions")
      .insert({
        profile_id: profile.data!.id,
        version: 1,
        adapter_kind: "deepseek_chat_v1",
        wire_api_kind: "chat_completions_v1",
        credential_alias: "deepseek_api_key",
        endpoint_alias: "deepseek_official",
        model_id: modelId,
        upstream_route: {},
        capability_contract_id: "polish_v2",
        cache_policy_id: "automatic_cache_v1",
        legal_manifest_id: DEEPSEEK_LEGAL_MANIFEST_ID,
        display_disclosure_key: displayDisclosureKey,
        config: {},
        config_sha256: "1".repeat(64),
      })
      .select("id")
      .single();
    expect(version.error).toBeNull();

    const price = await service
      .from("ai_price_versions")
      .insert({
        profile_version_id: version.data!.id,
        pricing_lane: "default",
        version: 1,
        currency: "CNY",
        calculator_kind: "linear_token_v1",
        valid_from: new Date(Date.now() - 3_600_000).toISOString(),
        source_url: "https://example.com/provider-attempt-start-price",
        source_checked_at: new Date().toISOString(),
        source_snapshot_sha256: "2".repeat(64),
        parameters: {},
      })
      .select("id")
      .single();
    expect(price.error).toBeNull();

    const components = await service.from("ai_price_components").insert(
      ["input_standard", "input_cache_read", "output"].map((component) => ({
        price_version_id: price.data!.id,
        component,
        nanos_per_million: 1,
      })),
    );
    expect(components.error).toBeNull();
    sealPriceAsDatabaseOwner(price.data!.id);

    const validatedProfile = await service
      .from("ai_provider_profile_versions")
      .update({ status: "validated" })
      .eq("id", version.data!.id);
    expect(validatedProfile.error).toBeNull();

    const runtime = authorSyntheticRuntimeContract({ profileKey });
    const policy = await service
      .from("ai_routing_policy_versions")
      .insert({
        policy_key: `test.attempt-start.${suffix}`,
        version: 1,
        timezone: "Asia/Shanghai",
        rules: {
          schemaVersion: "routing_rules_v1",
          defaultRoute: {
            profileVersionId: version.data!.id,
            priceVersionId: price.data!.id,
          },
          windows: [],
        },
        default_profile_version_id: version.data!.id,
        legal_bundle_version: INITIAL_LEGAL_BUNDLE_VERSION,
        runtime_contract_id: runtime.runtimeContractId,
        runtime_contract_sha256: runtime.runtimeContractSha256,
        config_sha256: "3".repeat(64),
      })
      .select("id")
      .single();
    expect(policy.error).toBeNull();

    transitionPolicyAsDatabaseOwner(policy.data!.id, "validated");
    const canaryProfile = await service
      .from("ai_provider_profile_versions")
      .update({ status: "canary" })
      .eq("id", version.data!.id);
    expect(canaryProfile.error).toBeNull();
    transitionPolicyAsDatabaseOwner(policy.data!.id, "canary");

    const pointer = await service
      .from("ai_feature_config")
      .update({
        active_routing_policy_version_id: policy.data!.id,
        routing_updated_by: "provider-attempt-start-test",
        routing_change_reason: `activate provider attempt start ${suffix}`,
      })
      .eq("id", true);
    expect(pointer.error).toBeNull();

    await configureFeature(service, {
      enabled: true,
      globalDailyLimit: LARGE_GLOBAL_LIMIT,
      allowlist: [],
    });

    return {
      profileId: profile.data!.id,
      profileVersionId: version.data!.id,
      priceVersionId: price.data!.id,
      policyVersionId: policy.data!.id,
      runtimeContractId: runtime.runtimeContractId,
      runtimeContractSha256: runtime.runtimeContractSha256,
      modelId,
      displayDisclosureKey,
    };
  }

  async function makeUser(label: string): Promise<TestUser> {
    const user = await createTestUser(service, label);
    users.push(user);
    return user;
  }

  async function expectedRoute(
    target = fixture,
  ): Promise<Record<string, string>> {
    const config = await service
      .from("ai_feature_config")
      .select("config_generation")
      .eq("id", true)
      .single();
    expect(config.error).toBeNull();
    return {
      schema_version: "expected_route_v1",
      config_generation: String(config.data!.config_generation),
      profile_version_id: target.profileVersionId,
      legal_bundle_version: INITIAL_LEGAL_BUNDLE_VERSION,
      runtime_contract_id: target.runtimeContractId,
      runtime_contract_sha256: target.runtimeContractSha256,
    };
  }

  async function reserveV2(
    user: TestUser,
    target = fixture,
  ): Promise<ReservationReceipt> {
    const result = await service.rpc("reserve_ai_polish_request_v2", {
      p_user_id: user.id,
      p_request_id: crypto.randomUUID(),
      p_client_request_id: crypto.randomUUID(),
      p_expected_route: await expectedRoute(target),
    });
    expect(result.error).toBeNull();
    expect(result.data?.allowed).toBe(true);
    return {
      reservationId: result.data.reservationId as string,
      routeSnapshot: result.data.routeSnapshot as RouteSnapshot,
    };
  }

  async function startAttempt(
    reservationId: string,
    attemptNo: number,
  ): Promise<StartReceipt | StartDenial> {
    const result = await service.rpc("start_ai_polish_provider_attempt", {
      p_reservation_id: reservationId,
      p_attempt_no: attemptNo,
    });
    expect(result.error).toBeNull();
    return result.data as StartReceipt | StartDenial;
  }

  function startAttemptSql(
    reservationId: string,
    attemptNo: 1 | 2,
    options: {
      markerBefore?: string;
      markerAfter?: string;
      holdSeconds?: number;
      lockParentBefore?: boolean;
    } = {},
  ): string {
    return String.raw`
      \set ON_ERROR_STOP on
      \pset format unaligned
      \pset tuples_only on
      begin;
      set local statement_timeout = '10s';
      set local role service_role;
      ${
        options.lockParentBefore
          ? `select reservation_id
             from public.ai_request_ledger
             where reservation_id = '${reservationId}'::uuid
             for update;`
          : ""
      }
      ${options.markerBefore ? `\\echo ${options.markerBefore}` : ""}
      select public.start_ai_polish_provider_attempt(
        '${reservationId}'::uuid,
        ${attemptNo}
      );
      reset role;
      ${options.markerAfter ? `\\echo ${options.markerAfter}` : ""}
      ${
        options.holdSeconds
          ? `select pg_sleep(${options.holdSeconds});`
          : ""
      }
      commit;
    `;
  }

  function markV1Sql(
    reservationId: string,
    markerBefore?: string,
  ): string {
    return String.raw`
      \set ON_ERROR_STOP on
      \pset format unaligned
      \pset tuples_only on
      begin;
      set local statement_timeout = '10s';
      set local role service_role;
      ${markerBefore ? `\\echo ${markerBefore}` : ""}
      select public.mark_ai_polish_provider_started(
        '${reservationId}'::uuid,
        null
      );
      reset role;
      commit;
    `;
  }

  function mutateAndHoldSql(statement: string): string {
    return String.raw`
      \set ON_ERROR_STOP on
      begin;
      set local statement_timeout = '10s';
      ${statement}
      \echo ${HOLDER_READY}
      select pg_sleep(${LOCK_HOLD_SECONDS});
      commit;
    `;
  }

  function completeAttemptSql(attemptId: string): string {
    return String.raw`
      \set ON_ERROR_STOP on
      \pset format unaligned
      \pset tuples_only on
      begin;
      set local statement_timeout = '10s';
      set local role service_role;
      update public.ai_provider_attempt_ledger
      set status = 'succeeded',
          terminal_at = pg_catalog.clock_timestamp(),
          provider_billable = true,
          usage_observation_kind = 'observed',
          usage_schema_version = 'normalized_usage_v2',
          input_total_tokens = 100,
          input_cache_read_tokens = 60,
          input_cache_write_tokens = null,
          input_standard_tokens = 40,
          output_tokens = 20,
          reasoning_tokens = 5,
          cache_usage_reporting = 'unavailable',
          usage_complete = true,
          route_observation_schema_version = 'route_observation_v1',
          cost_observation_schema_version = 'cost_observation_v1',
          estimated_currency = 'CNY',
          estimated_cost_nanos = 1234,
          cost_reconciliation_status = 'not_available',
          finish_reason = 'stop',
          latency_ms = 1234
      where attempt_id = '${attemptId}'::uuid
      returning status;
      reset role;
      commit;
    `;
  }

  async function insertDirectStartedAttempt(
    reservation: ReservationReceipt,
    attemptNo: 1 | 2,
  ) {
    return service
      .from("ai_provider_attempt_ledger")
      .insert({
        reservation_id: reservation.reservationId,
        attempt_no: attemptNo,
        route_schema_version: reservation.routeSnapshot.schemaVersion,
        config_generation: Number(reservation.routeSnapshot.configGeneration),
        routing_policy_version_id:
          reservation.routeSnapshot.routingPolicyVersionId,
        profile_version_id: reservation.routeSnapshot.profileVersionId,
        price_version_id: reservation.routeSnapshot.priceVersionId,
        legal_bundle_version: reservation.routeSnapshot.legalBundleVersion,
        runtime_contract_id: reservation.routeSnapshot.runtimeContractId,
        runtime_contract_sha256:
          reservation.routeSnapshot.runtimeContractSha256,
        gateway_kind: reservation.routeSnapshot.gatewayKind,
        model_id: reservation.routeSnapshot.modelId,
        wire_api_kind: reservation.routeSnapshot.wireApiKind,
        display_disclosure_key:
          reservation.routeSnapshot.displayDisclosureKey,
        adapter_kind: "deepseek_chat_v1",
        credential_alias: "deepseek_api_key",
        endpoint_alias: "deepseek_official",
        capability_contract_id: "polish_v2",
        cache_policy_id: "automatic_cache_v1",
        legal_manifest_id: DEEPSEEK_LEGAL_MANIFEST_ID,
        calculator_kind: "linear_token_v1",
        billing_currency: "CNY",
      })
      .select("attempt_id,attempt_no,status")
      .single();
  }

  async function attemptRows(reservationId: string) {
    const result = await service
      .from("ai_provider_attempt_ledger")
      .select("*")
      .eq("reservation_id", reservationId)
      .order("attempt_no");
    expect(result.error).toBeNull();
    return result.data ?? [];
  }

  async function assertUnstarted(
    reservationId: string,
    globalBefore: number,
  ): Promise<void> {
    expect(await attemptRows(reservationId)).toEqual([]);
    expect(await getGlobalStartedCount(service)).toBe(globalBefore);
    const parent = await getLedgerRow(service, reservationId);
    expect(parent).toMatchObject({
      state: "reserved",
      provider_started_at: null,
      attempt_count: 0,
    });
  }

  it("freezes the exact signature, definer boundary, ACL, one start clock, and V1 fingerprint", () => {
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      do $assertions$
      declare
        v_start pg_catalog.pg_proc%rowtype;
        v_v1 pg_catalog.pg_proc%rowtype;
        v_v1_sha256 text;
      begin
        if (
          select count(*)
          from pg_catalog.pg_proc
          where pronamespace = 'public'::pg_catalog.regnamespace
            and proname = 'start_ai_polish_provider_attempt'
        ) <> 1 then
          raise exception 'start RPC must have exactly one overload';
        end if;

        select * into v_start
        from pg_catalog.pg_proc
        where oid = 'public.start_ai_polish_provider_attempt(uuid,integer)'::pg_catalog.regprocedure;

        if not v_start.prosecdef
           or v_start.proconfig is distinct from array['search_path=""']::text[]
           or pg_catalog.pg_get_function_identity_arguments(v_start.oid)
             is distinct from 'p_reservation_id uuid, p_attempt_no integer'
           or pg_catalog.pg_get_function_result(v_start.oid) is distinct from 'jsonb'
           or pg_catalog.regexp_count(
             pg_catalog.pg_get_functiondef(v_start.oid),
             'clock_timestamp\(\)'
           ) <> 1 then
          raise exception 'start RPC signature/security/clock contract drifted';
        end if;

        if not pg_catalog.has_function_privilege(
             'service_role', v_start.oid, 'EXECUTE'
           )
           or pg_catalog.has_function_privilege('anon', v_start.oid, 'EXECUTE')
           or pg_catalog.has_function_privilege(
             'authenticated', v_start.oid, 'EXECUTE'
           )
           or exists (
             select 1
             from pg_catalog.aclexplode(v_start.proacl)
             where grantee = 0
           ) then
          raise exception 'start RPC ACL drifted';
        end if;

        select * into v_v1
        from pg_catalog.pg_proc
        where oid = 'public.mark_ai_polish_provider_started(uuid,text)'::pg_catalog.regprocedure;
        v_v1_sha256 := pg_catalog.encode(
          extensions.digest(
            pg_catalog.convert_to(pg_catalog.pg_get_functiondef(v_v1.oid), 'UTF8'),
            'sha256'
          ),
          'hex'
        );

        if v_v1.prosecdef
           or v_v1.proconfig is distinct from array['search_path=""']::text[]
           or v_v1_sha256 is distinct from '${V1_MARK_SHA256}'
           or not pg_catalog.has_function_privilege(
             'service_role', v_v1.oid, 'EXECUTE'
           )
           or pg_catalog.has_function_privilege('anon', v_v1.oid, 'EXECUTE')
           or pg_catalog.has_function_privilege(
             'authenticated', v_v1.oid, 'EXECUTE'
           )
           or exists (
             select 1
             from pg_catalog.aclexplode(v_v1.proacl)
             where grantee = 0
           ) then
          raise exception 'V1 provider-start definition or ACL changed';
        end if;
      end
      $assertions$;
    `);
  });

  it("denies anon/authenticated execution and rejects invalid internal attempt numbers", async () => {
    const reservationId = crypto.randomUUID();
    for (const pAttemptNo of [null, 0, 3]) {
      const result = await service.rpc("start_ai_polish_provider_attempt", {
        p_reservation_id: reservationId,
        p_attempt_no: pAttemptNo,
      });
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe("22023");
    }

    const anonResult = await anon.rpc("start_ai_polish_provider_attempt", {
      p_reservation_id: reservationId,
      p_attempt_no: 1,
    });
    expect(anonResult.data).toBeNull();
    expect(anonResult.error?.code).toBe("42501");
  });

  it("returns internal NOT_FOUND and rejects a legacy parent without admission mutation", async () => {
    const missing = await startAttempt(crypto.randomUUID(), 1);
    expect(missing).toEqual({ ok: false, reason: "NOT_FOUND" });

    const user = await makeUser("attempt-start-legacy-parent");
    const legacy = await tryReserve(service, user.id);
    expect(legacy.ok).toBe(true);
    const reservationId = (legacy as { reservationId: string }).reservationId;
    const globalBefore = await getGlobalStartedCount(service);

    const denied = await startAttempt(reservationId, 1);
    expect(denied).toEqual({ ok: false, reason: "SERVICE_UNAVAILABLE" });
    await assertUnstarted(reservationId, globalBefore);
  });

  it("copies the exact frozen route and aliases while keeping the parent reserved", async () => {
    const user = await makeUser("attempt-start-roundtrip");
    const reservation = await reserveV2(user);
    const globalBefore = await getGlobalStartedCount(service);
    const before = databaseClockMs();

    const started = await startAttempt(reservation.reservationId, 1);
    const after = databaseClockMs();
    expect(started).toMatchObject({
      ok: true,
      attemptNo: 1,
      alreadyStarted: false,
      status: "started",
      routeSnapshot: reservation.routeSnapshot,
    });

    const rows = await attemptRows(reservation.reservationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      attempt_id: (started as StartReceipt).attemptId,
      attempt_no: 1,
      route_schema_version: reservation.routeSnapshot.schemaVersion,
      config_generation: Number(reservation.routeSnapshot.configGeneration),
      routing_policy_version_id: reservation.routeSnapshot.routingPolicyVersionId,
      profile_version_id: reservation.routeSnapshot.profileVersionId,
      price_version_id: reservation.routeSnapshot.priceVersionId,
      legal_bundle_version: reservation.routeSnapshot.legalBundleVersion,
      runtime_contract_id: reservation.routeSnapshot.runtimeContractId,
      runtime_contract_sha256: reservation.routeSnapshot.runtimeContractSha256,
      gateway_kind: reservation.routeSnapshot.gatewayKind,
      model_id: reservation.routeSnapshot.modelId,
      wire_api_kind: reservation.routeSnapshot.wireApiKind,
      display_disclosure_key: reservation.routeSnapshot.displayDisclosureKey,
      adapter_kind: "deepseek_chat_v1",
      credential_alias: "deepseek_api_key",
      endpoint_alias: "deepseek_official",
      capability_contract_id: "polish_v2",
      cache_policy_id: "automatic_cache_v1",
      legal_manifest_id: DEEPSEEK_LEGAL_MANIFEST_ID,
      calculator_kind: "linear_token_v1",
      billing_currency: "CNY",
      status: "started",
    });
    expect(Date.parse(rows[0].started_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(rows[0].started_at)).toBeLessThanOrEqual(after);

    const parent = await getLedgerRow(service, reservation.reservationId);
    expect(parent).toMatchObject({
      state: "reserved",
      provider_started_at: null,
      attempt_count: 1,
    });
    expect(await getGlobalStartedCount(service)).toBe(globalBefore + 1);
  });

  it("replays sequentially before operational gates and consumes no second slot", async () => {
    const user = await makeUser("attempt-start-sequential-replay");
    const reservation = await reserveV2(user);
    const first = (await startAttempt(reservation.reservationId, 1)) as StartReceipt;
    const globalAfterFirst = await getGlobalStartedCount(service);

    await configureFeature(service, { enabled: false });
    const replay = await startAttempt(reservation.reservationId, 1);
    expect(replay).toEqual({
      ...first,
      alreadyStarted: true,
    });
    expect(await getGlobalStartedCount(service)).toBe(globalAfterFirst);
    expect((await getLedgerRow(service, reservation.reservationId))?.attempt_count).toBe(1);
    expect(await attemptRows(reservation.reservationId)).toHaveLength(1);
  });

  it("serializes concurrent same-attempt starts into one admission and one replay", async () => {
    const user = await makeUser("attempt-start-concurrent-replay");
    const reservation = await reserveV2(user);
    const globalBefore = await getGlobalStartedCount(service);

    const receipts = (await Promise.all([
      startAttempt(reservation.reservationId, 1),
      startAttempt(reservation.reservationId, 1),
    ])) as StartReceipt[];

    expect(receipts.every((receipt) => receipt.ok)).toBe(true);
    expect(receipts.map((receipt) => receipt.alreadyStarted).sort()).toEqual([
      false,
      true,
    ]);
    expect(new Set(receipts.map((receipt) => receipt.attemptId)).size).toBe(1);
    expect(receipts[0].routeSnapshot).toEqual(reservation.routeSnapshot);
    expect(receipts[1].routeSnapshot).toEqual(reservation.routeSnapshot);
    expect(await attemptRows(reservation.reservationId)).toHaveLength(1);
    expect((await getLedgerRow(service, reservation.reservationId))?.attempt_count).toBe(1);
    expect(await getGlobalStartedCount(service)).toBe(globalBefore + 1);
  });

  it("observably blocks a same-attempt contender until the first start commits", async () => {
    const user = await makeUser("attempt-start-observed-replay");
    const reservation = await reserveV2(user);
    const globalBefore = await getGlobalStartedCount(service);

    const race = await runObservedBlockedRace(
      startAttemptSql(reservation.reservationId, 1, {
        markerAfter: HOLDER_READY,
        holdSeconds: LOCK_HOLD_SECONDS,
      }),
      startAttemptSql(reservation.reservationId, 1, {
        markerBefore: CONTENDER_READY,
      }),
    );

    expect(race.holder.status, race.holder.stderr).toBe(0);
    expect(race.holder.stdout).toContain('"alreadyStarted": false');
    expect(race.contender.status, race.contender.stderr).toBe(0);
    expect(race.contender.stdout).toContain('"alreadyStarted": true');
    expect(await attemptRows(reservation.reservationId)).toHaveLength(1);
    expect(await getLedgerRow(service, reservation.reservationId)).toMatchObject({
      state: "reserved",
      provider_started_at: null,
      attempt_count: 1,
    });
    expect(await getGlobalStartedCount(service)).toBe(globalBefore + 1);
  });

  it("serializes a direct child completion against replay without a parent-child deadlock", async () => {
    const user = await makeUser("attempt-start-direct-update-replay");
    const reservation = await reserveV2(user);
    const first = (await startAttempt(reservation.reservationId, 1)) as StartReceipt;
    const globalAfterStart = await getGlobalStartedCount(service);
    const probeFunction = "public.db009_hold_child_before_parent";
    const probeTrigger = "a_db009_hold_child_before_parent";

    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      drop trigger if exists ${probeTrigger}
        on public.ai_provider_attempt_ledger;
      drop function if exists ${probeFunction}();
      create function ${probeFunction}()
      returns trigger
      language plpgsql
      set search_path = ''
      as $probe$
      begin
        raise notice '${CHILD_LOCK_READY}';
        perform pg_catalog.pg_advisory_xact_lock(${CHILD_LOCK_GATE_KEY});
        return new;
      end
      $probe$;

      create trigger ${probeTrigger}
      before update on public.ai_provider_attempt_ledger
      for each row execute function ${probeFunction}();
    `);

    const gate = startOwnerAdvisoryGate(
      CHILD_LOCK_GATE_KEY,
      ADVISORY_GATE_READY,
    );
    let holder: BarrierSqlProcess | undefined;
    let contender: BarrierSqlProcess | undefined;
    try {
      await gate.ready;
      holder = startOwnerSqlWithBarrier(
        completeAttemptSql(first.attemptId),
        CHILD_LOCK_READY,
      );
      await holder.ready;

      contender = startOwnerSqlWithBarrier(
        startAttemptSql(reservation.reservationId, 1, {
          lockParentBefore: true,
          markerBefore: CONTENDER_READY,
          holdSeconds: LOCK_HOLD_SECONDS,
        }),
        CONTENDER_READY,
      );
      await contender.ready;

      let holderSettled = false;
      const holderResult = holder.result.then((result) => {
        holderSettled = true;
        return result;
      });
      gate.release();
      await sleep(150);
      expect(holderSettled).toBe(false);

      const [completedContender, completedHolder, completedGate] =
        await Promise.all([contender.result, holderResult, gate.result]);
      expect(completedContender.status, completedContender.stderr).toBe(0);
      expect(completedHolder.status, completedHolder.stderr).toBe(0);
      expect(completedHolder.stdout).toContain("succeeded");
      expect(completedGate.status, completedGate.stderr).toBe(0);

      const replayLine = completedContender.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((line) => line.startsWith('{"ok"'));
      expect(replayLine).toBeDefined();
      expect(JSON.parse(replayLine!)).toEqual({
        ...first,
        alreadyStarted: true,
      });
    } finally {
      gate.release();
      await Promise.allSettled([
        gate.result,
        ...(holder ? [holder.result] : []),
        ...(contender ? [contender.result] : []),
      ]);
      runOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        drop trigger if exists ${probeTrigger}
          on public.ai_provider_attempt_ledger;
        drop function if exists ${probeFunction}();
      `);
    }

    expect(await attemptRows(reservation.reservationId)).toMatchObject([
      {
        attempt_id: first.attemptId,
        attempt_no: 1,
        status: "succeeded",
      },
    ]);
    expect(await getLedgerRow(service, reservation.reservationId)).toMatchObject({
      state: "reserved",
      provider_started_at: null,
      attempt_count: 1,
    });
    expect(await getGlobalStartedCount(service)).toBe(globalAfterStart);
  });

  it("admits caller-stable attempts 1 and 2 exactly once each", async () => {
    const user = await makeUser("attempt-start-two-attempts");
    const reservation = await reserveV2(user);
    const globalBefore = await getGlobalStartedCount(service);

    const first = await startAttempt(reservation.reservationId, 1);
    const second = await startAttempt(reservation.reservationId, 2);
    expect(first).toMatchObject({ ok: true, attemptNo: 1, alreadyStarted: false });
    expect(second).toMatchObject({ ok: true, attemptNo: 2, alreadyStarted: false });
    expect((await attemptRows(reservation.reservationId)).map((row) => row.attempt_no)).toEqual([
      1,
      2,
    ]);
    expect((await getLedgerRow(service, reservation.reservationId))?.attempt_count).toBe(2);
    expect(await getGlobalStartedCount(service)).toBe(globalBefore + 2);
  });

  it("rejects attempt 2 as the first child with zero admission mutation", async () => {
    const user = await makeUser("attempt-start-two-first");
    const reservation = await reserveV2(user);
    const globalBefore = await getGlobalStartedCount(service);

    expect(await startAttempt(reservation.reservationId, 2)).toEqual({
      ok: false,
      reason: "SERVICE_UNAVAILABLE",
    });
    await assertUnstarted(reservation.reservationId, globalBefore);
  });

  it("refuses to replay a direct child whose parent count was not admitted", async () => {
    const user = await makeUser("attempt-start-child-only-drift");
    const reservation = await reserveV2(user);
    const globalBefore = await getGlobalStartedCount(service);
    const direct = await insertDirectStartedAttempt(reservation, 1);
    expect(direct.error).toBeNull();

    expect(await startAttempt(reservation.reservationId, 1)).toEqual({
      ok: false,
      reason: "SERVICE_UNAVAILABLE",
    });
    expect(await attemptRows(reservation.reservationId)).toMatchObject([
      {
        attempt_id: direct.data!.attempt_id,
        attempt_no: 1,
        status: "started",
      },
    ]);
    expect(await getGlobalStartedCount(service)).toBe(globalBefore);
    expect(await getLedgerRow(service, reservation.reservationId)).toMatchObject({
      state: "reserved",
      attempt_count: 0,
    });
  });

  it("refuses a parent-only count drift before creating a child", async () => {
    const user = await makeUser("attempt-start-parent-only-drift");
    const reservation = await reserveV2(user);
    const drift = await service
      .from("ai_request_ledger")
      .update({ attempt_count: 1 })
      .eq("reservation_id", reservation.reservationId);
    expect(drift.error).toBeNull();
    const globalBefore = await getGlobalStartedCount(service);

    expect(await startAttempt(reservation.reservationId, 1)).toEqual({
      ok: false,
      reason: "SERVICE_UNAVAILABLE",
    });
    expect(await attemptRows(reservation.reservationId)).toEqual([]);
    expect(await getGlobalStartedCount(service)).toBe(globalBefore);
    expect((await getLedgerRow(service, reservation.reservationId))?.attempt_count).toBe(1);
  });

  it("refuses an aligned but impossible child set containing only attempt 2", async () => {
    const user = await makeUser("attempt-start-invalid-two-set");
    const reservation = await reserveV2(user);
    const direct = await insertDirectStartedAttempt(reservation, 2);
    expect(direct.error).toBeNull();
    const alignCount = await service
      .from("ai_request_ledger")
      .update({ attempt_count: 1 })
      .eq("reservation_id", reservation.reservationId);
    expect(alignCount.error).toBeNull();
    const globalBefore = await getGlobalStartedCount(service);

    expect(await startAttempt(reservation.reservationId, 2)).toEqual({
      ok: false,
      reason: "SERVICE_UNAVAILABLE",
    });
    expect((await attemptRows(reservation.reservationId)).map((row) => row.attempt_no)).toEqual([2]);
    expect(await getGlobalStartedCount(service)).toBe(globalBefore);
    expect((await getLedgerRow(service, reservation.reservationId))?.attempt_count).toBe(1);
  });

  it("returns ALREADY_FINALIZED without touching attempt or global accounting", async () => {
    const user = await makeUser("attempt-start-finalized");
    const reservation = await reserveV2(user);
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
      .eq("reservation_id", reservation.reservationId)
      .select("state")
      .single();
    expect(finalized.error).toBeNull();
    const globalBefore = await getGlobalStartedCount(service);

    const denied = await startAttempt(reservation.reservationId, 1);
    expect(denied).toEqual({ ok: false, reason: "ALREADY_FINALIZED" });
    expect(await attemptRows(reservation.reservationId)).toEqual([]);
    expect(await getGlobalStartedCount(service)).toBe(globalBefore);
  });

  it("denies disabled and non-allowlisted starts with zero admission mutation", async () => {
    const disabledUser = await makeUser("attempt-start-disabled");
    const disabledReservation = await reserveV2(disabledUser);
    let globalBefore = await getGlobalStartedCount(service);

    await configureFeature(service, { enabled: false });
    expect(await startAttempt(disabledReservation.reservationId, 1)).toEqual({
      ok: false,
      reason: "AI_DISABLED",
    });
    await assertUnstarted(disabledReservation.reservationId, globalBefore);

    await configureFeature(service, { enabled: true, allowlist: [] });
    const excludedUser = await makeUser("attempt-start-not-allowlisted");
    const excludedReservation = await reserveV2(excludedUser);
    globalBefore = await getGlobalStartedCount(service);
    await configureFeature(service, { allowlist: [crypto.randomUUID()] });

    expect(await startAttempt(excludedReservation.reservationId, 1)).toEqual({
      ok: false,
      reason: "AI_DISABLED",
    });
    await assertUnstarted(excludedReservation.reservationId, globalBefore);
  });

  it("waits on a concurrent config disable and then denies without admission", async () => {
    const user = await makeUser("attempt-start-observed-disable");
    const reservation = await reserveV2(user);
    const globalBefore = await getGlobalStartedCount(service);

    const race = await runObservedBlockedRace(
      mutateAndHoldSql(String.raw`
        update public.ai_feature_config
        set ai_polish_enabled = false
        where id = true;
      `),
      startAttemptSql(reservation.reservationId, 1, {
        markerBefore: CONTENDER_READY,
      }),
    );

    expect(race.holder.status, race.holder.stderr).toBe(0);
    expect(race.contender.status, race.contender.stderr).toBe(0);
    expect(race.contender.stdout).toContain('"reason": "AI_DISABLED"');
    await assertUnstarted(reservation.reservationId, globalBefore);
  });

  it("denies a full global gate without mutating request or attempt counts", async () => {
    const user = await makeUser("attempt-start-capacity-full");
    const reservation = await reserveV2(user);
    const globalBefore = await getGlobalStartedCount(service);
    await configureFeature(service, { globalDailyLimit: globalBefore });

    expect(await startAttempt(reservation.reservationId, 1)).toEqual({
      ok: false,
      reason: "SERVICE_UNAVAILABLE",
    });
    await assertUnstarted(reservation.reservationId, globalBefore);
  });

  it("serializes V1 and V2 on the same final global slot without changing V1 semantics", async () => {
    const v1User = await makeUser("attempt-start-v1-race");
    const v2User = await makeUser("attempt-start-v2-race");
    const v1Reservation = await tryReserve(service, v1User.id);
    const v2Reservation = await reserveV2(v2User);
    expect(v1Reservation.ok).toBe(true);

    const globalBefore = await getGlobalStartedCount(service);
    await configureFeature(service, { globalDailyLimit: globalBefore + 1 });

    const [v1Result, v2Result] = await Promise.all([
      service.rpc("mark_ai_polish_provider_started", {
        p_reservation_id: (v1Reservation as { reservationId: string }).reservationId,
        p_provider_request_id: null,
      }),
      service.rpc("start_ai_polish_provider_attempt", {
        p_reservation_id: v2Reservation.reservationId,
        p_attempt_no: 1,
      }),
    ]);
    expect(v1Result.error).toBeNull();
    expect(v2Result.error).toBeNull();

    const outcomes = [v1Result.data, v2Result.data];
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.reason),
    ).toEqual(["SERVICE_UNAVAILABLE"]);
    expect(await getGlobalStartedCount(service)).toBe(globalBefore + 1);

    const v1Parent = await getLedgerRow(
      service,
      (v1Reservation as { reservationId: string }).reservationId,
    );
    const v2Parent = await getLedgerRow(service, v2Reservation.reservationId);
    const v2Rows = await attemptRows(v2Reservation.reservationId);

    if (v1Result.data.ok) {
      expect(v1Parent).toMatchObject({
        state: "provider_started",
        attempt_count: 1,
      });
      expect(v2Parent).toMatchObject({ state: "reserved", attempt_count: 0 });
      expect(v2Rows).toEqual([]);
    } else {
      expect(v1Parent).toMatchObject({ state: "reserved", attempt_count: 0 });
      expect(v2Parent).toMatchObject({
        state: "reserved",
        provider_started_at: null,
        attempt_count: 1,
      });
      expect(v2Rows).toHaveLength(1);
    }
  });

  it("observably serializes V2 ahead of V1 on the final global slot", async () => {
    const v1User = await makeUser("attempt-start-observed-v1-race");
    const v2User = await makeUser("attempt-start-observed-v2-race");
    const v1Reservation = await tryReserve(service, v1User.id);
    const v2Reservation = await reserveV2(v2User);
    expect(v1Reservation.ok).toBe(true);
    const v1ReservationId = (v1Reservation as { reservationId: string })
      .reservationId;

    const globalBefore = await getGlobalStartedCount(service);
    await configureFeature(service, { globalDailyLimit: globalBefore + 1 });
    const race = await runObservedBlockedRace(
      startAttemptSql(v2Reservation.reservationId, 1, {
        markerAfter: HOLDER_READY,
        holdSeconds: LOCK_HOLD_SECONDS,
      }),
      markV1Sql(v1ReservationId, CONTENDER_READY),
    );

    expect(race.holder.status, race.holder.stderr).toBe(0);
    expect(race.holder.stdout).toContain('"alreadyStarted": false');
    expect(race.contender.status, race.contender.stderr).toBe(0);
    expect(race.contender.stdout).toContain(
      '"reason": "SERVICE_UNAVAILABLE"',
    );
    expect(await getGlobalStartedCount(service)).toBe(globalBefore + 1);
    expect(await getLedgerRow(service, v1ReservationId)).toMatchObject({
      state: "reserved",
      provider_started_at: null,
      attempt_count: 0,
    });
    expect(await attemptRows(v1ReservationId)).toEqual([]);
    expect(await getLedgerRow(service, v2Reservation.reservationId)).toMatchObject({
      state: "reserved",
      provider_started_at: null,
      attempt_count: 1,
    });
    expect(await attemptRows(v2Reservation.reservationId)).toHaveLength(1);
  });

  it("keeps a frozen closed price eligible but denies a subsequently retired profile", async () => {
    await configureFeature(service, { globalDailyLimit: LARGE_GLOBAL_LIMIT, allowlist: [] });
    const priceUser = await makeUser("attempt-start-closed-price");
    const retiredUser = await makeUser("attempt-start-retired-profile");
    const priceReservation = await reserveV2(priceUser);
    const retiredReservation = await reserveV2(retiredUser);

    const closePrice = await service
      .from("ai_price_versions")
      .update({ valid_to: new Date().toISOString() })
      .eq("id", fixture.priceVersionId);
    expect(closePrice.error).toBeNull();

    const globalBeforePriceStart = await getGlobalStartedCount(service);
    expect(await startAttempt(priceReservation.reservationId, 1)).toMatchObject({
      ok: true,
      attemptNo: 1,
      alreadyStarted: false,
    });
    expect(await getGlobalStartedCount(service)).toBe(globalBeforePriceStart + 1);

    const retireProfile = await service
      .from("ai_provider_profile_versions")
      .update({ status: "retired" })
      .eq("id", fixture.profileVersionId);
    expect(retireProfile.error).toBeNull();
    const globalBeforeRetiredStart = await getGlobalStartedCount(service);

    expect(await startAttempt(retiredReservation.reservationId, 1)).toEqual({
      ok: false,
      reason: "SERVICE_UNAVAILABLE",
    });
    await assertUnstarted(retiredReservation.reservationId, globalBeforeRetiredStart);
  });

  it("waits for a concurrent price close and then starts on the frozen price", async () => {
    const target = await createActiveRouteFixture();
    const user = await makeUser("attempt-start-observed-price-close");
    const reservation = await reserveV2(user, target);
    const globalBefore = await getGlobalStartedCount(service);

    const race = await runObservedBlockedRace(
      mutateAndHoldSql(String.raw`
        update public.ai_price_versions
        set valid_to = greatest(
          clock_timestamp(),
          valid_from + interval '1 microsecond'
        )
        where id = '${target.priceVersionId}'::uuid;
      `),
      startAttemptSql(reservation.reservationId, 1, {
        markerBefore: CONTENDER_READY,
      }),
    );

    expect(race.holder.status, race.holder.stderr).toBe(0);
    expect(race.contender.status, race.contender.stderr).toBe(0);
    expect(race.contender.stdout).toContain('"alreadyStarted": false');
    expect(await attemptRows(reservation.reservationId)).toHaveLength(1);
    expect(await getLedgerRow(service, reservation.reservationId)).toMatchObject({
      state: "reserved",
      provider_started_at: null,
      attempt_count: 1,
    });
    expect(await getGlobalStartedCount(service)).toBe(globalBefore + 1);
  });

  it("waits for a concurrent profile retirement and then denies admission", async () => {
    const target = await createActiveRouteFixture();
    const user = await makeUser("attempt-start-observed-profile-retire");
    const reservation = await reserveV2(user, target);
    const globalBefore = await getGlobalStartedCount(service);

    const race = await runObservedBlockedRace(
      mutateAndHoldSql(String.raw`
        update public.ai_provider_profiles
        set retired_at = greatest(clock_timestamp(), created_at)
        where id = '${target.profileId}'::uuid;
      `),
      startAttemptSql(reservation.reservationId, 1, {
        markerBefore: CONTENDER_READY,
      }),
    );

    expect(race.holder.status, race.holder.stderr).toBe(0);
    expect(race.contender.status, race.contender.stderr).toBe(0);
    expect(race.contender.stdout).toContain(
      '"reason": "SERVICE_UNAVAILABLE"',
    );
    await assertUnstarted(reservation.reservationId, globalBefore);
  });
});
