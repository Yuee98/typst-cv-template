-- ADM-I06 successor: a sealed deployment admission is the durable authority
-- shared by snapshot, attempt start, runtime readback, and reopen.
begin;

-- The ambiguous v1 owner entry point accepted globally bare target IDs and
-- admitted no validation-report identity. Keep its history, but retire it.
revoke all on function public.admin_admit_runtime_deployment_v1(
  uuid,text,text,text,text,text,text[],text
) from public, anon, authenticated, service_role;
revoke all on function public.admin_revoke_runtime_deployment_v1(
  text,text,text,text,bigint,text
) from public, anon, authenticated, service_role;

create table public.admin_admitted_runtime_deployments_v2 (
  admission_id uuid primary key default extensions.gen_random_uuid(),
  reviewed_deployment_id uuid not null,
  environment text not null check (environment in ('local','preview','production')),
  project_ref text not null check (project_ref ~ '^[a-z0-9-]{1,100}$'),
  runtime_build_id text not null
    check (runtime_build_id ~ '^[a-z0-9][a-z0-9._:-]{0,199}$'),
  binding_manifest_revision text not null
    check (binding_manifest_revision ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  binding_manifest_sha256 text not null
    check (binding_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  admission_revision bigint not null check (admission_revision > 0),
  target_count integer,
  target_set_sha256 text,
  admitted_at timestamptz not null default clock_timestamp(),
  sealed_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  unique (environment, project_ref, runtime_build_id, binding_manifest_revision),
  unique (environment, project_ref, admission_revision),
  unique (admission_id, admission_revision, target_set_sha256),
  foreign key (
    reviewed_deployment_id, environment, project_ref, runtime_build_id,
    binding_manifest_revision, binding_manifest_sha256
  ) references public.admin_reviewed_deployments_v1(
    id, environment, project_ref, runtime_build_id,
    binding_manifest_revision, binding_manifest_sha256
  ) on delete restrict,
  constraint admin_runtime_admission_v2_seal_shape check (
    (sealed_at is null and target_count is null and target_set_sha256 is null)
    or (sealed_at is not null and target_count between 1 and 64
      and target_set_sha256 ~ '^[0-9a-f]{64}$')
  ),
  constraint admin_runtime_admission_v2_revoke_shape check (
    (revoked_at is null and revoked_reason is null)
    or (revoked_at is not null and revoked_reason = btrim(revoked_reason)
      and length(revoked_reason) between 1 and 500)
  )
);

create table public.admin_admitted_runtime_targets_v2 (
  admission_id uuid not null references
    public.admin_admitted_runtime_deployments_v2(admission_id) on delete restrict,
  runtime_contract_id text not null,
  runtime_target_id text not null,
  validation_report_id uuid not null
    references public.admin_validation_reports_v1(id) on delete restrict,
  runtime_target_sha256 text not null check (runtime_target_sha256 ~ '^[0-9a-f]{64}$'),
  profile_version_id uuid not null,
  price_version_id uuid not null,
  provider_id uuid not null,
  legal_bundle_version text not null,
  legal_manifest_id text not null,
  display_disclosure_key text not null,
  code_capability_id text not null,
  code_capability_sha256 text not null
    check (code_capability_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (admission_id, runtime_contract_id, runtime_target_id),
  unique (admission_id, validation_report_id),
  foreign key (runtime_contract_id, runtime_target_id)
    references public.ai_runtime_target_bindings_v2(
      runtime_contract_id, runtime_target_id
    ) on delete restrict,
  foreign key (code_capability_id, code_capability_sha256)
    references public.ai_runtime_code_capabilities_v2(
      code_capability_id, descriptor_sha256
    ) on delete restrict
);

alter table public.admin_admitted_runtime_deployments_v2 enable row level security;
alter table public.admin_admitted_runtime_targets_v2 enable row level security;
revoke all on public.admin_admitted_runtime_deployments_v2,
  public.admin_admitted_runtime_targets_v2
  from public, anon, authenticated, service_role;

create function public.admin_runtime_target_set_sha256_v2(p_admission_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select encode(extensions.digest(convert_to(concat_ws(E'\n',
    'admin_runtime_target_set_v2', deployment.reviewed_deployment_id::text,
    deployment.environment, deployment.project_ref, deployment.runtime_build_id,
    deployment.binding_manifest_revision, deployment.binding_manifest_sha256,
    coalesce(string_agg(concat_ws(E'\x1f',
      target.runtime_contract_id, target.runtime_target_id,
      target.validation_report_id::text, target.runtime_target_sha256,
      target.profile_version_id::text, target.price_version_id::text,
      target.provider_id::text, target.legal_bundle_version,
      target.legal_manifest_id, target.display_disclosure_key,
      target.code_capability_id, target.code_capability_sha256
    ), E'\n' order by target.runtime_contract_id, target.runtime_target_id), '')
  ), 'UTF8'), 'sha256'), 'hex')
  from public.admin_admitted_runtime_deployments_v2 deployment
  left join public.admin_admitted_runtime_targets_v2 target
    on target.admission_id = deployment.admission_id
  where deployment.admission_id = p_admission_id
  group by deployment.admission_id;
$$;

create function public.admin_guard_runtime_admission_parent_v2()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Runtime admission v2 cannot be deleted' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.sealed_at is not null or new.revoked_at is not null then
      raise exception 'Runtime admission v2 must be assembled before sealing'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if old.sealed_at is null and new.sealed_at is not null
     and new.revoked_at is null
     and (new.admission_id, new.reviewed_deployment_id, new.environment,
       new.project_ref, new.runtime_build_id, new.binding_manifest_revision,
       new.binding_manifest_sha256, new.admission_revision, new.admitted_at)
       is not distinct from
       (old.admission_id, old.reviewed_deployment_id, old.environment,
       old.project_ref, old.runtime_build_id, old.binding_manifest_revision,
       old.binding_manifest_sha256, old.admission_revision, old.admitted_at) then
    return new;
  end if;
  if old.sealed_at is not null and old.revoked_at is null
     and new.revoked_at is not null
     and (new.admission_id, new.reviewed_deployment_id, new.environment,
       new.project_ref, new.runtime_build_id, new.binding_manifest_revision,
       new.binding_manifest_sha256, new.admission_revision, new.target_count,
       new.target_set_sha256, new.admitted_at, new.sealed_at)
       is not distinct from
       (old.admission_id, old.reviewed_deployment_id, old.environment,
       old.project_ref, old.runtime_build_id, old.binding_manifest_revision,
       old.binding_manifest_sha256, old.admission_revision, old.target_count,
       old.target_set_sha256, old.admitted_at, old.sealed_at) then
    return new;
  end if;
  raise exception 'Runtime admission v2 is immutable after sealing'
    using errcode = '23514';
end;
$$;
create trigger admin_runtime_admission_parent_guard_v2
before insert or update or delete on public.admin_admitted_runtime_deployments_v2
for each row execute function public.admin_guard_runtime_admission_parent_v2();

create function public.admin_validate_runtime_admission_target_v2()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_parent public.admin_admitted_runtime_deployments_v2%rowtype;
  v_binding public.ai_runtime_target_bindings_v2%rowtype;
  v_report public.admin_validation_reports_v1%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Runtime admission v2 targets are immutable'
      using errcode = '23514';
  end if;
  select * into v_parent from public.admin_admitted_runtime_deployments_v2
  where admission_id = new.admission_id for share;
  select * into v_binding from public.ai_runtime_target_bindings_v2
  where runtime_contract_id = new.runtime_contract_id
    and runtime_target_id = new.runtime_target_id for share;
  select * into v_report from public.admin_validation_reports_v1
  where id = new.validation_report_id for share;
  if v_parent.admission_id is null or v_parent.sealed_at is not null
     or v_parent.revoked_at is not null or v_binding.runtime_target_id is null
     or v_report.id is null or not v_report.passed
     or v_report.expires_at <= clock_timestamp()
     or v_report.reviewed_deployment_id is distinct from v_parent.reviewed_deployment_id
     or (v_report.environment, v_report.project_ref, v_report.runtime_build_id,
         v_report.binding_manifest_revision, v_report.binding_manifest_sha256)
       is distinct from
       (v_parent.environment, v_parent.project_ref, v_parent.runtime_build_id,
         v_parent.binding_manifest_revision, v_parent.binding_manifest_sha256)
     or (v_report.runtime_contract_id, v_report.runtime_target_id,
         v_report.runtime_target_sha256, v_report.profile_version_id,
         v_report.price_version_id, v_report.provider_id,
         v_report.legal_bundle_version, v_report.legal_manifest_id,
         v_report.display_disclosure_key, v_report.code_capability_id,
         v_report.code_capability_sha256)
       is distinct from
       (v_binding.runtime_contract_id, v_binding.runtime_target_id,
         v_binding.runtime_target_sha256, v_binding.profile_version_id,
         v_binding.price_version_id, v_binding.provider_id,
         v_binding.legal_bundle_version, v_binding.legal_manifest_id,
         v_binding.display_disclosure_key, v_binding.code_capability_id,
         v_binding.code_capability_sha256)
     or (new.runtime_target_sha256, new.profile_version_id,
         new.price_version_id, new.provider_id, new.legal_bundle_version,
         new.legal_manifest_id, new.display_disclosure_key,
         new.code_capability_id, new.code_capability_sha256)
       is distinct from
       (v_binding.runtime_target_sha256, v_binding.profile_version_id,
         v_binding.price_version_id, v_binding.provider_id,
         v_binding.legal_bundle_version, v_binding.legal_manifest_id,
         v_binding.display_disclosure_key, v_binding.code_capability_id,
         v_binding.code_capability_sha256) then
    raise exception 'Exact passed target validation is required'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger admin_runtime_admission_target_guard_v2
before insert or update or delete on public.admin_admitted_runtime_targets_v2
for each row execute function public.admin_validate_runtime_admission_target_v2();

create function public.admin_assert_runtime_admission_sealed_v2()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_admission_id uuid := case when tg_op = 'DELETE' then old.admission_id else new.admission_id end;
  v_parent public.admin_admitted_runtime_deployments_v2%rowtype;
  v_count integer;
begin
  select * into v_parent from public.admin_admitted_runtime_deployments_v2
  where admission_id = v_admission_id;
  select count(*)::integer into v_count
  from public.admin_admitted_runtime_targets_v2
  where admission_id = v_admission_id;
  if v_parent.admission_id is null or v_parent.sealed_at is null
     or v_parent.target_count is distinct from v_count
     or v_parent.target_set_sha256 is distinct from
       public.admin_runtime_target_set_sha256_v2(v_admission_id) then
    raise exception 'Runtime admission v2 target set is not sealed'
      using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger admin_runtime_admission_parent_seal_v2
after insert or update on public.admin_admitted_runtime_deployments_v2
deferrable initially deferred for each row
execute function public.admin_assert_runtime_admission_sealed_v2();
create constraint trigger admin_runtime_admission_target_seal_v2
after insert on public.admin_admitted_runtime_targets_v2
deferrable initially deferred for each row
execute function public.admin_assert_runtime_admission_sealed_v2();

create function public.admin_admit_runtime_deployment_v2(
  p_reviewed_deployment_id uuid,
  p_targets jsonb,
  p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_environment public.admin_environment%rowtype;
  v_review public.admin_reviewed_deployments_v1%rowtype;
  v_binding public.ai_runtime_target_bindings_v2%rowtype;
  v_report public.admin_validation_reports_v1%rowtype;
  v_admission public.admin_admitted_runtime_deployments_v2%rowtype;
  v_item jsonb;
  v_report_id uuid;
  v_revision bigint;
  v_audit uuid;
begin
  if session_user not in ('postgres','supabase_admin') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_reason is null or p_reason <> btrim(p_reason)
     or length(p_reason) not between 1 and 500
     or jsonb_typeof(p_targets) is distinct from 'array'
     or jsonb_array_length(p_targets) not between 1 and 64
     or exists (
       select 1 from jsonb_array_elements(p_targets) item(value)
       where jsonb_typeof(value) is distinct from 'object'
          or (select count(*) from jsonb_object_keys(value)) <> 3
          or not value ?& array['runtimeContractId','runtimeTargetId','validationReportId']
          or value ->> 'runtimeContractId' !~ '^[a-z0-9][a-z0-9._-]{0,199}$'
          or value ->> 'runtimeTargetId' !~ '^[a-z0-9][a-z0-9._-]{0,199}$'
          or value ->> 'validationReportId'
             !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     )
     or jsonb_array_length(p_targets) is distinct from (
       select count(*) from (
         select value ->> 'runtimeContractId', value ->> 'runtimeTargetId'
         from jsonb_array_elements(p_targets) item(value)
         group by value ->> 'runtimeContractId', value ->> 'runtimeTargetId'
       ) unique_targets
     )
     or jsonb_array_length(p_targets) is distinct from (
       select count(distinct value ->> 'validationReportId')
       from jsonb_array_elements(p_targets) item(value)
     ) then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  select * into v_environment from public.admin_environment
  where id = true for update;
  select * into v_review from public.admin_reviewed_deployments_v1
  where id = p_reviewed_deployment_id for share;
  if v_environment.id is null or v_review.id is null
     or (v_review.environment, v_review.project_ref) is distinct from
       (v_environment.environment, v_environment.project_ref)
     or v_review.valid_until <= clock_timestamp() then
    raise exception 'REVIEWED_DEPLOYMENT_MISMATCH' using errcode = '23514';
  end if;
  select coalesce(max(admission_revision), 0) + 1 into v_revision
  from public.admin_admitted_runtime_deployments_v2
  where environment = v_review.environment and project_ref = v_review.project_ref;
  insert into public.admin_admitted_runtime_deployments_v2(
    reviewed_deployment_id, environment, project_ref, runtime_build_id,
    binding_manifest_revision, binding_manifest_sha256, admission_revision
  ) values (
    v_review.id, v_review.environment, v_review.project_ref,
    v_review.runtime_build_id, v_review.binding_manifest_revision,
    v_review.binding_manifest_sha256, v_revision
  ) returning * into v_admission;
  for v_item in
    select value from jsonb_array_elements(p_targets) item(value)
    order by value ->> 'runtimeContractId', value ->> 'runtimeTargetId'
  loop
    v_report_id := (v_item ->> 'validationReportId')::uuid;
    select * into v_binding from public.ai_runtime_target_bindings_v2
    where runtime_contract_id = v_item ->> 'runtimeContractId'
      and runtime_target_id = v_item ->> 'runtimeTargetId' for share;
    select * into v_report from public.admin_validation_reports_v1
    where id = v_report_id for share;
    if v_binding.runtime_target_id is null or v_report.id is null
       or not v_report.passed or v_report.expires_at <= clock_timestamp()
       or v_report.reviewed_deployment_id is distinct from v_review.id
       or (v_report.environment, v_report.project_ref,
           v_report.runtime_build_id, v_report.binding_manifest_revision,
           v_report.binding_manifest_sha256)
         is distinct from
         (v_review.environment, v_review.project_ref,
           v_review.runtime_build_id, v_review.binding_manifest_revision,
           v_review.binding_manifest_sha256)
       or (v_report.runtime_contract_id, v_report.runtime_target_id,
           v_report.runtime_target_sha256, v_report.profile_version_id,
           v_report.price_version_id, v_report.provider_id,
           v_report.legal_bundle_version, v_report.legal_manifest_id,
           v_report.display_disclosure_key, v_report.code_capability_id,
           v_report.code_capability_sha256)
         is distinct from
         (v_binding.runtime_contract_id, v_binding.runtime_target_id,
           v_binding.runtime_target_sha256, v_binding.profile_version_id,
           v_binding.price_version_id, v_binding.provider_id,
           v_binding.legal_bundle_version, v_binding.legal_manifest_id,
           v_binding.display_disclosure_key, v_binding.code_capability_id,
           v_binding.code_capability_sha256) then
      raise exception 'EXACT_ADMISSION_EVIDENCE_REQUIRED' using errcode = '23514';
    end if;
    insert into public.admin_admitted_runtime_targets_v2(
      admission_id, runtime_contract_id, runtime_target_id,
      validation_report_id, runtime_target_sha256, profile_version_id,
      price_version_id, provider_id, legal_bundle_version,
      legal_manifest_id, display_disclosure_key, code_capability_id,
      code_capability_sha256
    ) values (
      v_admission.admission_id, v_binding.runtime_contract_id,
      v_binding.runtime_target_id, v_report.id, v_binding.runtime_target_sha256,
      v_binding.profile_version_id, v_binding.price_version_id,
      v_binding.provider_id, v_binding.legal_bundle_version,
      v_binding.legal_manifest_id, v_binding.display_disclosure_key,
      v_binding.code_capability_id, v_binding.code_capability_sha256
    );
  end loop;
  update public.admin_admitted_runtime_deployments_v2
  set target_count = jsonb_array_length(p_targets),
      target_set_sha256 = public.admin_runtime_target_set_sha256_v2(v_admission.admission_id),
      sealed_at = clock_timestamp()
  where admission_id = v_admission.admission_id returning * into v_admission;
  insert into public.admin_audit_events(operation, actor, target_id, reason)
  values ('runtime_deployment_admit_v2','db_operator',v_admission.admission_id,p_reason)
  returning id into v_audit;
  return jsonb_build_object(
    'schemaVersion','admin_runtime_admission_result_v2',
    'admissionId',v_admission.admission_id,
    'reviewedDeploymentId',v_admission.reviewed_deployment_id,
    'environment',v_admission.environment,'projectRef',v_admission.project_ref,
    'runtimeBuildId',v_admission.runtime_build_id,
    'bindingManifestRevision',v_admission.binding_manifest_revision,
    'bindingManifestSha256',v_admission.binding_manifest_sha256,
    'admissionRevision',v_admission.admission_revision::text,
    'targetCount',v_admission.target_count,
    'targetSetSha256',v_admission.target_set_sha256,'auditEventId',v_audit
  );
end;
$$;

create function public.admin_revoke_runtime_deployment_v2(
  p_admission_id uuid,
  p_expected_admission_revision bigint,
  p_expected_target_set_sha256 text,
  p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_admission public.admin_admitted_runtime_deployments_v2%rowtype;
  v_audit uuid;
begin
  if session_user not in ('postgres','supabase_admin') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_expected_admission_revision is null or p_expected_admission_revision <= 0
     or p_expected_target_set_sha256 !~ '^[0-9a-f]{64}$'
     or p_reason is null or p_reason <> btrim(p_reason)
     or length(p_reason) not between 1 and 500 then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  select * into v_admission from public.admin_admitted_runtime_deployments_v2
  where admission_id = p_admission_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_admission.revoked_at is not null
     or v_admission.admission_revision is distinct from p_expected_admission_revision
     or v_admission.target_set_sha256 is distinct from p_expected_target_set_sha256 then
    raise exception 'STALE_REVISION' using errcode = '40001';
  end if;
  update public.admin_admitted_runtime_deployments_v2
  set revoked_at = clock_timestamp(), revoked_reason = p_reason
  where admission_id = p_admission_id returning * into v_admission;
  insert into public.admin_audit_events(operation, actor, target_id, reason)
  values ('runtime_deployment_revoke_v2','db_operator',v_admission.admission_id,p_reason)
  returning id into v_audit;
  return jsonb_build_object(
    'schemaVersion','admin_runtime_admission_revoke_result_v2',
    'admissionId',v_admission.admission_id,
    'admissionRevision',v_admission.admission_revision::text,
    'targetSetSha256',v_admission.target_set_sha256,'auditEventId',v_audit
  );
end;
$$;

alter table public.ai_provider_attempt_ledger
  add column runtime_admission_id uuid references
    public.admin_admitted_runtime_deployments_v2(admission_id) on delete restrict,
  add column runtime_admission_revision bigint,
  add column runtime_target_set_sha256 text,
  add column admitted_runtime_target_id text,
  add column admitted_runtime_target_sha256 text,
  add column runtime_validation_report_id uuid references
    public.admin_validation_reports_v1(id) on delete restrict;
alter table public.ai_provider_attempt_ledger
  add constraint ai_attempt_runtime_admission_shape_v2 check (
    (runtime_admission_id is null and runtime_admission_revision is null
      and runtime_target_set_sha256 is null and admitted_runtime_target_id is null
      and admitted_runtime_target_sha256 is null and runtime_validation_report_id is null)
    or (runtime_admission_id is not null and runtime_admission_revision > 0
      and runtime_target_set_sha256 ~ '^[0-9a-f]{64}$'
      and admitted_runtime_target_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
      and admitted_runtime_target_sha256 ~ '^[0-9a-f]{64}$'
      and runtime_validation_report_id is not null)
  );

create function public.guard_ai_attempt_runtime_admission_v2()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (
    new.runtime_admission_id, new.runtime_admission_revision,
    new.runtime_target_set_sha256, new.admitted_runtime_target_id,
    new.admitted_runtime_target_sha256, new.runtime_validation_report_id
  ) is distinct from (
    old.runtime_admission_id, old.runtime_admission_revision,
    old.runtime_target_set_sha256, old.admitted_runtime_target_id,
    old.admitted_runtime_target_sha256, old.runtime_validation_report_id
  ) and not (
    old.runtime_admission_id is null and old.runtime_admission_revision is null
    and old.runtime_target_set_sha256 is null and old.admitted_runtime_target_id is null
    and old.admitted_runtime_target_sha256 is null and old.runtime_validation_report_id is null
    and new.runtime_admission_id is not null and new.runtime_admission_revision is not null
    and new.runtime_target_set_sha256 is not null and new.admitted_runtime_target_id is not null
    and new.admitted_runtime_target_sha256 is not null
    and new.runtime_validation_report_id is not null
    and current_user in ('postgres','supabase_admin')
  ) then
    raise exception 'Attempt runtime admission is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger guard_ai_attempt_runtime_admission_v2
before update on public.ai_provider_attempt_ledger
for each row execute function public.guard_ai_attempt_runtime_admission_v2();

create or replace function public.get_ai_polish_execution_snapshot_v4(
  p_reservation_id uuid, p_user_id uuid, p_environment text, p_project_ref text,
  p_runtime_build_id text, p_binding_manifest_revision text,
  p_binding_manifest_sha256 text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_snapshot jsonb;
  v_evidence jsonb;
  v_admission public.admin_admitted_runtime_deployments_v2%rowtype;
  v_target public.admin_admitted_runtime_targets_v2%rowtype;
begin
  v_snapshot := public.get_ai_polish_execution_snapshot_v2(
    p_reservation_id, p_user_id
  );
  if v_snapshot ->> 'ok' is distinct from 'true'
     or v_snapshot ->> 'schemaVersion' is distinct from
       'ai_polish_execution_snapshot_v2' then
    return v_snapshot;
  end if;
  v_evidence := v_snapshot -> 'runtimeEvidence';
  select * into v_admission from public.admin_admitted_runtime_deployments_v2
  where environment = p_environment and project_ref = p_project_ref
    and runtime_build_id = p_runtime_build_id
    and binding_manifest_revision = p_binding_manifest_revision
    and binding_manifest_sha256 = p_binding_manifest_sha256
    and sealed_at is not null and revoked_at is null for share;
  if not found then
    return jsonb_build_object('schemaVersion','ai_polish_execution_snapshot_v1',
      'ok',false,'reason','SERVICE_UNAVAILABLE');
  end if;
  select * into v_target from public.admin_admitted_runtime_targets_v2
  where admission_id = v_admission.admission_id
    and runtime_contract_id = v_evidence ->> 'runtimeContractId'
    and runtime_target_id = v_evidence ->> 'runtimeTargetId'
    and runtime_target_sha256 = v_evidence ->> 'runtimeTargetSha256'
    and profile_version_id::text = v_evidence ->> 'profileVersionId'
    and price_version_id::text = v_evidence ->> 'priceVersionId'
    and provider_id::text = v_evidence ->> 'providerId'
    and code_capability_id = v_evidence ->> 'codeCapabilityId'
    and code_capability_sha256 = v_evidence ->> 'codeCapabilitySha256'
    and legal_bundle_version = v_evidence ->> 'legalBundleVersion'
    and legal_manifest_id = v_evidence ->> 'legalManifestId'
    and display_disclosure_key = v_evidence ->> 'displayDisclosureKey'
  for share;
  if not found then
    return jsonb_build_object('schemaVersion','ai_polish_execution_snapshot_v1',
      'ok',false,'reason','SERVICE_UNAVAILABLE');
  end if;
  return jsonb_set(v_snapshot,'{deploymentValidation}',jsonb_build_object(
    'schemaVersion','runtime_deployment_admission_v2',
    'admissionId',v_admission.admission_id,
    'reviewedDeploymentId',v_admission.reviewed_deployment_id,
    'validationReportId',v_target.validation_report_id,
    'environment',v_admission.environment,'projectRef',v_admission.project_ref,
    'runtimeBuildId',v_admission.runtime_build_id,
    'bindingManifestRevision',v_admission.binding_manifest_revision,
    'bindingManifestSha256',v_admission.binding_manifest_sha256,
    'admissionRevision',v_admission.admission_revision::text,
    'targetSetSha256',v_admission.target_set_sha256,
    'runtimeContractId',v_target.runtime_contract_id,
    'runtimeTargetId',v_target.runtime_target_id,
    'runtimeTargetSha256',v_target.runtime_target_sha256,
    'profileVersionId',v_target.profile_version_id,
    'priceVersionId',v_target.price_version_id,'providerId',v_target.provider_id,
    'codeCapabilityId',v_target.code_capability_id,
    'codeCapabilitySha256',v_target.code_capability_sha256,
    'legalBundleVersion',v_target.legal_bundle_version,
    'legalManifestId',v_target.legal_manifest_id,
    'displayDisclosureKey',v_target.display_disclosure_key
  ));
exception when others then
  return jsonb_build_object('schemaVersion','ai_polish_execution_snapshot_v1',
    'ok',false,'reason','SERVICE_UNAVAILABLE');
end;
$$;

create function public.start_ai_polish_provider_attempt_v3(
  p_reservation_id uuid, p_attempt_no integer,
  p_admission_id uuid, p_reviewed_deployment_id uuid,
  p_validation_report_id uuid, p_environment text, p_project_ref text,
  p_runtime_build_id text, p_binding_manifest_revision text,
  p_binding_manifest_sha256 text, p_admission_revision bigint,
  p_target_set_sha256 text, p_runtime_contract_id text,
  p_runtime_target_id text, p_runtime_target_sha256 text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_request public.ai_request_ledger%rowtype;
  v_attempt public.ai_provider_attempt_ledger%rowtype;
  v_admission public.admin_admitted_runtime_deployments_v2%rowtype;
  v_target public.admin_admitted_runtime_targets_v2%rowtype;
  v_result jsonb;
begin
  if p_attempt_no not in (1,2) then
    raise exception 'provider attempt number must be 1 or 2' using errcode = '22023';
  end if;
  select * into v_request from public.ai_request_ledger
  where reservation_id = p_reservation_id for update;
  if not found then return jsonb_build_object('ok',false,'reason','NOT_FOUND'); end if;
  select * into v_attempt from public.ai_provider_attempt_ledger
  where reservation_id = p_reservation_id and attempt_no = p_attempt_no;
  select * into v_admission from public.admin_admitted_runtime_deployments_v2
  where admission_id = p_admission_id
    and reviewed_deployment_id = p_reviewed_deployment_id
    and environment = p_environment and project_ref = p_project_ref
    and runtime_build_id = p_runtime_build_id
    and binding_manifest_revision = p_binding_manifest_revision
    and binding_manifest_sha256 = p_binding_manifest_sha256
    and admission_revision = p_admission_revision
    and target_set_sha256 = p_target_set_sha256 and sealed_at is not null
  for share;
  if not found then
    return jsonb_build_object('ok',false,'reason','SERVICE_UNAVAILABLE');
  end if;
  select * into v_target from public.admin_admitted_runtime_targets_v2
  where admission_id = v_admission.admission_id
    and validation_report_id = p_validation_report_id
    and runtime_contract_id = p_runtime_contract_id
    and runtime_target_id = p_runtime_target_id
    and runtime_target_sha256 = p_runtime_target_sha256 for share;
  if not found
     or (v_request.runtime_contract_id, v_request.profile_version_id,
         v_request.price_version_id, v_request.legal_bundle_version)
       is distinct from
       (v_target.runtime_contract_id, v_target.profile_version_id,
         v_target.price_version_id, v_target.legal_bundle_version) then
    return jsonb_build_object('ok',false,'reason','SERVICE_UNAVAILABLE');
  end if;
  if v_attempt.attempt_id is not null then
    if (v_attempt.runtime_admission_id, v_attempt.runtime_admission_revision,
        v_attempt.runtime_target_set_sha256, v_attempt.admitted_runtime_target_id,
        v_attempt.admitted_runtime_target_sha256,
        v_attempt.runtime_validation_report_id)
      is distinct from
      (v_admission.admission_id, v_admission.admission_revision,
        v_admission.target_set_sha256, v_target.runtime_target_id,
        v_target.runtime_target_sha256, v_target.validation_report_id)
      or v_attempt.started_at < v_admission.admitted_at then
      return jsonb_build_object('ok',false,'reason','SERVICE_UNAVAILABLE');
    end if;
    return public.start_ai_polish_provider_attempt_v2(
      p_reservation_id,p_attempt_no,p_runtime_build_id,
      p_binding_manifest_revision
    );
  end if;
  if v_admission.revoked_at is not null then
    return jsonb_build_object('ok',false,'reason','SERVICE_UNAVAILABLE');
  end if;
  v_result := public.start_ai_polish_provider_attempt_v2(
    p_reservation_id,p_attempt_no,p_runtime_build_id,
    p_binding_manifest_revision
  );
  if v_result ->> 'ok' is distinct from 'true'
     or v_result ->> 'alreadyStarted' is distinct from 'false' then
    return v_result;
  end if;
  update public.ai_provider_attempt_ledger set
    runtime_admission_id = v_admission.admission_id,
    runtime_admission_revision = v_admission.admission_revision,
    runtime_target_set_sha256 = v_admission.target_set_sha256,
    admitted_runtime_target_id = v_target.runtime_target_id,
    admitted_runtime_target_sha256 = v_target.runtime_target_sha256,
    runtime_validation_report_id = v_target.validation_report_id
  where reservation_id = p_reservation_id and attempt_no = p_attempt_no;
  return v_result;
end;
$$;

-- Old readback rows remain historical. Every newly produced report must carry
-- the exact durable admission receipt that authorized its effective routes.
alter table public.admin_runtime_readback_reports_v1
  add column admission_id uuid references
    public.admin_admitted_runtime_deployments_v2(admission_id) on delete restrict,
  add column admission_revision bigint,
  add column target_set_sha256 text;

revoke all on function public.admin_runtime_target_set_sha256_v2(uuid),
  public.admin_guard_runtime_admission_parent_v2(),
  public.admin_validate_runtime_admission_target_v2(),
  public.admin_assert_runtime_admission_sealed_v2(),
  public.guard_ai_attempt_runtime_admission_v2(),
  public.admin_admit_runtime_deployment_v2(uuid,jsonb,text),
  public.admin_revoke_runtime_deployment_v2(uuid,bigint,text,text),
  public.start_ai_polish_provider_attempt_v3(
    uuid,integer,uuid,uuid,uuid,text,text,text,text,text,bigint,text,text,text,text
  ) from public, anon, authenticated, service_role;
revoke all on function public.get_ai_polish_execution_snapshot_v4(
  uuid,uuid,text,text,text,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.start_ai_polish_provider_attempt_v3(
  uuid,integer,uuid,uuid,uuid,text,text,text,text,text,bigint,text,text,text,text
) to service_role;
grant execute on function public.get_ai_polish_execution_snapshot_v4(
  uuid,uuid,text,text,text,text,text
) to service_role;

commit;
