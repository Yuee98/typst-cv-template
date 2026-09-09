-- Admin initialization uses only an existing user, environment and reason.
-- Supabase endpoint/key remain deployment configuration. Obsolete identity
-- columns are historical metadata, never populated or trusted by new callers.
begin;

-- Serialize with bootstrap and every current Admin read/write before replacing
-- the authority implementation. A pre-existing JWT authority mismatch aborts
-- the entire migration; it is never repaired by stamping observed code.
lock table public.admin_environment in access exclusive mode;
create temporary table admin_bootstrap_upgrade_state(environment text primary key) on commit drop;
do $preflight$
declare item public.admin_environment%rowtype;
begin
  select * into item from public.admin_environment where id=true;
  if item.control_plane_mode='jwt_v1' then
    perform public.admin_assert_runtime_authority_receipt_v3(item.environment,item.project_ref);
    insert into pg_temp.admin_bootstrap_upgrade_state values(item.environment);
  end if;
end;
$preflight$;

alter table public.admin_environment alter column project_ref drop not null, alter column auth_issuer drop not null;
comment on column public.admin_environment.project_ref is 'Historical bootstrap metadata only. New initialization leaves NULL; not an authorization binding.';
comment on column public.admin_environment.auth_issuer is 'Historical bootstrap metadata only. Supabase verifies tokens; new initialization leaves NULL.';
alter table public.admin_config_validation_reports_v2 alter column project_ref drop not null;
alter table public.admin_runtime_readback_reports_v2 alter column project_ref drop not null;
alter table public.admin_runtime_authority_receipts_v3 alter column project_ref drop not null;
alter table public.admin_config_validation_reports_v2 add column report_schema_version text not null default 'admin_config_validation_report_v2'
  check(report_schema_version in ('admin_config_validation_report_v2','admin_config_validation_report_v3'));
alter table public.admin_runtime_readback_reports_v2 add column report_schema_version text not null default 'admin_runtime_readback_v3'
  check(report_schema_version in ('admin_runtime_readback_v3','admin_runtime_readback_v4'));
create unique index admin_runtime_authority_db_epoch_v3 on public.admin_runtime_authority_receipts_v3(environment,authority_scope,authority_epoch) where project_ref is null;

drop function public.admin_bootstrap_v1(uuid,text,text,text,text);
CREATE OR REPLACE FUNCTION public.admin_bootstrap_v2(p_user_id uuid, p_environment text, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_audit uuid;
begin
  if session_user not in ('postgres','supabase_admin') then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(172911,1);
  if exists(select 1 from public.admin_principals) then
    raise exception 'bootstrap has already been used' using errcode='23514';
  end if;
  if not exists(select 1 from auth.users where id=p_user_id and deleted_at is null
      and not coalesce(is_anonymous,false) and (banned_until is null or banned_until<=clock_timestamp())
      and (email_confirmed_at is not null or phone_confirmed_at is not null)) then
    raise exception 'bootstrap requires a confirmed, available user' using errcode='23514';
  end if;
  if p_environment is null or p_environment not in ('local','preview','production') then
    raise exception 'invalid environment' using errcode='23514';
  end if;
  perform public.admin_assert_reason_v1(p_reason);
  insert into public.admin_environment(id,environment) values(true,p_environment);
  insert into public.admin_principals(user_id) values(p_user_id);
  insert into public.admin_audit_events(operation,actor,target_id,reason)
    values('admin_bootstrap','db_operator',p_user_id,p_reason) returning id into v_audit;
  return v_audit;
end;
$function$
;
revoke all on function public.admin_bootstrap_v2(uuid,text,text) from public,anon,authenticated,service_role;

-- p_project_ref remains an ignored compatibility argument in existing RPC
-- signatures. Matching web code sends NULL; no value selects or proves identity.
CREATE OR REPLACE FUNCTION public.admin_assert_actor_v1(p_environment text, p_project_ref text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor uuid:=auth.uid(); v_environment public.admin_environment%rowtype;
  v_session text:=auth.jwt()->>'session_id';
begin
  if v_actor is null or auth.role() is distinct from 'authenticated'
    or coalesce((auth.jwt()->>'is_anonymous')::boolean,false)
    or v_session is null or v_session !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  select * into v_environment from public.admin_environment where id=true for share;
  if not found then raise exception 'UNAVAILABLE' using errcode='P0001'; end if;
  if v_environment.environment is distinct from p_environment then
    raise exception 'ENVIRONMENT_MISMATCH' using errcode='42501';
  end if;
  perform 1 from public.admin_principals where user_id=v_actor and revoked_at is null for share;
  if not found then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if not exists(select 1 from auth.users where id=v_actor and deleted_at is null
      and not coalesce(is_anonymous,false) and (banned_until is null or banned_until<=clock_timestamp())
      and (email_confirmed_at is not null or phone_confirmed_at is not null))
    or not exists(select 1 from auth.sessions where id=v_session::uuid and user_id=v_actor
      and (not_after is null or not_after>clock_timestamp())) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  return v_actor;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_assert_write_actor_v1(p_environment text, p_project_ref text, p_require_recent_totp boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := auth.uid();
  v_environment public.admin_environment%rowtype;
  v_session_id text := auth.jwt() ->> 'session_id';
begin
  if v_actor is null
     or auth.role() is distinct from 'authenticated'
     or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
     or v_session_id is null
     or v_session_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_environment
  from public.admin_environment where id = true for update;
  if not found then
    raise exception 'UNAVAILABLE' using errcode = 'P0001';
  end if;
  if v_environment.environment is distinct from p_environment then
    raise exception 'ENVIRONMENT_MISMATCH' using errcode = '42501';
  end if;
  perform 1
  from public.admin_principals
  where user_id = v_actor and revoked_at is null
  for update;
  if not found then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (
    select 1 from auth.users
    where id = v_actor
      and deleted_at is null
      and not coalesce(is_anonymous, false)
      and (banned_until is null or banned_until <= clock_timestamp())
      and (email_confirmed_at is not null or phone_confirmed_at is not null)
  ) or not exists (
    select 1 from auth.sessions
    where id = v_session_id::uuid
      and user_id = v_actor
      and (not_after is null or not_after > clock_timestamp())
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if coalesce(p_require_recent_totp, false)
     and not public.admin_has_recent_totp_v1(v_actor) then
    raise exception 'STEP_UP_REQUIRED' using errcode = '42501';
  end if;
  return v_actor;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_assert_runtime_authority_receipt_v3(p_environment text, p_project_ref text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_environment public.admin_environment%rowtype;
  v_control public.admin_ai_control_state_v1%rowtype;
  v_receipt public.admin_runtime_authority_receipts_v3%rowtype;
  v_routines jsonb; v_manifest jsonb; v_sha text;
begin
  select * into v_environment from public.admin_environment where id=true for share;
  if v_environment.id is null or (v_environment.environment) is distinct from (p_environment) then
    raise exception 'RUNTIME_AUTHORITY_UNAVAILABLE' using errcode='23514';
  end if;
  if v_environment.control_plane_mode is distinct from 'jwt_v1' then return; end if;
  select * into v_control from public.admin_ai_control_state_v1 where id=true for share;
  select * into v_receipt from public.admin_runtime_authority_receipts_v3
    where environment=p_environment and authority_scope='jwt_v1'
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_get_context_v1(p_environment text, p_project_ref text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor uuid; v_result jsonb;
begin
  v_actor := public.admin_assert_actor_v1(p_environment, p_project_ref);
  select jsonb_build_object(
    'schemaVersion','admin_context_v2',
    'actor',jsonb_build_object('userId',v_actor,'email',u.email,'revision',p.revision::text),
    'environment',jsonb_build_object('name',e.environment,
      'controlPlaneMode',e.control_plane_mode,'revision',e.revision::text),
    'features',jsonb_build_object('aiEnabled',f.ai_polish_enabled,'globalDailyLimit',f.global_daily_limit,
      'allowlistedUsers',coalesce(cardinality(f.enabled_user_allowlist),0),'configGeneration',f.config_generation::text,
      'activePolicyVersionId',f.active_routing_policy_version_id,'currentLegalBundle',public.current_ai_terms_version()),
    'capabilities',jsonb_build_object('writes',e.control_plane_mode='jwt_v1')
  ) into v_result from public.admin_environment e cross join public.ai_feature_config f
    join public.admin_principals p on p.user_id=v_actor join auth.users u on u.id=p.user_id
    where e.id=true and f.id=true;
  if v_result is null then raise exception 'UNAVAILABLE' using errcode='P0001'; end if;
  return v_result;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_reopen_ai_v2(p_environment text, p_project_ref text, p_readback_report_id uuid, p_expected_closing_cycle_id uuid, p_expected_control_revision bigint, p_expected_policy_version_id uuid, p_expected_config_generation bigint, p_reason text, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
     or v_readback.report_schema_version is distinct from 'admin_runtime_readback_v4'
     or v_config.ai_polish_enabled or v_control.closing_cycle_id is distinct from p_expected_closing_cycle_id or v_control.reopened_at is not null
     or v_control.revision is distinct from p_expected_control_revision or v_config.active_routing_policy_version_id is distinct from p_expected_policy_version_id or v_config.config_generation is distinct from p_expected_config_generation
     or (v_readback.environment,v_readback.closing_cycle_id,v_readback.control_revision,v_readback.config_generation,v_readback.policy_version_id) is distinct from (p_environment,v_control.closing_cycle_id,v_control.revision,v_config.config_generation,v_config.active_routing_policy_version_id)
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_admin_config_validation_candidate_v2(p_runtime_contract_id text, p_runtime_target_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    'schemaVersion','admin_config_validation_candidate_v3',
    'environment',v_environment.environment,
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
$function$
;

CREATE OR REPLACE FUNCTION public.record_admin_config_validation_report_v2(p_runtime_contract_id text, p_runtime_target_id text, p_observed_code_capability_sha256 text, p_endpoint_policy_valid boolean, p_credential_binding_valid boolean, p_credential_configured boolean, p_compiled_capability_valid boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    'admin_config_validation_report_v3',v_environment.environment,
    v_target.runtime_contract_id,v_target.runtime_target_id,v_target.runtime_target_sha256,
    v_target.profile_version_id::text,v_target.price_version_id::text,v_target.provider_id::text,
    v_target.code_capability_id,v_target.code_capability_sha256,v_target.legal_bundle_version,
    v_target.legal_manifest_id,v_target.display_disclosure_key,
    p_endpoint_policy_valid::text,p_credential_binding_valid::text,p_credential_configured::text,
    p_compiled_capability_valid::text,v_database_binding_valid::text,array_to_string(v_evidence_ids,','),
    to_char(v_checked_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ),'UTF8'),'sha256'),'hex');
  insert into public.admin_config_validation_reports_v2(
    report_schema_version,environment,runtime_contract_id,runtime_target_id,runtime_target_sha256,
    profile_version_id,price_version_id,provider_id,code_capability_id,code_capability_sha256,
    legal_bundle_version,legal_manifest_id,display_disclosure_key,endpoint_policy_valid,
    credential_binding_valid,credential_configured,compiled_capability_valid,database_binding_valid,
    evidence_ids,checked_at,expires_at,report_sha256
  ) values (
    'admin_config_validation_report_v3',v_environment.environment,v_target.runtime_contract_id,v_target.runtime_target_id,v_target.runtime_target_sha256,
    v_target.profile_version_id,v_target.price_version_id,v_target.provider_id,v_target.code_capability_id,v_target.code_capability_sha256,
    v_target.legal_bundle_version,v_target.legal_manifest_id,v_target.display_disclosure_key,p_endpoint_policy_valid,
    p_credential_binding_valid,p_credential_configured,p_compiled_capability_valid,v_database_binding_valid,
    v_evidence_ids,v_checked_at,v_checked_at+interval '10 minutes',v_report_sha256
  ) returning * into v_report;
  return jsonb_build_object(
    'schemaVersion','admin_config_validation_report_v3','reportId',v_report.id,
    'environment',v_report.environment,
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_admin_runtime_readback_candidate_v3(p_policy_version_id uuid, p_validation_report_ids uuid[], p_environment text, p_project_ref text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
     or (v_environment.environment) is distinct from (p_environment)
     or v_config.ai_polish_enabled or v_config.active_routing_policy_version_id is distinct from v_policy.id
     or v_control.closing_cycle_id is null or v_control.reopened_at is not null
     or v_policy.legal_bundle_version is distinct from public.current_ai_terms_version() then
    raise exception 'READBACK_NOT_READY' using errcode='23514';
  end if;
  perform public.admin_assert_runtime_authority_receipt_v3(p_environment,p_project_ref);
  v_evidence:=public.admin_assert_policy_config_reports_v1(v_policy.id,p_validation_report_ids,clock_timestamp());
  select jsonb_agg(jsonb_build_object(
    'schemaVersion','admin_config_validation_candidate_v3','environment',v_environment.environment,
    'profileExecutionConfig',jsonb_build_object('schemaVersion',version.execution_schema_version,'profileKey',profile.profile_key,'providerId',provider.id,'gatewayKind',profile.gateway_kind,'adapterKind',version.adapter_kind,'wireApiKind',version.wire_api_kind,'endpointUrl',version.endpoint_url,'credentialEnvName',version.credential_env_name,'modelId',version.model_id,'capabilityContractId',version.capability_contract_id,'cachePolicyId',version.cache_policy_id,'legalManifestId',version.legal_manifest_id,'calculatorKind',price.calculator_kind,'displayDisclosureKey',version.display_disclosure_key,'config',version.config),
    'runtimeTarget',jsonb_build_object('runtimeContractId',target.runtime_contract_id,'runtimeTargetId',target.runtime_target_id,'runtimeTargetSha256',target.runtime_target_sha256,'profileVersionId',target.profile_version_id,'priceVersionId',target.price_version_id,'providerId',target.provider_id,'recipientKey',target.recipient_key,'codeCapabilityId',target.code_capability_id,'codeCapabilitySha256',target.code_capability_sha256,'legalBundleVersion',target.legal_bundle_version,'legalManifestId',target.legal_manifest_id,'displayDisclosureKey',target.display_disclosure_key)
  ) order by target.runtime_target_id) into v_candidates
  from jsonb_array_elements(v_evidence->'effectiveRoutes') route(value)
  join public.ai_runtime_target_bindings_v2 target on target.runtime_contract_id=v_policy.runtime_contract_id and target.runtime_target_id=route.value->>'runtimeTargetId'
  join public.ai_provider_profile_versions version on version.id=target.profile_version_id
  join public.ai_provider_profiles profile on profile.id=version.profile_id
  join public.ai_providers provider on provider.id=target.provider_id
  join public.ai_price_versions price on price.id=target.price_version_id;
  return jsonb_build_object('schemaVersion','admin_runtime_readback_candidate_v4','environment',v_environment.environment,'closingCycleId',v_control.closing_cycle_id,'controlRevision',v_control.revision::text,'configGeneration',v_config.config_generation::text,'policyVersionId',v_policy.id,'legalBundleVersion',v_policy.legal_bundle_version,'validationReportIds',v_evidence->'validationReportIds','effectiveRoutes',v_evidence->'effectiveRoutes','candidates',coalesce(v_candidates,'[]'::jsonb));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.record_admin_runtime_readback_v3(p_environment text, p_project_ref text, p_policy_version_id uuid, p_validation_report_ids uuid[], p_expected_closing_cycle_id uuid, p_expected_control_revision bigint, p_expected_config_generation bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
     or (v_environment.environment) is distinct from (p_environment)
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
  v_hash:=encode(extensions.digest(convert_to(concat_ws(E'\n','admin_runtime_readback_v4',v_environment.environment,v_control.closing_cycle_id::text,v_control.revision::text,v_config.config_generation::text,v_policy.id::text,v_policy.legal_bundle_version,array_to_string(v_ids,','),v_routes_sha,to_char(v_now at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),to_char(v_expires at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),'UTF8'),'sha256'),'hex');
  insert into public.admin_runtime_readback_reports_v2(report_schema_version,environment,closing_cycle_id,control_revision,config_generation,policy_version_id,legal_bundle_version,validation_report_ids,effective_routes,effective_routes_sha256,checked_at,expires_at,report_sha256) values ('admin_runtime_readback_v4',v_environment.environment,v_control.closing_cycle_id,v_control.revision,v_config.config_generation,v_policy.id,v_policy.legal_bundle_version,v_ids,v_routes,v_routes_sha,v_now,v_expires,v_hash) returning * into v_report;
  return jsonb_build_object('schemaVersion','admin_runtime_readback_v4','reportId',v_report.id,'environment',v_report.environment,'closingCycleId',v_report.closing_cycle_id,'controlRevision',v_report.control_revision::text,'configGeneration',v_report.config_generation::text,'policyVersionId',v_report.policy_version_id,'legalBundleVersion',v_report.legal_bundle_version,'validationReportIds',to_jsonb(v_report.validation_report_ids),'effectiveRoutes',v_report.effective_routes,'checkedAt',v_report.checked_at,'expiresAt',v_report.expires_at,'reportSha256',v_report.report_sha256);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_assert_policy_config_reports_v1(p_policy_version_id uuid, p_validation_report_ids uuid[], p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      where report.id=any(p_validation_report_ids) and report.report_schema_version='admin_config_validation_report_v3' and report.passed and report.expires_at>p_at
        and report.environment=v_environment.environment
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
    'environment',v_environment.environment,
    'policyVersionId',v_policy.id,'legalBundleVersion',v_policy.legal_bundle_version,
    'validationReportIds',to_jsonb(v_ids),'effectiveRoutes',v_routes,
    'expiresAt',(select min(expires_at) from public.admin_config_validation_reports_v2 where id=any(p_validation_report_ids)));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_assert_candidate_policy_config_reports_v2(p_policy public.ai_routing_policy_versions, p_validation_report_ids uuid[], p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_environment public.admin_environment%rowtype; v_routes jsonb; v_ids uuid[];
begin
  if p_at is null or p_validation_report_ids is null or cardinality(p_validation_report_ids) not between 1 and 64
     or cardinality(p_validation_report_ids) is distinct from (select count(distinct id) from unnest(p_validation_report_ids) id) then
    raise exception 'INVALID_REQUEST' using errcode='22023';
  end if;
  select * into v_environment from public.admin_environment where id=true;
  if v_environment.id is null then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  with route_pairs as (
    select distinct (p_policy.rules->'defaultRoute'->>'profileVersionId')::uuid profile_version_id,
      (p_policy.rules->'defaultRoute'->>'priceVersionId')::uuid price_version_id
    union
    select distinct (entry.value->'route'->>'profileVersionId')::uuid,
      (entry.value->'route'->>'priceVersionId')::uuid
    from jsonb_array_elements(p_policy.rules->'windows') entry(value)
  )
  select jsonb_agg(jsonb_build_object(
    'profileVersionId',binding.profile_version_id,'priceVersionId',binding.price_version_id,
    'runtimeTargetId',binding.runtime_target_id,'runtimeTargetSha256',binding.runtime_target_sha256,
    'providerId',binding.provider_id,'codeCapabilityId',binding.code_capability_id,
    'codeCapabilitySha256',binding.code_capability_sha256,'legalManifestId',binding.legal_manifest_id,
    'displayDisclosureKey',binding.display_disclosure_key
  ) order by binding.profile_version_id,binding.price_version_id) into v_routes
  from route_pairs pair join public.ai_runtime_target_bindings_v2 binding
    on binding.runtime_contract_id=p_policy.runtime_contract_id
   and binding.profile_version_id=pair.profile_version_id and binding.price_version_id=pair.price_version_id
   and binding.legal_bundle_version=p_policy.legal_bundle_version;
  if v_routes is null or jsonb_array_length(v_routes) is distinct from cardinality(p_validation_report_ids) then
    raise exception 'VALIDATION_REPORT_MISMATCH' using errcode='23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_routes) route(value)
    where (select count(*) from public.admin_config_validation_reports_v2 report
      where report.id=any(p_validation_report_ids) and report.report_schema_version='admin_config_validation_report_v3' and report.passed and report.expires_at>p_at
        and report.environment=v_environment.environment
        and report.runtime_contract_id=p_policy.runtime_contract_id and report.legal_bundle_version=p_policy.legal_bundle_version
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
    'environment',v_environment.environment,
    'policyVersionId',p_policy.id,'legalBundleVersion',p_policy.legal_bundle_version,
    'validationReportIds',to_jsonb(v_ids),'effectiveRoutes',v_routes,
    'expiresAt',(select min(expires_at) from public.admin_config_validation_reports_v2 where id=any(p_validation_report_ids)));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_config_validation_evidence_v2(p_report_id uuid, p_expected_profile_version_id uuid, p_expected_price_version_id uuid, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_report public.admin_config_validation_reports_v2%rowtype;
begin
  select report.* into v_report
  from public.admin_config_validation_reports_v2 report
  join public.admin_environment environment on environment.id=true
    and environment.environment=report.environment
  where report.id=p_report_id and report.report_schema_version='admin_config_validation_report_v3' and report.passed and report.expires_at>p_at and report.checked_at<=p_at;
  if p_at is null or v_report.id is null
     or (p_expected_profile_version_id is not null and v_report.profile_version_id is distinct from p_expected_profile_version_id)
     or (p_expected_price_version_id is not null and v_report.price_version_id is distinct from p_expected_price_version_id) then
    raise exception 'VALIDATION_REPORT_MISMATCH' using errcode='23514';
  end if;
  return jsonb_build_object('reportId',v_report.id,'runtimeContractId',v_report.runtime_contract_id,
    'recheckedAt',v_report.checked_at,'reportSha256',v_report.report_sha256,'expiresAt',v_report.expires_at);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_cutover_authority_v3(p_validation_report_ids uuid[], p_expected_environment_revision bigint, p_expected_control_revision bigint, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    where environment=v_environment.environment and authority_scope='jwt_v1';
  insert into public.admin_runtime_authority_receipts_v3(environment,authority_scope,authority_epoch,authority_manifest,authority_manifest_sha256) values(v_environment.environment,'jwt_v1',v_authority_epoch,v_manifest,v_manifest_sha256) returning receipt_id into v_receipt;
  insert into public.admin_audit_events(operation,actor,target_id,reason) values ('admin_authority_cutover','db_operator',v_config.active_routing_policy_version_id,p_reason) returning id into v_audit;
  return jsonb_build_object('schemaVersion','admin_authority_cutover_v3','auditId',v_audit,'controlPlaneMode',v_environment.control_plane_mode,'environmentRevision',v_environment.revision::text,'controlRevision',v_control.revision::text,'closingCycleId',v_control.closing_cycle_id,'activePolicyVersionId',v_config.active_routing_policy_version_id,'configGeneration',v_config.config_generation::text,'validationReportIds',v_evidence->'validationReportIds','authorityReceiptId',v_receipt,'authorityEpoch',v_authority_epoch::text,'authorityManifestSha256',v_manifest_sha256);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_ai_polish_execution_snapshot_v5(p_reservation_id uuid, p_user_id uuid, p_environment text, p_project_ref text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if v_environment.id is null or (v_environment.environment) is distinct from (p_environment) then
    return jsonb_build_object('schemaVersion','ai_polish_execution_snapshot_v1','ok',false,'reason','SERVICE_UNAVAILABLE');
  end if;
  perform public.admin_assert_runtime_authority_receipt_v3(p_environment,p_project_ref);
  select * into v_target from public.ai_runtime_target_bindings_v2 where runtime_contract_id=v_snapshot#>>'{runtimeEvidence,runtimeContractId}' and runtime_target_id=v_snapshot#>>'{runtimeEvidence,runtimeTargetId}';
  if v_target.runtime_target_id is null or (v_target.runtime_target_sha256,v_target.profile_version_id::text,v_target.price_version_id::text,v_target.provider_id::text,v_target.code_capability_id,v_target.code_capability_sha256,v_target.legal_bundle_version,v_target.legal_manifest_id,v_target.display_disclosure_key) is distinct from (v_snapshot#>>'{runtimeEvidence,runtimeTargetSha256}',v_snapshot#>>'{runtimeEvidence,profileVersionId}',v_snapshot#>>'{runtimeEvidence,priceVersionId}',v_snapshot#>>'{runtimeEvidence,providerId}',v_snapshot#>>'{runtimeEvidence,codeCapabilityId}',v_snapshot#>>'{runtimeEvidence,codeCapabilitySha256}',v_snapshot#>>'{runtimeEvidence,legalBundleVersion}',v_snapshot#>>'{runtimeEvidence,legalManifestId}',v_snapshot#>>'{runtimeEvidence,displayDisclosureKey}') then
    return jsonb_build_object('schemaVersion','ai_polish_execution_snapshot_v1','ok',false,'reason','SERVICE_UNAVAILABLE');
  end if;
  return jsonb_set(jsonb_set(v_snapshot - 'deploymentValidation','{schemaVersion}',to_jsonb('ai_polish_execution_snapshot_v3'::text)),'{runtimeConfigReceipt}',jsonb_build_object(
    'schemaVersion','runtime_config_receipt_v2','environment',v_environment.environment,
    'runtimeContractId',v_target.runtime_contract_id,'runtimeTargetId',v_target.runtime_target_id,'runtimeTargetSha256',v_target.runtime_target_sha256,
    'profileVersionId',v_target.profile_version_id,'priceVersionId',v_target.price_version_id,'providerId',v_target.provider_id,
    'codeCapabilityId',v_target.code_capability_id,'codeCapabilitySha256',v_target.code_capability_sha256,
    'legalBundleVersion',v_target.legal_bundle_version,'legalManifestId',v_target.legal_manifest_id,'displayDisclosureKey',v_target.display_disclosure_key));
exception when others then return jsonb_build_object('schemaVersion','ai_polish_execution_snapshot_v1','ok',false,'reason','SERVICE_UNAVAILABLE'); end;
$function$
;

CREATE OR REPLACE FUNCTION public.start_ai_polish_provider_attempt_v5(p_reservation_id uuid, p_attempt_no integer, p_runtime_config_receipt jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
     or (select count(*) from jsonb_object_keys(p_runtime_config_receipt)) <> 13
     or p_runtime_config_receipt->>'schemaVersion' is distinct from 'runtime_config_receipt_v2' then
    raise exception 'runtime configuration receipt is malformed' using errcode='22023';
  end if;
  select * into v_environment from public.admin_environment where id=true for share;
  perform public.admin_assert_runtime_authority_receipt_v3(
    p_runtime_config_receipt->>'environment',null
  );
  select * into v_target from public.ai_runtime_target_bindings_v2
    where runtime_contract_id=p_runtime_config_receipt->>'runtimeContractId'
      and runtime_target_id=p_runtime_config_receipt->>'runtimeTargetId' for share;
  if v_environment.id is null or v_target.runtime_target_id is null
     or (p_runtime_config_receipt->>'environment',
         p_runtime_config_receipt->>'runtimeTargetSha256',p_runtime_config_receipt->>'profileVersionId',
         p_runtime_config_receipt->>'priceVersionId',p_runtime_config_receipt->>'providerId',
         p_runtime_config_receipt->>'codeCapabilityId',p_runtime_config_receipt->>'codeCapabilitySha256',
         p_runtime_config_receipt->>'legalBundleVersion',p_runtime_config_receipt->>'legalManifestId',
         p_runtime_config_receipt->>'displayDisclosureKey') is distinct from
        (v_environment.environment,v_target.runtime_target_sha256,v_target.profile_version_id::text,
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
$function$
;

-- Update only the explicitly replaced, migration-owned covered definitions.
-- Keep all other expected hashes and all existing grants unchanged.
set local search_path='';
update public.admin_runtime_authority_expected_v3 expected
set definition_sha256=encode(extensions.digest(replace(replace(pg_catalog.pg_get_functiondef(proc.oid),chr(13)||chr(10),chr(10)),chr(13),chr(10)),'sha256'),'hex')
from pg_catalog.pg_proc proc
where proc.oid=pg_catalog.to_regprocedure(expected.signature)
  and proc.oid=any(array['public.admin_assert_actor_v1(text,text)'::regprocedure,
    'public.admin_assert_write_actor_v1(text,text,boolean)'::regprocedure,
    'public.admin_assert_runtime_authority_receipt_v3(text,text)'::regprocedure,
    'public.admin_get_context_v1(text,text)'::regprocedure,
    'public.admin_reopen_ai_v2(text,text,uuid,uuid,bigint,uuid,bigint,text,uuid)'::regprocedure,
    'public.get_admin_config_validation_candidate_v2(text,text)'::regprocedure,
    'public.record_admin_config_validation_report_v2(text,text,text,boolean,boolean,boolean,boolean)'::regprocedure,
    'public.get_admin_runtime_readback_candidate_v3(uuid,uuid[],text,text)'::regprocedure,
    'public.record_admin_runtime_readback_v3(text,text,uuid,uuid[],uuid,bigint,bigint)'::regprocedure,
    'public.admin_assert_policy_config_reports_v1(uuid,uuid[],timestamp with time zone)'::regprocedure,
    'public.admin_assert_candidate_policy_config_reports_v2(public.ai_routing_policy_versions,uuid[],timestamp with time zone)'::regprocedure,
    'public.admin_config_validation_evidence_v2(uuid,uuid,uuid,timestamp with time zone)'::regprocedure,
    'public.admin_cutover_authority_v3(uuid[],bigint,bigint,text)'::regprocedure,
    'public.get_ai_polish_execution_snapshot_v5(uuid,uuid,text,text)'::regprocedure,
    'public.start_ai_polish_provider_attempt_v5(uuid,integer,jsonb)'::regprocedure]::oid[]);

-- Continue only authority that passed the preflight. This appends an upgrade
-- receipt; it does not repeat cutover or modify mode, gate, pointer, revisions,
-- membership, legal identity, quota, committed operations or historical receipts.
do $upgrade$
declare item record; manifest jsonb; manifest_sha text; next_epoch bigint;
begin
  for item in select environment from pg_temp.admin_bootstrap_upgrade_state loop
    manifest:=public.admin_current_runtime_authority_manifest_v3();
    manifest_sha:=encode(extensions.digest(convert_to(manifest::text,'UTF8'),'sha256'),'hex');
    select coalesce(max(authority_epoch),0)+1 into next_epoch
      from public.admin_runtime_authority_receipts_v3
      where environment=item.environment and authority_scope='jwt_v1';
    insert into public.admin_runtime_authority_receipts_v3(environment,authority_scope,authority_epoch,authority_manifest,authority_manifest_sha256)
      values(item.environment,'jwt_v1',next_epoch,manifest,manifest_sha);
    perform public.admin_assert_runtime_authority_receipt_v3(item.environment,null);
  end loop;
end;
$upgrade$;
notify pgrst, 'reload schema';
commit;
