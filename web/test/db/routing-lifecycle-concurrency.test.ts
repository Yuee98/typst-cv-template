import { spawn } from "node:child_process";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { acceptAiLegalBundle, configureFeature, createServiceClient, createTestUser, deleteTestUser, RUN_DB_TESTS, sleep } from "./helpers";
import { authorSyntheticRuntimeContract, DEEPSEEK_LEGAL_MANIFEST_ID, INITIAL_LEGAL_BUNDLE_VERSION, readLifecycleEvidenceRoot, runOwnerSql, sealPriceAsDatabaseOwner, startOwnerSql, type OwnerSqlResult } from "./runtime-contract-fixtures";

const DB_CONTAINER = "supabase_db_typst-cv-template";
const EVIDENCE = {
  p_actor: "db013-concurrency",
  p_reason: "DB-013 deterministic concurrency gate",
} as const;

interface Barrier { ready: Promise<void>; result: Promise<OwnerSqlResult>; release: () => void }
interface Fixture { profileId: string; profileVersionId: string; priceVersionId: string; policyVersionId: string; runtimeContractId: string; runtimeContractSha256: string; runtimeTargetId: string; }

function heldOwnerSql(sql: string, marker: string, releaseSql = "commit;"): Barrier {
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let readySettled = false;
  let released = false;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let release = () => undefined;
  const result = new Promise<OwnerSqlResult>((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "--set", "ON_ERROR_STOP=1", "--no-psqlrc"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    const check = () => { if (!readySettled && `${stdout}\n${stderr}`.includes(marker)) { readySettled = true; readyResolve(); } };
    child.stdout.on("data", (chunk: string) => { stdout += chunk; check(); });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; check(); });
    child.on("error", (error) => {
      if (!readySettled) { readySettled = true; readyReject(error); }
      reject(error);
    });
    child.on("close", (status) => { if (!readySettled) { readySettled = true; readyReject(new Error(`barrier ${marker} exited: ${stderr || stdout}`)); } resolve({ status: status ?? -1, stdout, stderr }); });
    release = () => { if (!released) { released = true; child.stdin.end(releaseSql); } };
    child.stdin.write(sql);
  });
  return { ready, result, release: () => release() };
}

describe.skipIf(!RUN_DB_TESTS)("DB-013 routing lifecycle concurrency (real DB)", () => {
  let service: SupabaseClient;
  const ownedFixtures: Fixture[] = [];
  beforeAll(() => { service = createServiceClient(); });

  async function fixture(): Promise<Fixture> {
    const suffix = crypto.randomUUID();
    const profileId = crypto.randomUUID(); const profileVersionId = crypto.randomUUID(); const priceVersionId = crypto.randomUUID(); const policyVersionId = crypto.randomUUID();
    const profileKey = `db013.concurrent.${suffix}`;
    const runtime = authorSyntheticRuntimeContract({ profileKey });
    runOwnerSql(String.raw`begin;
      insert into public.ai_provider_profiles(id,profile_key,display_name,gateway_kind,model_vendor) values ('${profileId}','${profileKey}','DB013 ${suffix}','direct_deepseek','deepseek');
      insert into public.ai_provider_profile_versions(id,profile_id,version,adapter_kind,wire_api_kind,credential_alias,endpoint_alias,model_id,capability_contract_id,cache_policy_id,legal_manifest_id,display_disclosure_key,config,config_sha256)
        values ('${profileVersionId}','${profileId}',1,'deepseek_chat_v1','chat_completions_v1','deepseek_api_key','deepseek_official','deepseek-v4-flash','polish_v2','automatic_cache_v1','${DEEPSEEK_LEGAL_MANIFEST_ID}','deepseek.official','{}','${"a".repeat(64)}');
      update public.ai_provider_profile_versions set status='validated' where id='${profileVersionId}';
      insert into public.ai_price_versions(id,profile_version_id,version,pricing_lane,currency,calculator_kind,valid_from,source_url,source_checked_at,source_snapshot_sha256,parameters)
        values ('${priceVersionId}','${profileVersionId}',1,'default','CNY','linear_token_v1',clock_timestamp()-interval '1 hour','https://example.com/db013-${suffix}',clock_timestamp(),'${"b".repeat(64)}','{}');
      insert into public.ai_price_components(price_version_id,component,nanos_per_million) values ('${priceVersionId}','input_standard',1),('${priceVersionId}','input_cache_read',1),('${priceVersionId}','output',1);
      insert into public.ai_routing_policy_versions(id,policy_key,version,status,timezone,rules,default_profile_version_id,legal_bundle_version,runtime_contract_id,runtime_contract_sha256,config_sha256)
        values ('${policyVersionId}','db013.concurrent.${suffix}',1,'draft','Asia/Shanghai',jsonb_build_object('schemaVersion','routing_rules_v1','defaultRoute',jsonb_build_object('profileVersionId','${profileVersionId}','priceVersionId','${priceVersionId}'),'windows','[]'::jsonb),'${profileVersionId}','${INITIAL_LEGAL_BUNDLE_VERSION}','${runtime.runtimeContractId}','${runtime.runtimeContractSha256}','${"c".repeat(64)}'); commit;`);
    sealPriceAsDatabaseOwner(priceVersionId);
    const result = { profileId, profileVersionId, priceVersionId, policyVersionId, runtimeContractId: runtime.runtimeContractId, runtimeContractSha256: runtime.runtimeContractSha256, runtimeTargetId: runtime.runtimeTargetId };
    ownedFixtures.push(result); return result;
  }

  async function cleanup(f: Fixture) {
    runOwnerSql(`begin; set local session_replication_role=replica; update public.ai_feature_config set active_routing_policy_version_id=null,routing_updated_by=null,routing_change_reason=null where active_routing_policy_version_id='${f.policyVersionId}'; update public.ai_feature_config set ai_polish_enabled=false,enabled_user_allowlist='{}' where id=true; delete from public.ai_routing_lifecycle_audit where policy_version_id='${f.policyVersionId}' or profile_version_id='${f.profileVersionId}' or price_version_id='${f.priceVersionId}'; delete from public.ai_request_ledger where routing_policy_version_id='${f.policyVersionId}'; delete from public.ai_routing_policy_versions where id='${f.policyVersionId}'; delete from public.ai_price_components where price_version_id='${f.priceVersionId}'; delete from public.ai_price_versions where id='${f.priceVersionId}'; delete from public.ai_provider_profile_versions where id='${f.profileVersionId}'; delete from public.ai_provider_profiles where id='${f.profileId}'; delete from public.ai_service_runtime_contract_targets where runtime_contract_id='${f.runtimeContractId}' and runtime_target_id='${f.runtimeTargetId}'; delete from public.ai_service_runtime_contract_versions where runtime_contract_id='${f.runtimeContractId}' and runtime_contract_sha256='${f.runtimeContractSha256}'; delete from public.ai_service_runtime_target_versions where runtime_target_id='${f.runtimeTargetId}'; commit;`);
  }
  afterEach(async () => { while (ownedFixtures.length) { const current = ownedFixtures[0]; await cleanup(current); ownedFixtures.shift(); } });

  async function evidence(f: Fixture) {
    const root = readLifecycleEvidenceRoot({
      runtimeContractId: f.runtimeContractId,
      runtimeContractSha256: f.runtimeContractSha256,
      priceVersionIds: [f.priceVersionId],
    });
    return {
      ...EVIDENCE,
      p_runtime_contract_id: f.runtimeContractId,
      p_runtime_contract_sha256: f.runtimeContractSha256,
      p_reviewed_source_commit_oid: root.reviewedSourceCommitOid,
      p_reviewed_source_sha256: f.runtimeContractSha256,
      p_rechecked_at: root.recheckedAt,
      p_rechecked_sha256: f.runtimeContractSha256,
    };
  }

  async function lifecycle(name: string, args: Record<string, unknown>) { return service.rpc(name, args); }

  async function makeCanary(f: Fixture) {
    const ev = await evidence(f);
    expect((await lifecycle("transition_ai_routing_policy_v2", { p_policy_version_id: f.policyVersionId, p_to_status: "validated", ...ev })).error).toBeNull();
    runOwnerSql(`update public.ai_provider_profile_versions set status='canary' where id='${f.profileVersionId}';`);
    expect((await lifecycle("transition_ai_routing_policy_v2", { p_policy_version_id: f.policyVersionId, p_to_status: "canary", ...ev })).error).toBeNull();
  }

  async function waitForLock(applicationName: string) {
    for (let i = 0; i < 80; i += 1) {
      const state = runOwnerSql(`select coalesce(wait_event_type,'') || ':' || coalesce(wait_event,'') from pg_catalog.pg_stat_activity where application_name='${applicationName}';`).stdout;
      if (state.split(/\r?\n/u).some((line) => line.trim().startsWith("Lock:"))) return;
      await sleep(25);
    }
    throw new Error(`no lock wait observed for ${applicationName}`);
  }

  function parseOwnerCount(result: OwnerSqlResult): number {
    const match = result.stdout.match(/^\s*(\d+)\s*$/mu);
    if (!match) throw new Error(`owner SQL did not return a canonical count: ${result.stdout}`);
    return Number(match[1]);
  }

  async function runObservedBlockedRace(
    holderSql: string,
    marker: string,
    contenderName: string,
    contenderSql: string,
    releaseSql = "commit;",
  ): Promise<{ holder: OwnerSqlResult; contender: OwnerSqlResult }> {
    const holder = heldOwnerSql(holderSql, marker, releaseSql);
    let contender: Promise<OwnerSqlResult> | undefined;
    try {
      await holder.ready;
      contender = startOwnerSql(contenderSql);
      await sleep(100);
      await waitForLock(contenderName);
      holder.release();
      const [holderResult, contenderResult] = await Promise.all([
        holder.result,
        contender,
      ]);
      return { holder: holderResult, contender: contenderResult };
    } finally {
      holder.release();
      await Promise.allSettled([
        holder.result,
        ...(contender ? [contender] : []),
      ]);
    }
  }

  it("serializes two real policy transitions and revalidates after the winner", async () => {
    const candidate = await fixture();
    const ev = await evidence(candidate);
    const contenderName = `db013-transition-${crypto.randomUUID()}`;
    const sqlEvidence = Object.entries(ev).map(([key, value]) => `${key}=>${typeof value === "string" ? `'${value}'` : value}`).join(", ");
    const holder = heldOwnerSql(`begin; set local role service_role; select public.transition_ai_routing_policy_v2(p_policy_version_id=>'${candidate.policyVersionId}',p_to_status=>'validated',${sqlEvidence}); reset role; \\echo DB013_POLICY_HELD\n`, "DB013_POLICY_HELD", "commit;");
    await holder.ready;
    const contender = startOwnerSql(`begin; set local application_name='${contenderName}'; set local role service_role; select public.transition_ai_routing_policy_v2(p_policy_version_id=>'${candidate.policyVersionId}',p_to_status=>'validated',${sqlEvidence}); reset role; commit;`);
    try { await sleep(100); await waitForLock(contenderName); } finally { holder.release(); }
    const contenderResult = await contender;
    const holderResult = await holder.result;
    expect(holderResult.status).toBe(0);
    expect(contenderResult.status).not.toBe(0);
    const row = await service.from("ai_routing_policy_versions").select("status").eq("id", candidate.policyVersionId).single();
    expect(row.data?.status).toBe("validated");
    const audit = runOwnerSql(String.raw`\pset tuples_only on
select count(*) from public.ai_routing_lifecycle_audit where policy_version_id='${candidate.policyVersionId}' and operation='policy_transition';`);
    expect(audit.status).toBe(0); expect(parseOwnerCount(audit)).toBe(1);
  });

  it("serializes pointer set/clear and preserves singleton generation plus audit", async () => {
    const canary = await fixture(); await makeCanary(canary);
    const ev = await evidence(canary);
    const setEv = { ...ev, p_reason: `DB-013 pointer set ${crypto.randomUUID()}` };
    const clearEv = { ...ev, p_reason: `DB-013 pointer clear ${crypto.randomUUID()}` };
    const before = await service.from("ai_feature_config").select("active_routing_policy_version_id,config_generation").eq("id", true).single();
    const pointerApp = `db013-pointer-${crypto.randomUUID()}`;
    const setSqlEvidence = Object.entries(setEv).map(([key, value]) => `${key}=>'${value}'`).join(", ");
    const clearSqlEvidence = Object.entries(clearEv).map(([key, value]) => `${key}=>'${value}'`).join(", ");
    const holder = heldOwnerSql(`begin; set local role service_role; select public.set_ai_routing_policy_pointer_v1(p_policy_version_id=>'${canary.policyVersionId}',${setSqlEvidence}); reset role; \\echo DB013_POINTER_HELD\n`, "DB013_POINTER_HELD", "commit;");
    await holder.ready;
    const set = startOwnerSql(`begin; set local application_name='${pointerApp}'; set local role service_role; select public.clear_ai_routing_policy_pointer_v1(p_expected_policy_version_id=>'${canary.policyVersionId}',${clearSqlEvidence}); reset role; commit;`);
    try { await sleep(100); await waitForLock(pointerApp); } finally { holder.release(); }
    expect((await set).status).toBe(0); expect((await holder.result).status).toBe(0);
    const after = await service.from("ai_feature_config").select("active_routing_policy_version_id,config_generation").eq("id", true).single();
    expect(after.data?.active_routing_policy_version_id).toBeNull();
    expect(Number(after.data?.config_generation)).toBe(Number(before.data?.config_generation) + 2);
    const audits = runOwnerSql(String.raw`\pset tuples_only on
select count(*) from public.ai_routing_lifecycle_audit where policy_version_id='${canary.policyVersionId}' and operation in ('pointer_set','pointer_clear');`);
    expect(audits.status).toBe(0); expect(parseOwnerCount(audits)).toBe(2);
  });

  it("reserves an old or new complete frozen snapshot while pointer changes serialize", async () => {
    const canary = await fixture(); await makeCanary(canary);
    const ev = await evidence(canary);
    expect((await lifecycle("set_ai_routing_policy_pointer_v1", { p_policy_version_id: canary.policyVersionId, ...ev, p_reason: `DB-013 reserve pointer set ${crypto.randomUUID()}` })).error).toBeNull();
    const config = await service.from("ai_feature_config").select("config_generation").eq("id", true).single();
    const user = await createTestUser(service, "db013-concurrency");
    try {
      await acceptAiLegalBundle(service, user.id, INITIAL_LEGAL_BUNDLE_VERSION); await configureFeature(service, { enabled: true, globalDailyLimit: 2000, allowlist: [user.id] });
      const reserveApp = `db013-reserve-${crypto.randomUUID()}`; const clearApp = `db013-clear-${crypto.randomUUID()}`; const requestId = crypto.randomUUID(); const clientRequestId = crypto.randomUUID();
      let reserve: Barrier | undefined;
      try {
        reserve = heldOwnerSql(`begin; set local application_name='${reserveApp}'; set local role service_role; select public.reserve_ai_polish_request_v2('${user.id}'::uuid,'${requestId}'::uuid,'${clientRequestId}'::uuid,jsonb_build_object('schema_version','expected_route_v1','config_generation','${config.data?.config_generation}','profile_version_id','${canary.profileVersionId}','legal_bundle_version','${INITIAL_LEGAL_BUNDLE_VERSION}','runtime_contract_id','${canary.runtimeContractId}','runtime_contract_sha256','${canary.runtimeContractSha256}')); reset role; \\echo DB013_RESERVE_HELD\n`, "DB013_RESERVE_HELD", "commit;");
        await reserve.ready;
        const clearEvidence = { ...ev, p_reason: `DB-013 reserve pointer clear ${crypto.randomUUID()}` };
        const clear = startOwnerSql(`begin; set local application_name='${clearApp}'; set local role service_role; select public.clear_ai_routing_policy_pointer_v1(p_expected_policy_version_id=>'${canary.policyVersionId}',${Object.entries(clearEvidence).map(([key, value]) => `${key}=>'${value}'`).join(", ")}); reset role; commit;`);
        try { await waitForLock(clearApp); } finally { reserve.release(); }
        const [reserved, cleared] = await Promise.all([reserve.result, clear]);
        expect(reserved.status).toBe(0); expect(cleared.status).toBe(0); expect(reserved.stdout).toContain(canary.runtimeContractId);
      } finally { reserve?.release(); if (reserve) await reserve.result.catch(() => undefined); }
      const ledger = await service.from("ai_request_ledger").select("routing_policy_version_id,profile_version_id,runtime_contract_id,runtime_contract_sha256").eq("user_id", user.id).eq("client_request_id", clientRequestId).single();
      expect(ledger.data).toMatchObject({ routing_policy_version_id: canary.policyVersionId, profile_version_id: canary.profileVersionId, runtime_contract_id: canary.runtimeContractId, runtime_contract_sha256: canary.runtimeContractSha256 });
    } finally { await deleteTestUser(service, user.id); await configureFeature(service, { enabled: false, allowlist: [] }); }
  });

  it("rejects profile retirement and price closure after promotion (control)", async () => {
    const canary = await fixture(); await makeCanary(canary);
    const ev = await evidence(canary);
    const version = await service.from("ai_provider_profile_versions").select("profile_id").eq("id", canary.profileVersionId).single();
    expect(version.error).toBeNull();
    const priceId = canary.priceVersionId;
    runOwnerSql(`update public.ai_provider_profile_versions set status='active' where id='${canary.profileVersionId}';`);
    const promoted = await lifecycle("transition_ai_routing_policy_v2", { p_policy_version_id: canary.policyVersionId, p_to_status: "active", ...ev });
    expect(promoted.error).toBeNull();
    const rejectedRetire = await lifecycle("retire_ai_provider_profile_version_v1", { p_profile_version_id: canary.profileVersionId, ...ev });
    expect(rejectedRetire.error?.code).toMatch(/23514|P0001/);
    const close = await lifecycle("close_ai_price_version_v1", { p_price_version_id: priceId, p_valid_to: new Date().toISOString(), p_successor_price_version_id: null, ...ev });
    expect(close.error?.code).toMatch(/23514|P0001/); expect(version.data?.profile_id).toBeTruthy();
  });

  it("serializes profile retirement against policy transition and revalidates the loser", async () => {
    const candidate = await fixture();
    const ev = await evidence(candidate);
    const sqlEvidence = Object.entries(ev).map(([key, value]) => `${key}=>'${value}'`).join(", ");
    const contenderName = `db013-retire-${crypto.randomUUID()}`;
    const race = await runObservedBlockedRace(
      `begin; set local role service_role; select public.transition_ai_routing_policy_v2(p_policy_version_id=>'${candidate.policyVersionId}',p_to_status=>'validated',${sqlEvidence}); reset role; \\echo DB013_RETIRE_TRANSITION_HELD\n`,
      "DB013_RETIRE_TRANSITION_HELD",
      contenderName,
      `begin; set local application_name='${contenderName}'; set local role service_role; select public.retire_ai_provider_profile_version_v1(p_profile_version_id=>'${candidate.profileVersionId}',${sqlEvidence}); reset role; commit;`,
    );
    expect(race.holder.status).toBe(0);
    expect(race.contender.status).not.toBe(0);
    const policy = await service.from("ai_routing_policy_versions").select("status").eq("id", candidate.policyVersionId).single();
    const profile = await service.from("ai_provider_profile_versions").select("status").eq("id", candidate.profileVersionId).single();
    expect(policy.data?.status).toBe("validated");
    expect(profile.data?.status).toBe("validated");
    const audit = runOwnerSql(String.raw`\pset tuples_only on
select count(*) from public.ai_routing_lifecycle_audit
where (operation='policy_transition' and policy_version_id='${candidate.policyVersionId}')
   or (operation='profile_version_retire' and profile_version_id='${candidate.profileVersionId}');`);
    expect(audit.status).toBe(0); expect(parseOwnerCount(audit)).toBe(1);
  });

  it("serializes price closure against policy transition and revalidates the loser", async () => {
    const candidate = await fixture();
    const ev = await evidence(candidate);
    const sqlEvidence = Object.entries(ev).map(([key, value]) => `${key}=>'${value}'`).join(", ");
    const contenderName = `db013-close-price-${crypto.randomUUID()}`;
    const race = await runObservedBlockedRace(
      `begin; set local role service_role; select public.transition_ai_routing_policy_v2(p_policy_version_id=>'${candidate.policyVersionId}',p_to_status=>'validated',${sqlEvidence}); reset role; \\echo DB013_CLOSE_TRANSITION_HELD\n`,
      "DB013_CLOSE_TRANSITION_HELD",
      contenderName,
      `begin; set local application_name='${contenderName}'; set local role service_role; select public.close_ai_price_version_v1(p_price_version_id=>'${candidate.priceVersionId}',p_valid_to=>clock_timestamp(),p_successor_price_version_id=>null,${sqlEvidence}); reset role; commit;`,
    );
    expect(race.holder.status).toBe(0);
    expect(race.contender.status).not.toBe(0);
    const policy = await service.from("ai_routing_policy_versions").select("status").eq("id", candidate.policyVersionId).single();
    const price = await service.from("ai_price_versions").select("valid_to").eq("id", candidate.priceVersionId).single();
    expect(policy.data?.status).toBe("validated");
    expect(price.data?.valid_to).toBeNull();
    const audit = runOwnerSql(String.raw`\pset tuples_only on
select count(*) from public.ai_routing_lifecycle_audit
where (operation='policy_transition' and policy_version_id='${candidate.policyVersionId}')
   or (operation='price_close' and price_version_id='${candidate.priceVersionId}');`);
    expect(audit.status).toBe(0); expect(parseOwnerCount(audit)).toBe(1);
  });

  it("observes the lock wait and leaves state/audit unchanged after timeout/rollback", async () => {
    const candidate = await fixture();
    const ev = await evidence(candidate);
    const before = await service.from("ai_routing_policy_versions").select("status").eq("id", candidate.policyVersionId).single();
    const pointerBefore = await service.from("ai_feature_config").select("active_routing_policy_version_id,config_generation").eq("id", true).single();
    const auditBefore = runOwnerSql(String.raw`\pset tuples_only on
select count(*) from public.ai_routing_lifecycle_audit where policy_version_id='${candidate.policyVersionId}';`);
    const holderName = `db013-lock-holder-${crypto.randomUUID()}`; const contenderName = `db013-lock-contender-${crypto.randomUUID()}`;
    const holder = heldOwnerSql(`begin; set local application_name='${holderName}'; select 1 from public.ai_feature_config where id=true for update; \\echo DB013_LOCK_HELD\nselect pg_sleep(6);`, "DB013_LOCK_HELD", "rollback;");
    let holderResult: OwnerSqlResult | undefined;
    try {
      await holder.ready;
      const sqlEvidence = Object.entries(ev).map(([key, value]) => `${key}=>'${value}'`).join(", ");
      const contender = startOwnerSql(`begin; set local application_name='${contenderName}'; set local role service_role; select public.transition_ai_routing_policy_v2(p_policy_version_id=>'${candidate.policyVersionId}',p_to_status=>'validated',${sqlEvidence}); reset role; commit;`);
      await waitForLock(contenderName);
      const result = await contender; expect(result.status).not.toBe(0); holder.release();
    } finally { holder.release(); holderResult = await holder.result; }
    expect(holderResult?.status).toBe(0);
    const after = await service.from("ai_routing_policy_versions").select("status").eq("id", candidate.policyVersionId).single();
    const pointerAfter = await service.from("ai_feature_config").select("active_routing_policy_version_id,config_generation").eq("id", true).single();
    const auditAfter = runOwnerSql(String.raw`\pset tuples_only on
select count(*) from public.ai_routing_lifecycle_audit where policy_version_id='${candidate.policyVersionId}';`);
    expect(after.data?.status).toBe(before.data?.status); expect(parseOwnerCount(auditAfter)).toBe(parseOwnerCount(auditBefore));
    expect(pointerBefore.error).toBeNull(); expect(pointerAfter.error).toBeNull();
    expect(pointerAfter.data?.active_routing_policy_version_id).toBe(pointerBefore.data?.active_routing_policy_version_id);
    expect(Number(pointerAfter.data?.config_generation)).toBe(Number(pointerBefore.data?.config_generation));
  });
});
