-- Draft preparation does not transfer runtime authority or stop AI.
begin;
set local search_path = '';
lock table public.admin_environment in access exclusive mode;

-- These authoring/context functions are deliberately outside the runtime
-- receipt graph. Do not recertify a graph or update receipts in this migration.
do $scope$
begin
  if exists (
    select 1 from public.admin_runtime_authority_expected_v3 expected
    join pg_catalog.pg_proc proc on proc.oid=pg_catalog.to_regprocedure(expected.signature)
    where proc.proname in ('admin_get_context_v1',
      'admin_update_provider_defaults_v1','admin_create_provider_profile_v1',
      'admin_create_profile_version_v2','admin_create_price_version_v1')
  ) then
    raise exception 'DRAFT_MIGRATION_AUTHORITY_OVERLAP' using errcode='23514';
  end if;
end;
$scope$;


create or replace function public.admin_update_provider_defaults_v1(
  p_environment text,
  p_project_ref text,
  p_provider_id uuid,
  p_display_name text,
  p_default_adapter_id text,
  p_default_endpoint_url text,
  p_default_credential_env_name text,
  p_default_model_id text,
  p_archived boolean,
  p_expected_revision bigint,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid; v_payload jsonb; v_replay jsonb;
  v_provider public.ai_providers%rowtype; v_audit uuid; v_result jsonb;
begin
  v_actor:=public.admin_assert_write_actor_v1(p_environment,p_project_ref,false);
  v_payload:=jsonb_build_object('providerId',p_provider_id,'displayName',p_display_name,
    'defaultAdapterId',p_default_adapter_id,'defaultEndpointUrl',p_default_endpoint_url,
    'defaultCredentialEnvName',p_default_credential_env_name,'defaultModelId',p_default_model_id,
    'archived',p_archived,'expectedRevision',p_expected_revision,'reason',p_reason);
  v_replay:=public.admin_lock_committed_operation_v1(
    v_actor,'provider_defaults_update',p_idempotency_key,v_payload);
  if (v_replay->>'found')::boolean then
    return public.admin_replayed_operation_v1(v_replay,'provider_defaults_update',p_idempotency_key);
  end if;
  perform public.admin_assert_reason_v1(p_reason);
  if p_provider_id is null or p_display_name is null or p_display_name<>btrim(p_display_name)
     or length(p_display_name) not between 1 and 200 or p_archived is null
     or p_expected_revision is null or p_expected_revision<1
     or p_default_adapter_id is null
     or not exists(select 1 from public.ai_adapter_catalog where adapter_id=p_default_adapter_id
       and deprecated_at is null) then
    raise exception 'INVALID_REQUEST' using errcode='22023';
  end if;
  select * into v_provider from public.ai_providers where id=p_provider_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  if v_provider.revision is distinct from p_expected_revision then
    raise exception 'CONFLICT' using errcode='23505';
  end if;
  update public.ai_providers set display_name=p_display_name,
    default_adapter_id=p_default_adapter_id,
    default_endpoint_url=p_default_endpoint_url,
    default_credential_env_name=p_default_credential_env_name,
    default_model_id=p_default_model_id,
    archived_at=case when p_archived then coalesce(archived_at,clock_timestamp()) else null end
  where id=p_provider_id returning * into v_provider;
  insert into public.admin_audit_events(operation,actor,target_id,reason)
  values('provider_defaults_update',v_actor::text,p_provider_id,p_reason)
  returning id into v_audit;
  v_result:=jsonb_build_object('schemaVersion','admin_provider_result_v1',
    'providerId',v_provider.id,'revision',v_provider.revision::text,
    'archived',v_provider.archived_at is not null);
  return public.admin_commit_operation_v1(v_actor,'provider_defaults_update',
    p_idempotency_key,v_payload,v_result,v_audit);
end;
$$;

create or replace function public.admin_create_provider_profile_v1(
  p_environment text,
  p_project_ref text,
  p_provider_id uuid,
  p_profile_key text,
  p_display_name text,
  p_model_vendor text,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid; v_payload jsonb; v_replay jsonb;
  v_provider public.ai_providers%rowtype; v_profile public.ai_provider_profiles%rowtype;
  v_audit uuid; v_result jsonb;
begin
  v_actor:=public.admin_assert_write_actor_v1(p_environment,p_project_ref,false);
  v_payload:=jsonb_build_object('providerId',p_provider_id,'profileKey',p_profile_key,
    'displayName',p_display_name,'modelVendor',p_model_vendor,'reason',p_reason);
  v_replay:=public.admin_lock_committed_operation_v1(
    v_actor,'provider_profile_create',p_idempotency_key,v_payload);
  if (v_replay->>'found')::boolean then
    return public.admin_replayed_operation_v1(v_replay,'provider_profile_create',p_idempotency_key);
  end if;
  perform public.admin_assert_reason_v1(p_reason);
  if p_profile_key is null or p_profile_key !~ '^[a-z0-9][a-z0-9._-]*$'
     or length(p_profile_key)>200 or p_display_name is null
     or p_display_name<>btrim(p_display_name) or length(p_display_name) not between 1 and 200
     or p_model_vendor is null or p_model_vendor<>btrim(p_model_vendor)
     or length(p_model_vendor) not between 1 and 200 then
    raise exception 'INVALID_REQUEST' using errcode='22023';
  end if;
  select * into v_provider from public.ai_providers where id=p_provider_id for share;
  if not found or v_provider.archived_at is not null then
    raise exception 'PROVIDER_UNAVAILABLE' using errcode='23514';
  end if;
  insert into public.ai_provider_profiles(
    profile_key,display_name,gateway_kind,model_vendor,provider_id
  ) values (
    p_profile_key,p_display_name,v_provider.gateway_kind,p_model_vendor,v_provider.id
  ) returning * into v_profile;
  insert into public.admin_audit_events(operation,actor,target_id,reason)
  values('provider_profile_create',v_actor::text,v_profile.id,p_reason)
  returning id into v_audit;
  v_result:=jsonb_build_object('schemaVersion','admin_profile_identity_result_v1',
    'profileId',v_profile.id,'profileKey',v_profile.profile_key,'providerId',v_provider.id);
  return public.admin_commit_operation_v1(v_actor,'provider_profile_create',
    p_idempotency_key,v_payload,v_result,v_audit);
end;
$$;

create or replace function public.admin_create_profile_version_v2(
  p_environment text,
  p_project_ref text,
  p_profile_id uuid,
  p_expected_latest_version integer,
  p_adapter_id text,
  p_wire_api_kind text,
  p_endpoint_url text,
  p_credential_env_name text,
  p_model_id text,
  p_capability_contract_id text,
  p_cache_policy_id text,
  p_legal_manifest_id text,
  p_display_disclosure_key text,
  p_config jsonb,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid; v_payload jsonb; v_replay jsonb;
  v_profile public.ai_provider_profiles%rowtype; v_provider public.ai_providers%rowtype;
  v_version public.ai_provider_profile_versions%rowtype;
  v_actual_latest integer; v_config_sha256 text; v_audit uuid; v_result jsonb;
begin
  v_actor:=public.admin_assert_write_actor_v1(p_environment,p_project_ref,false);
  v_payload:=jsonb_build_object('profileId',p_profile_id,
    'expectedLatestVersion',p_expected_latest_version,'adapterId',p_adapter_id,
    'wireApiKind',p_wire_api_kind,'endpointUrl',p_endpoint_url,
    'credentialEnvName',p_credential_env_name,'modelId',p_model_id,
    'capabilityContractId',p_capability_contract_id,'cachePolicyId',p_cache_policy_id,
    'legalManifestId',p_legal_manifest_id,'displayDisclosureKey',p_display_disclosure_key,
    'config',p_config,'reason',p_reason);
  v_replay:=public.admin_lock_committed_operation_v1(
    v_actor,'profile_version_create',p_idempotency_key,v_payload);
  if (v_replay->>'found')::boolean then
    return public.admin_replayed_operation_v1(v_replay,'profile_version_create',p_idempotency_key);
  end if;
  perform public.admin_assert_reason_v1(p_reason);
  if p_profile_id is null or p_expected_latest_version is null or p_expected_latest_version<0
     or p_wire_api_kind not in ('chat_completions_v1','responses_v1')
     or p_endpoint_url is null or not public.ai_endpoint_shape_v2(p_endpoint_url)
     or p_credential_env_name !~ '^AI_PROVIDER_KEY_[A-Z0-9_]{1,160}$'
     or p_model_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
     or p_capability_contract_id !~ '^[a-z0-9][a-z0-9._-]{0,199}$'
     or p_cache_policy_id !~ '^[a-z0-9][a-z0-9._-]{0,199}$'
     or p_legal_manifest_id !~ '^[a-z0-9][a-z0-9._-]{0,199}$'
     or p_display_disclosure_key !~ '^[a-z0-9][a-z0-9._-]{0,199}$'
     or jsonb_typeof(p_config)<>'object' then
    raise exception 'INVALID_REQUEST' using errcode='22023';
  end if;
  select * into v_profile from public.ai_provider_profiles where id=p_profile_id for update;
  select * into v_provider from public.ai_providers where id=v_profile.provider_id for share;
  if v_profile.id is null or v_profile.retired_at is not null or v_provider.id is null
     or v_provider.archived_at is not null then
    raise exception 'PROFILE_UNAVAILABLE' using errcode='23514';
  end if;
  if not exists(select 1 from public.ai_adapter_catalog where adapter_id=p_adapter_id
      and wire_api_kind=p_wire_api_kind and deprecated_at is null) then
    raise exception 'UNSUPPORTED_ADAPTER' using errcode='23514';
  end if;
  -- Current adapters intentionally expose one reviewed config shape each.
  if (p_adapter_id='deepseek_chat_v1' and p_config is distinct from
      '{"providerSubjectField":"user_id","structuredOutput":"json_object","thinking":"disabled"}'::jsonb)
     or (p_adapter_id='mimo_responses_v1' and p_config is distinct from
      '{"reasoningEffort":"none","sendProviderSubjectId":false,"structuredOutput":"prompt_only"}'::jsonb)
     or p_adapter_id not in ('deepseek_chat_v1','mimo_responses_v1') then
    raise exception 'UNSUPPORTED_ADAPTER_CONFIG' using errcode='23514';
  end if;
  select coalesce(max(version),0) into v_actual_latest
  from public.ai_provider_profile_versions where profile_id=v_profile.id;
  if v_actual_latest is distinct from p_expected_latest_version then
    raise exception 'CONFLICT' using errcode='23505';
  end if;
  v_config_sha256:=public.admin_json_jcs_sha256_v1(p_config);
  insert into public.ai_provider_profile_versions(
    profile_id,version,status,adapter_kind,wire_api_kind,credential_alias,
    endpoint_alias,model_id,model_snapshot,upstream_route,capability_contract_id,
    cache_policy_id,legal_manifest_id,display_disclosure_key,config,config_sha256,
    execution_schema_version,endpoint_url,credential_env_name
  ) values (
    v_profile.id,v_actual_latest+1,'draft',p_adapter_id,p_wire_api_kind,null,
    null,p_model_id,null,'{}'::jsonb,p_capability_contract_id,p_cache_policy_id,
    p_legal_manifest_id,p_display_disclosure_key,p_config,v_config_sha256,
    'profile_execution_config_v2',p_endpoint_url,p_credential_env_name
  ) returning * into v_version;
  insert into public.admin_audit_events(operation,actor,target_id,reason)
  values('profile_version_create',v_actor::text,v_version.id,p_reason)
  returning id into v_audit;
  v_result:=jsonb_build_object('schemaVersion','admin_profile_version_result_v1',
    'profileVersionId',v_version.id,'profileId',v_version.profile_id,
    'version',v_version.version,'status',v_version.status,
    'configSha256',v_version.config_sha256);
  return public.admin_commit_operation_v1(v_actor,'profile_version_create',
    p_idempotency_key,v_payload,v_result,v_audit);
end;
$$;

create or replace function public.admin_create_price_version_v1(
  p_environment text,
  p_project_ref text,
  p_profile_version_id uuid,
  p_pricing_lane text,
  p_expected_latest_version integer,
  p_currency text,
  p_calculator_kind text,
  p_valid_from timestamptz,
  p_valid_to timestamptz,
  p_provider_effective_from timestamptz,
  p_provider_effective_to timestamptz,
  p_source_url text,
  p_source_checked_at timestamptz,
  p_source_snapshot_sha256 text,
  p_parameters jsonb,
  p_components jsonb,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid; v_payload jsonb; v_replay jsonb;
  v_profile public.ai_provider_profile_versions%rowtype;
  v_price public.ai_price_versions%rowtype; v_latest integer;
  v_component record; v_audit uuid; v_result jsonb;
begin
  v_actor:=public.admin_assert_write_actor_v1(p_environment,p_project_ref,false);
  v_payload:=jsonb_build_object('profileVersionId',p_profile_version_id,
    'pricingLane',p_pricing_lane,'expectedLatestVersion',p_expected_latest_version,
    'currency',p_currency,'calculatorKind',p_calculator_kind,'validFrom',p_valid_from,
    'validTo',p_valid_to,'providerEffectiveFrom',p_provider_effective_from,
    'providerEffectiveTo',p_provider_effective_to,'sourceUrl',p_source_url,
    'sourceCheckedAt',p_source_checked_at,'sourceSnapshotSha256',p_source_snapshot_sha256,
    'parameters',p_parameters,'components',p_components,'reason',p_reason);
  v_replay:=public.admin_lock_committed_operation_v1(
    v_actor,'price_version_create',p_idempotency_key,v_payload);
  if (v_replay->>'found')::boolean then
    return public.admin_replayed_operation_v1(v_replay,'price_version_create',p_idempotency_key);
  end if;
  perform public.admin_assert_reason_v1(p_reason);
  if p_profile_version_id is null or p_pricing_lane !~ '^[a-z0-9][a-z0-9._-]*$'
     or length(p_pricing_lane)>200 or p_expected_latest_version is null
     or p_expected_latest_version<0 or p_currency !~ '^[A-Z]{3}$'
     or p_calculator_kind not in ('linear_token_v1','openai_gpt56_v1')
     or p_valid_from is null or (p_valid_to is not null and p_valid_to<=p_valid_from)
     or (p_provider_effective_from is not null and p_provider_effective_to is not null
       and p_provider_effective_to<=p_provider_effective_from)
     or p_source_url !~ '^https://' or p_source_checked_at is null
     or p_source_checked_at>clock_timestamp()+interval '30 seconds'
     or p_source_snapshot_sha256 !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_parameters)<>'object' or jsonb_typeof(p_components)<>'object'
     or (select count(*) from jsonb_object_keys(p_components)) not between 3 and 4 then
    raise exception 'INVALID_REQUEST' using errcode='22023';
  end if;
  select * into v_profile from public.ai_provider_profile_versions
  where id=p_profile_version_id for update;
  if not found or v_profile.status='retired' then
    raise exception 'PROFILE_UNAVAILABLE' using errcode='23514';
  end if;
  select coalesce(max(version),0) into v_latest from public.ai_price_versions
  where profile_version_id=v_profile.id and pricing_lane=p_pricing_lane;
  if v_latest is distinct from p_expected_latest_version then
    raise exception 'CONFLICT' using errcode='23505';
  end if;
  insert into public.ai_price_versions(profile_version_id,pricing_lane,version,
    currency,calculator_kind,valid_from,valid_to,provider_effective_from,
    provider_effective_to,source_url,source_checked_at,source_snapshot_sha256,parameters)
  values(v_profile.id,p_pricing_lane,v_latest+1,p_currency,p_calculator_kind,
    p_valid_from,p_valid_to,p_provider_effective_from,p_provider_effective_to,
    p_source_url,p_source_checked_at,p_source_snapshot_sha256,p_parameters)
  returning * into v_price;
  for v_component in select key,value from jsonb_each_text(p_components) loop
    if v_component.key not in ('input_standard','input_cache_read','input_cache_write','output')
       or v_component.value !~ '^(0|[1-9][0-9]{0,18})$'
       or v_component.value::numeric>9223372036854775807 then
      raise exception 'INVALID_PRICE_COMPONENT' using errcode='22023';
    end if;
    insert into public.ai_price_components(price_version_id,component,nanos_per_million)
    values(v_price.id,v_component.key,v_component.value::bigint);
  end loop;
  perform public.assert_ai_price_structure_v1(v_price.id);
  insert into public.admin_audit_events(operation,actor,target_id,reason)
  values('price_version_create',v_actor::text,v_price.id,p_reason)
  returning id into v_audit;
  v_result:=jsonb_build_object('schemaVersion','admin_price_version_result_v1',
    'priceVersionId',v_price.id,'profileVersionId',v_price.profile_version_id,
    'pricingLane',v_price.pricing_lane,'version',v_price.version,'sealed',false);
  return public.admin_commit_operation_v1(v_actor,'price_version_create',
    p_idempotency_key,v_payload,v_result,v_audit);
end;
$$;

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
    'schemaVersion','admin_context_v3',
    'actor',jsonb_build_object('userId',v_actor,'email',u.email,'revision',p.revision::text),
    'environment',jsonb_build_object('name',e.environment,
      'controlPlaneMode',e.control_plane_mode,'revision',e.revision::text),
    'features',jsonb_build_object('aiEnabled',f.ai_polish_enabled,'globalDailyLimit',f.global_daily_limit,
      'allowlistedUsers',coalesce(cardinality(f.enabled_user_allowlist),0),'configGeneration',f.config_generation::text,
      'activePolicyVersionId',f.active_routing_policy_version_id,'currentLegalBundle',public.current_ai_terms_version()),
    'capabilities',jsonb_build_object('drafts',true,'writes',e.control_plane_mode='jwt_v1')
  ) into v_result from public.admin_environment e cross join public.ai_feature_config f
    join public.admin_principals p on p.user_id=v_actor join auth.users u on u.id=p.user_id
    where e.id=true and f.id=true;
  if v_result is null then raise exception 'UNAVAILABLE' using errcode='P0001'; end if;
  return v_result;
end;
$function$
;

-- A separate operation preserves the existing report-bearing creator and
-- its committed replay contract. Saving this record claims no readiness.
create function public.admin_create_routing_policy_draft_v1(
  p_environment text,p_project_ref text,p_policy_key text,p_expected_latest_version integer,
  p_rules jsonb,p_default_profile_version_id uuid,p_legal_bundle_version text,
  p_runtime_contract_id text,p_reason text,p_idempotency_key uuid
)
returns jsonb
language plpgsql security definer set search_path=''
as $$
declare
  v_actor uuid; v_payload jsonb; v_replay jsonb; v_latest integer;
  v_candidate public.ai_routing_policy_versions%rowtype;
  v_policy public.ai_routing_policy_versions%rowtype;
  v_profile_ids uuid[]; v_price_ids uuid[]; v_routes jsonb;
  v_audit uuid; v_result jsonb;
begin
  v_actor:=public.admin_assert_write_actor_v1(p_environment,p_project_ref,false);
  v_payload:=jsonb_build_object('policyKey',p_policy_key,'expectedLatestVersion',p_expected_latest_version,
    'timezone','Asia/Shanghai','rules',p_rules,'defaultProfileVersionId',p_default_profile_version_id,
    'legalBundleVersion',p_legal_bundle_version,'runtimeContractId',p_runtime_contract_id,'reason',p_reason);
  v_replay:=public.admin_lock_committed_operation_v1(v_actor,'routing_policy_draft_create',p_idempotency_key,v_payload);
  if (v_replay->>'found')::boolean then
    return public.admin_replayed_operation_v1(v_replay,'routing_policy_draft_create',p_idempotency_key);
  end if;
  perform public.admin_assert_reason_v1(p_reason);
  if p_policy_key is null or p_policy_key !~ '^[a-z0-9][a-z0-9._-]{0,199}$'
     or p_expected_latest_version is null or p_expected_latest_version<0
     or jsonb_typeof(p_rules) is distinct from 'object' or p_default_profile_version_id is null
     or p_legal_bundle_version is null or p_legal_bundle_version !~ '^[a-z0-9][a-z0-9._-]{0,199}$'
     or p_runtime_contract_id is null or p_runtime_contract_id !~ '^[a-z0-9][a-z0-9._-]{0,199}$' then
    raise exception 'INVALID_REQUEST' using errcode='22023';
  end if;
  select coalesce(max(version),0) into v_latest from public.ai_routing_policy_versions
    where policy_key=p_policy_key;
  -- A stale expected version cannot succeed on transaction retry.
  if v_latest is distinct from p_expected_latest_version then raise exception 'CONFLICT' using errcode='23505'; end if;
  v_candidate.id:=extensions.gen_random_uuid(); v_candidate.policy_key:=p_policy_key;
  v_candidate.version:=v_latest+1; v_candidate.timezone:='Asia/Shanghai';
  v_candidate.rules:=p_rules; v_candidate.default_profile_version_id:=p_default_profile_version_id;
  v_candidate.legal_bundle_version:=p_legal_bundle_version; v_candidate.runtime_contract_id:=p_runtime_contract_id;
  -- The existing syntax-only validator accepts a validated phase/status pair.
  -- This temporary value never becomes a persisted transition or evidence.
  v_candidate.status:='validated';
  perform public.validate_ai_routing_policy_row_v1(v_candidate,'validated',clock_timestamp(),true);
  select jsonb_agg(route) into v_routes from (
    select p_rules->'defaultRoute' as route
    union select item->'route' from jsonb_array_elements(p_rules->'windows') item
  ) routes;
  select array_agg(distinct (route->>'profileVersionId')::uuid order by (route->>'profileVersionId')::uuid),
         array_agg(distinct (route->>'priceVersionId')::uuid order by (route->>'priceVersionId')::uuid)
    into v_profile_ids,v_price_ids from jsonb_array_elements(v_routes) route;
  -- Match the established runtime -> profile identities -> versions -> prices
  -- lock order, without taking the live feature/pointer lock or testing seals.
  perform 1 from public.ai_service_runtime_contract_versions where runtime_contract_id=p_runtime_contract_id for key share;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  perform 1 from public.ai_provider_profiles where id in (
    select profile_id from public.ai_provider_profile_versions where id=any(v_profile_ids)
  ) order by id for share;
  perform 1 from public.ai_provider_profile_versions where id=any(v_profile_ids) order by id for share;
  perform 1 from public.ai_price_versions where id=any(v_price_ids) order by id for share;
  if exists (
    select 1 from jsonb_array_elements(v_routes) route
    left join public.ai_provider_profile_versions profile on profile.id=(route->>'profileVersionId')::uuid
    left join public.ai_price_versions price on price.id=(route->>'priceVersionId')::uuid
    where profile.id is null or price.id is null or price.profile_version_id is distinct from profile.id
  ) then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  v_candidate.config_sha256:=public.admin_json_jcs_sha256_v1(jsonb_build_object(
    'schemaVersion','routing_policy_config_v1','policyKey',p_policy_key,'version',v_latest+1,
    'timezone','Asia/Shanghai','rules',p_rules,'defaultProfileVersionId',p_default_profile_version_id,
    'legalBundleVersion',p_legal_bundle_version,'runtimeContractId',p_runtime_contract_id));
  insert into public.ai_routing_policy_versions(id,policy_key,version,status,timezone,rules,
    default_profile_version_id,legal_bundle_version,config_sha256,runtime_contract_id)
  values(v_candidate.id,p_policy_key,v_latest+1,'draft','Asia/Shanghai',p_rules,
    p_default_profile_version_id,p_legal_bundle_version,v_candidate.config_sha256,p_runtime_contract_id)
  returning * into v_policy;
  insert into public.admin_audit_events(operation,actor,target_id,reason)
    values('routing_policy_draft_create',v_actor::text,v_policy.id,p_reason) returning id into v_audit;
  v_result:=jsonb_build_object('schemaVersion','admin_routing_policy_draft_result_v1',
    'policyVersionId',v_policy.id,'policyKey',v_policy.policy_key,'version',v_policy.version,
    'status',v_policy.status,'configSha256',v_policy.config_sha256);
  return public.admin_commit_operation_v1(v_actor,'routing_policy_draft_create',p_idempotency_key,v_payload,v_result,v_audit);
end;
$$;
revoke all on function public.admin_create_routing_policy_draft_v1(text,text,text,integer,jsonb,uuid,text,text,text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.admin_create_routing_policy_draft_v1(text,text,text,integer,jsonb,uuid,text,text,text,uuid)
  to authenticated;


commit;
