-- ADM-I06B: owner-reviewed deployment registrations and service-produced,
-- immutable validation reports. No Admin business mutation is enabled.
begin;

create table public.admin_reviewed_deployments_v1 (
  id uuid primary key,
  environment text not null check (environment in ('local','preview','production')),
  project_ref text not null check (project_ref ~ '^[a-z0-9-]{1,100}$'),
  runtime_build_id text not null check (runtime_build_id ~ '^[a-z0-9][a-z0-9._:-]{0,199}$'),
  binding_manifest_revision text not null
    check (binding_manifest_revision ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  binding_manifest_sha256 text not null
    check (binding_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  reviewed_evidence_ids text[] not null,
  reviewed_source_commit_oid text not null check (
    reviewed_source_commit_oid ~ '^sha1:[0-9a-f]{40}$'
    or reviewed_source_commit_oid ~ '^sha256:[0-9a-f]{64}$'
  ),
  reviewed_source_sha256 text not null
    check (reviewed_source_sha256 ~ '^[0-9a-f]{64}$'),
  valid_until timestamptz not null,
  registration_sha256 text not null
    check (registration_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  constraint admin_reviewed_deployments_identity_unique unique (
    environment, project_ref, runtime_build_id, binding_manifest_revision,
    binding_manifest_sha256
  ),
  constraint admin_reviewed_deployments_window_check
    check (valid_until > created_at)
);

create table public.admin_reviewed_deployment_capabilities_v1 (
  reviewed_deployment_id uuid not null
    references public.admin_reviewed_deployments_v1(id) on delete restrict,
  code_capability_id text not null,
  code_capability_sha256 text not null,
  primary key (reviewed_deployment_id, code_capability_id),
  foreign key (code_capability_id, code_capability_sha256)
    references public.ai_runtime_code_capabilities_v2(
      code_capability_id, descriptor_sha256
    ) on delete restrict
);

create table public.admin_validation_reports_v1 (
  id uuid primary key default extensions.gen_random_uuid(),
  reviewed_deployment_id uuid not null
    references public.admin_reviewed_deployments_v1(id) on delete restrict,
  environment text not null,
  project_ref text not null,
  runtime_build_id text not null,
  binding_manifest_revision text not null,
  binding_manifest_sha256 text not null,
  runtime_contract_id text not null,
  runtime_target_id text not null,
  runtime_target_sha256 text not null,
  profile_version_id uuid not null,
  price_version_id uuid not null,
  provider_id uuid not null,
  code_capability_id text not null,
  code_capability_sha256 text not null,
  legal_bundle_version text not null,
  legal_manifest_id text not null,
  display_disclosure_key text not null,
  endpoint_policy_valid boolean not null,
  manifest_binding_valid boolean not null,
  credential_configured boolean not null,
  compiled_capability_valid boolean not null,
  database_binding_valid boolean not null,
  passed boolean generated always as (
    endpoint_policy_valid and manifest_binding_valid
    and credential_configured and compiled_capability_valid
    and database_binding_valid
  ) stored,
  evidence_ids text[] not null,
  checked_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  report_sha256 text not null check (report_sha256 ~ '^[0-9a-f]{64}$'),

  constraint admin_validation_reports_target_fkey
    foreign key (runtime_contract_id, runtime_target_id)
    references public.ai_runtime_target_bindings_v2(
      runtime_contract_id, runtime_target_id
    ) on delete restrict,
  constraint admin_validation_reports_capability_fkey
    foreign key (
      reviewed_deployment_id, code_capability_id
    ) references public.admin_reviewed_deployment_capabilities_v1(
      reviewed_deployment_id, code_capability_id
    ) on delete restrict,
  constraint admin_validation_reports_window_check check (
    expires_at > checked_at
    and expires_at <= checked_at + interval '10 minutes'
  ),
  constraint admin_validation_reports_ids_check check (
    runtime_build_id ~ '^[a-z0-9][a-z0-9._:-]{0,199}$'
    and binding_manifest_revision ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    and runtime_contract_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    and runtime_target_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    and legal_bundle_version ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    and legal_manifest_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    and display_disclosure_key ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
  ),
  constraint admin_validation_reports_hashes_check check (
    binding_manifest_sha256 ~ '^[0-9a-f]{64}$'
    and runtime_target_sha256 ~ '^[0-9a-f]{64}$'
    and code_capability_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint admin_validation_reports_evidence_check
    check (cardinality(evidence_ids) between 1 and 96)
);

alter table public.admin_reviewed_deployments_v1 enable row level security;
alter table public.admin_reviewed_deployment_capabilities_v1 enable row level security;
alter table public.admin_validation_reports_v1 enable row level security;
revoke all on public.admin_reviewed_deployments_v1,
  public.admin_reviewed_deployment_capabilities_v1,
  public.admin_validation_reports_v1
  from public, anon, authenticated, service_role;

create function public.admin_guard_validation_evidence_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Admin validation evidence is immutable'
    using errcode = '23514';
end;
$$;

create trigger admin_reviewed_deployments_immutable
before update or delete on public.admin_reviewed_deployments_v1
for each row execute function public.admin_guard_validation_evidence_v1();
create trigger admin_reviewed_deployment_capabilities_immutable
before update or delete on public.admin_reviewed_deployment_capabilities_v1
for each row execute function public.admin_guard_validation_evidence_v1();
create trigger admin_validation_reports_immutable
before update or delete on public.admin_validation_reports_v1
for each row execute function public.admin_guard_validation_evidence_v1();

-- Deliberately unavailable to service_role and browser sessions. The first
-- registration and each successor build/manifest review are DB-owner actions.
create function public.admin_import_reviewed_deployment_v1(
  p_id uuid,
  p_environment text,
  p_project_ref text,
  p_runtime_build_id text,
  p_binding_manifest_revision text,
  p_binding_manifest_sha256 text,
  p_code_capability_ids text[],
  p_reviewed_evidence_ids text[],
  p_reviewed_source_commit_oid text,
  p_reviewed_source_sha256 text,
  p_valid_until timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_environment public.admin_environment%rowtype;
  v_evidence_id text;
  v_capability_id text;
  v_registration_sha256 text;
  v_payload text;
  v_code_capability_ids text[];
  v_reviewed_evidence_ids text[];
begin
  if session_user not in ('postgres', 'supabase_admin') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_environment
  from public.admin_environment where id = true for share;
  if not found
     or v_environment.environment is distinct from p_environment
     or v_environment.project_ref is distinct from p_project_ref then
    raise exception 'ENVIRONMENT_MISMATCH' using errcode = '42501';
  end if;
  if p_id is null
     or p_runtime_build_id !~ '^[a-z0-9][a-z0-9._:-]{0,199}$'
     or p_binding_manifest_revision !~ '^[a-z0-9][a-z0-9._-]{0,199}$'
     or p_binding_manifest_sha256 !~ '^[0-9a-f]{64}$'
     or p_reviewed_source_commit_oid is null
     or not (
       p_reviewed_source_commit_oid ~ '^sha1:[0-9a-f]{40}$'
       or p_reviewed_source_commit_oid ~ '^sha256:[0-9a-f]{64}$'
     )
     or p_reviewed_source_sha256 !~ '^[0-9a-f]{64}$'
     or p_valid_until <= clock_timestamp()
     or cardinality(p_code_capability_ids) not between 1 and 32
     or cardinality(p_reviewed_evidence_ids) not between 1 and 64
     or cardinality(p_code_capability_ids) is distinct from (
       select count(distinct value) from unnest(p_code_capability_ids) as item(value)
     )
     or cardinality(p_reviewed_evidence_ids) is distinct from (
       select count(distinct value) from unnest(p_reviewed_evidence_ids) as item(value)
     ) then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  foreach v_capability_id in array p_code_capability_ids loop
    if v_capability_id is null
       or v_capability_id !~ '^[a-z0-9][a-z0-9._-]{0,199}$'
       or not exists (
         select 1 from public.ai_runtime_code_capabilities_v2
         where code_capability_id = v_capability_id
       ) then
      raise exception 'UNKNOWN_CODE_CAPABILITY' using errcode = '23514';
    end if;
  end loop;
  foreach v_evidence_id in array p_reviewed_evidence_ids loop
    if v_evidence_id is null
       or v_evidence_id !~ '^[a-z0-9][a-z0-9._-]{0,199}$' then
      raise exception 'INVALID_REQUEST' using errcode = '22023';
    end if;
  end loop;

  select array_agg(value order by value)
  into v_code_capability_ids
  from unnest(p_code_capability_ids) as item(value);
  select array_agg(value order by value)
  into v_reviewed_evidence_ids
  from unnest(p_reviewed_evidence_ids) as item(value);

  v_payload := concat_ws(E'\n',
    'reviewed_deployment_v1', p_id::text, p_environment, p_project_ref,
    p_runtime_build_id, p_binding_manifest_revision,
    p_binding_manifest_sha256, p_reviewed_source_commit_oid,
    p_reviewed_source_sha256,
    to_char(
      p_valid_until at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    array_to_string(v_code_capability_ids, ','),
    array_to_string(v_reviewed_evidence_ids, ',')
  );
  v_registration_sha256 := encode(
    extensions.digest(convert_to(v_payload, 'UTF8'), 'sha256'), 'hex'
  );
  insert into public.admin_reviewed_deployments_v1(
    id, environment, project_ref, runtime_build_id,
    binding_manifest_revision, binding_manifest_sha256,
    reviewed_evidence_ids, reviewed_source_commit_oid,
    reviewed_source_sha256, valid_until, registration_sha256
  ) values (
    p_id, p_environment, p_project_ref, p_runtime_build_id,
    p_binding_manifest_revision, p_binding_manifest_sha256,
    v_reviewed_evidence_ids, p_reviewed_source_commit_oid,
    p_reviewed_source_sha256, p_valid_until, v_registration_sha256
  );
  insert into public.admin_reviewed_deployment_capabilities_v1(
    reviewed_deployment_id, code_capability_id, code_capability_sha256
  )
  select p_id, capability.code_capability_id, capability.descriptor_sha256
  from public.ai_runtime_code_capabilities_v2 as capability
  where capability.code_capability_id = any(v_code_capability_ids);
  return p_id;
end;
$$;

-- The producer receives this approved projection by candidate ID. It cannot
-- ask the database to validate caller-supplied endpoint/profile JSON.
create function public.get_admin_validation_candidate_v1(
  p_reviewed_deployment_id uuid,
  p_runtime_contract_id text,
  p_runtime_target_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deployment public.admin_reviewed_deployments_v1%rowtype;
  v_target public.ai_runtime_target_bindings_v2%rowtype;
  v_version public.ai_provider_profile_versions%rowtype;
  v_profile public.ai_provider_profiles%rowtype;
  v_provider public.ai_providers%rowtype;
  v_capability public.ai_runtime_code_capabilities_v2%rowtype;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_deployment from public.admin_reviewed_deployments_v1
  where id = p_reviewed_deployment_id and valid_until > clock_timestamp();
  select * into v_target from public.ai_runtime_target_bindings_v2
  where runtime_contract_id = p_runtime_contract_id
    and runtime_target_id = p_runtime_target_id;
  if v_deployment.id is null or v_target.runtime_target_id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.admin_environment
    where id = true
      and environment = v_deployment.environment
      and project_ref = v_deployment.project_ref
  ) or not exists (
    select 1 from public.admin_reviewed_deployment_capabilities_v1
    where reviewed_deployment_id = v_deployment.id
      and code_capability_id = v_target.code_capability_id
      and code_capability_sha256 = v_target.code_capability_sha256
  ) then
    raise exception 'CANDIDATE_DEPLOYMENT_MISMATCH' using errcode = '23514';
  end if;
  select * into v_version from public.ai_provider_profile_versions
  where id = v_target.profile_version_id;
  select * into v_profile from public.ai_provider_profiles
  where id = v_version.profile_id;
  select * into v_provider from public.ai_providers
  where id = v_target.provider_id;
  select * into v_capability from public.ai_runtime_code_capabilities_v2
  where code_capability_id = v_target.code_capability_id;
  if v_version.id is null or v_profile.id is null or v_provider.id is null
     or v_capability.code_capability_id is null then
    raise exception 'CANDIDATE_DEPLOYMENT_MISMATCH' using errcode = '23514';
  end if;
  return jsonb_build_object(
    'schemaVersion', 'admin_validation_candidate_v1',
    'deployment', jsonb_build_object(
      'id', v_deployment.id,
      'environment', v_deployment.environment,
      'projectRef', v_deployment.project_ref,
      'runtimeBuildId', v_deployment.runtime_build_id,
      'bindingManifestRevision', v_deployment.binding_manifest_revision,
      'bindingManifestSha256', v_deployment.binding_manifest_sha256,
      'validUntil', v_deployment.valid_until
    ),
    'profileExecutionConfig', jsonb_build_object(
      'schemaVersion', v_version.execution_schema_version,
      'profileKey', v_profile.profile_key,
      'providerId', v_provider.id,
      'gatewayKind', v_profile.gateway_kind,
      'adapterKind', v_version.adapter_kind,
      'wireApiKind', v_version.wire_api_kind,
      'endpointUrl', v_version.endpoint_url,
      'credentialEnvName', v_version.credential_env_name,
      'modelId', v_version.model_id,
      'capabilityContractId', v_version.capability_contract_id,
      'cachePolicyId', v_version.cache_policy_id,
      'legalManifestId', v_version.legal_manifest_id,
      'calculatorKind', v_target.calculator_kind,
      'displayDisclosureKey', v_version.display_disclosure_key,
      'config', v_version.config
    ),
    'runtimeTarget', jsonb_build_object(
      'runtimeContractId', v_target.runtime_contract_id,
      'runtimeTargetId', v_target.runtime_target_id,
      'runtimeTargetSha256', v_target.runtime_target_sha256,
      'profileVersionId', v_target.profile_version_id,
      'priceVersionId', v_target.price_version_id,
      'providerId', v_target.provider_id,
      'recipientKey', v_target.recipient_key,
      'codeCapabilityId', v_target.code_capability_id,
      'codeCapabilitySha256', v_target.code_capability_sha256,
      'legalBundleVersion', v_target.legal_bundle_version,
      'legalManifestId', v_target.legal_manifest_id,
      'displayDisclosureKey', v_target.display_disclosure_key
    )
  );
end;
$$;

create function public.record_admin_validation_report_v1(
  p_reviewed_deployment_id uuid,
  p_runtime_contract_id text,
  p_runtime_target_id text,
  p_observed_runtime_build_id text,
  p_observed_binding_manifest_revision text,
  p_observed_binding_manifest_sha256 text,
  p_observed_code_capability_sha256 text,
  p_endpoint_policy_valid boolean,
  p_manifest_binding_valid boolean,
  p_credential_configured boolean,
  p_compiled_capability_valid boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deployment public.admin_reviewed_deployments_v1%rowtype;
  v_target public.ai_runtime_target_bindings_v2%rowtype;
  v_report public.admin_validation_reports_v1%rowtype;
  v_database_binding_valid boolean;
  v_evidence_ids text[];
  v_payload text;
  v_report_sha256 text;
  v_checked_at timestamptz;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_deployment
  from public.admin_reviewed_deployments_v1
  where id = p_reviewed_deployment_id
    and runtime_build_id = p_observed_runtime_build_id
    and binding_manifest_revision = p_observed_binding_manifest_revision
    and binding_manifest_sha256 = p_observed_binding_manifest_sha256
    and valid_until > clock_timestamp()
  for share;
  select * into v_target
  from public.ai_runtime_target_bindings_v2
  where runtime_contract_id = p_runtime_contract_id
    and runtime_target_id = p_runtime_target_id
  for share;
  if v_deployment.id is null or v_target.runtime_target_id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  v_checked_at := clock_timestamp();
  if v_deployment.valid_until <= v_checked_at then
    raise exception 'REVIEWED_DEPLOYMENT_EXPIRED' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.admin_environment
    where id = true
      and environment = v_deployment.environment
      and project_ref = v_deployment.project_ref
  ) or not exists (
    select 1 from public.admin_reviewed_deployment_capabilities_v1
    where reviewed_deployment_id = v_deployment.id
      and code_capability_id = v_target.code_capability_id
      and code_capability_sha256 = v_target.code_capability_sha256
  ) then
    raise exception 'CANDIDATE_DEPLOYMENT_MISMATCH' using errcode = '23514';
  end if;
  if p_observed_code_capability_sha256 is distinct from v_target.code_capability_sha256
     or p_endpoint_policy_valid is null
     or p_manifest_binding_valid is null
     or p_credential_configured is null
     or p_compiled_capability_valid is null then
    raise exception 'OBSERVED_RUNTIME_MISMATCH' using errcode = '23514';
  end if;

  v_database_binding_valid := exists (
    select 1
    from public.ai_service_runtime_contract_versions as contract
    join public.ai_provider_profile_versions as profile
      on profile.id = v_target.profile_version_id
    join public.ai_price_versions as price
      on price.id = v_target.price_version_id
     and price.profile_version_id = profile.id
    join public.ai_legal_display_versions_v2 as display
      on display.display_disclosure_key = v_target.display_disclosure_key
     and display.legal_bundle_version = v_target.legal_bundle_version
     and display.legal_manifest_id = v_target.legal_manifest_id
    where contract.runtime_contract_id = v_target.runtime_contract_id
      and contract.sealed_at is not null
      and profile.execution_schema_version = 'profile_execution_config_v2'
      and price.components_sealed_at is not null
      and display.sealed_at is not null
  );
  select array_agg(distinct evidence_id order by evidence_id)
  into v_evidence_ids
  from unnest(
    v_deployment.reviewed_evidence_ids || v_target.external_evidence_ids
  ) as evidence(evidence_id);
  if cardinality(v_evidence_ids) not between 1 and 96 then
    raise exception 'INVALID_EVIDENCE_SET' using errcode = '23514';
  end if;
  v_payload := concat_ws(E'\n',
    'admin_validation_report_v1', v_deployment.id::text,
    v_deployment.environment, v_deployment.project_ref,
    v_deployment.runtime_build_id, v_deployment.binding_manifest_revision,
    v_deployment.binding_manifest_sha256,
    v_target.runtime_contract_id, v_target.runtime_target_id,
    v_target.runtime_target_sha256, v_target.profile_version_id::text,
    v_target.price_version_id::text, v_target.provider_id::text,
    v_target.code_capability_id, v_target.code_capability_sha256,
    v_target.legal_bundle_version, v_target.legal_manifest_id,
    v_target.display_disclosure_key,
    p_endpoint_policy_valid::text, p_manifest_binding_valid::text,
    p_credential_configured::text, p_compiled_capability_valid::text,
    v_database_binding_valid::text, array_to_string(v_evidence_ids, ',')
  );
  v_report_sha256 := encode(
    extensions.digest(convert_to(v_payload, 'UTF8'), 'sha256'), 'hex'
  );
  insert into public.admin_validation_reports_v1(
    reviewed_deployment_id, environment, project_ref,
    runtime_build_id, binding_manifest_revision, binding_manifest_sha256,
    runtime_contract_id, runtime_target_id, runtime_target_sha256,
    profile_version_id, price_version_id, provider_id,
    code_capability_id, code_capability_sha256,
    legal_bundle_version, legal_manifest_id, display_disclosure_key,
    endpoint_policy_valid, manifest_binding_valid, credential_configured,
    compiled_capability_valid, database_binding_valid, evidence_ids,
    checked_at, expires_at, report_sha256
  ) values (
    v_deployment.id, v_deployment.environment, v_deployment.project_ref,
    v_deployment.runtime_build_id, v_deployment.binding_manifest_revision,
    v_deployment.binding_manifest_sha256,
    v_target.runtime_contract_id, v_target.runtime_target_id,
    v_target.runtime_target_sha256, v_target.profile_version_id,
    v_target.price_version_id, v_target.provider_id,
    v_target.code_capability_id, v_target.code_capability_sha256,
    v_target.legal_bundle_version, v_target.legal_manifest_id,
    v_target.display_disclosure_key,
    p_endpoint_policy_valid, p_manifest_binding_valid,
    p_credential_configured, p_compiled_capability_valid,
    v_database_binding_valid, v_evidence_ids,
    v_checked_at,
    least(v_checked_at + interval '10 minutes', v_deployment.valid_until),
    v_report_sha256
  ) returning * into v_report;
  return jsonb_build_object(
    'schemaVersion', 'admin_validation_report_v1',
    'reportId', v_report.id,
    'reviewedDeploymentId', v_report.reviewed_deployment_id,
    'environment', v_report.environment,
    'projectRef', v_report.project_ref,
    'runtimeBuildId', v_report.runtime_build_id,
    'bindingManifestRevision', v_report.binding_manifest_revision,
    'bindingManifestSha256', v_report.binding_manifest_sha256,
    'runtimeContractId', v_report.runtime_contract_id,
    'runtimeTargetId', v_report.runtime_target_id,
    'runtimeTargetSha256', v_report.runtime_target_sha256,
    'profileVersionId', v_report.profile_version_id,
    'priceVersionId', v_report.price_version_id,
    'providerId', v_report.provider_id,
    'codeCapabilityId', v_report.code_capability_id,
    'codeCapabilitySha256', v_report.code_capability_sha256,
    'legalBundleVersion', v_report.legal_bundle_version,
    'legalManifestId', v_report.legal_manifest_id,
    'displayDisclosureKey', v_report.display_disclosure_key,
    'checks', jsonb_build_object(
      'endpointPolicy', v_report.endpoint_policy_valid,
      'manifestBinding', v_report.manifest_binding_valid,
      'credentialConfigured', v_report.credential_configured,
      'compiledCapability', v_report.compiled_capability_valid,
      'databaseBinding', v_report.database_binding_valid
    ),
    'passed', v_report.passed,
    'evidenceIds', to_jsonb(v_report.evidence_ids),
    'checkedAt', v_report.checked_at,
    'expiresAt', v_report.expires_at,
    'reportSha256', v_report.report_sha256
  );
end;
$$;

create function public.get_admin_runtime_validation_v1(
  p_runtime_contract_id text,
  p_runtime_target_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report public.admin_validation_reports_v1%rowtype;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select report.* into v_report
  from public.admin_validation_reports_v1 as report
  join public.admin_reviewed_deployments_v1 as deployment
    on deployment.id = report.reviewed_deployment_id
   and deployment.environment = report.environment
   and deployment.project_ref = report.project_ref
   and deployment.runtime_build_id = report.runtime_build_id
   and deployment.binding_manifest_revision = report.binding_manifest_revision
   and deployment.binding_manifest_sha256 = report.binding_manifest_sha256
  join public.admin_environment as environment
    on environment.id = true
   and environment.environment = report.environment
   and environment.project_ref = report.project_ref
  where report.runtime_contract_id = p_runtime_contract_id
    and report.runtime_target_id = p_runtime_target_id
    and report.passed
    and report.expires_at > clock_timestamp()
    and deployment.valid_until > clock_timestamp()
  order by report.checked_at desc, report.id desc
  limit 1;
  if not found then return null; end if;
  return jsonb_build_object(
    'schemaVersion', 'runtime_deployment_validation_v1',
    'reportId', v_report.id,
    'reviewedDeploymentId', v_report.reviewed_deployment_id,
    'environment', v_report.environment,
    'projectRef', v_report.project_ref,
    'runtimeBuildId', v_report.runtime_build_id,
    'bindingManifestRevision', v_report.binding_manifest_revision,
    'bindingManifestSha256', v_report.binding_manifest_sha256,
    'runtimeContractId', v_report.runtime_contract_id,
    'runtimeTargetId', v_report.runtime_target_id,
    'runtimeTargetSha256', v_report.runtime_target_sha256,
    'profileVersionId', v_report.profile_version_id,
    'priceVersionId', v_report.price_version_id,
    'providerId', v_report.provider_id,
    'codeCapabilityId', v_report.code_capability_id,
    'codeCapabilitySha256', v_report.code_capability_sha256,
    'legalBundleVersion', v_report.legal_bundle_version,
    'legalManifestId', v_report.legal_manifest_id,
    'displayDisclosureKey', v_report.display_disclosure_key,
    'checkedAt', v_report.checked_at,
    'expiresAt', v_report.expires_at,
    'reportSha256', v_report.report_sha256
  );
end;
$$;

-- Production application entry point. The original v2 function remains for
-- frozen compatibility tests; the application uses v3 so every v2 snapshot
-- carries an unexpired deployment report selected by the database.
create function public.get_ai_polish_execution_snapshot_v3(
  p_reservation_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_snapshot jsonb;
  v_validation jsonb;
begin
  v_snapshot := public.get_ai_polish_execution_snapshot_v2(
    p_reservation_id, p_user_id
  );
  if v_snapshot ->> 'ok' is distinct from 'true'
     or v_snapshot ->> 'schemaVersion' is distinct from
       'ai_polish_execution_snapshot_v2' then
    return v_snapshot;
  end if;
  v_validation := public.get_admin_runtime_validation_v1(
    v_snapshot #>> '{runtimeEvidence,runtimeContractId}',
    v_snapshot #>> '{runtimeEvidence,runtimeTargetId}'
  );
  if v_validation is null then
    return jsonb_build_object(
      'schemaVersion', 'ai_polish_execution_snapshot_v1',
      'ok', false,
      'reason', 'SERVICE_UNAVAILABLE'
    );
  end if;
  return jsonb_set(v_snapshot, '{deploymentValidation}', v_validation);
exception
  when others then
    return jsonb_build_object(
      'schemaVersion', 'ai_polish_execution_snapshot_v1',
      'ok', false,
      'reason', 'SERVICE_UNAVAILABLE'
    );
end;
$$;

revoke all on function public.admin_guard_validation_evidence_v1(),
  public.admin_import_reviewed_deployment_v1(
    uuid, text, text, text, text, text, text[], text[], text, text,
    timestamptz
  ),
  public.get_admin_validation_candidate_v1(uuid, text, text),
  public.record_admin_validation_report_v1(
    uuid, text, text, text, text, text, text,
    boolean, boolean, boolean, boolean
  ),
  public.get_admin_runtime_validation_v1(text, text),
  public.get_ai_polish_execution_snapshot_v3(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_admin_validation_candidate_v1(uuid, text, text),
  public.record_admin_validation_report_v1(
    uuid, text, text, text, text, text, text,
    boolean, boolean, boolean, boolean
  ),
  public.get_admin_runtime_validation_v1(text, text),
  public.get_ai_polish_execution_snapshot_v3(uuid, uuid)
  to service_role;

commit;
