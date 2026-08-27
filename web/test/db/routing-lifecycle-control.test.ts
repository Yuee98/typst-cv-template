import { readFileSync } from "node:fs";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createServiceClient, RUN_DB_TESTS } from "./helpers";
import {
  authorSyntheticRuntimeContract,
  DEEPSEEK_LEGAL_MANIFEST_ID,
  INITIAL_LEGAL_BUNDLE_VERSION,
  runOwnerSql,
  sealPriceAsDatabaseOwner,
} from "./runtime-contract-fixtures";

const MIGRATION_URL = new URL(
  "../../../supabase/migrations/20260824004000_add_ai_provider_operator_lifecycle.sql",
  import.meta.url,
);

const EVIDENCE = {
  p_actor: "db013-control",
  p_reason: "DB-013 control-plane verification",
  p_rechecked_sha256: "b".repeat(64),
} as const;

interface Fixture {
  profileId: string;
  profileVersionId: string;
  priceVersionId: string;
  policyVersionId: string;
  runtimeContractId: string;
  runtimeContractSha256: string;
  runtimeTargetId: string;
}

function migrationSource(): string {
  return readFileSync(MIGRATION_URL, "utf8");
}

function ownerJson(sql: string): unknown {
  const result = runOwnerSql(`\\pset format unaligned
\\pset tuples_only on
${sql}`);
  expect(result.status).toBe(0);
  const line = result.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .findLast((value) => value.startsWith("{") || value.startsWith("["));
  if (!line) throw new Error(`expected owner JSON, got: ${result.stdout}`);
  return JSON.parse(line) as unknown;
}

describe("DB-013 lifecycle-control migration contract", () => {
  it("declares one explicit, non-overloaded audited operator surface", () => {
    const source = migrationSource();
    const wrappers = [
      "transition_ai_routing_policy_v2",
      "set_ai_routing_policy_pointer_v1",
      "clear_ai_routing_policy_pointer_v1",
      "retire_ai_provider_profile_version_v1",
      "retire_ai_provider_profile_v1",
      "close_ai_price_version_v1",
    ];

    for (const wrapper of wrappers) {
      expect(source).toMatch(new RegExp(`create function public\\.${wrapper}\\(`, "u"));
      expect(source).toMatch(
        new RegExp(
          `grant execute on function public\\.${wrapper}\\([\\s\\S]*?\\) to service_role;`,
          "u",
        ),
      );
    }
    expect(source).not.toMatch(/rules::text\s+like/iu);
    expect(source).not.toMatch(/^\s*execute\s+(?!function\b)/imu);
    expect(source).toContain("returning * into v_updated");
    expect(source).toContain("ai_routing_lifecycle_audit is append-only");
    expect(source).toContain("ai_routing_policy_transition_intents_status_check");
  });
});

describe.skipIf(!RUN_DB_TESTS)("DB-013 routing lifecycle control (real DB)", () => {
  let service: SupabaseClient;
  const fixtures: Fixture[] = [];

  beforeAll(() => {
    service = createServiceClient();
  });

  async function fixture(): Promise<Fixture> {
    const suffix = crypto.randomUUID();
    const profileId = crypto.randomUUID();
    const profileVersionId = crypto.randomUUID();
    const priceVersionId = crypto.randomUUID();
    const policyVersionId = crypto.randomUUID();
    const profileKey = `db013.control.${suffix}`;
    const runtime = authorSyntheticRuntimeContract({ profileKey });

    const result = runOwnerSql(`begin;
      insert into public.ai_provider_profiles (id, profile_key, display_name, gateway_kind, model_vendor)
      values ('${profileId}', '${profileKey}', 'DB-013 control', 'direct_deepseek', 'deepseek');
      insert into public.ai_provider_profile_versions (
        id, profile_id, version, adapter_kind, wire_api_kind,
        credential_alias, endpoint_alias, model_id, capability_contract_id,
        cache_policy_id, legal_manifest_id, display_disclosure_key, config, config_sha256
      ) values (
        '${profileVersionId}', '${profileId}', 1, 'deepseek_chat_v1',
        'chat_completions_v1', 'deepseek_api_key', 'deepseek_official',
        'deepseek-v4-flash', 'polish_v2', 'automatic_cache_v1',
        '${DEEPSEEK_LEGAL_MANIFEST_ID}', 'deepseek.official', '{}'::jsonb, '${"a".repeat(64)}'
      );
      update public.ai_provider_profile_versions set status = 'validated'
      where id = '${profileVersionId}'::uuid;
      insert into public.ai_price_versions (
        id, profile_version_id, version, pricing_lane, currency, calculator_kind,
        valid_from, source_url, source_checked_at, source_snapshot_sha256, parameters
      ) values (
        '${priceVersionId}', '${profileVersionId}', 1, 'default', 'CNY', 'linear_token_v1',
        pg_catalog.clock_timestamp() - interval '2 hours', 'https://example.com/${suffix}',
        pg_catalog.clock_timestamp() - interval '1 hour', '${"c".repeat(64)}', '{}'::jsonb
      );
      insert into public.ai_price_components (price_version_id, component, nanos_per_million)
      values ('${priceVersionId}', 'input_standard', 1), ('${priceVersionId}', 'input_cache_read', 1), ('${priceVersionId}', 'output', 1);
      insert into public.ai_routing_policy_versions (
        id, policy_key, version, status, timezone, rules, default_profile_version_id,
        legal_bundle_version, runtime_contract_id, runtime_contract_sha256, config_sha256
      ) values (
        '${policyVersionId}', 'db013.control.${suffix}', 1, 'draft', 'Asia/Shanghai',
        pg_catalog.jsonb_build_object(
          'schemaVersion', 'routing_rules_v1',
          'defaultRoute', pg_catalog.jsonb_build_object('profileVersionId', '${profileVersionId}', 'priceVersionId', '${priceVersionId}'),
          'windows', '[]'::jsonb
        ), '${profileVersionId}', '${INITIAL_LEGAL_BUNDLE_VERSION}',
        '${runtime.runtimeContractId}', '${runtime.runtimeContractSha256}', '${"d".repeat(64)}'
      );
      commit;`);
    expect(result.status).toBe(0);
    sealPriceAsDatabaseOwner(priceVersionId);
    const created = {
      profileId,
      profileVersionId,
      priceVersionId,
      policyVersionId,
      runtimeContractId: runtime.runtimeContractId,
      runtimeContractSha256: runtime.runtimeContractSha256,
      runtimeTargetId: runtime.runtimeTargetId,
    };
    fixtures.push(created);
    return created;
  }

  async function evidence(f: Fixture): Promise<Record<string, string>> {
    const root = ownerJson(`
      select pg_catalog.jsonb_build_object(
        'reviewedSourceCommitOid', root.reviewed_source_commit_oid,
        'recheckedAt', case
          when root.created_at >= price.source_checked_at then root.created_at
          else price.source_checked_at
        end
      )::text
      from public.ai_service_runtime_contract_versions as root
      join public.ai_price_versions as price on price.id = '${f.priceVersionId}'::uuid
      where root.runtime_contract_id = '${f.runtimeContractId}'
        and root.runtime_contract_sha256 = '${f.runtimeContractSha256}';
    `) as Record<string, unknown>;
    if (
      typeof root.reviewedSourceCommitOid !== "string" ||
      typeof root.recheckedAt !== "string"
    ) {
      throw new Error("DB-013 evidence fixture is missing its owner-only facts");
    }
    return {
      p_runtime_contract_id: f.runtimeContractId,
      p_runtime_contract_sha256: f.runtimeContractSha256,
      p_reviewed_source_commit_oid: root.reviewedSourceCommitOid,
      p_reviewed_source_sha256: f.runtimeContractSha256,
      p_rechecked_at: root.recheckedAt,
      ...EVIDENCE,
    };
  }

  function cleanup(f: Fixture): void {
    runOwnerSql(`begin;
      set local session_replication_role = replica;
      update public.ai_feature_config
      set active_routing_policy_version_id = null,
          routing_updated_by = null,
          routing_change_reason = null
      where id = true and active_routing_policy_version_id = '${f.policyVersionId}'::uuid;
      delete from public.ai_routing_lifecycle_audit where policy_version_id = '${f.policyVersionId}'::uuid or profile_id = '${f.profileId}'::uuid or profile_version_id = '${f.profileVersionId}'::uuid or price_version_id = '${f.priceVersionId}'::uuid;
      delete from public.ai_routing_policy_versions where id = '${f.policyVersionId}'::uuid;
      delete from public.ai_price_component_seal_intents where price_version_id = '${f.priceVersionId}'::uuid;
      delete from public.ai_price_components where price_version_id = '${f.priceVersionId}'::uuid;
      delete from public.ai_price_versions where id = '${f.priceVersionId}'::uuid;
      delete from public.ai_provider_profile_versions where id = '${f.profileVersionId}'::uuid;
      delete from public.ai_provider_profiles where id = '${f.profileId}'::uuid;
      delete from public.ai_service_runtime_contract_targets where runtime_contract_id = '${f.runtimeContractId}';
      delete from public.ai_service_runtime_contract_versions where runtime_contract_id = '${f.runtimeContractId}';
      delete from public.ai_service_runtime_target_versions where runtime_target_id = '${f.runtimeTargetId}';
      set local session_replication_role = origin;
      commit;`);
  }

  afterEach(() => {
    while (fixtures.length > 0) cleanup(fixtures.pop()!);
  });

  it("proves catalog signatures, ACL boundaries, private helper denial, and audit opacity", () => {
    const actual = ownerJson(`
      select pg_catalog.jsonb_build_object(
        'operatorFunctions', (select count(*) from pg_catalog.pg_proc as p join pg_catalog.pg_namespace as n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('transition_ai_routing_policy_v2','set_ai_routing_policy_pointer_v1','clear_ai_routing_policy_pointer_v1','retire_ai_provider_profile_version_v1','retire_ai_provider_profile_v1','close_ai_price_version_v1') and p.prosecdef and p.proconfig = array['search_path=""']),
        'operatorIdentities', (select pg_catalog.jsonb_agg(pg_catalog.pg_get_function_identity_arguments(p.oid) order by p.proname) from pg_catalog.pg_proc as p join pg_catalog.pg_namespace as n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('transition_ai_routing_policy_v2','set_ai_routing_policy_pointer_v1','clear_ai_routing_policy_pointer_v1','retire_ai_provider_profile_version_v1','retire_ai_provider_profile_v1','close_ai_price_version_v1')),
        'serviceAuditSelect', pg_catalog.has_table_privilege('service_role', 'public.ai_routing_lifecycle_audit', 'select'),
        'servicePolicyUpdate', pg_catalog.has_table_privilege('service_role', 'public.ai_routing_policy_versions', 'update'),
        'serviceProfileUpdate', pg_catalog.has_table_privilege('service_role', 'public.ai_provider_profile_versions', 'update'),
        'servicePriceUpdate', pg_catalog.has_table_privilege('service_role', 'public.ai_price_versions', 'update'),
        'anonPolicyUpdate', pg_catalog.has_table_privilege('anon', 'public.ai_routing_policy_versions', 'update'),
        'authenticatedPolicyUpdate', pg_catalog.has_table_privilege('authenticated', 'public.ai_routing_policy_versions', 'update'),
        'servicePointerUpdate', pg_catalog.has_column_privilege('service_role', 'public.ai_feature_config', 'active_routing_policy_version_id', 'update'),
        'serviceKillSwitchUpdate', pg_catalog.has_column_privilege('service_role', 'public.ai_feature_config', 'ai_polish_enabled', 'update'),
        'serviceHotColumns', (select pg_catalog.jsonb_object_agg(column_name, pg_catalog.has_column_privilege('service_role', 'public.ai_feature_config', column_name, 'update')) from information_schema.columns where table_schema='public' and table_name='ai_feature_config' and column_name in ('ai_polish_enabled','global_daily_limit','enabled_user_allowlist','active_routing_policy_version_id','config_generation','routing_updated_at','routing_updated_by','routing_change_reason','updated_at','id')),
        'serviceHelperExecute', pg_catalog.has_function_privilege('service_role', 'public.assert_ai_routing_lifecycle_evidence_v1(text,text,text,text,text,text,timestamptz,text,timestamptz)'::regprocedure, 'execute')
      )::text;
    `) as Record<string, unknown>;
    expect(actual).toMatchObject({
      operatorFunctions: 6,
      serviceAuditSelect: false,
      servicePolicyUpdate: false,
      serviceProfileUpdate: false,
      servicePriceUpdate: false,
      anonPolicyUpdate: false,
      authenticatedPolicyUpdate: false,
      servicePointerUpdate: false,
      serviceKillSwitchUpdate: true,
      serviceHelperExecute: false,
    });
    expect(actual.serviceHotColumns).toEqual({
      ai_polish_enabled: true,
      global_daily_limit: true,
      enabled_user_allowlist: true,
      active_routing_policy_version_id: false,
      config_generation: false,
      routing_updated_at: false,
      routing_updated_by: false,
      routing_change_reason: false,
      updated_at: false,
      id: false,
    });
    expect(actual.operatorIdentities).toEqual(
      expect.arrayContaining([
        expect.stringContaining("p_policy_version_id uuid, p_to_status text"),
        expect.stringContaining("p_expected_policy_version_id uuid"),
        expect.stringContaining("p_profile_version_id uuid"),
        expect.stringContaining("p_profile_id uuid"),
        expect.stringContaining("p_price_version_id uuid, p_valid_to timestamp with time zone, p_successor_price_version_id uuid"),
      ]),
    );
  });

  it("writes exactly one owner-readable audit row for each valid policy and pointer operation", async () => {
    const f = await fixture();
    const ev = await evidence(f);
    expect((await service.rpc("transition_ai_routing_policy_v2", { p_policy_version_id: f.policyVersionId, p_to_status: "validated", ...ev })).error).toBeNull();
    runOwnerSql(`update public.ai_provider_profile_versions set status='canary' where id='${f.profileVersionId}'::uuid;`);
    expect((await service.rpc("transition_ai_routing_policy_v2", { p_policy_version_id: f.policyVersionId, p_to_status: "canary", ...ev })).error).toBeNull();
    expect((await service.rpc("set_ai_routing_policy_pointer_v1", { p_policy_version_id: f.policyVersionId, ...ev, p_reason: `DB-013 pointer set ${crypto.randomUUID()}` })).error).toBeNull();
    expect((await service.rpc("clear_ai_routing_policy_pointer_v1", { p_expected_policy_version_id: f.policyVersionId, ...ev, p_reason: `DB-013 pointer clear ${crypto.randomUUID()}` })).error).toBeNull();

    const audit = ownerJson(`select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('operation', operation, 'old', old_config_generation, 'new', new_config_generation, 'runtime', runtime_contract_sha256, 'actor', actor) order by occurred_at) from public.ai_routing_lifecycle_audit where policy_version_id='${f.policyVersionId}'::uuid;`) as unknown[];
    expect(audit).toHaveLength(4);
    expect(audit).toContainEqual(expect.objectContaining({ operation: "pointer_set", actor: EVIDENCE.p_actor }));
    expect(audit).toContainEqual(expect.objectContaining({ operation: "pointer_clear" }));
  });

  it("rejects malformed evidence and leaves both state and audit unchanged", async () => {
    const f = await fixture();
    const ev = await evidence(f);
    const rejected = await service.rpc("transition_ai_routing_policy_v2", {
      p_policy_version_id: f.policyVersionId,
      p_to_status: "validated",
      ...ev,
      p_rechecked_sha256: "NOT-A-HASH",
    });
    expect(rejected.error?.code).toMatch(/23514|P0001/u);
    const actual = ownerJson(`select pg_catalog.jsonb_build_object('status', (select status from public.ai_routing_policy_versions where id='${f.policyVersionId}'::uuid), 'auditCount', (select count(*) from public.ai_routing_lifecycle_audit where policy_version_id='${f.policyVersionId}'::uuid))::text;`);
    expect(actual).toEqual({ status: "draft", auditCount: 0 });
  });

  it("enforces terminal retirement and close preconditions without mutating the kill switch", async () => {
    const f = await fixture();
    const ev = await evidence(f);
    const before = await service.from("ai_feature_config").select("ai_polish_enabled").eq("id", true).single();
    expect((await service.rpc("retire_ai_provider_profile_version_v1", { p_profile_version_id: f.profileVersionId, ...ev })).error?.code).toMatch(/23514|P0001/u);
    expect((await service.rpc("close_ai_price_version_v1", { p_price_version_id: f.priceVersionId, p_valid_to: new Date().toISOString(), p_successor_price_version_id: null, ...ev })).error?.code).toMatch(/23514|P0001/u);
    const after = await service.from("ai_feature_config").select("ai_polish_enabled").eq("id", true).single();
    expect(after.data?.ai_polish_enabled).toBe(before.data?.ai_polish_enabled);
  });

  it("admits every legal edge, consumes its intent, and rejects no-op, illegal, and terminal edges", async () => {
    const cases = [
      { prelude: [] as string[], from: "draft", to: "validated" },
      { prelude: ["validated"], from: "validated", to: "canary" },
      { prelude: ["validated"], from: "validated", to: "active" },
      { prelude: ["validated", "canary"], from: "canary", to: "active" },
      { prelude: [] as string[], from: "draft", to: "retired" },
      { prelude: ["validated"], from: "validated", to: "retired" },
      { prelude: ["validated", "canary"], from: "canary", to: "retired" },
      { prelude: ["validated", "canary", "active"], from: "active", to: "retired" },
    ];
    for (const item of cases) {
      const f = await fixture();
      const ev = await evidence(f);
      const requiredProfileStatus =
        item.from === "active" || item.to === "active"
          ? "active"
          : item.from === "canary" || item.to === "canary"
            ? "canary"
            : "validated";
      if (requiredProfileStatus === "canary") {
        runOwnerSql(`update public.ai_provider_profile_versions set status='canary' where id='${f.profileVersionId}'::uuid;`);
      }
      if (requiredProfileStatus === "active") {
        runOwnerSql(`update public.ai_provider_profile_versions set status='active' where id='${f.profileVersionId}'::uuid;`);
      }
      for (const status of item.prelude) {
        expect((await service.rpc("transition_ai_routing_policy_v2", { p_policy_version_id: f.policyVersionId, p_to_status: status, ...ev })).error).toBeNull();
      }
      const transition = await service.rpc("transition_ai_routing_policy_v2", { p_policy_version_id: f.policyVersionId, p_to_status: item.to, ...ev });
      expect(transition.error, `${item.from} -> ${item.to}`).toBeNull();
      const state = ownerJson(`select pg_catalog.jsonb_build_object('status',(select status from public.ai_routing_policy_versions where id='${f.policyVersionId}'::uuid),'intents',(select count(*) from public.ai_routing_policy_transition_intents where policy_version_id='${f.policyVersionId}'::uuid))::text;`);
      expect(state).toEqual({ status: item.to, intents: 0 });
      if (item.to === "retired") {
        expect((await service.rpc("transition_ai_routing_policy_v2", { p_policy_version_id: f.policyVersionId, p_to_status: "active", ...ev })).error?.code).toMatch(/23514|P0001/u);
      } else {
        expect((await service.rpc("transition_ai_routing_policy_v2", { p_policy_version_id: f.policyVersionId, p_to_status: item.to, ...ev })).error?.code).toMatch(/23514|P0001/u);
      }
    }
  });
});
