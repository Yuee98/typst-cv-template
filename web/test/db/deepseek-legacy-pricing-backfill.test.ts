import { spawn } from "node:child_process";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createServiceClient,
  createTestUser,
  deleteTestUser,
  RUN_DB_TESTS,
  type TestUser,
} from "./helpers";
import {
  authorSyntheticRuntimeContract,
  INITIAL_LEGAL_BUNDLE_VERSION,
  runOwnerSql,
  sealPriceAsDatabaseOwner,
  startOwnerSql,
  type OwnerSqlResult,
  type SyntheticRuntimeContract,
} from "./runtime-contract-fixtures";

const CUTOFF = "2026-08-16T16:00:00.000Z";
const BEFORE = "2026-08-16T15:59:59.000Z";
const LEGACY_PROFILE = "11111111-1111-4111-8111-111111111111";
const LEGACY_PROFILE_PARENT = "11111111-1111-4111-8111-111111111110";
const LEGACY_PRICE = "11111111-1111-4111-8111-111111111114";
const CHECK_VIOLATION = "23514";
const DB_CONTAINER = "supabase_db_typst-cv-template";

interface BarrierSqlProcess {
  ready: Promise<void>;
  release: () => void;
  result: Promise<OwnerSqlResult>;
}

interface SyntheticCurrentRouteFixture {
  reservationId: string;
  profileId: string;
  profileVersionId: string;
  priceVersionId: string;
  policyVersionId: string;
  runtime: SyntheticRuntimeContract;
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

describe.skipIf(!RUN_DB_TESTS)("DB-012 DeepSeek legacy pricing backfill (real DB)", () => {
  let service: SupabaseClient;
  let user: TestUser;

  beforeAll(async () => {
    service = createServiceClient();
    user = await createTestUser(service, "deepseek-legacy-backfill");
  });

  afterAll(async () => {
    await deleteTestUser(service, user.id);
  });

  afterEach(async () => {
    const result = await service
      .from("ai_request_ledger")
      .delete()
      .eq("user_id", user.id);
    expect(result.error).toBeNull();
  });

  function historicalRow(overrides: Record<string, unknown> = {}) {
    return {
      request_id: crypto.randomUUID(),
      client_request_id: crypto.randomUUID(),
      user_id: user.id,
      state: "finalized",
      status: "succeeded",
      quota_charged: true,
      provider_billable: true,
      usage_complete: true,
      attempt_count: 1,
      model: "deepseek-v4-flash",
      reserved_at: BEFORE,
      provider_started_at: BEFORE,
      finalized_at: BEFORE,
      input_cached_tokens: 2,
      input_uncached_tokens: 3,
      output_tokens: 5,
      ...overrides,
    };
  }

  async function insertHistorical(overrides: Record<string, unknown> = {}) {
    const result = await service
      .from("ai_request_ledger")
      .insert(historicalRow(overrides))
      .select("reservation_id")
      .single();
    expect(result.error).toBeNull();
    return result.data!.reservation_id as string;
  }

  function runBackfill(options: { expectFailure?: boolean } = {}) {
    return runOwnerSql(
      "select public.backfill_deepseek_legacy_pricing_v1();",
      options,
    );
  }

  async function read(reservationId: string) {
    const result = await service
      .from("ai_request_ledger")
      .select("*")
      .eq("reservation_id", reservationId)
      .single();
    expect(result.error).toBeNull();
    return result.data!;
  }

  async function readAttempts(reservationId: string) {
    const result = await service
      .from("ai_provider_attempt_ledger")
      .select("*")
      .eq("reservation_id", reservationId)
      .order("attempt_no");
    expect(result.error).toBeNull();
    return result.data!;
  }

  function cleanupSyntheticCurrentRoute(fixture: SyntheticCurrentRouteFixture) {
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      begin;
      set local session_replication_role = replica;
      delete from public.ai_provider_attempt_ledger
      where reservation_id = '${fixture.reservationId}'::uuid;
      delete from public.ai_request_ledger
      where reservation_id = '${fixture.reservationId}'::uuid;
      delete from public.ai_routing_policy_versions
      where id = '${fixture.policyVersionId}'::uuid;
      delete from public.ai_price_component_seal_intents
      where price_version_id = '${fixture.priceVersionId}'::uuid;
      delete from public.ai_price_components
      where price_version_id = '${fixture.priceVersionId}'::uuid;
      delete from public.ai_price_versions
      where id = '${fixture.priceVersionId}'::uuid;
      delete from public.ai_service_runtime_contract_targets
      where runtime_contract_id = '${fixture.runtime.runtimeContractId}'
        and runtime_contract_sha256 = '${fixture.runtime.runtimeContractSha256}';
      delete from public.ai_service_runtime_contract_versions
      where runtime_contract_id = '${fixture.runtime.runtimeContractId}'
        and runtime_contract_sha256 = '${fixture.runtime.runtimeContractSha256}';
      delete from public.ai_service_runtime_target_versions
      where runtime_target_id = '${fixture.runtime.runtimeTargetId}'
        and runtime_target_sha256 = '${fixture.runtime.runtimeTargetSha256}';
      delete from public.ai_provider_profile_versions
      where id = '${fixture.profileVersionId}'::uuid;
      delete from public.ai_provider_profiles
      where id = '${fixture.profileId}'::uuid;
      set local session_replication_role = origin;
      commit;
    `);
  }

  async function createSyntheticCurrentRoute(): Promise<SyntheticCurrentRouteFixture> {
    const fixture: SyntheticCurrentRouteFixture = {
      reservationId: crypto.randomUUID(),
      profileId: crypto.randomUUID(),
      profileVersionId: crypto.randomUUID(),
      priceVersionId: crypto.randomUUID(),
      policyVersionId: crypto.randomUUID(),
      runtime: authorSyntheticRuntimeContract({
        profileKey: `test.db012.current.${crypto.randomUUID()}`,
      }),
    };
    const profileKey = fixture.runtime.profileKey;

    try {
      runOwnerSql(String.raw`begin;
        insert into public.ai_provider_profiles(id,profile_key,display_name,gateway_kind,model_vendor) values ('${fixture.profileId}','${profileKey}','DB012 current-route fixture','direct_deepseek','fixture');
        insert into public.ai_provider_profile_versions(id,profile_id,version,adapter_kind,wire_api_kind,credential_alias,endpoint_alias,model_id,model_snapshot,upstream_route,capability_contract_id,cache_policy_id,legal_manifest_id,display_disclosure_key,config,config_sha256) values ('${fixture.profileVersionId}','${fixture.profileId}',1,'deepseek_chat_v1','chat_completions_v1','db012_fixture_api_key','db012_fixture_endpoint','db012-current-model','db012-current-model-v1','{}','db012_fixture_capabilities_v1','automatic_cache_v1','${fixture.runtime.legalManifestId}','db012.fixture.current','{}','${"1".repeat(64)}');
        insert into public.ai_price_versions(id,profile_version_id,pricing_lane,version,currency,calculator_kind,valid_from,source_url,source_checked_at,source_snapshot_sha256,parameters) values ('${fixture.priceVersionId}','${fixture.profileVersionId}','default',1,'CNY','linear_token_v1','2026-01-01T00:00:00Z','https://example.com/db012-current-route-fixture','2026-08-23T00:00:00Z','${"2".repeat(64)}','{}');
        insert into public.ai_price_components(price_version_id,component,nanos_per_million) values ('${fixture.priceVersionId}','input_cache_read',20000000),('${fixture.priceVersionId}','input_standard',1000000000),('${fixture.priceVersionId}','output',2000000000); commit;`);
      sealPriceAsDatabaseOwner(fixture.priceVersionId);

      runOwnerSql(String.raw`insert into public.ai_routing_policy_versions(id,policy_key,version,status,timezone,rules,default_profile_version_id,legal_bundle_version,runtime_contract_id,runtime_contract_sha256,config_sha256) values ('${fixture.policyVersionId}','test.db012.current.${crypto.randomUUID()}',1,'draft','Asia/Shanghai','{"schemaVersion":"routing_rules_v1","defaultRoute":{"profileVersionId":"${fixture.profileVersionId}","priceVersionId":"${fixture.priceVersionId}"},"windows":[]}'::jsonb,'${fixture.profileVersionId}','${INITIAL_LEGAL_BUNDLE_VERSION}','${fixture.runtime.runtimeContractId}','${fixture.runtime.runtimeContractSha256}','${"3".repeat(64)}');`);

      const request = await service.from("ai_request_ledger").insert({
        reservation_id: fixture.reservationId,
        request_id: crypto.randomUUID(),
        client_request_id: crypto.randomUUID(),
        user_id: user.id,
        route_schema_version: "route_snapshot_v1",
        config_generation: 42,
        routing_policy_version_id: fixture.policyVersionId,
        profile_version_id: fixture.profileVersionId,
        price_version_id: fixture.priceVersionId,
        legal_bundle_version: INITIAL_LEGAL_BUNDLE_VERSION,
        runtime_contract_id: fixture.runtime.runtimeContractId,
        runtime_contract_sha256: fixture.runtime.runtimeContractSha256,
        gateway_kind: "direct_deepseek",
        model_id: "db012-current-model",
        wire_api_kind: "chat_completions_v1",
        display_disclosure_key: "db012.fixture.current",
      });
      expect(request.error).toBeNull();
      return fixture;
    } catch (error) {
      cleanupSyntheticCurrentRoute(fixture);
      throw error;
    }
  }

  function ownerSyntheticCatalogSnapshot(fixture: SyntheticCurrentRouteFixture) {
    const result = runOwnerSql(String.raw`
      copy (
        select pg_catalog.jsonb_build_object(
          'profileParent', (select pg_catalog.to_jsonb(row_value)
            from public.ai_provider_profiles as row_value
            where id = '${fixture.profileId}'::uuid),
          'profileVersion', (select pg_catalog.to_jsonb(row_value)
            from public.ai_provider_profile_versions as row_value
            where id = '${fixture.profileVersionId}'::uuid),
          'price', (select pg_catalog.to_jsonb(row_value)
            from public.ai_price_versions as row_value
            where id = '${fixture.priceVersionId}'::uuid),
          'components', (select pg_catalog.jsonb_agg(
              pg_catalog.to_jsonb(row_value) order by component)
            from public.ai_price_components as row_value
            where price_version_id = '${fixture.priceVersionId}'::uuid),
          'sealIntent', (select pg_catalog.to_jsonb(row_value)
            from public.ai_price_component_seal_intents as row_value
            where price_version_id = '${fixture.priceVersionId}'::uuid),
          'policy', (select pg_catalog.to_jsonb(row_value)
            from public.ai_routing_policy_versions as row_value
            where id = '${fixture.policyVersionId}'::uuid),
          'runtimeContract', (select pg_catalog.to_jsonb(row_value)
            from public.ai_service_runtime_contract_versions as row_value
            where runtime_contract_id = '${fixture.runtime.runtimeContractId}'
              and runtime_contract_sha256 = '${fixture.runtime.runtimeContractSha256}'),
          'runtimeMembership', (select pg_catalog.to_jsonb(row_value)
            from public.ai_service_runtime_contract_targets as row_value
            where runtime_contract_id = '${fixture.runtime.runtimeContractId}'
              and runtime_contract_sha256 = '${fixture.runtime.runtimeContractSha256}'),
          'runtimeTarget', (select pg_catalog.to_jsonb(row_value)
            from public.ai_service_runtime_target_versions as row_value
            where runtime_target_id = '${fixture.runtime.runtimeTargetId}'
              and runtime_target_sha256 = '${fixture.runtime.runtimeTargetSha256}')
        )::text
      ) to stdout;
    `);
    return JSON.parse(result.stdout.trim()) as unknown;
  }

  function insertStartedAttempt(fixture: SyntheticCurrentRouteFixture) {
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      insert into public.ai_provider_attempt_ledger (
        reservation_id, attempt_no, route_schema_version, config_generation,
        routing_policy_version_id, profile_version_id, price_version_id,
        legal_bundle_version, runtime_contract_id, runtime_contract_sha256,
        gateway_kind, model_id, wire_api_kind, display_disclosure_key,
        adapter_kind, credential_alias, endpoint_alias, capability_contract_id,
        cache_policy_id, legal_manifest_id, calculator_kind, billing_currency
      )
      select
        request.reservation_id, 1, request.route_schema_version,
        request.config_generation, request.routing_policy_version_id,
        request.profile_version_id, request.price_version_id,
        request.legal_bundle_version, request.runtime_contract_id,
        request.runtime_contract_sha256, request.gateway_kind, request.model_id,
        request.wire_api_kind, request.display_disclosure_key,
        profile.adapter_kind, profile.credential_alias, profile.endpoint_alias,
        profile.capability_contract_id, profile.cache_policy_id,
        profile.legal_manifest_id, price.calculator_kind, price.currency
      from public.ai_request_ledger as request
      join public.ai_provider_profile_versions as profile
        on profile.id = request.profile_version_id
      join public.ai_price_versions as price on price.id = request.price_version_id
      where request.reservation_id = '${fixture.reservationId}'::uuid;
    `);
  }

  function hostileReplaySql(mutation: string, expectedMessage: string) {
    return String.raw`
      begin;
      set local session_replication_role = replica;
      delete from public.ai_price_component_seal_intents where price_version_id = '${LEGACY_PRICE}'::uuid;
      delete from public.ai_price_components where price_version_id = '${LEGACY_PRICE}'::uuid;
      delete from public.ai_price_versions where id = '${LEGACY_PRICE}'::uuid;
      set local session_replication_role = origin;
      ${mutation}
      do $$ begin
        begin
          perform public.backfill_deepseek_legacy_pricing_v1();
          raise exception 'expected hostile replay rejection';
        exception when others then
          if sqlstate <> '23514' or sqlerrm not like ${`'%${expectedMessage}%'`} then raise; end if;
        end;
      end $$;
      rollback;
    `;
  }

  function ownerLegacyCatalogSnapshot() {
    const result = runOwnerSql(String.raw`
      copy (
        select pg_catalog.jsonb_build_object(
          'profileParent', (
            select pg_catalog.to_jsonb(parent)
            from public.ai_provider_profiles as parent
            where parent.id = '${LEGACY_PROFILE_PARENT}'::uuid
          ),
          'profileVersion', (
            select pg_catalog.to_jsonb(profile)
            from public.ai_provider_profile_versions as profile
            where profile.id = '${LEGACY_PROFILE}'::uuid
          ),
          'priceVersions', (
            select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(price) order by price.id)
            from public.ai_price_versions as price where price.id = '${LEGACY_PRICE}'::uuid
          ),
          'components', (
            select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(component) order by component.component)
            from public.ai_price_components as component where component.price_version_id = '${LEGACY_PRICE}'::uuid
          ),
          'sealIntents', (
            select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(intent) order by intent.price_version_id)
            from public.ai_price_component_seal_intents as intent where intent.price_version_id = '${LEGACY_PRICE}'::uuid
          )
        )::text
      ) to stdout;
    `);
    return JSON.parse(result.stdout.trim()) as unknown;
  }

  function startHeldOwnerTransaction(
    body: string,
    marker: string,
  ): BarrierSqlProcess {
    return startOwnerSqlWithBarrier(
      String.raw`
        \set ON_ERROR_STOP on
        \pset format unaligned
        \pset tuples_only on
        begin;
        set local statement_timeout = '10s';
        ${body}
        \echo ${marker}
      `,
      marker,
      "commit;",
    );
  }

  function startBlockingOwnerWriter(
    body: string,
    marker: string,
    applicationName: string,
  ): BarrierSqlProcess {
    return startOwnerSqlWithBarrier(
      String.raw`
        \set ON_ERROR_STOP on
        \pset format unaligned
        \pset tuples_only on
        begin;
        set local statement_timeout = '10s';
        set local application_name = '${applicationName}';
        \echo ${marker}
        ${body}
        commit;
      `,
      marker,
    );
  }

  async function waitForDatabaseLock(applicationName: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = runOwnerSql(String.raw`
        \pset format unaligned
        \pset tuples_only on
        select coalesce(wait_event_type, '') || ':' || coalesce(wait_event, '')
        from pg_catalog.pg_stat_activity
        where application_name = '${applicationName}';
      `).stdout;
      if (state.split(/\r?\n/u).some((line) => line.trim().startsWith("Lock:"))) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`contender ${applicationName} never reported a DB lock wait`);
  }

  it("writes the approved price evidence and the complete eligible-class truth table", async () => {
    const billed = await insertHistorical();
    const unbilled = await insertHistorical({
      status: "released",
      quota_charged: false,
      provider_billable: false,
      usage_complete: false,
      attempt_count: 0,
      provider_started_at: null,
      input_cached_tokens: 0,
      input_uncached_tokens: 0,
      output_tokens: 0,
    });
    const incomplete = await insertHistorical({
      status: "canceled",
      provider_billable: null,
      usage_complete: false,
      input_cached_tokens: null,
      input_uncached_tokens: 3,
      output_tokens: null,
    });

    runBackfill();

    const [price, billedRow, unbilledRow, incompleteRow] = await Promise.all([
      service
        .from("ai_price_versions")
        .select("*")
        .eq("id", LEGACY_PRICE)
        .single(),
      read(billed),
      read(unbilled),
      read(incomplete),
    ]);
    expect(price.error).toBeNull();
    expect(price.data).toMatchObject({
      id: LEGACY_PRICE,
      profile_version_id: LEGACY_PROFILE,
      pricing_lane: "legacy",
      version: 1,
      currency: "CNY",
      calculator_kind: "linear_token_v1",
      provider_effective_from: null,
      source_url:
        "https://web.archive.org/web/20260814163114id_/https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
      source_snapshot_sha256:
        "2bab2555968333b6e0a6e9f04c5427880f36fba491d95790c3f44261e00c7d07",
    });
    expect(new Date(price.data!.provider_effective_to).toISOString()).toBe(CUTOFF);
    expect(new Date(price.data!.valid_to).toISOString()).toBe(CUTOFF);
    expect(new Date(price.data!.source_checked_at).toISOString()).toBe(
      "2026-08-25T16:42:19.348Z",
    );

    expect(billedRow).toMatchObject({
      route_schema_version: "legacy_pricing_v1",
      profile_version_id: LEGACY_PROFILE,
      price_version_id: LEGACY_PRICE,
      usage_schema_version: "legacy_v1",
      cost_basis: "legacy_request_aggregate",
      input_total_tokens: 5,
      input_cache_read_tokens: 2,
      input_cache_write_tokens: null,
      input_standard_tokens: 3,
      cache_usage_reporting: "unavailable",
      billing_currency: "CNY",
      known_estimated_cost_nanos: 13040,
      estimated_cost_nanos: 13040,
      provider_reported_currency: null,
      provider_reported_cost_nanos: null,
      cost_reconciliation_status: "not_available",
    });
    expect(unbilledRow).toMatchObject({
      estimated_cost_nanos: 0,
      known_estimated_cost_nanos: 0,
      billing_currency: "CNY",
      cost_reconciliation_status: "not_available",
    });
    expect(incompleteRow).toMatchObject({
      estimated_cost_nanos: null,
      known_estimated_cost_nanos: null,
      billing_currency: "CNY",
      incomplete_fields: ["estimated_cost"],
      cost_reconciliation_status: "incomplete_usage",
    });
    for (const row of [billedRow, unbilledRow, incompleteRow]) {
      expect(row.config_generation).toBeNull();
      expect(row.routing_policy_version_id).toBeNull();
      expect(row.legal_bundle_version).toBeNull();
      expect(row.runtime_contract_id).toBeNull();
      expect(row.runtime_contract_sha256).toBeNull();
      expect(row.gateway_kind).toBeNull();
      expect(row.model_id).toBeNull();
      expect(row.wire_api_kind).toBeNull();
      expect(row.display_disclosure_key).toBeNull();
    }
  });

  it("preserves the cost and derived-input cross product without inventing missing usage", async () => {
    const billableUsageIncomplete = await insertHistorical({ usage_complete: false });
    const billablePartial = await insertHistorical({
      input_cached_tokens: null,
      input_uncached_tokens: 3,
      output_tokens: 5,
    });
    const unknownComplete = await insertHistorical({
      status: "canceled",
      provider_billable: null,
      usage_complete: true,
    });
    const unknownPartial = await insertHistorical({
      status: "canceled",
      provider_billable: null,
      input_cached_tokens: 2,
      input_uncached_tokens: null,
      output_tokens: null,
    });
    const unknownAbsent = await insertHistorical({
      status: "abandoned",
      provider_billable: null,
      input_cached_tokens: null,
      input_uncached_tokens: null,
      output_tokens: null,
    });
    const unbilledAbsent = await insertHistorical({
      status: "released", quota_charged: false, provider_billable: false,
      usage_complete: false, attempt_count: 0, provider_started_at: null,
      input_cached_tokens: null, input_uncached_tokens: null, output_tokens: null,
    });
    const unbilledZero = await insertHistorical({
      status: "released", quota_charged: false, provider_billable: false,
      usage_complete: false, attempt_count: 0, provider_started_at: null,
      input_cached_tokens: 0, input_uncached_tokens: 0, output_tokens: 0,
    });
    runBackfill();

    for (const reservationId of [
      billableUsageIncomplete, billablePartial, unknownComplete, unknownPartial,
      unknownAbsent,
    ]) {
      const row = await read(reservationId);
      expect(row.known_estimated_cost_nanos).toBeNull();
      expect(row.estimated_cost_nanos).toBeNull();
      expect(row.incomplete_fields).toEqual(["estimated_cost"]);
    }
    expect(await read(billableUsageIncomplete)).toMatchObject({
      input_total_tokens: 5, cache_usage_reporting: "unavailable",
    });
    expect(await read(billablePartial)).toMatchObject({
      input_total_tokens: null, input_cache_read_tokens: null,
      input_standard_tokens: 3, cache_usage_reporting: null,
    });
    expect(await read(unknownComplete)).toMatchObject({
      input_total_tokens: 5, cache_usage_reporting: "unavailable",
    });
    expect(await read(unknownPartial)).toMatchObject({
      input_total_tokens: null, input_cache_read_tokens: 2,
      input_standard_tokens: null, cache_usage_reporting: null,
    });
    expect(await read(unknownAbsent)).toMatchObject({
      input_total_tokens: null, input_cache_read_tokens: null,
      input_standard_tokens: null, cache_usage_reporting: null,
    });
    expect(await read(unbilledAbsent)).toMatchObject({
      known_estimated_cost_nanos: 0, estimated_cost_nanos: 0,
      input_total_tokens: null, cache_usage_reporting: null,
    });
    expect(await read(unbilledZero)).toMatchObject({
      known_estimated_cost_nanos: 0, estimated_cost_nanos: 0,
      input_total_tokens: 0, cache_usage_reporting: "unavailable",
    });
  });

  it("strictly excludes all three cutoff equalities, straddles, and non-exact model identity", async () => {
    const reservedEquality = await insertHistorical({ reserved_at: CUTOFF });
    const startedEquality = await insertHistorical({ provider_started_at: CUTOFF });
    const finalizedEquality = await insertHistorical({ finalized_at: CUTOFF });
    const straddle = await insertHistorical({ provider_started_at: CUTOFF });
    const differentModel = await insertHistorical({ model: "DeepSeek-V4-Flash-0731" });
    const nullModel = await insertHistorical({ model: null });

    runBackfill();

    for (const reservationId of [
      reservedEquality,
      startedEquality,
      finalizedEquality,
      straddle,
      differentModel,
      nullModel,
    ]) {
      expect((await read(reservationId)).route_schema_version).toBeNull();
    }
  });

  it("keeps current-route, partial/prebound, and child-attempt histories out of the cohort", async () => {
    // DB-007 itself rejects attempts and fabricated route facts on bare rows;
    // these direct probes make that boundary part of the DB-012 regression
    // suite rather than manufacturing a current policy or an attempt child.
    const bare = await insertHistorical();
    const partial = await service
      .from("ai_request_ledger")
      .update({ config_generation: 1 })
      .eq("reservation_id", bare);
    expect(partial.error?.code).toBe(CHECK_VIOLATION);

    const directLegacy = await service
      .from("ai_request_ledger")
      .update({
        route_schema_version: "legacy_pricing_v1",
        profile_version_id: LEGACY_PROFILE,
        price_version_id: LEGACY_PRICE,
        usage_schema_version: "legacy_v1",
        cost_basis: "legacy_request_aggregate",
      })
      .eq("reservation_id", bare);
    expect(directLegacy.error?.code).toBe(CHECK_VIOLATION);
    expect((await read(bare)).route_schema_version).toBeNull();
  });

  it("aborts the whole transaction for contradictory semantics and arithmetic overflow", async () => {
    const good = await insertHistorical();
    await insertHistorical({
      status: "released",
      quota_charged: false,
      provider_billable: false,
      attempt_count: 0,
      provider_started_at: null,
      input_cached_tokens: 1,
      input_uncached_tokens: 0,
      output_tokens: 0,
    });
    runBackfill({ expectFailure: true });
    expect((await read(good)).route_schema_version).toBeNull();

    // A negative token cannot be persisted under the inherited ledger CHECK;
    // a legal-but-overflowing input pair is therefore the executable corruption
    // seam DB-012 must catch before its bigint cast or any partial update.
    const overflowing = await insertHistorical({
      input_cached_tokens: "9223372036854775807",
      input_uncached_tokens: 1,
      output_tokens: 0,
    });
    runBackfill({ expectFailure: true });
    expect((await read(overflowing)).route_schema_version).toBeNull();
  });

  it("rejects hostile legacy price catalog replays atomically and restores the canonical catalog", async () => {
    const good = await insertHistorical();
    const original = await read(good);
    const baselineCatalog = ownerLegacyCatalogSnapshot();
    const header = String.raw`insert into public.ai_price_versions (id,profile_version_id,pricing_lane,version,currency,calculator_kind,valid_from,valid_to,provider_effective_from,provider_effective_to,source_url,source_checked_at,source_snapshot_sha256,parameters) values ('${LEGACY_PRICE}'::uuid,'${LEGACY_PROFILE}'::uuid,'legacy',1,'CNY','linear_token_v1','-infinity','2026-08-16T16:00:00Z',null,'2026-08-16T16:00:00Z','https://web.archive.org/web/20260814163114id_/https://api-docs.deepseek.com/zh-cn/quick_start/pricing/','2026-08-25T16:42:19.348Z','2bab2555968333b6e0a6e9f04c5427880f36fba491d95790c3f44261e00c7d07','{}');`;
    const cases = [
      [header.replace("'CNY'", "'USD'"), "legacy price projection mismatch"],
      [String.raw`insert into public.ai_price_versions (id,profile_version_id,pricing_lane,version,currency,calculator_kind,valid_from,valid_to,provider_effective_from,provider_effective_to,source_url,source_checked_at,source_snapshot_sha256,parameters) values ('${LEGACY_PRICE}'::uuid,'${LEGACY_PROFILE}'::uuid,'legacy',2,'CNY','linear_token_v1','2026-08-16T16:00:00Z',null,'2026-08-16T16:00:00Z',null,'https://example.invalid/a',now(),'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','{}'),('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4','${LEGACY_PROFILE}'::uuid,'legacy',1,'CNY','linear_token_v1','-infinity','2026-08-16T16:00:00Z',null,'2026-08-16T16:00:00Z','https://example.invalid/b',now(),'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','{}');`, "UUID or natural identity collision"],
      [header + String.raw`insert into public.ai_price_components (price_version_id,component,nanos_per_million) values ('${LEGACY_PRICE}'::uuid,'input_cache_read',20000000);`, "components or seal mismatch"],
      [header + String.raw`insert into public.ai_price_components (price_version_id,component,nanos_per_million) values ('${LEGACY_PRICE}'::uuid,'input_cache_read',20000000),('${LEGACY_PRICE}'::uuid,'input_standard',1000000000),('${LEGACY_PRICE}'::uuid,'input_cache_write',0),('${LEGACY_PRICE}'::uuid,'output',2000000000); select public.seal_ai_price_components_v1(array['${LEGACY_PRICE}'::uuid],clock_timestamp());`, "components or seal mismatch"],
    ] as const;
    for (const [mutation, message] of cases) {
      expect(runOwnerSql(hostileReplaySql(mutation, message)).status).toBe(0);
      expect(await read(good)).toEqual(original);
      expect(ownerLegacyCatalogSnapshot()).toEqual(baselineCatalog);
    }
  });

  it("is an exact replay and keeps the helper private to the database owner", async () => {
    const reservationId = await insertHistorical();
    runBackfill();
    const first = await read(reservationId);
    runBackfill();
    const second = await read(reservationId);
    expect(second).toEqual(first);

    const denied = await service.rpc("backfill_deepseek_legacy_pricing_v1");
    expect(denied.error).not.toBeNull();
    const helperDenied = await service.rpc("seal_ai_price_components_v1", {
      p_price_version_ids: [LEGACY_PRICE],
      p_sealed_at: BEFORE,
    });
    expect(helperDenied.error).not.toBeNull();
  });

  it("keeps a coherent non-legacy V2 route and its catalog byte-identical", async () => {
    const fixture = await createSyntheticCurrentRoute();
    try {
      const beforeRequest = await read(fixture.reservationId);
      const beforeSyntheticCatalog = ownerSyntheticCatalogSnapshot(fixture);
      const beforeLegacyCatalog = ownerLegacyCatalogSnapshot();

      runBackfill();

      expect(await read(fixture.reservationId)).toEqual(beforeRequest);
      expect(ownerSyntheticCatalogSnapshot(fixture)).toEqual(beforeSyntheticCatalog);
      expect(ownerLegacyCatalogSnapshot()).toEqual(beforeLegacyCatalog);
    } finally {
      cleanupSyntheticCurrentRoute(fixture);
    }
  });

  it("rejects an attempt-backed partial legacy footprint without any mutation", async () => {
    const fixture = await createSyntheticCurrentRoute();
    try {
      // First create a real, trigger-validated child against the coherent V2
      // parent. Only the parent corruption below uses the replica test seam.
      insertStartedAttempt(fixture);
      runOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        begin;
        set local session_replication_role = replica;
        update public.ai_request_ledger
        set state = 'finalized',
            status = 'succeeded',
            quota_charged = true,
            provider_billable = true,
            usage_complete = true,
            attempt_count = 1,
            model = 'deepseek-v4-flash',
            reserved_at = '${BEFORE}'::timestamptz,
            provider_started_at = '${BEFORE}'::timestamptz,
            finalized_at = '${BEFORE}'::timestamptz,
            input_cached_tokens = 2,
            input_uncached_tokens = 3,
            output_tokens = 5,
            route_schema_version = null,
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
            usage_schema_version = 'legacy_v1'
        where reservation_id = '${fixture.reservationId}'::uuid;
        set local session_replication_role = origin;
        commit;
      `);

      const beforeRequest = await read(fixture.reservationId);
      const beforeAttempts = await readAttempts(fixture.reservationId);
      const beforeSyntheticCatalog = ownerSyntheticCatalogSnapshot(fixture);
      const beforeLegacyCatalog = ownerLegacyCatalogSnapshot();
      expect(beforeAttempts).toHaveLength(1);
      expect(beforeAttempts[0]).toMatchObject({
        attempt_no: 1,
        status: "started",
        route_schema_version: "route_snapshot_v1",
      });

      const result = runOwnerSql(
        String.raw`\set VERBOSITY verbose
          select public.backfill_deepseek_legacy_pricing_v1();`,
        { expectFailure: true },
      );
      expect(result.stderr + result.stdout).toContain("23514");
      expect(result.stderr + result.stdout).toContain(
        "DB-012 legacy request footprint mismatch",
      );
      expect(await read(fixture.reservationId)).toEqual(beforeRequest);
      expect(await readAttempts(fixture.reservationId)).toEqual(beforeAttempts);
      expect(ownerSyntheticCatalogSnapshot(fixture)).toEqual(beforeSyntheticCatalog);
      expect(ownerLegacyCatalogSnapshot()).toEqual(beforeLegacyCatalog);
    } finally {
      cleanupSyntheticCurrentRoute(fixture);
    }
  });

  it("rejects service-role mutation of every representative legacy-bound fact", async () => {
    const reservationId = await insertHistorical();
    runBackfill();
    const original = await read(reservationId);
    for (const mutation of [
      { input_cached_tokens: 99 },
      { input_total_tokens: 99, cache_usage_reporting: "unavailable" },
      { estimated_cost_nanos: 1, known_estimated_cost_nanos: 1 },
      { status: "failed_upstream" },
    ]) {
      const result = await service
        .from("ai_request_ledger")
        .update(mutation)
        .eq("reservation_id", reservationId);
      expect(result.error?.code).toBe(CHECK_VIOLATION);
      expect(result.error?.message).toContain("legacy pricing ledger rows are immutable");
      expect(await read(reservationId)).toEqual(original);
    }
  });

  it("fails closed on route-null DB-012 markers without changing bare work", async () => {
    const good = await insertHistorical();
    const originalGood = await read(good);
    const baselineCatalog = ownerLegacyCatalogSnapshot();
    for (const marker of [
      { usage_schema_version: "legacy_v1" },
      { cost_basis: "legacy_request_aggregate" },
      { billing_currency: "CNY", estimated_cost_nanos: 0, known_estimated_cost_nanos: 0 },
    ]) {
      const marked = await insertHistorical(marker);
      const originalMarked = await read(marked);
      const result = runOwnerSql(
        "select public.backfill_deepseek_legacy_pricing_v1();",
        { expectFailure: true },
      );
      expect(result.stderr + result.stdout).toContain("legacy request projection mismatch");
      expect(await read(good)).toEqual(originalGood);
      expect(await read(marked)).toEqual(originalMarked);
      expect(ownerLegacyCatalogSnapshot()).toEqual(baselineCatalog);
      const cleanup = await service
        .from("ai_request_ledger")
        .delete()
        .eq("reservation_id", marked);
      expect(cleanup.error).toBeNull();
    }
  });

  it("rolls back hostile complete legacy projection and seal-intent defects", async () => {
    const good = await insertHistorical();
    runBackfill();
    const original = await read(good);
    const catalog = ownerLegacyCatalogSnapshot();
    const defects = [
      {
        mutation: "update public.ai_request_ledger set known_estimated_cost_nanos = 1, estimated_cost_nanos = 1 where route_schema_version = 'legacy_pricing_v1';",
        message: "legacy request projection mismatch",
      },
      {
        mutation: "update public.ai_request_ledger set cache_usage_reporting = null where route_schema_version = 'legacy_pricing_v1';",
        message: "legacy request projection mismatch",
      },
      {
        mutation: "update public.ai_request_ledger set incomplete_fields = array['estimated_cost'] where route_schema_version = 'legacy_pricing_v1';",
        message: "legacy request projection mismatch",
      },
      {
        mutation: "update public.ai_request_ledger set provider_reported_currency = 'CNY', provider_reported_cost_nanos = 1, cost_reconciliation_status = 'mismatch' where route_schema_version = 'legacy_pricing_v1';",
        message: "legacy request projection mismatch",
      },
      {
        mutation: `delete from public.ai_price_component_seal_intents where price_version_id = '${LEGACY_PRICE}'::uuid;`,
        message: "components or seal mismatch",
      },
      {
        mutation: `update public.ai_price_component_seal_intents set applied_at = null where price_version_id = '${LEGACY_PRICE}'::uuid;`,
        message: "components or seal mismatch",
      },
      {
        mutation: `update public.ai_price_component_seal_intents
          set price_version_id = (
            select price.id
            from public.ai_price_versions as price
            left join public.ai_price_component_seal_intents as existing
              on existing.price_version_id = price.id
            where price.id <> '${LEGACY_PRICE}'::uuid
              and existing.price_version_id is null
            order by price.id
            limit 1
          )
          where price_version_id = '${LEGACY_PRICE}'::uuid;`,
        message: "components or seal mismatch",
      },
    ] as const;
    for (const defect of defects) {
      const result = runOwnerSql(String.raw`
        begin;
        set local session_replication_role = replica;
        ${defect.mutation}
        set local session_replication_role = origin;
        do $probe$ begin
          begin
            perform public.backfill_deepseek_legacy_pricing_v1();
            raise exception 'expected DB-012 hostile replay rejection';
          exception when others then
            if sqlstate <> '23514'
               or sqlerrm not like ${`'%${defect.message}%'`} then
              raise;
            end if;
          end;
        end $probe$;
        rollback;
      `);
      expect(result.status).toBe(0);
      expect(await read(good)).toEqual(original);
      expect(ownerLegacyCatalogSnapshot()).toEqual(catalog);
    }
  });

  it("fails closed after committed canonical profile lifecycle, display, or identity drift", async () => {
    const reservationId = await insertHistorical();
    const originalRequest = await read(reservationId);
    const originalCatalog = ownerLegacyCatalogSnapshot();
    const staleCases = [
      {
        name: "parent display",
        write: String.raw`
          update public.ai_provider_profiles
          set display_name = 'Relay DB012 stale display'
          where id = '${LEGACY_PROFILE_PARENT}'::uuid;
        `,
        restore: String.raw`
          update public.ai_provider_profiles
          set display_name = 'DeepSeek V4 Flash'
          where id = '${LEGACY_PROFILE_PARENT}'::uuid;
        `,
      },
      {
        name: "version identity",
        write: String.raw`
          update public.ai_provider_profile_versions
          set model_snapshot = 'Relay-DB012-stale-model'
          where id = '${LEGACY_PROFILE}'::uuid;
        `,
        restore: String.raw`
          update public.ai_provider_profile_versions
          set model_snapshot = 'DeepSeek-V4-Flash-0731'
          where id = '${LEGACY_PROFILE}'::uuid;
        `,
      },
      {
        name: "version lifecycle",
        write: String.raw`
          update public.ai_provider_profile_versions
          set status = 'validated', validated_at = pg_catalog.clock_timestamp()
          where id = '${LEGACY_PROFILE}'::uuid;
        `,
        restore: String.raw`
          update public.ai_provider_profile_versions
          set status = 'draft', validated_at = null
          where id = '${LEGACY_PROFILE}'::uuid;
        `,
      },
    ] as const;

    for (const stale of staleCases) {
      const writerMarker = `db012-stale-writer-${crypto.randomUUID()}`;
      const backfillApplication = `db012-stale-backfill-${crypto.randomUUID()}`;
      const writer = startHeldOwnerTransaction(
        String.raw`
          set local session_replication_role = replica;
          ${stale.write}
        `,
        writerMarker,
      );
      let backfill: Promise<OwnerSqlResult> | undefined;
      try {
        await writer.ready;
        backfill = startOwnerSql(String.raw`
          \set ON_ERROR_STOP on
          \set VERBOSITY verbose
          begin;
          set local application_name = '${backfillApplication}';
          select public.backfill_deepseek_legacy_pricing_v1();
          commit;
        `);
        await waitForDatabaseLock(backfillApplication);

        // T1 commits only after T2 is demonstrably waiting for the canonical
        // parent/version row.  T2 must then re-read the committed mismatch
        // while it still holds the canonical lock and fail closed.
        writer.release();
        expect((await writer.result).status).toBe(0);
        const committedStaleCatalog = ownerLegacyCatalogSnapshot();
        const result = await backfill;
        expect(result.status).not.toBe(0);
        expect(result.stderr + result.stdout).toContain("23514");
        expect(result.stderr + result.stdout).toContain(
          "DB-012 DeepSeek profile identity mismatch",
        );
        // The writer has intentionally committed stale CFG facts.  This proves
        // the DB-012 attempt itself neither repairs them nor changes its row.
        expect(await read(reservationId)).toEqual(originalRequest);
        expect(ownerLegacyCatalogSnapshot()).toEqual(committedStaleCatalog);
      } finally {
        writer.release();
        await writer.result;
        if (backfill) {
          await backfill;
        }
        runOwnerSql(String.raw`
          begin;
          set local session_replication_role = replica;
          ${stale.restore}
          set local session_replication_role = origin;
          commit;
        `);
      }
      expect(ownerLegacyCatalogSnapshot()).toEqual(originalCatalog);
    }
  });

  it("holds the canonical profile locks while a price wait serializes a profile writer", async () => {
    const reservationId = await insertHistorical();
    const baselineCatalog = ownerLegacyCatalogSnapshot();
    const priceMarker = `db012-price-holder-${crypto.randomUUID()}`;
    const backfillApplication = `db012-backfill-${crypto.randomUUID()}`;
    const writerMarker = `db012-profile-writer-${crypto.randomUUID()}`;
    const writerApplication = `db012-profile-writer-${crypto.randomUUID()}`;
    const priceHolder = startHeldOwnerTransaction(
      String.raw`
        select id from public.ai_price_versions
        where id = '${LEGACY_PRICE}'::uuid
        for update;
      `,
      priceMarker,
    );
    let writer: BarrierSqlProcess | undefined;
    let backfill: Promise<OwnerSqlResult> | undefined;
    try {
      await priceHolder.ready;
      backfill = startOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        begin;
        set local application_name = '${backfillApplication}';
        select public.backfill_deepseek_legacy_pricing_v1();
        commit;
      `);
      await waitForDatabaseLock(backfillApplication);

      writer = startBlockingOwnerWriter(
        String.raw`
          update public.ai_provider_profiles
          set display_name = display_name
          where id = '${LEGACY_PROFILE_PARENT}'::uuid;
        `,
        writerMarker,
        writerApplication,
      );
      await writer.ready;
      await waitForDatabaseLock(writerApplication);

      // Both waits are observed through pg_stat_activity before the holder is
      // released; this is a DB-lock proof, not a timing/sleep heuristic.
      priceHolder.release();
      expect((await priceHolder.result).status).toBe(0);
      expect((await backfill).status).toBe(0);
      expect((await writer.result).status).toBe(0);
    } finally {
      priceHolder.release();
      if (writer) {
        writer.release();
        await writer.result;
      }
      await priceHolder.result;
      if (backfill) {
        await backfill;
      }
    }

    const completed = await read(reservationId);
    expect(completed).toMatchObject({
      route_schema_version: "legacy_pricing_v1",
      profile_version_id: LEGACY_PROFILE,
      price_version_id: LEGACY_PRICE,
    });
    expect(ownerLegacyCatalogSnapshot()).toEqual(baselineCatalog);
  });
});
