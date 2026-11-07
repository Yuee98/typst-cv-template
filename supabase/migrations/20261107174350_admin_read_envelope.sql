-- Append-only Admin read optimization; no table, policy, lock or authentication changes.
begin;
-- The migration role's app_api_owner membership is deliberately NOINHERIT.
-- Assume the existing restricted owner only for atomic function replacement.
grant create on schema public to app_api_owner;
set local role app_api_owner;

create or replace function public.admin_context ()
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_user uuid;
begin
  v_user := common.admin_id ();
  return public.app_context () || jsonb_build_object(
    'member_id', (
      select external_id
      from admin.members
      where auth_user_id = v_user
    ),
    'aal', common.jwt () ->> 'aal',
    'control', (
      select admin.project ('control', jsonb_build_object(
        'enabled', c.enabled,
        'active_policy_version_id', c.active_policy_version_id,
        'audience', c.audience,
        'generation', c.generation,
        'close_cycle', c.close_cycle,
        'revision', c.revision,
        'user_daily_limit', c.user_daily_limit,
        'global_daily_limit', c.global_daily_limit,
        'user_minute_limit', c.user_minute_limit
      ))
      from ai.runtime_control c
      where id = 1
    )
  );
end
$$;

revoke all on function public.admin_context () from public, anon, authenticated, service_role;
grant execute on function public.admin_context () to authenticated;
comment on function public.admin_context () is 'Lightweight Admin identity and control context. Current account, live session and membership checks are retained; legal text is available only through the dedicated legal_current API.';

create function public.admin_read (p_input jsonb)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_context jsonb;
  v_data jsonb := null;
  v_section text;
  v_kind text;
  v_allowed_keys text[] := array['contract_code', 'expected_environment', 'database_instance_id', 'section'];
begin
  -- This gate retains the current account/session/member checks and existing lock order.
  -- The environment lock prevents concurrent control/legal publication or membership
  -- changes between this context and the section read in the same transaction.
  v_context := public.admin_context ();
  if jsonb_typeof(p_input) is distinct from 'object' then
    perform common.fail ('INVALID_REQUEST', 'ADMIN_READ_INPUT');
  end if;
  if p_input ->> 'contract_code' is distinct from v_context ->> 'contract_code' then
    perform common.fail ('CLIENT_UPDATE_REQUIRED', 'DATABASE_INSTANCE_OR_CONTRACT_CHANGED');
  end if;
  if jsonb_typeof(p_input -> 'expected_environment') is distinct from 'string'
    or p_input ->> 'expected_environment' not in ('LOCAL', 'PREVIEW', 'PRODUCTION') then
    perform common.fail ('INVALID_REQUEST', 'ADMIN_READ_ENVIRONMENT');
  end if;
  if p_input ->> 'expected_environment' is distinct from v_context ->> 'environment' then
    perform common.fail ('CLIENT_UPDATE_REQUIRED', 'DATABASE_ENVIRONMENT_CHANGED');
  end if;
  -- Absence is the explicit cold-read case. Null, wrong types and wrong instances
  -- are never interpreted as a request to rediscover or silently rebind identity.
  if p_input ? 'database_instance_id' then
    if jsonb_typeof(p_input -> 'database_instance_id') is distinct from 'string'
      or p_input ->> 'database_instance_id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      perform common.fail ('INVALID_REQUEST', 'ADMIN_READ_INSTANCE');
    end if;
    if lower(p_input ->> 'database_instance_id') is distinct from v_context ->> 'database_instance_id' then
      perform common.fail ('CLIENT_UPDATE_REQUIRED', 'DATABASE_INSTANCE_OR_CONTRACT_CHANGED');
    end if;
  end if;
  v_section := p_input ->> 'section';
  if jsonb_typeof(p_input -> 'section') is distinct from 'string'
    or v_section not in ('overview', 'users', 'providers', 'profiles', 'prices', 'policies', 'controls', 'analytics', 'audit') then
    perform common.fail ('INVALID_REQUEST', 'ADMIN_READ_SECTION');
  end if;
  if v_section = 'analytics' then
    v_allowed_keys := v_allowed_keys || array['days'];
    if p_input ? 'days' and (
      jsonb_typeof(p_input -> 'days') is distinct from 'number'
      or p_input ->> 'days' !~ '^(?:[1-9]|[12][0-9]|3[01])$'
    ) then
      perform common.fail ('INVALID_REQUEST', 'DAYS_RANGE');
    end if;
  elsif v_section not in ('overview', 'controls') then
    v_kind := p_input ->> 'kind';
    if jsonb_typeof(p_input -> 'kind') is distinct from 'string' or not (
      (v_section = 'users' and v_kind in ('users', 'members'))
      or (v_section = 'providers' and v_kind = 'providers')
      or (v_section = 'profiles' and v_kind in ('profiles', 'profile_versions'))
      or (v_section = 'prices' and v_kind = 'price_versions')
      or (v_section = 'policies' and v_kind in ('policies', 'policy_versions'))
      or (v_section = 'audit' and v_kind = 'events')
    ) then
      perform common.fail ('INVALID_REQUEST', 'ADMIN_READ_KIND');
    end if;
    v_allowed_keys := v_allowed_keys || array['kind'];
    if p_input ? 'external_id' then
      v_allowed_keys := v_allowed_keys || array['external_id'];
      if jsonb_typeof(p_input -> 'external_id') is distinct from 'string'
        or p_input ->> 'external_id' !~ '^(prv|prf|pfv|pcv|pol|plv|opt|lgb|lds|ldv|adm|op|val|rbk|evt|req)_[0-9A-HJKMNP-TV-Z]{12}$'
        or v_kind = 'users' then
        perform common.fail ('INVALID_REQUEST', 'ADMIN_READ_RECORD');
      end if;
    else
      v_allowed_keys := v_allowed_keys || array['limit', 'after'];
      if p_input ? 'limit' and (
        jsonb_typeof(p_input -> 'limit') is distinct from 'number'
        or p_input ->> 'limit' !~ '^[1-9][0-9]{0,2}$'
      ) then
        perform common.fail ('INVALID_REQUEST', 'PAGE_LIMIT');
      end if;
      if (p_input ->> 'limit')::integer > 100 then
        perform common.fail ('INVALID_REQUEST', 'PAGE_LIMIT');
      end if;
      if p_input ? 'after' and (
        jsonb_typeof(p_input -> 'after') is distinct from 'string'
        or length(p_input ->> 'after') > 200
      ) then
        perform common.fail ('INVALID_REQUEST', 'ADMIN_READ_CURSOR');
      end if;
    end if;
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_input) as k (key)
    where not (k.key = any(v_allowed_keys))
  ) then
    perform common.fail ('INVALID_REQUEST', 'ADMIN_READ_FIELDS');
  end if;

  if v_section = 'analytics' then
    v_data := public.admin_analytics (coalesce((p_input ->> 'days')::integer, 7));
  elsif v_section not in ('overview', 'controls') then
    if p_input ? 'external_id' then
      v_data := public.admin_record (v_kind, p_input ->> 'external_id');
    else
      v_data := public.admin_records (v_kind, coalesce((p_input ->> 'limit')::integer, 25), p_input ->> 'after');
    end if;
  end if;
  return jsonb_build_object('context', v_context, 'data', v_data);
end
$$;

-- Only the same authenticated bearer may read Admin data. This wrapper creates
-- no new table/schema grants, caller SQL, service-role path or authorization cache.
revoke all on function public.admin_read (jsonb) from public, anon, authenticated, service_role;
grant execute on function public.admin_read (jsonb) to authenticated;
comment on function public.admin_read (jsonb) is 'One authenticated Admin read envelope: slim context plus an allowlisted section projection in the same transaction. Exact contract/environment and an optional cold-read instance precondition; supplied stale instances fail closed. Existing live account/session/member gates, lock order, projections and pagination remain authoritative.';

reset role;
revoke create on schema public from app_api_owner;
commit;
