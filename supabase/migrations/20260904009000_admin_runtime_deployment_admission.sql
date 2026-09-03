-- ADM-I06: durable, database-authoritative runtime admission.
-- A reviewed deployment can be admitted once with an immutable target set and
-- later revoked. Short-lived validation reports remain candidate evidence;
-- request execution is authorized by this exact deployment identity instead.
begin;

-- A build/revision identifies exactly one provider-binding manifest. This
-- prevents two rolling instances from presenting crossed hashes for the same
-- deployment identity.
alter table public.admin_reviewed_deployments_v1
  add constraint admin_reviewed_deployments_revision_unique unique
    (environment, project_ref, runtime_build_id, binding_manifest_revision),
  add constraint admin_reviewed_deployments_id_identity_unique unique
    (id, environment, project_ref, runtime_build_id, binding_manifest_revision,
     binding_manifest_sha256);

create table public.admin_admitted_runtime_deployments_v1 (
  reviewed_deployment_id uuid not null,
  environment text not null check (environment in ('local','preview','production')),
  project_ref text not null check (project_ref ~ '^[a-z0-9-]{1,100}$'),
  runtime_build_id text not null check (runtime_build_id ~ '^[a-z0-9][a-z0-9._:-]{0,199}$'),
  binding_manifest_revision text not null check (binding_manifest_revision ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  binding_manifest_sha256 text not null check (binding_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  admission_revision bigint not null check (admission_revision > 0),
  admitted_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  revoked_reason text,
  primary key (environment, project_ref, runtime_build_id, binding_manifest_revision),
  constraint admin_admitted_runtime_revision_unique unique
    (environment, project_ref, admission_revision),
  constraint admin_admitted_runtime_review_fkey foreign key
    (reviewed_deployment_id, environment, project_ref, runtime_build_id,
     binding_manifest_revision, binding_manifest_sha256)
    references public.admin_reviewed_deployments_v1
      (id, environment, project_ref, runtime_build_id, binding_manifest_revision,
       binding_manifest_sha256) on delete restrict,
  constraint admin_admitted_runtime_revoke_check check
    ((revoked_at is null and revoked_reason is null) or
     (revoked_at is not null and revoked_reason = btrim(revoked_reason)
      and length(revoked_reason) between 1 and 500))
);

create table public.admin_admitted_runtime_targets_v1 (
  environment text not null,
  project_ref text not null,
  runtime_build_id text not null,
  binding_manifest_revision text not null,
  runtime_contract_id text not null,
  runtime_target_id text not null,
  runtime_target_sha256 text not null check (runtime_target_sha256 ~ '^[0-9a-f]{64}$'),
  profile_version_id uuid not null,
  price_version_id uuid not null,
  provider_id uuid not null,
  legal_bundle_version text not null,
  legal_manifest_id text not null,
  display_disclosure_key text not null,
  code_capability_id text not null,
  code_capability_sha256 text not null check (code_capability_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (environment, project_ref, runtime_build_id, binding_manifest_revision,
    runtime_contract_id, runtime_target_id),
  foreign key (environment, project_ref, runtime_build_id, binding_manifest_revision)
    references public.admin_admitted_runtime_deployments_v1
      (environment, project_ref, runtime_build_id, binding_manifest_revision)
    on delete restrict,
  foreign key (runtime_contract_id, runtime_target_id)
    references public.ai_runtime_target_bindings_v2
      (runtime_contract_id, runtime_target_id) on delete restrict,
  foreign key (code_capability_id, code_capability_sha256)
    references public.ai_runtime_code_capabilities_v2(code_capability_id, descriptor_sha256)
    on delete restrict
);

alter table public.admin_admitted_runtime_deployments_v1 enable row level security;
alter table public.admin_admitted_runtime_targets_v1 enable row level security;
revoke all on public.admin_admitted_runtime_deployments_v1,
  public.admin_admitted_runtime_targets_v1 from public, anon, authenticated, service_role;

-- The admitted target row is a frozen copy of the complete database-owned
-- runtime binding. Matching only IDs/hashes would permit crossed legal, price,
-- or disclosure evidence to enter an admitted deployment.
create function public.admin_validate_admitted_runtime_target_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_binding public.ai_runtime_target_bindings_v2%rowtype;
begin
  if session_user not in ('postgres', 'supabase_admin') then
    raise exception 'Runtime admission targets are owner managed' using errcode = '42501';
  end if;
  select * into v_binding from public.ai_runtime_target_bindings_v2
    where runtime_contract_id = new.runtime_contract_id
      and runtime_target_id = new.runtime_target_id;
  if v_binding.runtime_target_id is null
     or v_binding.runtime_target_sha256 is distinct from new.runtime_target_sha256
     or v_binding.profile_version_id is distinct from new.profile_version_id
     or v_binding.price_version_id is distinct from new.price_version_id
     or v_binding.provider_id is distinct from new.provider_id
     or v_binding.legal_bundle_version is distinct from new.legal_bundle_version
     or v_binding.legal_manifest_id is distinct from new.legal_manifest_id
     or v_binding.display_disclosure_key is distinct from new.display_disclosure_key
     or v_binding.code_capability_id is distinct from new.code_capability_id
     or v_binding.code_capability_sha256 is distinct from new.code_capability_sha256 then
    raise exception 'Runtime target identity mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger admin_admitted_runtime_target_validate
before insert on public.admin_admitted_runtime_targets_v1
for each row execute function public.admin_validate_admitted_runtime_target_v1();

create function public.admin_guard_admitted_runtime_target_immutable_v1()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Admitted runtime targets are immutable' using errcode = '23514';
end;
$$;
create trigger admin_admitted_runtime_target_immutable
before update or delete on public.admin_admitted_runtime_targets_v1
for each row execute function public.admin_guard_admitted_runtime_target_immutable_v1();

create function public.admin_guard_admitted_runtime_deployment_v1()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE'
     or session_user not in ('postgres', 'supabase_admin')
     or old.revoked_at is not null
     or new.revoked_at is null
     or new.reviewed_deployment_id is distinct from old.reviewed_deployment_id
     or new.environment is distinct from old.environment
     or new.project_ref is distinct from old.project_ref
     or new.runtime_build_id is distinct from old.runtime_build_id
     or new.binding_manifest_revision is distinct from old.binding_manifest_revision
     or new.binding_manifest_sha256 is distinct from old.binding_manifest_sha256
     or new.admission_revision is distinct from old.admission_revision
     or new.admitted_at is distinct from old.admitted_at then
    raise exception 'Runtime admission is immutable except for one revocation'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger admin_admitted_runtime_deployment_guard
before update or delete on public.admin_admitted_runtime_deployments_v1
for each row execute function public.admin_guard_admitted_runtime_deployment_v1();

-- The parent registration digest commits to the complete sorted capability ID
-- set. A deferred check lets the owner importer insert parent and children in
-- one transaction, while any later append changes the digest and is rejected.
create function public.admin_assert_reviewed_capability_set_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_review public.admin_reviewed_deployments_v1%rowtype;
  v_capability_ids text[];
  v_payload text;
  v_registration_sha256 text;
begin
  select * into v_review from public.admin_reviewed_deployments_v1
    where id = new.reviewed_deployment_id;
  select array_agg(code_capability_id order by code_capability_id)
    into v_capability_ids
    from public.admin_reviewed_deployment_capabilities_v1
    where reviewed_deployment_id = new.reviewed_deployment_id;
  v_payload := concat_ws(E'\n',
    'reviewed_deployment_v1', v_review.id::text, v_review.environment,
    v_review.project_ref, v_review.runtime_build_id,
    v_review.binding_manifest_revision, v_review.binding_manifest_sha256,
    v_review.reviewed_source_commit_oid, v_review.reviewed_source_sha256,
    to_char(v_review.valid_until at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    array_to_string(v_capability_ids, ','),
    array_to_string(v_review.reviewed_evidence_ids, ',')
  );
  v_registration_sha256 := encode(
    extensions.digest(convert_to(v_payload, 'UTF8'), 'sha256'), 'hex'
  );
  if v_review.id is null
     or v_registration_sha256 is distinct from v_review.registration_sha256 then
    raise exception 'Reviewed deployment capabilities are immutable'
      using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger admin_reviewed_capability_set_guard
after insert on public.admin_reviewed_deployment_capabilities_v1
deferrable initially deferred for each row
execute function public.admin_assert_reviewed_capability_set_v1();

create function public.admin_admit_runtime_deployment_v1(
  p_reviewed_deployment_id uuid,
  p_environment text,
  p_project_ref text,
  p_runtime_build_id text,
  p_binding_manifest_revision text,
  p_binding_manifest_sha256 text,
  p_runtime_target_ids text[],
  p_reason text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_review public.admin_reviewed_deployments_v1%rowtype;
  v_environment public.admin_environment%rowtype;
  v_target public.ai_runtime_target_bindings_v2%rowtype;
  v_revision bigint;
  v_target_id text;
  v_audit uuid;
begin
  if session_user not in ('postgres', 'supabase_admin') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_reason is null or p_reason is distinct from btrim(p_reason)
     or length(p_reason) not between 1 and 500
     or p_runtime_target_ids is null
     or cardinality(p_runtime_target_ids) not between 1 and 64
     or cardinality(p_runtime_target_ids) is distinct from
       (select count(distinct value) from unnest(p_runtime_target_ids) as item(value))
     or p_binding_manifest_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  select * into v_environment from public.admin_environment
    where id = true for update;
  select * into v_review from public.admin_reviewed_deployments_v1
    where id = p_reviewed_deployment_id for share;
  if v_environment.id is null or v_review.id is null
     or v_environment.environment is distinct from p_environment
     or v_environment.project_ref is distinct from p_project_ref
     or v_review.environment is distinct from p_environment
     or v_review.project_ref is distinct from p_project_ref
     or v_review.runtime_build_id is distinct from p_runtime_build_id
     or v_review.binding_manifest_revision is distinct from p_binding_manifest_revision
     or v_review.binding_manifest_sha256 is distinct from p_binding_manifest_sha256
     or v_review.valid_until <= clock_timestamp() then
    raise exception 'REVIEWED_DEPLOYMENT_MISMATCH' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.admin_admitted_runtime_deployments_v1
    where environment = p_environment and project_ref = p_project_ref
      and runtime_build_id = p_runtime_build_id
      and binding_manifest_revision = p_binding_manifest_revision
  ) then
    raise exception 'DEPLOYMENT_ALREADY_ADMITTED' using errcode = '23505';
  end if;
  foreach v_target_id in array p_runtime_target_ids loop
    if v_target_id is null
       or v_target_id !~ '^[a-z0-9][a-z0-9._-]{0,199}$'
       or (select count(*) from public.ai_runtime_target_bindings_v2
           where runtime_target_id = v_target_id) <> 1 then
      raise exception 'TARGET_IDENTITY_AMBIGUOUS' using errcode = '23514';
    end if;
    select * into v_target from public.ai_runtime_target_bindings_v2
      where runtime_target_id = v_target_id for share;
    if not exists (
      select 1 from public.admin_reviewed_deployment_capabilities_v1 capability
      where capability.reviewed_deployment_id = v_review.id
        and capability.code_capability_id = v_target.code_capability_id
        and capability.code_capability_sha256 = v_target.code_capability_sha256
    ) then
      raise exception 'TARGET_NOT_REVIEWED' using errcode = '23514';
    end if;
  end loop;
  select coalesce(max(admission_revision), 0) + 1 into v_revision
    from public.admin_admitted_runtime_deployments_v1
    where environment = p_environment and project_ref = p_project_ref;
  insert into public.admin_admitted_runtime_deployments_v1(
    reviewed_deployment_id, environment, project_ref, runtime_build_id,
    binding_manifest_revision, binding_manifest_sha256, admission_revision
  ) values (
    p_reviewed_deployment_id, p_environment, p_project_ref, p_runtime_build_id,
    p_binding_manifest_revision, p_binding_manifest_sha256, v_revision
  );
  foreach v_target_id in array p_runtime_target_ids loop
    insert into public.admin_admitted_runtime_targets_v1(
      environment, project_ref, runtime_build_id, binding_manifest_revision,
      runtime_contract_id, runtime_target_id, runtime_target_sha256,
      profile_version_id, price_version_id, provider_id, legal_bundle_version,
      legal_manifest_id, display_disclosure_key, code_capability_id,
      code_capability_sha256
    ) select p_environment, p_project_ref, p_runtime_build_id,
      p_binding_manifest_revision, target.runtime_contract_id,
      target.runtime_target_id, target.runtime_target_sha256,
      target.profile_version_id, target.price_version_id, target.provider_id,
      target.legal_bundle_version, target.legal_manifest_id,
      target.display_disclosure_key, target.code_capability_id,
      target.code_capability_sha256
    from public.ai_runtime_target_bindings_v2 target
    where target.runtime_target_id = v_target_id;
  end loop;
  insert into public.admin_audit_events(operation, actor, target_id, reason)
    values ('runtime_deployment_admit', 'db_operator', p_reviewed_deployment_id, p_reason)
    returning id into v_audit;
  return jsonb_build_object(
    'schemaVersion', 'admin_runtime_admission_result_v1',
    'environment', p_environment, 'projectRef', p_project_ref,
    'runtimeBuildId', p_runtime_build_id,
    'bindingManifestRevision', p_binding_manifest_revision,
    'bindingManifestSha256', p_binding_manifest_sha256,
    'admissionRevision', v_revision::text, 'auditEventId', v_audit
  );
end;
$$;

create function public.admin_revoke_runtime_deployment_v1(
  p_environment text,
  p_project_ref text,
  p_runtime_build_id text,
  p_binding_manifest_revision text,
  p_expected_admission_revision bigint,
  p_reason text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_deployment public.admin_admitted_runtime_deployments_v1%rowtype;
  v_audit uuid;
begin
  if session_user not in ('postgres', 'supabase_admin') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_expected_admission_revision is null or p_expected_admission_revision <= 0
     or p_reason is null or p_reason is distinct from btrim(p_reason)
     or length(p_reason) not between 1 and 500 then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  select * into v_deployment from public.admin_admitted_runtime_deployments_v1
    where environment = p_environment and project_ref = p_project_ref
      and runtime_build_id = p_runtime_build_id
      and binding_manifest_revision = p_binding_manifest_revision
    for update;
  if v_deployment.reviewed_deployment_id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_deployment.revoked_at is not null
     or v_deployment.admission_revision is distinct from p_expected_admission_revision then
    raise exception 'STALE_REVISION' using errcode = '40001';
  end if;
  update public.admin_admitted_runtime_deployments_v1
    set revoked_at = clock_timestamp(), revoked_reason = p_reason
    where environment = p_environment and project_ref = p_project_ref
      and runtime_build_id = p_runtime_build_id
      and binding_manifest_revision = p_binding_manifest_revision
    returning * into v_deployment;
  insert into public.admin_audit_events(operation, actor, target_id, reason)
    values ('runtime_deployment_revoke', 'db_operator',
      v_deployment.reviewed_deployment_id, p_reason)
    returning id into v_audit;
  return jsonb_build_object(
    'schemaVersion', 'admin_runtime_admission_revoke_result_v1',
    'admissionRevision', v_deployment.admission_revision::text,
    'auditEventId', v_audit
  );
end;
$$;

create function public.get_admin_admitted_runtime_deployment_v1(
  p_environment text,
  p_project_ref text,
  p_runtime_build_id text,
  p_binding_manifest_revision text,
  p_binding_manifest_sha256 text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_deployment public.admin_admitted_runtime_deployments_v1%rowtype;
  v_targets jsonb;
begin
  if not (
    (auth.role() = 'service_role' and auth.uid() is null)
    or session_user in ('postgres', 'supabase_admin')
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_deployment from public.admin_admitted_runtime_deployments_v1
    where environment = p_environment and project_ref = p_project_ref
      and runtime_build_id = p_runtime_build_id
      and binding_manifest_revision = p_binding_manifest_revision
      and binding_manifest_sha256 = p_binding_manifest_sha256
      and revoked_at is null;
  if not found then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'runtimeContractId', target.runtime_contract_id,
    'runtimeTargetId', target.runtime_target_id,
    'runtimeTargetSha256', target.runtime_target_sha256,
    'profileVersionId', target.profile_version_id,
    'priceVersionId', target.price_version_id,
    'providerId', target.provider_id,
    'legalBundleVersion', target.legal_bundle_version,
    'legalManifestId', target.legal_manifest_id,
    'displayDisclosureKey', target.display_disclosure_key,
    'codeCapabilityId', target.code_capability_id,
    'codeCapabilitySha256', target.code_capability_sha256
  ) order by target.runtime_contract_id, target.runtime_target_id), '[]'::jsonb)
  into v_targets from public.admin_admitted_runtime_targets_v1 target
  where target.environment = v_deployment.environment
    and target.project_ref = v_deployment.project_ref
    and target.runtime_build_id = v_deployment.runtime_build_id
    and target.binding_manifest_revision = v_deployment.binding_manifest_revision;
  return jsonb_build_object(
    'schemaVersion', 'admin_admitted_runtime_deployment_v1',
    'reviewedDeploymentId', v_deployment.reviewed_deployment_id,
    'environment', v_deployment.environment,
    'projectRef', v_deployment.project_ref,
    'runtimeBuildId', v_deployment.runtime_build_id,
    'bindingManifestRevision', v_deployment.binding_manifest_revision,
    'bindingManifestSha256', v_deployment.binding_manifest_sha256,
    'admissionRevision', v_deployment.admission_revision::text,
    'admittedAt', v_deployment.admitted_at,
    'targets', v_targets
  );
end;
$$;

create function public.get_ai_polish_execution_snapshot_v4(
  p_reservation_id uuid,
  p_user_id uuid,
  p_environment text,
  p_project_ref text,
  p_runtime_build_id text,
  p_binding_manifest_revision text,
  p_binding_manifest_sha256 text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_snapshot jsonb;
  v_admission jsonb;
  v_evidence jsonb;
  v_target jsonb;
begin
  v_snapshot := public.get_ai_polish_execution_snapshot_v2(
    p_reservation_id, p_user_id
  );
  if v_snapshot ->> 'ok' is distinct from 'true'
     or v_snapshot ->> 'schemaVersion' is distinct from
       'ai_polish_execution_snapshot_v2' then
    return v_snapshot;
  end if;
  v_admission := public.get_admin_admitted_runtime_deployment_v1(
    p_environment, p_project_ref, p_runtime_build_id,
    p_binding_manifest_revision, p_binding_manifest_sha256
  );
  if v_admission is null then
    return jsonb_build_object(
      'schemaVersion', 'ai_polish_execution_snapshot_v1',
      'ok', false, 'reason', 'SERVICE_UNAVAILABLE'
    );
  end if;
  v_evidence := v_snapshot -> 'runtimeEvidence';
  select target into v_target
  from jsonb_array_elements(v_admission -> 'targets') as item(target)
  where target ->> 'runtimeContractId' = v_evidence ->> 'runtimeContractId'
    and target ->> 'runtimeTargetId' = v_evidence ->> 'runtimeTargetId'
    and target ->> 'runtimeTargetSha256' = v_evidence ->> 'runtimeTargetSha256'
    and target ->> 'profileVersionId' = v_evidence ->> 'profileVersionId'
    and target ->> 'priceVersionId' = v_evidence ->> 'priceVersionId'
    and target ->> 'providerId' = v_evidence ->> 'providerId'
    and target ->> 'codeCapabilityId' = v_evidence ->> 'codeCapabilityId'
    and target ->> 'codeCapabilitySha256' = v_evidence ->> 'codeCapabilitySha256'
    and target ->> 'legalBundleVersion' = v_evidence ->> 'legalBundleVersion'
    and target ->> 'legalManifestId' = v_evidence ->> 'legalManifestId'
    and target ->> 'displayDisclosureKey' = v_evidence ->> 'displayDisclosureKey';
  if v_target is null then
    return jsonb_build_object(
      'schemaVersion', 'ai_polish_execution_snapshot_v1',
      'ok', false, 'reason', 'SERVICE_UNAVAILABLE'
    );
  end if;
  return jsonb_set(v_snapshot, '{deploymentValidation}', jsonb_build_object(
    'schemaVersion', 'runtime_deployment_admission_v1',
    'environment', p_environment, 'projectRef', p_project_ref,
    'runtimeBuildId', p_runtime_build_id,
    'bindingManifestRevision', p_binding_manifest_revision,
    'bindingManifestSha256', p_binding_manifest_sha256,
    'admissionRevision', v_admission ->> 'admissionRevision',
    'runtimeContractId', v_target -> 'runtimeContractId',
    'runtimeTargetId', v_target -> 'runtimeTargetId',
    'runtimeTargetSha256', v_target -> 'runtimeTargetSha256',
    'profileVersionId', v_target -> 'profileVersionId',
    'priceVersionId', v_target -> 'priceVersionId',
    'providerId', v_target -> 'providerId',
    'codeCapabilityId', v_target -> 'codeCapabilityId',
    'codeCapabilitySha256', v_target -> 'codeCapabilitySha256',
    'legalBundleVersion', v_target -> 'legalBundleVersion',
    'legalManifestId', v_target -> 'legalManifestId',
    'displayDisclosureKey', v_target -> 'displayDisclosureKey'
  ));
exception when others then
  return jsonb_build_object(
    'schemaVersion', 'ai_polish_execution_snapshot_v1',
    'ok', false, 'reason', 'SERVICE_UNAVAILABLE'
  );
end;
$$;

revoke all on function public.admin_validate_admitted_runtime_target_v1(),
  public.admin_guard_admitted_runtime_target_immutable_v1(),
  public.admin_guard_admitted_runtime_deployment_v1(),
  public.admin_assert_reviewed_capability_set_v1(),
  public.admin_admit_runtime_deployment_v1(uuid,text,text,text,text,text,text[],text),
  public.admin_revoke_runtime_deployment_v1(text,text,text,text,bigint,text),
  public.get_admin_admitted_runtime_deployment_v1(text,text,text,text,text),
  public.get_ai_polish_execution_snapshot_v4(uuid,uuid,text,text,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_ai_polish_execution_snapshot_v4(
  uuid,uuid,text,text,text,text,text
) to service_role;

commit;
