import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { G4_ROUTING_POLICY_SEED_V1 as SEED } from "../../src/server/polish/g4-routing-policy-seed-v1";
import { RUN_DB_TESTS } from "./helpers";
import { runOwnerSql } from "./runtime-contract-fixtures";

const migrationUrl = new URL("../../../supabase/migrations/20260824007000_seed_g4_routing_policy.sql", import.meta.url);
const g2 = "33333333-3333-4333-8333-333333333332";
const g4 = SEED.policies.g4.id;
const rollback = SEED.policies.rollback.id;
const tables = ["ai_feature_config", "ai_routing_policy_versions", "ai_routing_lifecycle_audit", "ai_routing_policy_transition_intents", "ai_request_ledger", "ai_provider_attempt_ledger", "ai_usage_daily", "ai_global_usage_daily", "ai_profile_usage_daily", "ai_rate_minutes"] as const;

const source = () => readFileSync(migrationUrl, "utf8");
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
function restore(): void { expect(runOwnerSql(source()).status).toBe(0); }

describe("CFG-003 G4 routing-policy seed", () => {
  it("is owner-only dark DML with no lifecycle or feature side effect", () => {
    const sql = source();
    expect(sql.match(/^begin;$/gmu)).toHaveLength(1);
    expect(sql.match(/^commit;$/gmu)).toHaveLength(1);
    expect(sql).toContain("CFG-003 routing policy identity collision");
    expect(sql).toContain("components_sealed_at is null");
    expect(sql).not.toMatch(/\b(?:set_ai_routing_policy_pointer_v1|transition_ai_routing_policy|validate_ai_routing_policy|apply_ai_price_component_seal_intent)\b/u);
    expect(sql).not.toMatch(/\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?(?:ai_feature_config|ai_request_ledger|ai_provider_attempt_ledger|ai_usage_daily|ai_global_usage_daily|ai_profile_usage_daily|ai_rate_minutes|ai_routing_lifecycle_audit|ai_routing_policy_transition_intents)\b/iu);
  });

  describe.skipIf(!RUN_DB_TESTS)("real DB", () => {
    it("has exactly G2 plus both dark candidates, exact selectors, memberships, and darkness", () => {
      const value = json(String.raw`select jsonb_build_object(
        'policies',(select jsonb_agg(jsonb_build_object('id',id,'key',policy_key,'rules',rules,'runtime',runtime_contract_id,'hash',runtime_contract_sha256,'status',status,'validated',validated_at,'active',activated_at) order by id) from public.ai_routing_policy_versions),
        'combined',(select jsonb_agg(runtime_target_id order by runtime_target_id) from public.ai_service_runtime_contract_targets where runtime_contract_id='runtime.deepseek-v2-mimo-v2.5-pro.v2'),
        'legacy',(select jsonb_agg(runtime_target_id order by runtime_target_id) from public.ai_service_runtime_contract_targets where runtime_contract_id='runtime.deepseek-v2.v1'),
        'dark',(select jsonb_build_object('mimoDraft',(select status='draft' and validated_at is null from public.ai_provider_profile_versions where id='22222222-2222-4222-8222-222222222221'::uuid),'mimoUnsealed',(select components_sealed_at is null from public.ai_price_versions where id='22222222-2222-4222-8222-222222222222'::uuid),'deepseekUnsealed',(select bool_and(components_sealed_at is null) from public.ai_price_versions where id in ('11111111-1111-4111-8111-111111111112'::uuid,'11111111-1111-4111-8111-111111111113'::uuid))))::text;`) as Record<string, unknown>;
      const policies = value.policies as Array<Record<string, unknown>>;
      expect(policies.map((x) => x.id)).toEqual([g2, g4, rollback]);
      for (const policy of Object.values(SEED.policies)) expect(policies).toContainEqual(expect.objectContaining({ id: policy.id, key: policy.policyKey, rules: policy.rules, runtime: policy.runtimeContractId, hash: policy.runtimeContractSha256, status: "draft", validated: null, active: null }));
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
      const before = snap();
      const result = runOwnerSql(String.raw`begin; set local session_replication_role=replica; ${mutate} set local session_replication_role=origin; savepoint p; \set ON_ERROR_STOP off
        ${body()}
        \set ON_ERROR_STOP on
        rollback to p; select 'AFTER='||jsonb_build_object(${tables.map((t) => `'${t}',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text collate "C"),'[]'::jsonb) from public.${t} x)`).join(",")})::text; rollback;`, { expectFailure: false });
      expect(result.stderr).toMatch(/ERROR:\s+23514:/u);
      const after = result.stdout.split(/\r?\n/u).map((x) => x.trim()).find((x) => x.startsWith("AFTER="));
      expect(after?.slice(6)).toBe(before); expect(snap()).toBe(before);
    });

    it.each([
      ["missing MiMo predecessor", "ai_price_versions", `delete from public.ai_price_versions where id='22222222-2222-4222-8222-222222222222'::uuid;`],
      ["hostile combined selector", "ai_service_runtime_contract_targets", `delete from public.ai_service_runtime_contract_targets where runtime_contract_id='runtime.deepseek-v2-mimo-v2.5-pro.v2' and runtime_target_id='runtime-target.mimo.cn.mimo-v2.5-pro.responses.v1';`],
    ])("fails closed for %", (_name, table, mutate) => {
      const before = snap(); const result = runOwnerSql(String.raw`begin; alter table public.${table} disable trigger user; ${mutate} savepoint p; \set ON_ERROR_STOP off
        ${body()}
        \set ON_ERROR_STOP on
        rollback to p; alter table public.${table} enable trigger user; rollback;`, { expectFailure: false });
      expect(result.stderr).toMatch(/ERROR:\s+23514:/u); expect(snap()).toBe(before);
    });

    it("rejects old combined-v1 and the G4 selector through the operational validator", () => {
      expect(runOwnerSql(String.raw`\pset tuples_only on select count(*) from public.ai_service_runtime_contract_versions where runtime_contract_id='runtime.deepseek-v2-mimo-v2.5-pro.v1';`).stdout.trim()).toBe("0");
      const result = runOwnerSql(String.raw`select public.assert_ai_routing_policy_v1('${g4}'::uuid,'validated',clock_timestamp());`, { expectFailure: true });
      expect(result.stderr).toMatch(/ERROR:\s+(?:23514|P0001):/u);
    });
  });
});
