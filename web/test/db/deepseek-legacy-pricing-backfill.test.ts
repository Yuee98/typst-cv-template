import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createServiceClient,
  createTestUser,
  deleteTestUser,
  RUN_DB_TESTS,
  type TestUser,
} from "./helpers";
import { runOwnerSql, startOwnerSql } from "./runtime-contract-fixtures";

const CUTOFF = "2026-08-16T16:00:00.000Z";
const BEFORE = "2026-08-16T15:59:59.000Z";
const LEGACY_PROFILE = "11111111-1111-4111-8111-111111111111";
const LEGACY_PRICE = "11111111-1111-4111-8111-111111111114";
const CHECK_VIOLATION = "23514";

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
        mutation: `update public.ai_price_component_seal_intents set price_version_id = (select id from public.ai_price_versions where id <> '${LEGACY_PRICE}'::uuid order by id limit 1) where price_version_id = '${LEGACY_PRICE}'::uuid;`,
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

  it("rolls back atomically when the canonical price/request lock order cannot proceed", async () => {
    const reservationId = await insertHistorical();
    const holder = startOwnerSql(String.raw`
      begin;
      select id from public.ai_price_versions
      where id = '${LEGACY_PRICE}'::uuid for update;
      select pg_catalog.pg_sleep(1);
      rollback;
    `);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const blocked = runBackfill({ expectFailure: true });
    expect(blocked.stderr + blocked.stdout).toMatch(/lock timeout/i);
    expect((await holder).status).toBe(0);
    expect((await read(reservationId)).route_schema_version).toBeNull();
  });
});
