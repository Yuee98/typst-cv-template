-- Strict, snapshot-bound reservation for the multi-provider AI polish path.
--
-- V1 remains untouched.  This independent V2 RPC treats the caller's route
-- expectation only as an equality assertion, locks the authoritative route in
-- one order, and writes the complete immutable route snapshot before returning.

begin;

create function public.reserve_ai_polish_request_v2(
  p_user_id uuid,
  p_request_id uuid,
  p_client_request_id uuid,
  p_expected_route jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_daily_limit constant integer := 20;
  c_minute_limit constant integer := 3;

  v_config public.ai_feature_config%rowtype;
  v_policy public.ai_routing_policy_versions%rowtype;
  v_runtime public.ai_service_runtime_contract_versions%rowtype;
  v_ledger public.ai_request_ledger%rowtype;
  v_selected_profile record;

  v_expected_generation_text text;
  v_expected_profile_version_id uuid;
  v_expected_legal_bundle_version text;
  v_expected_runtime_contract_id text;
  v_expected_runtime_contract_sha256 text;

  v_route_at timestamptz;
  v_local_route_at timestamp without time zone;
  v_local_weekday integer;
  v_local_minute integer;
  v_window jsonb;
  v_selected_route jsonb;
  v_selected_profile_version_id uuid;
  v_selected_price_version_id uuid;

  v_today date;
  v_reset_at timestamptz;
  v_minute_bucket timestamptz;
  v_existing_state text;
  v_global_count integer;
  v_daily_count integer;
  v_minute_count integer;
  v_new_count integer;
begin
  -- Reject anything other than the exact expected_route_v1 wire object before
  -- acquiring quota, rate, dedup, or request-ledger state.
  if p_expected_route is null
     or jsonb_typeof(p_expected_route) is distinct from 'object' then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'AI_ROUTE_CHANGED',
      'message', 'The AI route changed; refresh availability and confirm again.'
    );
  end if;

  if not (
       p_expected_route ?& array[
         'schema_version',
         'config_generation',
         'profile_version_id',
         'legal_bundle_version',
         'runtime_contract_id',
         'runtime_contract_sha256'
       ]
     )
     or (
       p_expected_route - array[
         'schema_version',
         'config_generation',
         'profile_version_id',
         'legal_bundle_version',
         'runtime_contract_id',
         'runtime_contract_sha256'
       ]
     ) is distinct from '{}'::jsonb
     or jsonb_typeof(p_expected_route->'schema_version') is distinct from 'string'
     or jsonb_typeof(p_expected_route->'config_generation') is distinct from 'string'
     or jsonb_typeof(p_expected_route->'profile_version_id') is distinct from 'string'
     or jsonb_typeof(p_expected_route->'legal_bundle_version') is distinct from 'string'
     or jsonb_typeof(p_expected_route->'runtime_contract_id') is distinct from 'string'
     or jsonb_typeof(p_expected_route->'runtime_contract_sha256') is distinct from 'string'
     or p_expected_route->>'schema_version' is distinct from 'expected_route_v1'
     or p_expected_route->>'config_generation' !~ '^(0|[1-9][0-9]*)$'
     or p_expected_route->>'profile_version_id'
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or p_expected_route->>'legal_bundle_version'
       !~ '^[a-z0-9][a-z0-9._-]{0,199}$'
     or p_expected_route->>'runtime_contract_id'
       !~ '^[a-z0-9][a-z0-9._-]{0,199}$'
     or p_expected_route->>'runtime_contract_sha256' !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'AI_ROUTE_CHANGED',
      'message', 'The AI route changed; refresh availability and confirm again.'
    );
  end if;

  v_expected_generation_text := p_expected_route->>'config_generation';
  if length(v_expected_generation_text) > 19 then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'AI_ROUTE_CHANGED',
      'message', 'The AI route changed; refresh availability and confirm again.'
    );
  end if;

  if v_expected_generation_text::numeric > 9223372036854775807::numeric then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'AI_ROUTE_CHANGED',
      'message', 'The AI route changed; refresh availability and confirm again.'
    );
  end if;

  v_expected_profile_version_id :=
    (p_expected_route->>'profile_version_id')::uuid;
  v_expected_legal_bundle_version :=
    p_expected_route->>'legal_bundle_version';
  v_expected_runtime_contract_id :=
    p_expected_route->>'runtime_contract_id';
  v_expected_runtime_contract_sha256 :=
    p_expected_route->>'runtime_contract_sha256';

  -- Identity values are server facts, but NULL still must fail closed before
  -- advisory, quota, rate, or ledger state.  Malformed route precedence above
  -- remains unconditional so stale/old clients always receive ROUTE_CHANGED.
  if p_user_id is null
     or p_request_id is null
     or p_client_request_id is null then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'SERVICE_UNAVAILABLE',
      'message', 'AI polish is temporarily unavailable.'
    );
  end if;

  -- All configuration work is isolated in a subtransaction.  Invalid,
  -- missing, retired, unsealed, or internally inconsistent configuration is a
  -- fail-closed availability denial and cannot leak DB diagnostics to callers.
  begin
    -- 1. Singleton config, then 2. its exact policy.
    select * into v_config
    from public.ai_feature_config
    where id = true
    for share;

    if not found then
      return jsonb_build_object(
        'allowed', false,
        'reason', 'SERVICE_UNAVAILABLE',
        'message', 'AI polish is temporarily unavailable.'
      );
    end if;

    if not v_config.ai_polish_enabled then
      return jsonb_build_object(
        'allowed', false,
        'reason', 'AI_DISABLED',
        'message', 'AI polish is currently disabled.'
      );
    end if;

    if cardinality(v_config.enabled_user_allowlist) > 0
       and not (p_user_id = any(v_config.enabled_user_allowlist)) then
      return jsonb_build_object(
        'allowed', false,
        'reason', 'AI_DISABLED',
        'message', 'AI polish is not enabled for this account.'
      );
    end if;

    if v_config.active_routing_policy_version_id is null then
      return jsonb_build_object(
        'allowed', false,
        'reason', 'SERVICE_UNAVAILABLE',
        'message', 'AI polish is temporarily unavailable.'
      );
    end if;

    select * into v_policy
    from public.ai_routing_policy_versions
    where id = v_config.active_routing_policy_version_id
    for share;

    if not found then
      return jsonb_build_object(
        'allowed', false,
        'reason', 'SERVICE_UNAVAILABLE',
        'message', 'AI polish is temporarily unavailable.'
      );
    end if;

    -- 3. One route/accounting instant for this reservation identity.
    v_route_at := clock_timestamp();

    -- Strict parse/ID discovery has no dependency locks and therefore cannot
    -- reverse the runtime -> profile -> price order below.
    perform public.validate_ai_routing_policy_row_v1(
      v_policy,
      'reserve',
      v_route_at,
      true
    );

    -- 4. Deterministic Asia/Shanghai half-open window selection.
    v_local_route_at := v_route_at at time zone 'Asia/Shanghai';
    v_local_weekday := extract(isodow from v_local_route_at)::integer;
    v_local_minute :=
      extract(hour from v_local_route_at)::integer * 60
      + extract(minute from v_local_route_at)::integer;
    v_selected_route := v_policy.rules->'defaultRoute';

    for v_window in
      select value
      from jsonb_array_elements(v_policy.rules->'windows')
    loop
      if v_local_minute >= (v_window->>'startMinute')::integer
         and v_local_minute < (v_window->>'endMinute')::integer
         and exists (
           select 1
           from jsonb_array_elements(v_window->'weekdays') as weekday(value)
           where (weekday.value #>> '{}')::integer = v_local_weekday
         ) then
        v_selected_route := v_window->'route';
        exit;
      end if;
    end loop;

    v_selected_profile_version_id :=
      (v_selected_route->>'profileVersionId')::uuid;
    v_selected_price_version_id :=
      (v_selected_route->>'priceVersionId')::uuid;

    -- 5. Runtime root.  The sealed parent makes its membership and target
    -- projection immutable, so children are read without reverse locks.
    select * into v_runtime
    from public.ai_service_runtime_contract_versions
    where runtime_contract_id = v_policy.runtime_contract_id
      and runtime_contract_sha256 = v_policy.runtime_contract_sha256
    for share;

    if not found or v_runtime.sealed_at is null then
      raise exception 'reserve requires an exact sealed runtime contract'
        using errcode = '23514';
    end if;

    perform 1
    from public.ai_service_runtime_contract_targets as membership
    join public.ai_service_runtime_target_versions as target
      on target.runtime_target_id = membership.runtime_target_id
     and target.runtime_target_sha256 = membership.runtime_target_sha256
     and target.profile_key = membership.profile_key
     and target.legal_manifest_id = membership.legal_manifest_id
     and target.manifest_sha256 = membership.manifest_sha256
     and target.route_descriptor_id = membership.route_descriptor_id
     and target.route_descriptor_sha256 = membership.route_descriptor_sha256
    where membership.runtime_contract_id = v_runtime.runtime_contract_id
      and membership.runtime_contract_sha256 = v_runtime.runtime_contract_sha256;

    if not found then
      raise exception 'reserve runtime contract has no exact target projection'
        using errcode = '23514';
    end if;

    -- 6. Every policy target profile parent, then version, in UUID order.
    perform 1
    from public.ai_provider_profiles as profile
    join public.ai_provider_profile_versions as version
      on version.profile_id = profile.id
    where version.id in (
      select distinct target.profile_version_id
      from (
        select (v_policy.rules->'defaultRoute'->>'profileVersionId')::uuid
          as profile_version_id
        union all
        select (window_entry.value->'route'->>'profileVersionId')::uuid
        from jsonb_array_elements(v_policy.rules->'windows') as window_entry(value)
      ) as target
    )
    order by profile.id
    for share of profile;

    perform 1
    from public.ai_provider_profile_versions as version
    where version.id in (
      select distinct target.profile_version_id
      from (
        select (v_policy.rules->'defaultRoute'->>'profileVersionId')::uuid
          as profile_version_id
        union all
        select (window_entry.value->'route'->>'profileVersionId')::uuid
        from jsonb_array_elements(v_policy.rules->'windows') as window_entry(value)
      ) as target
    )
    order by version.id
    for share;

    -- 7. Every policy target price, in UUID order.  Reserve never seals or
    -- mutates prices.
    perform 1
    from public.ai_price_versions as price
    where price.id in (
      select distinct target.price_version_id
      from (
        select (v_policy.rules->'defaultRoute'->>'priceVersionId')::uuid
          as price_version_id
        union all
        select (window_entry.value->'route'->>'priceVersionId')::uuid
        from jsonb_array_elements(v_policy.rules->'windows') as window_entry(value)
      ) as target
    )
    order by price.id
    for share;

    -- Authoritative reserve-phase validation re-reads all locked facts and the
    -- immutable legal/runtime children.
    perform public.validate_ai_routing_policy_row_v1(
      v_policy,
      'reserve',
      v_route_at,
      false
    );

    select
      profile.gateway_kind,
      version.model_id,
      version.wire_api_kind,
      version.display_disclosure_key
    into v_selected_profile
    from public.ai_provider_profile_versions as version
    join public.ai_provider_profiles as profile on profile.id = version.profile_id
    where version.id = v_selected_profile_version_id;

    if not found then
      raise exception 'selected route profile disappeared'
        using errcode = '23514';
    end if;

    -- expected_route_v1 is assertion-only.  The selected price is deliberately
    -- absent from the client assertion and is copied only from policy facts.
    if v_expected_generation_text is distinct from v_config.config_generation::text
       or v_expected_profile_version_id is distinct from v_selected_profile_version_id
       or v_expected_legal_bundle_version is distinct from v_policy.legal_bundle_version
       or v_expected_runtime_contract_id is distinct from v_runtime.runtime_contract_id
       or v_expected_runtime_contract_sha256
         is distinct from v_runtime.runtime_contract_sha256 then
      return jsonb_build_object(
        'allowed', false,
        'reason', 'AI_ROUTE_CHANGED',
        'message', 'The AI route changed; refresh availability and confirm again.'
      );
    end if;
  exception
    when others then
      return jsonb_build_object(
        'allowed', false,
        'reason', 'SERVICE_UNAVAILABLE',
        'message', 'AI polish is temporarily unavailable.'
      );
  end;

  -- Every accounting identity is derived from the one v_route_at above.
  v_today := (v_route_at at time zone 'utc')::date;
  v_reset_at := ((v_today + 1) at time zone 'utc');
  v_minute_bucket := date_trunc('minute', v_route_at);

  -- Route assertion precedes advisory dedup and every mutable admission row.
  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || p_client_request_id::text, 0)
  );

  select state into v_existing_state
  from public.ai_request_ledger
  where user_id = p_user_id
    and client_request_id = p_client_request_id;

  if found then
    if v_existing_state = 'finalized' then
      return jsonb_build_object(
        'allowed', false,
        'reason', 'DUPLICATE_REQUEST',
        'message', 'This request was already processed.'
      );
    end if;
    return jsonb_build_object(
      'allowed', false,
      'reason', 'REQUEST_IN_PROGRESS',
      'message', 'An identical request is already in progress.'
    );
  end if;

  select provider_started_count into v_global_count
  from public.ai_global_usage_daily
  where day = v_today;

  if coalesce(v_global_count, 0) >= v_config.global_daily_limit then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'SERVICE_UNAVAILABLE',
      'message', 'AI polish is temporarily unavailable (daily capacity reached).'
    );
  end if;

  insert into public.ai_usage_daily (user_id, day)
  values (p_user_id, v_today)
  on conflict do nothing;

  select request_count into v_daily_count
  from public.ai_usage_daily
  where user_id = p_user_id
    and day = v_today
  for update;

  if v_daily_count >= c_daily_limit then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'QUOTA_EXCEEDED',
      'message', 'Daily AI polish quota exhausted.',
      'remaining', 0,
      'resetAt', v_reset_at
    );
  end if;

  insert into public.ai_rate_minutes (user_id, minute_bucket)
  values (p_user_id, v_minute_bucket)
  on conflict do nothing;

  select count into v_minute_count
  from public.ai_rate_minutes
  where user_id = p_user_id
    and minute_bucket = v_minute_bucket
  for update;

  if v_minute_count >= c_minute_limit then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'RATE_LIMITED',
      'message', 'Too many AI polish requests; slow down.',
      'retryAfterSeconds', greatest(
        1,
        ceil(
          extract(
            epoch from (v_minute_bucket + interval '1 minute' - v_route_at)
          )
        )::integer
      )
    );
  end if;

  begin
    update public.ai_usage_daily
    set request_count = request_count + 1
    where user_id = p_user_id
      and day = v_today
    returning request_count into v_new_count;

    update public.ai_rate_minutes
    set count = count + 1
    where user_id = p_user_id
      and minute_bucket = v_minute_bucket;

    insert into public.ai_request_ledger (
      request_id,
      client_request_id,
      user_id,
      reserved_at,
      route_schema_version,
      config_generation,
      routing_policy_version_id,
      profile_version_id,
      price_version_id,
      legal_bundle_version,
      runtime_contract_id,
      runtime_contract_sha256,
      gateway_kind,
      model_id,
      wire_api_kind,
      display_disclosure_key
    ) values (
      p_request_id,
      p_client_request_id,
      p_user_id,
      v_route_at,
      'route_snapshot_v1',
      v_config.config_generation,
      v_policy.id,
      v_selected_profile_version_id,
      v_selected_price_version_id,
      v_policy.legal_bundle_version,
      v_runtime.runtime_contract_id,
      v_runtime.runtime_contract_sha256,
      v_selected_profile.gateway_kind,
      v_selected_profile.model_id,
      v_selected_profile.wire_api_kind,
      v_selected_profile.display_disclosure_key
    )
    returning * into v_ledger;
  exception
    when unique_violation then
      return jsonb_build_object(
        'allowed', false,
        'reason', 'REQUEST_IN_PROGRESS',
        'message', 'An identical request is already in progress.'
      );
  end;

  return jsonb_build_object(
    'allowed', true,
    'reservationId', v_ledger.reservation_id,
    'limit', c_daily_limit,
    'remaining', c_daily_limit - v_new_count,
    'resetAt', v_reset_at,
    'routeSnapshot', jsonb_build_object(
      'schemaVersion', v_ledger.route_schema_version,
      'configGeneration', v_ledger.config_generation::text,
      'routingPolicyVersionId', v_ledger.routing_policy_version_id,
      'profileVersionId', v_ledger.profile_version_id,
      'priceVersionId', v_ledger.price_version_id,
      'legalBundleVersion', v_ledger.legal_bundle_version,
      'runtimeContractId', v_ledger.runtime_contract_id,
      'runtimeContractSha256', v_ledger.runtime_contract_sha256,
      'gatewayKind', v_ledger.gateway_kind,
      'modelId', v_ledger.model_id,
      'wireApiKind', v_ledger.wire_api_kind,
      'displayDisclosureKey', v_ledger.display_disclosure_key
    )
  );
end;
$$;

revoke all on function public.reserve_ai_polish_request_v2(
  uuid,
  uuid,
  uuid,
  jsonb
) from public, anon, authenticated, service_role;

grant execute on function public.reserve_ai_polish_request_v2(
  uuid,
  uuid,
  uuid,
  jsonb
) to service_role;

commit;
