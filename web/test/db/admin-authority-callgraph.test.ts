import { describe, expect, it } from "vitest";
import { RUN_DB_TESTS } from "./helpers";
import { runOwnerSql } from "./runtime-contract-fixtures";

describe.skipIf(!RUN_DB_TESTS)("B4 authority call graph", () => {
  it("covers the successor start, readback, cutover, and policy validators", () => {
    const result = runOwnerSql(String.raw`
      select jsonb_build_object(
        'schema', position('admin_runtime_authority_manifest_v4' in pg_get_constraintdef(
          (select oid from pg_constraint where conname='admin_runtime_authority_manifest_shape_v4'
            and conrelid='public.admin_runtime_authority_receipts_v2'::regclass))),
        'count', (select count(*) from public.admin_runtime_authority_expected_v2),
        'covered', (select count(*) from public.admin_runtime_authority_expected_v2
          where signature in (
            'public.record_admin_runtime_readback_v1(uuid,uuid,uuid[],text,text,text)',
            'public.admin_cutover_authority_legacy_internal_v1(uuid,uuid[],bigint,bigint,text)',
            'public.start_ai_polish_provider_attempt_internal(uuid,integer)',
            'public.admin_policy_effective_routes_v1(uuid)',
            'public.admin_assert_policy_validation_reports_v1(uuid,uuid[],timestamptz)',
            'public.admin_assert_policy_validation_reports_v2(uuid,uuid[],timestamptz)',
            'public.admin_assert_policy_validation_reports_legacy_internal_v1(uuid,uuid[],timestamptz)',
            'public.start_ai_polish_provider_attempt_v4(uuid,integer,jsonb)',
            'public.current_ai_terms_version()',
            'public.ai_endpoint_shape_v2(text)')),
        'definitionDrift', (select count(*)
          from public.admin_runtime_authority_expected_v2 expected
          where expected.definition_sha256 is distinct from encode(extensions.digest(
            replace(replace(pg_get_functiondef(to_regprocedure(expected.signature)),
              chr(13)||chr(10),chr(10)),chr(13),chr(10)),
            'sha256'),'hex')),
        'callGraph', position('callGraph' in pg_get_functiondef(
          'public.admin_cutover_authority_v2(uuid,uuid,uuid[],bigint,bigint,text)'::regprocedure))
      );
    `);
    const line = result.stdout.split(/\r?\n/u).map((v: string) => v.trim()).findLast((v: string) => v.startsWith("{"));
    expect(line).toBeTruthy();
    const value = JSON.parse(line!);
    expect(value.schema).toBeGreaterThan(0);
    expect(value.count).toBe(18);
    expect(value.covered).toBe(10);
    expect(value.definitionDrift).toBe(0);
    expect(value.callGraph).toBeGreaterThan(0);
  });
});
