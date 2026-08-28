import { readFileSync } from "node:fs";

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { DEEPSEEK_V2_SEED_V1 } from "@/server/polish/deepseek-v2-seed-v1";

import {
  acceptAiLegalBundle,
  createServiceClient,
  createTestUser,
  deleteTestUser,
  RUN_DB_TESTS,
  setDailyUsageCount,
} from "./helpers";
import { runOwnerSql } from "./runtime-contract-fixtures";

const SEED = DEEPSEEK_V2_SEED_V1;
const DB012_LEGACY_PRICE_ID = "11111111-1111-4111-8111-111111111114";
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

describe("CFG-001 successor-compatible membership source", () => {
  it("scopes membership cardinality to the legacy root while retaining exact tuple checks", () => {
    const source = readFileSync(
      new URL("../../../supabase/migrations/20260824002000_seed_deepseek_v2_draft.sql", import.meta.url),
      "utf8",
    );
    expect(source).toContain("where runtime_contract_id = 'runtime.deepseek-v2.v1';");
    expect(source).not.toContain("runtime_contract_id = 'runtime.deepseek-v2.v1'\n     or runtime_target_id");
    expect(source).toContain("and runtime_target_id =\n        'runtime-target.deepseek.official.deepseek-v4-flash.chat.v1'");
  });
});

// PostgreSQL preserves migration-source line endings inside stored routine
// bodies. Canonicalize them before hashing so the authority oracle is stable
// across Windows worktrees and Linux CI checkouts.
const CANONICAL_ROUTINE_DEFINITION_SQL = String.raw`
  pg_catalog.replace(
    pg_catalog.replace(
      pg_catalog.pg_get_functiondef(procedure.oid),
      pg_catalog.chr(13) || pg_catalog.chr(10),
      pg_catalog.chr(10)
    ),
    pg_catalog.chr(13),
    pg_catalog.chr(10)
  )
`;

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
  "ai_routing_lifecycle_audit",
] as const;

const PUBLIC_SECURITY_DEFINER_AUTHORITY_V1 = [
  {
    schema: "public",
    name: "apply_ai_price_component_seal_intent",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "10ca00a60c2ae09b09b41823b81a8cb79cc64fee524a759140ebbc664c81c513",
  },
  {
    schema: "public",
    name: "assert_ai_routing_lifecycle_evidence_v1",
    identityArguments:
      "p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text, p_at timestamp with time zone",
    prokind: "f",
    definitionSha256: "b5b15e28bd2a99cf72d44e83a342e7f0aed90598c03a1d56efa962f5e5e038d5",
  },
  {
    schema: "public",
    name: "assert_ai_routing_lifecycle_no_policy_reference_v1",
    identityArguments:
      "p_reference_kind text, p_reference_id uuid, p_at timestamp with time zone",
    prokind: "f",
    definitionSha256: "1cf9ce369399ea92397ced502b4c235a4c33ad72bd6228ac3e809743e2204fd7",
  },
  {
    schema: "public",
    name: "assert_ai_routing_lifecycle_runtime_profile_coverage_v1",
    identityArguments:
      "p_runtime_contract_id text, p_runtime_contract_sha256 text, p_profile_id uuid, p_profile_version_id uuid",
    prokind: "f",
    definitionSha256: "4bed4391f10c5ced3133a5ee4247fa5aa1aa5654563ff2e8545f14993dadf270",
  },
  {
    schema: "public",
    name: "assert_ai_routing_lifecycle_selected_price_evidence_v1",
    identityArguments:
      "p_policy ai_routing_policy_versions, p_rechecked_at timestamp with time zone",
    prokind: "f",
    definitionSha256: "ce3a4e1c4555c436a1da7910869c4ad6af8fbd43cfa0e826be34029e3075182c",
  },
  {
    schema: "public",
    name: "assert_ai_routing_policy_v1",
    identityArguments: "p_policy_id uuid, p_phase text, p_at timestamp with time zone",
    prokind: "f",
    definitionSha256: "ef3bd23e0774dc4113c468038ef87632c75fd107e0ea98c36b088589e5adde84",
  },
  {
    schema: "public",
    name: "backfill_deepseek_legacy_pricing_v1",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "0b42f2bb7f347fd0f9a0070a43b110faf283a28ed6bb31233299bcd006396e27",
  },
  {
    schema: "public",
    name: "clear_ai_routing_policy_pointer_v1",
    identityArguments:
      "p_expected_policy_version_id uuid, p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
    prokind: "f",
    definitionSha256: "f8d952bfd7949a9ce4819c1bf16dfa2e1f909a508bf6d215795c73da6a74a472",
  },
  {
    schema: "public",
    name: "close_ai_price_version_v1",
    identityArguments:
      "p_price_version_id uuid, p_valid_to timestamp with time zone, p_successor_price_version_id uuid, p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
    prokind: "f",
    definitionSha256: "347da82eee1a9bc0a5dd9769aff321c7e2a878e35203e73793e0ca4d495e15eb",
  },
  {
    schema: "public",
    name: "complete_ai_polish_provider_attempt",
    identityArguments:
      "p_attempt_id uuid, p_status text, p_transmitted boolean, p_retry_eligible boolean, p_provider_billable boolean, p_usage jsonb, p_route jsonb, p_cost jsonb, p_metadata jsonb",
    prokind: "f",
    definitionSha256: "c02db99e3f9aaa59709e33f9331353ca223d1282010167117412b374817ed7f2",
  },
  {
    schema: "public",
    name: "complete_ai_polish_provider_attempt_internal",
    identityArguments:
      "p_attempt_id uuid, p_status text, p_provider_billable boolean, p_usage jsonb, p_route jsonb, p_cost jsonb, p_metadata jsonb",
    prokind: "f",
    definitionSha256: "5aa682c20a0b3a2ed8d326f513133eaace14b817d48049ff80d0c20df1885aa2",
  },
  {
    schema: "public",
    name: "complete_ai_polish_provider_attempt_transmission_internal",
    identityArguments:
      "p_attempt_id uuid, p_status text, p_transmitted boolean, p_provider_billable boolean, p_usage jsonb, p_route jsonb, p_cost jsonb, p_metadata jsonb",
    prokind: "f",
    definitionSha256: "915ee6c12124aff544de304dcf125af03b49953be8b1476dd7002af0ce3e9e40",
  },
  {
    schema: "public",
    name: "create_ai_routing_policy_version_v1",
    identityArguments:
      "p_policy_version_id uuid, p_policy_key text, p_version integer, p_timezone text, p_rules jsonb, p_default_profile_version_id uuid, p_legal_bundle_version text, p_config_sha256 text, p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
    prokind: "f",
    definitionSha256: "a9cdf7609cd5848b6fd6f616d42c1527adde2ea4b70329bf9f9409063a484989",
  },
  {
    schema: "public",
    name: "derive_ai_polish_v2_settlement",
    identityArguments: "p_reservation_id uuid",
    prokind: "f",
    definitionSha256: "0b8b0fcd618810600af3cd5ac9df5d936ed88434740f695784499b3abe546f40",
  },
  {
    schema: "public",
    name: "derive_ai_polish_v2_settlement_sequence",
    identityArguments: "p_reservation_id uuid, p_allow_open_retry boolean",
    prokind: "f",
    definitionSha256: "533bb3d49c8f62331911110d508840d06e6c460306f67d08979fbd1a925d495d",
  },
  {
    schema: "public",
    name: "finalize_ai_polish_request",
    identityArguments:
      "p_reservation_id uuid, p_status text, p_quota_charged boolean, p_provider_billable boolean, p_usage jsonb, p_metadata jsonb",
    prokind: "f",
    definitionSha256: "81b64314a12b5bd4922c3447d1b1c911720eac873e85f3882c7ff87098e4f69b",
  },
  {
    schema: "public",
    name: "finalize_ai_polish_request",
    identityArguments:
      "p_reservation_id uuid, p_status text, p_quota_charged boolean, p_provider_billable boolean, p_usage jsonb, p_metadata jsonb, p_settlement_contract text",
    prokind: "f",
    definitionSha256: "856254405c81071e2184e95eb269b8146bb8cb35b2400a62364dd9ab49f1e5c5",
  },
  {
    schema: "public",
    name: "get_ai_polish_availability_v1",
    identityArguments: "p_user_id uuid",
    prokind: "f",
    definitionSha256: "ea512419dfe6b8461d982f5fa860d813f19f6b0f7f5abdfb40e74cb71a803c3a",
  },
  {
    schema: "public",
    name: "get_ai_polish_execution_snapshot_v1",
    identityArguments: "p_reservation_id uuid, p_user_id uuid",
    prokind: "f",
    definitionSha256: "8e4437200dd8ca30480823aa9085a95a472f7500da29cdcbed9c7feb92feca4b",
  },
  {
    schema: "public",
    name: "guard_ai_feature_routing_pointer",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "0bc7eea658d3b45985a62cbeaee224b8fe9bc923302bcec582e8f3da2ce910f0",
  },
  {
    schema: "public",
    name: "guard_ai_price_version",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "ee3cec39edacae62ab7ee09b645bb6eeec38cc1cb545b7b4aa66abb12b05c016",
  },
  {
    schema: "public",
    name: "guard_ai_routing_lifecycle_audit",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "43923b85c83d5dc1043e03f656fe722211c375a5f2eed712e718cc0d70484c9c",
  },
  {
    schema: "public",
    name: "guard_ai_routing_policy_version",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "94e7d401da5f6fad9fcc5246b9652be44b5da4463517e33a6daf23cd94226bfe",
  },
  {
    schema: "public",
    name: "has_accepted_ai_legal_bundle",
    identityArguments: "p_user_id uuid, p_legal_bundle_version text",
    prokind: "f",
    definitionSha256: "1597268586acda1baa3c67cd25ae3dd5aad3f1e6a1a426ee3603934583eebe82",
  },
  {
    schema: "public",
    name: "insert_ai_routing_lifecycle_audit_v1",
    identityArguments:
      "p_operation text, p_policy uuid, p_profile uuid, p_profile_version uuid, p_price uuid, p_from text, p_to text, p_old_pointer uuid, p_new_pointer uuid, p_old_generation bigint, p_new_generation bigint, p_old_retired timestamp with time zone, p_new_retired timestamp with time zone, p_old_valid_to timestamp with time zone, p_new_valid_to timestamp with time zone, p_runtime_id text, p_runtime_hash text, p_actor text, p_reason text, p_commit text, p_source_hash text, p_rechecked timestamp with time zone, p_rechecked_hash text, p_at timestamp with time zone",
    prokind: "f",
    definitionSha256: "250e81ad9f6bdcc492657b4ced2b4507dc626e3dbda20ad748543855d054ab70",
  },
  {
    schema: "public",
    name: "lock_ai_routing_lifecycle_profile_prices_v1",
    identityArguments:
      "p_profile_id uuid, p_profile_version_id uuid, p_rechecked_at timestamp with time zone",
    prokind: "f",
    definitionSha256: "ea0a1c122e2fa5ac47b49dc0e64b47a05d386282474c0214172beb3b9a4a930e",
  },
  {
    schema: "public",
    name: "lock_and_validate_ai_routing_policy_row_v1",
    identityArguments:
      "p_policy ai_routing_policy_versions, p_phase text, p_at timestamp with time zone",
    prokind: "f",
    definitionSha256: "92617a394ef308accb16df1f9164b6e5293561ca8a8f44aa350aef07bc6aa35c",
  },
  {
    schema: "public",
    name: "reconcile_stale_ai_polish_reservations",
    identityArguments: "p_stale_after interval",
    prokind: "f",
    definitionSha256: "71c9e2f95b170ef60687f55cc77fdd54a6c53d42a82b3b9d7b463f2fe650668d",
  },
  {
    schema: "public",
    name: "record_ai_polish_request_cancellation",
    identityArguments: "p_reservation_id uuid, p_observation text",
    prokind: "f",
    definitionSha256: "6f3252ead83e935073252e369eb42e9e9bcefe73c64dbfa47f71b6ee16a2d0c1",
  },
  {
    schema: "public",
    name: "reserve_ai_polish_request_v2",
    identityArguments:
      "p_user_id uuid, p_request_id uuid, p_client_request_id uuid, p_expected_route jsonb",
    prokind: "f",
    definitionSha256: "5169d98f59e2df890327f808729a8f903402abffc68dd0ace11ef16f7f3a03a8",
  },
  {
    schema: "public",
    name: "retire_ai_provider_profile_v1",
    identityArguments:
      "p_profile_id uuid, p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
    prokind: "f",
    definitionSha256: "56af669a146104dc46c1f311ba47a619a6ee56c7fb5250cc78036e58e0f52afa",
  },
  {
    schema: "public",
    name: "retire_ai_provider_profile_version_v1",
    identityArguments:
      "p_profile_version_id uuid, p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
    prokind: "f",
    definitionSha256: "4d3f34fa51b097428a1e314472ea7635ae7ef6c918fab1d7c946a549cef87a7a",
  },
  {
    schema: "public",
    name: "seal_ai_price_components_v1",
    identityArguments: "p_price_version_ids uuid[], p_sealed_at timestamp with time zone",
    prokind: "f",
    definitionSha256: "de113bdd7774f43788668189a77c7e8a9d0ae35027fca015289858b6e10cd0b8",
  },
  {
    schema: "public",
    name: "seal_ai_price_for_activation_v1",
    identityArguments:
      "p_price_version_id uuid, p_rechecked_source_url text, p_rechecked_currency text, p_rechecked_calculator_kind text, p_rechecked_provider_effective_from timestamp with time zone, p_rechecked_provider_effective_to timestamp with time zone, p_rechecked_parameters jsonb, p_rechecked_components jsonb, p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
    prokind: "f",
    definitionSha256: "eec1807a501a4ddd66a1bbaff6d9a08720b4c1fb3bc2a799862e3b5d1b233973",
  },
  {
    schema: "public",
    name: "set_ai_routing_policy_pointer_v1",
    identityArguments:
      "p_policy_version_id uuid, p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
    prokind: "f",
    definitionSha256: "0cc317a282cee35d5350b8b37204c92274e1ee9802f857eed7397203ab0845d2",
  },
  {
    schema: "public",
    name: "start_ai_polish_provider_attempt",
    identityArguments: "p_reservation_id uuid, p_attempt_no integer",
    prokind: "f",
    definitionSha256: "7889dad2f1b2682906b661c1e2c42f2588d052503890741c8b2188c0b0e0c84c",
  },
  {
    schema: "public",
    name: "start_ai_polish_provider_attempt_internal",
    identityArguments: "p_reservation_id uuid, p_attempt_no integer",
    prokind: "f",
    definitionSha256: "b85eaf0b99283ac1bbf4a8a32180267c2dc925aa9e6b13c9191546ff69173a63",
  },
  {
    schema: "public",
    name: "transition_ai_provider_profile_version_v1",
    identityArguments:
      "p_profile_version_id uuid, p_to_status text, p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
    prokind: "f",
    definitionSha256: "900c1ac63d6903657ba9e555484b56709a74db1c8a0fbdf651331fa579ecf865",
  },
  {
    schema: "public",
    name: "transition_ai_routing_policy_v1",
    identityArguments: "p_policy_id uuid, p_to_status text",
    prokind: "f",
    definitionSha256: "568c239938f224dcbcbad1c1494872310bf75868adc7c015eea638c5f5c49f86",
  },
  {
    schema: "public",
    name: "transition_ai_routing_policy_v2",
    identityArguments:
      "p_policy_version_id uuid, p_to_status text, p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
    prokind: "f",
    definitionSha256: "4790e307474754d8344c46cdde54a2e42b0256e7ac78dd31bf1985f4144329e2",
  },
  {
    schema: "public",
    name: "validate_ai_routing_policy_transition_v1",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "b69ce2f4337deaa9e751104fd71fc099a3e1187dc676565117e7ba554cf19515",
  },
] as const;

const RUNTIME_ROUTINE_AUTHORITY_V1 = [
  {
    schema: "public",
    name: "assert_ai_routing_lifecycle_evidence_v1",
    identityArguments:
      "p_runtime_contract_id text, p_runtime_contract_sha256 text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text, p_at timestamp with time zone",
    prokind: "f",
    definitionSha256: "b5b15e28bd2a99cf72d44e83a342e7f0aed90598c03a1d56efa962f5e5e038d5",
  },
  {
    schema: "public",
    name: "assert_ai_routing_lifecycle_runtime_profile_coverage_v1",
    identityArguments:
      "p_runtime_contract_id text, p_runtime_contract_sha256 text, p_profile_id uuid, p_profile_version_id uuid",
    prokind: "f",
    definitionSha256: "4bed4391f10c5ced3133a5ee4247fa5aa1aa5654563ff2e8545f14993dadf270",
  },
  {
    schema: "public",
    name: "get_ai_polish_availability_v1",
    identityArguments: "p_user_id uuid",
    prokind: "f",
    definitionSha256: "ea512419dfe6b8461d982f5fa860d813f19f6b0f7f5abdfb40e74cb71a803c3a",
  },
  {
    schema: "public",
    name: "get_ai_polish_execution_snapshot_v1",
    identityArguments: "p_reservation_id uuid, p_user_id uuid",
    prokind: "f",
    definitionSha256: "8e4437200dd8ca30480823aa9085a95a472f7500da29cdcbed9c7feb92feca4b",
  },
  {
    schema: "public",
    name: "guard_ai_service_runtime_contract_target",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "604900a91d7c533e5591680102ac3eadc2867e8fb9244470f6f63ffe15c13a90",
  },
  {
    schema: "public",
    name: "guard_ai_service_runtime_contract_version",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "b6f45cdfc018755f7e9967d35c826aefb0a50de624b5abd8dad55bc32205312b",
  },
  {
    schema: "public",
    name: "guard_ai_service_runtime_target_version",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "a5651295f8a87bdabc7ca8b98c2f876ebaab48f71e9d0d6890b431246a7bbb99",
  },
  {
    schema: "public",
    name: "lock_and_validate_ai_routing_policy_row_v1",
    identityArguments:
      "p_policy ai_routing_policy_versions, p_phase text, p_at timestamp with time zone",
    prokind: "f",
    definitionSha256: "92617a394ef308accb16df1f9164b6e5293561ca8a8f44aa350aef07bc6aa35c",
  },
  {
    schema: "public",
    name: "reserve_ai_polish_request_v2",
    identityArguments:
      "p_user_id uuid, p_request_id uuid, p_client_request_id uuid, p_expected_route jsonb",
    prokind: "f",
    definitionSha256: "5169d98f59e2df890327f808729a8f903402abffc68dd0ace11ef16f7f3a03a8",
  },
  {
    schema: "public",
    name: "validate_ai_routing_policy_row_v1",
    identityArguments:
      "p_policy ai_routing_policy_versions, p_phase text, p_at timestamp with time zone, p_discovery_only boolean",
    prokind: "f",
    definitionSha256: "3aae3b2fdfbc99198a77a373d622691aec929d0254a2ac1d318f87bcfaa6f2f3",
  },
] as const;

// This root includes DB-013 migration 20260824004000's controlled lifecycle
// routines and DB003C migration 20260824005000's authorized replacement of the
// sole assert_ai_price_structure_v1(uuid) body.
const NON_SYSTEM_ROUTINE_AUTHORITY_ROOT_V1 = {
  routineCount: 375,
  authorityRootSha256:
    "cbb3189183921a35b662869bb2226d8162380022c183115d78c906928c408244",
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

function seedSnapshotSql(marker = ""): string {
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
  return String.raw`
    \set ON_ERROR_STOP on
    \pset format unaligned
    \pset tuples_only on
    select '${marker}' || pg_catalog.jsonb_build_object(${catalogPairs})::text;
  `;
}

function snapshotSeedRows(): string {
  const result = runOwnerSql(seedSnapshotSql());
  const snapshot = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) => line.startsWith("{"));
  if (!snapshot) throw new Error("seed snapshot returned no JSON");
  return snapshot;
}

const MIGRATION_URL = new URL(
  "../../../supabase/migrations/20260824002000_seed_deepseek_v2_draft.sql",
  import.meta.url,
);

function migrationBody(): string {
  return readFileSync(MIGRATION_URL, "utf8")
    .replace(/^begin;\s*$/mu, "")
    .replace(/^commit;\s*$/mu, "");
}

function withUserTriggersDisabled(tables: readonly string[], body: string): string {
  // CFG-001 hostile cleanups that remove canonical prices may subsequently
  // remove the profile version.  DB-012 adds a sealed legacy child graph, so
  // remove its seal intent/components/price first inside the same replica
  // boundary; the enclosing rollback restores the exact catalog snapshot.
  const db012LegacyCleanup = body.includes("delete from public.ai_price_versions")
    ? String.raw`
      set local session_replication_role = replica;
      delete from public.ai_price_component_seal_intents
      where price_version_id = '${DB012_LEGACY_PRICE_ID}'::uuid;
      delete from public.ai_price_components
      where price_version_id = '${DB012_LEGACY_PRICE_ID}'::uuid;
      delete from public.ai_price_versions
      where id = '${DB012_LEGACY_PRICE_ID}'::uuid;
      set local session_replication_role = origin;
    `
    : "";
  return [
    ...tables.map((table) => `alter table public.${table} disable trigger user;`),
    db012LegacyCleanup,
    body,
    ...[...tables]
      .reverse()
      .map((table) => `alter table public.${table} enable trigger user;`),
  ].join("\n");
}

function moveCanonicalFixedId(
  table:
    | "ai_provider_profiles"
    | "ai_provider_profile_versions"
    | "ai_price_versions"
    | "ai_routing_policy_versions",
  canonicalId: string,
  alternateId: string,
): string {
  return String.raw`
    set local session_replication_role = replica;
    update public.${table}
    set id = '${alternateId}'::uuid
    where id = '${canonicalId}'::uuid;
    set local session_replication_role = origin;
  `;
}

interface HostileSeedCase {
  name: string;
  precondition: string;
  expectedError: string;
  expectedNotice?: string;
}

const HISTORICAL_COVERAGE_TABLES = [
  "ai_request_ledger",
  "ai_provider_attempt_ledger",
  "ai_usage_daily",
  "ai_global_usage_daily",
  "ai_profile_usage_daily",
  "ai_rate_minutes",
  "user_terms_acceptances",
  "ai_legal_bundle_versions",
  "ai_legal_manifest_versions",
  "ai_legal_bundle_manifests",
  "ai_provider_profiles",
  "ai_provider_profile_versions",
  "ai_price_versions",
  "ai_routing_policy_versions",
  "ai_service_runtime_contract_versions",
  "ai_service_runtime_target_versions",
  "ai_service_runtime_contract_targets",
] as const;

function parseMarkedSnapshot(stdout: string, marker: string): string {
  const snapshot = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith(marker));
  if (!snapshot) throw new Error(`seed snapshot marker ${marker} was not emitted`);
  return snapshot.slice(marker.length);
}

function expectHistoricalCoverage(snapshot: string, caseName: string, userId: string): void {
  const catalog = JSON.parse(snapshot) as Record<string, unknown>;
  for (const table of HISTORICAL_COVERAGE_TABLES) {
    expect(Array.isArray(catalog[table]), `${caseName}: ${table} must be an array`).toBe(
      true,
    );
    expect(catalog[table], `${caseName}: ${table} must retain historical coverage`).not.toHaveLength(
      0,
    );
  }

  const rows = (table: (typeof HISTORICAL_COVERAGE_TABLES)[number]): Record<string, unknown>[] =>
    catalog[table] as Record<string, unknown>[];
  const profileId = "44444444-4444-4444-8444-444444444410";
  const profileVersionId = "44444444-4444-4444-8444-444444444411";
  const priceVersionId = "44444444-4444-4444-8444-444444444412";
  const policyId = "44444444-4444-4444-8444-444444444413";

  expect(rows("ai_provider_profiles")).toContainEqual(
    expect.objectContaining({ id: profileId, profile_key: "history.cfg001.rollback.v1" }),
  );
  expect(rows("ai_provider_profile_versions")).toContainEqual(
    expect.objectContaining({ id: profileVersionId, profile_id: profileId }),
  );
  expect(rows("ai_price_versions")).toContainEqual(
    expect.objectContaining({ id: priceVersionId, profile_version_id: profileVersionId }),
  );
  expect(rows("ai_routing_policy_versions")).toContainEqual(
    expect.objectContaining({ id: policyId, default_profile_version_id: profileVersionId }),
  );
  expect(rows("ai_service_runtime_target_versions")).toContainEqual(
    expect.objectContaining({ runtime_target_id: "history-runtime-target.cfg001.v1" }),
  );
  expect(rows("ai_service_runtime_contract_versions")).toContainEqual(
    expect.objectContaining({ runtime_contract_id: "history-runtime-contract.cfg001.v1" }),
  );
  expect(rows("ai_service_runtime_contract_targets")).toContainEqual(
    expect.objectContaining({
      runtime_contract_id: "history-runtime-contract.cfg001.v1",
      runtime_target_id: "history-runtime-target.cfg001.v1",
    }),
  );

  const requests = rows("ai_request_ledger");
  const request = requests.find((row) => row.user_id === userId);
  expect(request, `${caseName}: historical request must belong to the current fixture user`).toBeDefined();
  expect(rows("ai_provider_attempt_ledger")).toContainEqual(
    expect.objectContaining({ reservation_id: request?.reservation_id, attempt_no: 1 }),
  );
  expect(rows("ai_usage_daily")).toContainEqual(
    expect.objectContaining({ user_id: userId, request_count: 7 }),
  );
  expect(rows("ai_global_usage_daily")).toContainEqual(
    expect.objectContaining({ provider_started_count: 3 }),
  );
  expect(rows("ai_profile_usage_daily")).toContainEqual(
    expect.objectContaining({
      profile_version_id: profileVersionId,
      billing_currency: "CNY",
      request_count: 2,
      cost_incomplete_count: 2,
      known_estimated_cost_nanos: 0,
      estimated_cost_nanos: null,
    }),
  );
  expect(rows("ai_rate_minutes")).toContainEqual(
    expect.objectContaining({ user_id: userId, count: 5 }),
  );
  // Legal manifest/bundle rows are CFG-000 global legal authority, not CFG-001
  // identity. The current fixture's historical legal row is its user acceptance.
  expect(rows("user_terms_acceptances")).toContainEqual(
    expect.objectContaining({
      user_id: userId,
      document_key: "ai_terms",
      version: "2026-08-23-multi-provider-v1",
    }),
  );
}

function historicalFixtureSql(userId: string): string {
  return String.raw`
    -- The synthetic history catalog deliberately uses no CFG001 identity, so
    -- its request/attempt/profile-daily foreign keys survive CFG graph deletion.
    set local session_replication_role = replica;
    insert into public.ai_provider_profiles (
      id, profile_key, display_name, gateway_kind, model_vendor
    ) values (
      '44444444-4444-4444-8444-444444444410'::uuid,
      'history.cfg001.rollback.v1',
      'Historical rollback fixture',
      'direct_deepseek',
      'history'
    );
    insert into public.ai_provider_profile_versions (
      id, profile_id, version, status, adapter_kind, wire_api_kind,
      credential_alias, endpoint_alias, model_id, upstream_route,
      capability_contract_id, cache_policy_id, legal_manifest_id,
      display_disclosure_key, config, config_sha256
    ) values (
      '44444444-4444-4444-8444-444444444411'::uuid,
      '44444444-4444-4444-8444-444444444410'::uuid,
      1, 'draft', 'deepseek_chat_v1', 'chat_completions_v1',
      'history_credential', 'history_endpoint', 'history-model', '{}'::jsonb,
      'history_capability', 'history_cache', 'deepseek-official-2026-08-23-v1',
      'history-disclosure', '{}'::jsonb, repeat('4', 64)
    );
    insert into public.ai_price_versions (
      id, profile_version_id, version, currency, calculator_kind, valid_from,
      source_url, source_checked_at, source_snapshot_sha256, pricing_lane
    ) values (
      '44444444-4444-4444-8444-444444444412'::uuid,
      '44444444-4444-4444-8444-444444444411'::uuid,
      1, 'CNY', 'linear_token_v1', '2020-01-01T00:00:00Z'::timestamptz,
      'https://history.invalid/price', '2020-01-01T00:00:00Z'::timestamptz,
      repeat('5', 64), 'default'
    );
    insert into public.ai_service_runtime_target_versions (
      runtime_target_id, runtime_target_sha256, profile_key, legal_manifest_id,
      manifest_sha256, route_descriptor_id, route_descriptor_sha256
    ) values (
      'history-runtime-target.cfg001.v1', repeat('6', 64),
      'history.cfg001.rollback.v1', 'deepseek-official-2026-08-23-v1',
      '0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b',
      'history-route.cfg001.v1', repeat('7', 64)
    );
    insert into public.ai_service_runtime_contract_versions (
      runtime_contract_id, runtime_contract_sha256, reviewed_source_commit_oid,
      legal_bundle_version, bundle_contract_sha256, runtime_target_set_sha256,
      sealed_at
    ) values (
      'history-runtime-contract.cfg001.v1', repeat('8', 64),
      'sha1:0123456789abcdef0123456789abcdef01234567',
      '2026-08-23-multi-provider-v1',
      'fc26d1e1a016fda055fbe6a0b79b48d804fd7610e03bd5aa29389be37359ca18',
      repeat('9', 64), clock_timestamp()
    );
    insert into public.ai_service_runtime_contract_targets (
      runtime_contract_id, runtime_contract_sha256, runtime_target_id,
      runtime_target_sha256, profile_key, legal_manifest_id, manifest_sha256,
      route_descriptor_id, route_descriptor_sha256
    ) values (
      'history-runtime-contract.cfg001.v1', repeat('8', 64),
      'history-runtime-target.cfg001.v1', repeat('6', 64),
      'history.cfg001.rollback.v1', 'deepseek-official-2026-08-23-v1',
      '0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b',
      'history-route.cfg001.v1', repeat('7', 64)
    );
    insert into public.ai_routing_policy_versions (
      id, policy_key, version, status, timezone, rules,
      default_profile_version_id, legal_bundle_version, config_sha256,
      runtime_contract_id, runtime_contract_sha256
    ) values (
      '44444444-4444-4444-8444-444444444413'::uuid,
      'history.cfg001.rollback.v1', 1, 'draft', 'Asia/Shanghai',
      '{}'::jsonb, '44444444-4444-4444-8444-444444444411'::uuid,
      '2026-08-23-multi-provider-v1', repeat('a', 64),
      'history-runtime-contract.cfg001.v1', repeat('8', 64)
    );
    insert into public.user_terms_acceptances (user_id, document_key, version)
    values ('${userId}'::uuid, 'ai_terms', '2026-08-23-multi-provider-v1');
    insert into public.ai_usage_daily (user_id, day, request_count)
    values ('${userId}'::uuid, current_date, 7);
    insert into public.ai_global_usage_daily (day, provider_started_count)
    values (current_date, 3)
    on conflict (day) do update set provider_started_count = excluded.provider_started_count;
    insert into public.ai_profile_usage_daily (
      day, profile_version_id, billing_currency, request_count,
      cost_incomplete_count, known_estimated_cost_nanos, estimated_cost_nanos
    ) values (
      current_date, '44444444-4444-4444-8444-444444444411'::uuid, 'CNY', 2,
      2, 0, null
    );
    insert into public.ai_rate_minutes (user_id, minute_bucket, count)
    values ('${userId}'::uuid, date_trunc('minute', clock_timestamp()), 5);
    insert into public.ai_request_ledger (request_id, client_request_id, user_id)
    values (extensions.gen_random_uuid(), extensions.gen_random_uuid(), '${userId}'::uuid)
    returning reservation_id \gset history_request_
    insert into public.ai_provider_attempt_ledger (
      reservation_id, attempt_no, route_schema_version, config_generation,
      routing_policy_version_id, profile_version_id, price_version_id,
      legal_bundle_version, runtime_contract_id, runtime_contract_sha256,
      gateway_kind, model_id, wire_api_kind, display_disclosure_key,
      adapter_kind, credential_alias, endpoint_alias, capability_contract_id,
      cache_policy_id, legal_manifest_id, calculator_kind, billing_currency
    ) values (
      :'history_request_reservation_id'::uuid, 1, 'route_snapshot_v1', 1,
      '44444444-4444-4444-8444-444444444413'::uuid,
      '44444444-4444-4444-8444-444444444411'::uuid,
      '44444444-4444-4444-8444-444444444412'::uuid,
      '2026-08-23-multi-provider-v1', 'history-runtime-contract.cfg001.v1',
      repeat('8', 64), 'direct_deepseek', 'history-model',
      'chat_completions_v1', 'history-disclosure', 'deepseek_chat_v1',
      'history_credential', 'history_endpoint', 'history_capability',
      'history_cache', 'deepseek-official-2026-08-23-v1', 'linear_token_v1', 'CNY'
    );
    set local session_replication_role = origin;
  `;
}

async function expectHostileSeedRollback(service: SupabaseClient, {
  precondition,
  expectedError,
  expectedNotice,
}: HostileSeedCase): Promise<void> {
  const user = await createTestUser(service, "cfg001-hostile-history");
  try {
    const result = runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      \set VERBOSITY verbose
      \pset format unaligned
      \pset tuples_only on
      begin;
      ${historicalFixtureSql(user.id)}
      ${precondition}
      ${seedSnapshotSql("CFG001_HOSTILE_BEFORE=")}
      savepoint cfg001_migration_body;
      \set ON_ERROR_STOP off
      ${migrationBody()}
      \set ON_ERROR_STOP on
      rollback to savepoint cfg001_migration_body;
      ${seedSnapshotSql("CFG001_HOSTILE_AFTER=")}
      rollback;
    `);

    expect(result.stderr).toContain(expectedError);
    expect(result.stderr).toMatch(/ERROR:\s+23514:/u);
    if (expectedNotice) expect(result.stderr).toContain(expectedNotice);

    const before = parseMarkedSnapshot(result.stdout, "CFG001_HOSTILE_BEFORE=");
    const after = parseMarkedSnapshot(result.stdout, "CFG001_HOSTILE_AFTER=");
    expectHistoricalCoverage(before, expectedError, user.id);
    expect(after).toBe(before);
  } finally {
    await deleteTestUser(service, user.id);
  }
}

async function createHistoricalFixture(service: SupabaseClient): Promise<string> {
  const user = await createTestUser(service, "cfg001-history");
  try {
    await acceptAiLegalBundle(service, user.id, SEED.legalBundle.version);
    await setDailyUsageCount(service, user.id, 7);
    const { error } = await service.from("ai_request_ledger").insert({
      request_id: crypto.randomUUID(),
      client_request_id: crypto.randomUUID(),
      user_id: user.id,
    });
    if (error) throw new Error(`create CFG001 request fixture failed: ${error.message}`);
    return user.id;
  } catch (error) {
    await deleteTestUser(service, user.id);
    throw error;
  }
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

  it("publishes exact current and deterministic legacy CNY price lanes", async () => {
    const priceIds = [...SEED.pricing.rows.map((row) => row.id), DB012_LEGACY_PRICE_ID];
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
    expect(pricesResult.data).toHaveLength(3);

    for (const row of pricesResult.data ?? []) {
      const expected = SEED.pricing.rows.find(
        (candidate) => candidate.id === row.id,
      );
      if (row.id === DB012_LEGACY_PRICE_ID) {
        expect(row).toMatchObject({ pricing_lane: "legacy", components_sealed_at: expect.any(String) });
        continue;
      }
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
    expect(componentsResult.data).toHaveLength(9);
    expect(componentsResult.data?.filter((row) => row.price_version_id !== DB012_LEGACY_PRICE_ID)).toEqual(expectedComponents);
    expect(componentsResult.data?.filter((row) => row.price_version_id === DB012_LEGACY_PRICE_ID)).toEqual([
      { price_version_id: DB012_LEGACY_PRICE_ID, component: "input_cache_read", nanos_per_million: 20_000_000 },
      { price_version_id: DB012_LEGACY_PRICE_ID, component: "input_standard", nanos_per_million: 1_000_000_000 },
      { price_version_id: DB012_LEGACY_PRICE_ID, component: "output", nanos_per_million: 2_000_000_000 },
    ]);
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
                  ${CANONICAL_ROUTINE_DEFINITION_SQL},
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
                  ${CANONICAL_ROUTINE_DEFINITION_SQL},
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
                  ${CANONICAL_ROUTINE_DEFINITION_SQL},
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
                  ${CANONICAL_ROUTINE_DEFINITION_SQL},
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

  it("reapplies exactly without touching unrelated historical request, usage, or acceptance rows", async () => {
    const userId = await createHistoricalFixture(service);
    try {
      const before = snapshotSeedRows();

      runOwnerSql(readFileSync(MIGRATION_URL, "utf8"));

      expect(snapshotSeedRows()).toBe(before);
    } finally {
      await deleteTestUser(service, userId);
    }
  });

  const HOSTILE_SEED_CASES: readonly HostileSeedCase[] = [
    {
      name: "fixed profile ID has a wrong projection",
      precondition: withUserTriggersDisabled(
        ["ai_provider_profiles"],
        String.raw`
          update public.ai_provider_profiles
          set display_name = 'hostile-profile-projection'
          where id = '${SEED.profile.id}'::uuid;
        `,
      ),
      expectedError: "DeepSeek V2 profile identity mismatch",
    },
    {
      name: "alternate profile natural key occupies the expected identity",
      precondition: withUserTriggersDisabled(
        ["ai_provider_profiles"],
        String.raw`
          update public.ai_provider_profiles
          set profile_key = 'hostile.alternate.profile.natural-key.v1'
          where id = '${SEED.profile.id}'::uuid;
        `,
      ),
      expectedError: "DeepSeek V2 profile identity mismatch",
    },
    {
      name: "alternate fixed profile ID occupies the canonical natural key",
      precondition: moveCanonicalFixedId(
        "ai_provider_profiles",
        SEED.profile.id,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      ),
      expectedError: "DeepSeek V2 profile identity mismatch",
    },
    {
      name: "fixed profile-version ID has a wrong projection",
      precondition: withUserTriggersDisabled(
        ["ai_provider_profile_versions"],
        String.raw`
          update public.ai_provider_profile_versions
          set model_snapshot = 'hostile-profile-version-projection'
          where id = '${SEED.profile.profileVersionId}'::uuid;
        `,
      ),
      expectedError: "DeepSeek V2 profile version mismatch",
    },
    {
      name: "profile-version natural key is rebound to another profile",
      precondition: withUserTriggersDisabled(
        ["ai_provider_profile_versions"],
        String.raw`
          insert into public.ai_provider_profiles (
            id, profile_key, display_name, gateway_kind, model_vendor
          ) values (
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid,
            'hostile.alternate.profile-version-owner.v1',
            'Hostile alternate profile-version owner',
            'direct_deepseek',
            'deepseek'
          );
          update public.ai_provider_profile_versions
          set profile_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid
          where id = '${SEED.profile.profileVersionId}'::uuid;
        `,
      ),
      expectedError: "DeepSeek V2 profile version mismatch",
    },
    {
      name: "alternate fixed profile-version ID occupies the canonical natural key",
      precondition: moveCanonicalFixedId(
        "ai_provider_profile_versions",
        SEED.profile.profileVersionId,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
      ),
      expectedError: "DeepSeek V2 profile version mismatch",
    },
    {
      name: "fixed price ID has a wrong projection",
      precondition: withUserTriggersDisabled(
        ["ai_price_versions"],
        String.raw`
          update public.ai_price_versions
          set currency = 'USD'
          where id = '${SEED.pricing.rows[0].id}'::uuid;
        `,
      ),
      expectedError: "DeepSeek V2 price version mismatch",
    },
    {
      name: "price natural key no longer matches its fixed ID",
      precondition: withUserTriggersDisabled(
        ["ai_price_versions"],
        String.raw`
          update public.ai_price_versions
          set version = 2
          where id = '${SEED.pricing.rows[0].id}'::uuid;
        `,
      ),
      expectedError: "DeepSeek V2 price version mismatch",
    },
    {
      name: "alternate fixed price ID occupies the canonical offpeak natural key",
      precondition: moveCanonicalFixedId(
        "ai_price_versions",
        SEED.pricing.rows[0].id,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
      ),
      expectedError: "DeepSeek V2 price version mismatch",
    },
    {
      name: "alternate fixed price ID occupies the canonical peak natural key",
      precondition: moveCanonicalFixedId(
        "ai_price_versions",
        SEED.pricing.rows[1].id,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
      ),
      expectedError: "DeepSeek V2 price version mismatch",
    },
    {
      name: "price component is substituted",
      precondition: withUserTriggersDisabled(
        ["ai_price_components"],
        String.raw`
          update public.ai_price_components
          set nanos_per_million = nanos_per_million + 1
          where price_version_id = '${SEED.pricing.rows[0].id}'::uuid
            and component = 'output';
        `,
      ),
      expectedError: "DeepSeek V2 price component mismatch",
    },
    {
      name: "existing price identity has a missing component",
      precondition: withUserTriggersDisabled(
        ["ai_price_components"],
        String.raw`
          delete from public.ai_price_components
          where price_version_id = '${SEED.pricing.rows[0].id}'::uuid
            and component = 'output';
        `,
      ),
      expectedError: "DeepSeek V2 price component mismatch",
    },
    {
      name: "existing price identity has an additional component",
      precondition: String.raw`
        insert into public.ai_price_components (
          price_version_id, component, nanos_per_million
        ) values (
          '${SEED.pricing.rows[0].id}'::uuid,
          'input_cache_write',
          1
        );
      `,
      expectedError: "DeepSeek V2 price component mismatch",
    },
    {
      name: "runtime target projection is wrong",
      precondition: String.raw`
          alter table public.ai_service_runtime_contract_targets
            drop constraint ai_service_runtime_contract_targets_projection_fkey;
          alter table public.ai_service_runtime_target_versions disable trigger user;
          update public.ai_service_runtime_target_versions
          set route_descriptor_sha256 = repeat('0', 64)
          where runtime_target_id = '${SEED.runtime.targets[0].runtimeTargetId}';
          alter table public.ai_service_runtime_target_versions enable trigger user;
        `,
      expectedError: "DeepSeek V2 runtime target mismatch",
    },
    {
      name: "runtime root source is rebound",
      precondition: withUserTriggersDisabled(
        ["ai_service_runtime_contract_versions"],
        String.raw`
          update public.ai_service_runtime_contract_versions
          set reviewed_source_commit_oid = 'sha1:0000000000000000000000000000000000000000'
          where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}';
        `,
      ),
      expectedError: "DeepSeek V2 runtime contract mismatch",
    },
    {
      name: "existing runtime root is missing its seal",
      precondition: withUserTriggersDisabled(
        ["ai_service_runtime_contract_versions"],
        String.raw`
          update public.ai_service_runtime_contract_versions
          set sealed_at = null
          where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}';
        `,
      ),
      expectedError: "DeepSeek V2 runtime contract mismatch",
    },
    {
      name: "sealed runtime membership is rebound",
      precondition: String.raw`
          alter table public.ai_service_runtime_contract_targets
            drop constraint ai_service_runtime_contract_targets_projection_fkey;
          alter table public.ai_service_runtime_contract_targets disable trigger user;
          update public.ai_service_runtime_contract_targets
          set profile_key = 'hostile.rebound.runtime-profile.v1'
          where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}';
          alter table public.ai_service_runtime_contract_targets enable trigger user;
        `,
      expectedError: "DeepSeek V2 runtime membership mismatch",
    },
    {
      name: "sealed runtime root is missing its exact membership",
      precondition: withUserTriggersDisabled(
        ["ai_service_runtime_contract_targets"],
        String.raw`
          delete from public.ai_service_runtime_contract_targets
          where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}';
        `,
      ),
      expectedError: "DeepSeek V2 runtime membership mismatch",
    },
    {
      name: "sealed runtime root has an additional membership",
      precondition: withUserTriggersDisabled(
        ["ai_service_runtime_contract_targets"],
        String.raw`
          insert into public.ai_service_runtime_target_versions (
            runtime_target_id,
            runtime_target_sha256,
            profile_key,
            legal_manifest_id,
            manifest_sha256,
            route_descriptor_id,
            route_descriptor_sha256
          ) values (
            'runtime-target.hostile.additional.v1',
            repeat('1', 64),
            'hostile.additional.runtime-profile.v1',
            '${SEED.runtime.targets[0].legalManifestId}',
            '${SEED.runtime.targets[0].manifestSha256}',
            'route.hostile.additional.v1',
            repeat('2', 64)
          );
          insert into public.ai_service_runtime_contract_targets (
            runtime_contract_id,
            runtime_contract_sha256,
            runtime_target_id,
            runtime_target_sha256,
            profile_key,
            legal_manifest_id,
            manifest_sha256,
            route_descriptor_id,
            route_descriptor_sha256
          ) values (
            '${SEED.runtime.contract.runtimeContractId}',
            '${SEED.runtime.contract.runtimeContractSha256}',
            'runtime-target.hostile.additional.v1',
            repeat('1', 64),
            'hostile.additional.runtime-profile.v1',
            '${SEED.runtime.targets[0].legalManifestId}',
            '${SEED.runtime.targets[0].manifestSha256}',
            'route.hostile.additional.v1',
            repeat('2', 64)
          );
        `,
      ),
      expectedError: "DeepSeek V2 runtime membership mismatch",
    },
    {
      name: "fixed policy ID has a wrong projection",
      precondition: withUserTriggersDisabled(
        ["ai_routing_policy_versions"],
        String.raw`
          update public.ai_routing_policy_versions
          set config_sha256 = repeat('0', 64)
          where id = '${SEED.policy.id}'::uuid;
        `,
      ),
      expectedError: "DeepSeek G2 draft routing policy mismatch",
    },
    {
      name: "alternate policy natural key occupies the expected identity",
      precondition: withUserTriggersDisabled(
        ["ai_routing_policy_versions"],
        String.raw`
          update public.ai_routing_policy_versions
          set id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
          where id = '${SEED.policy.id}'::uuid;
        `,
      ),
      expectedError: "DeepSeek G2 draft routing policy mismatch",
    },
    {
      name: "alternate fixed policy ID occupies the canonical natural key",
      precondition: moveCanonicalFixedId(
        "ai_routing_policy_versions",
        SEED.policy.id,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6",
      ),
      expectedError: "DeepSeek G2 draft routing policy mismatch",
    },
  ];

  it.each(HOSTILE_SEED_CASES)(
    "rejects hostile seed state: $name, then restores every CFG table byte-for-byte",
    async (seedCase) => {
      await expectHostileSeedRollback(service, seedCase);
    },
  );

  const PARTIAL_CFG001_IDENTITY_CASES: readonly HostileSeedCase[] = [
    {
      name: "profile-only CFG001 identity graph",
      precondition: withUserTriggersDisabled(
        [
          "ai_routing_policy_versions",
          "ai_service_runtime_contract_targets",
          "ai_service_runtime_contract_versions",
          "ai_service_runtime_target_versions",
          "ai_price_components",
          "ai_price_versions",
          "ai_provider_profile_versions",
        ],
        String.raw`
          delete from public.ai_routing_policy_versions
          where id = '${SEED.policy.id}'::uuid;
          delete from public.ai_service_runtime_contract_targets
          where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}';
          delete from public.ai_service_runtime_contract_versions
          where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}';
          delete from public.ai_service_runtime_target_versions
          where runtime_target_id = '${SEED.runtime.targets[0].runtimeTargetId}';
          delete from public.ai_price_components
          where price_version_id in (
            '${SEED.pricing.rows[0].id}'::uuid,
            '${SEED.pricing.rows[1].id}'::uuid
          );
          delete from public.ai_price_versions
          where id in (
            '${SEED.pricing.rows[0].id}'::uuid,
            '${SEED.pricing.rows[1].id}'::uuid
          );
          delete from public.ai_provider_profile_versions
          where id = '${SEED.profile.profileVersionId}'::uuid;
        `,
      ),
      expectedError: "DeepSeek V2 profile version mismatch",
    },
    {
      name: "profile-and-version-only CFG001 identity graph",
      precondition: withUserTriggersDisabled(
        [
          "ai_routing_policy_versions",
          "ai_service_runtime_contract_targets",
          "ai_service_runtime_contract_versions",
          "ai_service_runtime_target_versions",
          "ai_price_components",
          "ai_price_versions",
        ],
        String.raw`
          delete from public.ai_routing_policy_versions
          where id = '${SEED.policy.id}'::uuid;
          delete from public.ai_service_runtime_contract_targets
          where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}';
          delete from public.ai_service_runtime_contract_versions
          where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}';
          delete from public.ai_service_runtime_target_versions
          where runtime_target_id = '${SEED.runtime.targets[0].runtimeTargetId}';
          delete from public.ai_price_components
          where price_version_id in (
            '${SEED.pricing.rows[0].id}'::uuid,
            '${SEED.pricing.rows[1].id}'::uuid
          );
          delete from public.ai_price_versions
          where id in (
            '${SEED.pricing.rows[0].id}'::uuid,
            '${SEED.pricing.rows[1].id}'::uuid
          );
        `,
      ),
      expectedError: "DeepSeek V2 price version mismatch",
    },
    {
      name: "CFG001 profile graph with no price identities",
      precondition: withUserTriggersDisabled(
        [
          "ai_routing_policy_versions",
          "ai_service_runtime_contract_targets",
          "ai_service_runtime_contract_versions",
          "ai_service_runtime_target_versions",
          "ai_price_components",
          "ai_price_versions",
        ],
        String.raw`
          delete from public.ai_routing_policy_versions
          where id = '${SEED.policy.id}'::uuid;
          delete from public.ai_service_runtime_contract_targets
          where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}';
          delete from public.ai_service_runtime_contract_versions
          where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}';
          delete from public.ai_service_runtime_target_versions
          where runtime_target_id = '${SEED.runtime.targets[0].runtimeTargetId}';
          delete from public.ai_price_components
          where price_version_id in (
            '${SEED.pricing.rows[0].id}'::uuid,
            '${SEED.pricing.rows[1].id}'::uuid
          );
          delete from public.ai_price_versions
          where id in (
            '${SEED.pricing.rows[0].id}'::uuid,
            '${SEED.pricing.rows[1].id}'::uuid
          );
        `,
      ),
      expectedError: "DeepSeek V2 price version mismatch",
    },
    {
      name: "one canonical CFG001 price identity",
      precondition: withUserTriggersDisabled(
        [
          "ai_routing_policy_versions",
          "ai_service_runtime_contract_targets",
          "ai_service_runtime_contract_versions",
          "ai_service_runtime_target_versions",
          "ai_price_components",
          "ai_price_versions",
        ],
        String.raw`
          delete from public.ai_routing_policy_versions
          where id = '${SEED.policy.id}'::uuid;
          delete from public.ai_service_runtime_contract_targets
          where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}';
          delete from public.ai_service_runtime_contract_versions
          where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}';
          delete from public.ai_service_runtime_target_versions
          where runtime_target_id = '${SEED.runtime.targets[0].runtimeTargetId}';
          delete from public.ai_price_components
          where price_version_id = '${SEED.pricing.rows[1].id}'::uuid;
          delete from public.ai_price_versions
          where id = '${SEED.pricing.rows[1].id}'::uuid;
        `,
      ),
      expectedError: "DeepSeek V2 price version mismatch",
    },
    {
      name: "runtime target without the CFG001 root",
      precondition: withUserTriggersDisabled(
        [
          "ai_routing_policy_versions",
          "ai_service_runtime_contract_targets",
          "ai_service_runtime_contract_versions",
        ],
        String.raw`
          delete from public.ai_routing_policy_versions
          where id = '${SEED.policy.id}'::uuid;
          delete from public.ai_service_runtime_contract_targets
          where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}';
          delete from public.ai_service_runtime_contract_versions
          where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}';
        `,
      ),
      expectedError: "DeepSeek V2 runtime contract mismatch",
    },
    {
      name: "runtime root without the CFG001 target",
      precondition: withUserTriggersDisabled(
        [
          "ai_routing_policy_versions",
          "ai_service_runtime_contract_targets",
          "ai_service_runtime_target_versions",
        ],
        String.raw`
          delete from public.ai_routing_policy_versions
          where id = '${SEED.policy.id}'::uuid;
          delete from public.ai_service_runtime_contract_targets
          where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}';
          delete from public.ai_service_runtime_target_versions
          where runtime_target_id = '${SEED.runtime.targets[0].runtimeTargetId}';
        `,
      ),
      expectedError: "DeepSeek V2 runtime target mismatch",
    },
    {
      name: "runtime root and target without CFG001 membership",
      precondition: withUserTriggersDisabled(
        [
          "ai_service_runtime_contract_targets",
          "ai_service_runtime_contract_versions",
        ],
        String.raw`
          update public.ai_service_runtime_contract_versions
          set sealed_at = null
          where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}';
          delete from public.ai_service_runtime_contract_targets
          where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}';
        `,
      ),
      expectedError: "DeepSeek V2 runtime membership mismatch",
    },
  ];

  it.each(PARTIAL_CFG001_IDENTITY_CASES)(
    "fails closed before repairing partial CFG001 identities: $name",
    async (seedCase) => {
      await expectHostileSeedRollback(service, seedCase);
    },
  );

  it("rolls back a late canonical policy conflict after the CFG runtime is sealed", async () => {
    await expectHostileSeedRollback(service, {
      name: "late canonical policy natural-key conflict",
      precondition: String.raw`
        ${withUserTriggersDisabled(
          [
            "ai_routing_policy_versions",
            "ai_service_runtime_contract_targets",
            "ai_service_runtime_contract_versions",
            "ai_service_runtime_target_versions",
            "ai_price_components",
            "ai_price_versions",
            "ai_provider_profile_versions",
            "ai_provider_profiles",
          ],
          String.raw`
            delete from public.ai_routing_policy_versions
            where id = '${SEED.policy.id}'::uuid;
            delete from public.ai_service_runtime_contract_targets
            where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}';
            delete from public.ai_service_runtime_contract_versions
            where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}';
            delete from public.ai_service_runtime_target_versions
            where runtime_target_id = '${SEED.runtime.targets[0].runtimeTargetId}';
            delete from public.ai_price_components
            where price_version_id in (
              '${SEED.pricing.rows[0].id}'::uuid,
              '${SEED.pricing.rows[1].id}'::uuid
            );
            delete from public.ai_price_versions
            where id in (
              '${SEED.pricing.rows[0].id}'::uuid,
              '${SEED.pricing.rows[1].id}'::uuid
            );
            delete from public.ai_provider_profile_versions
            where id = '${SEED.profile.profileVersionId}'::uuid;
            delete from public.ai_provider_profiles
            where id = '${SEED.profile.id}'::uuid;
          `,
        )}
        alter table public.ai_routing_policy_versions disable trigger user;
        create function pg_temp.cfg001_late_policy_conflict()
        returns trigger
        language plpgsql
        as $$
        begin
          if not exists (
            select 1
            from public.ai_provider_profile_versions
            where id = '${SEED.profile.profileVersionId}'::uuid
          ) or not exists (
            select 1
            from public.ai_service_runtime_contract_targets
            where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}'
              and runtime_target_id = '${SEED.runtime.targets[0].runtimeTargetId}'
          ) or not exists (
            select 1
            from public.ai_service_runtime_contract_versions
            where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}'
              and sealed_at is not null
          ) then
            raise exception 'CFG001 late conflict fired before runtime seal'
              using errcode = 'P0001';
          end if;

          raise notice 'CFG001_LATE_POLICY_CONFLICT_AFTER_RUNTIME_SEAL';
          update public.ai_routing_policy_versions
          set id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'::uuid
          where id = new.id;
          return new;
        end;
        $$;
        create trigger cfg001_late_policy_conflict
        after insert on public.ai_routing_policy_versions
        for each row
        when (new.id = '${SEED.policy.id}'::uuid)
        execute function pg_temp.cfg001_late_policy_conflict();
        alter table public.ai_routing_policy_versions
          enable trigger cfg001_late_policy_conflict;
      `,
      expectedError: "DeepSeek G2 draft routing policy mismatch",
      expectedNotice: "CFG001_LATE_POLICY_CONFLICT_AFTER_RUNTIME_SEAL",
    });
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
          'legacySealIntents', (
            select count(*) from public.ai_price_component_seal_intents
            where price_version_id = '${DB012_LEGACY_PRICE_ID}'::uuid
              and applied_at is not null
          ),
          'sealIntents', (select count(*) from public.ai_price_component_seal_intents),
          'policies', (select count(*) from public.ai_routing_policy_versions where id = '${SEED.policy.id}'::uuid),
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
            + (select count(*) from public.ai_routing_policy_transition_intents)
            + (select count(*) from public.ai_routing_lifecycle_audit)
        )::text;
      `);

      expect(actual).toEqual({
        profiles: 1,
        profileVersions: 1,
        prices: 3,
        priceLanes: ["legacy", "offpeak", "peak"],
        components: 9,
        legacySealIntents: 1,
        sealIntents: 1,
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
