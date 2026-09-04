import { describe, expect, it } from "vitest";
import { RUN_DB_TESTS } from "./helpers";
import { runOwnerSql } from "./runtime-contract-fixtures";

const q = (v: string) => `'${v.replaceAll("'", "''")}'`;

describe.skipIf(!RUN_DB_TESTS)("B3 validation report set authority", () => {
  it("exposes the successor bijection predicate over the canonical tuple", () => {
    const result = runOwnerSql(String.raw`
      select pg_get_functiondef(
        'public.admin_assert_policy_validation_reports_v2(uuid,uuid[],timestamptz)'::regprocedure
      );
    `);
    for (const field of [
      "runtime_contract_id", "runtime_target_id", "runtime_target_sha256",
      "profile_version_id", "price_version_id", "provider_id",
      "code_capability_id", "code_capability_sha256", "legal_manifest_id",
      "display_disclosure_key", "<> 1",
    ]) expect(result.stdout).toContain(field);
  });

  it("routes the established v1 caller contract through the strict successor", () => {
    const result = runOwnerSql(String.raw`
      select jsonb_build_object(
        'wrapper', position('admin_assert_policy_validation_reports_v2' in pg_get_functiondef(
          'public.admin_assert_policy_validation_reports_v1(uuid,uuid[],timestamptz)'::regprocedure)) > 0,
        'legacy', to_regprocedure(
          'public.admin_assert_policy_validation_reports_legacy_internal_v1(uuid,uuid[],timestamptz)') is not null,
        'serviceExecute', has_function_privilege('service_role',
          'public.admin_assert_policy_validation_reports_v1(uuid,uuid[],timestamptz)'::regprocedure,'EXECUTE')
      );
    `);
    const line = result.stdout.split(/\r?\n/u).map((v: string) => v.trim()).findLast((v: string) => v.startsWith("{"));
    const value = JSON.parse(line!);
    expect(value.wrapper).toBe(true);
    expect(value.legacy).toBe(true);
    expect(value.serviceExecute).toBe(false);
  });

  it("rejects an unknown policy before report selection", () => {
    const result = runOwnerSql(String.raw`
      select public.admin_assert_policy_validation_reports_v2(
        ${q(crypto.randomUUID())}::uuid,
        array[${q(crypto.randomUUID())}::uuid], clock_timestamp());
    `, { expectFailure: true });
    expect(`${result.stdout}${result.stderr}`).toMatch(/NOT_FOUND|P0002/i);
  });
});
