-- ADM-I02 expand only: no AI gate, pointer, legal current or operator grant changes.
begin;

create table public.admin_environment (
  id boolean primary key default true check (id),
  environment text not null check (environment in ('local','preview','production')),
  project_ref text not null check (project_ref ~ '^[a-z0-9-]{1,100}$'),
  auth_issuer text not null check (length(auth_issuer) between 15 and 300),
  control_plane_mode text not null default 'legacy' check (control_plane_mode in ('legacy','jwt_v1')),
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default now()
);
create table public.admin_principals (
  user_id uuid primary key references auth.users(id) on delete restrict,
  enabled_at timestamptz not null default now(),
  revoked_at timestamptz null,
  revision bigint not null default 1 check (revision > 0),
  check (revoked_at is null or revoked_at >= enabled_at)
);
create table public.admin_audit_events (
  id uuid primary key default extensions.gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  operation text not null check (operation ~ '^[a-z][a-z0-9_]{0,99}$'),
  actor text not null check (length(actor) between 1 and 200),
  target_id uuid null,
  reason text not null check (reason=btrim(reason) and length(reason) between 1 and 500)
);
alter table public.admin_environment enable row level security;
alter table public.admin_principals enable row level security;
alter table public.admin_audit_events enable row level security;
revoke all on public.admin_environment,public.admin_principals,public.admin_audit_events
  from public,anon,authenticated,service_role;

create function public.admin_guard_audit_v1() returns trigger
language plpgsql set search_path='' as $$
begin
  raise exception 'admin audit is append-only' using errcode='23514';
end;
$$;
create trigger admin_audit_append_only before update or delete on public.admin_audit_events
for each row execute function public.admin_guard_audit_v1();
revoke all on function public.admin_guard_audit_v1() from public,anon,authenticated,service_role;

-- Does not auto-enroll anybody. Only a direct, authorized database operator
-- may initialize the project identity and bind the first existing Auth user.
create function public.admin_bootstrap_v1(
  p_user_id uuid,p_environment text,p_project_ref text,p_auth_issuer text,p_reason text
) returns uuid language plpgsql security definer set search_path='' as $$
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
  if p_environment='local' then
    if p_project_ref<>'local' or p_auth_issuer not in
      ('http://127.0.0.1:54321/auth/v1','http://localhost:54321/auth/v1') then
      raise exception 'invalid local identity' using errcode='23514';
    end if;
  elsif p_environment in ('preview','production') then
    if p_project_ref is null or p_auth_issuer is distinct from
      'https://' || p_project_ref || '.supabase.co/auth/v1' then
      raise exception 'invalid hosted identity' using errcode='23514';
    end if;
  else
    raise exception 'invalid environment' using errcode='23514';
  end if;
  insert into public.admin_environment(id,environment,project_ref,auth_issuer)
    values(true,p_environment,p_project_ref,p_auth_issuer);
  insert into public.admin_principals(user_id) values(p_user_id);
  insert into public.admin_audit_events(operation,actor,target_id,reason)
    values('admin_bootstrap','db_operator',p_user_id,p_reason) returning id into v_audit;
  return v_audit;
end;
$$;
revoke all on function public.admin_bootstrap_v1(uuid,text,text,text,text)
  from public,anon,authenticated,service_role;

create function public.admin_assert_actor_v1(p_environment text,p_project_ref text)
returns uuid language plpgsql security definer set search_path='' as $$
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
  if v_environment.environment is distinct from p_environment
    or v_environment.project_ref is distinct from p_project_ref
    or v_environment.auth_issuer is distinct from auth.jwt()->>'iss' then
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
$$;
revoke all on function public.admin_assert_actor_v1(text,text) from public,anon,authenticated,service_role;

create function public.admin_get_context_v1(p_environment text,p_project_ref text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid; v_result jsonb;
begin
  v_actor:=public.admin_assert_actor_v1(p_environment,p_project_ref);
  select jsonb_build_object(
    'schemaVersion','admin_context_v1',
    'actor',jsonb_build_object('userId',v_actor,'email',u.email,'revision',p.revision::text),
    'environment',jsonb_build_object('name',e.environment,'projectRef',e.project_ref,
      'controlPlaneMode',e.control_plane_mode,'revision',e.revision::text),
    'features',jsonb_build_object('aiEnabled',f.ai_polish_enabled,'globalDailyLimit',f.global_daily_limit,
      'allowlistedUsers',coalesce(cardinality(f.enabled_user_allowlist),0),'configGeneration',f.config_generation::text,
      'activePolicyVersionId',f.active_routing_policy_version_id,'currentLegalBundle',public.current_ai_terms_version()),
    'capabilities',jsonb_build_object('writes',false)
  ) into v_result from public.admin_environment e cross join public.ai_feature_config f
    join public.admin_principals p on p.user_id=v_actor join auth.users u on u.id=p.user_id
    where e.id=true and f.id=true;
  if v_result is null then raise exception 'UNAVAILABLE' using errcode='P0001'; end if;
  return v_result;
end;
$$;
revoke all on function public.admin_get_context_v1(text,text) from public,anon,authenticated,service_role;
grant execute on function public.admin_get_context_v1(text,text) to authenticated;

-- Fixed query fragments only. User text is bound as values, never identifiers
-- or SQL. Wrapping projections never serializes complete Auth/config rows.
create function public.admin_records_query_v1(p_section text) returns text
language plpgsql set search_path='' as $$
begin
  return case p_section
  when 'users' then $query$
    select u.id,coalesce(u.email,'') as search_text,jsonb_build_object(
      'id',u.id,'email',u.email,'createdAt',u.created_at,
      'isAdmin',p.user_id is not null and p.revoked_at is null,'revision',p.revision::text,
      'banned',u.banned_until is not null and u.banned_until>clock_timestamp()) as item
    from auth.users u left join public.admin_principals p on p.user_id=u.id where u.deleted_at is null
  $query$
  when 'profiles' then $query$
    select v.id,p.profile_key || ' ' || v.model_id as search_text,jsonb_build_object(
      'id',v.id,'profileId',v.profile_id,'profileKey',p.profile_key,'version',v.version,'status',v.status,
      'gatewayKind',p.gateway_kind,'adapterKind',v.adapter_kind,'wireApiKind',v.wire_api_kind,
      'modelId',v.model_id,'legalManifestId',v.legal_manifest_id,'displayDisclosureKey',v.display_disclosure_key,
      'endpointAlias',v.endpoint_alias,'credentialAlias',v.credential_alias,'endpointUrl',null,
      'credentialEnvName',null,'configSha256',v.config_sha256,'createdAt',v.created_at) as item
    from public.ai_provider_profile_versions v join public.ai_provider_profiles p on p.id=v.profile_id
  $query$
  when 'prices' then $query$
    select v.id,v.currency as search_text,jsonb_build_object('id',v.id,'profileVersionId',v.profile_version_id,
      'currency',v.currency,'calculatorKind',v.calculator_kind,'validFrom',v.valid_from,'validTo',v.valid_to,
      'sealedAt',v.components_sealed_at,'createdAt',v.created_at) as item from public.ai_price_versions v
  $query$
  when 'policies' then $query$
    select v.id,v.policy_key as search_text,jsonb_build_object('id',v.id,'policyKey',v.policy_key,
      'version',v.version,'status',v.status,'timezone',v.timezone,
      'defaultProfileVersionId',v.default_profile_version_id,'legalBundleVersion',v.legal_bundle_version,
      'runtimeContractId',v.runtime_contract_id,'configSha256',v.config_sha256,'createdAt',v.created_at) as item
    from public.ai_routing_policy_versions v
  $query$
  when 'audit' then $query$
    select id,operation as search_text,jsonb_build_object('id',id,'occurredAt',occurred_at,
      'source','admin','operation',operation,'actor',actor,'targetId',target_id,'reason',reason) as item
      from public.admin_audit_events
    union all
    select audit_id,operation,jsonb_build_object('id',audit_id,'occurredAt',occurred_at,
      'source','lifecycle','operation',operation,'actor',actor,
      'targetId',coalesce(policy_version_id,profile_version_id,profile_id,price_version_id),'reason',reason)
      from public.ai_routing_lifecycle_audit
  $query$
  else null end;
end;
$$;
revoke all on function public.admin_records_query_v1(text) from public,anon,authenticated,service_role;

create function public.admin_list_records_v1(
  p_environment text,p_project_ref text,p_section text,p_limit integer default 25,
  p_after text default null,p_search text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_query text; v_rows jsonb; v_ids uuid[]; v_after uuid; v_next uuid;
begin
  perform public.admin_assert_actor_v1(p_environment,p_project_ref);
  v_query:=public.admin_records_query_v1(p_section);
  if v_query is null or p_limit is null or p_limit not between 1 and 100
    or length(p_search)>100 or (p_after is not null and p_after !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception 'INVALID_REQUEST' using errcode='22023';
  end if;
  v_after:=p_after::uuid;
  execute 'select coalesce(jsonb_agg(item order by id),''[]''::jsonb),array_agg(id order by id) from (' ||
    'select id,item from (' || v_query || ') as source where ($1 is null or id>$1)' ||
    ' and ($2 is null or position(lower($2) in lower(search_text))>0) order by id limit $3) as page'
    into v_rows,v_ids using v_after,nullif(btrim(p_search),''),p_limit+1;
  if cardinality(v_ids)>p_limit then
    v_next:=v_ids[p_limit]; v_rows:=v_rows-p_limit;
  end if;
  return jsonb_build_object('schemaVersion','admin_page_v1','section',p_section,'items',v_rows,'nextCursor',v_next);
end;
$$;
revoke all on function public.admin_list_records_v1(text,text,text,integer,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.admin_list_records_v1(text,text,text,integer,text,text) to authenticated;

create function public.admin_get_record_v1(p_environment text,p_project_ref text,p_section text,p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_query text; v_row jsonb;
begin
  perform public.admin_assert_actor_v1(p_environment,p_project_ref);
  v_query:=public.admin_records_query_v1(p_section);
  if v_query is null or p_id is null then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  execute 'select item from (' || v_query || ') as source where id=$1' into v_row using p_id;
  if v_row is null then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  return jsonb_build_object('schemaVersion','admin_page_v1','section',p_section,
    'items',jsonb_build_array(v_row),'nextCursor',null);
end;
$$;
revoke all on function public.admin_get_record_v1(text,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.admin_get_record_v1(text,text,text,uuid) to authenticated;

commit;
