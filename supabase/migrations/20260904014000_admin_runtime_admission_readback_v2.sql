begin;

create or replace function public.record_admin_runtime_readback_v1(
  p_reviewed_deployment_id uuid,
  p_policy_version_id uuid,
  p_validation_report_ids uuid[],
  p_observed_runtime_build_id text,
  p_observed_binding_manifest_revision text,
  p_observed_binding_manifest_sha256 text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := clock_timestamp();
  v_config public.ai_feature_config%rowtype;
  v_control public.admin_ai_control_state_v1%rowtype;
  v_policy public.ai_routing_policy_versions%rowtype;
  v_deployment public.admin_reviewed_deployments_v1%rowtype;
  v_admission public.admin_admitted_runtime_deployments_v2%rowtype;
  v_evidence jsonb;
  v_routes jsonb;
  v_report_ids uuid[];
  v_route_count integer;
  v_routes_sha256 text;
  v_report_sha256 text;
  v_expires_at timestamptz;
  v_readback public.admin_runtime_readback_reports_v1%rowtype;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_config from public.ai_feature_config where id = true for share;
  select * into v_control from public.admin_ai_control_state_v1 where id = true for share;
  select * into v_policy from public.ai_routing_policy_versions
  where id = p_policy_version_id for share;
  select * into v_deployment from public.admin_reviewed_deployments_v1
  where id = p_reviewed_deployment_id
    and runtime_build_id = p_observed_runtime_build_id
    and binding_manifest_revision = p_observed_binding_manifest_revision
    and binding_manifest_sha256 = p_observed_binding_manifest_sha256
    and valid_until > v_now for share;
  if v_config.id is null or v_control.id is null or v_policy.id is null
     or v_deployment.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into v_admission from public.admin_admitted_runtime_deployments_v2
  where reviewed_deployment_id = v_deployment.id
    and environment = v_deployment.environment
    and project_ref = v_deployment.project_ref
    and runtime_build_id = v_deployment.runtime_build_id
    and binding_manifest_revision = v_deployment.binding_manifest_revision
    and binding_manifest_sha256 = v_deployment.binding_manifest_sha256
    and sealed_at is not null and revoked_at is null for share;
  if not found then
    raise exception 'READBACK_ADMISSION_REQUIRED' using errcode = '23514';
  end if;
  if v_config.ai_polish_enabled
     or v_config.active_routing_policy_version_id is distinct from v_policy.id
     or v_control.closing_cycle_id is null or v_control.reopened_at is not null
     or v_policy.legal_bundle_version is distinct from public.current_ai_terms_version()
     or v_deployment.environment is distinct from
       (select environment from public.admin_environment where id = true)
     or v_deployment.project_ref is distinct from
       (select project_ref from public.admin_environment where id = true) then
    raise exception 'READBACK_NOT_READY' using errcode = '23514';
  end if;
  v_evidence := public.admin_assert_policy_validation_reports_v1(
    v_policy.id, p_validation_report_ids, v_now
  );
  if (v_evidence ->> 'reviewedDeploymentId')::uuid is distinct from v_deployment.id then
    raise exception 'READBACK_DEPLOYMENT_MISMATCH' using errcode = '23514';
  end if;
  v_report_ids := array(select jsonb_array_elements_text(
    v_evidence -> 'validationReportIds'
  )::uuid);
  v_routes := v_evidence -> 'effectiveRoutes';
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
      and target.provider_id::text = route.value ->> 'providerId'
      and target.code_capability_id = route.value ->> 'codeCapabilityId'
      and target.code_capability_sha256 = route.value ->> 'codeCapabilitySha256'
      and target.legal_bundle_version = v_policy.legal_bundle_version
      and target.legal_manifest_id = route.value ->> 'legalManifestId'
      and target.display_disclosure_key = route.value ->> 'displayDisclosureKey'
  );
  if v_route_count is distinct from jsonb_array_length(v_routes) then
    raise exception 'READBACK_ADMISSION_MISMATCH' using errcode = '23514';
  end if;
  v_routes_sha256 := encode(extensions.digest(
    convert_to(v_routes::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_expires_at := least(v_now + interval '10 minutes',
    v_deployment.valid_until, (v_evidence ->> 'expiresAt')::timestamptz);
  if v_expires_at <= v_now then
    raise exception 'READBACK_NOT_READY' using errcode = '23514';
  end if;
  v_report_sha256 := encode(extensions.digest(convert_to(concat_ws(E'\n',
    'admin_runtime_readback_v2', v_control.closing_cycle_id::text,
    v_control.revision::text, v_config.config_generation::text,
    v_policy.id::text, v_policy.legal_bundle_version,
    v_deployment.id::text, v_deployment.runtime_build_id,
    v_deployment.binding_manifest_revision, v_deployment.binding_manifest_sha256,
    v_admission.admission_id::text, v_admission.admission_revision::text,
    v_admission.target_set_sha256, array_to_string(v_report_ids, ','),
    v_routes_sha256,
    to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    to_char(v_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ), 'UTF8'), 'sha256'), 'hex');
  insert into public.admin_runtime_readback_reports_v1(
    closing_cycle_id, control_revision, config_generation,
    policy_version_id, legal_bundle_version, reviewed_deployment_id,
    runtime_build_id, binding_manifest_revision, binding_manifest_sha256,
    validation_report_ids, effective_routes, effective_routes_sha256,
    checked_at, expires_at, report_sha256, admission_id,
    admission_revision, target_set_sha256
  ) values (
    v_control.closing_cycle_id, v_control.revision, v_config.config_generation,
    v_policy.id, v_policy.legal_bundle_version, v_deployment.id,
    v_deployment.runtime_build_id, v_deployment.binding_manifest_revision,
    v_deployment.binding_manifest_sha256, v_report_ids, v_routes,
    v_routes_sha256, v_now, v_expires_at, v_report_sha256,
    v_admission.admission_id, v_admission.admission_revision,
    v_admission.target_set_sha256
  ) returning * into v_readback;
  return jsonb_build_object(
    'schemaVersion','admin_runtime_readback_v2','reportId',v_readback.id,
    'closingCycleId',v_readback.closing_cycle_id,
    'controlRevision',v_readback.control_revision::text,
    'configGeneration',v_readback.config_generation::text,
    'policyVersionId',v_readback.policy_version_id,
    'legalBundleVersion',v_readback.legal_bundle_version,
    'reviewedDeploymentId',v_readback.reviewed_deployment_id,
    'runtimeBuildId',v_readback.runtime_build_id,
    'bindingManifestRevision',v_readback.binding_manifest_revision,
    'bindingManifestSha256',v_readback.binding_manifest_sha256,
    'admissionId',v_readback.admission_id,
    'admissionRevision',v_readback.admission_revision::text,
    'targetSetSha256',v_readback.target_set_sha256,
    'validationReportIds',to_jsonb(v_readback.validation_report_ids),
    'effectiveRoutes',v_readback.effective_routes,
    'checkedAt',v_readback.checked_at,'expiresAt',v_readback.expires_at,
    'reportSha256',v_readback.report_sha256
  );
end;
$$;

create or replace function public.admin_reopen_ai_v1(
  p_environment text, p_project_ref text, p_readback_report_id uuid,
  p_expected_closing_cycle_id uuid, p_expected_control_revision bigint,
  p_expected_policy_version_id uuid, p_expected_config_generation bigint,
  p_reason text, p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid;
  v_payload jsonb;
  v_replay jsonb;
  v_now timestamptz := clock_timestamp();
  v_config public.ai_feature_config%rowtype;
  v_control public.admin_ai_control_state_v1%rowtype;
  v_policy public.ai_routing_policy_versions%rowtype;
  v_readback public.admin_runtime_readback_reports_v1%rowtype;
  v_admission public.admin_admitted_runtime_deployments_v2%rowtype;
  v_route_count integer;
  v_audit uuid;
  v_result jsonb;
begin
  v_actor := public.admin_assert_write_actor_v1(p_environment,p_project_ref,false);
  perform public.admin_assert_jwt_control_mode_v1();
  v_payload := jsonb_build_object(
    'readbackReportId',p_readback_report_id,
    'expectedClosingCycleId',p_expected_closing_cycle_id,
    'expectedControlRevision',p_expected_control_revision,
    'expectedPolicyVersionId',p_expected_policy_version_id,
    'expectedConfigGeneration',p_expected_config_generation,'reason',p_reason
  );
  v_replay := public.admin_lock_committed_operation_v1(
    v_actor,'ai_reopen',p_idempotency_key,v_payload
  );
  if (v_replay ->> 'found')::boolean then
    return public.admin_replayed_operation_v1(v_replay,'ai_reopen',p_idempotency_key);
  end if;
  if not public.admin_has_recent_totp_v1(v_actor) then
    raise exception 'STEP_UP_REQUIRED' using errcode = '42501';
  end if;
  if p_reason is null or p_reason <> btrim(p_reason)
     or length(p_reason) not between 1 and 500 then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  select * into v_config from public.ai_feature_config where id = true for update;
  select * into v_control from public.admin_ai_control_state_v1 where id = true for update;
  select * into v_policy from public.ai_routing_policy_versions
  where id = p_expected_policy_version_id for share;
  select * into v_readback from public.admin_runtime_readback_reports_v1
  where id = p_readback_report_id for share;
  if v_config.id is null or v_control.id is null or v_policy.id is null
     or v_readback.id is null or v_readback.admission_id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into v_admission from public.admin_admitted_runtime_deployments_v2
  where admission_id = v_readback.admission_id
    and reviewed_deployment_id = v_readback.reviewed_deployment_id
    and runtime_build_id = v_readback.runtime_build_id
    and binding_manifest_revision = v_readback.binding_manifest_revision
    and binding_manifest_sha256 = v_readback.binding_manifest_sha256
    and admission_revision = v_readback.admission_revision
    and target_set_sha256 = v_readback.target_set_sha256
    and sealed_at is not null and revoked_at is null for share;
  if not found then raise exception 'NOT_READY' using errcode = '23514'; end if;
  select count(*)::integer into v_route_count
  from jsonb_array_elements(v_readback.effective_routes) route(value)
  where exists (
    select 1 from public.admin_admitted_runtime_targets_v2 target
    where target.admission_id = v_admission.admission_id
      and target.runtime_contract_id = v_policy.runtime_contract_id
      and target.runtime_target_id = route.value ->> 'runtimeTargetId'
      and target.runtime_target_sha256 = route.value ->> 'runtimeTargetSha256'
      and target.profile_version_id::text = route.value ->> 'profileVersionId'
      and target.price_version_id::text = route.value ->> 'priceVersionId'
      and target.provider_id::text = route.value ->> 'providerId'
      and target.code_capability_id = route.value ->> 'codeCapabilityId'
      and target.code_capability_sha256 = route.value ->> 'codeCapabilitySha256'
      and target.legal_bundle_version = v_readback.legal_bundle_version
      and target.legal_manifest_id = route.value ->> 'legalManifestId'
      and target.display_disclosure_key = route.value ->> 'displayDisclosureKey'
  );
  if v_config.ai_polish_enabled
     or v_control.closing_cycle_id is distinct from p_expected_closing_cycle_id
     or v_control.reopened_at is not null
     or v_control.revision is distinct from p_expected_control_revision
     or v_config.active_routing_policy_version_id is distinct from p_expected_policy_version_id
     or v_config.config_generation is distinct from p_expected_config_generation
     or (v_readback.closing_cycle_id,v_readback.control_revision,
         v_readback.config_generation,v_readback.policy_version_id)
       is distinct from
       (v_control.closing_cycle_id,v_control.revision,
         v_config.config_generation,v_config.active_routing_policy_version_id)
     or v_readback.legal_bundle_version is distinct from public.current_ai_terms_version()
     or v_readback.expires_at <= v_now
     or v_route_count is distinct from jsonb_array_length(v_readback.effective_routes)
     or not exists (
       select 1 from public.admin_reviewed_deployments_v1 deployment
       where deployment.id = v_readback.reviewed_deployment_id
         and deployment.valid_until > v_now
         and deployment.runtime_build_id = v_readback.runtime_build_id
         and deployment.binding_manifest_revision = v_readback.binding_manifest_revision
         and deployment.binding_manifest_sha256 = v_readback.binding_manifest_sha256
     )
     or exists (
       select 1 from unnest(v_readback.validation_report_ids) selected(id)
       left join public.admin_validation_reports_v1 report
         on report.id = selected.id and report.passed and report.expires_at > v_now
       where report.id is null
     ) then
    raise exception 'NOT_READY' using errcode = '23514';
  end if;
  update public.ai_feature_config set ai_polish_enabled = true where id = true;
  update public.admin_ai_control_state_v1 set
    revision = revision + 1, reopened_at = clock_timestamp()
  where id = true returning * into v_control;
  insert into public.admin_audit_events(operation,actor,target_id,reason)
  values ('ai_reopen',v_actor::text,p_expected_policy_version_id,p_reason)
  returning id into v_audit;
  v_result := jsonb_build_object(
    'schemaVersion','admin_ai_control_result_v1','aiEnabled',true,
    'controlRevision',v_control.revision::text,
    'closingCycleId',v_control.closing_cycle_id,
    'configGeneration',v_config.config_generation::text,
    'activePolicyVersionId',v_config.active_routing_policy_version_id,
    'readbackReportId',v_readback.id,'admissionId',v_admission.admission_id,
    'admissionRevision',v_admission.admission_revision::text,
    'targetSetSha256',v_admission.target_set_sha256
  );
  return public.admin_commit_operation_v1(
    v_actor,'ai_reopen',p_idempotency_key,v_payload,v_result,v_audit
  );
end;
$$;

-- Rename the original owner-only cutover so the documented entry point cannot
-- adopt JWT authority without the successor admission check.
do $$
begin
  if to_regprocedure(
    'public.admin_cutover_authority_v1(uuid,uuid[],bigint,bigint,text)'
  ) is not null and to_regprocedure(
    'public.admin_cutover_authority_legacy_internal_v1(uuid,uuid[],bigint,bigint,text)'
  ) is null then
    alter function public.admin_cutover_authority_v1(
      uuid,uuid[],bigint,bigint,text
    ) rename to admin_cutover_authority_legacy_internal_v1;
  end if;
end;
$$;
revoke all on function public.admin_cutover_authority_legacy_internal_v1(
  uuid,uuid[],bigint,bigint,text
) from public, anon, authenticated, service_role;

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
begin
  if session_user not in ('postgres','supabase_admin') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if to_regprocedure('public.start_ai_polish_provider_attempt_v3(uuid,integer,uuid,uuid,uuid,text,text,text,text,text,bigint,text,text,text,text)') is null
     or to_regprocedure('public.get_ai_polish_execution_snapshot_v4(uuid,uuid,text,text,text,text,text)') is null
     or to_regprocedure('public.admin_admit_runtime_deployment_v2(uuid,jsonb,text)') is null
     or to_regprocedure('public.admin_revoke_runtime_deployment_v2(uuid,bigint,text,text)') is null then
    raise exception 'CUTOVER_SCHEMA_MISMATCH' using errcode = '23514';
  end if;
  v_result := public.admin_cutover_authority_legacy_internal_v1(
    p_reviewed_deployment_id,p_validation_report_ids,
    p_expected_environment_revision,p_expected_control_revision,p_reason
  );
  select * into v_admission from public.admin_admitted_runtime_deployments_v2
  where admission_id = p_admission_id
    and reviewed_deployment_id = p_reviewed_deployment_id
    and sealed_at is not null and revoked_at is null for share;
  if not found then
    raise exception 'CUTOVER_ADMISSION_REQUIRED' using errcode = '23514';
  end if;
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
  if v_route_count is distinct from jsonb_array_length(v_routes) then
    raise exception 'CUTOVER_ADMISSION_MISMATCH' using errcode = '23514';
  end if;
  execute 'revoke execute on function public.start_ai_polish_provider_attempt_v2(uuid,integer,text,text) from service_role';
  execute 'revoke execute on function public.get_ai_polish_execution_snapshot_v2(uuid,uuid) from service_role';
  return v_result || jsonb_build_object(
    'schemaVersion','admin_authority_cutover_v2',
    'admissionId',v_admission.admission_id,
    'admissionRevision',v_admission.admission_revision::text,
    'targetSetSha256',v_admission.target_set_sha256
  );
end;
$$;

revoke all on function public.record_admin_runtime_readback_v1(
  uuid,uuid,uuid[],text,text,text
), public.admin_reopen_ai_v1(
  text,text,uuid,uuid,bigint,uuid,bigint,text,uuid
), public.admin_cutover_authority_v2(
  uuid,uuid,uuid[],bigint,bigint,text
) from public, anon, authenticated, service_role;
grant execute on function public.record_admin_runtime_readback_v1(
  uuid,uuid,uuid[],text,text,text
) to service_role;
grant execute on function public.admin_reopen_ai_v1(
  text,text,uuid,uuid,bigint,uuid,bigint,text,uuid
) to authenticated;

-- A database already operating under JWT authority must not retain the direct
-- pre-admission V2 runtime entry points after this successor migration.
do $$
begin
  if exists (
    select 1 from public.admin_environment
    where id = true and control_plane_mode = 'jwt_v1'
  ) then
    revoke execute on function public.start_ai_polish_provider_attempt_v2(
      uuid,integer,text,text
    ) from service_role;
    revoke execute on function public.get_ai_polish_execution_snapshot_v2(
      uuid,uuid
    ) from service_role;
  end if;
end;
$$;

commit;
