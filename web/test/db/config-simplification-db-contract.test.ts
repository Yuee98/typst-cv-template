import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createServiceClient,
  createTestUser,
  deleteTestUser,
  RUN_DB_TESTS,
  type TestUser,
} from "./helpers";
import { runOwnerSql } from "./runtime-contract-fixtures";

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

describe.skipIf(!RUN_DB_TESTS)("CFG-005 config-owned runtime contract", () => {
  it("keeps historical V2 provenance while exposing only the successor RPCs", () => {
    const result = runOwnerSql(String.raw`
      select jsonb_build_object(
        'configCandidate', to_regprocedure(
          'public.get_admin_config_validation_candidate_v2(text,text)'
        ) is not null,
        'configReport', to_regprocedure(
          'public.record_admin_config_validation_report_v2(text,text,text,boolean,boolean,boolean,boolean)'
        ) is not null,
        'futurePolicyValidator', to_regprocedure(
          'public.lock_and_validate_ai_routing_policy_candidate_v2(public.ai_routing_policy_versions,text,timestamptz)'
        ) is not null,
        'candidateReportCheck', to_regprocedure(
          'public.admin_assert_candidate_policy_config_reports_v2(public.ai_routing_policy_versions,uuid[],timestamptz)'
        ) is not null,
        'futureTransitionTrigger', to_regprocedure(
          'public.validate_ai_routing_policy_transition_v2()'
        ) is not null,
        'futureTransitionTriggerBinding', exists (
          select 1 from pg_catalog.pg_trigger trigger
          where trigger.tgrelid='public.ai_routing_policy_versions'::regclass
            and trigger.tgname='validate_ai_routing_policy_transition_v1'
            and not trigger.tgisinternal
            and trigger.tgfoid='public.validate_ai_routing_policy_transition_v2()'::regprocedure
            and trigger.tgtype=17 and trigger.tgenabled='O'
        ),
        'snapshotV5', to_regprocedure(
          'public.get_ai_polish_execution_snapshot_v5(uuid,uuid,text,text)'
        ) is not null,
        'startV5', to_regprocedure(
          'public.start_ai_polish_provider_attempt_v5(uuid,integer,jsonb)'
        ) is not null,
        'readbackV3', to_regprocedure(
          'public.record_admin_runtime_readback_v3(text,text,uuid,uuid[],uuid,bigint,bigint)'
        ) is not null,
        'pointerSetV2', to_regprocedure(
          'public.admin_set_ai_routing_pointer_v2(text,text,uuid,uuid[],bigint,uuid,bigint,text,uuid)'
        ) is not null,
        'pointerClearV2', to_regprocedure(
          'public.admin_clear_ai_routing_pointer_v2(text,text,uuid[],bigint,uuid,bigint,text,uuid)'
        ) is not null,
        'pointerSetUsesConfigReports', position('admin_assert_policy_config_reports_v1' in pg_get_functiondef(
          'public.admin_set_ai_routing_pointer_v2(text,text,uuid,uuid[],bigint,uuid,bigint,text,uuid)'::regprocedure
        )) > 0,
        'pointerSetHasNoReviewedDeployment', position('reviewedDeployment' in pg_get_functiondef(
          'public.admin_set_ai_routing_pointer_v2(text,text,uuid,uuid[],bigint,uuid,bigint,text,uuid)'::regprocedure
        )) = 0,
        'pointerSetUsesV2Internal', position('set_ai_routing_policy_pointer_v2_internal' in pg_get_functiondef(
          'public.admin_set_ai_routing_pointer_v2(text,text,uuid,uuid[],bigint,uuid,bigint,text,uuid)'::regprocedure
        )) > 0,
        'pointerSetHasNoLegacyInternal', position('set_ai_routing_policy_pointer_v1' in pg_get_functiondef(
          'public.admin_set_ai_routing_pointer_v2(text,text,uuid,uuid[],bigint,uuid,bigint,text,uuid)'::regprocedure
        )) = 0,
        'pointerClearUsesV2Internal', position('clear_ai_routing_policy_pointer_v2_internal' in pg_get_functiondef(
          'public.admin_clear_ai_routing_pointer_v2(text,text,uuid[],bigint,uuid,bigint,text,uuid)'::regprocedure
        )) > 0,
        'pointerClearHasNoLegacyInternal', position('clear_ai_routing_policy_pointer_v1' in pg_get_functiondef(
          'public.admin_clear_ai_routing_pointer_v2(text,text,uuid[],bigint,uuid,bigint,text,uuid)'::regprocedure
        )) = 0,
        'oldStartPreserved', position('v2 execution provenance is malformed' in pg_get_functiondef(
          'public.start_ai_polish_provider_attempt_v2(uuid,integer,text,text)'::regprocedure
        )) > 0,
        'successorStartGranted', has_function_privilege('service_role',
          'public.start_ai_polish_provider_attempt_v5(uuid,integer,jsonb)','EXECUTE'
        ),
        'noPublicStart', not exists (
          select 1 from pg_catalog.aclexplode(coalesce(
            (select proacl from pg_catalog.pg_proc where oid=
              'public.start_ai_polish_provider_attempt_v5(uuid,integer,jsonb)'::regprocedure),
            pg_catalog.acldefault('f',(select proowner from pg_catalog.pg_proc where oid=
              'public.start_ai_polish_provider_attempt_v5(uuid,integer,jsonb)'::regprocedure)
          ))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE'
        )
      );
    `);
    const line = result.stdout
      .split(/\r?\n/u)
      .map((value: string) => value.trim())
      .findLast((value: string) => value.startsWith("{"));
    expect(line).toBeTruthy();
    expect(JSON.parse(line!)).toEqual({
      configCandidate: true,
      configReport: true,
      futurePolicyValidator: true,
      candidateReportCheck: true,
      futureTransitionTrigger: true,
      futureTransitionTriggerBinding: true,
      snapshotV5: true,
      startV5: true,
      readbackV3: true,
      pointerSetV2: true,
      pointerClearV2: true,
      pointerSetUsesConfigReports: true,
      pointerSetHasNoReviewedDeployment: true,
      pointerSetUsesV2Internal: true,
      pointerSetHasNoLegacyInternal: true,
      pointerClearUsesV2Internal: true,
      pointerClearHasNoLegacyInternal: true,
      oldStartPreserved: true,
      successorStartGranted: true,
      noPublicStart: true,
    });
  });
});

describe.skipIf(!RUN_DB_TESTS)("CFG-005 authority proof negative paths", () => {
  let service: SupabaseClient;
  let adminUser: TestUser;

  beforeAll(async () => {
    service = createServiceClient();
    adminUser = await createTestUser(service, "cfg005-authority-proof");
  });

  afterAll(async () => {
    if (adminUser) await deleteTestUser(service, adminUser.id);
  });

  it("rejects a pre-cutover definition tamper instead of stamping it", () => {
    const result = runOwnerSql(String.raw`
      begin;
      select public.admin_bootstrap_v2(${sql(adminUser.id)},'local','CFG-005 authority tamper bootstrap');
      create or replace function public.admin_assert_policy_config_reports_v1(
        p_policy_version_id uuid,p_validation_report_ids uuid[],p_at timestamptz
      )
      returns jsonb language sql security definer set search_path='' as $$ select '{}'::jsonb $$;
      do $assert$
      begin
        begin
          perform public.admin_cutover_authority_v3('{}'::uuid[],0,0,'CFG-005 must reject tampered authority');
          raise exception 'tampered authority was accepted';
        exception when check_violation then
          if sqlerrm <> 'RUNTIME_AUTHORITY_MISMATCH' then raise; end if;
        end;
      end;
      $assert$;
      rollback;
    `);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    [
      "the delegated TOTP predicate",
      String.raw`
        create or replace function public.admin_has_recent_totp_v1(p_actor uuid)
        returns boolean language sql stable security definer set search_path='' as $$ select true $$;
      `,
    ],
    [
      "the delegated write-actor predicate",
      String.raw`
        create or replace function public.admin_assert_write_actor_v1(
          p_environment text,p_project_ref text,p_require_recent_totp boolean default false
        ) returns uuid language sql security definer set search_path='' as $$ select null::uuid $$;
      `,
    ],
  ])("rejects pre-cutover drift in %s", (_name, tamper) => {
    const result = runOwnerSql(String.raw`
      begin;
      select public.admin_bootstrap_v2(${sql(adminUser.id)},'local','CFG-005 delegated authority bootstrap');
      ${tamper}
      do $assert$
      begin
        begin
          perform public.admin_cutover_authority_v3('{}'::uuid[],0,0,'CFG-005 delegated authority must reject drift');
          raise exception 'delegated authority drift was accepted';
        exception when check_violation then
          if sqlerrm <> 'RUNTIME_AUTHORITY_MISMATCH' then raise; end if;
        end;
      end;
      $assert$;
      rollback;
    `);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    [
      "the current legal-bundle predicate",
      String.raw`
        create or replace function public.current_ai_terms_version()
        returns text language sql stable set search_path='' as $$ select 'tampered'::text $$;
      `,
    ],
    [
      "the endpoint-shape predicate",
      String.raw`
        create or replace function public.ai_endpoint_shape_v2(p_url text)
        returns boolean language sql immutable set search_path='' as $$ select true $$;
      `,
    ],
  ])("detects post-cutover drift in %s", (_name, tamper) => {
    const result = runOwnerSql(String.raw`
      begin;
      select public.admin_bootstrap_v2(${sql(adminUser.id)},'local','CFG-005 delegated authority bootstrap');
      select public.admin_cutover_authority_v3('{}'::uuid[],0,0,'CFG-005 delegated authority cutover');
      ${tamper}
      do $assert$
      begin
        begin
          perform public.admin_assert_runtime_authority_receipt_v3('local','local');
          raise exception 'post-cutover delegated authority drift was accepted';
        exception when check_violation then
          if sqlerrm <> 'RUNTIME_AUTHORITY_MISMATCH' then raise; end if;
        end;
      end;
      $assert$;
      rollback;
    `);
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a post-cutover old/internal RPC regrant and denies direct internal calls", () => {
    const result = runOwnerSql(String.raw`
      begin;
      select public.admin_bootstrap_v2(${sql(adminUser.id)},'local','CFG-005 authority regrant bootstrap');
      select public.admin_cutover_authority_v3('{}'::uuid[],0,0,'CFG-005 authority regrant cutover');
      do $assert$
      declare v_role text;
      begin
        foreach v_role in array array['anon','authenticated','service_role'] loop
          execute format('set local role %I',v_role);
          begin
            perform public.start_ai_polish_provider_attempt_v5_internal(gen_random_uuid(),1);
            raise exception 'internal start was executable by %',v_role;
          exception when insufficient_privilege then null;
          end;
          reset role;
        end loop;
        grant execute on function public.admin_reopen_ai_v1(text,text,uuid,uuid,bigint,uuid,bigint,text,uuid) to authenticated;
        begin
          perform public.admin_assert_runtime_authority_receipt_v3('local','local');
          raise exception 'old RPC regrant was accepted';
        exception when check_violation then
          if sqlerrm <> 'RUNTIME_AUTHORITY_MISMATCH' then raise; end if;
        end;
      end;
      $assert$;
      rollback;
    `);
    expect(result.status, result.stderr).toBe(0);
  });
});
