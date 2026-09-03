-- ADM-I07C: publication/lifecycle wrappers. Browser callers reference
-- immutable deployment/report IDs; actor and all evidence hashes are derived.
begin;

create function public.admin_runtime_validation_evidence_v1(
  p_report_id uuid,
  p_expected_profile_version_id uuid,
  p_expected_price_version_id uuid,
  p_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_report public.admin_validation_reports_v1%rowtype;
  v_deployment public.admin_reviewed_deployments_v1%rowtype;
begin
  select report.* into v_report
  from public.admin_validation_reports_v1 report
  join public.admin_environment environment on environment.id=true
   and environment.environment=report.environment
   and environment.project_ref=report.project_ref
  where report.id=p_report_id and report.passed and report.expires_at>p_at;
  select deployment.* into v_deployment
  from public.admin_reviewed_deployments_v1 deployment
  where deployment.id=v_report.reviewed_deployment_id
    and deployment.environment=v_report.environment
    and deployment.project_ref=v_report.project_ref
    and deployment.runtime_build_id=v_report.runtime_build_id
    and deployment.binding_manifest_revision=v_report.binding_manifest_revision
    and deployment.binding_manifest_sha256=v_report.binding_manifest_sha256
    and deployment.valid_until>p_at;
  if v_report.id is null
     or (p_expected_profile_version_id is not null
       and v_report.profile_version_id is distinct from p_expected_profile_version_id)
     or (p_expected_price_version_id is not null
       and v_report.price_version_id is distinct from p_expected_price_version_id)
     or v_deployment.reviewed_source_commit_oid !~ '^sha1:[0-9a-f]{40}$'
     or v_report.checked_at>p_at then
    raise exception 'VALIDATION_REPORT_MISMATCH' using errcode='23514';
  end if;
  return jsonb_build_object('reportId',v_report.id,
    'reviewedDeploymentId',v_deployment.id,
    'runtimeContractId',v_report.runtime_contract_id,
    'reviewedSourceCommitOid',v_deployment.reviewed_source_commit_oid,
    'reviewedSourceSha256',v_deployment.reviewed_source_sha256,
    'recheckedAt',v_report.checked_at,'recheckedSha256',v_report.report_sha256,
    'expiresAt',least(v_report.expires_at,v_deployment.valid_until));
end;
$$;

create function public.admin_seal_price_for_activation_v1(
  p_environment text,p_project_ref text,p_price_version_id uuid,
  p_runtime_contract_id text,p_reviewed_deployment_id uuid,
  p_reason text,p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid; v_payload jsonb; v_replay jsonb; v_at timestamptz:=clock_timestamp();
  v_price public.ai_price_versions%rowtype;
  v_version public.ai_provider_profile_versions%rowtype;
  v_profile public.ai_provider_profiles%rowtype;
  v_deployment public.admin_reviewed_deployments_v1%rowtype;
  v_components jsonb; v_rechecked_sha256 text;
  v_lifecycle_audit uuid; v_admin_audit uuid; v_result jsonb;
begin
  v_actor:=public.admin_assert_write_actor_v1(p_environment,p_project_ref,false);
  perform public.admin_assert_jwt_control_mode_v1();
  v_payload:=jsonb_build_object('priceVersionId',p_price_version_id,
    'runtimeContractId',p_runtime_contract_id,'reviewedDeploymentId',p_reviewed_deployment_id,
    'reason',p_reason);
  v_replay:=public.admin_lock_committed_operation_v1(v_actor,'price_seal',p_idempotency_key,v_payload);
  if (v_replay->>'found')::boolean then
    return public.admin_replayed_operation_v1(v_replay,'price_seal',p_idempotency_key);
  end if;
  if not public.admin_has_recent_totp_v1(v_actor) then raise exception 'STEP_UP_REQUIRED' using errcode='42501'; end if;
  perform public.admin_assert_reason_v1(p_reason);
  select * into v_price from public.ai_price_versions where id=p_price_version_id for update;
  select * into v_version from public.ai_provider_profile_versions where id=v_price.profile_version_id for share;
  select * into v_profile from public.ai_provider_profiles where id=v_version.profile_id for share;
  select * into v_deployment from public.admin_reviewed_deployments_v1 deployment
  where deployment.id=p_reviewed_deployment_id and deployment.environment=p_environment
    and deployment.project_ref=p_project_ref and deployment.valid_until>v_at for share;
  if v_price.id is null or v_version.id is null or v_profile.id is null or v_deployment.id is null
     or v_deployment.reviewed_source_commit_oid !~ '^sha1:[0-9a-f]{40}$'
     or not exists(
       select 1 from public.admin_reviewed_deployment_capabilities_v1 reviewed
       join public.ai_runtime_code_capabilities_v2 capability
         on capability.code_capability_id=reviewed.code_capability_id
        and capability.descriptor_sha256=reviewed.code_capability_sha256
       where reviewed.reviewed_deployment_id=v_deployment.id
         and capability.gateway_kind=v_profile.gateway_kind
         and capability.adapter_kind=v_version.adapter_kind
         and capability.wire_api_kind=v_version.wire_api_kind
         and capability.capability_contract_id=v_version.capability_contract_id
         and capability.cache_policy_id=v_version.cache_policy_id
         and capability.calculator_kind=v_price.calculator_kind
     ) then
    raise exception 'PRICE_SEAL_NOT_READY' using errcode='23514';
  end if;
  select jsonb_object_agg(component,nanos_per_million::text order by component)
  into v_components from public.ai_price_components where price_version_id=v_price.id;
  v_rechecked_sha256:=public.admin_json_jcs_sha256_v1(jsonb_build_object(
    'schemaVersion','admin_price_recheck_v1','priceVersionId',v_price.id,
    'sourceUrl',v_price.source_url,'sourceSnapshotSha256',v_price.source_snapshot_sha256,
    'currency',v_price.currency,'calculatorKind',v_price.calculator_kind,
    'providerEffectiveFrom',v_price.provider_effective_from,
    'providerEffectiveTo',v_price.provider_effective_to,
    'parameters',v_price.parameters,'components',v_components));
  select public.seal_ai_price_for_activation_v1(v_price.id,v_price.source_url,
    v_price.currency,v_price.calculator_kind,v_price.provider_effective_from,
    v_price.provider_effective_to,v_price.parameters,v_components,p_runtime_contract_id,
    v_actor::text,p_reason,v_deployment.reviewed_source_commit_oid,
    v_deployment.reviewed_source_sha256,v_at,v_rechecked_sha256)
  into v_lifecycle_audit;
  insert into public.admin_audit_events(operation,actor,target_id,reason)
  values('price_seal',v_actor::text,v_price.id,p_reason) returning id into v_admin_audit;
  v_result:=jsonb_build_object('schemaVersion','admin_price_version_result_v1',
    'priceVersionId',v_price.id,'profileVersionId',v_price.profile_version_id,
    'pricingLane',v_price.pricing_lane,'version',v_price.version,'sealed',true,
    'lifecycleAuditId',v_lifecycle_audit,'reviewedDeploymentId',v_deployment.id);
  return public.admin_commit_operation_v1(v_actor,'price_seal',p_idempotency_key,
    v_payload,v_result,v_admin_audit);
end;
$$;

create function public.admin_transition_profile_version_v1(
  p_environment text,p_project_ref text,p_profile_version_id uuid,p_to_status text,
  p_validation_report_id uuid,p_reason text,p_idempotency_key uuid
)
returns jsonb
language plpgsql security definer set search_path=''
as $$
declare v_actor uuid; v_payload jsonb; v_replay jsonb; v_evidence jsonb;
  v_audit uuid; v_admin_audit uuid; v_version public.ai_provider_profile_versions%rowtype; v_result jsonb;
begin
  v_actor:=public.admin_assert_write_actor_v1(p_environment,p_project_ref,false);
  perform public.admin_assert_jwt_control_mode_v1();
  v_payload:=jsonb_build_object('profileVersionId',p_profile_version_id,'toStatus',p_to_status,
    'validationReportId',p_validation_report_id,'reason',p_reason);
  v_replay:=public.admin_lock_committed_operation_v1(v_actor,'profile_version_transition',p_idempotency_key,v_payload);
  if (v_replay->>'found')::boolean then return public.admin_replayed_operation_v1(v_replay,'profile_version_transition',p_idempotency_key); end if;
  if not public.admin_has_recent_totp_v1(v_actor) then raise exception 'STEP_UP_REQUIRED' using errcode='42501'; end if;
  perform public.admin_assert_reason_v1(p_reason);
  if p_to_status not in ('validated','canary','active') then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  select * into v_version from public.ai_provider_profile_versions where id=p_profile_version_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  v_evidence:=public.admin_runtime_validation_evidence_v1(p_validation_report_id,v_version.id,null,clock_timestamp());
  select public.transition_ai_provider_profile_version_v1(v_version.id,p_to_status,
    v_evidence->>'runtimeContractId',v_actor::text,p_reason,
    v_evidence->>'reviewedSourceCommitOid',v_evidence->>'reviewedSourceSha256',
    (v_evidence->>'recheckedAt')::timestamptz,v_evidence->>'recheckedSha256') into v_audit;
  select * into v_version from public.ai_provider_profile_versions where id=p_profile_version_id;
  insert into public.admin_audit_events(operation,actor,target_id,reason)
  values('profile_version_transition',v_actor::text,v_version.id,p_reason) returning id into v_admin_audit;
  v_result:=jsonb_build_object('schemaVersion','admin_profile_version_result_v1',
    'profileVersionId',v_version.id,'profileId',v_version.profile_id,'version',v_version.version,
    'status',v_version.status,'configSha256',v_version.config_sha256,'lifecycleAuditId',v_audit,
    'validationReportId',p_validation_report_id);
  return public.admin_commit_operation_v1(v_actor,'profile_version_transition',p_idempotency_key,v_payload,v_result,v_admin_audit);
end;
$$;

create function public.admin_create_routing_policy_v1(
  p_environment text,p_project_ref text,p_policy_key text,p_expected_latest_version integer,
  p_rules jsonb,p_default_profile_version_id uuid,p_legal_bundle_version text,
  p_runtime_contract_id text,p_validation_report_ids uuid[],p_reason text,p_idempotency_key uuid
)
returns jsonb
language plpgsql security definer set search_path=''
as $$
declare v_actor uuid; v_payload jsonb; v_replay jsonb; v_report_ids uuid[];
  v_policy public.ai_routing_policy_versions%rowtype; v_candidate public.ai_routing_policy_versions%rowtype;
  v_latest integer; v_evidence jsonb; v_lifecycle_audit uuid; v_admin_audit uuid;
  v_result jsonb; v_at timestamptz:=clock_timestamp();
begin
  v_actor:=public.admin_assert_write_actor_v1(p_environment,p_project_ref,false);
  perform public.admin_assert_jwt_control_mode_v1();
  select array_agg(id order by id) into v_report_ids from unnest(p_validation_report_ids) item(id);
  v_payload:=jsonb_build_object('policyKey',p_policy_key,'expectedLatestVersion',p_expected_latest_version,
    'timezone','Asia/Shanghai','rules',p_rules,'defaultProfileVersionId',p_default_profile_version_id,
    'legalBundleVersion',p_legal_bundle_version,'runtimeContractId',p_runtime_contract_id,
    'validationReportIds',to_jsonb(v_report_ids),'reason',p_reason);
  v_replay:=public.admin_lock_committed_operation_v1(v_actor,'routing_policy_create',p_idempotency_key,v_payload);
  if (v_replay->>'found')::boolean then return public.admin_replayed_operation_v1(v_replay,'routing_policy_create',p_idempotency_key); end if;
  perform public.admin_assert_reason_v1(p_reason);
  if p_policy_key !~ '^[a-z0-9][a-z0-9._-]*$' or length(p_policy_key)>200
     or p_expected_latest_version is null or p_expected_latest_version<0
     or jsonb_typeof(p_rules)<>'object' or p_default_profile_version_id is null
     or p_legal_bundle_version !~ '^[a-z0-9][a-z0-9._-]{0,199}$'
     or p_runtime_contract_id !~ '^[a-z0-9][a-z0-9._-]{0,199}$'
     or cardinality(v_report_ids) not between 1 and 32 then
    raise exception 'INVALID_REQUEST' using errcode='22023';
  end if;
  select coalesce(max(version),0) into v_latest from public.ai_routing_policy_versions
  where policy_key=p_policy_key;
  if v_latest is distinct from p_expected_latest_version then raise exception 'CONFLICT' using errcode='40001'; end if;
  v_candidate.id:=extensions.gen_random_uuid(); v_candidate.policy_key:=p_policy_key;
  v_candidate.version:=v_latest+1; v_candidate.status:='validated';
  v_candidate.timezone:='Asia/Shanghai'; v_candidate.rules:=p_rules;
  v_candidate.default_profile_version_id:=p_default_profile_version_id;
  v_candidate.legal_bundle_version:=p_legal_bundle_version;
  v_candidate.runtime_contract_id:=p_runtime_contract_id; v_candidate.created_at:=v_at;
  v_candidate.config_sha256:=public.admin_json_jcs_sha256_v1(jsonb_build_object(
    'schemaVersion','routing_policy_config_v1','policyKey',p_policy_key,'version',v_latest+1,
    'timezone','Asia/Shanghai','rules',p_rules,'defaultProfileVersionId',p_default_profile_version_id,
    'legalBundleVersion',p_legal_bundle_version,'runtimeContractId',p_runtime_contract_id));
  perform public.lock_and_validate_ai_routing_policy_row_v1(v_candidate,'validated',v_at);
  insert into public.ai_routing_policy_versions(id,policy_key,version,status,timezone,rules,
    default_profile_version_id,legal_bundle_version,config_sha256,runtime_contract_id,created_at)
  values(v_candidate.id,v_candidate.policy_key,v_candidate.version,'draft',v_candidate.timezone,
    v_candidate.rules,v_candidate.default_profile_version_id,v_candidate.legal_bundle_version,
    v_candidate.config_sha256,v_candidate.runtime_contract_id,v_candidate.created_at)
  returning * into v_policy;
  v_evidence:=public.admin_assert_policy_validation_reports_v1(v_policy.id,v_report_ids,v_at);
  select public.insert_ai_routing_lifecycle_audit_v1('policy_create',v_policy.id,null,null,null,
    null,null,null,null,null,null,null,null,null,null,p_runtime_contract_id,v_actor::text,p_reason,
    v_evidence->>'reviewedSourceCommitOid',v_evidence->>'reviewedSourceSha256',
    (v_evidence->>'recheckedAt')::timestamptz,v_evidence->>'recheckedSha256',v_at)
  into v_lifecycle_audit;
  insert into public.admin_audit_events(operation,actor,target_id,reason)
  values('routing_policy_create',v_actor::text,v_policy.id,p_reason) returning id into v_admin_audit;
  v_result:=jsonb_build_object('schemaVersion','admin_routing_policy_result_v1',
    'policyVersionId',v_policy.id,'policyKey',v_policy.policy_key,'version',v_policy.version,
    'status',v_policy.status,'configSha256',v_policy.config_sha256,
    'lifecycleAuditId',v_lifecycle_audit,'validationReportIds',v_evidence->'validationReportIds');
  return public.admin_commit_operation_v1(v_actor,'routing_policy_create',p_idempotency_key,v_payload,v_result,v_admin_audit);
end;
$$;

create function public.admin_transition_routing_policy_v1(
  p_environment text,p_project_ref text,p_policy_version_id uuid,p_to_status text,
  p_validation_report_ids uuid[],p_reason text,p_idempotency_key uuid
)
returns jsonb
language plpgsql security definer set search_path=''
as $$
declare v_actor uuid; v_payload jsonb; v_replay jsonb; v_report_ids uuid[];
  v_policy public.ai_routing_policy_versions%rowtype; v_evidence jsonb;
  v_lifecycle_audit uuid; v_admin_audit uuid; v_result jsonb;
begin
  v_actor:=public.admin_assert_write_actor_v1(p_environment,p_project_ref,false);
  perform public.admin_assert_jwt_control_mode_v1();
  select array_agg(id order by id) into v_report_ids from unnest(p_validation_report_ids) item(id);
  v_payload:=jsonb_build_object('policyVersionId',p_policy_version_id,'toStatus',p_to_status,
    'validationReportIds',to_jsonb(v_report_ids),'reason',p_reason);
  v_replay:=public.admin_lock_committed_operation_v1(v_actor,'routing_policy_transition',p_idempotency_key,v_payload);
  if (v_replay->>'found')::boolean then return public.admin_replayed_operation_v1(v_replay,'routing_policy_transition',p_idempotency_key); end if;
  if not public.admin_has_recent_totp_v1(v_actor) then raise exception 'STEP_UP_REQUIRED' using errcode='42501'; end if;
  perform public.admin_assert_reason_v1(p_reason);
  if p_to_status not in ('validated','canary','active','retired') then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  select * into v_policy from public.ai_routing_policy_versions where id=p_policy_version_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  v_evidence:=public.admin_assert_policy_validation_reports_v1(v_policy.id,v_report_ids,clock_timestamp());
  select public.transition_ai_routing_policy_v2(v_policy.id,p_to_status,v_policy.runtime_contract_id,
    v_actor::text,p_reason,v_evidence->>'reviewedSourceCommitOid',v_evidence->>'reviewedSourceSha256',
    (v_evidence->>'recheckedAt')::timestamptz,v_evidence->>'recheckedSha256') into v_lifecycle_audit;
  select * into v_policy from public.ai_routing_policy_versions where id=p_policy_version_id;
  insert into public.admin_audit_events(operation,actor,target_id,reason)
  values('routing_policy_transition',v_actor::text,v_policy.id,p_reason) returning id into v_admin_audit;
  v_result:=jsonb_build_object('schemaVersion','admin_routing_policy_result_v1',
    'policyVersionId',v_policy.id,'policyKey',v_policy.policy_key,'version',v_policy.version,
    'status',v_policy.status,'configSha256',v_policy.config_sha256,
    'lifecycleAuditId',v_lifecycle_audit,'validationReportIds',v_evidence->'validationReportIds');
  return public.admin_commit_operation_v1(v_actor,'routing_policy_transition',p_idempotency_key,v_payload,v_result,v_admin_audit);
end;
$$;

create function public.admin_close_price_version_v1(
  p_environment text,p_project_ref text,p_price_version_id uuid,p_valid_to timestamptz,
  p_successor_price_version_id uuid,p_validation_report_id uuid,p_reason text,p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_actor uuid; v_payload jsonb; v_replay jsonb; v_evidence jsonb;
  v_price public.ai_price_versions%rowtype; v_audit uuid; v_admin_audit uuid; v_result jsonb;
begin
  v_actor:=public.admin_assert_write_actor_v1(p_environment,p_project_ref,false); perform public.admin_assert_jwt_control_mode_v1();
  v_payload:=jsonb_build_object('priceVersionId',p_price_version_id,'validTo',p_valid_to,
    'successorPriceVersionId',p_successor_price_version_id,'validationReportId',p_validation_report_id,'reason',p_reason);
  v_replay:=public.admin_lock_committed_operation_v1(v_actor,'price_close',p_idempotency_key,v_payload);
  if (v_replay->>'found')::boolean then return public.admin_replayed_operation_v1(v_replay,'price_close',p_idempotency_key); end if;
  if not public.admin_has_recent_totp_v1(v_actor) then raise exception 'STEP_UP_REQUIRED' using errcode='42501'; end if;
  perform public.admin_assert_reason_v1(p_reason);
  select * into v_price from public.ai_price_versions where id=p_price_version_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  v_evidence:=public.admin_runtime_validation_evidence_v1(p_validation_report_id,v_price.profile_version_id,v_price.id,clock_timestamp());
  select public.close_ai_price_version_v1(v_price.id,p_valid_to,p_successor_price_version_id,
    v_evidence->>'runtimeContractId',v_actor::text,p_reason,v_evidence->>'reviewedSourceCommitOid',
    v_evidence->>'reviewedSourceSha256',(v_evidence->>'recheckedAt')::timestamptz,
    v_evidence->>'recheckedSha256') into v_audit;
  select * into v_price from public.ai_price_versions where id=p_price_version_id;
  insert into public.admin_audit_events(operation,actor,target_id,reason)
  values('price_close',v_actor::text,v_price.id,p_reason) returning id into v_admin_audit;
  v_result:=jsonb_build_object('schemaVersion','admin_price_version_result_v1',
    'priceVersionId',v_price.id,'profileVersionId',v_price.profile_version_id,
    'pricingLane',v_price.pricing_lane,'version',v_price.version,
    'sealed',v_price.components_sealed_at is not null,'validTo',v_price.valid_to,
    'lifecycleAuditId',v_audit,'validationReportId',p_validation_report_id);
  return public.admin_commit_operation_v1(v_actor,'price_close',p_idempotency_key,v_payload,v_result,v_admin_audit);
end;
$$;

create function public.admin_retire_profile_version_v1(
  p_environment text,p_project_ref text,p_profile_version_id uuid,
  p_validation_report_id uuid,p_reason text,p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_actor uuid; v_payload jsonb; v_replay jsonb; v_evidence jsonb;
  v_version public.ai_provider_profile_versions%rowtype; v_audit uuid; v_admin_audit uuid; v_result jsonb;
begin
  v_actor:=public.admin_assert_write_actor_v1(p_environment,p_project_ref,false); perform public.admin_assert_jwt_control_mode_v1();
  v_payload:=jsonb_build_object('profileVersionId',p_profile_version_id,
    'validationReportId',p_validation_report_id,'reason',p_reason);
  v_replay:=public.admin_lock_committed_operation_v1(v_actor,'profile_version_retire',p_idempotency_key,v_payload);
  if (v_replay->>'found')::boolean then return public.admin_replayed_operation_v1(v_replay,'profile_version_retire',p_idempotency_key); end if;
  if not public.admin_has_recent_totp_v1(v_actor) then raise exception 'STEP_UP_REQUIRED' using errcode='42501'; end if;
  perform public.admin_assert_reason_v1(p_reason);
  select * into v_version from public.ai_provider_profile_versions where id=p_profile_version_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  v_evidence:=public.admin_runtime_validation_evidence_v1(p_validation_report_id,v_version.id,null,clock_timestamp());
  select public.retire_ai_provider_profile_version_v1(v_version.id,v_evidence->>'runtimeContractId',
    v_actor::text,p_reason,v_evidence->>'reviewedSourceCommitOid',v_evidence->>'reviewedSourceSha256',
    (v_evidence->>'recheckedAt')::timestamptz,v_evidence->>'recheckedSha256') into v_audit;
  select * into v_version from public.ai_provider_profile_versions where id=p_profile_version_id;
  insert into public.admin_audit_events(operation,actor,target_id,reason)
  values('profile_version_retire',v_actor::text,v_version.id,p_reason) returning id into v_admin_audit;
  v_result:=jsonb_build_object('schemaVersion','admin_profile_version_result_v1',
    'profileVersionId',v_version.id,'profileId',v_version.profile_id,'version',v_version.version,
    'status',v_version.status,'configSha256',v_version.config_sha256,'lifecycleAuditId',v_audit,
    'validationReportId',p_validation_report_id);
  return public.admin_commit_operation_v1(v_actor,'profile_version_retire',p_idempotency_key,v_payload,v_result,v_admin_audit);
end;
$$;

create function public.admin_retire_provider_profile_v1(
  p_environment text,p_project_ref text,p_profile_id uuid,
  p_validation_report_id uuid,p_reason text,p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_actor uuid; v_payload jsonb; v_replay jsonb; v_evidence jsonb;
  v_profile public.ai_provider_profiles%rowtype; v_report public.admin_validation_reports_v1%rowtype;
  v_audit uuid; v_admin_audit uuid; v_result jsonb;
begin
  v_actor:=public.admin_assert_write_actor_v1(p_environment,p_project_ref,false); perform public.admin_assert_jwt_control_mode_v1();
  v_payload:=jsonb_build_object('profileId',p_profile_id,'validationReportId',p_validation_report_id,'reason',p_reason);
  v_replay:=public.admin_lock_committed_operation_v1(v_actor,'provider_profile_retire',p_idempotency_key,v_payload);
  if (v_replay->>'found')::boolean then return public.admin_replayed_operation_v1(v_replay,'provider_profile_retire',p_idempotency_key); end if;
  if not public.admin_has_recent_totp_v1(v_actor) then raise exception 'STEP_UP_REQUIRED' using errcode='42501'; end if;
  perform public.admin_assert_reason_v1(p_reason);
  select * into v_profile from public.ai_provider_profiles where id=p_profile_id for update;
  select * into v_report from public.admin_validation_reports_v1 where id=p_validation_report_id;
  if v_profile.id is null or v_report.id is null or not exists(
    select 1 from public.ai_provider_profile_versions where id=v_report.profile_version_id and profile_id=v_profile.id
  ) then raise exception 'VALIDATION_REPORT_MISMATCH' using errcode='23514'; end if;
  v_evidence:=public.admin_runtime_validation_evidence_v1(p_validation_report_id,v_report.profile_version_id,null,clock_timestamp());
  select public.retire_ai_provider_profile_v1(v_profile.id,v_evidence->>'runtimeContractId',
    v_actor::text,p_reason,v_evidence->>'reviewedSourceCommitOid',v_evidence->>'reviewedSourceSha256',
    (v_evidence->>'recheckedAt')::timestamptz,v_evidence->>'recheckedSha256') into v_audit;
  select * into v_profile from public.ai_provider_profiles where id=p_profile_id;
  insert into public.admin_audit_events(operation,actor,target_id,reason)
  values('provider_profile_retire',v_actor::text,v_profile.id,p_reason) returning id into v_admin_audit;
  v_result:=jsonb_build_object('schemaVersion','admin_profile_identity_result_v1',
    'profileId',v_profile.id,'profileKey',v_profile.profile_key,'providerId',v_profile.provider_id,
    'retired',v_profile.retired_at is not null,'lifecycleAuditId',v_audit,
    'validationReportId',p_validation_report_id);
  return public.admin_commit_operation_v1(v_actor,'provider_profile_retire',p_idempotency_key,v_payload,v_result,v_admin_audit);
end;
$$;

revoke all on function public.admin_runtime_validation_evidence_v1(uuid,uuid,uuid,timestamptz),
  public.admin_seal_price_for_activation_v1(text,text,uuid,text,uuid,text,uuid),
  public.admin_transition_profile_version_v1(text,text,uuid,text,uuid,text,uuid),
  public.admin_create_routing_policy_v1(text,text,text,integer,jsonb,uuid,text,text,uuid[],text,uuid),
  public.admin_transition_routing_policy_v1(text,text,uuid,text,uuid[],text,uuid),
  public.admin_close_price_version_v1(text,text,uuid,timestamptz,uuid,uuid,text,uuid),
  public.admin_retire_profile_version_v1(text,text,uuid,uuid,text,uuid),
  public.admin_retire_provider_profile_v1(text,text,uuid,uuid,text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function
  public.admin_seal_price_for_activation_v1(text,text,uuid,text,uuid,text,uuid),
  public.admin_transition_profile_version_v1(text,text,uuid,text,uuid,text,uuid),
  public.admin_create_routing_policy_v1(text,text,text,integer,jsonb,uuid,text,text,uuid[],text,uuid),
  public.admin_transition_routing_policy_v1(text,text,uuid,text,uuid[],text,uuid),
  public.admin_close_price_version_v1(text,text,uuid,timestamptz,uuid,uuid,text,uuid),
  public.admin_retire_profile_version_v1(text,text,uuid,uuid,text,uuid),
  public.admin_retire_provider_profile_v1(text,text,uuid,uuid,text,uuid)
  to authenticated;

commit;
