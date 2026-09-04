-- Bind runtime readback and the JWT authority cutover to one durable
-- admission receipt and one introspected runtime-function authority manifest.
begin;

create table public.admin_runtime_authority_receipts_v2 (
  receipt_id uuid primary key default extensions.gen_random_uuid(),
  environment text not null check (environment in ('local','preview','production')),
  project_ref text not null check (project_ref ~ '^[a-z0-9-]{1,100}$'),
  reviewed_deployment_id uuid not null,
  admission_id uuid not null,
  admission_revision bigint not null check (admission_revision > 0),
  target_set_sha256 text not null check (target_set_sha256 ~ '^[0-9a-f]{64}$'),
  authority_manifest jsonb not null,
  authority_manifest_sha256 text not null
    check (authority_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  unique (environment, project_ref, admission_revision),
  unique (admission_id),
  foreign key (admission_id, admission_revision, target_set_sha256)
    references public.admin_admitted_runtime_deployments_v2(
      admission_id, admission_revision, target_set_sha256
    ) on delete restrict,
  foreign key (reviewed_deployment_id)
    references public.admin_reviewed_deployments_v1(id) on delete restrict,
  constraint admin_runtime_authority_manifest_shape_v2 check (
    authority_manifest ->> 'schemaVersion' = 'admin_runtime_authority_manifest_v2'
    and jsonb_typeof(authority_manifest -> 'routines') = 'array'
    and jsonb_array_length(authority_manifest -> 'routines') = 7
  )
);

alter table public.admin_runtime_authority_receipts_v2 enable row level security;
revoke all on public.admin_runtime_authority_receipts_v2
  from public, anon, authenticated, service_role;

create function public.admin_guard_runtime_authority_receipt_v2()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Runtime authority receipts are append-only'
    using errcode = '23514';
end;
$$;
create trigger admin_runtime_authority_receipt_guard_v2
before update or delete on public.admin_runtime_authority_receipts_v2
for each row execute function public.admin_guard_runtime_authority_receipt_v2();

create function public.record_admin_runtime_readback_v2(
  p_reviewed_deployment_id uuid,
  p_admission_id uuid,
  p_admission_revision bigint,
  p_target_set_sha256 text,
  p_policy_version_id uuid,
  p_validation_report_ids uuid[],
  p_observed_runtime_build_id text,
  p_observed_binding_manifest_revision text,
  p_observed_binding_manifest_sha256 text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb;
  v_readback public.admin_runtime_readback_reports_v1%rowtype;
  v_admission public.admin_admitted_runtime_deployments_v2%rowtype;
  v_admission_report_ids uuid[];
  v_readback_report_ids uuid[];
  v_target_count integer;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_admission
  from public.admin_admitted_runtime_deployments_v2
  where admission_id = p_admission_id
    and reviewed_deployment_id = p_reviewed_deployment_id
    and admission_revision = p_admission_revision
    and target_set_sha256 = p_target_set_sha256
    and runtime_build_id = p_observed_runtime_build_id
    and binding_manifest_revision = p_observed_binding_manifest_revision
    and binding_manifest_sha256 = p_observed_binding_manifest_sha256
    and sealed_at is not null and revoked_at is null
  for share;
  if not found then
    raise exception 'READBACK_ADMISSION_REQUIRED' using errcode = '23514';
  end if;
  v_result := public.record_admin_runtime_readback_v1(
    p_reviewed_deployment_id, p_policy_version_id, p_validation_report_ids,
    p_observed_runtime_build_id, p_observed_binding_manifest_revision,
    p_observed_binding_manifest_sha256
  );
  select * into v_readback
  from public.admin_runtime_readback_reports_v1
  where id = (v_result ->> 'reportId')::uuid for share;
  select array_agg(validation_report_id order by validation_report_id),
         count(*)::integer
    into v_admission_report_ids, v_target_count
  from public.admin_admitted_runtime_targets_v2
  where admission_id = v_admission.admission_id;
  select array_agg(id order by id) into v_readback_report_ids
  from unnest(v_readback.validation_report_ids) selected(id);
  if v_readback.id is null
     or (v_readback.admission_id, v_readback.admission_revision,
         v_readback.target_set_sha256)
       is distinct from
       (v_admission.admission_id, v_admission.admission_revision,
         v_admission.target_set_sha256)
     or v_admission_report_ids is distinct from v_readback_report_ids
     or v_target_count is distinct from v_admission.target_count
     or v_target_count is distinct from jsonb_array_length(v_readback.effective_routes)
     or exists (
       select 1 from public.admin_admitted_runtime_targets_v2 target
       where target.admission_id = v_admission.admission_id
         and not exists (
           select 1 from jsonb_array_elements(v_readback.effective_routes) route(value)
           where route.value ->> 'runtimeTargetId' = target.runtime_target_id
             and route.value ->> 'runtimeTargetSha256' = target.runtime_target_sha256
             and route.value ->> 'profileVersionId' = target.profile_version_id::text
             and route.value ->> 'priceVersionId' = target.price_version_id::text
         )
     ) then
    raise exception 'READBACK_ADMISSION_MISMATCH' using errcode = '23514';
  end if;
  return v_result;
end;
$$;

create or replace function public.admin_cutover_authority_v2(
  p_reviewed_deployment_id uuid,
  p_admission_id uuid,
  p_validation_report_ids uuid[],
  p_expected_environment_revision bigint,
  p_expected_control_revision bigint,
  p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb;
  v_admission public.admin_admitted_runtime_deployments_v2%rowtype;
  v_policy public.ai_routing_policy_versions%rowtype;
  v_routes jsonb;
  v_route_count integer;
  v_admission_report_ids uuid[];
  v_selected_report_ids uuid[];
  v_routines jsonb;
  v_manifest jsonb;
  v_manifest_sha256 text;
  v_receipt_id uuid;
begin
  if session_user not in ('postgres','supabase_admin') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if to_regprocedure('public.start_ai_polish_provider_attempt_v3(uuid,integer,uuid,uuid,uuid,text,text,text,text,text,bigint,text,text,text,text)') is null
     or to_regprocedure('public.get_ai_polish_execution_snapshot_v4(uuid,uuid,text,text,text,text,text)') is null
     or to_regprocedure('public.record_admin_runtime_readback_v2(uuid,uuid,bigint,text,uuid,uuid[],text,text,text)') is null
     or to_regprocedure('public.admin_admit_runtime_deployment_v2(uuid,jsonb,text)') is null
     or to_regprocedure('public.admin_revoke_runtime_deployment_v2(uuid,bigint,text,text)') is null then
    raise exception 'CUTOVER_SCHEMA_MISMATCH' using errcode = '23514';
  end if;
  select * into v_admission from public.admin_admitted_runtime_deployments_v2
  where admission_id = p_admission_id
    and reviewed_deployment_id = p_reviewed_deployment_id
    and sealed_at is not null and revoked_at is null for share;
  if not found then
    raise exception 'CUTOVER_ADMISSION_REQUIRED' using errcode = '23514';
  end if;
  select array_agg(validation_report_id order by validation_report_id)
    into v_admission_report_ids
  from public.admin_admitted_runtime_targets_v2
  where admission_id = v_admission.admission_id;
  select array_agg(id order by id) into v_selected_report_ids
  from unnest(p_validation_report_ids) selected(id);
  if v_admission_report_ids is distinct from v_selected_report_ids then
    raise exception 'CUTOVER_ADMISSION_MISMATCH' using errcode = '23514';
  end if;
  v_result := public.admin_cutover_authority_legacy_internal_v1(
    p_reviewed_deployment_id,p_validation_report_ids,
    p_expected_environment_revision,p_expected_control_revision,p_reason
  );
  select * into v_policy from public.ai_routing_policy_versions
  where id = (v_result ->> 'activePolicyVersionId')::uuid for share;
  v_routes := public.admin_policy_effective_routes_v1(v_policy.id);
  select count(*)::integer into v_route_count
  from jsonb_array_elements(v_routes) route(value)
  where exists (
    select 1 from public.admin_admitted_runtime_targets_v2 target
    where target.admission_id = v_admission.admission_id
      and target.runtime_contract_id = v_policy.runtime_contract_id
      and target.runtime_target_id = route.value ->> 'runtimeTargetId'
      and target.runtime_target_sha256 = route.value ->> 'runtimeTargetSha256'
      and target.profile_version_id::text = route.value ->> 'profileVersionId'
      and target.price_version_id::text = route.value ->> 'priceVersionId'
  );
  if v_route_count is distinct from jsonb_array_length(v_routes)
     or v_route_count is distinct from v_admission.target_count then
    raise exception 'CUTOVER_ADMISSION_MISMATCH' using errcode = '23514';
  end if;

  revoke all on function public.start_ai_polish_provider_attempt(uuid,integer)
    from public, anon, authenticated, service_role;
  revoke all on function public.start_ai_polish_provider_attempt_v2(uuid,integer,text,text)
    from public, anon, authenticated, service_role;
  revoke all on function public.get_ai_polish_execution_snapshot_v1(uuid,uuid)
    from public, anon, authenticated, service_role;
  revoke all on function public.get_ai_polish_execution_snapshot_v2(uuid,uuid)
    from public, anon, authenticated, service_role;
  revoke all on function public.get_ai_polish_execution_snapshot_v3(uuid,uuid)
    from public, anon, authenticated, service_role;
  revoke all on function public.record_admin_runtime_readback_v1(
    uuid,uuid,uuid[],text,text,text
  ) from public, anon, authenticated, service_role;

  select jsonb_agg(jsonb_build_object(
      'signature',spec.signature,
      'kind',spec.kind,
      'definitionSha256',encode(extensions.digest(
        replace(replace(pg_catalog.pg_get_functiondef(procedure.oid),
          chr(13) || chr(10), chr(10)), chr(13), chr(10)), 'sha256'
      ),'hex'),
      'publicExecute',exists (
        select 1 from pg_catalog.aclexplode(coalesce(
          procedure.proacl, pg_catalog.acldefault('f',procedure.proowner)
        )) acl where acl.grantee=0 and acl.privilege_type='EXECUTE'
      ),
      'anonExecute',pg_catalog.has_function_privilege('anon',procedure.oid,'EXECUTE'),
      'authenticatedExecute',pg_catalog.has_function_privilege('authenticated',procedure.oid,'EXECUTE'),
      'serviceRoleExecute',pg_catalog.has_function_privilege('service_role',procedure.oid,'EXECUTE')
    ) order by spec.signature) into v_routines
  from (values
    ('public.get_ai_polish_execution_snapshot_v1(uuid,uuid)','legacy'),
    ('public.get_ai_polish_execution_snapshot_v2(uuid,uuid)','legacy'),
    ('public.get_ai_polish_execution_snapshot_v3(uuid,uuid)','legacy'),
    ('public.get_ai_polish_execution_snapshot_v4(uuid,uuid,text,text,text,text,text)','successor'),
    ('public.start_ai_polish_provider_attempt(uuid,integer)','legacy'),
    ('public.start_ai_polish_provider_attempt_v2(uuid,integer,text,text)','legacy'),
    ('public.start_ai_polish_provider_attempt_v3(uuid,integer,uuid,uuid,uuid,text,text,text,text,text,bigint,text,text,text,text)','successor')
  ) spec(signature,kind)
  join pg_catalog.pg_proc procedure
    on procedure.oid=pg_catalog.to_regprocedure(spec.signature);
  if jsonb_array_length(v_routines) is distinct from 7
     or exists (
       select 1 from jsonb_array_elements(v_routines) routine(value)
       where routine.value ->> 'publicExecute' <> 'false'
          or routine.value ->> 'anonExecute' <> 'false'
          or routine.value ->> 'authenticatedExecute' <> 'false'
          or (routine.value ->> 'serviceRoleExecute')::boolean
             is distinct from (routine.value ->> 'kind' = 'successor')
     ) then
    raise exception 'CUTOVER_AUTHORITY_MISMATCH' using errcode = '23514';
  end if;
  v_manifest := jsonb_build_object(
    'schemaVersion','admin_runtime_authority_manifest_v2',
    'admissionSchemaVersion','runtime_deployment_admission_v2',
    'reviewedDeploymentId',v_admission.reviewed_deployment_id,
    'admissionId',v_admission.admission_id,
    'admissionRevision',v_admission.admission_revision::text,
    'targetSetSha256',v_admission.target_set_sha256,
    'bindingManifestRevision',v_admission.binding_manifest_revision,
    'bindingManifestSha256',v_admission.binding_manifest_sha256,
    'routines',v_routines
  );
  v_manifest_sha256 := encode(extensions.digest(
    convert_to(v_manifest::text,'UTF8'),'sha256'
  ),'hex');
  insert into public.admin_runtime_authority_receipts_v2(
    environment,project_ref,reviewed_deployment_id,admission_id,
    admission_revision,target_set_sha256,authority_manifest,
    authority_manifest_sha256
  ) values (
    v_admission.environment,v_admission.project_ref,
    v_admission.reviewed_deployment_id,v_admission.admission_id,
    v_admission.admission_revision,v_admission.target_set_sha256,
    v_manifest,v_manifest_sha256
  ) returning receipt_id into v_receipt_id;
  return v_result || jsonb_build_object(
    'schemaVersion','admin_authority_cutover_v2',
    'admissionId',v_admission.admission_id,
    'admissionRevision',v_admission.admission_revision::text,
    'targetSetSha256',v_admission.target_set_sha256,
    'authorityReceiptId',v_receipt_id,
    'authorityManifestSha256',v_manifest_sha256
  );
end;
$$;

revoke all on function public.admin_guard_runtime_authority_receipt_v2(),
  public.record_admin_runtime_readback_v2(
    uuid,uuid,bigint,text,uuid,uuid[],text,text,text
  ), public.admin_cutover_authority_v2(
    uuid,uuid,uuid[],bigint,bigint,text
  ) from public, anon, authenticated, service_role;
grant execute on function public.record_admin_runtime_readback_v2(
  uuid,uuid,bigint,text,uuid,uuid[],text,text,text
) to service_role;

commit;
