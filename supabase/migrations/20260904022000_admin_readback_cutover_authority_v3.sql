-- Successor for the B3/B4 authority defects.
-- Fresh validation reports are provenance for a new readback, while the
-- admitted target tuple is the authority being compared.
begin;

create table public.admin_runtime_authority_expected_v2 (
  signature text primary key,
  kind text not null check (kind in ('legacy','successor')),
  definition_sha256 text not null check (definition_sha256 ~ '^[0-9a-f]{64}$'),
  public_execute boolean not null,
  anon_execute boolean not null,
  authenticated_execute boolean not null,
  service_role_execute boolean not null,
  recorded_by text not null default '20260904022000'
);
alter table public.admin_runtime_authority_expected_v2 enable row level security;
revoke all on public.admin_runtime_authority_expected_v2 from public, anon, authenticated, service_role;

-- Preserve every existing v2 receipt while admitting the successor manifest
-- shape.  The old v2 shape remains strict (exactly seven routines).
alter table public.admin_runtime_authority_receipts_v2
  drop constraint if exists admin_runtime_authority_manifest_shape_v2;
alter table public.admin_runtime_authority_receipts_v2
  add constraint admin_runtime_authority_manifest_shape_v3 check (
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
  );

-- This is the migration-owned baseline.  It is captured before cutover and is
-- therefore stable across later catalog tampering and grant changes.
do $$
declare
  spec record;
  proc oid;
begin
  for spec in
    select * from (values
      ('public.get_ai_polish_execution_snapshot_v1(uuid,uuid)','legacy'),
      ('public.get_ai_polish_execution_snapshot_v2(uuid,uuid)','legacy'),
      ('public.get_ai_polish_execution_snapshot_v3(uuid,uuid)','legacy'),
      ('public.get_ai_polish_execution_snapshot_v4(uuid,uuid,text,text,text,text,text)','successor'),
      ('public.start_ai_polish_provider_attempt(uuid,integer)','legacy'),
      ('public.start_ai_polish_provider_attempt_v2(uuid,integer,text,text)','legacy'),
      ('public.start_ai_polish_provider_attempt_v3(uuid,integer,uuid,uuid,uuid,text,text,text,text,text,bigint,text,text,text,text)','legacy'),
      ('public.start_ai_polish_provider_attempt_v4(uuid,integer,jsonb)','successor'),
      ('public.record_admin_runtime_readback_v2(uuid,uuid,bigint,text,uuid,uuid[],text,text,text)','successor')
    ) s(signature,kind)
  loop
    proc := to_regprocedure(spec.signature);
    if proc is null then raise exception 'CUTOVER_SCHEMA_MISMATCH'; end if;
    insert into public.admin_runtime_authority_expected_v2(
      signature,kind,definition_sha256,public_execute,anon_execute,
      authenticated_execute,service_role_execute
    ) values (
      spec.signature,spec.kind,
      encode(extensions.digest(replace(replace(pg_catalog.pg_get_functiondef(proc),chr(13)||chr(10),chr(10)),chr(13),chr(10)),'sha256'),'hex'),
      false,
      false,
      false,
      spec.kind = 'successor'
    );
  end loop;
end;
$$;

create or replace function public.record_admin_runtime_readback_v2(
  p_reviewed_deployment_id uuid, p_admission_id uuid,
  p_admission_revision bigint, p_target_set_sha256 text,
  p_policy_version_id uuid, p_validation_report_ids uuid[],
  p_observed_runtime_build_id text, p_observed_binding_manifest_revision text,
  p_observed_binding_manifest_sha256 text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb;
  v_readback public.admin_runtime_readback_reports_v1%rowtype;
  v_admission public.admin_admitted_runtime_deployments_v2%rowtype;
  v_policy public.ai_routing_policy_versions%rowtype;
  v_target_count integer;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_admission
  from public.admin_admitted_runtime_deployments_v2
  where admission_id=p_admission_id and reviewed_deployment_id=p_reviewed_deployment_id
    and admission_revision=p_admission_revision and target_set_sha256=p_target_set_sha256
    and runtime_build_id=p_observed_runtime_build_id
    and binding_manifest_revision=p_observed_binding_manifest_revision
    and binding_manifest_sha256=p_observed_binding_manifest_sha256
    and sealed_at is not null and revoked_at is null for share;
  if not found then raise exception 'READBACK_ADMISSION_REQUIRED' using errcode='23514'; end if;

  -- v1 performs the current policy/deployment/report validity checks and
  -- stores the fresh report UUIDs.  Those UUIDs are deliberately not compared
  -- with admission provenance UUIDs below.
  v_result := public.record_admin_runtime_readback_v1(
    p_reviewed_deployment_id,p_policy_version_id,p_validation_report_ids,
    p_observed_runtime_build_id,p_observed_binding_manifest_revision,
    p_observed_binding_manifest_sha256);
  select * into v_readback from public.admin_runtime_readback_reports_v1
    where id=(v_result->>'reportId')::uuid for share;
  select * into v_policy from public.ai_routing_policy_versions
    where id=v_readback.policy_version_id for share;

  select count(*)::integer into v_target_count
    from public.admin_admitted_runtime_targets_v2 where admission_id=v_admission.admission_id;
  if v_readback.id is null or v_policy.id is null
     or (v_readback.admission_id,v_readback.admission_revision,v_readback.target_set_sha256)
        is distinct from (v_admission.admission_id,v_admission.admission_revision,v_admission.target_set_sha256)
     or v_target_count is distinct from v_admission.target_count
     or v_target_count is distinct from jsonb_array_length(v_readback.effective_routes)
     or exists (
       select 1 from public.admin_admitted_runtime_targets_v2 target
       where target.admission_id=v_admission.admission_id
         and not exists (
           select 1 from jsonb_array_elements(v_readback.effective_routes) route(value)
           where target.runtime_contract_id=v_policy.runtime_contract_id
             and (route.value->>'runtimeTargetId')=target.runtime_target_id
             and (route.value->>'runtimeTargetSha256')=target.runtime_target_sha256
             and (route.value->>'profileVersionId')=target.profile_version_id::text
             and (route.value->>'priceVersionId')=target.price_version_id::text
             and (route.value->>'providerId')=target.provider_id::text
             and target.legal_bundle_version=v_readback.legal_bundle_version
             and (route.value->>'legalManifestId')=target.legal_manifest_id
             and (route.value->>'displayDisclosureKey')=target.display_disclosure_key
             and (route.value->>'codeCapabilityId')=target.code_capability_id
             and (route.value->>'codeCapabilitySha256')=target.code_capability_sha256
         )
     )
     or exists (
       select 1 from jsonb_array_elements(v_readback.effective_routes) route(value)
       where not exists (select 1 from public.admin_admitted_runtime_targets_v2 target
         where target.admission_id=v_admission.admission_id
           and target.runtime_target_id=route.value->>'runtimeTargetId'
           and target.runtime_target_sha256=route.value->>'runtimeTargetSha256')
     ) then
    raise exception 'READBACK_ADMISSION_MISMATCH' using errcode='23514';
  end if;
  return v_result;
end;
$$;

update public.admin_runtime_authority_expected_v2
set definition_sha256 = encode(extensions.digest(
      replace(replace(pg_catalog.pg_get_functiondef(
        'public.record_admin_runtime_readback_v2(uuid,uuid,bigint,text,uuid,uuid[],text,text,text)'::regprocedure),
        chr(13) || chr(10), chr(10)), chr(13), chr(10)), 'sha256'), 'hex')
where signature = 'public.record_admin_runtime_readback_v2(uuid,uuid,bigint,text,uuid,uuid[],text,text,text)';

create or replace function public.admin_cutover_authority_v2(
  p_reviewed_deployment_id uuid, p_admission_id uuid,
  p_validation_report_ids uuid[], p_expected_environment_revision bigint,
  p_expected_control_revision bigint, p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb; v_admission public.admin_admitted_runtime_deployments_v2%rowtype;
  v_policy public.ai_routing_policy_versions%rowtype; v_routes jsonb;
  v_route_count integer;
  v_expected jsonb; v_observed jsonb; v_manifest jsonb;
  v_manifest_sha256 text; v_receipt_id uuid;
begin
  if session_user not in ('postgres','supabase_admin') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into v_admission from public.admin_admitted_runtime_deployments_v2
    where admission_id=p_admission_id and reviewed_deployment_id=p_reviewed_deployment_id
      and sealed_at is not null and revoked_at is null for share;
  if not found then raise exception 'CUTOVER_ADMISSION_REQUIRED' using errcode='23514'; end if;
  v_result := public.admin_cutover_authority_legacy_internal_v1(
    p_reviewed_deployment_id,p_validation_report_ids,
    p_expected_environment_revision,p_expected_control_revision,p_reason);

  -- A fresh report set may replace the admission's expired provenance, but
  -- it must still describe exactly the same sealed runtime target set.
  select * into v_policy from public.ai_routing_policy_versions
    where id=(v_result->>'activePolicyVersionId')::uuid for share;
  v_routes := public.admin_policy_effective_routes_v1(v_policy.id);
  select count(*)::integer into v_route_count
  from jsonb_array_elements(v_routes) route(value)
  where exists (
    select 1 from public.admin_admitted_runtime_targets_v2 target
    where target.admission_id=v_admission.admission_id
      and target.runtime_contract_id=v_policy.runtime_contract_id
      and target.runtime_target_id=route.value->>'runtimeTargetId'
      and target.runtime_target_sha256=route.value->>'runtimeTargetSha256'
      and target.profile_version_id::text=route.value->>'profileVersionId'
      and target.price_version_id::text=route.value->>'priceVersionId'
      and target.provider_id::text=route.value->>'providerId'
      and target.code_capability_id=route.value->>'codeCapabilityId'
      and target.code_capability_sha256=route.value->>'codeCapabilitySha256'
      and target.legal_bundle_version=v_policy.legal_bundle_version
      and target.legal_manifest_id=route.value->>'legalManifestId'
      and target.display_disclosure_key=route.value->>'displayDisclosureKey'
  );
  if v_policy.id is null
     or v_route_count is distinct from jsonb_array_length(v_routes)
     or v_route_count is distinct from v_admission.target_count then
    raise exception 'CUTOVER_ADMISSION_MISMATCH' using errcode='23514';
  end if;

  revoke all on function public.start_ai_polish_provider_attempt(uuid,integer)
    from public, anon, authenticated, service_role;
  revoke all on function public.start_ai_polish_provider_attempt_v2(
    uuid,integer,text,text
  ) from public, anon, authenticated, service_role;
  revoke all on function public.start_ai_polish_provider_attempt_v3(
    uuid,integer,uuid,uuid,uuid,text,text,text,text,text,bigint,text,text,text,text
  ) from public, anon, authenticated, service_role;
  revoke all on function public.get_ai_polish_execution_snapshot_v1(uuid,uuid)
    from public, anon, authenticated, service_role;
  revoke all on function public.get_ai_polish_execution_snapshot_v2(uuid,uuid)
    from public, anon, authenticated, service_role;
  revoke all on function public.get_ai_polish_execution_snapshot_v3(uuid,uuid)
    from public, anon, authenticated, service_role;
  revoke all on function public.record_admin_runtime_readback_v1(
    uuid,uuid,uuid[],text,text,text
  ) from public, anon, authenticated, service_role;

  select jsonb_agg(jsonb_build_object('signature',e.signature,'kind',e.kind,
      'definitionSha256',e.definition_sha256,'publicExecute',e.public_execute,
      'anonExecute',e.anon_execute,'authenticatedExecute',e.authenticated_execute,
      'serviceRoleExecute',e.service_role_execute) order by e.signature)
    into v_expected from public.admin_runtime_authority_expected_v2 e;
  select jsonb_agg(jsonb_build_object('signature',e.signature,'kind',e.kind,
      'definitionSha256',case when to_regprocedure(e.signature) is null then null else encode(extensions.digest(replace(replace(pg_get_functiondef(to_regprocedure(e.signature)),chr(13)||chr(10),chr(10)),chr(13),chr(10)),'sha256'),'hex') end,
      'publicExecute',case when to_regprocedure(e.signature) is null then null else exists (
        select 1 from pg_catalog.pg_proc procedure,
          lateral pg_catalog.aclexplode(coalesce(
            procedure.proacl,
            pg_catalog.acldefault('f',procedure.proowner)
          )) acl
        where procedure.oid=to_regprocedure(e.signature)
          and acl.grantee=0 and acl.privilege_type='EXECUTE'
      ) end,
      'anonExecute',case when to_regprocedure(e.signature) is null then null else has_function_privilege('anon',to_regprocedure(e.signature),'EXECUTE') end,
      'authenticatedExecute',case when to_regprocedure(e.signature) is null then null else has_function_privilege('authenticated',to_regprocedure(e.signature),'EXECUTE') end,
      'serviceRoleExecute',case when to_regprocedure(e.signature) is null then null else has_function_privilege('service_role',to_regprocedure(e.signature),'EXECUTE') end) order by e.signature)
    into v_observed from public.admin_runtime_authority_expected_v2 e;
  if v_expected is distinct from v_observed then raise exception 'CUTOVER_AUTHORITY_MISMATCH' using errcode='23514'; end if;
  v_manifest := jsonb_build_object('schemaVersion','admin_runtime_authority_manifest_v3',
    'admissionSchemaVersion','runtime_deployment_admission_v2',
    'reviewedDeploymentId',v_admission.reviewed_deployment_id,'admissionId',v_admission.admission_id,
    'admissionRevision',v_admission.admission_revision::text,'targetSetSha256',v_admission.target_set_sha256,
    'bindingManifestRevision',v_admission.binding_manifest_revision,'bindingManifestSha256',v_admission.binding_manifest_sha256,
    'expectedRoutines',v_expected,'observedRoutines',v_observed,
    'routines',v_observed,
    'readbackAuthority','public.record_admin_runtime_readback_v2(uuid,uuid,bigint,text,uuid,uuid[],text,text,text)');
  v_manifest_sha256 := encode(extensions.digest(convert_to(v_manifest::text,'UTF8'),'sha256'),'hex');
  insert into public.admin_runtime_authority_receipts_v2(environment,project_ref,reviewed_deployment_id,admission_id,admission_revision,target_set_sha256,authority_manifest,authority_manifest_sha256)
    values(v_admission.environment,v_admission.project_ref,v_admission.reviewed_deployment_id,v_admission.admission_id,v_admission.admission_revision,v_admission.target_set_sha256,v_manifest,v_manifest_sha256)
    returning receipt_id into v_receipt_id;
  return v_result || jsonb_build_object('schemaVersion','admin_authority_cutover_v2','authorityReceiptId',v_receipt_id,'authorityManifestSha256',v_manifest_sha256,'readbackAuthority',v_manifest->>'readbackAuthority');
end;
$$;

revoke all on function public.record_admin_runtime_readback_v2(uuid,uuid,bigint,text,uuid,uuid[],text,text,text), public.admin_cutover_authority_v2(uuid,uuid,uuid[],bigint,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.record_admin_runtime_readback_v2(uuid,uuid,bigint,text,uuid,uuid[],text,text,text) to service_role;
commit;
