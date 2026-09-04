import { readFileSync } from "node:fs";

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { DEEPSEEK_V2_SEED_V1 } from "@/server/polish/deepseek-v2-seed-v1";
import { G4_ROUTING_POLICY_SEED_V1 } from "@/server/polish/g4-routing-policy-seed-v1";

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
const G4_SEED = G4_ROUTING_POLICY_SEED_V1;
const DB012_LEGACY_PRICE_ID = "11111111-1111-4111-8111-111111111114";
const RUN_CFG001_FRESH_RESET = process.env.CFG001_FRESH_RESET === "1";
const DISABLED_AVAILABILITY = {
  enabled: false,
  configGeneration: null,
  routingPolicyVersionId: null,
  profileVersionId: null,
  legalBundleVersion: null,
  runtimeContractId: null,
  displayDisclosureKey: null,
  termsAccepted: false,
} as const;

describe("CFG-001 successor-compatible membership source", () => {
  it("keeps every additive Admin/v2 routine in the explicit successor manifest", () => {
    const sources = [
      "20260903000000_admin_read_foundation.sql",
      "20260904000000_ai_provider_binding_v2_expand.sql",
      "20260904001000_provider_execution_v2_lifecycle.sql",
      "20260904002000_runtime_legal_evidence_v2.sql",
      "20260904003000_ai_legal_acceptance_v2.sql",
      "20260904004000_admin_write_kernel.sql",
      "20260904005000_admin_validation_reports.sql",
      "20260904006000_admin_control_operations.sql",
      "20260904007000_admin_authoring_operations.sql",
      "20260904008000_admin_publication_operations.sql",
      "20260904009000_admin_runtime_deployment_admission.sql",
      "20260904010000_admin_authoring_reads.sql",
      "20260904011000_admin_ai_analytics.sql",
      "20260904012000_admin_privilege_hardening.sql",
      "20260904013000_admin_runtime_admission_v2.sql",
      "20260904014000_admin_runtime_admission_readback_v2.sql",
      "20260904016000_attempt_admission_receipt_seal.sql",
      "20260904017000_runtime_authority_receipt_v2.sql",
      "20260904020000_admin_effective_membership_guard.sql",
      "20260904021000_start_ai_polish_provider_attempt_v4.sql",
      "20260904022000_admin_readback_cutover_authority_v3.sql",
    ].map((name) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8"));
    const declared = sources.flatMap((source) => [...source.matchAll(/create function public\.([a-z0-9_]+)\s*\(/giu)].map((match) => match[1]));
    const manifest = new Set<string>(NON_SYSTEM_ROUTINE_AUTHORITY_SUCCESSOR_V1.map(([name]) => name));
    const retired = new Set(["admin_cutover_authority_v1"]);
    expect(
      declared
        .filter((name) => !name.startsWith("pg_"))
        .filter((name) => !retired.has(name))
        .filter((name) => !manifest.has(name)),
    ).toEqual([]);
  });

  it("scopes membership cardinality to the legacy root while retaining exact tuple checks", () => {
    const source = readFileSync(
      new URL("../../../supabase/migrations/20260824002000_seed_deepseek_v2_draft.sql", import.meta.url),
      "utf8",
    ).replace(/\r\n?/gu, "\n");
    expect(source).toContain("where runtime_contract_id = 'runtime.deepseek-v2.v1';");
    expect(source).not.toContain("runtime_contract_id = 'runtime.deepseek-v2.v1'\n     or runtime_target_id");
    expect(source).toContain("and runtime_target_id =\n        'runtime-target.deepseek.official.deepseek-v4-flash.chat.v1'");
  });

  it("freezes price-effective provenance separately from the operational interval", () => {
    const source = readFileSync(
      new URL("../../../supabase/migrations/20260824002000_seed_deepseek_v2_draft.sql", import.meta.url),
      "utf8",
    );

    expect(SEED.pricing.sourceCheckedAt).toBe("2026-08-28T08:05:41.804Z");
    expect(SEED.pricing.sourceSnapshotSha256).toBe(
      "899affbdbc33d0be620d8dea59e86f5036c11b5410b14d060b8d2874c74f38e5",
    );
    expect(SEED.pricing.rows).toHaveLength(2);
    for (const row of SEED.pricing.rows) {
      expect(row.validFrom).toBe("2026-08-25T06:45:15.787Z");
      expect(row.providerEffectiveFrom).toBe("2026-08-16T16:00:00.000Z");
      expect(row.providerEffectiveTo).toBeNull();
    }
    expect(source).toContain("'2026-08-16T16:00:00Z'::timestamptz");
    expect(source).toContain("'2026-08-28T08:05:41.804Z'::timestamptz");
    expect(source).toContain(
      "'899affbdbc33d0be620d8dea59e86f5036c11b5410b14d060b8d2874c74f38e5'",
    );
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
      "p_runtime_contract_id text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text, p_at timestamp with time zone",
    prokind: "f",
    definitionSha256: "6b99fb2d7645dd85bf34cc07b6ee5453388a2c14223a93d596da1ff209dfe75f",
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
      "p_runtime_contract_id text, p_profile_id uuid, p_profile_version_id uuid",
    prokind: "f",
    definitionSha256: "f6fa4cc4de46233966542ae9d86d89ce24c5c59ba1197a7eeff346e1578048b2",
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
    definitionSha256: "9024180ca9270cdabc72d7ec5ec68df920672ddc5cba7f145bf96f3e4a119c47",
  },
  {
    schema: "public",
    name: "clear_ai_routing_policy_pointer_v1",
    identityArguments:
      "p_expected_policy_version_id uuid, p_runtime_contract_id text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
    prokind: "f",
    definitionSha256: "6e0838c7d2a2ee95ad1f12bdc39f9bca71fc31157f3458fc30d2f8cf0054f939",
  },
  {
    schema: "public",
    name: "close_ai_price_version_v1",
    identityArguments:
      "p_price_version_id uuid, p_valid_to timestamp with time zone, p_successor_price_version_id uuid, p_runtime_contract_id text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
    prokind: "f",
    definitionSha256: "275dcd9ad4785ccc07b477c78d18f591f62c4ce2e9791bd76dabb6dfbee03579",
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
      "p_policy_version_id uuid, p_policy_key text, p_version integer, p_timezone text, p_rules jsonb, p_default_profile_version_id uuid, p_legal_bundle_version text, p_config_sha256 text, p_runtime_contract_id text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
    prokind: "f",
    definitionSha256: "643f2232ade940aa093dae46e405cfc86d40b6a02d153b18a8a9138fb694ec34",
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
    definitionSha256: "c046069e050d8e640add41eab33f032ad8eee7e8346383d9458f720d23ac495a",
  },
  {
    schema: "public",
    name: "get_ai_polish_execution_snapshot_v1",
    identityArguments: "p_reservation_id uuid, p_user_id uuid",
    prokind: "f",
    definitionSha256: "d2d22cab1c1cbff01b16edd144f6e79e5e9231bfa40b940e0ae6ca9f9dfe5f5b",
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
      "p_operation text, p_policy uuid, p_profile uuid, p_profile_version uuid, p_price uuid, p_from text, p_to text, p_old_pointer uuid, p_new_pointer uuid, p_old_generation bigint, p_new_generation bigint, p_old_retired timestamp with time zone, p_new_retired timestamp with time zone, p_old_valid_to timestamp with time zone, p_new_valid_to timestamp with time zone, p_runtime_id text, p_actor text, p_reason text, p_commit text, p_source_hash text, p_rechecked timestamp with time zone, p_rechecked_hash text, p_at timestamp with time zone",
    prokind: "f",
    definitionSha256: "f0c50052cce74d56c93c3f84cafd1477fbfbb808bfd0ec276cb41669e323191b",
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
    definitionSha256: "063fe3b1313cc8def2f459ce15cb369c6568fa15402e726060fe76911564ec46",
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
    definitionSha256: "070e9cb6549b36497f8460878b3e4133b6ebb21eccf7feb7d032b55be3faf58a",
  },
  {
    schema: "public",
    name: "retire_ai_provider_profile_v1",
    identityArguments:
      "p_profile_id uuid, p_runtime_contract_id text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
    prokind: "f",
    definitionSha256: "aaf8f6b3c4809df2b2d080c001e89533a1137dcd2fc46ec8b5663ed938251898",
  },
  {
    schema: "public",
    name: "retire_ai_provider_profile_version_v1",
    identityArguments:
      "p_profile_version_id uuid, p_runtime_contract_id text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
    prokind: "f",
    definitionSha256: "6f8b3f0e6e1f47619fbe6197a89dfaf0935f350bc32ea073f5b5eb7cf7aeda59",
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
      "p_price_version_id uuid, p_rechecked_source_url text, p_rechecked_currency text, p_rechecked_calculator_kind text, p_rechecked_provider_effective_from timestamp with time zone, p_rechecked_provider_effective_to timestamp with time zone, p_rechecked_parameters jsonb, p_rechecked_components jsonb, p_runtime_contract_id text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
    prokind: "f",
    definitionSha256: "2a11e433b7286991e14227e1262b5c675c333c99dd596a2f46f97eca1f609238",
  },
  {
    schema: "public",
    name: "set_ai_routing_policy_pointer_v1",
    identityArguments:
      "p_policy_version_id uuid, p_runtime_contract_id text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
    prokind: "f",
    definitionSha256: "97fb5ad52ca8cf683c4d151a13851d89dc7dd2149fae9031de01ed2be18e5e2a",
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
    definitionSha256: "213d51f684019dbca646966e2cf4cfff6995b7571689971979f96bd52ea39961",
  },
  {
    schema: "public",
    name: "transition_ai_provider_profile_version_v1",
    identityArguments:
      "p_profile_version_id uuid, p_to_status text, p_runtime_contract_id text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
    prokind: "f",
    definitionSha256: "1ef068afeb7f29eb83ce475d163c233e57748211c740c21c9a80b984575ae4f9",
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
      "p_policy_version_id uuid, p_to_status text, p_runtime_contract_id text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text",
    prokind: "f",
    definitionSha256: "e00fb291b940aee92d5bc617a2736c19b2d7878c472781997f471ef6d830d931",
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
      "p_runtime_contract_id text, p_actor text, p_reason text, p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_rechecked_at timestamp with time zone, p_rechecked_sha256 text, p_at timestamp with time zone",
    prokind: "f",
    definitionSha256: "6b99fb2d7645dd85bf34cc07b6ee5453388a2c14223a93d596da1ff209dfe75f",
  },
  {
    schema: "public",
    name: "assert_ai_routing_lifecycle_runtime_profile_coverage_v1",
    identityArguments:
      "p_runtime_contract_id text, p_profile_id uuid, p_profile_version_id uuid",
    prokind: "f",
    definitionSha256: "f6fa4cc4de46233966542ae9d86d89ce24c5c59ba1197a7eeff346e1578048b2",
  },
  {
    schema: "public",
    name: "get_ai_polish_availability_v1",
    identityArguments: "p_user_id uuid",
    prokind: "f",
    definitionSha256: "c046069e050d8e640add41eab33f032ad8eee7e8346383d9458f720d23ac495a",
  },
  {
    schema: "public",
    name: "get_ai_polish_execution_snapshot_v1",
    identityArguments: "p_reservation_id uuid, p_user_id uuid",
    prokind: "f",
    definitionSha256: "d2d22cab1c1cbff01b16edd144f6e79e5e9231bfa40b940e0ae6ca9f9dfe5f5b",
  },
  {
    schema: "public",
    name: "guard_ai_service_runtime_contract_target",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "df78064c89b8b6465023660921553493a24a810c725c6457d6358ef03395bb40",
  },
  {
    schema: "public",
    name: "guard_ai_service_runtime_contract_version",
    identityArguments: "",
    prokind: "f",
    definitionSha256: "c0dafef806cdcce5ff479c0c1cdcd9ebffa4ffef6502cf63e83dffb866817ad6",
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
    definitionSha256: "063fe3b1313cc8def2f459ce15cb369c6568fa15402e726060fe76911564ec46",
  },
  {
    schema: "public",
    name: "reserve_ai_polish_request_v2",
    identityArguments:
      "p_user_id uuid, p_request_id uuid, p_client_request_id uuid, p_expected_route jsonb",
    prokind: "f",
    definitionSha256: "070e9cb6549b36497f8460878b3e4133b6ebb21eccf7feb7d032b55be3faf58a",
  },
  {
    schema: "public",
    name: "validate_ai_routing_policy_row_v1",
    identityArguments:
      "p_policy ai_routing_policy_versions, p_phase text, p_at timestamp with time zone, p_discovery_only boolean",
    prokind: "f",
    definitionSha256: "79dfdd245145031cc0950c7e5a322417fe50c05399df3b48433f3f49ef170394",
  },
] as const;

// This root includes DB-013 migration 20260824004000's controlled lifecycle
// routines and DB003C migration 20260824005000's authorized replacement of the
// sole assert_ai_price_structure_v1(uuid) body.
const NON_SYSTEM_ROUTINE_AUTHORITY_ROOT_V1 = {
  routineCount: 374,
  authorityRootSha256:
    "d3cdcd8357e159809df663ea47add75d1babb2bb2678bfaf618421add60986bd",
} as const;

// Post-CFG001 routines are an explicit additive successor surface. The v1
// root below deliberately excludes exactly these identities, so any new
// routine omitted from this manifest still changes the frozen v1 count/hash.
const NON_SYSTEM_ROUTINE_AUTHORITY_SUCCESSOR_V1 = [
  ["admin_guard_audit_v1", "", "f", false, "c54e2ae27031c4bcec613fd604405625319e6e29cc25b0a0f575a80d64a880ed"],
  ["admin_bootstrap_v1", "p_user_id uuid, p_environment text, p_project_ref text, p_auth_issuer text, p_reason text", "f", true, "c2c2d3d9630b06c73dc9443f33dd48ffdaa3edc8126f7a5701b55eda9079abc0"],
  ["admin_assert_actor_v1", "p_environment text, p_project_ref text", "f", true, "0c579b0557284f56986eecefe4a94279aa4adf4c10c084bff7cc38e6cee67e1f"],
  ["admin_get_context_v1", "p_environment text, p_project_ref text", "f", true, "2351ca36df4b99f94832ac9235e019783dce435865244e56a8a0997c0e9c29f0"],
  ["admin_records_query_v1", "p_section text", "f", false, "19ae56c24787f1671246a16ffac96c97fcf4648a9e8db2380e63845a74d5c55d"],
  ["admin_list_records_v1", "p_environment text, p_project_ref text, p_section text, p_limit integer, p_after text, p_search text", "f", true, "5f1a87edaa14aa78f8e116766cbd111e4bb2f459349e4a80938655dcac232c3d"],
  ["admin_get_record_v1", "p_environment text, p_project_ref text, p_section text, p_id uuid", "f", true, "1dc5bbbf6881e29f0b5208fbbef67e4a5398b829a014aa664ec8ee7b16cae36a"],
  ["ai_endpoint_shape_v2", "p_url text", "f", false, "368d5a62f9b0ca4951e7305b68195c16814b1c9e71972a655f3e01ac1239b5f5"],
  ["guard_ai_provider_directory_v2", "", "f", false, "0edf9a2b51b9ecb7ddf77cb65a9598d9363e151095b0e915df8010555294c963"],
  ["guard_ai_profile_provider_v2", "", "f", false, "f4f4c5c4619d78aa1b835b111e85efb38e95753811141f045b3f557e88843dfa"],
  ["guard_ai_profile_binding_v2", "", "f", false, "9ea4480c057aab2e7e1281f7a31b469c2efe4a65c22e2e4933d641f230754e19"],
  ["guard_ai_attempt_binding_v2", "", "f", false, "c108c352ecf7d56f2aa3f202b9702df94d6e3ca2159806d03192eaffcff0dfee"],
  ["guard_ai_runtime_code_capability_v2", "", "f", false, "c5c468ce0ff7cea295de87f096f1ccadab75313bdb9076fdc57e53822971b263"],
  ["ai_legal_display_content_shape_v2", "p_content jsonb", "f", false, "2c4f1c85c63e24a82a77ee14cb60656b74d80ba0193329801ee1676949255278"],
  ["guard_ai_legal_display_version_v2", "", "f", false, "171aafc2e254045026a53da612b10b13c8a3f6a47c714b72651533123fd155c4"],
  ["guard_ai_current_legal_bundle_v2", "", "f", false, "1b8823594a80f7b71184e1e98b515c1818056cbc795b9a1165498ed853cad444"],
  ["get_ai_current_legal_bundle_v2", "", "f", true, "443163e8aa131fe1dbbf989f3d35053ac8d8c7ecdcd95ea21aa9517fcdee397e"],
  ["guard_ai_runtime_target_binding_v2", "", "f", false, "f8f6df398c6b7c13ab8b0178d076c06014bbaecbd14b5cc67e72723178346dee"],
  ["get_ai_polish_execution_snapshot_v2", "p_reservation_id uuid, p_user_id uuid", "f", true, "db45668b5b53040335b8e68e2d70047ccfcf2e595b6797f83ffd69f441c6bcc6"],
  ["start_ai_polish_provider_attempt_v2", "p_reservation_id uuid, p_attempt_no integer, p_runtime_build_id text, p_binding_manifest_revision text", "f", true, "a1b9421dc07731be7fc60555490f512530c2037ad0633b6371276a0095c873bd"],
  ["guard_user_ai_legal_acceptance_v2", "", "f", false, "4196ee3f7f9d9dfeb95ad8a3724d9297e00208597898a844c57432cc0080c413"],
  ["has_accepted_ai_legal_disclosure_v2", "p_user_id uuid, p_legal_bundle_version text, p_display_disclosure_key text", "f", true, "21549d835d5d6165b2da7ba0f1b92cbb879d3305c7affc27723dcc1f878227a7"],
  ["accept_ai_legal_disclosure_v2", "p_expected_user_id uuid, p_legal_bundle_version text, p_display_disclosure_key text, p_content_sha256 text", "f", true, "c7d7e8ae03ecac2c3a4a266ac35a2d9a7a905442843c082d2a616258aba2a163"],
  ["get_ai_legal_display_v2", "p_legal_bundle_version text, p_display_disclosure_key text", "f", true, "a2eba11b407d7f33042e5bf3018dec4eb74396e9aba1bbffdc5b0e96e6165109"],
  ["get_ai_polish_availability_v2", "p_user_id uuid", "f", true, "65764e7c65797c3796d9cb8470e2f00dcefa300285b943016ea8b0d9491bcd2a"],
  ["guard_ai_request_legal_acceptance_v2", "", "f", true, "b557efe180f29392a48c25ae3494d47c2a28f530242ea676b8ebc06dea508396"],
  ["admin_guard_committed_operation_v1", "", "f", false, "0fee26e267566d4ec90ff3429811dfe48eeaecb8f67ecc877be4ba888498115c"],
  ["admin_canonical_operation_payload_sha256_v1", "p_operation_kind text, p_payload jsonb", "f", false, "09a2e7cb5965ddcf849c1beffa034b10bad6c0406bdc5e649027d9e7118aebd2"],
  ["admin_has_recent_totp_v1", "p_actor uuid", "f", true, "c2065c979fa0e20efea4b7a46f142550337b68f6f0655774491a8672ac30408a"],
  ["admin_assert_write_actor_v1", "p_environment text, p_project_ref text, p_require_recent_totp boolean", "f", true, "dc89261db47d8b942c51d6961d7ec4432450140bfb8cb56c5a8c2d9dcb7cd98a"],
  ["admin_lock_committed_operation_v1", "p_actor uuid, p_operation_kind text, p_idempotency_key uuid, p_typed_payload jsonb", "f", true, "0254dd150cf83d28396f4400bb90b89ccb616cecdcbf8872188c83416ddcb8aa"],
  ["admin_commit_operation_v1", "p_actor uuid, p_operation_kind text, p_idempotency_key uuid, p_typed_payload jsonb, p_committed_result jsonb, p_domain_audit_id uuid", "f", true, "446d2aa50b5f6430a7d069c7477a52b689cb4dafd026207dc7b15c88cfd1838a"],
  ["admin_get_committed_operation_v1", "p_environment text, p_project_ref text, p_operation_kind text, p_idempotency_key uuid", "f", true, "d6f05e1e2fb10f7e9d1b7f54b4bccff34dfd0f2edd6c891a60a66baa9038c0fe"],
  ["admin_get_write_authority_v1", "p_environment text, p_project_ref text", "f", true, "bc7c586897201daf4a6640710eedbf90cce49b0f602e0f1a075e9d8af838314b"],
  ["admin_guard_validation_evidence_v1", "", "f", false, "af4a0cf10d265a892bdbc85cd24cbfae572110f5757884a3ef320199ca1962fa"],
  ["admin_import_reviewed_deployment_v1", "p_id uuid, p_environment text, p_project_ref text, p_runtime_build_id text, p_binding_manifest_revision text, p_binding_manifest_sha256 text, p_code_capability_ids text[], p_reviewed_evidence_ids text[], p_reviewed_source_commit_oid text, p_reviewed_source_sha256 text, p_valid_until timestamp with time zone", "f", true, "2444dd13a8988a23da6350f9c7379873fade9fd9790e823f7598195032d7b0fd"],
  ["get_admin_validation_candidate_v1", "p_reviewed_deployment_id uuid, p_runtime_contract_id text, p_runtime_target_id text", "f", true, "f28950ac8a97ab47a947a9c8fb2302ba2d7d0176f4d91ac3615221fd9dd9c615"],
  ["record_admin_validation_report_v1", "p_reviewed_deployment_id uuid, p_runtime_contract_id text, p_runtime_target_id text, p_observed_runtime_build_id text, p_observed_binding_manifest_revision text, p_observed_binding_manifest_sha256 text, p_observed_code_capability_sha256 text, p_endpoint_policy_valid boolean, p_manifest_binding_valid boolean, p_credential_configured boolean, p_compiled_capability_valid boolean", "f", true, "176ae0b3234b8401ceecaa819b36b53147c833edf17fd70904dbea0e5cb19ecb"],
  ["get_admin_runtime_validation_v1", "p_runtime_contract_id text, p_runtime_target_id text", "f", true, "9cb4c545c19f2cbae0b6c61f95ef1f055d7588a9608161cc21e61d810e61e20a"],
  ["get_ai_polish_execution_snapshot_v3", "p_reservation_id uuid, p_user_id uuid", "f", true, "4f9cd90873cd3037c97e7b5f3efaffb5021233b804c8478e9f4272c46b1cae5a"],
  ["admin_guard_control_evidence_v1", "", "f", false, "4b08eed2301e932b6914c98312ddbb19fd16e301ddc6f9cea8dd20eeb4c7b335"],
  ["admin_assert_jwt_control_mode_v1", "", "f", true, "bd9defe7ee2e30ca07e5559715c73efcb74ac1bb71e5ca86d577521273334f55"],
  ["admin_replayed_operation_v1", "p_replay jsonb, p_operation_kind text, p_idempotency_key uuid", "f", false, "8c4d33a98179917968e41e792f6cbecf56b5b4b65e716cfc63bab0086ce031d0"],
  ["admin_policy_effective_routes_v1", "p_policy_version_id uuid", "f", true, "ea7df88a8551995b39fdb81195fd92d811e45523ff9b9deb466d1de4444aaf09"],
  ["admin_assert_policy_validation_reports_legacy_internal_v1", "p_policy_version_id uuid, p_validation_report_ids uuid[], p_at timestamp with time zone", "f", true, "b6b1fc6d3765f20ced0846e9aca6a490dd61aa6a562b57e7ba5407da6f34b343"],
  ["admin_assert_policy_validation_reports_v1", "p_policy_version_id uuid, p_validation_report_ids uuid[], p_at timestamp with time zone", "f", true, "afda5a2965b4b09d98b62554b37d67a7d11aa42e668617296bddf1c9472f3532"],
  ["admin_assert_policy_validation_reports_v2", "p_policy_version_id uuid, p_validation_report_ids uuid[], p_at timestamp with time zone", "f", true, "512fa159bac9c11adf11e473435d7bd954104898ff896177bc9841f01976d553"],
  ["admin_disable_ai_v1", "p_environment text, p_project_ref text, p_expected_control_revision bigint, p_reason text, p_idempotency_key uuid", "f", true, "1145a7d4e091d4e2bcc2162dda906ab3c5886adf4f0db2654b5fdbf19a192d8e"],
  ["admin_set_ai_routing_pointer_v1", "p_environment text, p_project_ref text, p_policy_version_id uuid, p_validation_report_ids uuid[], p_expected_control_revision bigint, p_expected_policy_version_id uuid, p_expected_config_generation bigint, p_reason text, p_idempotency_key uuid", "f", true, "f4895cff7edb3d92bd849c59afa54426f90268eb2a45f12f280839e5a8a1d562"],
  ["admin_clear_ai_routing_pointer_v1", "p_environment text, p_project_ref text, p_validation_report_ids uuid[], p_expected_control_revision bigint, p_expected_policy_version_id uuid, p_expected_config_generation bigint, p_reason text, p_idempotency_key uuid", "f", true, "a3049cd7d055ba1751cb97022674fe1406182316b2a9e02fce1c68917a237826"],
  ["record_admin_runtime_readback_v1", "p_reviewed_deployment_id uuid, p_policy_version_id uuid, p_validation_report_ids uuid[], p_observed_runtime_build_id text, p_observed_binding_manifest_revision text, p_observed_binding_manifest_sha256 text", "f", true, "824efbe734b06108101709006b219a687f35f5cbf40be56886ebdbe1bf90eb26"],
  ["admin_reopen_ai_v1", "p_environment text, p_project_ref text, p_readback_report_id uuid, p_expected_closing_cycle_id uuid, p_expected_control_revision bigint, p_expected_policy_version_id uuid, p_expected_config_generation bigint, p_reason text, p_idempotency_key uuid", "f", true, "e7594f0d007c476b96a18d99376148638e5b08766fa224c50df7ef498497373e"],
  ["admin_get_ai_control_state_v1", "p_environment text, p_project_ref text", "f", true, "de5c4ebd4b15bb270c2f43be808aab6350713278502ce26f942974e98ba6b191"],
  ["admin_cutover_authority_legacy_internal_v1", "p_reviewed_deployment_id uuid, p_validation_report_ids uuid[], p_expected_environment_revision bigint, p_expected_control_revision bigint, p_reason text", "f", true, "aa682bf3e24ae883ffe23b7382ec27c21095f1b9c16c2435e273a1550c0dfaf6"],
  ["admin_cutover_authority_v2", "p_reviewed_deployment_id uuid, p_admission_id uuid, p_validation_report_ids uuid[], p_expected_environment_revision bigint, p_expected_control_revision bigint, p_reason text", "f", true, "a22f7d7ac765f904ada39863f396524e20e98f85fa88fa6c5d46ccc5bead7cee"],
  ["admin_json_jcs_v1", "p_value jsonb", "f", false, "d3b0cf98d2c015e64dc870578a148b1a1d4bf312b7fe4f8138c135382f4492ba"],
  ["admin_json_jcs_sha256_v1", "p_value jsonb", "f", false, "d9df9752380bf66e65b5e56025595f9993b04e667613c1071cecbba4687521eb"],
  ["admin_assert_reason_v1", "p_reason text", "f", false, "53e07731744a82c8b0660948f2ff2eb7b5ca5b0e45a7b4a11236fd1aaad852c7"],
  ["admin_set_membership_v1", "p_environment text, p_project_ref text, p_target_user_id uuid, p_enabled boolean, p_expected_revision bigint, p_reason text, p_idempotency_key uuid", "f", true, "f9ac25d58a9e8cc373251161e2f9c434f34b492480e885e322f6f22fb1bcc6dc"],
  ["admin_update_provider_defaults_v1", "p_environment text, p_project_ref text, p_provider_id uuid, p_display_name text, p_default_adapter_id text, p_default_endpoint_url text, p_default_credential_env_name text, p_default_model_id text, p_archived boolean, p_expected_revision bigint, p_reason text, p_idempotency_key uuid", "f", true, "ff483b3925fdf23b8b8cbd1a40c0573a1ab5a300d38769602ca9edcdd957b8d9"],
  ["admin_create_provider_profile_v1", "p_environment text, p_project_ref text, p_provider_id uuid, p_profile_key text, p_display_name text, p_model_vendor text, p_reason text, p_idempotency_key uuid", "f", true, "bfc66dc7e65678488768fccd1d6758f049a147541adeba818f15d9096e6849c8"],
  ["admin_create_profile_version_v2", "p_environment text, p_project_ref text, p_profile_id uuid, p_expected_latest_version integer, p_adapter_id text, p_wire_api_kind text, p_endpoint_url text, p_credential_env_name text, p_model_id text, p_capability_contract_id text, p_cache_policy_id text, p_legal_manifest_id text, p_display_disclosure_key text, p_config jsonb, p_reason text, p_idempotency_key uuid", "f", true, "4562cf47ed29b9d7520b583bfed2b5bb79bc455e9677592ac89835eea0a47aa9"],
  ["admin_create_price_version_v1", "p_environment text, p_project_ref text, p_profile_version_id uuid, p_pricing_lane text, p_expected_latest_version integer, p_currency text, p_calculator_kind text, p_valid_from timestamp with time zone, p_valid_to timestamp with time zone, p_provider_effective_from timestamp with time zone, p_provider_effective_to timestamp with time zone, p_source_url text, p_source_checked_at timestamp with time zone, p_source_snapshot_sha256 text, p_parameters jsonb, p_components jsonb, p_reason text, p_idempotency_key uuid", "f", true, "acf166c58045e3223a289cb9da36ea6302464343ecfdc7c073e6ec3482b3d5c4"],
  ["admin_set_global_daily_limit_v1", "p_environment text, p_project_ref text, p_global_daily_limit integer, p_expected_global_daily_limit integer, p_expected_control_revision bigint, p_reason text, p_idempotency_key uuid", "f", true, "222414159863be2fe703387ca9db915d5668ac78baf32ddc1169f6efc4fdb0e2"],
  ["admin_runtime_validation_evidence_v1", "p_report_id uuid, p_expected_profile_version_id uuid, p_expected_price_version_id uuid, p_at timestamp with time zone", "f", true, "407a2bf83150039b92bdfd8fd270524e0506258bad456df82867acbb7ed71e45"],
  ["admin_seal_price_for_activation_v1", "p_environment text, p_project_ref text, p_price_version_id uuid, p_runtime_contract_id text, p_reviewed_deployment_id uuid, p_reason text, p_idempotency_key uuid", "f", true, "a57aee1e3b0d813155fa6b587035534e43b30276f2e712bb4d47e5ba3c0e9bc6"],
  ["admin_transition_profile_version_v1", "p_environment text, p_project_ref text, p_profile_version_id uuid, p_to_status text, p_validation_report_id uuid, p_reason text, p_idempotency_key uuid", "f", true, "c8f9430ffb703bed01faffbc43db7bcf36c4ba54e418f46cabf9d18a0c25dc35"],
  ["admin_create_routing_policy_v1", "p_environment text, p_project_ref text, p_policy_key text, p_expected_latest_version integer, p_rules jsonb, p_default_profile_version_id uuid, p_legal_bundle_version text, p_runtime_contract_id text, p_validation_report_ids uuid[], p_reason text, p_idempotency_key uuid", "f", true, "ab845a22d3e57b3d114e079efe005355cff2d46d90ea6f014ad0dd00a35bc8fb"],
  ["admin_transition_routing_policy_v1", "p_environment text, p_project_ref text, p_policy_version_id uuid, p_to_status text, p_validation_report_ids uuid[], p_reason text, p_idempotency_key uuid", "f", true, "28ddf2f2e3929975a7c4a3644d112f8e5e90c15f916687a5a0d88fbe7d101918"],
  ["admin_close_price_version_v1", "p_environment text, p_project_ref text, p_price_version_id uuid, p_valid_to timestamp with time zone, p_successor_price_version_id uuid, p_validation_report_id uuid, p_reason text, p_idempotency_key uuid", "f", true, "a72e5dbd587839444dd4eec5a9c678c72d864e06168a4032b7617fbf5dbab2cc"],
  ["admin_retire_profile_version_v1", "p_environment text, p_project_ref text, p_profile_version_id uuid, p_validation_report_id uuid, p_reason text, p_idempotency_key uuid", "f", true, "46723f151d405c35fac939a15af95ccd2e5258ee6721a168ecd707400d515d64"],
  ["admin_retire_provider_profile_v1", "p_environment text, p_project_ref text, p_profile_id uuid, p_validation_report_id uuid, p_reason text, p_idempotency_key uuid", "f", true, "5d75537d71e78ab14055c70f7108882b7b4b90c2dc6f2ecb8f4fce6b3e1e5a2f"],
  ["admin_validate_admitted_runtime_target_v1", "", "f", true, "e9b6d92143ca6acb8ed705ec2c237bb43f459eee684dfb3872089cb67a7918d4"],
  ["admin_guard_admitted_runtime_target_immutable_v1", "", "f", false, "49a75875063bfeb4fab28e768da4b5c0e7023b81d35f0889f14cb6630d715c35"],
  ["admin_guard_admitted_runtime_deployment_v1", "", "f", false, "61513df2072c251cdabaf83c365219197bd5d97dc1f56d2461d3b97dc1dfc24f"],
  ["admin_assert_reviewed_capability_set_v1", "", "f", true, "7c46a1d26d0e84e7b661082a02fd8adc3acb4099e1083a97c6dd49e7b813082c"],
  ["admin_admit_runtime_deployment_v1", "p_reviewed_deployment_id uuid, p_environment text, p_project_ref text, p_runtime_build_id text, p_binding_manifest_revision text, p_binding_manifest_sha256 text, p_runtime_target_ids text[], p_reason text", "f", true, "59f225a48f4b421f9431c73d7656e49606517661356e2e33f1f459ff6381c5f8"],
  ["admin_revoke_runtime_deployment_v1", "p_environment text, p_project_ref text, p_runtime_build_id text, p_binding_manifest_revision text, p_expected_admission_revision bigint, p_reason text", "f", true, "7ab2f1f6e97bbdd08412db347fa171a0366e37ffc941f8ba21f9447d269cd589"],
  ["get_admin_admitted_runtime_deployment_v1", "p_environment text, p_project_ref text, p_runtime_build_id text, p_binding_manifest_revision text, p_binding_manifest_sha256 text", "f", true, "2302795cd3c479126fcc80d73e5a36788a1eae629875d225d34418c918a5be95"],
  ["admin_admit_runtime_deployment_v2", "p_reviewed_deployment_id uuid, p_targets jsonb, p_reason text", "f", true, "76361f2c6c86356b8f8719a7f094645f8043b782438328da4fc092b94a5d22f5"],
  ["admin_assert_runtime_admission_sealed_v2", "", "f", true, "00d0265290c5005a2ad56e3e268bac365a8de18c198bfbc1fd6829cc1eb834c5"],
  ["admin_guard_runtime_admission_parent_v2", "", "f", false, "9866b0449d819299a60ae4a20b2dc3cbeb0b4064c1dbc3d8014be8cbd3d79703"],
  ["admin_revoke_runtime_deployment_v2", "p_admission_id uuid, p_expected_admission_revision bigint, p_expected_target_set_sha256 text, p_reason text", "f", true, "3450dcc9756ae31c1fcb42328c09c7c06140dac27d79b5efffb07dfe56ab80df"],
  ["admin_runtime_target_set_sha256_v2", "p_admission_id uuid", "f", true, "854cf6dadcd97d81013cb0e34a77da8933011f2437a6fa0010224f6df344dd64"],
  ["admin_validate_runtime_admission_target_v2", "", "f", true, "7caa288835972b69296d7124a04755fb820185bfac6ba1240c583c204031f2ef"],
  ["get_ai_polish_execution_snapshot_v4", "p_reservation_id uuid, p_user_id uuid, p_environment text, p_project_ref text, p_runtime_build_id text, p_binding_manifest_revision text, p_binding_manifest_sha256 text", "f", true, "ed3d28be232cc6968c77db06f76c30953f44d9fe7aa254f461e13e7a7af3c65b"],
  ["guard_ai_attempt_runtime_admission_v2", "", "f", false, "913c99103f3d984fae9272bbdabc065a2709f0ac11a3b7b1800afc47cf0382b4"],
  ["guard_ai_provider_attempt_ledger", "", "f", false, "d9875f2678d79aa6d6affda1c5f94f23a8a518434a365886a057215fe8d18482"],
  ["admin_guard_runtime_authority_receipt_v2", "", "f", false, "9f35a9f444fe5258b25fe6930464444dccea784bec9cb91c854198b9f4080796"],
  ["record_admin_runtime_readback_v2", "p_reviewed_deployment_id uuid, p_admission_id uuid, p_admission_revision bigint, p_target_set_sha256 text, p_policy_version_id uuid, p_validation_report_ids uuid[], p_observed_runtime_build_id text, p_observed_binding_manifest_revision text, p_observed_binding_manifest_sha256 text", "f", true, "58258fa666910888118cf450f083bb54bf5b5745c7dbec54f90252f0375ef040"],
  ["start_ai_polish_provider_attempt_v3", "p_reservation_id uuid, p_attempt_no integer, p_admission_id uuid, p_reviewed_deployment_id uuid, p_validation_report_id uuid, p_environment text, p_project_ref text, p_runtime_build_id text, p_binding_manifest_revision text, p_binding_manifest_sha256 text, p_admission_revision bigint, p_target_set_sha256 text, p_runtime_contract_id text, p_runtime_target_id text, p_runtime_target_sha256 text", "f", true, "aadf672903e41e8e414f730e31e8bb7b9f6887afe5c27e2782f1ec6f0da1940b"],
  ["start_ai_polish_provider_attempt_v4", "p_reservation_id uuid, p_attempt_no integer, p_runtime_admission jsonb", "f", true, "b3d1cd34904796312a8e90be6b388731475baa48e0d069b014c7d4f8392dc9f2"],
  ["admin_get_ai_analytics_v1", "p_environment text, p_project_ref text, p_from timestamp with time zone, p_to timestamp with time zone", "f", true, "ccb418c09a90f0284f714dbb986c5f7658106341bb0a39d89821a6c4f28caef2"],
] as const;
const SUCCESSOR_ROUTINE_VALUES_SQL = NON_SYSTEM_ROUTINE_AUTHORITY_SUCCESSOR_V1
  .map(([name, identityArguments, prokind]) => `('${name}'::text, '${identityArguments}'::text, '${prokind}'::text)`)
  .join(",");
const IS_SUCCESSOR_ROUTINE_SQL = `exists (
  select 1 from (values ${SUCCESSOR_ROUTINE_VALUES_SQL}) as successor(name, identity_arguments, prokind)
  where namespace.nspname='public' and successor.name=procedure.proname
    and successor.identity_arguments=pg_catalog.pg_get_function_identity_arguments(procedure.oid)
    and successor.prokind=procedure.prokind::text
)`;

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
    .replace(/\r\n?/gu, "\n")
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
      delete from public.ai_price_component_seal_intents
      where price_version_id = '${DB012_LEGACY_PRICE_ID}'::uuid;
      delete from public.ai_price_components
      where price_version_id = '${DB012_LEGACY_PRICE_ID}'::uuid;
      delete from public.ai_price_versions
      where id = '${DB012_LEGACY_PRICE_ID}'::uuid;
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
    update public.${table}
    set id = '${alternateId}'::uuid
    where id = '${canonicalId}'::uuid;
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
      runtime_contract_id,
      legal_bundle_version, bundle_contract_sha256, runtime_target_set_sha256,
      sealed_at
    ) values (
      'history-runtime-contract.cfg001.v1',
      '2026-08-23-multi-provider-v1',
      'fc26d1e1a016fda055fbe6a0b79b48d804fd7610e03bd5aa29389be37359ca18',
      repeat('9', 64), clock_timestamp()
    );
    insert into public.ai_service_runtime_contract_targets (
      runtime_contract_id, runtime_target_id,
      runtime_target_sha256, profile_key, legal_manifest_id, manifest_sha256,
      route_descriptor_id, route_descriptor_sha256
    ) values (
      'history-runtime-contract.cfg001.v1',
      'history-runtime-target.cfg001.v1', repeat('6', 64),
      'history.cfg001.rollback.v1', 'deepseek-official-2026-08-23-v1',
      '0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b',
      'history-route.cfg001.v1', repeat('7', 64)
    );
    insert into public.ai_routing_policy_versions (
      id, policy_key, version, status, timezone, rules,
      default_profile_version_id, legal_bundle_version, config_sha256,
      runtime_contract_id
    ) values (
      '44444444-4444-4444-8444-444444444413'::uuid,
      'history.cfg001.rollback.v1', 1, 'draft', 'Asia/Shanghai',
      '{}'::jsonb, '44444444-4444-4444-8444-444444444411'::uuid,
      '2026-08-23-multi-provider-v1', repeat('a', 64),
      'history-runtime-contract.cfg001.v1'
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
      legal_bundle_version, runtime_contract_id,
      gateway_kind, model_id, wire_api_kind, display_disclosure_key,
      adapter_kind, credential_alias, endpoint_alias, capability_contract_id,
      cache_policy_id, legal_manifest_id, calculator_kind, billing_currency
    ) values (
      :'history_request_reservation_id'::uuid, 1, 'route_snapshot_v1', 1,
      '44444444-4444-4444-8444-444444444413'::uuid,
      '44444444-4444-4444-8444-444444444411'::uuid,
      '44444444-4444-4444-8444-444444444412'::uuid,
      '2026-08-23-multi-provider-v1', 'history-runtime-contract.cfg001.v1',
      'direct_deepseek', 'history-model',
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
  const baseline = snapshotSeedRows();
  const user = await createTestUser(service, "cfg001-hostile-history");
  try {
    const result = runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      \set VERBOSITY verbose
      \pset format unaligned
      \pset tuples_only on
      begin;
      ${historicalFixtureSql(user.id)}
      -- Only the hostile precondition bypasses successor FKs/triggers.  The
      -- migration itself must observe the normal origin authority graph.
      set local session_replication_role = replica;
      ${precondition}
      set local session_replication_role = origin;
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
    expect(snapshotSeedRows()).toBe(baseline);
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
        provider_effective_to: expected?.providerEffectiveTo,
        source_url: SEED.pricing.sourceUrl,
        source_snapshot_sha256: SEED.pricing.sourceSnapshotSha256,
        parameters: expected?.parameters,
        components_sealed_at: expected?.componentsSealedAt,
      });
      expect(new Date(row.valid_from).toISOString()).toBe(expected?.validFrom);
      expect(
        row.provider_effective_from === null
          ? null
          : new Date(row.provider_effective_from).toISOString(),
      ).toBe(expected?.providerEffectiveFrom);
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
        "id,policy_key,version,status,timezone,rules,default_profile_version_id,legal_bundle_version,runtime_contract_id,config_sha256,validated_at,activated_at,retired_at",
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
            and not (${IS_SUCCESSOR_ROUTINE_SQL})
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
            and not (${IS_SUCCESSOR_ROUTINE_SQL})
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
            and not (${IS_SUCCESSOR_ROUTINE_SQL})
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
              and not (${IS_SUCCESSOR_ROUTINE_SQL})
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
        ),
        'successorRoutineAuthority', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'schema', namespace.nspname,
              'name', procedure.proname,
              'identityArguments', pg_catalog.pg_get_function_identity_arguments(procedure.oid),
              'prokind', procedure.prokind,
              'prosecdef', procedure.prosecdef,
              'owner', pg_catalog.pg_get_userbyid(procedure.proowner),
              'definitionSha256', pg_catalog.encode(extensions.digest(${CANONICAL_ROUTINE_DEFINITION_SQL}, 'sha256'), 'hex'),
              'publicExecute', exists (select 1 from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) as acl where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'),
              'anonExecute', pg_catalog.has_function_privilege('anon', procedure.oid, 'EXECUTE'),
              'authenticatedExecute', pg_catalog.has_function_privilege('authenticated', procedure.oid, 'EXECUTE'),
              'serviceRoleExecute', pg_catalog.has_function_privilege('service_role', procedure.oid, 'EXECUTE')
            ) order by procedure.proname
          )
          from pg_catalog.pg_proc as procedure
          join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
          join (values ${SUCCESSOR_ROUTINE_VALUES_SQL}) as expected(name, identity_arguments, prokind)
            on expected.name = procedure.proname
            and expected.identity_arguments = pg_catalog.pg_get_function_identity_arguments(procedure.oid)
            and expected.prokind = procedure.prokind::text
          where namespace.nspname = 'public'
            and procedure.prokind in ('f', 'p')
        ), '[]'::jsonb)
      )::text;
    `);

    expect(security).toEqual({
      privilegeCount: 0,
      nonSystemRoutineAuthority: NON_SYSTEM_ROUTINE_AUTHORITY_ROOT_V1,
      successorRoutineAuthority: [...NON_SYSTEM_ROUTINE_AUTHORITY_SUCCESSOR_V1].sort((a,b) => a[0].localeCompare(b[0])).map(
        ([name, identityArguments, prokind, prosecdef, definitionSha256]) => ({
          schema: "public",
          name,
          identityArguments,
          prokind,
          prosecdef,
          owner: "postgres",
          definitionSha256,
          publicExecute: false,
          anonExecute: false,
          authenticatedExecute: [
            "admin_get_context_v1",
            "admin_list_records_v1",
            "admin_get_record_v1",
            "admin_get_committed_operation_v1",
            "admin_get_write_authority_v1",
            "accept_ai_legal_disclosure_v2",
            "admin_clear_ai_routing_pointer_v1",
            "admin_close_price_version_v1",
            "admin_create_price_version_v1",
            "admin_create_profile_version_v2",
            "admin_create_provider_profile_v1",
            "admin_create_routing_policy_v1",
            "admin_disable_ai_v1",
            "admin_get_ai_analytics_v1",
            "admin_get_ai_control_state_v1",
            "admin_reopen_ai_v1",
            "admin_retire_profile_version_v1",
            "admin_retire_provider_profile_v1",
            "admin_seal_price_for_activation_v1",
            "admin_set_ai_routing_pointer_v1",
            "admin_set_global_daily_limit_v1",
            "admin_set_membership_v1",
            "admin_transition_profile_version_v1",
            "admin_transition_routing_policy_v1",
            "admin_update_provider_defaults_v1",
          ].includes(name),
          serviceRoleExecute: [
            "get_ai_current_legal_bundle_v2",
            "get_ai_legal_display_v2",
            "get_ai_polish_availability_v2",
            "get_ai_polish_execution_snapshot_v2",
            "get_ai_polish_execution_snapshot_v3",
            "get_admin_validation_candidate_v1",
            "record_admin_validation_report_v1",
            "get_admin_runtime_validation_v1",
            "start_ai_polish_provider_attempt_v2",
            "start_ai_polish_provider_attempt_v3",
            "start_ai_polish_provider_attempt_v4",
            "get_ai_polish_execution_snapshot_v4",
            "record_admin_runtime_readback_v1",
            "record_admin_runtime_readback_v2",
          ].includes(name),
        }),
      ),
      publicExecuteRoutines: [],
      publicSecurityDefiners: PUBLIC_SECURITY_DEFINER_AUTHORITY_V1,
      runtimeRoutines: RUNTIME_ROUTINE_AUTHORITY_V1,
    });

    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const statement of [
        String.raw`insert into public.ai_service_runtime_contract_versions (
          runtime_contract_id,
          legal_bundle_version,
          bundle_contract_sha256,
          runtime_target_set_sha256
        ) values (
          'blocked.${role}',
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
            runtime_target_id,
            runtime_target_sha256,
            profile_key,
            legal_manifest_id,
            manifest_sha256,
            route_descriptor_id,
            route_descriptor_sha256
          ) values (
            '${SEED.runtime.contract.runtimeContractId}',
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
    )
      .replace(/\r\n?/gu, "\n")
      .toLowerCase();

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
    it("keeps the exact CFG001 owner slice while successor roots remain visible", () => {
      const actual = parseOwnerJson(String.raw`
        select pg_catalog.jsonb_build_object(
          'profiles', (
            select count(*)
            from public.ai_provider_profiles
            where id = '${SEED.profile.id}'::uuid
              and profile_key = '${SEED.profile.profileKey}'
          ),
          'profileVersions', (
            select count(*)
            from public.ai_provider_profile_versions
            where id = '${SEED.profile.profileVersionId}'::uuid
              and profile_id = '${SEED.profile.id}'::uuid
              and version = ${SEED.profile.version}
              and status = '${SEED.profile.status}'
          ),
          'prices', (
            select count(*)
            from public.ai_price_versions
            where id in (
              '${SEED.pricing.rows[0].id}'::uuid,
              '${SEED.pricing.rows[1].id}'::uuid,
              '${DB012_LEGACY_PRICE_ID}'::uuid
            )
          ),
          'priceLanes', (
            select pg_catalog.jsonb_agg(pricing_lane order by pricing_lane)
            from public.ai_price_versions
            where id in (
              '${SEED.pricing.rows[0].id}'::uuid,
              '${SEED.pricing.rows[1].id}'::uuid,
              '${DB012_LEGACY_PRICE_ID}'::uuid
            )
          ),
          'components', (
            select count(*)
            from public.ai_price_components
            where price_version_id in (
              '${SEED.pricing.rows[0].id}'::uuid,
              '${SEED.pricing.rows[1].id}'::uuid,
              '${DB012_LEGACY_PRICE_ID}'::uuid
            )
          ),
          'legacySealIntents', (
            select count(*) from public.ai_price_component_seal_intents
            where price_version_id = '${DB012_LEGACY_PRICE_ID}'::uuid
              and applied_at is not null
          ),
          'g2Policy', (
            select count(*)
            from public.ai_routing_policy_versions
            where id = '${SEED.policy.id}'::uuid
              and policy_key = '${SEED.policy.policyKey}'
              and version = ${SEED.policy.version}
              and status = '${SEED.policy.status}'
              and runtime_contract_id = '${SEED.policy.runtimeContractId}'
          ),
          'legacyRoot', (
            select count(*)
            from public.ai_service_runtime_contract_versions
            where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}'
              and sealed_at is not null
          ),
          'sharedDeepseekTarget', (
            select count(*)
            from public.ai_service_runtime_target_versions
            where runtime_target_id = '${SEED.runtime.targets[0].runtimeTargetId}'
              and runtime_target_sha256 = '${SEED.runtime.targets[0].runtimeTargetSha256}'
              and profile_key = '${SEED.runtime.targets[0].profileKey}'
              and legal_manifest_id = '${SEED.runtime.targets[0].legalManifestId}'
              and manifest_sha256 = '${SEED.runtime.targets[0].manifestSha256}'
              and route_descriptor_id = '${SEED.runtime.targets[0].routeDescriptorId}'
              and route_descriptor_sha256 = '${SEED.runtime.targets[0].routeDescriptorSha256}'
          ),
          'legacyMembership', (
            select count(*)
            from public.ai_service_runtime_contract_targets
            where runtime_contract_id = '${SEED.runtime.contract.runtimeContractId}'
              and runtime_target_id = '${SEED.runtime.targets[0].runtimeTargetId}'
              and runtime_target_sha256 = '${SEED.runtime.targets[0].runtimeTargetSha256}'
              and profile_key = '${SEED.runtime.targets[0].profileKey}'
              and legal_manifest_id = '${SEED.runtime.targets[0].legalManifestId}'
              and manifest_sha256 = '${SEED.runtime.targets[0].manifestSha256}'
              and route_descriptor_id = '${SEED.runtime.targets[0].routeDescriptorId}'
              and route_descriptor_sha256 = '${SEED.runtime.targets[0].routeDescriptorSha256}'
          ),
          'combinedV2Memberships', (
            select pg_catalog.jsonb_agg(runtime_target_id order by runtime_target_id)
            from public.ai_service_runtime_contract_targets
            where runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v2'
          ),
          'cfg003Policies', (
            select coalesce(
              pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'id', id,
                  'key', policy_key,
                  'version', version,
                  'status', status,
                  'timezone', timezone,
                  'rules', rules,
                  'default', default_profile_version_id,
                  'legal', legal_bundle_version,
                  'runtime', runtime_contract_id,
                  'config', config_sha256,
                  'validated', validated_at,
                  'active', activated_at,
                  'retired', retired_at
                ) order by id
              ),
              '[]'::jsonb
            )
            from public.ai_routing_policy_versions
            where id in (
              '${G4_SEED.policies.g4.id}'::uuid,
              '${G4_SEED.policies.rollback.id}'::uuid
            )
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
        g2Policy: 1,
        legacyRoot: 1,
        sharedDeepseekTarget: 1,
        legacyMembership: 1,
        combinedV2Memberships: [
          "runtime-target.deepseek.official.deepseek-v4-flash.chat.v1",
          "runtime-target.mimo.cn.mimo-v2.5-pro.responses.v1",
        ],
        cfg003Policies: Object.values(G4_SEED.policies).map((policy) => ({
          id: policy.id,
          key: policy.policyKey,
          version: policy.version,
          status: policy.status,
          timezone: policy.timezone,
          rules: policy.rules,
          default: policy.defaultProfileVersionId,
          legal: G4_SEED.legalBundleVersion,
          runtime: policy.runtimeContractId,
          config: policy.configSha256,
          validated: null,
          active: null,
          retired: null,
        })),
        legalHeaders: 1,
        legalManifests: 2,
        legalMemberships: 2,
        feature: { enabled: false, pointer: null, generation: 0 },
        dynamicRows: 0,
      });
    });
  },
);
