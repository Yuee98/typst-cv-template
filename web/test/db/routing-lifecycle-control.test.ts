import { readFileSync } from "node:fs";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createServiceClient, RUN_DB_TESTS } from "./helpers";
import {
  authorSyntheticRuntimeContract,
  DEEPSEEK_LEGAL_MANIFEST_ID,
  INITIAL_LEGAL_BUNDLE_VERSION,
  readLifecycleEvidenceRoot,
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
const CHECK_VIOLATION = "23514";
const EVIDENCE_RETRY_DELAY_MS = 200;
const EVIDENCE_RETRY_TIMEOUT_MS = 10_000;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type LifecycleRpcName =
  | "clear_ai_routing_policy_pointer_v1"
  | "close_ai_price_version_v1"
  | "create_ai_routing_policy_version_v1"
  | "retire_ai_provider_profile_v1"
  | "retire_ai_provider_profile_version_v1"
  | "seal_ai_price_for_activation_v1"
  | "set_ai_routing_policy_pointer_v1"
  | "transition_ai_provider_profile_version_v1"
  | "transition_ai_routing_policy_v2";

function isLifecycleEvidenceFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === CHECK_VIOLATION &&
    candidate.message === "invalid routing lifecycle evidence"
  );
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

interface Fixture {
  profileId: string;
  profileVersionId: string;
  priceVersionId: string;
  policyVersionId: string;
  runtimeContractId: string;
  runtimeContractSha256: string;
  runtimeTargetId: string;
  sourceUrl: string;
  createdPolicyIds: string[];
  additionalRuntimeContractIds: string[];
  additionalRuntimeTargetIds: string[];
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
      "seal_ai_price_for_activation_v1",
      "transition_ai_provider_profile_version_v1",
      "create_ai_routing_policy_version_v1",
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

  async function fixture(
    options: {
      malformedRules?: boolean;
      profileStatus?: "draft" | "validated";
      sealPrice?: boolean;
      providerEffectiveFrom?: string | null;
    } = {},
  ): Promise<Fixture> {
    const suffix = crypto.randomUUID();
    const profileId = crypto.randomUUID();
    const profileVersionId = crypto.randomUUID();
    const priceVersionId = crypto.randomUUID();
    const policyVersionId = crypto.randomUUID();
    const profileKey = `db013.control.${suffix}`;
    const sourceUrl = `https://example.com/${suffix}`;
    const providerEffectiveFromSql = options.providerEffectiveFrom
      ? `'${options.providerEffectiveFrom}'::timestamptz`
      : "null";
    const runtime = authorSyntheticRuntimeContract({ profileKey });

    const rulesSql = options.malformedRules
      ? "pg_catalog.jsonb_build_object('schemaVersion', 'routing_rules_v1', 'windows', '[]'::jsonb)"
      : `pg_catalog.jsonb_build_object(
          'schemaVersion', 'routing_rules_v1',
          'defaultRoute', pg_catalog.jsonb_build_object('profileVersionId', '${profileVersionId}', 'priceVersionId', '${priceVersionId}'),
          'windows', '[]'::jsonb
        )`;
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
      ${options.profileStatus === "draft" ? "" : `update public.ai_provider_profile_versions set status = 'validated'
      where id = '${profileVersionId}'::uuid;`}
      insert into public.ai_price_versions (
        id, profile_version_id, version, pricing_lane, currency, calculator_kind,
        valid_from, provider_effective_from, source_url, source_checked_at, source_snapshot_sha256, parameters
      ) values (
        '${priceVersionId}', '${profileVersionId}', 1, 'default', 'CNY', 'linear_token_v1',
        pg_catalog.clock_timestamp() - interval '2 hours', ${providerEffectiveFromSql}, '${sourceUrl}',
        pg_catalog.clock_timestamp() - interval '1 hour', '${"c".repeat(64)}', '{}'::jsonb
      );
      insert into public.ai_price_components (price_version_id, component, nanos_per_million)
      values ('${priceVersionId}', 'input_standard', 1), ('${priceVersionId}', 'input_cache_read', 1), ('${priceVersionId}', 'output', 1);
      insert into public.ai_routing_policy_versions (
        id, policy_key, version, status, timezone, rules, default_profile_version_id,
        legal_bundle_version, runtime_contract_id, runtime_contract_sha256, config_sha256
      ) values (
        '${policyVersionId}', 'db013.control.${suffix}', 1, 'draft', 'Asia/Shanghai',
        ${rulesSql}, '${profileVersionId}', '${INITIAL_LEGAL_BUNDLE_VERSION}',
        '${runtime.runtimeContractId}', '${runtime.runtimeContractSha256}', '${"d".repeat(64)}'
      );
      commit;`);
    expect(result.status).toBe(0);
    if (options.sealPrice !== false) sealPriceAsDatabaseOwner(priceVersionId);
    const created = {
      profileId,
      profileVersionId,
      priceVersionId,
      policyVersionId,
      runtimeContractId: runtime.runtimeContractId,
      runtimeContractSha256: runtime.runtimeContractSha256,
      runtimeTargetId: runtime.runtimeTargetId,
      sourceUrl,
      createdPolicyIds: [],
      additionalRuntimeContractIds: [],
      additionalRuntimeTargetIds: [],
    };
    fixtures.push(created);
    return created;
  }

  async function evidence(f: Fixture): Promise<Record<string, string>> {
    const root = readLifecycleEvidenceRoot({
      runtimeContractId: f.runtimeContractId,
      runtimeContractSha256: f.runtimeContractSha256,
      priceVersionIds: [f.priceVersionId],
    });
    return {
      p_runtime_contract_id: f.runtimeContractId,
      p_runtime_contract_sha256: f.runtimeContractSha256,
      p_reviewed_source_commit_oid: root.reviewedSourceCommitOid,
      p_reviewed_source_sha256: f.runtimeContractSha256,
      p_rechecked_at: root.recheckedAt,
      ...EVIDENCE,
    };
  }

  async function lifecycleRpc(
    name: LifecycleRpcName,
    args: Record<string, unknown>,
  ) {
    const deadline = Date.now() + EVIDENCE_RETRY_TIMEOUT_MS;
    let result = await service.rpc(name, args);
    // The exact evidence guard runs before lifecycle DML/audit. Retrying only
    // that transient cross-session clock failure cannot duplicate an operation.
    while (isLifecycleEvidenceFailure(result.error) && Date.now() < deadline) {
      await sleep(EVIDENCE_RETRY_DELAY_MS);
      result = await service.rpc(name, args);
    }
    return result;
  }

  function cleanup(f: Fixture): void {
    const policyIds = [f.policyVersionId, ...f.createdPolicyIds]
      .map((id) => `'${id}'::uuid`)
      .join(", ");
    const runtimeContractIds = [
      f.runtimeContractId,
      ...f.additionalRuntimeContractIds,
    ]
      .map((id) => `'${id}'`)
      .join(", ");
    const runtimeTargetIds = [f.runtimeTargetId, ...f.additionalRuntimeTargetIds]
      .map((id) => `'${id}'`)
      .join(", ");
    runOwnerSql(`begin;
      set local session_replication_role = replica;
      update public.ai_feature_config
      set active_routing_policy_version_id = null,
          routing_updated_by = null,
          routing_change_reason = null
      where id = true and active_routing_policy_version_id = '${f.policyVersionId}'::uuid;
      delete from public.ai_routing_lifecycle_audit where policy_version_id = any(array[${policyIds}]) or profile_id = '${f.profileId}'::uuid or profile_version_id = '${f.profileVersionId}'::uuid or price_version_id = '${f.priceVersionId}'::uuid;
      delete from public.ai_routing_policy_versions where id = any(array[${policyIds}]);
      delete from public.ai_price_component_seal_intents where price_version_id = '${f.priceVersionId}'::uuid;
      delete from public.ai_price_components where price_version_id = '${f.priceVersionId}'::uuid;
      delete from public.ai_price_versions where id = '${f.priceVersionId}'::uuid;
      delete from public.ai_provider_profile_versions where id = '${f.profileVersionId}'::uuid;
      delete from public.ai_provider_profiles where id = '${f.profileId}'::uuid;
      delete from public.ai_service_runtime_contract_targets where runtime_contract_id = any(array[${runtimeContractIds}]);
      delete from public.ai_service_runtime_contract_versions where runtime_contract_id = any(array[${runtimeContractIds}]);
      delete from public.ai_service_runtime_target_versions where runtime_target_id = any(array[${runtimeTargetIds}]);
      set local session_replication_role = origin;
      commit;`);
  }

  afterEach(() => {
    while (fixtures.length > 0) cleanup(fixtures.pop()!);
  });

  it("proves catalog signatures, ACL boundaries, private helper denial, and audit opacity", () => {
    const actual = ownerJson(`
      select pg_catalog.jsonb_build_object(
        'operatorFunctionCount', (
          select count(*)
          from pg_catalog.pg_proc as p
          join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in (
              'transition_ai_routing_policy_v2',
              'set_ai_routing_policy_pointer_v1',
              'clear_ai_routing_policy_pointer_v1',
              'retire_ai_provider_profile_version_v1',
              'retire_ai_provider_profile_v1',
              'close_ai_price_version_v1',
              'seal_ai_price_for_activation_v1',
              'transition_ai_provider_profile_version_v1',
              'create_ai_routing_policy_version_v1'
            )
        ),
        'securedOperatorFunctionCount', (
          select count(*)
          from pg_catalog.pg_proc as p
          join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in (
              'transition_ai_routing_policy_v2',
              'set_ai_routing_policy_pointer_v1',
              'clear_ai_routing_policy_pointer_v1',
              'retire_ai_provider_profile_version_v1',
              'retire_ai_provider_profile_v1',
              'close_ai_price_version_v1',
              'seal_ai_price_for_activation_v1',
              'transition_ai_provider_profile_version_v1',
              'create_ai_routing_policy_version_v1'
            )
            and p.prosecdef
            and p.proconfig = array['search_path=""']
        ),
        'operatorIdentities', (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'name', p.proname,
              'arguments', pg_catalog.pg_get_function_identity_arguments(p.oid)
            )
            order by p.proname
          )
          from pg_catalog.pg_proc as p
          join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in (
              'transition_ai_routing_policy_v2',
              'set_ai_routing_policy_pointer_v1',
              'clear_ai_routing_policy_pointer_v1',
              'retire_ai_provider_profile_version_v1',
              'retire_ai_provider_profile_v1',
              'close_ai_price_version_v1',
              'seal_ai_price_for_activation_v1',
              'transition_ai_provider_profile_version_v1',
              'create_ai_routing_policy_version_v1'
            )
        ),
        'routeSnapshotGuard', (select pg_catalog.jsonb_build_object('prosecdef', p.prosecdef, 'proconfig', p.proconfig) from pg_catalog.pg_proc as p join pg_catalog.pg_namespace as n on n.oid=p.pronamespace where n.nspname='public' and p.proname='guard_ai_request_route_snapshot'),
        'serviceAuditSelect', pg_catalog.has_table_privilege('service_role', 'public.ai_routing_lifecycle_audit', 'select'),
        'servicePolicyUpdate', pg_catalog.has_table_privilege('service_role', 'public.ai_routing_policy_versions', 'update'),
        'serviceProviderUpdate', pg_catalog.has_table_privilege('service_role', 'public.ai_provider_profiles', 'update'),
        'serviceProfileUpdate', pg_catalog.has_table_privilege('service_role', 'public.ai_provider_profile_versions', 'update'),
        'servicePriceUpdate', pg_catalog.has_table_privilege('service_role', 'public.ai_price_versions', 'update'),
        'serviceLegalCatalogDml', (
          select pg_catalog.jsonb_object_agg(
            legal_table.table_name,
            pg_catalog.jsonb_build_object(
              'insert', pg_catalog.has_table_privilege('service_role', legal_table.table_name, 'insert'),
              'update', pg_catalog.has_table_privilege('service_role', legal_table.table_name, 'update'),
              'delete', pg_catalog.has_table_privilege('service_role', legal_table.table_name, 'delete')
            )
          )
          from (
            values
              ('public.ai_legal_bundle_versions'),
              ('public.ai_legal_bundle_manifests'),
              ('public.ai_legal_manifest_versions')
          ) as legal_table(table_name)
        ),
        'serviceCatalogUpdateColumns', (
          select pg_catalog.jsonb_object_agg(catalog_table.table_name, catalog_table.granted_columns)
          from (
            select
              catalog_column.table_name,
              coalesce(
                pg_catalog.jsonb_agg(
                  catalog_column.column_name order by catalog_column.ordinal_position
                )
                  filter (
                    where pg_catalog.has_column_privilege(
                      'service_role',
                      'public.' || catalog_column.table_name,
                      catalog_column.column_name,
                      'update'
                    )
                  ),
                '[]'::jsonb
              ) as granted_columns
            from information_schema.columns as catalog_column
            where catalog_column.table_schema = 'public'
              and catalog_column.table_name in (
                'ai_provider_profile_versions',
                'ai_price_versions'
              )
            group by catalog_column.table_name
          ) as catalog_table
        ),
        'anonPolicyUpdate', pg_catalog.has_table_privilege('anon', 'public.ai_routing_policy_versions', 'update'),
        'authenticatedPolicyUpdate', pg_catalog.has_table_privilege('authenticated', 'public.ai_routing_policy_versions', 'update'),
        'servicePointerUpdate', pg_catalog.has_column_privilege('service_role', 'public.ai_feature_config', 'active_routing_policy_version_id', 'update'),
        'serviceKillSwitchUpdate', pg_catalog.has_column_privilege('service_role', 'public.ai_feature_config', 'ai_polish_enabled', 'update'),
        'serviceHotColumns', (select pg_catalog.jsonb_object_agg(column_name, pg_catalog.has_column_privilege('service_role', 'public.ai_feature_config', column_name, 'update')) from information_schema.columns where table_schema='public' and table_name='ai_feature_config' and column_name in ('ai_polish_enabled','global_daily_limit','enabled_user_allowlist','active_routing_policy_version_id','config_generation','routing_updated_at','routing_updated_by','routing_change_reason','updated_at','id')),
        'servicePrivateExecute', pg_catalog.jsonb_build_object(
          'guard_ai_routing_lifecycle_audit', pg_catalog.has_function_privilege('service_role', 'public.guard_ai_routing_lifecycle_audit()'::regprocedure, 'execute'),
          'assert_ai_routing_lifecycle_evidence_v1', pg_catalog.has_function_privilege('service_role', 'public.assert_ai_routing_lifecycle_evidence_v1(text,text,text,text,text,text,timestamptz,text,timestamptz)'::regprocedure, 'execute'),
          'assert_ai_routing_lifecycle_no_policy_reference_v1', pg_catalog.has_function_privilege('service_role', 'public.assert_ai_routing_lifecycle_no_policy_reference_v1(text,uuid,timestamptz)'::regprocedure, 'execute'),
          'assert_ai_routing_lifecycle_selected_price_evidence_v1', pg_catalog.has_function_privilege('service_role', 'public.assert_ai_routing_lifecycle_selected_price_evidence_v1(public.ai_routing_policy_versions,timestamptz)'::regprocedure, 'execute'),
          'lock_ai_routing_lifecycle_profile_prices_v1', pg_catalog.has_function_privilege('service_role', 'public.lock_ai_routing_lifecycle_profile_prices_v1(uuid,uuid,timestamptz)'::regprocedure, 'execute'),
          'assert_ai_routing_lifecycle_runtime_profile_coverage_v1', pg_catalog.has_function_privilege('service_role', 'public.assert_ai_routing_lifecycle_runtime_profile_coverage_v1(text,text,uuid,uuid)'::regprocedure, 'execute'),
          'insert_ai_routing_lifecycle_audit_v1', pg_catalog.has_function_privilege('service_role', 'public.insert_ai_routing_lifecycle_audit_v1(text,uuid,uuid,uuid,uuid,text,text,uuid,uuid,bigint,bigint,timestamptz,timestamptz,timestamptz,timestamptz,text,text,text,text,text,text,timestamptz,text,timestamptz)'::regprocedure, 'execute')
        )
      )::text;
    `) as Record<string, unknown>;
    expect(actual).toMatchObject({
      operatorFunctionCount: 9,
      securedOperatorFunctionCount: 9,
      routeSnapshotGuard: {
        prosecdef: false,
        proconfig: ['search_path=""'],
      },
      serviceAuditSelect: false,
      servicePolicyUpdate: false,
      serviceProviderUpdate: false,
      serviceProfileUpdate: false,
      servicePriceUpdate: false,
      anonPolicyUpdate: false,
      authenticatedPolicyUpdate: false,
      servicePointerUpdate: false,
      serviceKillSwitchUpdate: true,
    });
    expect(actual.serviceLegalCatalogDml).toEqual({
      "public.ai_legal_bundle_versions": {
        insert: false,
        update: false,
        delete: false,
      },
      "public.ai_legal_bundle_manifests": {
        insert: false,
        update: false,
        delete: false,
      },
      "public.ai_legal_manifest_versions": {
        insert: false,
        update: false,
        delete: false,
      },
    });
    expect(actual.serviceCatalogUpdateColumns).toEqual({
      ai_provider_profile_versions: ["display_disclosure_key"],
      ai_price_versions: ["components_sealed_at"],
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
    expect(actual.operatorIdentities).toEqual([
      {
        name: "clear_ai_routing_policy_pointer_v1",
        arguments:
          "p_expected_policy_version_id uuid, p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
      },
      {
        name: "close_ai_price_version_v1",
        arguments:
          "p_price_version_id uuid, p_valid_to timestamp with time zone, p_successor_price_version_id uuid, p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
      },
      {
        name: "create_ai_routing_policy_version_v1",
        arguments:
          "p_policy_version_id uuid, p_policy_key text, p_version integer, p_timezone text, p_rules jsonb, p_default_profile_version_id uuid, p_legal_bundle_version text, p_config_sha256 text, p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
      },
      {
        name: "retire_ai_provider_profile_v1",
        arguments:
          "p_profile_id uuid, p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
      },
      {
        name: "retire_ai_provider_profile_version_v1",
        arguments:
          "p_profile_version_id uuid, p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
      },
      {
        name: "seal_ai_price_for_activation_v1",
        arguments:
          "p_price_version_id uuid, p_rechecked_source_url text, p_rechecked_currency text, p_rechecked_calculator_kind text, p_rechecked_provider_effective_from timestamp with time zone, p_rechecked_provider_effective_to timestamp with time zone, p_rechecked_parameters jsonb, p_rechecked_components jsonb, p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
      },
      {
        name: "set_ai_routing_policy_pointer_v1",
        arguments:
          "p_policy_version_id uuid, p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
      },
      {
        name: "transition_ai_provider_profile_version_v1",
        arguments:
          "p_profile_version_id uuid, p_to_status text, p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
      },
      {
        name: "transition_ai_routing_policy_v2",
        arguments:
          "p_policy_version_id uuid, p_to_status text, p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
      },
    ]);
    expect(actual.servicePrivateExecute).toEqual({
      guard_ai_routing_lifecycle_audit: false,
      assert_ai_routing_lifecycle_evidence_v1: false,
      assert_ai_routing_lifecycle_no_policy_reference_v1: false,
      assert_ai_routing_lifecycle_selected_price_evidence_v1: false,
      lock_ai_routing_lifecycle_profile_prices_v1: false,
      assert_ai_routing_lifecycle_runtime_profile_coverage_v1: false,
      insert_ai_routing_lifecycle_audit_v1: false,
    });
  });

  it("keeps row-lock-only catalog columns structurally unforgeable", async () => {
    const f = await fixture();
    const profileBefore = await service
      .from("ai_provider_profile_versions")
      .select("display_disclosure_key")
      .eq("id", f.profileVersionId)
      .single();
    expect(profileBefore.error).toBeNull();
    const priceBefore = await service
      .from("ai_price_versions")
      .select("components_sealed_at")
      .eq("id", f.priceVersionId)
      .single();
    expect(priceBefore.error).toBeNull();

    const profileMutation = await service
      .from("ai_provider_profile_versions")
      .update({ display_disclosure_key: "forbidden.direct.mutation" })
      .eq("id", f.profileVersionId);
    expect(profileMutation.error?.code).toBe(CHECK_VIOLATION);

    const priceMutation = await service
      .from("ai_price_versions")
      .update({ components_sealed_at: new Date().toISOString() })
      .eq("id", f.priceVersionId);
    expect(priceMutation.error?.code).toBe(CHECK_VIOLATION);

    const profileAfter = await service
      .from("ai_provider_profile_versions")
      .select("display_disclosure_key")
      .eq("id", f.profileVersionId)
      .single();
    expect(profileAfter.error).toBeNull();
    expect(profileAfter.data).toEqual(profileBefore.data);
    const priceAfter = await service
      .from("ai_price_versions")
      .select("components_sealed_at")
      .eq("id", f.priceVersionId)
      .single();
    expect(priceAfter.error).toBeNull();
    expect(priceAfter.data).toEqual(priceBefore.data);
  });

  it("rejects every typed price-fact mismatch without sealing or auditing", async () => {
    const cases: Array<{
      name: string;
      override: (ev: Record<string, string>) => Record<string, unknown>;
    }> = [
      {
        name: "source URL",
        override: () => ({ p_rechecked_source_url: "https://example.com/changed" }),
      },
      { name: "currency", override: () => ({ p_rechecked_currency: "USD" }) },
      {
        name: "calculator kind",
        override: () => ({ p_rechecked_calculator_kind: "different_calculator_v1" }),
      },
      {
        name: "provider effective from",
        override: () => ({ p_rechecked_provider_effective_from: "2020-01-01T00:00:00.000Z" }),
      },
      {
        name: "provider effective to",
        override: () => ({ p_rechecked_provider_effective_to: "2020-01-01T00:00:00.000Z" }),
      },
      {
        name: "parameters",
        override: () => ({ p_rechecked_parameters: { changed: true } }),
      },
      {
        name: "missing component",
        override: () => ({
          p_rechecked_components: { input_standard: "1", output: "1" },
        }),
      },
      {
        name: "extra component",
        override: () => ({
          p_rechecked_components: {
            input_standard: "1",
            input_cache_read: "1",
            input_cache_write: "1",
            output: "1",
          },
        }),
      },
      {
        name: "malformed decimal",
        override: () => ({
          p_rechecked_components: {
            input_standard: "01",
            input_cache_read: "1",
            output: "1",
          },
        }),
      },
      {
        name: "numeric component value",
        override: () => ({
          p_rechecked_components: {
            input_standard: 1,
            input_cache_read: "1",
            output: "1",
          },
        }),
      },
      {
        name: "null component value",
        override: () => ({
          p_rechecked_components: {
            input_standard: null,
            input_cache_read: "1",
            output: "1",
          },
        }),
      },
      {
        name: "negative decimal",
        override: () => ({
          p_rechecked_components: {
            input_standard: "-1",
            input_cache_read: "1",
            output: "1",
          },
        }),
      },
      {
        name: "bigint overflow",
        override: () => ({
          p_rechecked_components: {
            input_standard: "9223372036854775808",
            input_cache_read: "1",
            output: "1",
          },
        }),
      },
      {
        name: "stale recheck",
        override: (ev: Record<string, string>) => ({
          p_rechecked_at: new Date(
            Date.parse(ev.p_rechecked_at) - 1,
          ).toISOString(),
        }),
      },
    ];

    for (const item of cases) {
      const f = await fixture({ profileStatus: "draft", sealPrice: false });
      const ev = await evidence(f);
      const args = {
        p_price_version_id: f.priceVersionId,
        p_rechecked_source_url: f.sourceUrl,
        p_rechecked_currency: "CNY",
        p_rechecked_calculator_kind: "linear_token_v1",
        p_rechecked_provider_effective_from: null,
        p_rechecked_provider_effective_to: null,
        p_rechecked_parameters: {},
        p_rechecked_components: {
          input_standard: "1",
          input_cache_read: "1",
          output: "1",
        },
        ...ev,
        ...item.override(ev),
      };
      const result =
        item.name === "stale recheck"
          ? await service.rpc("seal_ai_price_for_activation_v1", args)
          : await lifecycleRpc("seal_ai_price_for_activation_v1", args);
      expect(result.error?.code, item.name).toMatch(/23514|P0001/u);
      expect(
        ownerJson(`select pg_catalog.jsonb_build_object('sealed', (select components_sealed_at is not null from public.ai_price_versions where id='${f.priceVersionId}'::uuid), 'audit', (select count(*) from public.ai_routing_lifecycle_audit where price_version_id='${f.priceVersionId}'::uuid))::text;`),
        item.name,
      ).toEqual({ sealed: false, audit: 0 });
    }
  });

  it("seals a non-null provider-effective date only when the rechecked date is exact", async () => {
    const providerEffectiveFrom = "2026-08-16T16:00:00.000Z";
    const f = await fixture({
      profileStatus: "draft",
      sealPrice: false,
      providerEffectiveFrom,
    });
    const ev = await evidence(f);
    const args = {
      p_price_version_id: f.priceVersionId,
      p_rechecked_source_url: f.sourceUrl,
      p_rechecked_currency: "CNY",
      p_rechecked_calculator_kind: "linear_token_v1",
      p_rechecked_provider_effective_to: null,
      p_rechecked_parameters: {},
      p_rechecked_components: {
        input_standard: "1",
        input_cache_read: "1",
        output: "1",
      },
      ...ev,
    };

    for (const recheckedProviderEffectiveFrom of [
      null,
      "2026-08-16T16:00:01.000Z",
    ]) {
      const rejected = await lifecycleRpc("seal_ai_price_for_activation_v1", {
        ...args,
        p_rechecked_provider_effective_from: recheckedProviderEffectiveFrom,
      });
      expect(rejected.error?.code).toMatch(/23514|P0001/u);
      expect(
        ownerJson(`select pg_catalog.jsonb_build_object('sealed', (select components_sealed_at is not null from public.ai_price_versions where id='${f.priceVersionId}'::uuid), 'audit', (select count(*) from public.ai_routing_lifecycle_audit where price_version_id='${f.priceVersionId}'::uuid))::text;`),
      ).toEqual({ sealed: false, audit: 0 });
    }

    const sealed = await lifecycleRpc("seal_ai_price_for_activation_v1", {
      ...args,
      p_rechecked_provider_effective_from: providerEffectiveFrom,
    });
    expect(sealed.error).toBeNull();
    expect(sealed.data).toMatch(CANONICAL_UUID);
  });

  it("seals exact refreshed price facts, promotes non-retired profiles, and authors a validated candidate before inserting its draft", async () => {
    const f = await fixture({ profileStatus: "draft", sealPrice: false });
    const ev = await evidence(f);
    const priceArguments = {
      p_price_version_id: f.priceVersionId,
      p_rechecked_source_url: f.sourceUrl,
      p_rechecked_currency: "CNY",
      p_rechecked_calculator_kind: "linear_token_v1",
      p_rechecked_provider_effective_from: null,
      p_rechecked_provider_effective_to: null,
      p_rechecked_parameters: {},
      ...ev,
    };

    const sealed = await lifecycleRpc("seal_ai_price_for_activation_v1", {
      ...priceArguments,
      p_rechecked_components: {
        input_standard: "1",
        input_cache_read: "1",
        output: "1",
      },
    });
    expect(sealed.error).toBeNull();
    expect(sealed.data).toMatch(CANONICAL_UUID);

    const promoted = await lifecycleRpc(
      "transition_ai_provider_profile_version_v1",
      { p_profile_version_id: f.profileVersionId, p_to_status: "validated", ...ev },
    );
    expect(promoted.error).toBeNull();
    expect(promoted.data).toMatch(CANONICAL_UUID);
    expect(
      (
        await lifecycleRpc("transition_ai_provider_profile_version_v1", {
          p_profile_version_id: f.profileVersionId,
          p_to_status: "draft",
          ...ev,
        })
      ).error?.code,
    ).toMatch(/23514|P0001/u);

    const createdPolicyId = crypto.randomUUID();
    f.createdPolicyIds.push(createdPolicyId);
    const created = await lifecycleRpc("create_ai_routing_policy_version_v1", {
      p_policy_version_id: createdPolicyId,
      p_policy_key: `db013.created.${crypto.randomUUID()}`,
      p_version: 1,
      p_timezone: "Asia/Shanghai",
      p_rules: {
        schemaVersion: "routing_rules_v1",
        defaultRoute: {
          profileVersionId: f.profileVersionId,
          priceVersionId: f.priceVersionId,
        },
        windows: [],
      },
      p_default_profile_version_id: f.profileVersionId,
      p_legal_bundle_version: INITIAL_LEGAL_BUNDLE_VERSION,
      p_config_sha256: "e".repeat(64),
      ...ev,
    });
    expect(created.error).toBeNull();
    expect(created.data).toMatch(CANONICAL_UUID);
    expect(
      ownerJson(`
        select pg_catalog.jsonb_build_object(
          'policyStatus', (select status from public.ai_routing_policy_versions where id='${createdPolicyId}'::uuid),
          'priceSeal', (
            select count(*) = 1 and pg_catalog.bool_and(
              audit.audit_id::text = '${sealed.data}'
              and audit.price_version_id = price.id
              and audit.policy_version_id is null
              and audit.profile_id is null
              and audit.profile_version_id is null
              and audit.from_status is null
              and audit.to_status is null
              and audit.old_active_policy_version_id is null
              and audit.new_active_policy_version_id is null
              and audit.old_config_generation is null
              and audit.new_config_generation is null
              and audit.old_retired_at is null
              and audit.new_retired_at is null
              and audit.old_valid_to is null
              and audit.new_valid_to is null
              and audit.old_components_sealed_at is null
              and audit.new_components_sealed_at = price.components_sealed_at
              and audit.runtime_contract_id = '${f.runtimeContractId}'
              and audit.runtime_contract_sha256 = '${f.runtimeContractSha256}'
              and audit.actor = '${EVIDENCE.p_actor}'
              and audit.reason = '${EVIDENCE.p_reason}'
              and audit.reviewed_source_commit_oid = '${ev.p_reviewed_source_commit_oid}'
              and audit.reviewed_source_sha256 = '${f.runtimeContractSha256}'
              and audit.rechecked_at = '${ev.p_rechecked_at}'::timestamptz
              and audit.rechecked_sha256 = '${EVIDENCE.p_rechecked_sha256}'
              and audit.occurred_at is not null
              and audit.transaction_id > 0
            )
            from public.ai_routing_lifecycle_audit as audit
            join public.ai_price_versions as price on price.id = audit.price_version_id
            where audit.operation='price_seal' and audit.price_version_id='${f.priceVersionId}'::uuid
          ),
          'profileTransition', (select count(*) = 1 and pg_catalog.bool_and(from_status='draft' and to_status='validated' and old_components_sealed_at is null and new_components_sealed_at is null and policy_version_id is null and profile_id is null and price_version_id is null) from public.ai_routing_lifecycle_audit where operation='profile_version_transition' and profile_version_id='${f.profileVersionId}'::uuid),
          'policyCreate', (select count(*) = 1 and pg_catalog.bool_and(policy_version_id='${createdPolicyId}'::uuid and from_status is null and to_status is null and old_components_sealed_at is null and new_components_sealed_at is null) from public.ai_routing_lifecycle_audit where operation='policy_create' and policy_version_id='${createdPolicyId}'::uuid)
        )::text;
      `),
    ).toEqual({
      policyStatus: "draft",
      priceSeal: true,
      profileTransition: true,
      policyCreate: true,
    });
  });

  it("fails closed when an exact sealed evidence root does not cover the target profile", async () => {
    const f = await fixture({ profileStatus: "draft", sealPrice: false });
    const uncoveredRuntime = authorSyntheticRuntimeContract({
      profileKey: `db013.uncovered.${crypto.randomUUID()}`,
    });
    f.additionalRuntimeContractIds.push(uncoveredRuntime.runtimeContractId);
    f.additionalRuntimeTargetIds.push(uncoveredRuntime.runtimeTargetId);
    const root = readLifecycleEvidenceRoot({
      runtimeContractId: uncoveredRuntime.runtimeContractId,
      runtimeContractSha256: uncoveredRuntime.runtimeContractSha256,
      priceVersionIds: [f.priceVersionId],
    });
    const uncoveredEvidence = {
      p_runtime_contract_id: uncoveredRuntime.runtimeContractId,
      p_runtime_contract_sha256: uncoveredRuntime.runtimeContractSha256,
      p_reviewed_source_commit_oid: root.reviewedSourceCommitOid,
      p_reviewed_source_sha256: uncoveredRuntime.runtimeContractSha256,
      p_rechecked_at: root.recheckedAt,
      ...EVIDENCE,
    };

    const seal = await service.rpc("seal_ai_price_for_activation_v1", {
      p_price_version_id: f.priceVersionId,
      p_rechecked_source_url: f.sourceUrl,
      p_rechecked_currency: "CNY",
      p_rechecked_calculator_kind: "linear_token_v1",
      p_rechecked_provider_effective_from: null,
      p_rechecked_provider_effective_to: null,
      p_rechecked_parameters: {},
      p_rechecked_components: {
        input_standard: "1",
        input_cache_read: "1",
        output: "1",
      },
      ...uncoveredEvidence,
    });
    expect(seal.error?.code).toMatch(/23514|P0001/u);
    const promotion = await service.rpc(
      "transition_ai_provider_profile_version_v1",
      {
        p_profile_version_id: f.profileVersionId,
        p_to_status: "validated",
        ...uncoveredEvidence,
      },
    );
    expect(promotion.error?.code).toMatch(/23514|P0001/u);
    expect(
      ownerJson(`
        select pg_catalog.jsonb_build_object(
          'sealed', (select components_sealed_at is not null from public.ai_price_versions where id='${f.priceVersionId}'::uuid),
          'profileStatus', (select status from public.ai_provider_profile_versions where id='${f.profileVersionId}'::uuid),
          'audit', (select count(*) from public.ai_routing_lifecycle_audit where price_version_id='${f.priceVersionId}'::uuid or profile_version_id='${f.profileVersionId}'::uuid)
        )::text;
      `),
    ).toEqual({ sealed: false, profileStatus: "draft", audit: 0 });
  });

  it("admits exactly the four non-retirement profile promotion edges", async () => {
    const edges = new Set([
      "draft:validated",
      "validated:canary",
      "validated:active",
      "canary:active",
    ]);
    const preludes: Record<string, string[]> = {
      draft: [],
      validated: ["validated"],
      canary: ["validated", "canary"],
      active: ["validated", "active"],
    };
    for (const from of Object.keys(preludes)) {
      for (const to of ["draft", "validated", "canary", "active", "retired"]) {
        const f = await fixture({ profileStatus: "draft" });
        const ev = await evidence(f);
        for (const status of preludes[from]!) {
          expect(
            (
              await lifecycleRpc("transition_ai_provider_profile_version_v1", {
                p_profile_version_id: f.profileVersionId,
                p_to_status: status,
                ...ev,
              })
            ).error,
          ).toBeNull();
        }
        const result = await lifecycleRpc(
          "transition_ai_provider_profile_version_v1",
          { p_profile_version_id: f.profileVersionId, p_to_status: to, ...ev },
        );
        if (edges.has(`${from}:${to}`)) {
          expect(result.error, `${from} -> ${to}`).toBeNull();
        } else {
          expect(result.error?.code, `${from} -> ${to}`).toMatch(/23514|P0001/u);
        }
      }
    }
  });

  it("writes exactly one owner-readable audit row for each valid policy and pointer operation", async () => {
    const f = await fixture();
    const ev = await evidence(f);
    expect((await lifecycleRpc("transition_ai_routing_policy_v2", { p_policy_version_id: f.policyVersionId, p_to_status: "validated", ...ev })).error).toBeNull();
    runOwnerSql(`update public.ai_provider_profile_versions set status='canary' where id='${f.profileVersionId}'::uuid;`);
    expect((await lifecycleRpc("transition_ai_routing_policy_v2", { p_policy_version_id: f.policyVersionId, p_to_status: "canary", ...ev })).error).toBeNull();
    expect((await lifecycleRpc("set_ai_routing_policy_pointer_v1", { p_policy_version_id: f.policyVersionId, ...ev, p_reason: `DB-013 pointer set ${crypto.randomUUID()}` })).error).toBeNull();
    expect((await lifecycleRpc("clear_ai_routing_policy_pointer_v1", { p_expected_policy_version_id: f.policyVersionId, ...ev, p_reason: `DB-013 pointer clear ${crypto.randomUUID()}` })).error).toBeNull();

    const audit = ownerJson(`select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('operation', operation, 'old', old_config_generation, 'new', new_config_generation, 'runtime', runtime_contract_sha256, 'actor', actor) order by occurred_at) from public.ai_routing_lifecycle_audit where policy_version_id='${f.policyVersionId}'::uuid;`) as unknown[];
    expect(audit).toHaveLength(4);
    expect(audit).toContainEqual(expect.objectContaining({ operation: "pointer_set", actor: EVIDENCE.p_actor }));
    expect(audit).toContainEqual(expect.objectContaining({ operation: "pointer_clear" }));
  });

  it("ignores inert malformed drafts and audits successful terminal wrappers", async () => {
    const malformedDraft = await fixture({ malformedRules: true });
    const profileFixture = await fixture();
    const profileEvidence = await evidence(profileFixture);
    const retiredPolicy = await lifecycleRpc("transition_ai_routing_policy_v2", {
      p_policy_version_id: profileFixture.policyVersionId,
      p_to_status: "retired",
      ...profileEvidence,
    });
    expect(retiredPolicy.error).toBeNull();
    expect(retiredPolicy.data).toMatch(CANONICAL_UUID);

    const profileVersionReason =
      `DB-013 profile-version retirement ${crypto.randomUUID()}`;
    const retiredVersion = await lifecycleRpc(
      "retire_ai_provider_profile_version_v1",
      {
        p_profile_version_id: profileFixture.profileVersionId,
        ...profileEvidence,
        p_reason: profileVersionReason,
      },
    );
    expect(retiredVersion.error).toBeNull();
    expect(retiredVersion.data).toMatch(CANONICAL_UUID);

    const profileReason = `DB-013 profile retirement ${crypto.randomUUID()}`;
    const retiredProfile = await lifecycleRpc("retire_ai_provider_profile_v1", {
      p_profile_id: profileFixture.profileId,
      ...profileEvidence,
      p_reason: profileReason,
    });
    expect(retiredProfile.error).toBeNull();
    expect(retiredProfile.data).toMatch(CANONICAL_UUID);

    const profileState = ownerJson(`
      select pg_catalog.jsonb_build_object(
        'profileRetired', profile.retired_at is not null,
        'versionRetired', version.status = 'retired' and version.retired_at is not null,
        'policyAuditId', (
          select audit.audit_id::text
          from public.ai_routing_lifecycle_audit as audit
          where audit.operation = 'policy_transition'
            and audit.policy_version_id = '${profileFixture.policyVersionId}'::uuid
        ),
        'versionAuditId', (
          select audit.audit_id::text
          from public.ai_routing_lifecycle_audit as audit
          where audit.operation = 'profile_version_retire'
            and audit.profile_version_id = version.id
        ),
        'profileAuditId', (
          select audit.audit_id::text
          from public.ai_routing_lifecycle_audit as audit
          where audit.operation = 'profile_retire'
            and audit.profile_id = profile.id
        ),
        'versionAuditExact', (
          select count(*) = 1 and pg_catalog.bool_and(
            audit.policy_version_id is null
            and audit.profile_id is null
            and audit.profile_version_id = version.id
            and audit.price_version_id is null
            and audit.from_status is null
            and audit.to_status is null
            and audit.old_active_policy_version_id is null
            and audit.new_active_policy_version_id is null
            and audit.old_config_generation is null
            and audit.new_config_generation is null
            and audit.old_retired_at is null
            and audit.new_retired_at = version.retired_at
            and audit.old_valid_to is null
            and audit.new_valid_to is null
            and audit.runtime_contract_id = '${profileFixture.runtimeContractId}'
            and audit.runtime_contract_sha256 = '${profileFixture.runtimeContractSha256}'
            and audit.actor = '${EVIDENCE.p_actor}'
            and audit.reason = '${profileVersionReason}'
            and audit.reviewed_source_commit_oid = '${profileEvidence.p_reviewed_source_commit_oid}'
            and audit.reviewed_source_sha256 = '${profileFixture.runtimeContractSha256}'
            and audit.rechecked_at = '${profileEvidence.p_rechecked_at}'::timestamptz
            and audit.rechecked_sha256 = '${EVIDENCE.p_rechecked_sha256}'
            and audit.occurred_at is not null
            and audit.transaction_id > 0
          )
          from public.ai_routing_lifecycle_audit as audit
          where audit.operation = 'profile_version_retire'
            and audit.profile_version_id = version.id
        ),
        'profileAuditExact', (
          select count(*) = 1 and pg_catalog.bool_and(
            audit.policy_version_id is null
            and audit.profile_id = profile.id
            and audit.profile_version_id is null
            and audit.price_version_id is null
            and audit.from_status is null
            and audit.to_status is null
            and audit.old_active_policy_version_id is null
            and audit.new_active_policy_version_id is null
            and audit.old_config_generation is null
            and audit.new_config_generation is null
            and audit.old_retired_at is null
            and audit.new_retired_at = profile.retired_at
            and audit.old_valid_to is null
            and audit.new_valid_to is null
            and audit.runtime_contract_id = '${profileFixture.runtimeContractId}'
            and audit.runtime_contract_sha256 = '${profileFixture.runtimeContractSha256}'
            and audit.actor = '${EVIDENCE.p_actor}'
            and audit.reason = '${profileReason}'
            and audit.reviewed_source_commit_oid = '${profileEvidence.p_reviewed_source_commit_oid}'
            and audit.reviewed_source_sha256 = '${profileFixture.runtimeContractSha256}'
            and audit.rechecked_at = '${profileEvidence.p_rechecked_at}'::timestamptz
            and audit.rechecked_sha256 = '${EVIDENCE.p_rechecked_sha256}'
            and audit.occurred_at is not null
            and audit.transaction_id > 0
          )
          from public.ai_routing_lifecycle_audit as audit
          where audit.operation = 'profile_retire'
            and audit.profile_id = profile.id
        )
      )::text
      from public.ai_provider_profiles as profile
      join public.ai_provider_profile_versions as version
        on version.profile_id = profile.id
      where profile.id = '${profileFixture.profileId}'::uuid;
    `);
    expect(profileState).toEqual({
      profileRetired: true,
      versionRetired: true,
      policyAuditId: retiredPolicy.data,
      versionAuditId: retiredVersion.data,
      profileAuditId: retiredProfile.data,
      versionAuditExact: true,
      profileAuditExact: true,
    });

    const malformedDraftState = ownerJson(`
      select pg_catalog.jsonb_build_object(
        'status', policy.status,
        'rules', policy.rules,
        'auditCount', (
          select count(*)
          from public.ai_routing_lifecycle_audit as audit
          where audit.policy_version_id = policy.id
        )
      )::text
      from public.ai_routing_policy_versions as policy
      where policy.id = '${malformedDraft.policyVersionId}'::uuid;
    `);
    expect(malformedDraftState).toEqual({
      status: "draft",
      rules: { schemaVersion: "routing_rules_v1", windows: [] },
      auditCount: 0,
    });

    const priceFixture = await fixture();
    const priceEvidence = await evidence(priceFixture);
    expect(
      (
        await lifecycleRpc("transition_ai_routing_policy_v2", {
          p_policy_version_id: priceFixture.policyVersionId,
          p_to_status: "retired",
          ...priceEvidence,
        })
      ).error,
    ).toBeNull();
    const priceReason = `DB-013 price closure ${crypto.randomUUID()}`;
    const closedPrice = await lifecycleRpc("close_ai_price_version_v1", {
      p_price_version_id: priceFixture.priceVersionId,
      p_valid_to: new Date().toISOString(),
      p_successor_price_version_id: null,
      ...priceEvidence,
      p_reason: priceReason,
    });
    expect(closedPrice.error).toBeNull();
    expect(closedPrice.data).toMatch(CANONICAL_UUID);

    const priceState = ownerJson(`
      select pg_catalog.jsonb_build_object(
        'closed', price.valid_to is not null,
        'auditId', (
          select audit.audit_id::text
          from public.ai_routing_lifecycle_audit as audit
          where audit.operation = 'price_close'
            and audit.price_version_id = price.id
        ),
        'auditExact', (
          select count(*) = 1 and pg_catalog.bool_and(
            audit.policy_version_id is null
            and audit.profile_id is null
            and audit.profile_version_id is null
            and audit.price_version_id = price.id
            and audit.from_status is null
            and audit.to_status is null
            and audit.old_active_policy_version_id is null
            and audit.new_active_policy_version_id is null
            and audit.old_config_generation is null
            and audit.new_config_generation is null
            and audit.old_retired_at is null
            and audit.new_retired_at is null
            and audit.old_valid_to is null
            and audit.new_valid_to = price.valid_to
            and audit.runtime_contract_id = '${priceFixture.runtimeContractId}'
            and audit.runtime_contract_sha256 = '${priceFixture.runtimeContractSha256}'
            and audit.actor = '${EVIDENCE.p_actor}'
            and audit.reason = '${priceReason}'
            and audit.reviewed_source_commit_oid = '${priceEvidence.p_reviewed_source_commit_oid}'
            and audit.reviewed_source_sha256 = '${priceFixture.runtimeContractSha256}'
            and audit.rechecked_at = '${priceEvidence.p_rechecked_at}'::timestamptz
            and audit.rechecked_sha256 = '${EVIDENCE.p_rechecked_sha256}'
            and audit.occurred_at is not null
            and audit.transaction_id > 0
          )
          from public.ai_routing_lifecycle_audit as audit
          where audit.operation = 'price_close'
            and audit.price_version_id = price.id
        )
      )::text
      from public.ai_price_versions as price
      where price.id = '${priceFixture.priceVersionId}'::uuid;
    `);
    expect(priceState).toEqual({
      closed: true,
      auditId: closedPrice.data,
      auditExact: true,
    });
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
    expect((await lifecycleRpc("retire_ai_provider_profile_version_v1", { p_profile_version_id: f.profileVersionId, ...ev })).error?.code).toMatch(/23514|P0001/u);
    expect((await lifecycleRpc("close_ai_price_version_v1", { p_price_version_id: f.priceVersionId, p_valid_to: new Date().toISOString(), p_successor_price_version_id: null, ...ev })).error?.code).toMatch(/23514|P0001/u);
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
        expect((await lifecycleRpc("transition_ai_routing_policy_v2", { p_policy_version_id: f.policyVersionId, p_to_status: status, ...ev })).error).toBeNull();
      }
      const transition = await lifecycleRpc("transition_ai_routing_policy_v2", { p_policy_version_id: f.policyVersionId, p_to_status: item.to, ...ev });
      expect(transition.error, `${item.from} -> ${item.to}`).toBeNull();
      const state = ownerJson(`select pg_catalog.jsonb_build_object('status',(select status from public.ai_routing_policy_versions where id='${f.policyVersionId}'::uuid),'intents',(select count(*) from public.ai_routing_policy_transition_intents where policy_version_id='${f.policyVersionId}'::uuid))::text;`);
      expect(state).toEqual({ status: item.to, intents: 0 });
      if (item.to === "retired") {
        expect((await lifecycleRpc("transition_ai_routing_policy_v2", { p_policy_version_id: f.policyVersionId, p_to_status: "active", ...ev })).error?.code).toMatch(/23514|P0001/u);
      } else {
        expect((await lifecycleRpc("transition_ai_routing_policy_v2", { p_policy_version_id: f.policyVersionId, p_to_status: item.to, ...ev })).error?.code).toMatch(/23514|P0001/u);
      }
    }
  });
});
