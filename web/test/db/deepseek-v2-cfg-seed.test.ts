import { readFileSync } from "node:fs";

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { DEEPSEEK_V2_SEED_V1 } from "@/server/polish/deepseek-v2-seed-v1";

import { createServiceClient, RUN_DB_TESTS } from "./helpers";
import { runOwnerSql } from "./runtime-contract-fixtures";

const SEED = DEEPSEEK_V2_SEED_V1;
const RUN_CFG001_FRESH_RESET = process.env.CFG001_FRESH_RESET === "1";
const DISABLED_AVAILABILITY = {
  enabled: false,
  configGeneration: null,
  routingPolicyVersionId: null,
  profileVersionId: null,
  legalBundleVersion: null,
  runtimeContractId: null,
  runtimeContractSha256: null,
  displayDisclosureKey: null,
  termsAccepted: false,
} as const;

const SNAPSHOT_TABLES = [
  "ai_feature_config",
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
  "ai_request_ledger",
  "ai_provider_attempt_ledger",
  "ai_usage_daily",
  "ai_global_usage_daily",
  "ai_profile_usage_daily",
  "ai_rate_minutes",
  "user_terms_acceptances",
  "ai_price_component_seal_intents",
  "ai_routing_policy_transition_intents",
] as const;

const PUBLIC_SECURITY_DEFINER_AUTHORITY_V1 = [
  {
    schema: "public",
    name: "apply_ai_price_component_seal_intent",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "60a52cc8fe50c18f5c10e825ed7d22dbc0be6ac268e1f21be134613a28cda113",
  },
  {
    schema: "public",
    name: "assert_ai_routing_policy_v1",
    identityArguments: "p_policy_id uuid, p_phase text, p_at timestamp with time zone",
    prokind: "f",
    definitionSha256: "13c1c97b4adcd9d6fb46485f937ac667c4c92300b854ec4346c87ad1e15895da",
  },
  {
    schema: "public",
    name: "complete_ai_polish_provider_attempt",
    identityArguments:
      "p_attempt_id uuid, p_status text, p_transmitted boolean, p_retry_eligible boolean, p_provider_billable boolean, p_usage jsonb, p_route jsonb, p_cost jsonb, p_metadata jsonb",
    prokind: "f",
    definitionSha256: "4092c7cda332ea22f1e1cd48ed77847f4ac65fe2314c8ad7d4dae879a16deece",
  },
  {
    schema: "public",
    name: "complete_ai_polish_provider_attempt_internal",
    identityArguments:
      "p_attempt_id uuid, p_status text, p_provider_billable boolean, p_usage jsonb, p_route jsonb, p_cost jsonb, p_metadata jsonb",
    prokind: "f",
    definitionSha256: "1e8604a5d30cce762152bd2d32755c74f06a42b2b5fec8f7ff6bef6226937a1c",
  },
  {
    schema: "public",
    name: "complete_ai_polish_provider_attempt_transmission_internal",
    identityArguments:
      "p_attempt_id uuid, p_status text, p_transmitted boolean, p_provider_billable boolean, p_usage jsonb, p_route jsonb, p_cost jsonb, p_metadata jsonb",
    prokind: "f",
    definitionSha256: "f738cdc7557323bac276221f1d81326694d8253efd4cf425164c239ef03936b2",
  },
  {
    schema: "public",
    name: "derive_ai_polish_v2_settlement",
    identityArguments: "p_reservation_id uuid",
    prokind: "f",
    definitionSha256: "96ce52e077730429b8317969d0ad3394aa4710c19ea8b88a98a9f5b4dd4ba37c",
  },
  {
    schema: "public",
    name: "derive_ai_polish_v2_settlement_sequence",
    identityArguments: "p_reservation_id uuid, p_allow_open_retry boolean",
    prokind: "f",
    definitionSha256: "d2233e6a09079f3b43dd6298e824c6a61d950b9e48c0d5c47e10c14d4d5029ea",
  },
  {
    schema: "public",
    name: "finalize_ai_polish_request",
    identityArguments:
      "p_reservation_id uuid, p_status text, p_quota_charged boolean, p_provider_billable boolean, p_usage jsonb, p_metadata jsonb",
    prokind: "f",
    definitionSha256: "e3f1d4d5fb32eec8b8aef81001c72dad8463ec61b9792fd9d53d117d1ed56d22",
  },
  {
    schema: "public",
    name: "finalize_ai_polish_request",
    identityArguments:
      "p_reservation_id uuid, p_status text, p_quota_charged boolean, p_provider_billable boolean, p_usage jsonb, p_metadata jsonb, p_settlement_contract text",
    prokind: "f",
    definitionSha256: "82d7197b568db9420b7f30d4a760fc56cc52f8e1d7caeb32a993985a33956037",
  },
  {
    schema: "public",
    name: "get_ai_polish_availability_v1",
    identityArguments: "p_user_id uuid",
    prokind: "f",
    definitionSha256: "e2ed670a39e88f4df1d81ed423688b89ac490dc9dbdc6062e38096752d3261eb",
  },
  {
    schema: "public",
    name: "get_ai_polish_execution_snapshot_v1",
    identityArguments: "p_reservation_id uuid, p_user_id uuid",
    prokind: "f",
    definitionSha256: "42b8405c1365e2125a86e00dbb741c737a229c54a1640515f9c0ddeee95331fc",
  },
  {
    schema: "public",
    name: "guard_ai_feature_routing_pointer",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "16c33dc5450acde6ddfafae353f379bc8077ee2ece3614dcb52b3f468d5f51ea",
  },
  {
    schema: "public",
    name: "guard_ai_price_version",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "aaf09223f0121101d62c3a6fb67a95c8ed167dac286e92b5fc378d219abbbee6",
  },
  {
    schema: "public",
    name: "guard_ai_routing_policy_version",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "7db4cde2ff3a547667facdcf61ae60c47afcf83e5826805f97e5960b7e00b3d3",
  },
  {
    schema: "public",
    name: "has_accepted_ai_legal_bundle",
    identityArguments: "p_user_id uuid, p_legal_bundle_version text",
    prokind: "f",
    definitionSha256: "38001bae505723bbf893a2717bc7e3d194b31ee6f71ba78f7c620a22a3478f53",
  },
  {
    schema: "public",
    name: "lock_and_validate_ai_routing_policy_row_v1",
    identityArguments:
      "p_policy ai_routing_policy_versions, p_phase text, p_at timestamp with time zone",
    prokind: "f",
    definitionSha256: "4faaf7dab95e997efe27be9b523e86c69124bec608e2e7fa07a63f031e115a52",
  },
  {
    schema: "public",
    name: "reconcile_stale_ai_polish_reservations",
    identityArguments: "p_stale_after interval",
    prokind: "f",
    definitionSha256: "1640e1b4ee91359891584383205c8482c9de2850467516d515867fea62452b30",
  },
  {
    schema: "public",
    name: "record_ai_polish_request_cancellation",
    identityArguments: "p_reservation_id uuid, p_observation text",
    prokind: "f",
    definitionSha256: "7df24a481e7ab1e928d86ed8facf7f19dc2f46c6423e64f37ba4384604632300",
  },
  {
    schema: "public",
    name: "reserve_ai_polish_request_v2",
    identityArguments:
      "p_user_id uuid, p_request_id uuid, p_client_request_id uuid, p_expected_route jsonb",
    prokind: "f",
    definitionSha256: "b201d838cfdc900951ea8d0c97586b15e4721fdff4de7e1079f713da92c1ee09",
  },
  {
    schema: "public",
    name: "seal_ai_price_components_v1",
    identityArguments: "p_price_version_ids uuid[], p_sealed_at timestamp with time zone",
    prokind: "f",
    definitionSha256: "0dd187ddb38e0c6647c3e97f91a3acc8c4649108199fcc3fc2be55e020cd5073",
  },
  {
    schema: "public",
    name: "start_ai_polish_provider_attempt",
    identityArguments: "p_reservation_id uuid, p_attempt_no integer",
    prokind: "f",
    definitionSha256: "a43230f5201790f267ceacdd3cdb3d7c85740633458363236d56c4be3d17516e",
  },
  {
    schema: "public",
    name: "start_ai_polish_provider_attempt_internal",
    identityArguments: "p_reservation_id uuid, p_attempt_no integer",
    prokind: "f",
    definitionSha256: "2034752c8152f4450ede122ed5a372510366a2e2af3ee7061362d21b4063a4c7",
  },
  {
    schema: "public",
    name: "transition_ai_routing_policy_v1",
    identityArguments: "p_policy_id uuid, p_to_status text",
    prokind: "f",
    definitionSha256: "345268f4ebcee8b61a2d18d41e5a7dbe48a401fd0ae716a0ccc58ca26bf14f4b",
  },
  {
    schema: "public",
    name: "validate_ai_routing_policy_transition_v1",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "ab6afa02691efe383095e14c6eebc85c9debc6828fc8fced6771ac9db4a66530",
  },
] as const;

const RUNTIME_ROUTINE_AUTHORITY_V1 = [
  {
    schema: "public",
    name: "get_ai_polish_availability_v1",
    identityArguments: "p_user_id uuid",
    prokind: "f",
    definitionSha256: "e2ed670a39e88f4df1d81ed423688b89ac490dc9dbdc6062e38096752d3261eb",
  },
  {
    schema: "public",
    name: "get_ai_polish_execution_snapshot_v1",
    identityArguments: "p_reservation_id uuid, p_user_id uuid",
    prokind: "f",
    definitionSha256: "42b8405c1365e2125a86e00dbb741c737a229c54a1640515f9c0ddeee95331fc",
  },
  {
    schema: "public",
    name: "guard_ai_service_runtime_contract_target",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "e04c9e4d3c45e07dd210892567646310ddb020f853b58a8b29af38a894fba395",
  },
  {
    schema: "public",
    name: "guard_ai_service_runtime_contract_version",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "53df10d400bbcf7da9f652ad899b91de4c570e8712c6700cd61443177422ce5c",
  },
  {
    schema: "public",
    name: "guard_ai_service_runtime_target_version",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "91a20c5a5cbdd39491171274c0c805f424ae8b3c82970a4124488c0b4c75c128",
  },
  {
    schema: "public",
    name: "lock_and_validate_ai_routing_policy_row_v1",
    identityArguments:
      "p_policy ai_routing_policy_versions, p_phase text, p_at timestamp with time zone",
    prokind: "f",
    definitionSha256: "4faaf7dab95e997efe27be9b523e86c69124bec608e2e7fa07a63f031e115a52",
  },
  {
    schema: "public",
    name: "reserve_ai_polish_request_v2",
    identityArguments:
      "p_user_id uuid, p_request_id uuid, p_client_request_id uuid, p_expected_route jsonb",
    prokind: "f",
    definitionSha256: "b201d838cfdc900951ea8d0c97586b15e4721fdff4de7e1079f713da92c1ee09",
  },
  {
    schema: "public",
    name: "validate_ai_routing_policy_row_v1",
    identityArguments:
      "p_policy ai_routing_policy_versions, p_phase text, p_at timestamp with time zone, p_discovery_only boolean",
    prokind: "f",
    definitionSha256: "82a937c6ba13b6bf8047e064665e594350f232542830d982c0c8e1c3edb3fd01",
  },
] as const;

const NON_SYSTEM_ROUTINE_AUTHORITY_ROOT_V1 = {
  routineCount: 358,
  authorityRootSha256:
    "05c976caac3503f1c029748cbadda3ea42d420f4701d28563269f48db0470cca",
} as const;

function parseOwnerJson(sql: string): unknown {
  const result = runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    \pset format unaligned
    \pset tuples_only on
    ${sql}
  `);
  const encoded = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) => line.startsWith("{") || line.startsWith("["));
  if (!encoded) throw new Error("owner query returned no JSON");
  return JSON.parse(encoded) as unknown;
}

function snapshotSeedRows(): string {
  const catalogPairs = SNAPSHOT_TABLES.map(
    (table) => String.raw`
      '${table}', (
        select coalesce(
          pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(row_value)
            order by pg_catalog.to_jsonb(row_value)::text
          ),
          '[]'::jsonb
        )
        from public.${table} as row_value
      )`,
  ).join(",");
  const result = runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    \pset format unaligned
    \pset tuples_only on
    select pg_catalog.jsonb_build_object(${catalogPairs})::text;
  `);
  const snapshot = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) => line.startsWith("{"));
  if (!snapshot) throw new Error("seed snapshot returned no JSON");
  return snapshot;
}

describe.skipIf(!RUN_DB_TESTS)("CFG-001 DeepSeek V2 dark seed (real DB)", () => {
  let service: SupabaseClient;

  beforeAll(() => {
    service = createServiceClient();
  });

  it("publishes the exact joined draft profile projection", async () => {
    const [profileResult, versionResult] = await Promise.all([
      service
        .from("ai_provider_profiles")
        .select("id,profile_key,display_name,gateway_kind,model_vendor,retired_at")
        .eq("id", SEED.profile.id),
      service
        .from("ai_provider_profile_versions")
        .select(
          "id,profile_id,version,status,adapter_kind,wire_api_kind,credential_alias,endpoint_alias,model_id,model_snapshot,upstream_route,capability_contract_id,cache_policy_id,legal_manifest_id,display_disclosure_key,config,config_sha256,validated_at,activated_at,retired_at",
        )
        .eq("id", SEED.profile.profileVersionId),
    ]);

    expect(profileResult.error).toBeNull();
    expect(versionResult.error).toBeNull();
    expect(profileResult.data).toEqual([
      {
        id: SEED.profile.id,
        profile_key: SEED.profile.profileKey,
        display_name: SEED.profile.displayName,
        gateway_kind: SEED.profile.gatewayKind,
        model_vendor: SEED.profile.modelVendor,
        retired_at: null,
      },
    ]);
    expect(versionResult.data).toEqual([
      {
        id: SEED.profile.profileVersionId,
        profile_id: SEED.profile.id,
        version: SEED.profile.version,
        status: SEED.profile.status,
        adapter_kind: SEED.profile.adapterKind,
        wire_api_kind: SEED.profile.wireApiKind,
        credential_alias: SEED.profile.credentialAlias,
        endpoint_alias: SEED.profile.endpointAlias,
        model_id: SEED.profile.modelId,
        model_snapshot: SEED.profile.modelSnapshot,
        upstream_route: SEED.profile.upstreamRoute,
        capability_contract_id: SEED.profile.capabilityContractId,
        cache_policy_id: SEED.profile.cachePolicyId,
        legal_manifest_id: SEED.profile.legalManifestId,
        display_disclosure_key: SEED.profile.displayDisclosureKey,
        config: SEED.profile.config,
        config_sha256: SEED.profile.configSha256,
        validated_at: null,
        activated_at: null,
        retired_at: null,
      },
    ]);
  });

  it("publishes two unsealed CNY lanes and exactly six automatic-cache components", async () => {
    const priceIds = SEED.pricing.rows.map((row) => row.id);
    const [pricesResult, componentsResult] = await Promise.all([
      service
        .from("ai_price_versions")
        .select(
          "id,profile_version_id,pricing_lane,version,currency,calculator_kind,valid_from,valid_to,provider_effective_from,provider_effective_to,source_url,source_checked_at,source_snapshot_sha256,parameters,components_sealed_at",
        )
        .in("id", priceIds)
        .order("pricing_lane"),
      service
        .from("ai_price_components")
        .select("price_version_id,component,nanos_per_million")
        .in("price_version_id", priceIds)
        .order("price_version_id")
        .order("component"),
    ]);

    expect(pricesResult.error).toBeNull();
    expect(componentsResult.error).toBeNull();
    expect(pricesResult.data).toHaveLength(2);

    for (const row of pricesResult.data ?? []) {
      const expected = SEED.pricing.rows.find(
        (candidate) => candidate.id === row.id,
      );
      expect(expected).toBeDefined();
      expect(row).toMatchObject({
        id: expected?.id,
        profile_version_id: SEED.profile.profileVersionId,
        pricing_lane: expected?.pricingLane,
        version: expected?.version,
        currency: expected?.currency,
        calculator_kind: expected?.calculatorKind,
        valid_to: expected?.validTo,
        provider_effective_from: expected?.providerEffectiveFrom,
        provider_effective_to: expected?.providerEffectiveTo,
        source_url: SEED.pricing.sourceUrl,
        source_snapshot_sha256: SEED.pricing.sourceSnapshotSha256,
        parameters: expected?.parameters,
        components_sealed_at: expected?.componentsSealedAt,
      });
      expect(new Date(row.valid_from).toISOString()).toBe(expected?.validFrom);
      expect(new Date(row.source_checked_at).toISOString()).toBe(
        SEED.pricing.sourceCheckedAt,
      );
    }

    const expectedComponents = SEED.pricing.rows
      .flatMap((price) =>
        price.components.map((component) => ({
          price_version_id: price.id,
          component: component.component,
          nanos_per_million: component.nanosPerMillion,
        })),
      )
      .sort((left, right) =>
        `${left.price_version_id}:${left.component}`.localeCompare(
          `${right.price_version_id}:${right.component}`,
        ),
      );
    expect(componentsResult.data).toEqual(expectedComponents);
    expect(componentsResult.data?.some((row) => row.component === "input_cache_write")).toBe(
      false,
    );
  });

  it("publishes the exact DeepSeek-only G2 draft policy and bound hash inputs", async () => {
    const { data, error } = await service
      .from("ai_routing_policy_versions")
      .select(
        "id,policy_key,version,status,timezone,rules,default_profile_version_id,legal_bundle_version,runtime_contract_id,runtime_contract_sha256,config_sha256,validated_at,activated_at,retired_at",
      )
      .eq("id", SEED.policy.id);

    expect(error).toBeNull();
    expect(data).toEqual([
      {
        id: SEED.policy.id,
        policy_key: SEED.policy.policyKey,
        version: SEED.policy.version,
        status: SEED.policy.status,
        timezone: SEED.policy.timezone,
        rules: SEED.policy.rules,
        default_profile_version_id: SEED.policy.defaultProfileVersionId,
        legal_bundle_version: SEED.policy.legalBundleVersion,
        runtime_contract_id: SEED.policy.runtimeContractId,
        runtime_contract_sha256: SEED.policy.runtimeContractSha256,
        config_sha256: SEED.policy.configSha256,
        validated_at: null,
        activated_at: null,
        retired_at: null,
      },
    ]);
    expect(JSON.stringify(data)).not.toContain("mimo");

    const row = data?.[0];
    expect({
      schemaVersion: "routing_policy_config_v1",
      policyKey: row?.policy_key,
      version: row?.version,
      timezone: row?.timezone,
      rules: row?.rules,
      defaultProfileVersionId: row?.default_profile_version_id,
      legalBundleVersion: row?.legal_bundle_version,
      runtimeContractId: row?.runtime_contract_id,
      runtimeContractSha256: row?.runtime_contract_sha256,
    }).toEqual(SEED.policy.jcsInput);
  });

  it("publishes the exact sealed owner-only runtime root, target, and membership", () => {
    const actual = parseOwnerJson(String.raw`
      select pg_catalog.jsonb_build_object(
        'fixture', pg_catalog.jsonb_build_object(
          'schemaVersion', 'service_runtime_contract_db_fixture_v1',
          'contract', (
            select pg_catalog.jsonb_build_object(
              'runtimeContractId', root.runtime_contract_id,
              'runtimeContractSha256', root.runtime_contract_sha256,
              'reviewedSourceCommitOid', root.reviewed_source_commit_oid,
              'legalBundleVersion', root.legal_bundle_version,
              'bundleContractSha256', root.bundle_contract_sha256,
              'runtimeTargetSetSha256', root.runtime_target_set_sha256
            )
            from public.ai_service_runtime_contract_versions as root
            where root.runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}'
          ),
          'targets', (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'runtimeTargetId', target.runtime_target_id,
                'runtimeTargetSha256', target.runtime_target_sha256,
                'profileVersionId', policy.default_profile_version_id,
                'profileKey', target.profile_key,
                'legalManifestId', target.legal_manifest_id,
                'manifestSha256', target.manifest_sha256,
                'routeDescriptorId', target.route_descriptor_id,
                'routeDescriptorSha256', target.route_descriptor_sha256
              ) order by target.runtime_target_id
            )
            from public.ai_service_runtime_target_versions as target
            cross join public.ai_routing_policy_versions as policy
            where target.runtime_target_id = '${SEED.runtime.targets[0].runtimeTargetId}'
              and policy.id = '${SEED.policy.id}'::uuid
          )
        ),
        'rootSealed', (
          select root.sealed_at is not null and root.sealed_at >= root.created_at
          from public.ai_service_runtime_contract_versions as root
          where root.runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}'
        ),
        'membershipCount', (
          select count(*)
          from public.ai_service_runtime_contract_targets as membership
          where membership.runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}'
        ),
        'membershipExact', exists (
          select 1
          from public.ai_service_runtime_contract_targets as membership
          where membership.runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}'
            and membership.runtime_contract_sha256 = '${SEED.runtime.contract.runtimeContractSha256}'
            and membership.runtime_target_id = '${SEED.runtime.targets[0].runtimeTargetId}'
            and membership.runtime_target_sha256 = '${SEED.runtime.targets[0].runtimeTargetSha256}'
            and membership.profile_key = '${SEED.runtime.targets[0].profileKey}'
            and membership.legal_manifest_id = '${SEED.runtime.targets[0].legalManifestId}'
            and membership.manifest_sha256 = '${SEED.runtime.targets[0].manifestSha256}'
            and membership.route_descriptor_id = '${SEED.runtime.targets[0].routeDescriptorId}'
            and membership.route_descriptor_sha256 = '${SEED.runtime.targets[0].routeDescriptorSha256}'
        )
      )::text;
    `);

    expect(actual).toEqual({
      fixture: SEED.runtime,
      rootSealed: true,
      membershipCount: 1,
      membershipExact: true,
    });
  });

  it("denies API-role runtime DML and freezes exact routine authority", () => {
    const security = parseOwnerJson(String.raw`
      select pg_catalog.jsonb_build_object(
        'privilegeCount', (
          select count(*)
          from (
            values ('anon'::text), ('authenticated'::text), ('service_role'::text)
          ) as role_name(name)
          cross join (
            values
              ('public.ai_service_runtime_contract_versions'::text),
              ('public.ai_service_runtime_target_versions'::text),
              ('public.ai_service_runtime_contract_targets'::text)
          ) as table_name(name)
          cross join (
            values ('SELECT'::text), ('INSERT'::text), ('UPDATE'::text), ('DELETE'::text)
          ) as privilege_name(name)
          where pg_catalog.has_table_privilege(
            role_name.name,
            table_name.name,
            privilege_name.name
          )
        ),
        'publicSecurityDefiners', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'schema', namespace.nspname,
              'name', procedure.proname,
              'identityArguments',
                pg_catalog.pg_get_function_identity_arguments(procedure.oid),
              'prokind', procedure.prokind,
              'definitionSha256', pg_catalog.encode(
                extensions.digest(
                  pg_catalog.pg_get_functiondef(procedure.oid),
                  'sha256'
                ),
                'hex'
              )
            )
            order by
              namespace.nspname,
              procedure.proname,
              pg_catalog.pg_get_function_identity_arguments(procedure.oid)
          )
          from pg_catalog.pg_proc as procedure
          join pg_catalog.pg_namespace as namespace
            on namespace.oid = procedure.pronamespace
          where namespace.nspname = 'public'
            and procedure.prokind in ('f', 'p')
            and procedure.prosecdef
        ), '[]'::jsonb),
        'publicExecuteRoutines', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'schema', namespace.nspname,
              'name', procedure.proname,
              'identityArguments',
                pg_catalog.pg_get_function_identity_arguments(procedure.oid),
              'prokind', procedure.prokind,
              'definitionSha256', pg_catalog.encode(
                extensions.digest(
                  pg_catalog.pg_get_functiondef(procedure.oid),
                  'sha256'
                ),
                'hex'
              )
            )
            order by
              namespace.nspname,
              procedure.proname,
              pg_catalog.pg_get_function_identity_arguments(procedure.oid)
          )
          from pg_catalog.pg_proc as procedure
          join pg_catalog.pg_namespace as namespace
            on namespace.oid = procedure.pronamespace
          where namespace.nspname = 'public'
            and procedure.prokind in ('f', 'p')
            and pg_catalog.pg_get_functiondef(procedure.oid) ~* '\mexecute\M'
        ), '[]'::jsonb),
        'runtimeRoutines', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'schema', namespace.nspname,
              'name', procedure.proname,
              'identityArguments',
                pg_catalog.pg_get_function_identity_arguments(procedure.oid),
              'prokind', procedure.prokind,
              'definitionSha256', pg_catalog.encode(
                extensions.digest(
                  pg_catalog.pg_get_functiondef(procedure.oid),
                  'sha256'
                ),
                'hex'
              )
            )
            order by
              namespace.nspname,
              procedure.proname,
              pg_catalog.pg_get_function_identity_arguments(procedure.oid)
          )
          from pg_catalog.pg_proc as procedure
          join pg_catalog.pg_namespace as namespace
            on namespace.oid = procedure.pronamespace
          where namespace.nspname = 'public'
            and procedure.prokind in ('f', 'p')
            and pg_catalog.strpos(
              pg_catalog.lower(pg_catalog.pg_get_functiondef(procedure.oid)),
              'ai_service_runtime_'
            ) > 0
        ), '[]'::jsonb),
        'nonSystemRoutineAuthority', (
          with routines as (
            select
              namespace.nspname as schema_name,
              procedure.proname as routine_name,
              pg_catalog.pg_get_function_identity_arguments(procedure.oid)
                as identity_arguments,
              procedure.prokind::text as prokind,
              procedure.prosecdef,
              pg_catalog.encode(
                extensions.digest(
                  pg_catalog.pg_get_functiondef(procedure.oid),
                  'sha256'
                ),
                'hex'
              ) as definition_sha256
            from pg_catalog.pg_proc as procedure
            join pg_catalog.pg_namespace as namespace
              on namespace.oid = procedure.pronamespace
            where namespace.nspname not in ('pg_catalog', 'information_schema')
              and namespace.nspname !~ '^pg_'
              and procedure.prokind in ('f', 'p')
          ),
          canonical as (
            select
              count(*) as routine_count,
              pg_catalog.string_agg(
                pg_catalog.octet_length(
                  pg_catalog.convert_to(schema_name, 'UTF8')
                )::text || ':' || schema_name || ':' ||
                pg_catalog.octet_length(
                  pg_catalog.convert_to(routine_name, 'UTF8')
                )::text || ':' || routine_name || ':' ||
                pg_catalog.octet_length(
                  pg_catalog.convert_to(identity_arguments, 'UTF8')
                )::text || ':' || identity_arguments || ':' ||
                prokind || ':' || prosecdef::text || ':' || definition_sha256,
                E'\n'
                order by
                  schema_name collate "C",
                  routine_name collate "C",
                  identity_arguments collate "C"
              ) as payload
            from routines
          )
          select pg_catalog.jsonb_build_object(
            'routineCount', routine_count,
            'authorityRootSha256',
              pg_catalog.encode(extensions.digest(payload, 'sha256'), 'hex')
          )
          from canonical
        )
      )::text;
    `);

    expect(security).toEqual({
      privilegeCount: 0,
      nonSystemRoutineAuthority: NON_SYSTEM_ROUTINE_AUTHORITY_ROOT_V1,
      publicExecuteRoutines: [],
      publicSecurityDefiners: PUBLIC_SECURITY_DEFINER_AUTHORITY_V1,
      runtimeRoutines: RUNTIME_ROUTINE_AUTHORITY_V1,
    });

    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const statement of [
        String.raw`insert into public.ai_service_runtime_contract_versions (
          runtime_contract_id,
          runtime_contract_sha256,
          reviewed_source_commit_oid,
          legal_bundle_version,
          bundle_contract_sha256,
          runtime_target_set_sha256
        ) values (
          'blocked.${role}',
          '${"0".repeat(64)}',
          'sha1:${"0".repeat(40)}',
          '${SEED.legalBundle.version}',
          '${SEED.legalBundle.contractSha256}',
          '${"0".repeat(64)}'
        );`,
        String.raw`update public.ai_service_runtime_contract_versions
          set sealed_at = sealed_at where false;`,
        String.raw`delete from public.ai_service_runtime_contract_targets
          where false;`,
      ]) {
        const denied = runOwnerSql(
          String.raw`
            \set ON_ERROR_STOP on
            begin;
            set local role ${role};
            ${statement}
            rollback;
          `,
          { expectFailure: true },
        );
        expect(denied.stderr).toMatch(/permission denied/u);
      }
    }
  });

  it("reapplies once as owner without changing any seeded byte projection", () => {
    const migrationPath = new URL(
      "../../../supabase/migrations/20260824002000_seed_deepseek_v2_draft.sql",
      import.meta.url,
    );
    const migration = readFileSync(migrationPath, "utf8");
    const before = snapshotSeedRows();

    runOwnerSql(migration);

    expect(snapshotSeedRows()).toBe(before);
  });

  it("rolls back the whole migration when an immutable seed fact conflicts", () => {
    const migrationPath = new URL(
      "../../../supabase/migrations/20260824002000_seed_deepseek_v2_draft.sql",
      import.meta.url,
    );
    const migrationBody = readFileSync(migrationPath, "utf8")
      .replace(/^begin;\s*$/mu, "")
      .replace(/^commit;\s*$/mu, "");
    const before = snapshotSeedRows();

    const conflict = runOwnerSql(
      String.raw`
        \set ON_ERROR_STOP on
        begin;
        alter table public.ai_provider_profile_versions
          disable trigger guard_ai_provider_profile_version;
        update public.ai_provider_profile_versions
        set model_snapshot = 'owner-corrupted-snapshot'
        where id = '${SEED.profile.profileVersionId}'::uuid;
        alter table public.ai_provider_profile_versions
          enable trigger guard_ai_provider_profile_version;

        ${migrationBody}
        rollback;
      `,
      { expectFailure: true },
    );

    expect(conflict.stderr).toContain("DeepSeek V2 profile version mismatch");
    expect(snapshotSeedRows()).toBe(before);
  });

  it("keeps the feature dark and availability on the exact disabled shape", async () => {
    const [featureResult, availabilityResult, requestCountResult, attemptCountResult] =
      await Promise.all([
        service
          .from("ai_feature_config")
          .select(
            "ai_polish_enabled,active_routing_policy_version_id,config_generation",
          )
          .eq("id", true)
          .single(),
        service.rpc("get_ai_polish_availability_v1", { p_user_id: null }),
        service
          .from("ai_request_ledger")
          .select("*", { count: "exact", head: true })
          .eq("routing_policy_version_id", SEED.policy.id),
        service
          .from("ai_provider_attempt_ledger")
          .select("*", { count: "exact", head: true })
          .eq("routing_policy_version_id", SEED.policy.id),
      ]);

    expect(featureResult.error).toBeNull();
    expect(featureResult.data).toMatchObject({
      ai_polish_enabled: false,
      active_routing_policy_version_id: null,
    });
    expect(Number(featureResult.data?.config_generation)).toBeGreaterThanOrEqual(0);
    expect(availabilityResult.error).toBeNull();
    expect(availabilityResult.data).toEqual(DISABLED_AVAILABILITY);
    expect(requestCountResult.error).toBeNull();
    expect(attemptCountResult.error).toBeNull();
    expect(requestCountResult.count).toBe(0);
    expect(attemptCountResult.count).toBe(0);
  });

  it("keeps the owner migration DML-only and outside every runtime data surface", () => {
    const migration = readFileSync(
      new URL(
        "../../../supabase/migrations/20260824002000_seed_deepseek_v2_draft.sql",
        import.meta.url,
      ),
      "utf8",
    ).toLowerCase();

    expect(migration.match(/^begin;$/gm)).toHaveLength(1);
    expect(migration.match(/^commit;$/gm)).toHaveLength(1);
    expect(migration).not.toMatch(/\bon\s+conflict\b/);
    expect(migration).not.toMatch(/\bcreate\s+(?:or\s+replace\s+)?function\b/);
    expect(migration).not.toMatch(/\bgrant\b/);
    expect(
      [...migration.matchAll(/\bupdate\s+public\.(ai_[a-z0-9_]+)/g)].map(
        (match) => match[1],
      ),
    ).toEqual(["ai_service_runtime_contract_versions"]);
    expect(migration).not.toMatch(
      /\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?(?:ai_feature_config|ai_request_ledger|ai_provider_attempt_ledger|ai_usage_daily|ai_global_usage_daily|ai_profile_usage_daily|ai_rate_minutes|user_terms_acceptances|ai_routing_policy_audit)\b/,
    );
  });
});

describe.skipIf(!RUN_DB_TESTS || !RUN_CFG001_FRESH_RESET)(
  "CFG-001 strict fresh-reset gate (real DB)",
  () => {
    it("has exact catalog cardinality, generation zero, and no dynamic history", () => {
      const actual = parseOwnerJson(String.raw`
        select pg_catalog.jsonb_build_object(
          'profiles', (select count(*) from public.ai_provider_profiles),
          'profileVersions', (
            select count(*) from public.ai_provider_profile_versions
          ),
          'prices', (select count(*) from public.ai_price_versions),
          'priceLanes', (
            select pg_catalog.jsonb_agg(pricing_lane order by pricing_lane)
            from public.ai_price_versions
          ),
          'components', (select count(*) from public.ai_price_components),
          'policies', (select count(*) from public.ai_routing_policy_versions),
          'runtimeRoots', (
            select count(*) from public.ai_service_runtime_contract_versions
          ),
          'runtimeTargets', (
            select count(*) from public.ai_service_runtime_target_versions
          ),
          'runtimeMemberships', (
            select count(*) from public.ai_service_runtime_contract_targets
          ),
          'legalHeaders', (select count(*) from public.ai_legal_bundle_versions),
          'legalManifests', (
            select count(*) from public.ai_legal_manifest_versions
          ),
          'legalMemberships', (
            select count(*) from public.ai_legal_bundle_manifests
          ),
          'feature', (
            select pg_catalog.jsonb_build_object(
              'enabled', ai_polish_enabled,
              'pointer', active_routing_policy_version_id,
              'generation', config_generation
            )
            from public.ai_feature_config
            where id = true
          ),
          'dynamicRows',
            (select count(*) from public.ai_request_ledger)
            + (select count(*) from public.ai_provider_attempt_ledger)
            + (select count(*) from public.ai_usage_daily)
            + (select count(*) from public.ai_global_usage_daily)
            + (select count(*) from public.ai_profile_usage_daily)
            + (select count(*) from public.ai_rate_minutes)
            + (select count(*) from public.user_terms_acceptances)
            + (select count(*) from public.ai_price_component_seal_intents)
            + (select count(*) from public.ai_routing_policy_transition_intents)
        )::text;
      `);

      expect(actual).toEqual({
        profiles: 1,
        profileVersions: 1,
        prices: 2,
        priceLanes: ["offpeak", "peak"],
        components: 6,
        policies: 1,
        runtimeRoots: 1,
        runtimeTargets: 1,
        runtimeMemberships: 1,
        legalHeaders: 1,
        legalManifests: 2,
        legalMemberships: 2,
        feature: { enabled: false, pointer: null, generation: 0 },
        dynamicRows: 0,
      });
    });
  },
);
