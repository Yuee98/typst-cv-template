-- Additive v2 execution entry points. Existing v1 routine definitions remain unchanged.
begin;

-- Versioned readback keeps the original v1 function as the authority for all
-- shared reservation, price, legal-bundle and runtime-contract checks. Only a
-- v2 profile branch replaces the execution object with its immutable fields.
create function public.get_ai_polish_execution_snapshot_v2(
  p_reservation_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base jsonb;
  v_version public.ai_provider_profile_versions%rowtype;
  v_profile public.ai_provider_profiles%rowtype;
  v_provider public.ai_providers%rowtype;
  v_price public.ai_price_versions%rowtype;
begin
  v_base := public.get_ai_polish_execution_snapshot_v1(
    p_reservation_id,
    p_user_id
  );

  if v_base ->> 'ok' is distinct from 'true' then
    return v_base;
  end if;

  select * into v_version
  from public.ai_provider_profile_versions
  where id = (v_base #>> '{routeSnapshot,profileVersionId}')::uuid;

  if not found then
    return jsonb_build_object(
      'schemaVersion', 'ai_polish_execution_snapshot_v1',
      'ok', false,
      'reason', 'SERVICE_UNAVAILABLE'
    );
  end if;

  if v_version.execution_schema_version = 'profile_execution_config_v1' then
    return v_base;
  end if;

  select * into v_profile
  from public.ai_provider_profiles
  where id = v_version.profile_id;

  select * into v_provider
  from public.ai_providers
  where id = v_profile.provider_id;

  select * into v_price
  from public.ai_price_versions
  where id = (v_base #>> '{routeSnapshot,priceVersionId}')::uuid;

  if v_version.execution_schema_version is distinct from 'profile_execution_config_v2'
     or v_version.credential_alias is not null
     or v_version.endpoint_alias is not null
     or not public.ai_endpoint_shape_v2(v_version.endpoint_url)
     or v_version.credential_env_name !~ '^AI_PROVIDER_KEY_[A-Z0-9_]{1,160}$'
     or v_profile.provider_id is null
     or v_provider.id is distinct from v_profile.provider_id
     or v_provider.gateway_kind is distinct from v_profile.gateway_kind
     or v_price.id is null
     or v_price.profile_version_id is distinct from v_version.id then
    return jsonb_build_object(
      'schemaVersion', 'ai_polish_execution_snapshot_v1',
      'ok', false,
      'reason', 'SERVICE_UNAVAILABLE'
    );
  end if;

  return jsonb_set(
    jsonb_set(
      v_base,
      '{schemaVersion}',
      to_jsonb('ai_polish_execution_snapshot_v2'::text)
    ),
    '{profileExecutionConfig}',
    jsonb_build_object(
      'schemaVersion', v_version.execution_schema_version,
      'profileKey', v_profile.profile_key,
      'providerId', v_provider.id,
      'gatewayKind', v_profile.gateway_kind,
      'adapterKind', v_version.adapter_kind,
      'wireApiKind', v_version.wire_api_kind,
      'endpointUrl', v_version.endpoint_url,
      'credentialEnvName', v_version.credential_env_name,
      'modelId', v_version.model_id,
      'capabilityContractId', v_version.capability_contract_id,
      'cachePolicyId', v_version.cache_policy_id,
      'legalManifestId', v_version.legal_manifest_id,
      'calculatorKind', v_price.calculator_kind,
      'displayDisclosureKey', v_version.display_disclosure_key,
      'config', v_version.config
    )
  );
exception
  when others then
    return jsonb_build_object(
      'schemaVersion', 'ai_polish_execution_snapshot_v1',
      'ok', false,
      'reason', 'SERVICE_UNAVAILABLE'
    );
end;
$$;

revoke all on function public.get_ai_polish_execution_snapshot_v2(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_ai_polish_execution_snapshot_v2(uuid, uuid)
  to service_role;

create function public.start_ai_polish_provider_attempt_v2(
  p_reservation_id uuid,
  p_attempt_no integer,
  p_runtime_build_id text,
  p_binding_manifest_revision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.ai_request_ledger%rowtype;
  v_attempt public.ai_provider_attempt_ledger%rowtype;
  v_config public.ai_feature_config%rowtype;
  v_profile record;
  v_price public.ai_price_versions%rowtype;
  v_started_at timestamptz;
  v_today date;
  v_global_count integer;
  v_route_snapshot jsonb;
  v_attempt_nos smallint[];
  v_child_count integer;
begin
  if p_runtime_build_id is null
     or p_runtime_build_id !~ '^[a-z0-9][a-z0-9._:-]{0,199}$'
     or p_binding_manifest_revision is null
     or p_binding_manifest_revision !~ '^[a-z0-9][a-z0-9._-]{0,199}$' then
    raise exception 'v2 execution provenance is malformed' using errcode = '22023';
  end if;

  -- attempt_no is caller-owned idempotency identity.  Reject invalid internal
  -- arguments rather than manufacturing a public availability reason.
  if p_attempt_no is null or p_attempt_no not in (1, 2) then
    raise exception 'provider attempt number must be 1 or 2'
      using errcode = '22023';
  end if;

  -- The parent row is the serialization point for starts, replays, completion
  -- and eventual settlement for this reservation.
  select * into v_request
  from public.ai_request_ledger
  where reservation_id = p_reservation_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'NOT_FOUND');
  end if;

  if v_request.state = 'finalized' then
    return jsonb_build_object('ok', false, 'reason', 'ALREADY_FINALIZED');
  end if;

  -- Legacy or partially populated rows cannot enter the V2 attempt lifecycle.
  if v_request.state is distinct from 'reserved'
     or v_request.route_schema_version is distinct from 'route_snapshot_v1'
     or v_request.runtime_contract_id is null then
    return jsonb_build_object('ok', false, 'reason', 'SERVICE_UNAVAILABLE');
  end if;

  -- Validate the complete child set before treating any row as an admitted
  -- replay.  Every child mutation takes this same parent lock in the table
  -- guard, so the ordered set is stable without taking child tuple locks in
  -- the opposite order from a direct child update.
  select
    coalesce(
      array_agg(locked_attempt.attempt_no order by locked_attempt.attempt_no),
      array[]::smallint[]
    ),
    count(*)::integer
  into v_attempt_nos, v_child_count
  from (
    select attempt_no
    from public.ai_provider_attempt_ledger
    where reservation_id = p_reservation_id
    order by attempt_no
  ) as locked_attempt;

  if v_request.attempt_count is distinct from v_child_count
     or v_attempt_nos not in (
       array[]::smallint[],
       array[1]::smallint[],
       array[1, 2]::smallint[]
     )
     or (v_attempt_nos = array[]::smallint[] and p_attempt_no <> 1) then
    return jsonb_build_object('ok', false, 'reason', 'SERVICE_UNAVAILABLE');
  end if;

  -- Exact replay follows the ledger invariant but precedes every mutable
  -- operational gate.  A response-loss retry returns the exact child identity
  -- and frozen route even if the kill switch, profile, or capacity changed.
  select * into v_attempt
  from public.ai_provider_attempt_ledger
  where reservation_id = p_reservation_id
    and attempt_no = p_attempt_no;

  if found then
    if v_attempt.execution_schema_version is distinct from 'profile_execution_config_v2'
       or v_attempt.runtime_build_id is distinct from p_runtime_build_id
       or v_attempt.binding_manifest_revision is distinct from p_binding_manifest_revision then
      return jsonb_build_object('ok', false, 'reason', 'SERVICE_UNAVAILABLE');
    end if;

    v_route_snapshot := jsonb_build_object(
      'schemaVersion', v_attempt.route_schema_version,
      'configGeneration', v_attempt.config_generation::text,
      'routingPolicyVersionId', v_attempt.routing_policy_version_id,
      'profileVersionId', v_attempt.profile_version_id,
      'priceVersionId', v_attempt.price_version_id,
      'legalBundleVersion', v_attempt.legal_bundle_version,
      'runtimeContractId', v_attempt.runtime_contract_id,
      'gatewayKind', v_attempt.gateway_kind,
      'modelId', v_attempt.model_id,
      'wireApiKind', v_attempt.wire_api_kind,
      'displayDisclosureKey', v_attempt.display_disclosure_key
    );

    return jsonb_build_object(
      'ok', true,
      'attemptId', v_attempt.attempt_id,
      'attemptNo', v_attempt.attempt_no,
      'alreadyStarted', true,
      'status', v_attempt.status,
      'routeSnapshot', v_route_snapshot
    );
  end if;

  -- One clock establishes both the immutable child start time and the UTC
  -- capacity row identity.
  v_started_at := clock_timestamp();
  v_today := (v_started_at at time zone 'utc')::date;

  -- This is the same serialization row used by the V1 mark RPC, so a V1/V2
  -- race for the last slot admits exactly one contender.
  insert into public.ai_global_usage_daily (day)
  values (v_today)
  on conflict do nothing;

  select provider_started_count into v_global_count
  from public.ai_global_usage_daily
  where day = v_today
  for update;

  -- The feature config is operational authority only.  Route identity remains
  -- frozen on the reservation even if the active routing pointer moved.
  select * into v_config
  from public.ai_feature_config
  where id = true
  for share;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'SERVICE_UNAVAILABLE');
  end if;

  if not v_config.ai_polish_enabled then
    return jsonb_build_object('ok', false, 'reason', 'AI_DISABLED');
  end if;

  if cardinality(v_config.enabled_user_allowlist) > 0
     and not (v_request.user_id = any(v_config.enabled_user_allowlist)) then
    return jsonb_build_object('ok', false, 'reason', 'AI_DISABLED');
  end if;

  if v_global_count >= v_config.global_daily_limit then
    return jsonb_build_object('ok', false, 'reason', 'SERVICE_UNAVAILABLE');
  end if;

  -- Lock the exact frozen profile identity and version.  Lifecycle status is
  -- intentionally re-read at transmission admission while execution aliases
  -- must still match the immutable reservation snapshot.
  select
    profile.retired_at as profile_retired_at,
    profile.gateway_kind,
    version.status as version_status,
    version.retired_at as version_retired_at,
    version.execution_schema_version,
    version.adapter_kind,
    version.credential_alias,
    version.endpoint_alias,
    version.endpoint_url,
    version.credential_env_name,
    version.capability_contract_id,
    version.cache_policy_id,
    version.legal_manifest_id,
    version.model_id,
    version.wire_api_kind,
    version.display_disclosure_key
  into v_profile
  from public.ai_provider_profile_versions as version
  join public.ai_provider_profiles as profile on profile.id = version.profile_id
  where version.id = v_request.profile_version_id
  for share of profile, version;

  if not found
     or v_profile.profile_retired_at is not null
     or v_profile.version_retired_at is not null
     or v_profile.version_status not in ('canary', 'active')
     or v_profile.execution_schema_version is distinct from 'profile_execution_config_v2'
     or v_profile.credential_alias is not null
     or v_profile.endpoint_alias is not null
     or not public.ai_endpoint_shape_v2(v_profile.endpoint_url)
     or v_profile.credential_env_name !~ '^AI_PROVIDER_KEY_[A-Z0-9_]{1,160}$'
     or (
       v_profile.gateway_kind,
       v_profile.model_id,
       v_profile.wire_api_kind,
       v_profile.display_disclosure_key
     ) is distinct from (
       v_request.gateway_kind,
       v_request.model_id,
       v_request.wire_api_kind,
       v_request.display_disclosure_key
     ) then
    return jsonb_build_object('ok', false, 'reason', 'SERVICE_UNAVAILABLE');
  end if;

  -- A reservation freezes its exact price even when that lane later closes.
  -- Start only proves the pair, its permanent component seal, and the aliases
  -- copied into the attempt row; it never re-evaluates the validity window.
  select * into v_price
  from public.ai_price_versions
  where id = v_request.price_version_id
    and profile_version_id = v_request.profile_version_id
  for share;

  if not found or v_price.components_sealed_at is null then
    return jsonb_build_object('ok', false, 'reason', 'SERVICE_UNAVAILABLE');
  end if;

  insert into public.ai_provider_attempt_ledger (
    reservation_id,
    attempt_no,
    route_schema_version,
    config_generation,
    routing_policy_version_id,
    profile_version_id,
    price_version_id,
    legal_bundle_version,
    runtime_contract_id,
    gateway_kind,
    model_id,
    wire_api_kind,
    display_disclosure_key,
    execution_schema_version,
    adapter_kind,
    credential_alias,
    endpoint_alias,
    endpoint_url,
    credential_env_name,
    runtime_build_id,
    binding_manifest_revision,
    capability_contract_id,
    cache_policy_id,
    legal_manifest_id,
    calculator_kind,
    billing_currency,
    started_at
  ) values (
    v_request.reservation_id,
    p_attempt_no,
    v_request.route_schema_version,
    v_request.config_generation,
    v_request.routing_policy_version_id,
    v_request.profile_version_id,
    v_request.price_version_id,
    v_request.legal_bundle_version,
    v_request.runtime_contract_id,
    v_request.gateway_kind,
    v_request.model_id,
    v_request.wire_api_kind,
    v_request.display_disclosure_key,
    v_profile.execution_schema_version,
    v_profile.adapter_kind,
    v_profile.credential_alias,
    v_profile.endpoint_alias,
    v_profile.endpoint_url,
    v_profile.credential_env_name,
    p_runtime_build_id,
    p_binding_manifest_revision,
    v_profile.capability_contract_id,
    v_profile.cache_policy_id,
    v_profile.legal_manifest_id,
    v_price.calculator_kind,
    v_price.currency,
    v_started_at
  )
  returning * into v_attempt;

  update public.ai_request_ledger
  set attempt_count = v_child_count + 1
  where reservation_id = p_reservation_id;

  update public.ai_global_usage_daily
  set provider_started_count = provider_started_count + 1
  where day = v_today;

  v_route_snapshot := jsonb_build_object(
    'schemaVersion', v_attempt.route_schema_version,
    'configGeneration', v_attempt.config_generation::text,
    'routingPolicyVersionId', v_attempt.routing_policy_version_id,
    'profileVersionId', v_attempt.profile_version_id,
    'priceVersionId', v_attempt.price_version_id,
    'legalBundleVersion', v_attempt.legal_bundle_version,
    'runtimeContractId', v_attempt.runtime_contract_id,
    'gatewayKind', v_attempt.gateway_kind,
    'modelId', v_attempt.model_id,
    'wireApiKind', v_attempt.wire_api_kind,
    'displayDisclosureKey', v_attempt.display_disclosure_key
  );

  return jsonb_build_object(
    'ok', true,
    'attemptId', v_attempt.attempt_id,
    'attemptNo', v_attempt.attempt_no,
    'alreadyStarted', false,
    'status', v_attempt.status,
    'routeSnapshot', v_route_snapshot
  );
end;
$$;

revoke all on function public.start_ai_polish_provider_attempt_v2(uuid, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.start_ai_polish_provider_attempt_v2(uuid, integer, text, text)
  to service_role;

commit;
