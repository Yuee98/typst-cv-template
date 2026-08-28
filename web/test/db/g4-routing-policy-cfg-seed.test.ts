import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { G4_ROUTING_POLICY_SEED_V1 } from "@/server/polish/g4-routing-policy-seed-v1";

import { RUN_DB_TESTS } from "./helpers";
import { runOwnerSql } from "./runtime-contract-fixtures";

const MIGRATION_URL = new URL(
  "../../../supabase/migrations/20260824007000_seed_g4_routing_policy.sql",
  import.meta.url,
);

function migrationBody(): string {
  return readFileSync(MIGRATION_URL, "utf8");
}

describe("CFG-003 G4 routing-policy seed migration", () => {
  it("contains only exact dark policy inserts and no lifecycle side effects", () => {
    const source = migrationBody();
    expect(source).toContain("begin;");
    expect(source).toContain("commit;");
    expect(source).toContain("CFG-003 routing policy identity collision");
    expect(source).toContain("components_sealed_at is null");
    expect(source).not.toMatch(/\b(?:set_ai_routing_policy_pointer_v1|transition_ai_routing_policy|validate_ai_routing_policy|apply_ai_price_component_seal_intent)\b/u);
    expect(source).not.toMatch(/\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?(?:ai_feature_config|ai_request_ledger|ai_provider_attempt_ledger|ai_usage_daily|ai_global_usage_daily|ai_profile_usage_daily|ai_rate_minutes|ai_routing_lifecycle_audit|ai_routing_policy_transition_intents)\b/iu);
  });

  describe.runIf(RUN_DB_TESTS)("database projection", () => {
    it("has exactly G2 plus the two known CFG-003 dark policies", () => {
      const result = runOwnerSql(String.raw`
        \pset format unaligned
        \pset tuples_only on
        select jsonb_agg(jsonb_build_object(
          'id', id, 'key', policy_key, 'version', version, 'status', status,
          'timezone', timezone, 'rules', rules, 'runtimeContractId', runtime_contract_id,
          'runtimeContractSha256', runtime_contract_sha256, 'configSha256', config_sha256,
          'validatedAt', validated_at, 'activatedAt', activated_at, 'retiredAt', retired_at
        ) order by id)::text
        from public.ai_routing_policy_versions;
      `);
      const line = result.stdout.split(/\r?\n/u).map((value) => value.trim()).find((value) => value.startsWith("["));
      if (!line) throw new Error(`missing CFG-003 policy projection: ${result.stdout}`);
      const rows = JSON.parse(line) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(3);
      for (const policy of Object.values(G4_ROUTING_POLICY_SEED_V1.policies)) {
        expect(rows).toContainEqual(expect.objectContaining({
          id: policy.id,
          key: policy.policyKey,
          version: policy.version,
          status: "draft",
          timezone: policy.timezone,
          rules: policy.rules,
          runtimeContractId: policy.runtimeContractId,
          runtimeContractSha256: policy.runtimeContractSha256,
          configSha256: policy.configSha256,
          validatedAt: null,
          activatedAt: null,
          retiredAt: null,
        }));
      }
    });
  });
});
