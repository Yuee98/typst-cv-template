-- CFG-005: remove deployment-scoped admission from the active control plane.
-- Historical reviewed-deployment/admission rows and routines are retained for
-- audit/replay only.  New validation evidence is about one immutable runtime
-- target in this environment, not a hand-maintained whole-site build.
begin;

create table public.admin_config_validation_reports_v2 (
  id uuid primary key default extensions.gen_random_uuid(),
  environment text not null check (environment in ('local','preview','production')),
  project_ref text not null check (project_ref ~ '^[a-z0-9-]{1,100}$'),
  runtime_contract_id text not null,
  runtime_target_id text not null,
  runtime_target_sha256 text not null check (runtime_target_sha256 ~ '^[0-9a-f]{64}$'),
  profile_version_id uuid not null,
  price_version_id uuid not null,
  provider_id uuid not null,
  code_capability_id text not null,
  code_capability_sha256 text not null check (code_capability_sha256 ~ '^[0-9a-f]{64}$'),
  legal_bundle_version text not null,
  legal_manifest_id text not null,
  display_disclosure_key text not null,
  endpoint_policy_valid boolean not null,
  credential_binding_valid boolean not null,
  credential_configured boolean not null,
  compiled_capability_valid boolean not null,
  database_binding_valid boolean not null,
  passed boolean generated always as (
    endpoint_policy_valid and credential_binding_valid and credential_configured
    and compiled_capability_valid and database_binding_valid
  ) stored,
  evidence_ids text[] not null,
  checked_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  report_sha256 text not null check (report_sha256 ~ '^[0-9a-f]{64}$'),
  foreign key (runtime_contract_id, runtime_target_id)
    references public.ai_runtime_target_bindings_v2(runtime_contract_id, runtime_target_id)
    on delete restrict,
  foreign key (code_capability_id, code_capability_sha256)
    references public.ai_runtime_code_capabilities_v2(code_capability_id, descriptor_sha256)
    on delete restrict,
  constraint admin_config_validation_reports_v2_window check (
    expires_at > checked_at and expires_at <= checked_at + interval '10 minutes'
  ),
  constraint admin_config_validation_reports_v2_identifiers check (
    runtime_contract_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    and runtime_target_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    and code_capability_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    and legal_bundle_version ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    and legal_manifest_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    and display_disclosure_key ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    and cardinality(evidence_ids) between 1 and 96
  )
);
alter table public.admin_config_validation_reports_v2 enable row level security;
revoke all on public.admin_config_validation_reports_v2 from public, anon, authenticated, service_role;

create function public.admin_guard_config_validation_report_v2()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Configuration validation reports are immutable' using errcode = '23514';
end;
$$;
create trigger admin_config_validation_reports_v2_immutable
before update or delete on public.admin_config_validation_reports_v2
for each row execute function public.admin_guard_config_validation_report_v2();

-- A narrow projection ensures the service validates database-selected config,
-- never caller-supplied endpoint or credential fields.
create function public.get_admin_config_validation_candidate_v2(
  p_runtime_contract_id text, p_runtime_target_id text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_environment public.admin_environment%rowtype;
  v_target public.ai_runtime_target_bindings_v2%rowtype;
  v_version public.ai_provider_profile_versions%rowtype;
  v_profile public.ai_provider_profiles%rowtype;
  v_provider public.ai_providers%rowtype;
  v_price public.ai_price_versions%rowtype;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_environment from public.admin_environment where id = true;
  select * into v_target from public.ai_runtime_target_bindings_v2
    where runtime_contract_id = p_runtime_contract_id and runtime_target_id = p_runtime_target_id;
  if v_environment.id is null or v_target.runtime_target_id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into v_version from public.ai_provider_profile_versions where id = v_target.profile_version_id;
  select * into v_profile from public.ai_provider_profiles where id = v_version.profile_id;
  select * into v_provider from public.ai_providers where id = v_target.provider_id;
  select * into v_price from public.ai_price_versions where id = v_target.price_version_id;
  if v_version.id is null or v_profile.id is null or v_provider.id is null or v_price.id is null then
    raise exception 'CONFIG_TARGET_MISMATCH' using errcode = '23514';
  end if;
  return jsonb_build_object(
    'schemaVersion','admin_config_validation_candidate_v2',
    'environment',v_environment.environment,'projectRef',v_environment.project_ref,
    'profileExecutionConfig',jsonb_build_object(
      'schemaVersion',v_version.execution_schema_version,'profileKey',v_profile.profile_key,
      'providerId',v_provider.id,'gatewayKind',v_profile.gateway_kind,
      'adapterKind',v_version.adapter_kind,'wireApiKind',v_version.wire_api_kind,
      'endpointUrl',v_version.endpoint_url,'credentialEnvName',v_version.credential_env_name,
      'modelId',v_version.model_id,'capabilityContractId',v_version.capability_contract_id,
      'cachePolicyId',v_version.cache_policy_id,'legalManifestId',v_version.legal_manifest_id,
      'calculatorKind',v_price.calculator_kind,'displayDisclosureKey',v_version.display_disclosure_key,
      'config',v_version.config
    ),
    'runtimeTarget',jsonb_build_object(
      'runtimeContractId',v_target.runtime_contract_id,'runtimeTargetId',v_target.runtime_target_id,
      'runtimeTargetSha256',v_target.runtime_target_sha256,'profileVersionId',v_target.profile_version_id,
      'priceVersionId',v_target.price_version_id,'providerId',v_target.provider_id,
      'recipientKey',v_target.recipient_key,'codeCapabilityId',v_target.code_capability_id,
      'codeCapabilitySha256',v_target.code_capability_sha256,
      'legalBundleVersion',v_target.legal_bundle_version,'legalManifestId',v_target.legal_manifest_id,
      'displayDisclosureKey',v_target.display_disclosure_key
    )
  );
end;
$$;

create function public.record_admin_config_validation_report_v2(
  p_runtime_contract_id text, p_runtime_target_id text,
  p_observed_code_capability_sha256 text, p_endpoint_policy_valid boolean,
  p_credential_binding_valid boolean, p_credential_configured boolean,
  p_compiled_capability_valid boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_environment public.admin_environment%rowtype;
  v_target public.ai_runtime_target_bindings_v2%rowtype;
  v_checked_at timestamptz := clock_timestamp();
  v_database_binding_valid boolean;
  v_evidence_ids text[];
  v_report_sha256 text;
  v_report public.admin_config_validation_reports_v2%rowtype;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_environment from public.admin_environment where id = true for share;
  select * into v_target from public.ai_runtime_target_bindings_v2
    where runtime_contract_id = p_runtime_contract_id and runtime_target_id = p_runtime_target_id for share;
  if v_environment.id is null or v_target.runtime_target_id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_observed_code_capability_sha256 is distinct from v_target.code_capability_sha256
     or p_endpoint_policy_valid is null or p_credential_binding_valid is null
     or p_credential_configured is null or p_compiled_capability_valid is null then
    raise exception 'OBSERVED_RUNTIME_MISMATCH' using errcode = '23514';
  end if;
  v_database_binding_valid := exists (
    select 1 from public.ai_service_runtime_contract_versions contract
    join public.ai_provider_profile_versions profile on profile.id=v_target.profile_version_id
    join public.ai_price_versions price on price.id=v_target.price_version_id and price.profile_version_id=profile.id
    join public.ai_legal_display_versions_v2 display on display.display_disclosure_key=v_target.display_disclosure_key
      and display.legal_bundle_version=v_target.legal_bundle_version and display.legal_manifest_id=v_target.legal_manifest_id
    where contract.runtime_contract_id=v_target.runtime_contract_id and contract.sealed_at is not null
      and profile.execution_schema_version='profile_execution_config_v2'
      and price.components_sealed_at is not null and display.sealed_at is not null
  );
  select array_agg(distinct item order by item) into v_evidence_ids
  from (
    select unnest(v_target.external_evidence_ids) as item
    union all
    select unnest(capability.implementation_evidence_ids)
    from public.ai_runtime_code_capabilities_v2 capability
    where capability.code_capability_id=v_target.code_capability_id
      and capability.descriptor_sha256=v_target.code_capability_sha256
    union all
    select unnest(display.evidence_ids)
    from public.ai_legal_display_versions_v2 display
    where display.display_disclosure_key=v_target.display_disclosure_key
      and display.legal_bundle_version=v_target.legal_bundle_version
      and display.legal_manifest_id=v_target.legal_manifest_id
  ) evidence;
  if cardinality(v_evidence_ids) not between 1 and 96 then
    raise exception 'INVALID_EVIDENCE_SET' using errcode = '23514';
  end if;
  v_report_sha256 := encode(extensions.digest(convert_to(concat_ws(E'\n',
    'admin_config_validation_report_v2',v_environment.environment,v_environment.project_ref,
    v_target.runtime_contract_id,v_target.runtime_target_id,v_target.runtime_target_sha256,
    v_target.profile_version_id::text,v_target.price_version_id::text,v_target.provider_id::text,
    v_target.code_capability_id,v_target.code_capability_sha256,v_target.legal_bundle_version,
    v_target.legal_manifest_id,v_target.display_disclosure_key,
    p_endpoint_policy_valid::text,p_credential_binding_valid::text,p_credential_configured::text,
    p_compiled_capability_valid::text,v_database_binding_valid::text,array_to_string(v_evidence_ids,','),
    to_char(v_checked_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ),'UTF8'),'sha256'),'hex');
  insert into public.admin_config_validation_reports_v2(
    environment,project_ref,runtime_contract_id,runtime_target_id,runtime_target_sha256,
    profile_version_id,price_version_id,provider_id,code_capability_id,code_capability_sha256,
    legal_bundle_version,legal_manifest_id,display_disclosure_key,endpoint_policy_valid,
    credential_binding_valid,credential_configured,compiled_capability_valid,database_binding_valid,
    evidence_ids,checked_at,expires_at,report_sha256
  ) values (
    v_environment.environment,v_environment.project_ref,v_target.runtime_contract_id,v_target.runtime_target_id,v_target.runtime_target_sha256,
    v_target.profile_version_id,v_target.price_version_id,v_target.provider_id,v_target.code_capability_id,v_target.code_capability_sha256,
    v_target.legal_bundle_version,v_target.legal_manifest_id,v_target.display_disclosure_key,p_endpoint_policy_valid,
    p_credential_binding_valid,p_credential_configured,p_compiled_capability_valid,v_database_binding_valid,
    v_evidence_ids,v_checked_at,v_checked_at+interval '10 minutes',v_report_sha256
  ) returning * into v_report;
  return jsonb_build_object(
    'schemaVersion','admin_config_validation_report_v2','reportId',v_report.id,
    'environment',v_report.environment,'projectRef',v_report.project_ref,
    'runtimeContractId',v_report.runtime_contract_id,'runtimeTargetId',v_report.runtime_target_id,
    'runtimeTargetSha256',v_report.runtime_target_sha256,'profileVersionId',v_report.profile_version_id,
    'priceVersionId',v_report.price_version_id,'providerId',v_report.provider_id,
    'codeCapabilityId',v_report.code_capability_id,'codeCapabilitySha256',v_report.code_capability_sha256,
    'legalBundleVersion',v_report.legal_bundle_version,'legalManifestId',v_report.legal_manifest_id,
    'displayDisclosureKey',v_report.display_disclosure_key,'passed',v_report.passed,
    'checks',jsonb_build_object(
      'endpointPolicy',v_report.endpoint_policy_valid,
      'credentialBinding',v_report.credential_binding_valid,
      'credentialConfigured',v_report.credential_configured,
      'compiledCapability',v_report.compiled_capability_valid,
      'databaseBinding',v_report.database_binding_valid),
    'evidenceIds',to_jsonb(v_report.evidence_ids),
    'checkedAt',v_report.checked_at,'expiresAt',v_report.expires_at,'reportSha256',v_report.report_sha256
  );
end;
$$;

create function public.admin_assert_policy_config_reports_v1(
  p_policy_version_id uuid,p_validation_report_ids uuid[],p_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_policy public.ai_routing_policy_versions%rowtype;
  v_environment public.admin_environment%rowtype;
  v_routes jsonb;
  v_ids uuid[];
begin
  if p_at is null or p_validation_report_ids is null or cardinality(p_validation_report_ids) not between 1 and 64
     or cardinality(p_validation_report_ids) is distinct from (select count(distinct id) from unnest(p_validation_report_ids) id) then
    raise exception 'INVALID_REQUEST' using errcode='22023';
  end if;
  select * into v_policy from public.ai_routing_policy_versions where id=p_policy_version_id;
  select * into v_environment from public.admin_environment where id=true;
  if v_policy.id is null or v_environment.id is null then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  v_routes:=public.admin_policy_effective_routes_v1(v_policy.id);
  if jsonb_array_length(v_routes) is distinct from cardinality(p_validation_report_ids) then
    raise exception 'VALIDATION_REPORT_MISMATCH' using errcode='23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_routes) route(value)
    where (select count(*) from public.admin_config_validation_reports_v2 report
      where report.id=any(p_validation_report_ids) and report.passed and report.expires_at>p_at
        and report.environment=v_environment.environment and report.project_ref=v_environment.project_ref
        and report.runtime_contract_id=v_policy.runtime_contract_id and report.legal_bundle_version=v_policy.legal_bundle_version
        and report.runtime_target_id=route.value->>'runtimeTargetId'
        and report.runtime_target_sha256=route.value->>'runtimeTargetSha256'
        and report.profile_version_id::text=route.value->>'profileVersionId'
        and report.price_version_id::text=route.value->>'priceVersionId'
        and report.provider_id::text=route.value->>'providerId'
        and report.code_capability_id=route.value->>'codeCapabilityId'
        and report.code_capability_sha256=route.value->>'codeCapabilitySha256'
        and report.legal_manifest_id=route.value->>'legalManifestId'
        and report.display_disclosure_key=route.value->>'displayDisclosureKey') <> 1
  ) then raise exception 'VALIDATION_REPORT_ROUTE_BIJECTION_MISMATCH' using errcode='23514'; end if;
  select array_agg(id order by id) into v_ids from unnest(p_validation_report_ids) id;
  return jsonb_build_object('schemaVersion','admin_policy_config_validation_v1',
    'environment',v_environment.environment,'projectRef',v_environment.project_ref,
    'policyVersionId',v_policy.id,'legalBundleVersion',v_policy.legal_bundle_version,
    'validationReportIds',to_jsonb(v_ids),'effectiveRoutes',v_routes,
    'expiresAt',(select min(expires_at) from public.admin_config_validation_reports_v2 where id=any(p_validation_report_ids)));
end;
$$;

-- V3 execution permits either historical V2 provenance or the successor
-- format with no provenance.  Historical attempt rows remain valid evidence.
alter table public.ai_provider_attempt_ledger drop constraint ai_attempt_execution_branch_check;
alter table public.ai_provider_attempt_ledger add constraint ai_attempt_execution_branch_check check (coalesce(
  (execution_schema_version='profile_execution_config_v1' and endpoint_url is null and credential_env_name is null
    and endpoint_alias is not null and credential_alias is not null and runtime_build_id is null and binding_manifest_revision is null)
  or (execution_schema_version='profile_execution_config_v2' and endpoint_alias is null and credential_alias is null
    and public.ai_endpoint_shape_v2(endpoint_url) and credential_env_name is not null
    and credential_env_name ~ '^AI_PROVIDER_KEY_[A-Z0-9_]{1,160}$'
    and ((runtime_build_id is null and binding_manifest_revision is null)
      or (runtime_build_id ~ '^[a-z0-9][a-z0-9._:-]{0,199}$'
        and binding_manifest_revision ~ '^[a-z0-9][a-z0-9._-]{0,199}$'))),false));

-- The successor snapshot only authenticates the immutable DB target against
-- the frozen reservation.  It deliberately does not use report freshness.
create function public.get_ai_polish_execution_snapshot_v5(
  p_reservation_id uuid,p_user_id uuid,p_environment text,p_project_ref text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_snapshot jsonb; v_environment public.admin_environment%rowtype;
  v_target public.ai_runtime_target_bindings_v2%rowtype;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  -- Do not infer legacy identity from a successor envelope.  A frozen V1
  -- reservation must remain readable before Admin bootstrap, even when a
  -- later wrapper changes its envelope shape.
  if exists (
    select 1
    from public.ai_request_ledger request
    join public.ai_provider_profile_versions version on version.id=request.profile_version_id
    where request.reservation_id=p_reservation_id
      and request.user_id=p_user_id
      and version.execution_schema_version='profile_execution_config_v1'
  ) then
    return public.get_ai_polish_execution_snapshot_v1(p_reservation_id,p_user_id);
  end if;
  v_snapshot:=public.get_ai_polish_execution_snapshot_v2(p_reservation_id,p_user_id);
  -- V1 reservations never enter the Admin/config branch and must remain
  -- usable before an Admin environment is bootstrapped.
  if v_snapshot->>'ok' is distinct from 'true' or v_snapshot->>'schemaVersion' is distinct from 'ai_polish_execution_snapshot_v2' then return v_snapshot; end if;
  select * into v_environment from public.admin_environment where id=true;
  if v_environment.id is null or (v_environment.environment,v_environment.project_ref) is distinct from (p_environment,p_project_ref) then
    return jsonb_build_object('schemaVersion','ai_polish_execution_snapshot_v1','ok',false,'reason','SERVICE_UNAVAILABLE');
  end if;
  perform public.admin_assert_runtime_authority_receipt_v3(p_environment,p_project_ref);
  select * into v_target from public.ai_runtime_target_bindings_v2 where runtime_contract_id=v_snapshot#>>'{runtimeEvidence,runtimeContractId}' and runtime_target_id=v_snapshot#>>'{runtimeEvidence,runtimeTargetId}';
  if v_target.runtime_target_id is null or (v_target.runtime_target_sha256,v_target.profile_version_id::text,v_target.price_version_id::text,v_target.provider_id::text,v_target.code_capability_id,v_target.code_capability_sha256,v_target.legal_bundle_version,v_target.legal_manifest_id,v_target.display_disclosure_key) is distinct from (v_snapshot#>>'{runtimeEvidence,runtimeTargetSha256}',v_snapshot#>>'{runtimeEvidence,profileVersionId}',v_snapshot#>>'{runtimeEvidence,priceVersionId}',v_snapshot#>>'{runtimeEvidence,providerId}',v_snapshot#>>'{runtimeEvidence,codeCapabilityId}',v_snapshot#>>'{runtimeEvidence,codeCapabilitySha256}',v_snapshot#>>'{runtimeEvidence,legalBundleVersion}',v_snapshot#>>'{runtimeEvidence,legalManifestId}',v_snapshot#>>'{runtimeEvidence,displayDisclosureKey}') then
    return jsonb_build_object('schemaVersion','ai_polish_execution_snapshot_v1','ok',false,'reason','SERVICE_UNAVAILABLE');
  end if;
  return jsonb_set(jsonb_set(v_snapshot - 'deploymentValidation','{schemaVersion}',to_jsonb('ai_polish_execution_snapshot_v3'::text)),'{runtimeConfigReceipt}',jsonb_build_object(
    'schemaVersion','runtime_config_receipt_v1','environment',v_environment.environment,'projectRef',v_environment.project_ref,
    'runtimeContractId',v_target.runtime_contract_id,'runtimeTargetId',v_target.runtime_target_id,'runtimeTargetSha256',v_target.runtime_target_sha256,
    'profileVersionId',v_target.profile_version_id,'priceVersionId',v_target.price_version_id,'providerId',v_target.provider_id,
    'codeCapabilityId',v_target.code_capability_id,'codeCapabilitySha256',v_target.code_capability_sha256,
    'legalBundleVersion',v_target.legal_bundle_version,'legalManifestId',v_target.legal_manifest_id,'displayDisclosureKey',v_target.display_disclosure_key));
exception when others then return jsonb_build_object('schemaVersion','ai_polish_execution_snapshot_v1','ok',false,'reason','SERVICE_UNAVAILABLE'); end;
$$;

-- Clone the V2 start implementation's quota, retry and ledger serialization
-- into an internal successor.  The V2 routine itself remains untouched for
-- historical callers and exact replay semantics.
do $rewrite_start$
declare v_body text;
begin
  v_body := pg_catalog.pg_get_functiondef(
    'public.start_ai_polish_provider_attempt_v2(uuid,integer,text,text)'::regprocedure
  );
  v_body := replace(v_body,
    E'  if p_runtime_build_id is null\n     or p_runtime_build_id !~ ''^[a-z0-9][a-z0-9._:-]{0,199}$''\n     or p_binding_manifest_revision is null\n     or p_binding_manifest_revision !~ ''^[a-z0-9][a-z0-9._-]{0,199}$'' then\n    raise exception ''v2 execution provenance is malformed'' using errcode = ''22023'';\n  end if;\n\n','');
  v_body := replace(v_body,
    E'    if v_attempt.execution_schema_version is distinct from ''profile_execution_config_v2''\n       or v_attempt.runtime_build_id is distinct from p_runtime_build_id\n       or v_attempt.binding_manifest_revision is distinct from p_binding_manifest_revision then',
    E'    if v_attempt.execution_schema_version is distinct from ''profile_execution_config_v2''\n       or v_attempt.runtime_build_id is not null\n       or v_attempt.binding_manifest_revision is not null then');
  if position('v2 execution provenance is malformed' in v_body) > 0
     or position('v_attempt.runtime_build_id is distinct from p_runtime_build_id' in v_body) > 0 then
    raise exception 'CFG-005 start successor rewrite failed' using errcode='23514';
  end if;
  v_body := 'create or replace function public.start_ai_polish_provider_attempt_v5_internal('
    || 'p_reservation_id uuid, p_attempt_no integer) ' || substr(v_body, position('RETURNS jsonb' in v_body));
  v_body := replace(v_body, E'    p_runtime_build_id,\n    p_binding_manifest_revision,', E'    null,\n    null,');
  if position('p_runtime_build_id' in v_body) > 0 or position('p_binding_manifest_revision' in v_body) > 0 then
    raise exception 'CFG-005 start successor provenance rewrite failed' using errcode='23514';
  end if;
  execute v_body;
end;
$rewrite_start$;

create function public.start_ai_polish_provider_attempt_v5(
  p_reservation_id uuid,p_attempt_no integer,p_runtime_config_receipt jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_request public.ai_request_ledger%rowtype;
  v_environment public.admin_environment%rowtype;
  v_target public.ai_runtime_target_bindings_v2%rowtype;
  v_attempt public.ai_provider_attempt_ledger%rowtype;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  if p_attempt_no not in (1,2) then
    raise exception 'runtime configuration receipt is malformed' using errcode='22023';
  end if;
  select * into v_request from public.ai_request_ledger where reservation_id=p_reservation_id for update;
  if not found then return jsonb_build_object('ok',false,'reason','NOT_FOUND'); end if;
  if exists (select 1 from public.ai_provider_profile_versions version where version.id=v_request.profile_version_id and version.execution_schema_version='profile_execution_config_v1') then
    return public.start_ai_polish_provider_attempt(p_reservation_id,p_attempt_no);
  end if;
  if jsonb_typeof(p_runtime_config_receipt) is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_runtime_config_receipt)) <> 14
     or p_runtime_config_receipt->>'schemaVersion' is distinct from 'runtime_config_receipt_v1' then
    raise exception 'runtime configuration receipt is malformed' using errcode='22023';
  end if;
  select * into v_environment from public.admin_environment where id=true for share;
  perform public.admin_assert_runtime_authority_receipt_v3(
    p_runtime_config_receipt->>'environment',p_runtime_config_receipt->>'projectRef'
  );
  select * into v_target from public.ai_runtime_target_bindings_v2
    where runtime_contract_id=p_runtime_config_receipt->>'runtimeContractId'
      and runtime_target_id=p_runtime_config_receipt->>'runtimeTargetId' for share;
  if v_environment.id is null or v_target.runtime_target_id is null
     or (p_runtime_config_receipt->>'environment',p_runtime_config_receipt->>'projectRef',
         p_runtime_config_receipt->>'runtimeTargetSha256',p_runtime_config_receipt->>'profileVersionId',
         p_runtime_config_receipt->>'priceVersionId',p_runtime_config_receipt->>'providerId',
         p_runtime_config_receipt->>'codeCapabilityId',p_runtime_config_receipt->>'codeCapabilitySha256',
         p_runtime_config_receipt->>'legalBundleVersion',p_runtime_config_receipt->>'legalManifestId',
         p_runtime_config_receipt->>'displayDisclosureKey') is distinct from
        (v_environment.environment,v_environment.project_ref,v_target.runtime_target_sha256,v_target.profile_version_id::text,
         v_target.price_version_id::text,v_target.provider_id::text,v_target.code_capability_id,v_target.code_capability_sha256,
         v_target.legal_bundle_version,v_target.legal_manifest_id,v_target.display_disclosure_key)
     or (v_request.runtime_contract_id,v_request.profile_version_id,v_request.price_version_id,v_request.legal_bundle_version,
         v_request.display_disclosure_key) is distinct from
        (v_target.runtime_contract_id,v_target.profile_version_id,v_target.price_version_id,v_target.legal_bundle_version,
         v_target.display_disclosure_key) then
    return jsonb_build_object('ok',false,'reason','SERVICE_UNAVAILABLE');
  end if;
  select * into v_attempt from public.ai_provider_attempt_ledger
    where reservation_id=p_reservation_id and attempt_no=p_attempt_no;
  if v_attempt.attempt_id is not null and (v_attempt.runtime_build_id is not null or v_attempt.binding_manifest_revision is not null) then
    return jsonb_build_object('ok',false,'reason','SERVICE_UNAVAILABLE');
  end if;
  return public.start_ai_polish_provider_attempt_v5_internal(p_reservation_id,p_attempt_no);
end;
$$;

create table public.admin_runtime_readback_reports_v2 (
  id uuid primary key default extensions.gen_random_uuid(),
  environment text not null check (environment in ('local','preview','production')),
  project_ref text not null check (project_ref ~ '^[a-z0-9-]{1,100}$'),
  closing_cycle_id uuid not null,
  control_revision bigint not null check (control_revision > 0),
  config_generation bigint not null check (config_generation >= 0),
  policy_version_id uuid not null references public.ai_routing_policy_versions(id) on delete restrict,
  legal_bundle_version text not null,
  validation_report_ids uuid[] not null,
  effective_routes jsonb not null,
  effective_routes_sha256 text not null check (effective_routes_sha256 ~ '^[0-9a-f]{64}$'),
  checked_at timestamptz not null,
  expires_at timestamptz not null,
  report_sha256 text not null check (report_sha256 ~ '^[0-9a-f]{64}$'),
  constraint admin_runtime_readback_reports_v2_window check (expires_at>checked_at and expires_at<=checked_at+interval '10 minutes'),
  constraint admin_runtime_readback_reports_v2_ids check (cardinality(validation_report_ids) between 1 and 64)
);
alter table public.admin_runtime_readback_reports_v2 enable row level security;
revoke all on public.admin_runtime_readback_reports_v2 from public,anon,authenticated,service_role;
create function public.admin_guard_runtime_readback_report_v2() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'Runtime readback reports are immutable' using errcode='23514'; end; $$;
create trigger admin_runtime_readback_reports_v2_immutable before update or delete on public.admin_runtime_readback_reports_v2 for each row execute function public.admin_guard_runtime_readback_report_v2();

create function public.get_admin_runtime_readback_candidate_v3(
  p_policy_version_id uuid,p_validation_report_ids uuid[],p_environment text,p_project_ref text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_config public.ai_feature_config%rowtype; v_control public.admin_ai_control_state_v1%rowtype;
  v_environment public.admin_environment%rowtype; v_policy public.ai_routing_policy_versions%rowtype;
  v_evidence jsonb; v_candidates jsonb;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  -- Match the environment -> feature -> control order of authenticated writes.
  select * into v_environment from public.admin_environment where id=true for share;
  select * into v_config from public.ai_feature_config where id=true for share;
  select * into v_control from public.admin_ai_control_state_v1 where id=true for share;
  select * into v_policy from public.ai_routing_policy_versions where id=p_policy_version_id for share;
  if v_config.id is null or v_control.id is null or v_environment.id is null or v_policy.id is null
     or (v_environment.environment,v_environment.project_ref) is distinct from (p_environment,p_project_ref)
     or v_config.ai_polish_enabled or v_config.active_routing_policy_version_id is distinct from v_policy.id
     or v_control.closing_cycle_id is null or v_control.reopened_at is not null
     or v_policy.legal_bundle_version is distinct from public.current_ai_terms_version() then
    raise exception 'READBACK_NOT_READY' using errcode='23514';
  end if;
  perform public.admin_assert_runtime_authority_receipt_v3(p_environment,p_project_ref);
  v_evidence:=public.admin_assert_policy_config_reports_v1(v_policy.id,p_validation_report_ids,clock_timestamp());
  select jsonb_agg(jsonb_build_object(
    'schemaVersion','admin_config_validation_candidate_v2','environment',v_environment.environment,'projectRef',v_environment.project_ref,
    'profileExecutionConfig',jsonb_build_object('schemaVersion',version.execution_schema_version,'profileKey',profile.profile_key,'providerId',provider.id,'gatewayKind',profile.gateway_kind,'adapterKind',version.adapter_kind,'wireApiKind',version.wire_api_kind,'endpointUrl',version.endpoint_url,'credentialEnvName',version.credential_env_name,'modelId',version.model_id,'capabilityContractId',version.capability_contract_id,'cachePolicyId',version.cache_policy_id,'legalManifestId',version.legal_manifest_id,'calculatorKind',price.calculator_kind,'displayDisclosureKey',version.display_disclosure_key,'config',version.config),
    'runtimeTarget',jsonb_build_object('runtimeContractId',target.runtime_contract_id,'runtimeTargetId',target.runtime_target_id,'runtimeTargetSha256',target.runtime_target_sha256,'profileVersionId',target.profile_version_id,'priceVersionId',target.price_version_id,'providerId',target.provider_id,'recipientKey',target.recipient_key,'codeCapabilityId',target.code_capability_id,'codeCapabilitySha256',target.code_capability_sha256,'legalBundleVersion',target.legal_bundle_version,'legalManifestId',target.legal_manifest_id,'displayDisclosureKey',target.display_disclosure_key)
  ) order by target.runtime_target_id) into v_candidates
  from jsonb_array_elements(v_evidence->'effectiveRoutes') route(value)
  join public.ai_runtime_target_bindings_v2 target on target.runtime_contract_id=v_policy.runtime_contract_id and target.runtime_target_id=route.value->>'runtimeTargetId'
  join public.ai_provider_profile_versions version on version.id=target.profile_version_id
  join public.ai_provider_profiles profile on profile.id=version.profile_id
  join public.ai_providers provider on provider.id=target.provider_id
  join public.ai_price_versions price on price.id=target.price_version_id;
  return jsonb_build_object('schemaVersion','admin_runtime_readback_candidate_v3','environment',v_environment.environment,'projectRef',v_environment.project_ref,'closingCycleId',v_control.closing_cycle_id,'controlRevision',v_control.revision::text,'configGeneration',v_config.config_generation::text,'policyVersionId',v_policy.id,'legalBundleVersion',v_policy.legal_bundle_version,'validationReportIds',v_evidence->'validationReportIds','effectiveRoutes',v_evidence->'effectiveRoutes','candidates',coalesce(v_candidates,'[]'::jsonb));
end;
$$;

create function public.record_admin_runtime_readback_v3(
  p_environment text,p_project_ref text,p_policy_version_id uuid,p_validation_report_ids uuid[],
  p_expected_closing_cycle_id uuid,p_expected_control_revision bigint,p_expected_config_generation bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_now timestamptz; v_config public.ai_feature_config%rowtype; v_control public.admin_ai_control_state_v1%rowtype;
  v_environment public.admin_environment%rowtype; v_policy public.ai_routing_policy_versions%rowtype; v_evidence jsonb;
  v_ids uuid[]; v_routes jsonb; v_routes_sha text; v_expires timestamptz; v_hash text; v_report public.admin_runtime_readback_reports_v2%rowtype;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into v_environment from public.admin_environment where id=true for share;
  select * into v_config from public.ai_feature_config where id=true for share;
  select * into v_control from public.admin_ai_control_state_v1 where id=true for share;
  select * into v_policy from public.ai_routing_policy_versions where id=p_policy_version_id for share;
  if v_config.id is null or v_control.id is null or v_environment.id is null or v_policy.id is null
     or (v_environment.environment,v_environment.project_ref) is distinct from (p_environment,p_project_ref)
     or v_config.ai_polish_enabled or v_config.active_routing_policy_version_id is distinct from p_policy_version_id
     or v_control.closing_cycle_id is distinct from p_expected_closing_cycle_id or v_control.reopened_at is not null
     or v_control.revision is distinct from p_expected_control_revision or v_config.config_generation is distinct from p_expected_config_generation
     or v_policy.legal_bundle_version is distinct from public.current_ai_terms_version() then raise exception 'READBACK_NOT_READY' using errcode='23514'; end if;
  perform public.admin_assert_runtime_authority_receipt_v3(p_environment,p_project_ref);
  v_now:=clock_timestamp();
  v_evidence:=public.admin_assert_policy_config_reports_v1(v_policy.id,p_validation_report_ids,v_now);
  v_now:=clock_timestamp();
  select array_agg(id order by id) into v_ids from unnest(p_validation_report_ids) id;
  v_routes:=v_evidence->'effectiveRoutes'; v_routes_sha:=encode(extensions.digest(convert_to(v_routes::text,'UTF8'),'sha256'),'hex');
  v_expires:=least(v_now+interval '10 minutes',(v_evidence->>'expiresAt')::timestamptz);
  if v_expires<=v_now then raise exception 'READBACK_NOT_READY' using errcode='23514'; end if;
  v_hash:=encode(extensions.digest(convert_to(concat_ws(E'\n','admin_runtime_readback_v3',v_environment.environment,v_environment.project_ref,v_control.closing_cycle_id::text,v_control.revision::text,v_config.config_generation::text,v_policy.id::text,v_policy.legal_bundle_version,array_to_string(v_ids,','),v_routes_sha,to_char(v_now at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),to_char(v_expires at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),'UTF8'),'sha256'),'hex');
  insert into public.admin_runtime_readback_reports_v2(environment,project_ref,closing_cycle_id,control_revision,config_generation,policy_version_id,legal_bundle_version,validation_report_ids,effective_routes,effective_routes_sha256,checked_at,expires_at,report_sha256) values (v_environment.environment,v_environment.project_ref,v_control.closing_cycle_id,v_control.revision,v_config.config_generation,v_policy.id,v_policy.legal_bundle_version,v_ids,v_routes,v_routes_sha,v_now,v_expires,v_hash) returning * into v_report;
  return jsonb_build_object('schemaVersion','admin_runtime_readback_v3','reportId',v_report.id,'environment',v_report.environment,'projectRef',v_report.project_ref,'closingCycleId',v_report.closing_cycle_id,'controlRevision',v_report.control_revision::text,'configGeneration',v_report.config_generation::text,'policyVersionId',v_report.policy_version_id,'legalBundleVersion',v_report.legal_bundle_version,'validationReportIds',to_jsonb(v_report.validation_report_ids),'effectiveRoutes',v_report.effective_routes,'checkedAt',v_report.checked_at,'expiresAt',v_report.expires_at,'reportSha256',v_report.report_sha256);
end;
$$;

-- Cutover is a database-authority transition, not publication.  It can run
-- with an empty active pointer (fresh bootstrap) or with a legacy V1 pointer;
-- neither state has a V2 target report yet.  Optional reports are still
-- checked exactly when supplied, while publication/readback enforce target
-- freshness later.
create function public.admin_cutover_authority_v3(
  p_validation_report_ids uuid[],p_expected_environment_revision bigint,
  p_expected_control_revision bigint,p_reason text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_environment public.admin_environment%rowtype; v_config public.ai_feature_config%rowtype;
  v_control public.admin_ai_control_state_v1%rowtype; v_policy public.ai_routing_policy_versions%rowtype;
  v_evidence jsonb; v_cycle uuid:=extensions.gen_random_uuid(); v_audit uuid;
  v_routines jsonb; v_manifest jsonb; v_manifest_sha256 text; v_receipt uuid;
  v_authority_epoch bigint;
begin
  if session_user not in ('postgres','supabase_admin') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if p_reason is null or p_reason<>btrim(p_reason) or length(p_reason) not between 1 and 500 then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(172911,8);
  select * into v_environment from public.admin_environment where id=true for update;
  select * into v_config from public.ai_feature_config where id=true for update;
  select * into v_control from public.admin_ai_control_state_v1 where id=true for update;
  if v_environment.id is null or v_config.id is null or v_control.id is null
     or v_environment.control_plane_mode is distinct from 'legacy'
     or v_environment.revision is distinct from p_expected_environment_revision
     or v_control.revision is distinct from p_expected_control_revision
     or v_config.ai_polish_enabled
     or not exists (select 1 from public.admin_principals principal join auth.users account on account.id=principal.user_id where principal.revoked_at is null and account.deleted_at is null and not coalesce(account.is_anonymous,false) and (account.banned_until is null or account.banned_until<=clock_timestamp()) and (account.email_confirmed_at is not null or account.phone_confirmed_at is not null)) then
    raise exception 'CUTOVER_NOT_READY' using errcode='23514';
  end if;
  if v_config.active_routing_policy_version_id is not null then
    select * into v_policy from public.ai_routing_policy_versions where id=v_config.active_routing_policy_version_id for update;
    if not found or v_policy.status not in ('canary','active') or v_policy.legal_bundle_version is distinct from public.current_ai_terms_version() then raise exception 'CUTOVER_NOT_READY' using errcode='23514'; end if;
  end if;
  if coalesce(cardinality(p_validation_report_ids),0)>0 then
    if v_policy.id is null then raise exception 'CUTOVER_NOT_READY' using errcode='23514'; end if;
    v_evidence:=public.admin_assert_policy_config_reports_v1(v_policy.id,p_validation_report_ids,clock_timestamp());
  else
    v_evidence:=jsonb_build_object('validationReportIds','[]'::jsonb);
  end if;
  if to_regprocedure('public.get_ai_polish_execution_snapshot_v5(uuid,uuid,text,text)') is null
     or to_regprocedure('public.start_ai_polish_provider_attempt_v5(uuid,integer,jsonb)') is null
     or to_regprocedure('public.record_admin_runtime_readback_v3(text,text,uuid,uuid[],uuid,bigint,bigint)') is null
     or to_regprocedure('public.admin_reopen_ai_v2(text,text,uuid,uuid,bigint,uuid,bigint,text,uuid)') is null
     or to_regprocedure('public.admin_set_ai_routing_pointer_v2(text,text,uuid,uuid[],bigint,uuid,bigint,text,uuid)') is null
     or to_regprocedure('public.admin_clear_ai_routing_pointer_v2(text,text,uuid[],bigint,uuid,bigint,text,uuid)') is null
     or to_regprocedure('public.admin_seal_price_for_activation_v2(text,text,uuid,text,text,uuid)') is null
     or to_regprocedure('public.admin_transition_profile_version_v2(text,text,uuid,text,uuid,text,uuid)') is null
     or to_regprocedure('public.admin_create_routing_policy_v2(text,text,text,integer,jsonb,uuid,text,text,uuid[],text,uuid)') is null
     or to_regprocedure('public.admin_transition_routing_policy_v2(text,text,uuid,text,uuid[],text,uuid)') is null
     or to_regprocedure('public.admin_close_price_version_v2(text,text,uuid,timestamptz,uuid,uuid,text,uuid)') is null
      or to_regprocedure('public.admin_retire_profile_version_v2(text,text,uuid,uuid,text,uuid)') is null
      or to_regprocedure('public.admin_retire_provider_profile_v2(text,text,uuid,uuid,text,uuid)') is null
      or to_regprocedure('public.lock_and_validate_ai_routing_policy_candidate_v2(public.ai_routing_policy_versions,text,timestamptz)') is null
      or to_regprocedure('public.admin_assert_candidate_policy_config_reports_v2(public.ai_routing_policy_versions,uuid[],timestamptz)') is null then raise exception 'CUTOVER_SCHEMA_MISMATCH' using errcode='23514'; end if;
  revoke all on function public.start_ai_polish_provider_attempt(uuid,integer) from public,anon,authenticated,service_role;
  revoke all on function public.start_ai_polish_provider_attempt_v2(uuid,integer,text,text) from public,anon,authenticated,service_role;
  revoke all on function public.start_ai_polish_provider_attempt_v3(uuid,integer,uuid,uuid,uuid,text,text,text,text,text,bigint,text,text,text,text) from public,anon,authenticated,service_role;
  revoke all on function public.start_ai_polish_provider_attempt_v4(uuid,integer,jsonb) from public,anon,authenticated,service_role;
  revoke all on function public.get_ai_polish_execution_snapshot_v1(uuid,uuid) from public,anon,authenticated,service_role;
  revoke all on function public.get_ai_polish_execution_snapshot_v2(uuid,uuid) from public,anon,authenticated,service_role;
  revoke all on function public.get_ai_polish_execution_snapshot_v3(uuid,uuid) from public,anon,authenticated,service_role;
  revoke all on function public.get_ai_polish_execution_snapshot_v4(uuid,uuid,text,text,text,text,text) from public,anon,authenticated,service_role;
  revoke all on function public.transition_ai_routing_policy_v2(uuid,text,text,text,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
  revoke all on function public.set_ai_routing_policy_pointer_v1(uuid,text,text,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
  revoke all on function public.clear_ai_routing_policy_pointer_v1(uuid,text,text,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
  revoke all on function public.retire_ai_provider_profile_version_v1(uuid,text,text,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
  revoke all on function public.retire_ai_provider_profile_v1(uuid,text,text,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
  revoke all on function public.close_ai_price_version_v1(uuid,timestamptz,uuid,text,text,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
  revoke all on function public.transition_ai_provider_profile_version_v1(uuid,text,text,text,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
  revoke all on function public.create_ai_routing_policy_version_v1(uuid,text,integer,text,jsonb,uuid,text,text,text,text,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
  revoke all on function public.admin_seal_price_for_activation_v1(text,text,uuid,text,uuid,text,uuid),
    public.admin_transition_profile_version_v1(text,text,uuid,text,uuid,text,uuid),
    public.admin_create_routing_policy_v1(text,text,text,integer,jsonb,uuid,text,text,uuid[],text,uuid),
    public.admin_transition_routing_policy_v1(text,text,uuid,text,uuid[],text,uuid),
    public.admin_close_price_version_v1(text,text,uuid,timestamptz,uuid,uuid,text,uuid),
    public.admin_retire_profile_version_v1(text,text,uuid,uuid,text,uuid),
    public.admin_retire_provider_profile_v1(text,text,uuid,uuid,text,uuid),
    public.admin_set_ai_routing_pointer_v1(text,text,uuid,uuid[],bigint,uuid,bigint,text,uuid),
    public.admin_clear_ai_routing_pointer_v1(text,text,uuid[],bigint,uuid,bigint,text,uuid),
    public.admin_reopen_ai_v1(text,text,uuid,uuid,bigint,uuid,bigint,text,uuid),
    public.record_admin_validation_report_v1(uuid,text,text,text,text,text,text,boolean,boolean,boolean,boolean),
    public.record_admin_runtime_readback_v1(uuid,uuid,uuid[],text,text,text),
    public.record_admin_runtime_readback_v2(uuid,uuid,bigint,text,uuid,uuid[],text,text,text)
    from public,anon,authenticated,service_role;
  revoke all on function public.seal_ai_price_for_activation_v1(uuid,text,text,text,timestamptz,timestamptz,jsonb,jsonb,text,text,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
  revoke update(ai_polish_enabled,global_daily_limit,enabled_user_allowlist) on public.ai_feature_config from service_role;
  if pg_catalog.has_column_privilege('service_role','public.ai_feature_config','ai_polish_enabled','UPDATE')
     or pg_catalog.has_column_privilege('service_role','public.ai_feature_config','global_daily_limit','UPDATE')
     or pg_catalog.has_column_privilege('service_role','public.ai_feature_config','enabled_user_allowlist','UPDATE') then
    raise exception 'CUTOVER_AUTHORITY_MISMATCH' using errcode='23514';
  end if;
  grant execute on function public.start_ai_polish_provider_attempt_v5(uuid,integer,jsonb),public.get_ai_polish_execution_snapshot_v5(uuid,uuid,text,text) to service_role;
  update public.admin_ai_control_state_v1 set revision=revision+1,closing_cycle_id=v_cycle,closed_at=clock_timestamp(),closed_by=null,reopened_at=null where id=true returning * into v_control;
  update public.admin_environment set control_plane_mode='jwt_v1',revision=revision+1 where id=true returning * into v_environment;
  v_manifest:=public.admin_current_runtime_authority_manifest_v3();
  v_manifest_sha256:=encode(extensions.digest(convert_to(v_manifest::text,'UTF8'),'sha256'),'hex');
  select coalesce(max(authority_epoch),0)+1 into v_authority_epoch
    from public.admin_runtime_authority_receipts_v3
    where environment=v_environment.environment and project_ref=v_environment.project_ref and authority_scope='jwt_v1';
  insert into public.admin_runtime_authority_receipts_v3(environment,project_ref,authority_scope,authority_epoch,authority_manifest,authority_manifest_sha256) values(v_environment.environment,v_environment.project_ref,'jwt_v1',v_authority_epoch,v_manifest,v_manifest_sha256) returning receipt_id into v_receipt;
  insert into public.admin_audit_events(operation,actor,target_id,reason) values ('admin_authority_cutover','db_operator',v_config.active_routing_policy_version_id,p_reason) returning id into v_audit;
  return jsonb_build_object('schemaVersion','admin_authority_cutover_v3','auditId',v_audit,'controlPlaneMode',v_environment.control_plane_mode,'environmentRevision',v_environment.revision::text,'controlRevision',v_control.revision::text,'closingCycleId',v_control.closing_cycle_id,'activePolicyVersionId',v_config.active_routing_policy_version_id,'configGeneration',v_config.config_generation::text,'validationReportIds',v_evidence->'validationReportIds','authorityReceiptId',v_receipt,'authorityEpoch',v_authority_epoch::text,'authorityManifestSha256',v_manifest_sha256);
end;
$$;

create function public.admin_reopen_ai_v2(
  p_environment text,p_project_ref text,p_readback_report_id uuid,p_expected_closing_cycle_id uuid,
  p_expected_control_revision bigint,p_expected_policy_version_id uuid,p_expected_config_generation bigint,
  p_reason text,p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid; v_payload jsonb; v_replay jsonb; v_now timestamptz;
  v_config public.ai_feature_config%rowtype; v_control public.admin_ai_control_state_v1%rowtype; v_readback public.admin_runtime_readback_reports_v2%rowtype; v_audit uuid; v_result jsonb; v_evidence jsonb;
begin
  v_actor:=public.admin_assert_write_actor_v1(p_environment,p_project_ref,false);
  perform public.admin_assert_jwt_control_mode_v1();
  v_payload:=jsonb_build_object('readbackReportId',p_readback_report_id,'expectedClosingCycleId',p_expected_closing_cycle_id,'expectedControlRevision',p_expected_control_revision,'expectedPolicyVersionId',p_expected_policy_version_id,'expectedConfigGeneration',p_expected_config_generation,'reason',p_reason);
  v_replay:=public.admin_lock_committed_operation_v1(v_actor,'ai_reopen',p_idempotency_key,v_payload);
  if (v_replay->>'found')::boolean then return public.admin_replayed_operation_v1(v_replay,'ai_reopen',p_idempotency_key); end if;
  if not public.admin_has_recent_totp_v1(v_actor) then raise exception 'STEP_UP_REQUIRED' using errcode='42501'; end if;
  if p_reason is null or p_reason<>btrim(p_reason) or length(p_reason) not between 1 and 500 then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  perform public.admin_assert_runtime_authority_receipt_v3(p_environment,p_project_ref);
  select * into v_config from public.ai_feature_config where id=true for update;
  select * into v_control from public.admin_ai_control_state_v1 where id=true for update;
  select * into v_readback from public.admin_runtime_readback_reports_v2 where id=p_readback_report_id for share;
  -- A lock wait cannot extend operational evidence validity.
  v_now:=clock_timestamp();
  if v_config.id is null or v_control.id is null or v_readback.id is null
     or v_config.ai_polish_enabled or v_control.closing_cycle_id is distinct from p_expected_closing_cycle_id or v_control.reopened_at is not null
     or v_control.revision is distinct from p_expected_control_revision or v_config.active_routing_policy_version_id is distinct from p_expected_policy_version_id or v_config.config_generation is distinct from p_expected_config_generation
     or (v_readback.environment,v_readback.project_ref,v_readback.closing_cycle_id,v_readback.control_revision,v_readback.config_generation,v_readback.policy_version_id) is distinct from (p_environment,p_project_ref,v_control.closing_cycle_id,v_control.revision,v_config.config_generation,v_config.active_routing_policy_version_id)
     or v_readback.legal_bundle_version is distinct from public.current_ai_terms_version() or v_readback.expires_at<=v_now then raise exception 'NOT_READY' using errcode='23514'; end if;
  v_evidence:=public.admin_assert_policy_config_reports_v1(v_readback.policy_version_id,v_readback.validation_report_ids,v_now);
  v_now:=clock_timestamp();
  if v_readback.expires_at<=v_now or (v_evidence->>'expiresAt')::timestamptz<=v_now then raise exception 'NOT_READY' using errcode='23514'; end if;
  update public.ai_feature_config set ai_polish_enabled=true where id=true;
  update public.admin_ai_control_state_v1 set revision=revision+1,reopened_at=clock_timestamp() where id=true returning * into v_control;
  insert into public.admin_audit_events(operation,actor,target_id,reason) values ('ai_reopen',v_actor::text,p_expected_policy_version_id,p_reason) returning id into v_audit;
  v_result:=jsonb_build_object('schemaVersion','admin_ai_control_result_v1','aiEnabled',true,'controlRevision',v_control.revision::text,'closingCycleId',v_control.closing_cycle_id,'configGeneration',v_config.config_generation::text,'activePolicyVersionId',v_config.active_routing_policy_version_id,'readbackReportId',v_readback.id);
  return public.admin_commit_operation_v1(v_actor,'ai_reopen',p_idempotency_key,v_payload,v_result,v_audit);
end;
$$;

-- Price sealing precedes runtime-target binding. It checks the immutable
-- price/profile, supported capability and legal membership, then records an
-- append-only lifecycle event. Final binding and a validation report are
-- required before publication; no old build evidence is manufactured.
create table public.admin_config_lifecycle_events_v2 (
  id uuid primary key default extensions.gen_random_uuid(),
  operation text not null check (operation in ('price_seal','pointer_set','pointer_clear')),
  target_id uuid not null,
  runtime_contract_id text not null,
  code_capability_id text null,
  code_capability_sha256 text null check (code_capability_sha256 is null or code_capability_sha256 ~ '^[0-9a-f]{64}$'),
  validation_report_ids uuid[] not null default '{}'::uuid[],
  actor text not null, reason text not null, occurred_at timestamptz not null default clock_timestamp(),
  transaction_id bigint not null default txid_current()
);
alter table public.admin_config_lifecycle_events_v2 enable row level security;
revoke all on public.admin_config_lifecycle_events_v2 from public,anon,authenticated,service_role;
create function public.admin_guard_config_lifecycle_event_v2() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'Configuration lifecycle events are append-only' using errcode='23514'; end; $$;
create trigger admin_config_lifecycle_events_v2_immutable before update or delete on public.admin_config_lifecycle_events_v2 for each row execute function public.admin_guard_config_lifecycle_event_v2();

-- This receipt is deliberately separate from the removed deployment
-- admission.  It records the database-owned callable authority surface at
-- cutover, including actual definitions and grants.
create table public.admin_runtime_authority_receipts_v3 (
  receipt_id uuid primary key default extensions.gen_random_uuid(),
  environment text not null check (environment in ('local','preview','production')),
  project_ref text not null,
  authority_scope text not null default 'jwt_v1' check (authority_scope='jwt_v1'),
  authority_epoch bigint not null check (authority_epoch>0),
  authority_manifest jsonb not null,
  authority_manifest_sha256 text not null check (authority_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  unique(environment,project_ref,authority_scope,authority_epoch)
);
alter table public.admin_runtime_authority_receipts_v3 enable row level security;
revoke all on public.admin_runtime_authority_receipts_v3 from public,anon,authenticated,service_role;
create function public.admin_guard_runtime_authority_receipt_v3() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'Runtime authority receipts are append-only' using errcode='23514'; end; $$;
create trigger admin_runtime_authority_receipts_v3_immutable before update or delete on public.admin_runtime_authority_receipts_v3 for each row execute function public.admin_guard_runtime_authority_receipt_v3();

-- This catalog is stamped by the migrations that introduce the covered
-- routines.  Cutover compares against it; it never blesses whatever happens
-- to be installed at cutover time.
create table public.admin_runtime_authority_expected_v3 (
  signature text primary key,
  definition_sha256 text not null check (definition_sha256 ~ '^[0-9a-f]{64}$'),
  authenticated_execute boolean not null,
  service_role_execute boolean not null
);
alter table public.admin_runtime_authority_expected_v3 enable row level security;
revoke all on public.admin_runtime_authority_expected_v3 from public,anon,authenticated,service_role;

-- A cutover receipt is an active authority check, rather than an audit row
-- that future operations merely display.  Keep this list independent of the
-- receipt routine itself so verifying it cannot become self-referential.
create function public.admin_assert_runtime_authority_receipt_v3(
  p_environment text,p_project_ref text
) returns void language plpgsql security definer set search_path='' as $$
declare
  v_environment public.admin_environment%rowtype;
  v_control public.admin_ai_control_state_v1%rowtype;
  v_receipt public.admin_runtime_authority_receipts_v3%rowtype;
  v_routines jsonb; v_manifest jsonb; v_sha text;
begin
  select * into v_environment from public.admin_environment where id=true for share;
  if v_environment.id is null or (v_environment.environment,v_environment.project_ref) is distinct from (p_environment,p_project_ref) then
    raise exception 'RUNTIME_AUTHORITY_UNAVAILABLE' using errcode='23514';
  end if;
  if v_environment.control_plane_mode is distinct from 'jwt_v1' then return; end if;
  select * into v_control from public.admin_ai_control_state_v1 where id=true for share;
  select * into v_receipt from public.admin_runtime_authority_receipts_v3
    where environment=p_environment and project_ref=p_project_ref and authority_scope='jwt_v1'
    order by authority_epoch desc limit 1 for share;
  if v_control.id is null or v_receipt.receipt_id is null then
    raise exception 'RUNTIME_AUTHORITY_UNAVAILABLE' using errcode='23514';
  end if;
  v_manifest:=public.admin_current_runtime_authority_manifest_v3();
  v_sha:=encode(extensions.digest(convert_to(v_manifest::text,'UTF8'),'sha256'),'hex');
  if v_receipt.authority_manifest_sha256 is distinct from v_sha
     or v_receipt.authority_manifest is distinct from v_manifest then
    raise exception 'RUNTIME_AUTHORITY_MISMATCH' using errcode='23514';
  end if;
end;
$$;

create function public.admin_seal_price_for_activation_v2(
  p_environment text,p_project_ref text,p_price_version_id uuid,p_runtime_contract_id text,
  p_reason text,p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid; v_payload jsonb; v_replay jsonb; v_price public.ai_price_versions%rowtype;
  v_contract public.ai_service_runtime_contract_versions%rowtype;
  v_contract_target public.ai_service_runtime_contract_targets%rowtype;
  v_profile public.ai_provider_profiles%rowtype;
  v_version public.ai_provider_profile_versions%rowtype;
  v_capability public.ai_runtime_code_capabilities_v2%rowtype;
  v_components jsonb; v_event uuid; v_audit uuid; v_result jsonb;
begin
  v_actor:=public.admin_assert_write_actor_v1(p_environment,p_project_ref,false);
  perform public.admin_assert_jwt_control_mode_v1();
  v_payload:=jsonb_build_object('priceVersionId',p_price_version_id,'runtimeContractId',p_runtime_contract_id,'reason',p_reason);
  v_replay:=public.admin_lock_committed_operation_v1(v_actor,'price_seal',p_idempotency_key,v_payload);
  if (v_replay->>'found')::boolean then return public.admin_replayed_operation_v1(v_replay,'price_seal',p_idempotency_key); end if;
  if not public.admin_has_recent_totp_v1(v_actor) then raise exception 'STEP_UP_REQUIRED' using errcode='42501'; end if;
  perform public.admin_assert_reason_v1(p_reason);
  perform pg_catalog.set_config('lock_timeout','5s',true);
  perform 1 from public.ai_feature_config where id=true for update;
  if not found then raise exception 'PRICE_SEAL_NOT_READY' using errcode='23514'; end if;
  select * into v_price from public.ai_price_versions where id=p_price_version_id for update;
  select * into v_version from public.ai_provider_profile_versions where id=v_price.profile_version_id for share;
  select * into v_profile from public.ai_provider_profiles where id=v_version.profile_id for share;
  select * into v_contract from public.ai_service_runtime_contract_versions where runtime_contract_id=p_runtime_contract_id for share;
  select * into v_contract_target from public.ai_service_runtime_contract_targets
    where runtime_contract_id=p_runtime_contract_id and profile_key=v_profile.profile_key for share;
  select * into v_capability from public.ai_runtime_code_capabilities_v2 capability
    where (capability.gateway_kind,capability.adapter_kind,capability.wire_api_kind,
           capability.capability_contract_id,capability.cache_policy_id,capability.calculator_kind)
        is not distinct from
          (v_profile.gateway_kind,v_version.adapter_kind,v_version.wire_api_kind,
           v_version.capability_contract_id,v_version.cache_policy_id,v_price.calculator_kind)
    order by capability.code_capability_id
    limit 1 for share;
  if v_price.id is null or v_version.id is null or v_profile.id is null
     or v_contract.runtime_contract_id is null or v_contract.sealed_at is not null
     or v_contract_target.runtime_target_id is null
     or v_price.components_sealed_at is not null or v_price.valid_to is not null
     or v_price.pricing_lane='legacy'
     or v_price.source_checked_at is null or v_price.source_checked_at>clock_timestamp()
     or v_profile.retired_at is not null or v_version.retired_at is not null
     or v_version.execution_schema_version is distinct from 'profile_execution_config_v2'
     or v_capability.code_capability_id is null
     or v_contract_target.legal_manifest_id is distinct from v_version.legal_manifest_id
     or not exists (
       select 1
       from public.ai_legal_bundle_versions bundle
       join public.ai_legal_bundle_manifests membership
         on membership.legal_bundle_version=bundle.legal_bundle_version
       where bundle.legal_bundle_version=v_contract.legal_bundle_version
         and bundle.sealed_at is not null
         and membership.legal_manifest_id=v_contract_target.legal_manifest_id
         and membership.manifest_sha256=v_contract_target.manifest_sha256
     ) then
    raise exception 'PRICE_SEAL_NOT_READY' using errcode='23514';
  end if;
  perform public.assert_ai_price_structure_v1(v_price.id);
  perform public.seal_ai_price_components_v1(array[v_price.id],greatest(clock_timestamp(),v_price.created_at));
  select jsonb_object_agg(component,nanos_per_million::text order by component) into v_components from public.ai_price_components where price_version_id=v_price.id;
  insert into public.admin_config_lifecycle_events_v2(operation,target_id,runtime_contract_id,code_capability_id,code_capability_sha256,actor,reason) values ('price_seal',v_price.id,p_runtime_contract_id,v_capability.code_capability_id,v_capability.descriptor_sha256,v_actor::text,p_reason) returning id into v_event;
  insert into public.admin_audit_events(operation,actor,target_id,reason) values ('price_seal',v_actor::text,v_price.id,p_reason) returning id into v_audit;
  select * into v_price from public.ai_price_versions where id=p_price_version_id;
  v_result:=jsonb_build_object('schemaVersion','admin_price_version_result_v1','priceVersionId',v_price.id,'profileVersionId',v_price.profile_version_id,'pricingLane',v_price.pricing_lane,'version',v_price.version,'sealed',v_price.components_sealed_at is not null,'lifecycleAuditId',v_event);
  return public.admin_commit_operation_v1(v_actor,'price_seal',p_idempotency_key,v_payload,v_result,v_audit);
end;
$$;

-- These internal pointer transitions consume the V2 configuration-report set
-- and write the successor append-only lifecycle event.  They intentionally do
-- not manufacture the old reviewed-source commit fields just to call V1.
create function public.set_ai_routing_policy_pointer_v2_internal(
  p_policy_version_id uuid,p_actor text,p_reason text,p_validation_report_ids uuid[]
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_config public.ai_feature_config%rowtype; v_updated public.ai_feature_config%rowtype;
  v_policy public.ai_routing_policy_versions%rowtype; v_id uuid;
begin
  select * into v_config from public.ai_feature_config where id=true for update;
  select * into v_policy from public.ai_routing_policy_versions where id=p_policy_version_id for update;
  if v_config.id is null or v_policy.id is null or v_policy.status not in ('canary','active')
     or v_config.active_routing_policy_version_id is not distinct from p_policy_version_id then
    raise exception 'invalid routing pointer target' using errcode='23514';
  end if;
  perform public.lock_and_validate_ai_routing_policy_row_v1(v_policy,v_policy.status,clock_timestamp());
  perform public.admin_assert_policy_config_reports_v1(v_policy.id,p_validation_report_ids,clock_timestamp());
  update public.ai_feature_config set active_routing_policy_version_id=v_policy.id,
    routing_updated_by=p_actor,routing_change_reason=p_reason where id=true returning * into v_updated;
  if v_updated.active_routing_policy_version_id is distinct from v_policy.id
     or v_updated.config_generation<>v_config.config_generation+1 then
    raise exception 'routing pointer update did not preserve its guarded generation' using errcode='23514';
  end if;
  insert into public.admin_config_lifecycle_events_v2(operation,target_id,runtime_contract_id,validation_report_ids,actor,reason)
    values('pointer_set',v_policy.id,v_policy.runtime_contract_id,p_validation_report_ids,p_actor,p_reason)
    returning id into v_id;
  return v_id;
end;
$$;

create function public.clear_ai_routing_policy_pointer_v2_internal(
  p_expected_policy_version_id uuid,p_actor text,p_reason text,p_validation_report_ids uuid[]
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_config public.ai_feature_config%rowtype; v_updated public.ai_feature_config%rowtype;
  v_policy public.ai_routing_policy_versions%rowtype; v_id uuid;
begin
  select * into v_config from public.ai_feature_config where id=true for update;
  select * into v_policy from public.ai_routing_policy_versions where id=p_expected_policy_version_id for update;
  if v_config.id is null or v_policy.id is null or p_expected_policy_version_id is null
     or v_config.active_routing_policy_version_id is distinct from p_expected_policy_version_id then
    raise exception 'stale or absent routing pointer' using errcode='23514';
  end if;
  perform public.lock_and_validate_ai_routing_policy_row_v1(v_policy,v_policy.status,clock_timestamp());
  perform public.admin_assert_policy_config_reports_v1(v_policy.id,p_validation_report_ids,clock_timestamp());
  update public.ai_feature_config set active_routing_policy_version_id=null,
    routing_updated_by=p_actor,routing_change_reason=p_reason where id=true returning * into v_updated;
  if v_updated.active_routing_policy_version_id is not null
     or v_updated.config_generation<>v_config.config_generation+1 then
    raise exception 'routing pointer clear did not preserve its guarded generation' using errcode='23514';
  end if;
  insert into public.admin_config_lifecycle_events_v2(operation,target_id,runtime_contract_id,validation_report_ids,actor,reason)
    values('pointer_clear',v_policy.id,v_policy.runtime_contract_id,p_validation_report_ids,p_actor,p_reason)
    returning id into v_id;
  return v_id;
end;
$$;

-- Keep these successor bodies explicit.  Rewriting pg_get_functiondef text was
-- brittle across PostgreSQL formatting changes and could silently retain the
-- old reviewed-deployment path.
create function public.admin_set_ai_routing_pointer_v2(
  p_environment text,p_project_ref text,p_policy_version_id uuid,
  p_validation_report_ids uuid[],p_expected_control_revision bigint,
  p_expected_policy_version_id uuid,p_expected_config_generation bigint,
  p_reason text,p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid; v_report_ids uuid[]; v_payload jsonb; v_replay jsonb;
  v_config public.ai_feature_config%rowtype; v_control public.admin_ai_control_state_v1%rowtype;
  v_policy public.ai_routing_policy_versions%rowtype; v_evidence jsonb;
  v_lifecycle_audit uuid; v_admin_audit uuid; v_result jsonb;
begin
  v_actor:=public.admin_assert_write_actor_v1(p_environment,p_project_ref,false);
  perform public.admin_assert_jwt_control_mode_v1();
  perform public.admin_assert_runtime_authority_receipt_v3(p_environment,p_project_ref);
  select array_agg(id order by id) into v_report_ids from unnest(p_validation_report_ids) item(id);
  v_payload:=jsonb_build_object('policyVersionId',p_policy_version_id,'validationReportIds',to_jsonb(v_report_ids),'expectedControlRevision',p_expected_control_revision,'expectedPolicyVersionId',p_expected_policy_version_id,'expectedConfigGeneration',p_expected_config_generation,'reason',p_reason);
  v_replay:=public.admin_lock_committed_operation_v1(v_actor,'ai_pointer_set',p_idempotency_key,v_payload);
  if (v_replay->>'found')::boolean then return public.admin_replayed_operation_v1(v_replay,'ai_pointer_set',p_idempotency_key); end if;
  if not public.admin_has_recent_totp_v1(v_actor) then raise exception 'STEP_UP_REQUIRED' using errcode='42501'; end if;
  perform public.admin_assert_reason_v1(p_reason);
  select * into v_config from public.ai_feature_config where id=true for update;
  select * into v_control from public.admin_ai_control_state_v1 where id=true for update;
  select * into v_policy from public.ai_routing_policy_versions where id=p_policy_version_id for update;
  if v_config.id is null or v_control.id is null or v_policy.id is null then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  if v_config.ai_polish_enabled or v_control.closing_cycle_id is null or v_control.reopened_at is not null
     or v_control.revision is distinct from p_expected_control_revision
     or v_config.active_routing_policy_version_id is distinct from p_expected_policy_version_id
     or v_config.config_generation is distinct from p_expected_config_generation then raise exception 'CONFLICT' using errcode='40001'; end if;
  v_evidence:=public.admin_assert_policy_config_reports_v1(v_policy.id,v_report_ids,clock_timestamp());
  select public.set_ai_routing_policy_pointer_v2_internal(v_policy.id,v_actor::text,p_reason,v_report_ids) into v_lifecycle_audit;
  select * into v_config from public.ai_feature_config where id=true;
  update public.admin_ai_control_state_v1 set revision=revision+1 where id=true returning * into v_control;
  insert into public.admin_audit_events(operation,actor,target_id,reason) values('ai_pointer_set',v_actor::text,v_policy.id,p_reason) returning id into v_admin_audit;
  v_result:=jsonb_build_object('schemaVersion','admin_ai_control_result_v1','aiEnabled',false,'controlRevision',v_control.revision::text,'closingCycleId',v_control.closing_cycle_id,'configGeneration',v_config.config_generation::text,'activePolicyVersionId',v_config.active_routing_policy_version_id,'lifecycleAuditId',v_lifecycle_audit,'validationReportIds',v_evidence->'validationReportIds');
  return public.admin_commit_operation_v1(v_actor,'ai_pointer_set',p_idempotency_key,v_payload,v_result,v_admin_audit);
end;
$$;

create function public.admin_clear_ai_routing_pointer_v2(
  p_environment text,p_project_ref text,p_validation_report_ids uuid[],
  p_expected_control_revision bigint,p_expected_policy_version_id uuid,
  p_expected_config_generation bigint,p_reason text,p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid; v_report_ids uuid[]; v_payload jsonb; v_replay jsonb;
  v_config public.ai_feature_config%rowtype; v_control public.admin_ai_control_state_v1%rowtype;
  v_policy public.ai_routing_policy_versions%rowtype; v_evidence jsonb;
  v_lifecycle_audit uuid; v_admin_audit uuid; v_result jsonb;
begin
  v_actor:=public.admin_assert_write_actor_v1(p_environment,p_project_ref,false);
  perform public.admin_assert_jwt_control_mode_v1();
  perform public.admin_assert_runtime_authority_receipt_v3(p_environment,p_project_ref);
  select array_agg(id order by id) into v_report_ids from unnest(p_validation_report_ids) item(id);
  v_payload:=jsonb_build_object('validationReportIds',to_jsonb(v_report_ids),'expectedControlRevision',p_expected_control_revision,'expectedPolicyVersionId',p_expected_policy_version_id,'expectedConfigGeneration',p_expected_config_generation,'reason',p_reason);
  v_replay:=public.admin_lock_committed_operation_v1(v_actor,'ai_pointer_clear',p_idempotency_key,v_payload);
  if (v_replay->>'found')::boolean then return public.admin_replayed_operation_v1(v_replay,'ai_pointer_clear',p_idempotency_key); end if;
  if not public.admin_has_recent_totp_v1(v_actor) then raise exception 'STEP_UP_REQUIRED' using errcode='42501'; end if;
  if p_expected_policy_version_id is null then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  perform public.admin_assert_reason_v1(p_reason);
  select * into v_config from public.ai_feature_config where id=true for update;
  select * into v_control from public.admin_ai_control_state_v1 where id=true for update;
  select * into v_policy from public.ai_routing_policy_versions where id=p_expected_policy_version_id for update;
  if v_config.id is null or v_control.id is null or v_policy.id is null then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  if v_config.ai_polish_enabled or v_control.closing_cycle_id is null or v_control.reopened_at is not null
     or v_control.revision is distinct from p_expected_control_revision
     or v_config.active_routing_policy_version_id is distinct from p_expected_policy_version_id
     or v_config.config_generation is distinct from p_expected_config_generation then raise exception 'CONFLICT' using errcode='40001'; end if;
  v_evidence:=public.admin_assert_policy_config_reports_v1(v_policy.id,v_report_ids,clock_timestamp());
  select public.clear_ai_routing_policy_pointer_v2_internal(v_policy.id,v_actor::text,p_reason,v_report_ids) into v_lifecycle_audit;
  select * into v_config from public.ai_feature_config where id=true;
  update public.admin_ai_control_state_v1 set revision=revision+1 where id=true returning * into v_control;
  insert into public.admin_audit_events(operation,actor,target_id,reason) values('ai_pointer_clear',v_actor::text,v_policy.id,p_reason) returning id into v_admin_audit;
  v_result:=jsonb_build_object('schemaVersion','admin_ai_control_result_v1','aiEnabled',false,'controlRevision',v_control.revision::text,'closingCycleId',v_control.closing_cycle_id,'configGeneration',v_config.config_generation::text,'activePolicyVersionId',v_config.active_routing_policy_version_id,'lifecycleAuditId',v_lifecycle_audit,'validationReportIds',v_evidence->'validationReportIds');
  return public.admin_commit_operation_v1(v_actor,'ai_pointer_clear',p_idempotency_key,v_payload,v_result,v_admin_audit);
end;
$$;

revoke all on function public.admin_guard_config_validation_report_v2(),
  public.admin_guard_runtime_readback_report_v2(),
  public.admin_guard_config_lifecycle_event_v2(),
  public.admin_guard_runtime_authority_receipt_v3(),
  public.admin_assert_runtime_authority_receipt_v3(text,text),
  public.get_admin_config_validation_candidate_v2(text,text),
  public.record_admin_config_validation_report_v2(text,text,text,boolean,boolean,boolean,boolean),
  public.admin_assert_policy_config_reports_v1(uuid,uuid[],timestamptz),
  public.get_ai_polish_execution_snapshot_v5(uuid,uuid,text,text),
  public.start_ai_polish_provider_attempt_v5(uuid,integer,jsonb),
  public.start_ai_polish_provider_attempt_v5_internal(uuid,integer),
  public.get_admin_runtime_readback_candidate_v3(uuid,uuid[],text,text),
  public.record_admin_runtime_readback_v3(text,text,uuid,uuid[],uuid,bigint,bigint),
  public.admin_cutover_authority_v3(uuid[],bigint,bigint,text),
  public.admin_reopen_ai_v2(text,text,uuid,uuid,bigint,uuid,bigint,text,uuid)
  ,public.admin_seal_price_for_activation_v2(text,text,uuid,text,text,uuid),
  public.set_ai_routing_policy_pointer_v2_internal(uuid,text,text,uuid[]),
  public.clear_ai_routing_policy_pointer_v2_internal(uuid,text,text,uuid[]),
  public.admin_set_ai_routing_pointer_v2(text,text,uuid,uuid[],bigint,uuid,bigint,text,uuid),
  public.admin_clear_ai_routing_pointer_v2(text,text,uuid[],bigint,uuid,bigint,text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_admin_config_validation_candidate_v2(text,text),
  public.record_admin_config_validation_report_v2(text,text,text,boolean,boolean,boolean,boolean),
  public.get_ai_polish_execution_snapshot_v5(uuid,uuid,text,text),
  public.start_ai_polish_provider_attempt_v5(uuid,integer,jsonb),
  public.get_admin_runtime_readback_candidate_v3(uuid,uuid[],text,text),
  public.record_admin_runtime_readback_v3(text,text,uuid,uuid[],uuid,bigint,bigint) to service_role;
grant execute on function public.admin_reopen_ai_v2(text,text,uuid,uuid,bigint,uuid,bigint,text,uuid) to authenticated;
grant execute on function public.admin_seal_price_for_activation_v2(text,text,uuid,text,text,uuid) to authenticated;
grant execute on function public.admin_set_ai_routing_pointer_v2(text,text,uuid,uuid[],bigint,uuid,bigint,text,uuid),
  public.admin_clear_ai_routing_pointer_v2(text,text,uuid[],bigint,uuid,bigint,text,uuid) to authenticated;

create function public.admin_current_runtime_authority_manifest_v3()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_routines jsonb; v_expected_count integer;
begin
  select count(*) into v_expected_count from public.admin_runtime_authority_expected_v3;
  select jsonb_agg(jsonb_build_object(
    'signature',spec.signature,
    'definitionSha256',encode(extensions.digest(replace(replace(pg_catalog.pg_get_functiondef(proc.oid),chr(13)||chr(10),chr(10)),chr(13),chr(10)),'sha256'),'hex'),
    'publicExecute',exists(select 1 from pg_catalog.aclexplode(coalesce(proc.proacl,pg_catalog.acldefault('f',proc.proowner))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE'),
    'anonExecute',pg_catalog.has_function_privilege('anon',proc.oid,'EXECUTE'),
    'authenticatedExecute',pg_catalog.has_function_privilege('authenticated',proc.oid,'EXECUTE'),
    'serviceRoleExecute',pg_catalog.has_function_privilege('service_role',proc.oid,'EXECUTE')
  ) order by spec.signature) into v_routines
  from public.admin_runtime_authority_expected_v3 spec
  join pg_catalog.pg_proc proc on proc.oid=pg_catalog.to_regprocedure(spec.signature);
  if v_expected_count<13 or jsonb_array_length(v_routines) is distinct from v_expected_count
     or exists (
       select 1 from jsonb_array_elements(v_routines) entry(value)
       join public.admin_runtime_authority_expected_v3 expected on expected.signature=entry.value->>'signature'
       where entry.value->>'definitionSha256' is distinct from expected.definition_sha256
         or entry.value->>'publicExecute' is distinct from 'false'
         or entry.value->>'anonExecute' is distinct from 'false'
         or (entry.value->>'authenticatedExecute')::boolean is distinct from expected.authenticated_execute
         or (entry.value->>'serviceRoleExecute')::boolean is distinct from expected.service_role_execute
     )
     or pg_catalog.has_column_privilege('service_role','public.ai_feature_config','ai_polish_enabled','UPDATE')
     or pg_catalog.has_column_privilege('service_role','public.ai_feature_config','global_daily_limit','UPDATE')
     or pg_catalog.has_column_privilege('service_role','public.ai_feature_config','enabled_user_allowlist','UPDATE') then
    raise exception 'RUNTIME_AUTHORITY_MISMATCH' using errcode='23514';
  end if;
  return jsonb_build_object('schemaVersion','admin_runtime_authority_manifest_v5','routines',v_routines);
end;
$$;
revoke all on function public.admin_current_runtime_authority_manifest_v3() from public,anon,authenticated,service_role;

commit;
