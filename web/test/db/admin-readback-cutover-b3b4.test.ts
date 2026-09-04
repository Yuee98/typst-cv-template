import { describe, expect, it } from "vitest";
import { RUN_DB_TESTS } from "./helpers";
import { runOwnerSql } from "./runtime-contract-fixtures";

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

describe.skipIf(!RUN_DB_TESTS)("B3/B4 runtime authority readback", () => {
  it("persists migration owned hashes and includes the fresh readback authority", () => {
    const result = runOwnerSql(String.raw`
      select jsonb_build_object(
        'expected', (select count(*) from public.admin_runtime_authority_expected_v2),
        'readback', exists (select 1 from public.admin_runtime_authority_expected_v2
          where signature like 'public.record_admin_runtime_readback_v2(%'
            and definition_sha256 ~ '^[0-9a-f]{64}$'),
        'manifestReadback', position('readbackAuthority' in pg_get_functiondef(
          'public.admin_cutover_authority_v2(uuid,uuid,uuid[],bigint,bigint,text)'::regprocedure)) > 0,
        'v4Shape', position('admin_runtime_authority_manifest_v4' in pg_get_constraintdef(
          (select oid from pg_constraint where conname='admin_runtime_authority_manifest_shape_v4'
            and conrelid='public.admin_runtime_authority_receipts_v2'::regclass))) > 0
      );
    `);
    const line = result.stdout.split(/\r?\n/u).map((v: string) => v.trim()).findLast((v: string) => v.startsWith("{"));
    expect(line).toBeTruthy();
    const value = JSON.parse(line!);
    expect(value.expected).toBe(18);
    expect(value.readback).toBe(true);
    expect(value.manifestReadback).toBe(true);
    expect(value.v4Shape).toBe(true);
  });

  it("binds readback to the complete sealed target tuple", () => {
    const result = runOwnerSql(String.raw`
      select pg_get_functiondef(
        'public.record_admin_runtime_readback_v2(uuid,uuid,bigint,text,uuid,uuid[],text,text,text)'::regprocedure
      );
    `);
    const body = result.stdout;
    for (const field of [
      "runtime_contract_id", "runtime_target_id", "runtime_target_sha256",
      "profile_version_id", "price_version_id", "provider_id",
      "legal_bundle_version", "legal_manifest_id", "display_disclosure_key",
      "code_capability_id", "code_capability_sha256",
    ]) expect(body).toContain(field);
  });

  it("fails closed before accepting a crossed or incomplete admission", () => {
    const result = runOwnerSql(String.raw`
      begin;
      set local role service_role;
      set local request.jwt.claims='{"role":"service_role"}';
      select public.record_admin_runtime_readback_v2(
        ${quote(crypto.randomUUID())}::uuid, ${quote(crypto.randomUUID())}::uuid,
        1, ${quote("a".repeat(64))}, ${quote(crypto.randomUUID())}::uuid,
        array[${quote(crypto.randomUUID())}::uuid], 'missing-build',
        'missing-manifest', ${quote("b".repeat(64))});
      rollback;
    `, { expectFailure: true });
    expect(`${result.stdout}${result.stderr}`).toMatch(/READBACK_ADMISSION_REQUIRED|NOT_FOUND/i);
  });
});
