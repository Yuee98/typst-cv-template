import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { G4_ROUTING_POLICY_SEED_V1 as SEED } from "../../src/server/polish/g4-routing-policy-seed-v1";
import { RUN_DB_TESTS, sleep } from "./helpers";
import { type OwnerSqlResult, runOwnerSql, startOwnerSql } from "./runtime-contract-fixtures";

const migrationUrl = new URL("../../../supabase/migrations/20260824007000_seed_g4_routing_policy.sql", import.meta.url);
const g2 = "33333333-3333-4333-8333-333333333332";
const g4 = SEED.policies.g4.id;
const rollback = SEED.policies.rollback.id;
const DB_CONTAINER = "supabase_db_typst-cv-template";
const CFG003_REAPPLY_ADVISORY_LOCK_KEY = 703003;
const tables = ["ai_provider_profiles", "ai_provider_profile_versions", "ai_price_versions", "ai_price_components", "ai_service_runtime_contract_versions", "ai_service_runtime_target_versions", "ai_service_runtime_contract_targets", "ai_legal_bundle_versions", "ai_legal_bundle_manifests", "ai_legal_manifest_versions", "ai_feature_config", "ai_routing_policy_versions", "ai_routing_lifecycle_audit", "ai_price_component_seal_intents", "ai_routing_policy_transition_intents", "user_terms_acceptances", "ai_request_ledger", "ai_provider_attempt_ledger", "ai_usage_daily", "ai_global_usage_daily", "ai_profile_usage_daily", "ai_rate_minutes"] as const;

interface BarrierSqlProcess {
  ready: Promise<void>;
  result: Promise<OwnerSqlResult>;
  release: () => void;
}

const source = () => readFileSync(migrationUrl, "utf8");
const testSource = () => readFileSync(new URL(import.meta.url), "utf8");
const body = () => source().replace(/^begin;\s*$/mu, "").replace(/^commit;\s*$/mu, "");
function json(sql: string): unknown {
  const out = runOwnerSql(String.raw`\pset tuples_only on
    \pset format unaligned
    ${sql}`).stdout;
  const line = out.split(/\r?\n/u).map((x) => x.trim()).findLast((x) => x.startsWith("{") || x.startsWith("["));
  if (!line) throw new Error(`missing JSON: ${out}`);
  return JSON.parse(line);
}
function snap(marker = "CFG003="): string {
  const fields = tables.map((t) => `'${t}',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text collate "C"),'[]'::jsonb) from public.${t} x)`).join(",");
  const out = runOwnerSql(String.raw`\pset tuples_only on
    \pset format unaligned
    select '${marker}'||jsonb_build_object(${fields})::text;`).stdout;
  const line = out.split(/\r?\n/u).map((x) => x.trim()).find((x) => x.startsWith(marker));
  if (!line) throw new Error(`missing snapshot: ${out}`);
  return line.slice(marker.length);
}
function policyGraph(): unknown {
  return json(String.raw`select jsonb_agg(jsonb_build_object(
    'id',id,'policy_key',policy_key,'version',version,'status',status,'timezone',timezone,
    'rules',rules,'default_profile_version_id',default_profile_version_id,
    'legal_bundle_version',legal_bundle_version,'runtime_contract_id',runtime_contract_id,
    'runtime_contract_sha256',runtime_contract_sha256,'config_sha256',config_sha256,
    'validated_at',validated_at,'activated_at',activated_at,'retired_at',retired_at
  ) order by id) from public.ai_routing_policy_versions;`);
}
function policyInsert(policy: (typeof SEED.policies)[keyof typeof SEED.policies]): string {
  return String.raw`insert into public.ai_routing_policy_versions (
    id, policy_key, version, status, timezone, rules, default_profile_version_id,
    legal_bundle_version, runtime_contract_id, runtime_contract_sha256, config_sha256
  ) values (
    '${policy.id}'::uuid, '${policy.policyKey}', 1, 'draft', 'Asia/Shanghai',
    '${JSON.stringify(policy.rules)}'::jsonb, '${policy.defaultProfileVersionId}'::uuid,
    '${SEED.legalBundleVersion}', '${policy.runtimeContractId}',
    '${policy.runtimeContractSha256}', '${policy.configSha256}'
  );`;
}
function restore(): void { expect(runOwnerSql(source()).status).toBe(0); }
function removePolicies(): void {
  expect(runOwnerSql(String.raw`begin; set local session_replication_role=replica;
    delete from public.ai_routing_policy_versions where id in ('${g4}'::uuid,'${rollback}'::uuid);
    set local session_replication_role=origin; commit;`).status).toBe(0);
}
function pgApplicationName(label: string): string {
  return `cfg003-${label}-${randomUUID().replaceAll("-", "")}`;
}
function startOwnerSqlWithBarrier(sql: string, marker: string, releaseSql: string): BarrierSqlProcess {
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let settled = false;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let released = false;
  let release = () => undefined;
  const result = new Promise<OwnerSqlResult>((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "--set", "ON_ERROR_STOP=1", "--no-psqlrc"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    const capture = (chunk: string, error: boolean) => {
      if (error) stderr += chunk; else stdout += chunk;
      if (!settled && `${stdout}\n${stderr}`.includes(marker)) { settled = true; resolveReady(); }
    };
    child.stdout.on("data", (chunk: string) => capture(chunk, false));
    child.stderr.on("data", (chunk: string) => capture(chunk, true));
    child.on("error", (error) => { if (!settled) { settled = true; rejectReady(error); } reject(error); });
    child.on("close", (status) => {
      if (!settled) { settled = true; rejectReady(new Error(`owner SQL exited before ${marker}: ${stderr || stdout}`)); }
      resolve({ status: status ?? -1, stdout, stderr });
    });
    release = () => { if (!released) { released = true; child.stdin.end(releaseSql); } };
    child.stdin.write(sql);
  });
  return { ready, result, release };
}
async function waitForDatabaseLock(applicationName: string, contender: Promise<OwnerSqlResult>, event: string): Promise<void> {
  let complete: OwnerSqlResult | undefined;
  void contender.then((result) => { complete = result; });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const state = runOwnerSql(String.raw`\pset format unaligned
      \pset tuples_only on
      select coalesce(wait_event_type, '') || ':' || coalesce(wait_event, '') from pg_catalog.pg_stat_activity where application_name='${applicationName}';`).stdout;
    if (state.split(/\r?\n/u).some((line) => line.trim().startsWith(`Lock:${event}`))) return;
    if (complete) throw new Error(`contender ${applicationName} exited before Lock:${event}: ${complete.stderr || complete.stdout}`);
    await sleep(25);
  }
  throw new Error(`contender ${applicationName} never reported Lock:${event}`);
}
function assertNoDeadlockOrLockTimeout(result: OwnerSqlResult): void {
  expect(result.stderr).not.toMatch(/(?:40P01|55P03|deadlock detected|lock timeout)/iu);
}
function removeReapplyBarrier(): void {
  expect(runOwnerSql(String.raw`\set ON_ERROR_STOP on
    drop trigger if exists cfg003_reapply_barrier on public.ai_routing_policy_versions;
    drop function if exists public.cfg003_reapply_barrier();`).status).toBe(0);
}
function installReapplyBarrier(): void {
  removeReapplyBarrier();
  expect(runOwnerSql(String.raw`\set ON_ERROR_STOP on
    create function public.cfg003_reapply_barrier() returns trigger language plpgsql set search_path = '' as $$
    begin
      if new.id in ('${g4}'::uuid, '${rollback}'::uuid) then perform pg_catalog.pg_advisory_xact_lock(${CFG003_REAPPLY_ADVISORY_LOCK_KEY}); end if;
      return new;
    end;
    $$;
    create trigger cfg003_reapply_barrier after insert on public.ai_routing_policy_versions for each row execute function public.cfg003_reapply_barrier();`).status).toBe(0);
}

describe("CFG-003 G4 routing-policy seed", () => {
  it("is owner-only dark DML with no lifecycle or feature side effect", () => {
    const sql = source();
    expect(sql.match(/^begin;$/gmu)).toHaveLength(1);
    expect(sql.match(/^commit;$/gmu)).toHaveLength(1);
    expect(sql).toContain("CFG-003 routing policy identity collision");
    expect(sql).toContain("CFG-003 routing policy group is partially present");
    expect(sql).toContain("components_sealed_at is null");
    expect(sql).toContain("ai_legal_bundle_manifests as actual");
    expect(sql).toContain("DeepSeek V4 Flash");
    expect(sql).toContain("input_cache_write'::text, 0::bigint");
    expect(testSource()).toContain("cleanupBarrier = true;");
    expect(testSource()).toContain("try { if (cleanupBarrier) removeReapplyBarrier(); } finally { restore(); }");
    expect(sql).not.toMatch(/\b(?:set_ai_routing_policy_pointer_v1|transition_ai_routing_policy|validate_ai_routing_policy|apply_ai_price_component_seal_intent)\b/u);
    expect(sql).not.toMatch(/\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?(?:ai_feature_config|ai_request_ledger|ai_provider_attempt_ledger|ai_usage_daily|ai_global_usage_daily|ai_profile_usage_daily|ai_rate_minutes|ai_routing_lifecycle_audit|ai_routing_policy_transition_intents)\b/iu);
  });

  describe.skipIf(!RUN_DB_TESTS)("real DB", () => {
    it("has exactly G2 plus both dark candidates, exact selectors, memberships, and darkness", () => {
      const value = json(String.raw`select jsonb_build_object(
        'policies',(select jsonb_agg(jsonb_build_object('id',id,'key',policy_key,'version',version,'rules',rules,'default',default_profile_version_id,'legal',legal_bundle_version,'runtime',runtime_contract_id,'hash',runtime_contract_sha256,'config',config_sha256,'status',status,'validated',validated_at,'active',activated_at,'retired',retired_at) order by id) from public.ai_routing_policy_versions),
        'combined',(select jsonb_agg(runtime_target_id order by runtime_target_id) from public.ai_service_runtime_contract_targets where runtime_contract_id='runtime.deepseek-v2-mimo-v2.5-pro.v2' and runtime_contract_sha256='510fb411fdbbf2de5822e8becd508d7bb5da458392162f55244a5d3ab016721c'),
        'legacy',(select jsonb_agg(runtime_target_id order by runtime_target_id) from public.ai_service_runtime_contract_targets where runtime_contract_id='runtime.deepseek-v2.v1' and runtime_contract_sha256='229ee6ca2b1ff78c81fc5748f01a285ac5936c1f8f06961c6c339ca808752ca9'),
        'dark',(select jsonb_build_object('mimoDraft',(select status='draft' and validated_at is null from public.ai_provider_profile_versions where id='22222222-2222-4222-8222-222222222221'::uuid),'mimoUnsealed',(select components_sealed_at is null from public.ai_price_versions where id='22222222-2222-4222-8222-222222222222'::uuid),'deepseekUnsealed',(select bool_and(components_sealed_at is null) from public.ai_price_versions where id in ('11111111-1111-4111-8111-111111111112'::uuid,'11111111-1111-4111-8111-111111111113'::uuid)))))::text;`) as Record<string, unknown>;
      const policies = value.policies as Array<Record<string, unknown>>;
      expect(policies.map((x) => x.id)).toEqual([g2, g4, rollback]);
      for (const policy of Object.values(SEED.policies)) expect(policies).toContainEqual(expect.objectContaining({ id: policy.id, key: policy.policyKey, version: 1, rules: policy.rules, default: policy.defaultProfileVersionId, legal: SEED.legalBundleVersion, runtime: policy.runtimeContractId, hash: policy.runtimeContractSha256, config: policy.configSha256, status: "draft", validated: null, active: null, retired: null }));
      expect(value.combined).toEqual(["runtime-target.deepseek.official.deepseek-v4-flash.chat.v1", "runtime-target.mimo.cn.mimo-v2.5-pro.responses.v1"]);
      expect(value.legacy).toEqual(["runtime-target.deepseek.official.deepseek-v4-flash.chat.v1"]);
      expect(value.dark).toEqual({ mimoDraft: true, mimoUnsealed: true, deepseekUnsealed: true });
    });

    it("serially replays byte-for-byte without pointer, audit, or ledger mutation", () => {
      const before = snap(); expect(runOwnerSql(source()).status).toBe(0); expect(snap()).toBe(before);
    });

    it.each([
      ["fixed ID", `update public.ai_routing_policy_versions set policy_key='cfg003.fixed' where id='${g4}'::uuid;`],
      ["natural key", `update public.ai_routing_policy_versions set id='33333333-3333-4333-8333-333333333399'::uuid where id='${g4}'::uuid;`],
    ])("rolls back a % collision as one transaction", (_kind, mutate) => {
      const canonical = snap();
      const result = runOwnerSql(String.raw`\set VERBOSITY verbose
        begin; set local session_replication_role=replica; ${mutate} set local session_replication_role=origin; select 'CORRUPTED='||jsonb_build_object(${tables.map((t) => `'${t}',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text collate "C"),'[]'::jsonb) from public.${t} x)`).join(",")})::text; savepoint p; \set ON_ERROR_STOP off
        ${body()}
        \set ON_ERROR_STOP on
        rollback to p; select 'AFTER='||jsonb_build_object(${tables.map((t) => `'${t}',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text collate "C"),'[]'::jsonb) from public.${t} x)`).join(",")})::text; rollback;`, { expectFailure: false });
      expect(result.stderr).toMatch(/ERROR:\s+23514:/u);
      const lines = result.stdout.split(/\r?\n/u).map((x) => x.trim());
      expect(lines.find((x) => x.startsWith("CORRUPTED="))?.slice(10)).toBe(lines.find((x) => x.startsWith("AFTER="))?.slice(6)); expect(snap()).toBe(canonical);
    });

    it.each([
      ["G4 only", SEED.policies.g4, rollback],
      ["rollback only", SEED.policies.rollback, g4],
    ])("rejects a complete but partial CFG003 group (%), without repairing its missing half", (_name, present, missing) => {
      const canonical = snap();
      const projection = tables.map((t) => `'${t}',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text collate "C"),'[]'::jsonb) from public.${t} x)`).join(",");
      const result = runOwnerSql(String.raw`\set VERBOSITY verbose
        begin;
        set local session_replication_role=replica;
        delete from public.ai_routing_policy_versions where id in ('${g4}'::uuid,'${rollback}'::uuid);
        ${policyInsert(present)}
        set local session_replication_role=origin;
        select 'PARTIAL_BEFORE='||jsonb_build_object(${projection})::text;
        savepoint cfg003_partial_group;
        \set ON_ERROR_STOP off
        ${body()}
        \set ON_ERROR_STOP on
        rollback to savepoint cfg003_partial_group;
        select 'PARTIAL_AFTER='||jsonb_build_object(${projection})::text;
        select 'PARTIAL_MISSING='||count(*) from public.ai_routing_policy_versions where id='${missing}'::uuid;
        rollback;`, { expectFailure: false });
      expect(result.stderr).toMatch(/ERROR:\s+23514:/u);
      const lines = result.stdout.split(/\r?\n/u).map((line) => line.trim());
      expect(lines.find((line) => line.startsWith("PARTIAL_BEFORE="))?.slice(15)).toBe(lines.find((line) => line.startsWith("PARTIAL_AFTER="))?.slice(14));
      expect(lines).toContain("PARTIAL_MISSING=0"); expect(snap()).toBe(canonical);
    });

    it("observes the unique-key serialization for concurrent reapplication and restores both policies", async () => {
      const beforePolicies = policyGraph();
      const marker = `CFG003_REAPPLY_HELD_${randomUUID()}`;
      let holder: BarrierSqlProcess | undefined;
      let cleanupBarrier = false;
      try {
        removePolicies();
        // Cleanup is required before installation: the function may be
        // created even if the subsequent trigger statement fails.
        cleanupBarrier = true;
        installReapplyBarrier();
        holder = startOwnerSqlWithBarrier(String.raw`\set ON_ERROR_STOP on
          begin;
          select pg_catalog.pg_advisory_xact_lock(${CFG003_REAPPLY_ADVISORY_LOCK_KEY});
          \echo ${marker}
        `, marker, "commit;");
        const firstApplication = pgApplicationName("identical-a");
        const secondApplication = pgApplicationName("identical-b");
        await holder.ready;
        const first = startOwnerSql(String.raw`\set VERBOSITY verbose
          set application_name='${firstApplication}';
          ${source()}`);
        await waitForDatabaseLock(firstApplication, first, "advisory");
        const second = startOwnerSql(String.raw`\set VERBOSITY verbose
          set application_name='${secondApplication}';
          ${source()}`);
        await waitForDatabaseLock(secondApplication, second, "transactionid");
        holder.release();
        const [holderResult, firstResult, secondResult] = await Promise.all([holder.result, first, second]);
        expect(holderResult.status, holderResult.stderr).toBe(0);
        expect(firstResult.status, firstResult.stderr).toBe(0);
        expect(secondResult.status).not.toBe(0);
        assertNoDeadlockOrLockTimeout(firstResult); assertNoDeadlockOrLockTimeout(secondResult);
        expect(secondResult.stderr).toMatch(/ERROR:\s+23505:/u);
        expect(policyGraph()).toEqual(beforePolicies);
        restore(); expect(policyGraph()).toEqual(beforePolicies);
      } finally {
        holder?.release();
        await holder?.result.catch(() => undefined);
        try { if (cleanupBarrier) removeReapplyBarrier(); } finally { restore(); }
      }
    });

    it.each([
      ["missing MiMo predecessor", `delete from public.ai_price_versions where id='22222222-2222-4222-8222-222222222222'::uuid;`],
      ["hostile combined selector", `delete from public.ai_service_runtime_contract_targets where runtime_contract_id='runtime.deepseek-v2-mimo-v2.5-pro.v2' and runtime_target_id='runtime-target.mimo.cn.mimo-v2.5-pro.responses.v1';`],
      ["mutated DeepSeek offpeak component", `update public.ai_price_components set nanos_per_million=1 where price_version_id='11111111-1111-4111-8111-111111111112'::uuid and component='input_standard';`],
      ["missing DeepSeek peak component", `delete from public.ai_price_components where price_version_id='11111111-1111-4111-8111-111111111113'::uuid and component='output';`],
      ["extra DeepSeek offpeak component", `insert into public.ai_price_components (price_version_id,component,nanos_per_million) values ('11111111-1111-4111-8111-111111111112'::uuid,'input_cache_write',0);`],
      ["mutated MiMo cache-write component", `update public.ai_price_components set nanos_per_million=1 where price_version_id='22222222-2222-4222-8222-222222222222'::uuid and component='input_cache_write';`],
      ["mutated DeepSeek profile parent", `update public.ai_provider_profiles set display_name='forged' where id='11111111-1111-4111-8111-111111111110'::uuid;`],
      ["missing legal membership", `delete from public.ai_legal_bundle_manifests where legal_bundle_version='2026-08-23-multi-provider-v1' and legal_manifest_id='mimo-cn-2026-08-23-v1';`],
    ])("fails closed for % from fresh-absent CFG003 state", (_name, mutate) => {
      const canonical = snap(); const projection = tables.map((t) => `'${t}',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text collate "C"),'[]'::jsonb) from public.${t} x)`).join(",");
      const result = runOwnerSql(String.raw`\set VERBOSITY verbose
        begin;
        set local session_replication_role=replica;
        delete from public.ai_routing_policy_versions where id in ('${g4}'::uuid,'${rollback}'::uuid);
        ${mutate}
        set local session_replication_role=origin;
        select 'FRESH_BEFORE='||jsonb_build_object(${projection})::text;
        savepoint cfg003_predecessor;
        \set ON_ERROR_STOP off
        ${body()}
        \set ON_ERROR_STOP on
        rollback to savepoint cfg003_predecessor;
        select 'FRESH_AFTER='||jsonb_build_object(${projection})::text;
        select 'FRESH_ZERO='||count(*) from public.ai_routing_policy_versions where id in ('${g4}'::uuid,'${rollback}'::uuid);
        rollback;`, { expectFailure: false });
      expect(result.stderr).toMatch(/ERROR:\s+23514:/u);
      const lines = result.stdout.split(/\r?\n/u).map((line) => line.trim());
      expect(lines.find((line) => line.startsWith("FRESH_BEFORE="))?.slice(13)).toBe(lines.find((line) => line.startsWith("FRESH_AFTER="))?.slice(12));
      expect(lines).toContain("FRESH_ZERO=0"); expect(snap()).toBe(canonical);
    });

    it("rejects old combined-v1 and the G4 selector through the operational validator", () => {
      expect(runOwnerSql(String.raw`\pset tuples_only on
        select count(*) from public.ai_service_runtime_contract_versions where runtime_contract_id='runtime.deepseek-v2-mimo-v2.5-pro.v1';`).stdout.trim()).toBe("0");
      const result = runOwnerSql(String.raw`\set VERBOSITY verbose
        select public.assert_ai_routing_policy_v1('${g4}'::uuid,'validated',clock_timestamp());`, { expectFailure: true });
      expect(result.stderr).toMatch(/ERROR:\s+(?:23514|P0001):/u);
    });
  });
});
