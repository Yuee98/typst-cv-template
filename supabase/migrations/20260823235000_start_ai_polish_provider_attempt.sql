-- Atomically admit and record one provider attempt for a frozen V2 route.
--
-- V1 mark_ai_polish_provider_started remains independent and unchanged.  The
-- V2 lifecycle keeps its parent request reserved while child attempts are in
-- progress; later migrations own attempt completion and request settlement.

begin;

create function public.start_ai_polish_provider_attempt(
  p_reservation_id uuid,
  p_attempt_no integer
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
     or v_request.runtime_contract_id is null
     or v_request.runtime_contract_sha256 is null then
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
    v_route_snapshot := jsonb_build_object(
      'schemaVersion', v_attempt.route_schema_version,
      'configGeneration', v_attempt.config_generation::text,
      'routingPolicyVersionId', v_attempt.routing_policy_version_id,
      'profileVersionId', v_attempt.profile_version_id,
      'priceVersionId', v_attempt.price_version_id,
      'legalBundleVersion', v_attempt.legal_bundle_version,
      'runtimeContractId', v_attempt.runtime_contract_id,
      'runtimeContractSha256', v_attempt.runtime_contract_sha256,
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
    version.adapter_kind,
    version.credential_alias,
    version.endpoint_alias,
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
    runtime_contract_sha256,
    gateway_kind,
    model_id,
    wire_api_kind,
    display_disclosure_key,
    adapter_kind,
    credential_alias,
    endpoint_alias,
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
    v_request.runtime_contract_sha256,
    v_request.gateway_kind,
    v_request.model_id,
    v_request.wire_api_kind,
    v_request.display_disclosure_key,
    v_profile.adapter_kind,
    v_profile.credential_alias,
    v_profile.endpoint_alias,
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
    'runtimeContractSha256', v_attempt.runtime_contract_sha256,
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

revoke all on function public.start_ai_polish_provider_attempt(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.start_ai_polish_provider_attempt(uuid, integer)
  to service_role;

commit;
