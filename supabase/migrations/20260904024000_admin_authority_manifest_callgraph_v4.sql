-- B4 successor: make the migration-owned authority manifest cover every
-- security-sensitive routine reached by the cutover/readback/start kernels.
begin;

alter table public.admin_runtime_authority_receipts_v2
  drop constraint if exists admin_runtime_authority_manifest_shape_v3;
alter table public.admin_runtime_authority_receipts_v2
  drop constraint if exists admin_runtime_authority_manifest_shape_v4;
alter table public.admin_runtime_authority_receipts_v2
  add constraint admin_runtime_authority_manifest_shape_v4 check (
    (authority_manifest ->> 'schemaVersion' = 'admin_runtime_authority_manifest_v2'
      and jsonb_typeof(authority_manifest -> 'routines') = 'array'
      and jsonb_array_length(authority_manifest -> 'routines') = 7)
    or
    (authority_manifest ->> 'schemaVersion' = 'admin_runtime_authority_manifest_v3'
      and jsonb_typeof(authority_manifest -> 'expectedRoutines') = 'array'
      and jsonb_typeof(authority_manifest -> 'observedRoutines') = 'array'
      and jsonb_typeof(authority_manifest -> 'routines') = 'array'
      and jsonb_array_length(authority_manifest -> 'expectedRoutines') = 9
      and jsonb_array_length(authority_manifest -> 'expectedRoutines') =
          jsonb_array_length(authority_manifest -> 'observedRoutines')
      and authority_manifest -> 'routines' =
          authority_manifest -> 'expectedRoutines'
      and authority_manifest -> 'routines' =
          authority_manifest -> 'observedRoutines'
      and authority_manifest ->> 'readbackAuthority' =
        'public.record_admin_runtime_readback_v2(uuid,uuid,bigint,text,uuid,uuid[],text,text,text)')
    or
    (authority_manifest ->> 'schemaVersion' = 'admin_runtime_authority_manifest_v4'
      and jsonb_typeof(authority_manifest -> 'expectedRoutines') = 'array'
      and jsonb_typeof(authority_manifest -> 'observedRoutines') = 'array'
      and jsonb_typeof(authority_manifest -> 'routines') = 'array'
      and jsonb_array_length(authority_manifest -> 'expectedRoutines') = 18
      and authority_manifest -> 'expectedRoutines' = authority_manifest -> 'observedRoutines'
      and authority_manifest -> 'routines' = authority_manifest -> 'observedRoutines'
      and authority_manifest ->> 'readbackAuthority' =
        'public.record_admin_runtime_readback_v2(uuid,uuid,bigint,text,uuid,uuid[],text,text,text)'
      and jsonb_typeof(authority_manifest -> 'callGraph') = 'object')
  );

do $$
declare
  spec record;
  proc oid;
begin
  for spec in select * from (values
    ('public.record_admin_runtime_readback_v1(uuid,uuid,uuid[],text,text,text)','legacy',false,false,false,false),
    ('public.admin_cutover_authority_legacy_internal_v1(uuid,uuid[],bigint,bigint,text)','legacy',false,false,false,false),
    ('public.start_ai_polish_provider_attempt_internal(uuid,integer)','legacy',false,false,false,false),
    ('public.admin_assert_policy_validation_reports_legacy_internal_v1(uuid,uuid[],timestamptz)','legacy',false,false,false,false),
    ('public.admin_policy_effective_routes_v1(uuid)','legacy',false,false,false,false),
    ('public.admin_assert_policy_validation_reports_v1(uuid,uuid[],timestamptz)','legacy',false,false,false,false),
    ('public.admin_assert_policy_validation_reports_v2(uuid,uuid[],timestamptz)','successor',false,false,false,false),
    ('public.current_ai_terms_version()','legacy',false,false,true,true),
    ('public.ai_endpoint_shape_v2(text)','legacy',false,false,false,false)
  ) s(signature,kind,public_execute,anon_execute,authenticated_execute,service_role_execute)
  loop
    proc := to_regprocedure(spec.signature);
    if proc is null then raise exception 'CUTOVER_SCHEMA_MISMATCH: %', spec.signature; end if;
    insert into public.admin_runtime_authority_expected_v2(
      signature,kind,definition_sha256,public_execute,anon_execute,
      authenticated_execute,service_role_execute,recorded_by
    ) values (
      spec.signature,spec.kind,
      encode(extensions.digest(replace(replace(pg_catalog.pg_get_functiondef(proc),chr(13)||chr(10),chr(10)),chr(13),chr(10)),'sha256'),'hex'),
      spec.public_execute,spec.anon_execute,spec.authenticated_execute,
      spec.service_role_execute,'20260904024000'
    ) on conflict (signature) do update set
      kind=excluded.kind, definition_sha256=excluded.definition_sha256,
      public_execute=excluded.public_execute, anon_execute=excluded.anon_execute,
      authenticated_execute=excluded.authenticated_execute,
      service_role_execute=excluded.service_role_execute,
      recorded_by=excluded.recorded_by;
  end loop;
end;
$$;

-- The v3 cutover implementation already compares expected and observed rows
-- atomically. Retain its body and promote only the manifest schema and add the
-- call graph, so all existing signatures and grants remain unchanged.
do $$
declare
  body text;
begin
  body := pg_catalog.pg_get_functiondef(
    'public.admin_cutover_authority_v2(uuid,uuid,uuid[],bigint,bigint,text)'::regprocedure
  );
  if position('''admin_runtime_authority_manifest_v4''' in body) = 0 then
    body := replace(body, '''admin_runtime_authority_manifest_v3''',
                    '''admin_runtime_authority_manifest_v4''');
  end if;
  if position('''callGraph''' in body) = 0 then
    body := replace(body, '''routines'',v_observed,',
                    '''routines'',v_observed,''callGraph'',jsonb_build_object(
                    ''recordAdminRuntimeReadbackV1'',''public.record_admin_runtime_readback_v1(uuid,uuid,uuid[],text,text,text)'',
                    ''adminCutoverAuthorityLegacyInternalV1'',''public.admin_cutover_authority_legacy_internal_v1(uuid,uuid[],bigint,bigint,text)'',
                    ''startProviderAttemptInternal'',''public.start_ai_polish_provider_attempt_internal(uuid,integer)'',
                    ''effectiveRoutes'',''public.admin_policy_effective_routes_v1(uuid)'',
                    ''policyValidationReportsV1'',''public.admin_assert_policy_validation_reports_v1(uuid,uuid[],timestamptz)'',
                    ''policyValidationReportsV2'',''public.admin_assert_policy_validation_reports_v2(uuid,uuid[],timestamptz)'',
                    ''policyValidationReportsLegacyInternal'',''public.admin_assert_policy_validation_reports_legacy_internal_v1(uuid,uuid[],timestamptz)'',
                    ''currentTermsVersion'',''public.current_ai_terms_version()'',
                    ''endpointShape'',''public.ai_endpoint_shape_v2(text)''),');
  end if;
  if position('''admin_runtime_authority_manifest_v4''' in body) = 0
     or position('''callGraph''' in body) = 0 then
    raise exception 'CUTOVER_SCHEMA_MISMATCH: v4 manifest rewrite failed';
  end if;
  execute body;
end;
$$;

commit;
