-- Authoring-only directory and bounded relationship options. Runtime receipts unchanged.
begin;
set local search_path='';
alter table public.ai_providers drop constraint ai_providers_gateway_kind_check;
alter table public.ai_providers add constraint ai_providers_gateway_kind_check
  check(gateway_kind in ('direct_deepseek','direct_mimo','custom_compatible'));
alter table public.ai_provider_profiles drop constraint ai_provider_profiles_gateway_kind_check;
alter table public.ai_provider_profiles add constraint ai_provider_profiles_gateway_kind_check
  check(gateway_kind in ('openrouter','direct_deepseek','direct_mimo','custom_compatible'));

create function public.admin_create_provider_v1(
  p_environment text,p_project_ref text,p_provider_key text,p_display_name text,
  p_recipient_key text,p_gateway_kind text,p_default_adapter_id text,
  p_default_endpoint_url text,p_default_credential_env_name text,p_default_model_id text,
  p_reason text,p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid; v_payload jsonb; v_replay jsonb; v_provider public.ai_providers%rowtype; v_audit uuid;
begin
  v_actor:=public.admin_assert_write_actor_v1(p_environment,p_project_ref,false);
  v_payload:=jsonb_build_object('providerKey',p_provider_key,'displayName',p_display_name,
    'recipientKey',p_recipient_key,'gatewayKind',p_gateway_kind,'defaultAdapterId',p_default_adapter_id,
    'defaultEndpointUrl',p_default_endpoint_url,'defaultCredentialEnvName',p_default_credential_env_name,
    'defaultModelId',p_default_model_id,'reason',p_reason);
  v_replay:=public.admin_lock_committed_operation_v1(v_actor,'provider_create',p_idempotency_key,v_payload);
  if (v_replay->>'found')::boolean then
    return public.admin_replayed_operation_v1(v_replay,'provider_create',p_idempotency_key);
  end if;
  perform public.admin_assert_reason_v1(p_reason);
  if not coalesce(p_provider_key ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    and p_recipient_key ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    and length(p_display_name) between 1 and 200 and p_display_name=btrim(p_display_name)
    and p_gateway_kind in ('direct_deepseek','direct_mimo','custom_compatible')
    and (p_gateway_kind<>'direct_deepseek' or p_recipient_key='deepseek')
    and (p_gateway_kind<>'direct_mimo' or p_recipient_key='xiaomi-mimo')
    and public.ai_endpoint_shape_v2(p_default_endpoint_url)
    and p_default_credential_env_name ~ '^AI_PROVIDER_KEY_[A-Z0-9_]{1,160}$'
    and p_default_model_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$',false)
    or not exists(select 1 from public.ai_adapter_catalog where adapter_id=p_default_adapter_id and deprecated_at is null)
  then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  insert into public.ai_providers(provider_key,display_name,recipient_key,gateway_kind,
    default_adapter_id,default_endpoint_url,default_credential_env_name,default_model_id)
    values(p_provider_key,p_display_name,p_recipient_key,p_gateway_kind,p_default_adapter_id,
      p_default_endpoint_url,p_default_credential_env_name,p_default_model_id) returning * into v_provider;
  insert into public.admin_audit_events(operation,actor,target_id,reason)
    values('provider_create',v_actor::text,v_provider.id,p_reason) returning id into v_audit;
  return public.admin_commit_operation_v1(v_actor,'provider_create',p_idempotency_key,v_payload,
    jsonb_build_object('schemaVersion','admin_provider_result_v1','providerId',v_provider.id,
      'revision',v_provider.revision::text,'archived',false),v_audit);
exception when unique_violation then raise exception 'CONFLICT' using errcode='23505';
end;
$$;
revoke all on function public.admin_create_provider_v1(text,text,text,text,text,text,text,text,text,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.admin_create_provider_v1(text,text,text,text,text,text,text,text,text,text,text,uuid) to authenticated;

-- Fixed projections; caller cannot supply a table, SQL, or arbitrary sort expression.
-- VOLATILE is intentional: the shared actor check can take locks.
create function public.admin_authoring_options_v1(
  p_environment text,p_project_ref text,p_kind text,p_parent text default null,
  p_search text default null,p_after text default null,p_id text default null,p_limit integer default 25
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_query text; v_items jsonb; v_ids text[]; v_next text;
begin
  perform public.admin_assert_actor_v1(p_environment,p_project_ref);
  if p_kind is null or p_limit is null or p_limit not between 1 and 100
    or length(p_search)>100 or length(p_parent)>200 or length(p_id)>200 or length(p_after)>200
    or (p_id is not null and (p_search is not null or p_after is not null))
    or (p_kind='prices' and p_parent is null)
    or (p_parent is not null and p_kind not in ('identities','versions','prices')) then
    raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  v_query:=case p_kind
    when 'adapters' then $q$select adapter_id as id,display_name as label,null::text as parent,
      case when deprecated_at is null then 'available' else 'deprecated' end as status,
      null::integer as latest,wire_api_kind as wire from public.ai_adapter_catalog$q$
    when 'providers' then $q$select id::text,display_name || ' / ' || provider_key as label,null::text as parent,
      case when archived_at is null then 'available' else 'archived' end as status,
      null::integer as latest,null::text as wire from public.ai_providers$q$
    when 'identities' then $q$select p.id::text,p.display_name || ' / ' || p.profile_key as label,p.provider_id::text as parent,
      case when p.retired_at is null and d.archived_at is null then 'available' else 'retired' end as status,
      (select coalesce(max(v.version),0) from public.ai_provider_profile_versions v where v.profile_id=p.id) as latest,
      null::text as wire from public.ai_provider_profiles p join public.ai_providers d on d.id=p.provider_id$q$
    when 'versions' then $q$select v.id::text,coalesce(d.display_name,p.model_vendor) || ' / ' || p.profile_key || ' / v' || v.version || ' / ' || v.model_id as label,
      p.id::text as parent,v.status, null::integer as latest,null::text as wire
      from public.ai_provider_profile_versions v join public.ai_provider_profiles p on p.id=v.profile_id
      left join public.ai_providers d on d.id=p.provider_id$q$
    when 'prices' then $q$select id::text,pricing_lane || ' / v' || version || ' / ' || currency as label,
      profile_version_id::text as parent,case when components_sealed_at is null then 'unsealed' else 'sealed' end as status,
      null::integer as latest,null::text as wire from public.ai_price_versions$q$
    when 'runtime_contracts' then $q$select runtime_contract_id as id,runtime_contract_id as label,null::text as parent,
      'registered'::text as status,null::integer as latest,null::text as wire from public.ai_service_runtime_contract_versions$q$
    else null end;
  if v_query is null then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  execute 'select coalesce(jsonb_agg(jsonb_build_object(''id'',id,''label'',label,''parentId'',parent,''status'',status,''latestVersion'',latest,''wireApiKind'',wire) order by id),''[]''::jsonb),array_agg(id order by id) from (' ||
    'select * from (' || v_query || ') source where ($1 is null or parent=$1) and ($2 is null or position(lower($2) in lower(label))>0)' ||
    ' and ($3 is null or id>$3) and ($4 is null or id=$4) order by id limit $5) page'
    into v_items,v_ids using p_parent,nullif(btrim(p_search),''),p_after,p_id,p_limit+1;
  if cardinality(v_ids)>p_limit then v_next:=v_ids[p_limit]; v_items:=v_items-p_limit; end if;
  return jsonb_build_object('schemaVersion','admin_authoring_options_v1','kind',p_kind,'items',v_items,'nextCursor',v_next);
end;
$$;
revoke all on function public.admin_authoring_options_v1(text,text,text,text,text,text,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.admin_authoring_options_v1(text,text,text,text,text,text,text,integer) to authenticated;
commit;
