import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MIMO_V2_SEED_IDENTITY_V1 } from "@/server/polish/mimo-v2-seed-identity-v1";
import { DEEPSEEK_MIMO_RUNTIME_CONTRACT_DB_FIXTURE_V1 } from "@/server/polish/service-runtime-contract-v1";

import { RUN_DB_TESTS } from "./helpers";
import { runOwnerSql } from "./runtime-contract-fixtures";

const RUN_CFG002_FRESH_RESET = process.env.CFG002_FRESH_RESET === "1";
const MIGRATION_URL = new URL(
  "../../../supabase/migrations/20260824006000_seed_mimo_v2_draft.sql",
  import.meta.url,
);
const PROFILE_ID = MIMO_V2_SEED_IDENTITY_V1.profile.id;
const PROFILE_VERSION_ID = MIMO_V2_SEED_IDENTITY_V1.profile.profileVersionId;
const PRICE_ID = MIMO_V2_SEED_IDENTITY_V1.pricing.reservedDefaultPriceVersionId;
const CONTRACT = DEEPSEEK_MIMO_RUNTIME_CONTRACT_DB_FIXTURE_V1.contract;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

function ownerJson(sql: string): unknown {
  const result = runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    \pset format unaligned
    \pset tuples_only on
    ${sql}
  `);
  const line = result.stdout.split(/\r?\n/u).map((value) => value.trim())
    .findLast((value) => value.startsWith("{") || value.startsWith("["));
  if (!line) throw new Error(`owner query returned no JSON: ${result.stdout}`);
  return JSON.parse(line);
}

function migrationBody(): string {
  return readFileSync(MIGRATION_URL, "utf8")
    .replace(/^begin;\s*$/mu, "")
    .replace(/^commit;\s*$/mu, "");
}

function snapshot(): string {
  const result = runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    \pset format unaligned
    \pset tuples_only on
    select pg_catalog.jsonb_build_object(
      'profile', (select pg_catalog.to_jsonb(row_value) from public.ai_provider_profiles row_value where id='${PROFILE_ID}'::uuid),
      'version', (select pg_catalog.to_jsonb(row_value) from public.ai_provider_profile_versions row_value where id='${PROFILE_VERSION_ID}'::uuid),
      'price', (select pg_catalog.to_jsonb(row_value) from public.ai_price_versions row_value where id='${PRICE_ID}'::uuid),
      'components', (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_value) order by component collate "C") from public.ai_price_components row_value where price_version_id='${PRICE_ID}'::uuid),
      'root', (select pg_catalog.to_jsonb(row_value) from public.ai_service_runtime_contract_versions row_value where runtime_contract_id='${CONTRACT.runtimeContractId}'),
      'memberships', (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_value) order by runtime_target_id collate "C") from public.ai_service_runtime_contract_targets row_value where runtime_contract_id='${CONTRACT.runtimeContractId}'),
      'feature', (select pg_catalog.to_jsonb(row_value) from public.ai_feature_config row_value where id=true),
      'auditCount', (select count(*) from public.ai_routing_lifecycle_audit),
      'sealIntentCount', (select count(*) from public.ai_price_component_seal_intents)
    )::text;
  `);
  const line = result.stdout.split(/\r?\n/u).map((value) => value.trim()).findLast((value) => value.startsWith("{"));
  if (!line) throw new Error("CFG-002 snapshot is missing");
  return line;
}

describe("CFG-002 MiMo V2 seed static contract", () => {
  it("keeps the seed DML-only, dark, and explicitly outside price sealing", () => {
    const migration = readFileSync(MIGRATION_URL, "utf8").toLowerCase();
    expect(migration.match(/^begin;$/gm)).toHaveLength(1);
    expect(migration.match(/^commit;$/gm)).toHaveLength(1);
    expect(migration).not.toMatch(/\bon\s+conflict\s+do\s+update\b/);
    expect(migration).not.toMatch(/\b(?:create|alter|grant|revoke)\b/);
    expect(migration).not.toMatch(/seal_ai_price(?:_for_activation|_components)?_v1/);
    expect(migration).not.toMatch(/\b(?:ai_feature_config|ai_routing_policy_versions|ai_routing_lifecycle_audit|ai_price_component_seal_intents)\b\s*(?:\(|set|values)/);
    expect([...migration.matchAll(/\bupdate\s+public\.(ai_[a-z0-9_]+)/g)].map((match) => match[1]))
      .toEqual(["ai_service_runtime_contract_versions"]);
  });

  it("cross-checks frozen MiMo identity JCS and the reviewed combined fixture", () => {
    const profile = MIMO_V2_SEED_IDENTITY_V1.profile;
    const jcs = canonicalize(profile.config);
    expect(Buffer.from(jcs, "utf8").toString("hex")).toBe(profile.configJcsUtf8Hex);
    expect(createHash("sha256").update(jcs, "utf8").digest("hex")).toBe(profile.configSha256);
    expect(CONTRACT.runtimeContractId).toBe(MIMO_V2_SEED_IDENTITY_V1.runtime.runtimeContractId);
    expect(DEEPSEEK_MIMO_RUNTIME_CONTRACT_DB_FIXTURE_V1.targets).toHaveLength(2);
    expect(DEEPSEEK_MIMO_RUNTIME_CONTRACT_DB_FIXTURE_V1.targets.map((target) => target.profileKey).sort())
      .toEqual(["deepseek.official.deepseek-v4-flash.chat.v1", profile.profileKey]);
  });
});

describe.skipIf(!RUN_DB_TESTS)("CFG-002 MiMo V2 seed (real DB)", () => {
  it("has complete dark readback, an unsealed price, and the exact post-seed totals", () => {
    const actual = ownerJson(String.raw`
      select pg_catalog.jsonb_build_object(
        'profile', (select pg_catalog.to_jsonb(row_value) from public.ai_provider_profiles row_value where id='${PROFILE_ID}'::uuid),
        'version', (select pg_catalog.to_jsonb(row_value) from public.ai_provider_profile_versions row_value where id='${PROFILE_VERSION_ID}'::uuid),
        'price', (select pg_catalog.to_jsonb(row_value) from public.ai_price_versions row_value where id='${PRICE_ID}'::uuid),
        'components', (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_value) order by component collate "C") from public.ai_price_components row_value where price_version_id='${PRICE_ID}'::uuid),
        'root', (select pg_catalog.to_jsonb(row_value) from public.ai_service_runtime_contract_versions row_value where runtime_contract_id='${CONTRACT.runtimeContractId}'),
        'counts', pg_catalog.jsonb_build_object(
          'profiles',(select count(*) from public.ai_provider_profiles),
          'profileVersions',(select count(*) from public.ai_provider_profile_versions),
          'prices',(select count(*) from public.ai_price_versions),
          'components',(select count(*) from public.ai_price_components),
          'policies',(select count(*) from public.ai_routing_policy_versions),
          'runtimeRoots',(select count(*) from public.ai_service_runtime_contract_versions),
          'runtimeTargets',(select count(*) from public.ai_service_runtime_target_versions),
          'runtimeMemberships',(select count(*) from public.ai_service_runtime_contract_targets),
          'audit',(select count(*) from public.ai_routing_lifecycle_audit),
          'sealIntents',(select count(*) from public.ai_price_component_seal_intents)
        ),
        'feature', (select pg_catalog.jsonb_build_object('enabled',ai_polish_enabled,'pointer',active_routing_policy_version_id,'generation',config_generation) from public.ai_feature_config where id=true)
      )::text;
    `) as {
      profile: Record<string, unknown>;
      version: Record<string, unknown>;
      price: Record<string, unknown>;
      components: Array<{ component: string; nanos_per_million: number | string }>;
      root: Record<string, unknown>;
      counts: Record<string, number>;
      feature: Record<string, unknown>;
    };
    expect(actual.profile).toMatchObject({ id: PROFILE_ID, profile_key: MIMO_V2_SEED_IDENTITY_V1.profile.profileKey, gateway_kind: "direct_mimo", model_vendor: "xiaomi-mimo" });
    expect(actual.version).toMatchObject({ id: PROFILE_VERSION_ID, status: "draft", validated_at: null, activated_at: null, retired_at: null, config_sha256: MIMO_V2_SEED_IDENTITY_V1.profile.configSha256 });
    expect(actual.price).toMatchObject({ id: PRICE_ID, pricing_lane: "default", currency: "CNY", calculator_kind: "linear_token_v1", components_sealed_at: null, provider_effective_from: null, provider_effective_to: null });
    expect(actual.components.map((row) => [row.component, Number(row.nanos_per_million)])).toEqual([
      ["input_cache_read", 25000000], ["input_cache_write", 0], ["input_standard", 3000000000], ["output", 6000000000],
    ]);
    expect(actual.root).toMatchObject({ runtime_contract_id: CONTRACT.runtimeContractId, runtime_contract_sha256: CONTRACT.runtimeContractSha256, runtime_target_set_sha256: CONTRACT.runtimeTargetSetSha256 });
    expect(actual.root.sealed_at).not.toBeNull();
    expect(actual.counts).toEqual({ profiles: 2, profileVersions: 2, prices: 4, components: 13, policies: 1, runtimeRoots: 2, runtimeTargets: 2, runtimeMemberships: 3, audit: 0, sealIntents: 1 });
    expect(actual.feature).toEqual({ enabled: false, pointer: null, generation: 0 });
  });

  it("is serially idempotent without sealing the price or adding audit history", () => {
    const before = snapshot();
    runOwnerSql(readFileSync(MIGRATION_URL, "utf8"));
    expect(snapshot()).toBe(before);
  });

  it("fails closed and rolls back hostile immutable identities", () => {
    const cases = [
      ["ai_provider_profiles", `update public.ai_provider_profiles set display_name='wrong' where id='${PROFILE_ID}'::uuid;`, "MiMo V2 profile identity mismatch"],
      ["ai_provider_profile_versions", `update public.ai_provider_profile_versions set model_id='wrong' where id='${PROFILE_VERSION_ID}'::uuid;`, "MiMo V2 profile version mismatch"],
      ["ai_price_versions", `update public.ai_price_versions set source_url='https://wrong.example' where id='${PRICE_ID}'::uuid;`, "MiMo V2 price version mismatch"],
      ["ai_service_runtime_contract_versions", `update public.ai_service_runtime_contract_versions set runtime_target_set_sha256=repeat('0',64) where runtime_contract_id='${CONTRACT.runtimeContractId}';`, "MiMo V2 runtime root mismatch"],
    ] as const;
    for (const [table, mutate, message] of cases) {
      const result = runOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        \set VERBOSITY verbose
        begin;
        alter table public.${table} disable trigger user;
        ${mutate}
        savepoint cfg002_hostile;
        \set ON_ERROR_STOP off
        ${migrationBody()}
        \set ON_ERROR_STOP on
        rollback to savepoint cfg002_hostile;
        alter table public.${table} enable trigger user;
        rollback;
      `, { expectFailure: false });
      expect(result.stderr).toContain(message);
      expect(result.stderr).toMatch(/ERROR:\s+23514:/u);
    }
  });
});

describe.skipIf(!RUN_DB_TESTS || !RUN_CFG002_FRESH_RESET)("CFG-002 strict fresh-reset gate", () => {
  it("runs only after the fresh-reset selector is active", () => {
    // The preceding exact-total test is intentionally shared with local focused
    // runs; this assertion makes the selector requirement visible in output.
    expect(RUN_CFG002_FRESH_RESET).toBe(true);
  });
});
