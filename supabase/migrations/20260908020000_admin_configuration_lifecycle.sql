-- Configuration-owned lifecycle successors preserve the established locks,
-- transition guards, actor checks and idempotency. Evidence references actual
-- immutable configuration reports; no deployment or source-commit stand-ins.
begin;

alter table public.admin_config_lifecycle_events_v2
  drop constraint admin_config_lifecycle_events_v2_operation_check;
alter table public.admin_config_lifecycle_events_v2
  add constraint admin_config_lifecycle_events_v2_operation_check check (operation in (
    'price_seal','pointer_set','pointer_clear','profile_version_transition',
    'policy_create','policy_transition','price_close','profile_version_retire','profile_retire')),
  add column metadata jsonb not null default '{}'::jsonb;

create function public.admin_config_validation_evidence_v2(
  p_report_id uuid,p_expected_profile_version_id uuid,p_expected_price_version_id uuid,p_at timestamptz
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_report public.admin_config_validation_reports_v2%rowtype;
begin
  select report.* into v_report
  from public.admin_config_validation_reports_v2 report
  join public.admin_environment environment on environment.id=true
    and environment.environment=report.environment and environment.project_ref=report.project_ref
  where report.id=p_report_id and report.passed and report.expires_at>p_at and report.checked_at<=p_at;
  if p_at is null or v_report.id is null
     or (p_expected_profile_version_id is not null and v_report.profile_version_id is distinct from p_expected_profile_version_id)
     or (p_expected_price_version_id is not null and v_report.price_version_id is distinct from p_expected_price_version_id) then
    raise exception 'VALIDATION_REPORT_MISMATCH' using errcode='23514';
  end if;
  return jsonb_build_object('reportId',v_report.id,'runtimeContractId',v_report.runtime_contract_id,
    'recheckedAt',v_report.checked_at,'reportSha256',v_report.report_sha256,'expiresAt',v_report.expires_at);
end;
$$;

create function public.admin_config_lifecycle_evidence_v2(
  p_report_ids uuid[],p_runtime_contract_id text,p_at timestamptz
) returns timestamptz language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_report jsonb; v_checked timestamptz;
begin
  if cardinality(p_report_ids) is null or cardinality(p_report_ids) not between 1 and 64
     or cardinality(p_report_ids)<>(select count(distinct id) from unnest(p_report_ids) id) then
    raise exception 'VALIDATION_REPORT_MISMATCH' using errcode='23514';
  end if;
  foreach v_id in array p_report_ids loop
    v_report:=public.admin_config_validation_evidence_v2(v_id,null,null,p_at);
    if v_report->>'runtimeContractId' is distinct from p_runtime_contract_id then
      raise exception 'VALIDATION_REPORT_MISMATCH' using errcode='23514';
    end if;
    v_checked:=least(v_checked,(v_report->>'recheckedAt')::timestamptz);
  end loop;
  return v_checked;
end;
$$;

create function public.admin_insert_config_lifecycle_event_v2(
  p_operation text,p_target_id uuid,p_runtime_contract_id text,p_report_ids uuid[],
  p_actor text,p_reason text,p_metadata jsonb
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  insert into public.admin_config_lifecycle_events_v2(
    operation,target_id,runtime_contract_id,validation_report_ids,actor,reason,metadata
  ) values (p_operation,p_target_id,p_runtime_contract_id,p_report_ids,p_actor,p_reason,p_metadata)
  returning id into v_id;
  return v_id;
end;
$$;

create function public.transition_ai_provider_profile_version_v2_internal(
  p_profile_version_id uuid,p_to_status text,p_runtime_contract_id text,
  p_actor text,p_reason text,p_validation_report_ids uuid[]
) returns uuid language plpgsql security definer set search_path='' as $$
declare p_rechecked_at timestamptz; v_profile public.ai_provider_profiles%rowtype; v_version public.ai_provider_profile_versions%rowtype; v_updated public.ai_provider_profile_versions%rowtype; v_at timestamptz:=pg_catalog.clock_timestamp(); v_id uuid;
begin
  perform pg_catalog.set_config('lock_timeout','5s',true);
  perform 1 from public.ai_feature_config where id=true for update;
  if not found then raise exception 'ai feature config singleton is missing' using errcode='23514'; end if;
  p_rechecked_at:=public.admin_config_lifecycle_evidence_v2(p_validation_report_ids,p_runtime_contract_id,v_at);
  select profile_id into v_profile.id from public.ai_provider_profile_versions where id=p_profile_version_id;
  if not found then raise exception 'profile promotion target does not exist' using errcode='23503'; end if;
  select * into v_profile from public.ai_provider_profiles where id=v_profile.id for share;
  select * into v_version from public.ai_provider_profile_versions where id=p_profile_version_id for update;
  if not found or v_profile.retired_at is not null or v_version.profile_id is distinct from v_profile.id
     or v_version.retired_at is not null or v_version.status='retired'
     or (v_version.status,p_to_status) not in (('draft','validated'),('validated','canary'),('validated','active'),('canary','active')) then
    raise exception 'invalid non-retirement profile version promotion' using errcode='23514';
  end if;
  perform public.assert_ai_routing_lifecycle_runtime_profile_coverage_v1(p_runtime_contract_id,v_profile.id,v_version.id);
  update public.ai_provider_profile_versions set status=p_to_status where id=v_version.id returning * into v_updated;
  if not found or v_updated.status is distinct from p_to_status then raise exception 'profile version promotion was not applied exactly once' using errcode='23514'; end if;
  select public.admin_insert_config_lifecycle_event_v2('profile_version_transition',v_version.id,p_runtime_contract_id,p_validation_report_ids,p_actor,p_reason,jsonb_build_object('fromStatus',v_version.status,'toStatus',p_to_status)) into v_id;
  return v_id;
end; $$;
revoke all on function public.transition_ai_provider_profile_version_v2_internal(uuid,text,text,text,text,uuid[]) from public,anon,authenticated,service_role;

create function public.transition_ai_routing_policy_v3_internal(p_policy_version_id uuid,p_to_status text,p_runtime_contract_id text,p_actor text,p_reason text,p_validation_report_ids uuid[])
returns uuid language plpgsql security definer set search_path='' as $$
declare p_rechecked_at timestamptz; v_policy public.ai_routing_policy_versions%rowtype; v_candidate public.ai_routing_policy_versions%rowtype; v_at timestamptz:=pg_catalog.clock_timestamp(); v_id uuid;
begin
 perform pg_catalog.set_config('lock_timeout','5s',true); perform 1 from public.ai_feature_config where id=true for update;
 if not found then raise exception 'ai feature config singleton is missing' using errcode='23514'; end if;
 select * into v_policy from public.ai_routing_policy_versions where id=p_policy_version_id for update;
 if not found or p_to_status is null or p_to_status=v_policy.status then raise exception 'invalid routing lifecycle transition' using errcode='23514'; end if;
 if p_runtime_contract_id is distinct from v_policy.runtime_contract_id then raise exception 'routing lifecycle runtime id mismatch' using errcode='23514'; end if;
 p_rechecked_at:=public.admin_config_lifecycle_evidence_v2(p_validation_report_ids,p_runtime_contract_id,v_at);
 if (v_policy.status,p_to_status) not in (('draft','validated'),('draft','retired'),('validated','canary'),('validated','active'),('validated','retired'),('canary','active'),('canary','retired'),('active','retired')) then raise exception 'invalid routing lifecycle transition' using errcode='23514'; end if;
 v_candidate:=v_policy;
 if p_to_status='retired' then
   if v_policy.status in ('draft','validated') then
     v_candidate.status:='validated';
   end if;
 else
   v_candidate.status:=p_to_status;
 end if;
 perform public.lock_and_validate_ai_routing_policy_row_v1(v_candidate,case when p_to_status='retired' then case when v_policy.status in ('draft','validated') then 'validated' else v_policy.status end else p_to_status end,v_at);
 if p_to_status='retired' and (exists(select 1 from public.ai_feature_config where id=true and active_routing_policy_version_id=v_policy.id)
    or exists(select 1 from public.ai_request_ledger where routing_policy_version_id=v_policy.id and state <> 'finalized')) then
   raise exception 'routing lifecycle target has a current pointer or unfinished request' using errcode='23514';
 end if;
 perform public.assert_ai_routing_lifecycle_selected_price_evidence_v1(v_policy,p_rechecked_at);
 insert into public.ai_routing_policy_transition_intents (
   policy_version_id, from_status, to_status, requested_at, requested_txid
 ) values (v_policy.id,v_policy.status,p_to_status,v_at,pg_catalog.txid_current());
 update public.ai_routing_policy_versions set status=p_to_status where id=v_policy.id;
 if exists(select 1 from public.ai_routing_policy_transition_intents where policy_version_id=v_policy.id) then
   raise exception 'routing policy transition intent was not consumed' using errcode='23514';
 end if;
 select public.admin_insert_config_lifecycle_event_v2('policy_transition',v_policy.id,p_runtime_contract_id,p_validation_report_ids,p_actor,p_reason,jsonb_build_object('fromStatus',v_policy.status,'toStatus',p_to_status)) into v_id; return v_id;
end; $$;
revoke all on function public.transition_ai_routing_policy_v3_internal(uuid,text,text,text,text,uuid[]) from public,anon,authenticated,service_role;

create function public.close_ai_price_version_v2_internal(p_price_version_id uuid,p_valid_to timestamptz,p_successor_price_version_id uuid,p_runtime_contract_id text,p_actor text,p_reason text,p_validation_report_ids uuid[])
returns uuid language plpgsql security definer set search_path='' as $$
declare p_rechecked_at timestamptz; v public.ai_price_versions%rowtype; s public.ai_price_versions%rowtype; v_locked public.ai_price_versions%rowtype; v_updated public.ai_price_versions%rowtype; v_profile_version public.ai_provider_profile_versions%rowtype; v_profile public.ai_provider_profiles%rowtype; v_at timestamptz:=pg_catalog.clock_timestamp(); v_id uuid;
begin
 perform pg_catalog.set_config('lock_timeout','5s',true); perform 1 from public.ai_feature_config where id=true for update; if not found then raise exception 'ai feature config singleton is missing' using errcode='23514'; end if;
 select profile_version_id into v_profile_version.id from public.ai_price_versions where id=p_price_version_id; if not found then raise exception 'invalid price closure' using errcode='23514'; end if;
 perform public.assert_ai_routing_lifecycle_no_policy_reference_v1('price',p_price_version_id,v_at);
 p_rechecked_at:=public.admin_config_lifecycle_evidence_v2(p_validation_report_ids,p_runtime_contract_id,v_at);
 select profile_id into v_profile.id from public.ai_provider_profile_versions where id=v_profile_version.id; if not found then raise exception 'price profile version is missing' using errcode='23503'; end if;
 select * into v_profile from public.ai_provider_profiles where id=v_profile.id for share; if not found then raise exception 'price parent profile is missing' using errcode='23503'; end if;
 select * into v_profile_version from public.ai_provider_profile_versions where id=v_profile_version.id for share; if not found or v_profile_version.profile_id is distinct from v_profile.id then raise exception 'price profile lifecycle drift' using errcode='23514'; end if;
 if p_successor_price_version_id is null then
   select * into v from public.ai_price_versions where id=p_price_version_id for update;
 else
   for v_locked in select * from public.ai_price_versions where id=any(array[p_price_version_id,p_successor_price_version_id]) order by id for update loop
     if v_locked.id=p_price_version_id then v:=v_locked; else s:=v_locked; end if;
   end loop;
 end if;
 if v.id is null or v.profile_version_id is distinct from v_profile_version.id or v.valid_to is not null or p_valid_to is null then raise exception 'invalid price closure' using errcode='23514'; end if;
 if p_valid_to <= v.valid_from then raise exception 'price close must be after valid_from' using errcode='23514'; end if;
 if v.source_checked_at is null or p_rechecked_at<v.source_checked_at or exists(select 1 from public.ai_request_ledger where price_version_id=v.id and state<>'finalized') then raise exception 'price closure has stale evidence or unfinished requests' using errcode='23514'; end if;
 if p_successor_price_version_id is null then
   null;
 else
   if s.id is null or s.id=v.id or s.components_sealed_at is null or s.profile_version_id<>v.profile_version_id
      or s.pricing_lane<>v.pricing_lane or s.valid_from<p_valid_to or s.source_checked_at is null
      or p_rechecked_at<s.source_checked_at then
     raise exception 'invalid price closure successor' using errcode='23514';
   end if;
   perform public.assert_ai_price_structure_v1(s.id);
 end if;
 update public.ai_price_versions set valid_to=p_valid_to where id=v.id and valid_to is null returning * into v_updated;
 if not found or v_updated.valid_to is distinct from p_valid_to then raise exception 'price close was not applied exactly once' using errcode='23514'; end if;
 select public.admin_insert_config_lifecycle_event_v2('price_close',v.id,p_runtime_contract_id,p_validation_report_ids,p_actor,p_reason,jsonb_build_object('fromValidTo',v.valid_to,'toValidTo',v_updated.valid_to,'successorPriceVersionId',p_successor_price_version_id)) into v_id; return v_id;
end; $$;
revoke all on function public.close_ai_price_version_v2_internal(uuid,timestamptz,uuid,text,text,text,uuid[]) from public,anon,authenticated,service_role;

create function public.retire_ai_provider_profile_version_v2_internal(p_profile_version_id uuid,p_runtime_contract_id text,p_actor text,p_reason text,p_validation_report_ids uuid[])
returns uuid language plpgsql security definer set search_path='' as $$
declare p_rechecked_at timestamptz; v public.ai_provider_profile_versions%rowtype; v_parent public.ai_provider_profiles%rowtype; v_updated public.ai_provider_profile_versions%rowtype; v_at timestamptz:=pg_catalog.clock_timestamp(); v_id uuid;
begin
 perform pg_catalog.set_config('lock_timeout','5s',true); perform 1 from public.ai_feature_config where id=true for update; if not found then raise exception 'ai feature config singleton is missing' using errcode='23514'; end if;
 select profile_id into v_parent.id from public.ai_provider_profile_versions where id=p_profile_version_id; if not found then raise exception 'invalid profile version retirement' using errcode='23514'; end if;
 perform public.assert_ai_routing_lifecycle_no_policy_reference_v1('profile_version',p_profile_version_id,v_at);
 p_rechecked_at:=public.admin_config_lifecycle_evidence_v2(p_validation_report_ids,p_runtime_contract_id,v_at);
 select * into v_parent from public.ai_provider_profiles where id=v_parent.id for update; if not found or v_parent.retired_at is not null then raise exception 'profile version parent is unavailable' using errcode='23514'; end if;
 select * into v from public.ai_provider_profile_versions where id=p_profile_version_id for update; if not found or v.profile_id is distinct from v_parent.id or v.retired_at is not null or v.status='retired' then raise exception 'profile version lifecycle drift' using errcode='23514'; end if;
 perform public.lock_ai_routing_lifecycle_profile_prices_v1(v_parent.id,v.id,p_rechecked_at);
 if exists(select 1 from public.ai_request_ledger where profile_version_id=v.id and state<>'finalized') then raise exception 'profile version has unfinished requests' using errcode='23514'; end if;
 update public.ai_provider_profile_versions set status='retired' where id=v.id returning * into v_updated;
 if not found or v_updated.retired_at is null or v_updated.status<>'retired' then raise exception 'profile version retirement was not trigger-managed' using errcode='23514'; end if;
 select public.admin_insert_config_lifecycle_event_v2('profile_version_retire',v.id,p_runtime_contract_id,p_validation_report_ids,p_actor,p_reason,jsonb_build_object('fromRetiredAt',v.retired_at,'toRetiredAt',v_updated.retired_at)) into v_id; return v_id;
end; $$;
revoke all on function public.retire_ai_provider_profile_version_v2_internal(uuid,text,text,text,uuid[]) from public,anon,authenticated,service_role;

create function public.retire_ai_provider_profile_v2_internal(p_profile_id uuid,p_runtime_contract_id text,p_actor text,p_reason text,p_validation_report_ids uuid[])
returns uuid language plpgsql security definer set search_path='' as $$
declare p_rechecked_at timestamptz; v public.ai_provider_profiles%rowtype; v_updated public.ai_provider_profiles%rowtype; v_child public.ai_provider_profile_versions%rowtype; v_at timestamptz:=pg_catalog.clock_timestamp(); v_id uuid;
begin
 perform pg_catalog.set_config('lock_timeout','5s',true); perform 1 from public.ai_feature_config where id=true for update; if not found then raise exception 'ai feature config singleton is missing' using errcode='23514'; end if;
 select id into v.id from public.ai_provider_profiles where id=p_profile_id; if not found then raise exception 'invalid profile retirement' using errcode='23514'; end if;
 for v_child in select * from public.ai_provider_profile_versions where profile_id=v.id order by id loop
   perform public.assert_ai_routing_lifecycle_no_policy_reference_v1('profile_version',v_child.id,v_at);
 end loop;
 p_rechecked_at:=public.admin_config_lifecycle_evidence_v2(p_validation_report_ids,p_runtime_contract_id,v_at);
 select * into v from public.ai_provider_profiles where id=v.id for update; if not found or v.retired_at is not null then raise exception 'invalid profile retirement' using errcode='23514'; end if;
 for v_child in select * from public.ai_provider_profile_versions where profile_id=v.id order by id for update loop
   if v_child.status<>'retired' or v_child.retired_at is null then raise exception 'profile has non-retired versions' using errcode='23514'; end if;
   if exists(select 1 from public.ai_request_ledger where profile_version_id=v_child.id and state<>'finalized') then
     raise exception 'profile has unfinished requests' using errcode='23514';
   end if;
 end loop;
 perform public.lock_ai_routing_lifecycle_profile_prices_v1(v.id,null,p_rechecked_at);
 update public.ai_provider_profiles set retired_at=v_at where id=v.id returning * into v_updated;
 if not found or v_updated.retired_at is null then raise exception 'profile retirement did not persist' using errcode='23514'; end if;
 select public.admin_insert_config_lifecycle_event_v2('profile_retire',v.id,p_runtime_contract_id,p_validation_report_ids,p_actor,p_reason,jsonb_build_object('fromRetiredAt',v.retired_at,'toRetiredAt',v_updated.retired_at)) into v_id; return v_id;
end; $$;
revoke all on function public.retire_ai_provider_profile_v2_internal(uuid,text,text,text,uuid[]) from public,anon,authenticated,service_role;

create function public.admin_transition_profile_version_v2(
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
  v_evidence:=public.admin_config_validation_evidence_v2(p_validation_report_id,v_version.id,null,clock_timestamp());
  select public.transition_ai_provider_profile_version_v2_internal(v_version.id,p_to_status,
    v_evidence->>'runtimeContractId',v_actor::text,p_reason,
    array[p_validation_report_id]) into v_audit;
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
revoke all on function public.admin_transition_profile_version_v2(text,text,uuid,text,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.admin_transition_profile_version_v2(text,text,uuid,text,uuid,text,uuid) to authenticated;

create function public.admin_create_routing_policy_v2(
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
  v_evidence:=public.admin_assert_policy_config_reports_v1(v_policy.id,v_report_ids,v_at);
  select public.admin_insert_config_lifecycle_event_v2('policy_create',v_policy.id,p_runtime_contract_id,v_report_ids,v_actor::text,p_reason,jsonb_build_object('status',v_policy.status,'configSha256',v_policy.config_sha256)) into v_lifecycle_audit;
  insert into public.admin_audit_events(operation,actor,target_id,reason)
  values('routing_policy_create',v_actor::text,v_policy.id,p_reason) returning id into v_admin_audit;
  v_result:=jsonb_build_object('schemaVersion','admin_routing_policy_result_v1',
    'policyVersionId',v_policy.id,'policyKey',v_policy.policy_key,'version',v_policy.version,
    'status',v_policy.status,'configSha256',v_policy.config_sha256,
    'lifecycleAuditId',v_lifecycle_audit,'validationReportIds',v_evidence->'validationReportIds');
  return public.admin_commit_operation_v1(v_actor,'routing_policy_create',p_idempotency_key,v_payload,v_result,v_admin_audit);
end;
$$;
revoke all on function public.admin_create_routing_policy_v2(text,text,text,integer,jsonb,uuid,text,text,uuid[],text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.admin_create_routing_policy_v2(text,text,text,integer,jsonb,uuid,text,text,uuid[],text,uuid) to authenticated;

create function public.admin_transition_routing_policy_v2(
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
  v_evidence:=public.admin_assert_policy_config_reports_v1(v_policy.id,v_report_ids,clock_timestamp());
  select public.transition_ai_routing_policy_v3_internal(v_policy.id,p_to_status,v_policy.runtime_contract_id,
    v_actor::text,p_reason,v_report_ids) into v_lifecycle_audit;
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
revoke all on function public.admin_transition_routing_policy_v2(text,text,uuid,text,uuid[],text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.admin_transition_routing_policy_v2(text,text,uuid,text,uuid[],text,uuid) to authenticated;

create function public.admin_close_price_version_v2(
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
  v_evidence:=public.admin_config_validation_evidence_v2(p_validation_report_id,v_price.profile_version_id,v_price.id,clock_timestamp());
  select public.close_ai_price_version_v2_internal(v_price.id,p_valid_to,p_successor_price_version_id,
    v_evidence->>'runtimeContractId',v_actor::text,p_reason,array[p_validation_report_id]) into v_audit;
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
revoke all on function public.admin_close_price_version_v2(text,text,uuid,timestamptz,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.admin_close_price_version_v2(text,text,uuid,timestamptz,uuid,uuid,text,uuid) to authenticated;

create function public.admin_retire_profile_version_v2(
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
  v_evidence:=public.admin_config_validation_evidence_v2(p_validation_report_id,v_version.id,null,clock_timestamp());
  select public.retire_ai_provider_profile_version_v2_internal(v_version.id,v_evidence->>'runtimeContractId',
    v_actor::text,p_reason,array[p_validation_report_id]) into v_audit;
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
revoke all on function public.admin_retire_profile_version_v2(text,text,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.admin_retire_profile_version_v2(text,text,uuid,uuid,text,uuid) to authenticated;

create function public.admin_retire_provider_profile_v2(
  p_environment text,p_project_ref text,p_profile_id uuid,
  p_validation_report_id uuid,p_reason text,p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_actor uuid; v_payload jsonb; v_replay jsonb; v_evidence jsonb;
  v_profile public.ai_provider_profiles%rowtype; v_report public.admin_config_validation_reports_v2%rowtype;
  v_audit uuid; v_admin_audit uuid; v_result jsonb;
begin
  v_actor:=public.admin_assert_write_actor_v1(p_environment,p_project_ref,false); perform public.admin_assert_jwt_control_mode_v1();
  v_payload:=jsonb_build_object('profileId',p_profile_id,'validationReportId',p_validation_report_id,'reason',p_reason);
  v_replay:=public.admin_lock_committed_operation_v1(v_actor,'provider_profile_retire',p_idempotency_key,v_payload);
  if (v_replay->>'found')::boolean then return public.admin_replayed_operation_v1(v_replay,'provider_profile_retire',p_idempotency_key); end if;
  if not public.admin_has_recent_totp_v1(v_actor) then raise exception 'STEP_UP_REQUIRED' using errcode='42501'; end if;
  perform public.admin_assert_reason_v1(p_reason);
  select * into v_profile from public.ai_provider_profiles where id=p_profile_id for update;
  select * into v_report from public.admin_config_validation_reports_v2 where id=p_validation_report_id;
  if v_profile.id is null or v_report.id is null or not exists(
    select 1 from public.ai_provider_profile_versions where id=v_report.profile_version_id and profile_id=v_profile.id
  ) then raise exception 'VALIDATION_REPORT_MISMATCH' using errcode='23514'; end if;
  v_evidence:=public.admin_config_validation_evidence_v2(p_validation_report_id,v_report.profile_version_id,null,clock_timestamp());
  select public.retire_ai_provider_profile_v2_internal(v_profile.id,v_evidence->>'runtimeContractId',
    v_actor::text,p_reason,array[p_validation_report_id]) into v_audit;
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
revoke all on function public.admin_retire_provider_profile_v2(text,text,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.admin_retire_provider_profile_v2(text,text,uuid,uuid,text,uuid) to authenticated;

revoke all on function public.admin_config_validation_evidence_v2(uuid,uuid,uuid,timestamptz),
  public.admin_config_lifecycle_evidence_v2(uuid[],text,timestamptz),
  public.admin_insert_config_lifecycle_event_v2(text,uuid,text,uuid[],text,text,jsonb)
  from public,anon,authenticated,service_role;

-- Capture the expected database implementation only inside this schema
-- migration, after every successor exists. A later web build never rewrites
-- this catalog; cutover cannot bless an arbitrary pre-existing definition.
-- pg_get_functiondef qualifies composite argument types using search_path.
-- Match the security-definer consumer's empty path before hashing.
set local search_path='';
insert into public.admin_runtime_authority_expected_v3(
  signature,definition_sha256,authenticated_execute,service_role_execute
)
select spec.signature,encode(extensions.digest(
  replace(replace(pg_catalog.pg_get_functiondef(spec.signature::regprocedure),chr(13)||chr(10),chr(10)),chr(13),chr(10)),
  'sha256'),'hex'),spec.authenticated_execute,spec.service_role_execute
from (values
  ('public.admin_assert_policy_config_reports_v1(uuid,uuid[],timestamptz)',false,false),
  ('public.admin_assert_runtime_authority_receipt_v3(text,text)',false,false),
  ('public.admin_clear_ai_routing_pointer_v1(text,text,uuid[],bigint,uuid,bigint,text,uuid)',false,false),
  ('public.admin_clear_ai_routing_pointer_v2(text,text,uuid[],bigint,uuid,bigint,text,uuid)',true,false),
  ('public.admin_close_price_version_v1(text,text,uuid,timestamptz,uuid,uuid,text,uuid)',false,false),
  ('public.admin_close_price_version_v2(text,text,uuid,timestamptz,uuid,uuid,text,uuid)',true,false),
  ('public.admin_config_lifecycle_evidence_v2(uuid[],text,timestamptz)',false,false),
  ('public.admin_config_validation_evidence_v2(uuid,uuid,uuid,timestamptz)',false,false),
  ('public.admin_create_routing_policy_v1(text,text,text,integer,jsonb,uuid,text,text,uuid[],text,uuid)',false,false),
  ('public.admin_create_routing_policy_v2(text,text,text,integer,jsonb,uuid,text,text,uuid[],text,uuid)',true,false),
  ('public.admin_current_runtime_authority_manifest_v3()',false,false),
  ('public.admin_guard_config_lifecycle_event_v2()',false,false),
  ('public.admin_guard_config_validation_report_v2()',false,false),
  ('public.admin_guard_runtime_authority_receipt_v3()',false,false),
  ('public.admin_guard_runtime_readback_report_v2()',false,false),
  ('public.admin_insert_config_lifecycle_event_v2(text,uuid,text,uuid[],text,text,jsonb)',false,false),
  ('public.admin_policy_effective_routes_v1(uuid)',false,false),
  ('public.admin_reopen_ai_v1(text,text,uuid,uuid,bigint,uuid,bigint,text,uuid)',false,false),
  ('public.admin_reopen_ai_v2(text,text,uuid,uuid,bigint,uuid,bigint,text,uuid)',true,false),
  ('public.admin_retire_profile_version_v1(text,text,uuid,uuid,text,uuid)',false,false),
  ('public.admin_retire_profile_version_v2(text,text,uuid,uuid,text,uuid)',true,false),
  ('public.admin_retire_provider_profile_v1(text,text,uuid,uuid,text,uuid)',false,false),
  ('public.admin_retire_provider_profile_v2(text,text,uuid,uuid,text,uuid)',true,false),
  ('public.admin_seal_price_for_activation_v1(text,text,uuid,text,uuid,text,uuid)',false,false),
  ('public.admin_seal_price_for_activation_v2(text,text,uuid,text,text,uuid)',true,false),
  ('public.admin_set_ai_routing_pointer_v1(text,text,uuid,uuid[],bigint,uuid,bigint,text,uuid)',false,false),
  ('public.admin_set_ai_routing_pointer_v2(text,text,uuid,uuid[],bigint,uuid,bigint,text,uuid)',true,false),
  ('public.admin_transition_profile_version_v1(text,text,uuid,text,uuid,text,uuid)',false,false),
  ('public.admin_transition_profile_version_v2(text,text,uuid,text,uuid,text,uuid)',true,false),
  ('public.admin_transition_routing_policy_v1(text,text,uuid,text,uuid[],text,uuid)',false,false),
  ('public.admin_transition_routing_policy_v2(text,text,uuid,text,uuid[],text,uuid)',true,false),
  ('public.clear_ai_routing_policy_pointer_v1(uuid,text,text,text,text,text,timestamptz,text)',false,false),
  ('public.clear_ai_routing_policy_pointer_v2_internal(uuid,text,text,uuid[])',false,false),
  ('public.close_ai_price_version_v1(uuid,timestamptz,uuid,text,text,text,text,text,timestamptz,text)',false,false),
  ('public.close_ai_price_version_v2_internal(uuid,timestamptz,uuid,text,text,text,uuid[])',false,false),
  ('public.create_ai_routing_policy_version_v1(uuid,text,integer,text,jsonb,uuid,text,text,text,text,text,text,text,timestamptz,text)',false,false),
  ('public.get_admin_config_validation_candidate_v2(text,text)',false,true),
  ('public.get_admin_runtime_readback_candidate_v3(uuid,uuid[],text,text)',false,true),
  ('public.get_ai_polish_execution_snapshot_v1(uuid,uuid)',false,false),
  ('public.get_ai_polish_execution_snapshot_v2(uuid,uuid)',false,false),
  ('public.get_ai_polish_execution_snapshot_v3(uuid,uuid)',false,false),
  ('public.get_ai_polish_execution_snapshot_v4(uuid,uuid,text,text,text,text,text)',false,false),
  ('public.get_ai_polish_execution_snapshot_v5(uuid,uuid,text,text)',false,true),
  ('public.lock_and_validate_ai_routing_policy_row_v1(public.ai_routing_policy_versions,text,timestamptz)',false,false),
  ('public.record_admin_config_validation_report_v2(text,text,text,boolean,boolean,boolean,boolean)',false,true),
  ('public.record_admin_runtime_readback_v1(uuid,uuid,uuid[],text,text,text)',false,false),
  ('public.record_admin_runtime_readback_v2(uuid,uuid,bigint,text,uuid,uuid[],text,text,text)',false,false),
  ('public.record_admin_runtime_readback_v3(text,text,uuid,uuid[],uuid,bigint,bigint)',false,true),
  ('public.record_admin_validation_report_v1(uuid,text,text,text,text,text,text,boolean,boolean,boolean,boolean)',false,false),
  ('public.retire_ai_provider_profile_v1(uuid,text,text,text,text,text,timestamptz,text)',false,false),
  ('public.retire_ai_provider_profile_v2_internal(uuid,text,text,text,uuid[])',false,false),
  ('public.retire_ai_provider_profile_version_v1(uuid,text,text,text,text,text,timestamptz,text)',false,false),
  ('public.retire_ai_provider_profile_version_v2_internal(uuid,text,text,text,uuid[])',false,false),
  ('public.seal_ai_price_for_activation_v1(uuid,text,text,text,timestamptz,timestamptz,jsonb,jsonb,text,text,text,text,text,timestamptz,text)',false,false),
  ('public.set_ai_routing_policy_pointer_v1(uuid,text,text,text,text,text,timestamptz,text)',false,false),
  ('public.set_ai_routing_policy_pointer_v2_internal(uuid,text,text,uuid[])',false,false),
  ('public.start_ai_polish_provider_attempt(uuid,integer)',false,false),
  ('public.start_ai_polish_provider_attempt_internal(uuid,integer)',false,false),
  ('public.start_ai_polish_provider_attempt_v2(uuid,integer,text,text)',false,false),
  ('public.start_ai_polish_provider_attempt_v3(uuid,integer,uuid,uuid,uuid,text,text,text,text,text,bigint,text,text,text,text)',false,false),
  ('public.start_ai_polish_provider_attempt_v4(uuid,integer,jsonb)',false,false),
  ('public.start_ai_polish_provider_attempt_v5(uuid,integer,jsonb)',false,true),
  ('public.start_ai_polish_provider_attempt_v5_internal(uuid,integer)',false,false),
  ('public.transition_ai_provider_profile_version_v1(uuid,text,text,text,text,text,text,timestamptz,text)',false,false),
  ('public.transition_ai_provider_profile_version_v2_internal(uuid,text,text,text,text,uuid[])',false,false),
  ('public.transition_ai_routing_policy_v2(uuid,text,text,text,text,text,text,timestamptz,text)',false,false),
  ('public.transition_ai_routing_policy_v3_internal(uuid,text,text,text,text,uuid[])',false,false)
) spec(signature,authenticated_execute,service_role_execute);

commit;
