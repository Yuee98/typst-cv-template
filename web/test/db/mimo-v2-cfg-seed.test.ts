import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MIMO_V2_SEED_IDENTITY_V1 } from "@/server/polish/mimo-v2-seed-identity-v1";
import { DEEPSEEK_MIMO_RUNTIME_CONTRACT_DB_FIXTURE_V1 } from "@/server/polish/service-runtime-contract-v1";

import { RUN_DB_TESTS, sleep } from "./helpers";
import {
  runOwnerSql,
  startOwnerSql,
  type OwnerSqlResult,
} from "./runtime-contract-fixtures";

const RUN_CFG002_FRESH_RESET = process.env.CFG002_FRESH_RESET === "1";
const MIGRATION_URL = new URL(
  "../../../supabase/migrations/20260824006000_seed_mimo_v2_draft.sql",
  import.meta.url,
);
const PROFILE_ID = MIMO_V2_SEED_IDENTITY_V1.profile.id;
const PROFILE_VERSION_ID = MIMO_V2_SEED_IDENTITY_V1.profile.profileVersionId;
const PRICE_ID = MIMO_V2_SEED_IDENTITY_V1.pricing.reservedDefaultPriceVersionId;
const CONTRACT = DEEPSEEK_MIMO_RUNTIME_CONTRACT_DB_FIXTURE_V1.contract;
const TARGETS = DEEPSEEK_MIMO_RUNTIME_CONTRACT_DB_FIXTURE_V1.targets;
const DB_CONTAINER = "supabase_db_typst-cv-template";
const OLD_CONTRACT_ID = "runtime.deepseek-v2.v1";
const OLD_CONTRACT_SHA256 =
  "229ee6ca2b1ff78c81fc5748f01a285ac5936c1f8f06961c6c339ca808752ca9";
const SNAPSHOT_TABLES = [
  "ai_provider_profiles",
  "ai_provider_profile_versions",
  "ai_price_versions",
  "ai_price_components",
  "ai_service_runtime_contract_versions",
  "ai_service_runtime_target_versions",
  "ai_service_runtime_contract_targets",
  "ai_legal_bundle_versions",
  "ai_legal_bundle_manifests",
  "ai_legal_manifest_versions",
  "ai_feature_config",
  "ai_routing_policy_versions",
  "ai_routing_lifecycle_audit",
  "ai_price_component_seal_intents",
  "ai_routing_policy_transition_intents",
  "user_terms_acceptances",
  "ai_request_ledger",
  "ai_provider_attempt_ledger",
  "ai_usage_daily",
  "ai_global_usage_daily",
  "ai_profile_usage_daily",
  "ai_rate_minutes",
] as const;

interface BarrierSqlProcess {
  ready: Promise<void>;
  result: Promise<OwnerSqlResult>;
  release: () => void;
}

interface CatalogSnapshot {
  availability: unknown;
  tables: Record<string, Array<Record<string, unknown>>>;
}

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

function stableSnapshotSql(marker = ""): string {
  const tables = SNAPSHOT_TABLES.map(
    (table) => String.raw`
      '${table}', (
        select coalesce(
          pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(row_value)
            order by pg_catalog.to_jsonb(row_value)::text collate "C"
          ),
          '[]'::jsonb
        )
        from public.${table} as row_value
      )`,
  ).join(",\n");
  return String.raw`
    select '${marker}' || pg_catalog.jsonb_build_object(
      'availability', public.get_ai_polish_availability_v1(null),
      'tables', pg_catalog.jsonb_build_object(${tables})
    )::text;
  `;
}

function parseMarkedSnapshot(stdout: string, marker: string): string {
  const line = stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find((value) => value.startsWith(marker));
  if (!line) throw new Error(`CFG-002 snapshot marker ${marker} is missing`);
  return line.slice(marker.length);
}

function snapshot(): string {
  const result = runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    \pset format unaligned
    \pset tuples_only on
    ${stableSnapshotSql("CFG002_SNAPSHOT=")}
  `);
  return parseMarkedSnapshot(result.stdout, "CFG002_SNAPSHOT=");
}

function parsedSnapshot(): CatalogSnapshot {
  return JSON.parse(snapshot()) as CatalogSnapshot;
}

function targetSetHash(
  targets: ReadonlyArray<(typeof TARGETS)[number]>,
): string {
  return createHash("sha256")
    .update(
      [...targets]
        .sort((left, right) =>
          Buffer.from(left.runtimeTargetId, "utf8").compare(
            Buffer.from(right.runtimeTargetId, "utf8"),
          ),
        )
        .map(
          (target) =>
            `${Buffer.byteLength(target.runtimeTargetId, "utf8")}:${target.runtimeTargetId}:${target.runtimeTargetSha256}`,
        )
        .join("\n"),
      "utf8",
    )
    .digest("hex");
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
        "exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres",
        "--set", "ON_ERROR_STOP=1", "--no-psqlrc",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const onOutput = (chunk: string, isError: boolean) => {
      if (isError) stderr += chunk;
      else stdout += chunk;
      if (!readySettled && `${stdout}\n${stderr}`.includes(marker)) {
        readySettled = true;
        resolveReady();
      }
    };
    child.stdout.on("data", (chunk: string) => onOutput(chunk, false));
    child.stderr.on("data", (chunk: string) => onOutput(chunk, true));
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
        rejectReady(new Error(`owner SQL exited before ${marker}: ${stderr || stdout}`));
      }
      resolve({ status: status ?? -1, stdout, stderr });
    });
    release = () => {
      if (released) return;
      released = true;
      child.stdin.end(releaseSql);
    };
    if (releaseSql === undefined) child.stdin.end(sql);
    else child.stdin.write(sql);
  });
  return { ready, result, release: () => release() };
}

async function waitForActivity(applicationName: string, prefix: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const state = runOwnerSql(String.raw`
      \pset format unaligned
      \pset tuples_only on
      select coalesce(wait_event_type, '') || ':' || coalesce(wait_event, '')
      from pg_catalog.pg_stat_activity
      where application_name = '${applicationName}';
    `).stdout;
    if (state.split(/\r?\n/u).some((line) => line.trim().startsWith(prefix))) return;
    await sleep(25);
  }
  throw new Error(`${applicationName} never reached ${prefix}`);
}

async function waitForDatabaseLock(
  applicationName: string,
  contender?: Promise<OwnerSqlResult>,
): Promise<void> {
  let completed: OwnerSqlResult | undefined;
  void contender?.then((result) => {
    completed = result;
  });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const state = runOwnerSql(String.raw`
      \pset format unaligned
      \pset tuples_only on
      select coalesce(wait_event_type, '') || ':' || coalesce(wait_event, '')
      from pg_catalog.pg_stat_activity
      where application_name = '${applicationName}';
    `).stdout;
    if (state.split(/\r?\n/u).some((line) => line.trim().startsWith("Lock:"))) return;
    if (completed) {
      throw new Error(
        `contender ${applicationName} exited before a DB lock: ${completed.stderr || completed.stdout}`,
      );
    }
    await sleep(25);
  }
  throw new Error(`contender ${applicationName} never reported a DB lock`);
}

function assertNoDeadlockOrLockTimeout(result: OwnerSqlResult): void {
  expect(result.stderr).not.toMatch(/(?:40P01|55P03|deadlock detected|lock timeout)/iu);
}

function seedGraphCounts(): Record<string, number> {
  return ownerJson(String.raw`
    select pg_catalog.jsonb_build_object(
      'profile', (select count(*) from public.ai_provider_profiles where id='${PROFILE_ID}'::uuid),
      'version', (select count(*) from public.ai_provider_profile_versions where id='${PROFILE_VERSION_ID}'::uuid),
      'price', (select count(*) from public.ai_price_versions where id='${PRICE_ID}'::uuid),
      'components', (select count(*) from public.ai_price_components where price_version_id='${PRICE_ID}'::uuid),
      'root', (select count(*) from public.ai_service_runtime_contract_versions where runtime_contract_id='${CONTRACT.runtimeContractId}'),
      'mimoTarget', (select count(*) from public.ai_service_runtime_target_versions where runtime_target_id='${TARGETS[1].runtimeTargetId}'),
      'memberships', (select count(*) from public.ai_service_runtime_contract_targets where runtime_contract_id='${CONTRACT.runtimeContractId}')
    )::text;
  `) as Record<string, number>;
}

function makeSeedAbsent(): void {
  const result = runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    begin;
    set local session_replication_role = replica;
    delete from public.ai_service_runtime_contract_targets
    where runtime_contract_id='${CONTRACT.runtimeContractId}';
    delete from public.ai_service_runtime_contract_versions
    where runtime_contract_id='${CONTRACT.runtimeContractId}';
    delete from public.ai_service_runtime_target_versions
    where runtime_target_id='${TARGETS[1].runtimeTargetId}';
    delete from public.ai_price_components where price_version_id='${PRICE_ID}'::uuid;
    delete from public.ai_price_versions where id='${PRICE_ID}'::uuid;
    delete from public.ai_provider_profile_versions where id='${PROFILE_VERSION_ID}'::uuid;
    delete from public.ai_provider_profiles where id='${PROFILE_ID}'::uuid;
    set local session_replication_role = origin;
    commit;
  `);
  expect(result.status, result.stderr).toBe(0);
  expect(seedGraphCounts()).toEqual({
    profile: 0, version: 0, price: 0, components: 0, root: 0, mimoTarget: 0, memberships: 0,
  });
}

function restoreSeed(): void {
  const result = runOwnerSql(readFileSync(MIGRATION_URL, "utf8"));
  expect(result.status, result.stderr).toBe(0);
}

function removeProfileGate(): void {
  runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    drop trigger if exists cfg002_profile_gate on public.ai_provider_profiles;
    drop function if exists public.cfg002_profile_gate();
  `);
}

function installProfileGate(): void {
  removeProfileGate();
  const result = runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    create function public.cfg002_profile_gate() returns trigger
    language plpgsql set search_path = '' as $$
    begin
      if new.id='${PROFILE_ID}'::uuid then
        perform pg_catalog.pg_advisory_xact_lock(702002);
      end if;
      return new;
    end;
    $$;
    create trigger cfg002_profile_gate before insert on public.ai_provider_profiles
    for each row execute function public.cfg002_profile_gate();
  `);
  expect(result.status, result.stderr).toBe(0);
}

function removeReapplyPause(): void {
  runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    drop trigger if exists cfg002_reapply_pause on public.ai_provider_profiles;
    drop function if exists public.cfg002_reapply_pause();
  `);
}

function installReapplyPause(): void {
  removeReapplyPause();
  const result = runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    create function public.cfg002_reapply_pause() returns trigger
    language plpgsql set search_path = '' as $$
    begin
      if new.id='${PROFILE_ID}'::uuid then perform pg_catalog.pg_sleep(0.75); end if;
      return new;
    end;
    $$;
    create trigger cfg002_reapply_pause after insert on public.ai_provider_profiles
    for each row execute function public.cfg002_reapply_pause();
  `);
  expect(result.status, result.stderr).toBe(0);
}

function membershipValues(
  rootId: string,
  rootHash: string,
  target: (typeof TARGETS)[number],
): string {
  return String.raw`(
    '${rootId}', '${rootHash}',
    '${target.runtimeTargetId}', '${target.runtimeTargetSha256}',
    '${target.profileKey}', '${target.legalManifestId}', '${target.manifestSha256}',
    '${target.routeDescriptorId}', '${target.routeDescriptorSha256}'
  )`;
}

function createUnsealedRaceRoot(
  label: string,
  initialTargets: ReadonlyArray<(typeof TARGETS)[number]>,
): { id: string; hash: string } {
  const id = `cfg002.race.${label}.${randomUUID()}`;
  const hash = createHash("sha256").update(id, "utf8").digest("hex");
  const initialMemberships = initialTargets.length === 0
    ? ""
    : String.raw`
      insert into public.ai_service_runtime_contract_targets (
        runtime_contract_id, runtime_contract_sha256,
        runtime_target_id, runtime_target_sha256, profile_key,
        legal_manifest_id, manifest_sha256, route_descriptor_id, route_descriptor_sha256
      ) values ${initialTargets.map((target) => membershipValues(id, hash, target)).join(",")};`;
  const result = runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    begin;
    insert into public.ai_service_runtime_contract_versions (
      runtime_contract_id, runtime_contract_sha256, reviewed_source_commit_oid,
      legal_bundle_version, bundle_contract_sha256, runtime_target_set_sha256
    ) values (
      '${id}', '${hash}', '${CONTRACT.reviewedSourceCommitOid}',
      '${CONTRACT.legalBundleVersion}', '${CONTRACT.bundleContractSha256}',
      '${CONTRACT.runtimeTargetSetSha256}'
    );
    ${initialMemberships}
    commit;
  `);
  expect(result.status, result.stderr).toBe(0);
  return { id, hash };
}

function removeRaceRoot(rootId: string): void {
  const result = runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    begin;
    set local session_replication_role = replica;
    delete from public.ai_service_runtime_contract_targets where runtime_contract_id='${rootId}';
    delete from public.ai_service_runtime_contract_versions where runtime_contract_id='${rootId}';
    set local session_replication_role = origin;
    commit;
  `);
  expect(result.status, result.stderr).toBe(0);
}

function expectExactSealedRaceRoot(rootId: string, rootHash: string): void {
  const actual = ownerJson(String.raw`
    select pg_catalog.jsonb_build_object(
      'root', (
        select pg_catalog.to_jsonb(row_value)
        from public.ai_service_runtime_contract_versions as row_value
        where runtime_contract_id='${rootId}' and runtime_contract_sha256='${rootHash}'
      ),
      'memberships', (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_value)
          order by runtime_target_id collate "C"), '[]'::jsonb)
        from public.ai_service_runtime_contract_targets as row_value
        where runtime_contract_id='${rootId}'
      )
    )::text;
  `) as {
    root: Record<string, unknown>;
    memberships: Array<Record<string, unknown>>;
  };
  expect(actual.root).toMatchObject({
    runtime_contract_id: rootId,
    runtime_contract_sha256: rootHash,
    runtime_target_set_sha256: CONTRACT.runtimeTargetSetSha256,
  });
  expect(actual.root.sealed_at).not.toBeNull();
  expect(actual.memberships.map((row) => [row.runtime_target_id, row.profile_key]))
    .toEqual(TARGETS.map((target) => [target.runtimeTargetId, target.profileKey]));
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
    expect(TARGETS).toHaveLength(2);
    expect(targetSetHash(TARGETS)).toBe(CONTRACT.runtimeTargetSetSha256);
    expect(TARGETS.map((target) => target.profileKey).sort())
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

    const catalog = parsedSnapshot();
    expect(catalog.availability).toEqual({
      enabled: false,
      termsAccepted: false,
      profileVersionId: null,
      routingPolicyVersionId: null,
      runtimeContractId: null,
      runtimeContractSha256: null,
      legalBundleVersion: null,
      displayDisclosureKey: null,
      configGeneration: null,
    });
    const targets = catalog.tables.ai_service_runtime_target_versions;
    expect(targets.filter((row) => TARGETS.some((target) => target.runtimeTargetId === row.runtime_target_id)))
      .toEqual(expect.arrayContaining(TARGETS.map((target) => expect.objectContaining({
        runtime_target_id: target.runtimeTargetId,
        runtime_target_sha256: target.runtimeTargetSha256,
        profile_key: target.profileKey,
        legal_manifest_id: target.legalManifestId,
        manifest_sha256: target.manifestSha256,
        route_descriptor_id: target.routeDescriptorId,
        route_descriptor_sha256: target.routeDescriptorSha256,
      }))));
    expect(catalog.tables.ai_service_runtime_contract_targets
      .filter((row) => row.runtime_contract_id === CONTRACT.runtimeContractId)
      .map((row) => [row.runtime_target_id, row.profile_key]))
      .toEqual(TARGETS.map((target) => [target.runtimeTargetId, target.profileKey]));
    expect(catalog.tables.ai_service_runtime_contract_versions)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        runtime_contract_id: OLD_CONTRACT_ID,
        runtime_contract_sha256: OLD_CONTRACT_SHA256,
        sealed_at: expect.any(String),
      })]));
    for (const table of [
      "ai_routing_lifecycle_audit", "ai_routing_policy_transition_intents",
      "ai_request_ledger", "ai_provider_attempt_ledger", "ai_usage_daily",
      "ai_global_usage_daily", "ai_profile_usage_daily", "ai_rate_minutes",
      "user_terms_acceptances",
    ]) expect(catalog.tables[table]).toEqual([]);
  });

  it("is serially idempotent without sealing the price or adding audit history", () => {
    const before = snapshot();
    runOwnerSql(readFileSync(MIGRATION_URL, "utf8"));
    expect(snapshot()).toBe(before);
  });

  it("observes a real unique-key lock for identical concurrent reapplication, then retries unchanged", async () => {
    makeSeedAbsent();
    installReapplyPause();
    try {
      const firstApplication = `cfg002-identical-first-${randomUUID()}`;
      const secondApplication = `cfg002-identical-second-${randomUUID()}`;
      const first = startOwnerSql(String.raw`
        \set VERBOSITY verbose
        set application_name='${firstApplication}';
        ${readFileSync(MIGRATION_URL, "utf8")}
      `);
      await waitForActivity(firstApplication, "Timeout:PgSleep");
      const second = startOwnerSql(String.raw`
        \set VERBOSITY verbose
        set application_name='${secondApplication}';
        ${readFileSync(MIGRATION_URL, "utf8")}
      `);
      await waitForDatabaseLock(secondApplication, second);
      const results = await Promise.all([first, second]);
      for (const result of results) assertNoDeadlockOrLockTimeout(result);
      const successes = results.filter((result) => result.status === 0);
      const losers = results.filter((result) => result.status !== 0);
      expect(successes.length).toBeGreaterThanOrEqual(1);
      expect(successes.length + losers.length).toBe(2);
      for (const loser of losers) expect(loser.stderr).toMatch(/ERROR:\s+23505:/u);
      expect(seedGraphCounts()).toEqual({
        profile: 1, version: 1, price: 1, components: 4, root: 1, mimoTarget: 1, memberships: 2,
      });
      const afterRace = snapshot();
      restoreSeed();
      expect(snapshot()).toBe(afterRace);
    } finally {
      removeReapplyPause();
      if (seedGraphCounts().profile !== 1) restoreSeed();
    }
  });

  it("rolls back a late fixed-ID and natural-key profile collision after the migration observed absence", async () => {
    const collisions = [
      {
        name: "fixed id",
        id: PROFILE_ID,
        profileKey: `cfg002.collision.fixed.${randomUUID()}`,
      },
      {
        name: "natural key",
        id: randomUUID(),
        profileKey: MIMO_V2_SEED_IDENTITY_V1.profile.profileKey,
      },
    ] as const;
    installProfileGate();
    try {
      for (const collision of collisions) {
        makeSeedAbsent();
        const marker = `CFG002_LATE_COLLISION_${randomUUID()}`;
        const holder = startOwnerSqlWithBarrier(
          String.raw`
            \set ON_ERROR_STOP on
            begin;
            select pg_catalog.pg_advisory_lock(702002);
            \echo ${marker}
          `,
          marker,
          String.raw`
            insert into public.ai_provider_profiles (
              id, profile_key, display_name, gateway_kind, model_vendor
            ) values (
              '${collision.id}'::uuid, '${collision.profileKey}',
              'late ${collision.name}', 'direct_mimo', 'xiaomi-mimo'
            );
            commit;
          `,
        );
        const contenderApplication = `cfg002-late-${randomUUID()}`;
        try {
          await holder.ready;
          const contender = startOwnerSql(String.raw`
            \set VERBOSITY verbose
            set application_name='${contenderApplication}';
            ${readFileSync(MIGRATION_URL, "utf8")}
          `);
          await waitForDatabaseLock(contenderApplication, contender);
          holder.release();
          const [winner, loser] = await Promise.all([holder.result, contender]);
          expect(winner.status, winner.stderr).toBe(0);
          expect(loser.status).not.toBe(0);
          assertNoDeadlockOrLockTimeout(loser);
          expect(loser.stderr).toMatch(/ERROR:\s+23505:/u);
          // The collision writer is the sole surviving profile.  Every row the
          // migration would have authored after its observed absence is absent.
          expect(seedGraphCounts()).toEqual({
            profile: collision.id === PROFILE_ID ? 1 : 0,
            version: 0, price: 0, components: 0, root: 0, mimoTarget: 0, memberships: 0,
          });
          const profileDomain = ownerJson(String.raw`
            select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_value)
              order by id::text collate "C"), '[]'::jsonb)::text
            from public.ai_provider_profiles as row_value
            where id='${collision.id}'::uuid
               or profile_key='${collision.profileKey}';
          `) as Array<Record<string, unknown>>;
          expect(profileDomain).toHaveLength(1);
          expect(profileDomain[0]).toMatchObject({
            id: collision.id,
            profile_key: collision.profileKey,
            display_name: `late ${collision.name}`,
            gateway_kind: "direct_mimo",
            model_vendor: "xiaomi-mimo",
          });
        } finally {
          holder.release();
          await holder.result.catch(() => undefined);
          const cleanup = runOwnerSql(String.raw`
            \set ON_ERROR_STOP on
            begin;
            set local session_replication_role = replica;
            delete from public.ai_provider_profiles where id='${collision.id}'::uuid;
            set local session_replication_role = origin;
            commit;
          `);
          expect(cleanup.status, cleanup.stderr).toBe(0);
          restoreSeed();
        }
      }
    } finally {
      removeProfileGate();
    }
  });

  it("serializes membership authoring before root sealing on the real root lock", async () => {
    const before = snapshot();
    const root = createUnsealedRaceRoot("membership-first", [TARGETS[0]]);
    const holderApplication = `cfg002-membership-holder-${randomUUID()}`;
    const contenderApplication = `cfg002-seal-after-membership-${randomUUID()}`;
    // This mirrors the established DB007 mutation-first schedule: the real
    // membership trigger takes root FOR UPDATE, then pg_sleep only keeps that
    // already-acquired transaction lock observable while the seal is sent.
    const holder = startOwnerSql(
      String.raw`
        \set ON_ERROR_STOP on
        set application_name='${holderApplication}';
        begin;
        set local statement_timeout='10s';
        insert into public.ai_service_runtime_contract_targets (
          runtime_contract_id, runtime_contract_sha256,
          runtime_target_id, runtime_target_sha256, profile_key,
          legal_manifest_id, manifest_sha256, route_descriptor_id, route_descriptor_sha256
        ) values ${membershipValues(root.id, root.hash, TARGETS[1])};
        select pg_catalog.pg_sleep(0.75);
        commit;
      `,
    );
    try {
      await waitForActivity(holderApplication, "Timeout:PgSleep");
      const contender = startOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        \set VERBOSITY verbose
        begin;
        set local application_name='${contenderApplication}';
        set local statement_timeout='10s';
        update public.ai_service_runtime_contract_versions
        set sealed_at=greatest(pg_catalog.clock_timestamp(), created_at)
        where runtime_contract_id='${root.id}' and runtime_contract_sha256='${root.hash}';
        commit;
      `);
      await waitForDatabaseLock(contenderApplication, contender);
      const [authored, sealed] = await Promise.all([holder, contender]);
      expect(authored.status, authored.stderr).toBe(0);
      expect(sealed.status, sealed.stderr).toBe(0);
      assertNoDeadlockOrLockTimeout(sealed);
      expectExactSealedRaceRoot(root.id, root.hash);
    } finally {
      await holder.catch(() => undefined);
      removeRaceRoot(root.id);
      expect(snapshot()).toBe(before);
    }
  });

  it("rejects a membership mutation after seal-first serialization and preserves exact members", async () => {
    const before = snapshot();
    const root = createUnsealedRaceRoot("seal-first", TARGETS);
    const marker = `CFG002_SEAL_HELD_${randomUUID()}`;
    const contenderMarker = `CFG002_MUTATION_CONTENDER_READY_${randomUUID()}`;
    const contenderApplication = `cfg002-mutation-after-seal-${randomUUID()}`;
    const holder = startOwnerSqlWithBarrier(
      String.raw`
        \set ON_ERROR_STOP on
        begin;
        set local statement_timeout='10s';
        update public.ai_service_runtime_contract_versions
        set sealed_at=greatest(pg_catalog.clock_timestamp(), created_at)
        where runtime_contract_id='${root.id}' and runtime_contract_sha256='${root.hash}';
        \echo ${marker}
      `,
      marker,
      "commit;",
    );
    try {
      await holder.ready;
      const contender = startOwnerSqlWithBarrier(String.raw`
        \set ON_ERROR_STOP on
        \set VERBOSITY verbose
        begin;
        set local application_name='${contenderApplication}';
        set local statement_timeout='10s';
        \echo ${contenderMarker}
        delete from public.ai_service_runtime_contract_targets
        where runtime_contract_id='${root.id}'
          and runtime_target_id='${TARGETS[1].runtimeTargetId}';
        commit;
      `, contenderMarker);
      await contender.ready;
      await waitForDatabaseLock(contenderApplication, contender.result);
      holder.release();
      const [sealed, rejected] = await Promise.all([holder.result, contender.result]);
      expect(sealed.status, sealed.stderr).toBe(0);
      expect(rejected.status).not.toBe(0);
      assertNoDeadlockOrLockTimeout(rejected);
      expect(rejected.stderr).toMatch(/ERROR:\s+23514:.*sealed runtime contract target sets are immutable/i);
      expectExactSealedRaceRoot(root.id, root.hash);
    } finally {
      holder.release();
      await holder.result.catch(() => undefined);
      removeRaceRoot(root.id);
      expect(snapshot()).toBe(before);
    }
  });

  it("rolls back every authored row when a trigger-disabled immutable old-root corruption fails late", () => {
    const original = snapshot();
    const result = runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      \set VERBOSITY verbose
      \pset format unaligned
      \pset tuples_only on
      begin;
      set local session_replication_role = replica;
      delete from public.ai_service_runtime_contract_targets
      where runtime_contract_id='${CONTRACT.runtimeContractId}';
      delete from public.ai_service_runtime_contract_versions
      where runtime_contract_id='${CONTRACT.runtimeContractId}';
      delete from public.ai_service_runtime_target_versions
      where runtime_target_id='${TARGETS[1].runtimeTargetId}';
      delete from public.ai_price_components where price_version_id='${PRICE_ID}'::uuid;
      delete from public.ai_price_versions where id='${PRICE_ID}'::uuid;
      delete from public.ai_provider_profile_versions where id='${PROFILE_VERSION_ID}'::uuid;
      delete from public.ai_provider_profiles where id='${PROFILE_ID}'::uuid;
      update public.ai_service_runtime_contract_versions
      set runtime_target_set_sha256=repeat('0',64)
      where runtime_contract_id='${OLD_CONTRACT_ID}'
        and runtime_contract_sha256='${OLD_CONTRACT_SHA256}';
      set local session_replication_role = origin;
      ${stableSnapshotSql("CFG002_ROLLBACK_BEFORE=")}
      savepoint cfg002_seed_body;
      \set ON_ERROR_STOP off
      ${migrationBody()}
      \set ON_ERROR_STOP on
      rollback to savepoint cfg002_seed_body;
      ${stableSnapshotSql("CFG002_ROLLBACK_AFTER=")}
      rollback;
    `, { expectFailure: false });
    expect(result.stderr).toContain("MiMo V2 final runtime assertion failed");
    expect(result.stderr).toMatch(/ERROR:\s+23514:/u);
    expect(parseMarkedSnapshot(result.stdout, "CFG002_ROLLBACK_AFTER="))
      .toBe(parseMarkedSnapshot(result.stdout, "CFG002_ROLLBACK_BEFORE="));
    expect(snapshot()).toBe(original);
  });

  it("keeps every direct catalog mutation and the discovered private price seal dark to API roles", () => {
    const protectedTables = [
      "ai_provider_profiles",
      "ai_provider_profile_versions",
      "ai_price_versions",
      "ai_price_components",
      "ai_service_runtime_contract_versions",
      "ai_service_runtime_target_versions",
      "ai_service_runtime_contract_targets",
    ] as const;
    const roles = ["anon", "authenticated", "service_role"] as const;
    const directAttempts = roles.flatMap((role) => protectedTables.flatMap((table) => [
      String.raw`
        begin;
        set local role ${role};
        insert into public.${table} default values;
        rollback;`,
      String.raw`
        begin;
        set local role ${role};
        do $$
        declare v_column text;
        begin
          select attribute.attname into v_column
          from pg_catalog.pg_attribute as attribute
          where attribute.attrelid='public.${table}'::regclass
            and attribute.attnum > 0 and not attribute.attisdropped
          order by attribute.attnum limit 1;
          execute pg_catalog.format(
            'update public.%I set %I=%I where false', '${table}', v_column, v_column
          );
        end;
        $$;
        rollback;`,
      String.raw`
        begin;
        set local role ${role};
        delete from public.${table} where false;
        rollback;`,
    ])).join("\n");
    const denied = runOwnerSql(String.raw`
      \set ON_ERROR_STOP off
      \set VERBOSITY verbose
      ${directAttempts}
    `, { expectFailure: false });
    expect(denied.status, denied.stderr).toBe(0);
    expect(denied.stderr.match(/ERROR:\s+42501:/g)).toHaveLength(
      protectedTables.length * roles.length * 3,
    );

    const privateSeals = ownerJson(String.raw`
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'identity', procedure.oid::regprocedure::text,
        'arguments', pg_catalog.pg_get_function_identity_arguments(procedure.oid),
        'grants', pg_catalog.jsonb_build_object(
          'anon', has_function_privilege('anon', procedure.oid, 'EXECUTE'),
          'authenticated', has_function_privilege('authenticated', procedure.oid, 'EXECUTE'),
          'service_role', has_function_privilege('service_role', procedure.oid, 'EXECUTE')
        )
      ) order by procedure.oid::regprocedure::text), '[]'::jsonb)::text
      from pg_catalog.pg_proc as procedure
      join pg_catalog.pg_namespace as namespace on namespace.oid=procedure.pronamespace
      where namespace.nspname='public'
        and procedure.proname='seal_ai_price_components_v1';
    `) as Array<{ identity: string; arguments: string; grants: Record<string, boolean> }>;
    expect(privateSeals).toHaveLength(1);
    expect(privateSeals[0].identity).toContain("seal_ai_price_components_v1");
    expect(privateSeals[0].arguments).not.toBe("");
    expect(privateSeals[0].grants).toEqual({
      anon: false,
      authenticated: false,
      service_role: false,
    });
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
