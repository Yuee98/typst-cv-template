-- Complete immutable provider-attempt facts and settle V2 requests from those
-- facts.  The request settlement half is added below in the same migration;
-- keeping both lifecycle operations in one migration prevents a live partial
-- deployment between completion and aggregation semantics.

begin;

-- This table is intentionally dark before DB-010.  Refuse to assign a new
-- completeness identity to any pre-existing aggregate row silently.
do $$
begin
  if exists (select 1 from public.ai_profile_usage_daily) then
    raise exception 'DB-010 requires an empty ai_profile_usage_daily preflight'
      using errcode = '23514';
  end if;
end;
$$;

alter table public.ai_profile_usage_daily
  add column provider_report_incomplete_count integer not null default 0,
  add constraint ai_profile_usage_daily_provider_report_incomplete_check
    check (provider_report_incomplete_count >= 0);

alter table public.ai_request_ledger
  drop constraint ai_request_ledger_usage_conservation_check,
  drop constraint ai_request_ledger_v2_incomplete_consistency_check,
  drop constraint ai_request_ledger_cost_check;

alter table public.ai_request_ledger
  add constraint ai_request_ledger_usage_conservation_check check (coalesce((
    cache_usage_reporting is null
    or (
      cache_usage_reporting = 'reported'
      and input_total_tokens is not null
      and input_cache_read_tokens is not null
      and input_cache_write_tokens is not null
      and input_standard_tokens is not null
      and input_total_tokens::numeric =
        input_cache_read_tokens::numeric
        + input_cache_write_tokens::numeric
        + input_standard_tokens::numeric
    )
    or (
      cache_usage_reporting = 'unavailable'
      and input_total_tokens is not null
      and input_cache_read_tokens is not null
      and input_cache_write_tokens is null
      and input_standard_tokens is not null
      and input_total_tokens::numeric >=
        input_cache_read_tokens::numeric + input_standard_tokens::numeric
    )
    or (
      cache_usage_reporting = 'not_applicable'
      and input_total_tokens is not null
      and input_cache_read_tokens = 0
      and input_cache_write_tokens = 0
      and input_standard_tokens is not null
      and input_total_tokens = input_standard_tokens
    )
  ), false)),
  add constraint ai_request_ledger_v2_incomplete_consistency_check check (coalesce((
    usage_schema_version is distinct from 'request_usage_aggregate_v2'
    or (
      incomplete_fields is not null
      and (
        usage_complete is true
        and pg_catalog.array_position(incomplete_fields, 'attempt_usage') is null
        or usage_complete is false
        and pg_catalog.array_position(incomplete_fields, 'attempt_usage') is not null
      )
      and (input_cache_write_tokens is null) =
        (pg_catalog.array_position(incomplete_fields, 'input_cache_write') is not null)
      and (reasoning_tokens is null) =
        (pg_catalog.array_position(incomplete_fields, 'reasoning') is not null)
      and (provider_billable is null) =
        (pg_catalog.array_position(incomplete_fields, 'provider_billable') is not null)
      and (
        pg_catalog.array_position(incomplete_fields, 'estimated_cost') is not null
        and estimated_cost_nanos is null
        or pg_catalog.array_position(incomplete_fields, 'estimated_cost') is null
        and estimated_cost_nanos is not distinct from known_estimated_cost_nanos
      )
      and pg_catalog.cardinality(incomplete_fields) =
        case when pg_catalog.array_position(incomplete_fields, 'attempt_usage') is null then 0 else 1 end
        + case when pg_catalog.array_position(incomplete_fields, 'input_cache_write') is null then 0 else 1 end
        + case when pg_catalog.array_position(incomplete_fields, 'reasoning') is null then 0 else 1 end
        + case when pg_catalog.array_position(incomplete_fields, 'provider_billable') is null then 0 else 1 end
        + case when pg_catalog.array_position(incomplete_fields, 'estimated_cost') is null then 0 else 1 end
    )
  ), false)),
  add constraint ai_request_ledger_cost_check check (coalesce((
    (cost_basis is null or pg_catalog.length(pg_catalog.btrim(cost_basis)) > 0)
    and (billing_currency is null or billing_currency ~ '^[A-Z]{3}$')
    and (known_estimated_cost_nanos is null or known_estimated_cost_nanos >= 0)
    and (known_estimated_cost_nanos is null or billing_currency is not null)
    and (estimated_cost_nanos is null or estimated_cost_nanos >= 0)
    and (
      estimated_cost_nanos is null
      or billing_currency is not null
      and known_estimated_cost_nanos is not null
      and estimated_cost_nanos = known_estimated_cost_nanos
    )
    and (
      provider_reported_currency is null
      and provider_reported_cost_nanos is null
      or provider_reported_currency is not null
      and provider_reported_currency ~ '^[A-Z]{3}$'
      and provider_reported_cost_nanos is not null
      and provider_reported_cost_nanos >= 0
      and billing_currency is not null
      and provider_reported_currency = billing_currency
    )
    and (
      cost_reconciliation_status is null
      or cost_reconciliation_status in (
        'not_available',
        'pending',
        'matched',
        'mismatch',
        'incomplete_usage'
      )
    )
    and (
      cost_reconciliation_status is null
      or case cost_reconciliation_status
        when 'not_available' then
          provider_reported_currency is null
          and provider_reported_cost_nanos is null
          and (
            estimated_cost_nanos is not null
            or usage_schema_version = 'request_usage_aggregate_v2'
            and provider_billable is false
            and known_estimated_cost_nanos is null
            and estimated_cost_nanos is null
            and pg_catalog.array_position(incomplete_fields, 'estimated_cost') is null
          )
        when 'pending' then
          estimated_cost_nanos is not null
          and pg_catalog.array_position(incomplete_fields, 'estimated_cost') is null
          and provider_reported_currency is null
          and provider_reported_cost_nanos is null
        when 'matched' then
          estimated_cost_nanos is not null
          and provider_reported_currency is not null
          and provider_reported_cost_nanos is not null
          and estimated_cost_nanos = provider_reported_cost_nanos
        when 'mismatch' then
          estimated_cost_nanos is not null
          and provider_reported_currency is not null
          and provider_reported_cost_nanos is not null
          and estimated_cost_nanos <> provider_reported_cost_nanos
        when 'incomplete_usage' then
          estimated_cost_nanos is null
          and incomplete_fields is not null
          and pg_catalog.array_position(incomplete_fields, 'estimated_cost') is not null
        else false
      end
    )
  ), false));

alter table public.ai_profile_usage_daily
  drop constraint ai_profile_usage_daily_cost_check,
  add constraint ai_profile_usage_daily_cost_check check (coalesce((
    cost_incomplete_count = 0
    and estimated_cost_nanos is not distinct from known_estimated_cost_nanos
    or cost_incomplete_count > 0
    and estimated_cost_nanos is null
  ), false));

create function public.complete_ai_polish_provider_attempt(
  p_attempt_id uuid,
  p_status text,
  p_provider_billable boolean,
  p_usage jsonb,
  p_route jsonb,
  p_cost jsonb,
  p_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_max_safe_integer constant numeric := 9007199254740991;
  c_max_bigint constant numeric := 9223372036854775807;
  c_max_integer constant numeric := 2147483647;
  v_reservation_id uuid;
  v_request public.ai_request_ledger%rowtype;
  v_attempt public.ai_provider_attempt_ledger%rowtype;
  v_terminal_at timestamptz;
  v_usage_absent boolean;
  v_usage_observation_kind text;
  v_usage_schema_version text;
  v_input_total_tokens bigint;
  v_input_cache_read_tokens bigint;
  v_input_cache_write_tokens bigint;
  v_input_standard_tokens bigint;
  v_output_tokens bigint;
  v_reasoning_tokens bigint;
  v_cache_usage_reporting text;
  v_usage_complete boolean;
  v_gateway_request_id text;
  v_provider_request_id text;
  v_actual_upstream_endpoint text;
  v_actual_model_id text;
  v_router_attempt_count smallint;
  v_estimated_currency text;
  v_estimated_cost_nanos bigint;
  v_provider_reported_currency text;
  v_provider_reported_cost_nanos bigint;
  v_reconciliation_status text;
  v_asserted_reconciliation_status text;
  v_finish_reason text;
  v_failure_stage text;
  v_latency_ms integer;
begin
  -- This lookup intentionally does not lock the child.  The parent request is
  -- the lifecycle serialization point and must always be locked first.
  select attempt.reservation_id into v_reservation_id
  from public.ai_provider_attempt_ledger as attempt
  where attempt.attempt_id = p_attempt_id;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'NOT_FOUND');
  end if;

  select * into v_request
  from public.ai_request_ledger
  where reservation_id = v_reservation_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'NOT_FOUND');
  end if;

  -- Finalization permanently closes the attempt fact channel.  This check is
  -- deliberately before all hostile payload parsing.
  if v_request.state = 'finalized' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'REQUEST_ALREADY_FINALIZED'
    );
  end if;

  if v_request.state is distinct from 'reserved'
     or v_request.route_schema_version is distinct from 'route_snapshot_v1' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'SERVICE_UNAVAILABLE'
    );
  end if;

  select * into v_attempt
  from public.ai_provider_attempt_ledger
  where attempt_id = p_attempt_id
    and reservation_id = v_request.reservation_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'NOT_FOUND');
  end if;

  if p_status is null or p_status not in (
    'succeeded',
    'invalid_output',
    'failed_upstream',
    'timed_out',
    'canceled'
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'INTERNAL_ERROR'
    );
  end if;

  v_usage_absent := p_usage is null or p_usage = 'null'::jsonb;
  if v_usage_absent then
    v_usage_observation_kind := 'unavailable';
    v_usage_schema_version := null;
    v_input_total_tokens := null;
    v_input_cache_read_tokens := null;
    v_input_cache_write_tokens := null;
    v_input_standard_tokens := null;
    v_output_tokens := null;
    v_reasoning_tokens := null;
    v_cache_usage_reporting := null;
    v_usage_complete := false;
  else
    if pg_catalog.jsonb_typeof(p_usage) is distinct from 'object'
       or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_usage)) <> 9
       or not p_usage ?& array[
         'schema_version',
         'input_total_tokens',
         'input_cache_read_tokens',
         'input_cache_write_tokens',
         'input_standard_tokens',
         'output_tokens',
         'reasoning_tokens',
         'cache_usage_reporting',
         'usage_complete'
       ]
       or p_usage ->> 'schema_version' is distinct from 'normalized_usage_v2'
       or pg_catalog.jsonb_typeof(p_usage -> 'input_total_tokens') is distinct from 'number'
       or pg_catalog.jsonb_typeof(p_usage -> 'input_cache_read_tokens') is distinct from 'number'
       or pg_catalog.jsonb_typeof(p_usage -> 'input_standard_tokens') is distinct from 'number'
       or pg_catalog.jsonb_typeof(p_usage -> 'output_tokens') is distinct from 'number'
       or pg_catalog.jsonb_typeof(p_usage -> 'usage_complete') is distinct from 'boolean'
       or pg_catalog.jsonb_typeof(p_usage -> 'cache_usage_reporting') is distinct from 'string'
       or (p_usage ->> 'input_total_tokens') !~ '^(0|[1-9][0-9]*)$'
       or (p_usage ->> 'input_cache_read_tokens') !~ '^(0|[1-9][0-9]*)$'
       or (p_usage ->> 'input_standard_tokens') !~ '^(0|[1-9][0-9]*)$'
       or (p_usage ->> 'output_tokens') !~ '^(0|[1-9][0-9]*)$'
       or (p_usage ->> 'input_total_tokens')::numeric > c_max_safe_integer
       or (p_usage ->> 'input_cache_read_tokens')::numeric > c_max_safe_integer
       or (p_usage ->> 'input_standard_tokens')::numeric > c_max_safe_integer
       or (p_usage ->> 'output_tokens')::numeric > c_max_safe_integer
       or pg_catalog.jsonb_typeof(p_usage -> 'input_cache_write_tokens') not in ('number', 'null')
       or pg_catalog.jsonb_typeof(p_usage -> 'reasoning_tokens') not in ('number', 'null') then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'INTERNAL_ERROR'
      );
    end if;

    if pg_catalog.jsonb_typeof(p_usage -> 'input_cache_write_tokens') = 'number'
       and (
         (p_usage ->> 'input_cache_write_tokens') !~ '^(0|[1-9][0-9]*)$'
         or (p_usage ->> 'input_cache_write_tokens')::numeric > c_max_safe_integer
       ) then
      return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INTERNAL_ERROR');
    end if;

    if pg_catalog.jsonb_typeof(p_usage -> 'reasoning_tokens') = 'number'
       and (
         (p_usage ->> 'reasoning_tokens') !~ '^(0|[1-9][0-9]*)$'
         or (p_usage ->> 'reasoning_tokens')::numeric > c_max_safe_integer
       ) then
      return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INTERNAL_ERROR');
    end if;

    v_usage_observation_kind := 'observed';
    v_usage_schema_version := 'normalized_usage_v2';
    v_input_total_tokens := (p_usage ->> 'input_total_tokens')::bigint;
    v_input_cache_read_tokens := (p_usage ->> 'input_cache_read_tokens')::bigint;
    v_input_cache_write_tokens := case
      when pg_catalog.jsonb_typeof(p_usage -> 'input_cache_write_tokens') = 'null' then null
      else (p_usage ->> 'input_cache_write_tokens')::bigint
    end;
    v_input_standard_tokens := (p_usage ->> 'input_standard_tokens')::bigint;
    v_output_tokens := (p_usage ->> 'output_tokens')::bigint;
    v_reasoning_tokens := case
      when pg_catalog.jsonb_typeof(p_usage -> 'reasoning_tokens') = 'null' then null
      else (p_usage ->> 'reasoning_tokens')::bigint
    end;
    v_cache_usage_reporting := p_usage ->> 'cache_usage_reporting';
    v_usage_complete := (p_usage ->> 'usage_complete')::boolean;

    if v_cache_usage_reporting not in ('reported', 'unavailable', 'not_applicable')
       or v_reasoning_tokens is not null and v_reasoning_tokens > v_output_tokens
       or (case v_cache_usage_reporting
         when 'reported' then
           v_input_cache_write_tokens is null
           or v_input_total_tokens::numeric is distinct from
             v_input_cache_read_tokens::numeric
             + v_input_cache_write_tokens::numeric
             + v_input_standard_tokens::numeric
         when 'unavailable' then
           v_input_cache_write_tokens is not null
           or v_input_total_tokens::numeric is distinct from
             v_input_cache_read_tokens::numeric + v_input_standard_tokens::numeric
         when 'not_applicable' then
           v_input_cache_read_tokens <> 0
           or v_input_cache_write_tokens <> 0
           or v_input_total_tokens <> v_input_standard_tokens
         else true
       end) then
      return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INTERNAL_ERROR');
    end if;
  end if;

  if pg_catalog.jsonb_typeof(p_route) is distinct from 'object'
     or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_route)) <> 6
     or not p_route ?& array[
       'schema_version',
       'gateway_request_id',
       'provider_request_id',
       'actual_upstream_endpoint',
       'actual_model_id',
       'router_attempt_count'
     ]
     or p_route ->> 'schema_version' is distinct from 'route_observation_v1'
     or pg_catalog.jsonb_typeof(p_route -> 'gateway_request_id') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(p_route -> 'provider_request_id') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(p_route -> 'actual_upstream_endpoint') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(p_route -> 'actual_model_id') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(p_route -> 'router_attempt_count') not in ('number', 'null') then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INTERNAL_ERROR');
  end if;

  v_gateway_request_id := p_route ->> 'gateway_request_id';
  v_provider_request_id := p_route ->> 'provider_request_id';
  v_actual_upstream_endpoint := p_route ->> 'actual_upstream_endpoint';
  v_actual_model_id := p_route ->> 'actual_model_id';

  if (v_gateway_request_id is not null and v_gateway_request_id !~ '^hmac-sha256:[0-9a-f]{64}$')
     or (v_provider_request_id is not null and v_provider_request_id !~ '^hmac-sha256:[0-9a-f]{64}$')
     or (v_actual_model_id is not null and v_actual_model_id is distinct from v_request.model_id)
     or (
       pg_catalog.jsonb_typeof(p_route -> 'router_attempt_count') = 'number'
       and (
         (p_route ->> 'router_attempt_count') !~ '^[1-9][0-9]*$'
         or (p_route ->> 'router_attempt_count')::numeric > 100
       )
     ) then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INTERNAL_ERROR');
  end if;

  v_router_attempt_count := case
    when pg_catalog.jsonb_typeof(p_route -> 'router_attempt_count') = 'null' then null
    else (p_route ->> 'router_attempt_count')::smallint
  end;

  if pg_catalog.jsonb_typeof(p_cost) is distinct from 'object'
     or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_cost)) <> 6
     or not p_cost ?& array[
       'schema_version',
       'estimated_currency',
       'estimated_cost_nanos',
       'provider_reported_currency',
       'provider_reported_cost_nanos',
       'reconciliation_status'
     ]
     or p_cost ->> 'schema_version' is distinct from 'cost_observation_v1'
     or pg_catalog.jsonb_typeof(p_cost -> 'estimated_currency') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(p_cost -> 'estimated_cost_nanos') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(p_cost -> 'provider_reported_currency') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(p_cost -> 'provider_reported_cost_nanos') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(p_cost -> 'reconciliation_status') not in ('string', 'null') then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INTERNAL_ERROR');
  end if;

  v_estimated_currency := p_cost ->> 'estimated_currency';
  v_provider_reported_currency := p_cost ->> 'provider_reported_currency';
  v_asserted_reconciliation_status := p_cost ->> 'reconciliation_status';

  if (v_estimated_currency is null) <>
       (pg_catalog.jsonb_typeof(p_cost -> 'estimated_cost_nanos') = 'null')
     or (v_provider_reported_currency is null) <>
       (pg_catalog.jsonb_typeof(p_cost -> 'provider_reported_cost_nanos') = 'null')
     or (
       v_estimated_currency is not null
       and (
         v_estimated_currency is distinct from v_attempt.billing_currency
         or (p_cost ->> 'estimated_cost_nanos') !~ '^(0|[1-9][0-9]*)$'
         or (p_cost ->> 'estimated_cost_nanos')::numeric > c_max_bigint
       )
     )
     or (
       v_provider_reported_currency is not null
       and (
         v_provider_reported_currency is distinct from v_attempt.billing_currency
         or (p_cost ->> 'provider_reported_cost_nanos') !~ '^(0|[1-9][0-9]*)$'
         or (p_cost ->> 'provider_reported_cost_nanos')::numeric > c_max_bigint
       )
     ) then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INTERNAL_ERROR');
  end if;

  v_estimated_cost_nanos := case
    when v_estimated_currency is null then null
    else (p_cost ->> 'estimated_cost_nanos')::bigint
  end;
  v_provider_reported_cost_nanos := case
    when v_provider_reported_currency is null then null
    else (p_cost ->> 'provider_reported_cost_nanos')::bigint
  end;

  if v_usage_absent and v_estimated_cost_nanos is not null then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INTERNAL_ERROR');
  end if;

  if p_provider_billable is false
     and v_provider_reported_cost_nanos is not null
     and v_provider_reported_cost_nanos <> 0 then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INTERNAL_ERROR');
  end if;

  v_reconciliation_status := case
    when v_estimated_cost_nanos is null then 'incomplete_usage'
    when v_provider_reported_cost_nanos is null then 'not_available'
    when v_estimated_cost_nanos = v_provider_reported_cost_nanos then 'matched'
    else 'mismatch'
  end;

  if v_asserted_reconciliation_status is not null
     and v_asserted_reconciliation_status is distinct from v_reconciliation_status then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INTERNAL_ERROR');
  end if;

  if pg_catalog.jsonb_typeof(p_metadata) is distinct from 'object'
     or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_metadata)) <> 4
     or not p_metadata ?& array[
       'schema_version',
       'finish_reason',
       'failure_stage',
       'latency_ms'
     ]
     or p_metadata ->> 'schema_version' is distinct from 'attempt_metadata_v1'
     or pg_catalog.jsonb_typeof(p_metadata -> 'finish_reason') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(p_metadata -> 'failure_stage') not in ('string', 'null')
     or pg_catalog.jsonb_typeof(p_metadata -> 'latency_ms') is distinct from 'number'
     or (p_metadata ->> 'latency_ms') !~ '^(0|[1-9][0-9]*)$'
     or (p_metadata ->> 'latency_ms')::numeric > c_max_integer then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INTERNAL_ERROR');
  end if;

  v_finish_reason := p_metadata ->> 'finish_reason';
  v_failure_stage := p_metadata ->> 'failure_stage';
  v_latency_ms := (p_metadata ->> 'latency_ms')::integer;

  if (v_finish_reason is not null and v_finish_reason not in (
       'stop', 'length', 'content_filter', 'insufficient_system_resource', 'unknown'
     ))
     or (v_failure_stage is not null and v_failure_stage !~ '^[a-z][a-z0-9_]{0,63}$') then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INTERNAL_ERROR');
  end if;

  if v_attempt.status <> 'started' then
    if (
      v_attempt.status,
      v_attempt.provider_billable,
      v_attempt.usage_observation_kind,
      v_attempt.usage_schema_version,
      v_attempt.input_total_tokens,
      v_attempt.input_cache_read_tokens,
      v_attempt.input_cache_write_tokens,
      v_attempt.input_standard_tokens,
      v_attempt.output_tokens,
      v_attempt.reasoning_tokens,
      v_attempt.cache_usage_reporting,
      v_attempt.usage_complete,
      v_attempt.route_observation_schema_version,
      v_attempt.gateway_request_id,
      v_attempt.provider_request_id,
      v_attempt.actual_upstream_endpoint,
      v_attempt.actual_model_id,
      v_attempt.router_attempt_count,
      v_attempt.cost_observation_schema_version,
      v_attempt.estimated_currency,
      v_attempt.estimated_cost_nanos,
      v_attempt.provider_reported_currency,
      v_attempt.provider_reported_cost_nanos,
      v_attempt.cost_reconciliation_status,
      v_attempt.finish_reason,
      v_attempt.failure_stage,
      v_attempt.latency_ms
    ) is distinct from (
      p_status,
      p_provider_billable,
      v_usage_observation_kind,
      v_usage_schema_version,
      v_input_total_tokens,
      v_input_cache_read_tokens,
      v_input_cache_write_tokens,
      v_input_standard_tokens,
      v_output_tokens,
      v_reasoning_tokens,
      v_cache_usage_reporting,
      v_usage_complete,
      'route_observation_v1'::text,
      v_gateway_request_id,
      v_provider_request_id,
      v_actual_upstream_endpoint,
      v_actual_model_id,
      v_router_attempt_count,
      'cost_observation_v1'::text,
      v_estimated_currency,
      v_estimated_cost_nanos,
      v_provider_reported_currency,
      v_provider_reported_cost_nanos,
      v_reconciliation_status,
      v_finish_reason,
      v_failure_stage,
      v_latency_ms
    ) then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'ATTEMPT_COMPLETION_CONFLICT'
      );
    end if;

    return pg_catalog.jsonb_build_object(
      'ok', true,
      'alreadyCompleted', true,
      'status', v_attempt.status,
      'usageComplete', v_attempt.usage_complete
    );
  end if;

  v_terminal_at := pg_catalog.clock_timestamp();
  if v_terminal_at < v_attempt.started_at then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'SERVICE_UNAVAILABLE'
    );
  end if;

  begin
    update public.ai_provider_attempt_ledger
    set status = p_status,
        terminal_at = v_terminal_at,
        provider_billable = p_provider_billable,
        usage_observation_kind = v_usage_observation_kind,
        usage_schema_version = v_usage_schema_version,
        input_total_tokens = v_input_total_tokens,
        input_cache_read_tokens = v_input_cache_read_tokens,
        input_cache_write_tokens = v_input_cache_write_tokens,
        input_standard_tokens = v_input_standard_tokens,
        output_tokens = v_output_tokens,
        reasoning_tokens = v_reasoning_tokens,
        cache_usage_reporting = v_cache_usage_reporting,
        usage_complete = v_usage_complete,
        route_observation_schema_version = 'route_observation_v1',
        gateway_request_id = v_gateway_request_id,
        provider_request_id = v_provider_request_id,
        actual_upstream_endpoint = v_actual_upstream_endpoint,
        actual_model_id = v_actual_model_id,
        router_attempt_count = v_router_attempt_count,
        cost_observation_schema_version = 'cost_observation_v1',
        estimated_currency = v_estimated_currency,
        estimated_cost_nanos = v_estimated_cost_nanos,
        provider_reported_currency = v_provider_reported_currency,
        provider_reported_cost_nanos = v_provider_reported_cost_nanos,
        cost_reconciliation_status = v_reconciliation_status,
        finish_reason = v_finish_reason,
        failure_stage = v_failure_stage,
        latency_ms = v_latency_ms
    where attempt_id = p_attempt_id;
  exception
    when others then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'SERVICE_UNAVAILABLE'
      );
  end;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'alreadyCompleted', false,
    'status', p_status,
    'usageComplete', v_usage_complete
  );
end;
$$;

revoke all on function public.complete_ai_polish_provider_attempt(
  uuid, text, boolean, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.complete_ai_polish_provider_attempt(
  uuid, text, boolean, jsonb, jsonb, jsonb, jsonb
) to service_role;

create or replace function public.finalize_ai_polish_request(
  p_reservation_id uuid,
  p_status text,
  p_quota_charged boolean,
  p_provider_billable boolean default null,
  p_usage jsonb default null,
  p_metadata jsonb default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c_daily_limit constant integer := 20;
  c_max_bigint constant numeric := 9223372036854775807;
  c_max_integer constant numeric := 2147483647;
  v_row public.ai_request_ledger%rowtype;
  v_attempt public.ai_provider_attempt_ledger%rowtype;
  v_last_attempt public.ai_provider_attempt_ledger%rowtype;
  v_price public.ai_price_versions%rowtype;
  v_profile record;
  v_user_today public.ai_usage_daily%rowtype;
  v_user_quota public.ai_usage_daily%rowtype;
  v_global_daily public.ai_global_usage_daily%rowtype;
  v_profile_daily public.ai_profile_usage_daily%rowtype;
  v_now timestamptz;
  v_today date;
  v_reset_at timestamptz;
  v_quota_day date;
  v_today_count integer;
  v_quota jsonb;
  v_finalize_owner_oid oid;
  v_current_user_oid oid;
  v_owner_call boolean := false;
  v_metadata_object jsonb;
  v_source text;
  v_usage_absent boolean;
  v_child_count integer := 0;
  v_attempt_nos smallint[] := array[]::smallint[];
  v_currency text;
  v_sum_input_total numeric := 0;
  v_sum_cache_read numeric := 0;
  v_sum_cache_write numeric := 0;
  v_sum_input_standard numeric := 0;
  v_sum_output numeric := 0;
  v_sum_reasoning numeric := 0;
  v_all_usage_complete boolean := true;
  v_all_cache_write_known boolean := true;
  v_all_reasoning_known boolean := true;
  v_all_cache_not_applicable boolean := true;
  v_any_cache_reported boolean := false;
  v_any_billable_true boolean := false;
  v_all_billable_false boolean := true;
  v_known_estimated_sum numeric := 0;
  v_known_estimated_count integer := 0;
  v_estimated_incomplete boolean := false;
  v_provider_applicable_count integer := 0;
  v_provider_reported_count integer := 0;
  v_provider_reported_sum numeric := 0;
  v_input_total bigint;
  v_cache_read bigint;
  v_cache_write bigint;
  v_input_standard bigint;
  v_output bigint;
  v_reasoning bigint;
  v_cache_reporting text;
  v_request_usage_complete boolean;
  v_derived_billable boolean;
  v_incomplete_fields text[] := array[]::text[];
  v_known_estimated bigint;
  v_estimated bigint;
  v_provider_reported bigint;
  v_reconciliation text;
  v_legacy_cached bigint;
  v_legacy_uncached bigint;
  v_legacy_output bigint;
  v_provider_report_incomplete_increment integer := 0;
  v_usage_incomplete_increment integer := 0;
  v_cost_incomplete_increment integer := 0;
  v_user_new_cached numeric;
  v_user_new_uncached numeric;
  v_user_new_output numeric;
  v_global_new_cached numeric;
  v_global_new_uncached numeric;
  v_global_new_output numeric;
  v_profile_new_request_count numeric;
  v_profile_new_usage_incomplete_count numeric;
  v_profile_new_cost_incomplete_count numeric;
  v_profile_new_provider_incomplete_count numeric;
  v_profile_new_input_total numeric;
  v_profile_new_cache_read numeric;
  v_profile_new_cache_write numeric;
  v_profile_new_input_standard numeric;
  v_profile_new_output numeric;
  v_profile_new_reasoning numeric;
  v_profile_new_known_estimated numeric;
  v_profile_new_estimated numeric;
  v_profile_new_provider_reported numeric;
  v_cached bigint;
  v_uncached bigint;
  v_v1_output bigint;
  v_v1_usage_complete boolean;
begin
  select * into v_row
  from public.ai_request_ledger
  where reservation_id = p_reservation_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'NOT_FOUND');
  end if;

  -- Genuine V1 retains the legacy transaction-stable clock for quota-day,
  -- finalized_at and replay readback. V2 keeps the DB-010 wall-clock behavior.
  v_now := case
    when v_row.route_schema_version is null then pg_catalog.transaction_timestamp()
    else pg_catalog.clock_timestamp()
  end;
  v_today := (v_now at time zone 'utc')::date;
  v_reset_at := ((v_today + 1) at time zone 'utc');
  v_quota_day := (v_row.reserved_at at time zone 'utc')::date;

  select request_count into v_today_count
  from public.ai_usage_daily
  where user_id = v_row.user_id
    and day = v_today;
  v_quota := pg_catalog.jsonb_build_object(
    'limit', c_daily_limit,
    'remaining', c_daily_limit - coalesce(v_today_count, 0),
    'resetAt', v_reset_at
  );

  -- Frozen readback has absolute precedence over every hostile caller field.
  if v_row.state = 'finalized' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'alreadyFinalized', true,
      'status', v_row.status,
      'quotaCharged', v_row.quota_charged,
      'quota', v_quota
    );
  end if;

  select finalize_proc.proowner, role_row.oid
  into v_finalize_owner_oid, v_current_user_oid
  from pg_catalog.pg_proc as finalize_proc
  join pg_catalog.pg_roles as role_row
    on role_row.rolname = current_user
  where finalize_proc.oid =
    'public.finalize_ai_polish_request(uuid,text,boolean,boolean,jsonb,jsonb)'::pg_catalog.regprocedure;
  v_owner_call := v_current_user_oid is not null
    and v_current_user_oid = v_finalize_owner_oid;

  if p_status = 'abandoned' and not v_owner_call then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INVALID_STATUS');
  end if;

  -- Genuine V1 requests retain the legacy parser, metadata and response.
  if v_row.route_schema_version is null then
    -- Preserve the legacy SQL three-valued NULL behavior: a NULL status is
    -- allowed to reach the original DML constraints and surface as a DB error.
    if p_status not in (
      'succeeded',
      'canceled',
      'failed_upstream',
      'invalid_output',
      'released'
    ) then
      return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INVALID_STATUS');
    end if;

    perform 1
    from public.ai_provider_attempt_ledger
    where reservation_id = p_reservation_id
    order by attempt_no
    for update;
    if found then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'SERVICE_UNAVAILABLE'
      );
    end if;

    v_cached := coalesce((p_usage ->> 'input_cached_tokens')::bigint, 0);
    v_uncached := coalesce((p_usage ->> 'input_uncached_tokens')::bigint, 0);
    v_v1_output := coalesce((p_usage ->> 'output_tokens')::bigint, 0);
    v_v1_usage_complete := coalesce(
      (p_usage ->> 'usage_complete')::boolean,
      false
    );

    update public.ai_request_ledger
      set state = 'finalized',
          status = p_status,
          quota_charged = p_quota_charged,
          provider_billable = p_provider_billable,
          finalized_at = v_now,
          input_cached_tokens = case when p_usage is null then null else v_cached end,
          input_uncached_tokens = case when p_usage is null then null else v_uncached end,
          output_tokens = case when p_usage is null then null else v_v1_output end,
          usage_complete = v_v1_usage_complete,
          granularity = coalesce(p_metadata ->> 'granularity', granularity),
          item_count = coalesce((p_metadata ->> 'item_count')::integer, item_count),
          context_level = coalesce((p_metadata ->> 'context_level')::smallint, context_level),
          language = coalesce(p_metadata ->> 'language', language),
          model = coalesce(p_metadata ->> 'model', model),
          prompt_version = coalesce(p_metadata ->> 'prompt_version', prompt_version),
          validator_version = coalesce(p_metadata ->> 'validator_version', validator_version),
          attempt_count = coalesce((p_metadata ->> 'attempt_count')::integer, attempt_count),
          provider_request_id = coalesce(
            p_metadata ->> 'provider_request_id',
            provider_request_id
          ),
          finish_reason = coalesce(p_metadata ->> 'finish_reason', finish_reason),
          failure_stage = coalesce(p_metadata ->> 'failure_stage', failure_stage),
          latency_ms = coalesce((p_metadata ->> 'latency_ms')::integer, latency_ms)
      where reservation_id = p_reservation_id;

    if not p_quota_charged then
      update public.ai_usage_daily
      set request_count = greatest(0, request_count - 1)
      where user_id = v_row.user_id
        and day = v_quota_day;
    end if;

    if p_usage is not null then
      insert into public.ai_usage_daily (
          user_id,
          day,
          request_count,
          input_cached_tokens,
          input_uncached_tokens,
          output_tokens
        ) values (
          v_row.user_id,
          v_today,
          0,
          v_cached,
          v_uncached,
          v_v1_output
        )
      on conflict (user_id, day) do update
      set input_cached_tokens =
            ai_usage_daily.input_cached_tokens + excluded.input_cached_tokens,
          input_uncached_tokens =
            ai_usage_daily.input_uncached_tokens + excluded.input_uncached_tokens,
          output_tokens =
            ai_usage_daily.output_tokens + excluded.output_tokens;

      insert into public.ai_global_usage_daily (
          day,
          input_cached_tokens,
          input_uncached_tokens,
          output_tokens
        ) values (v_today, v_cached, v_uncached, v_v1_output)
      on conflict (day) do update
      set input_cached_tokens =
            ai_global_usage_daily.input_cached_tokens + excluded.input_cached_tokens,
          input_uncached_tokens =
            ai_global_usage_daily.input_uncached_tokens + excluded.input_uncached_tokens,
          output_tokens =
            ai_global_usage_daily.output_tokens + excluded.output_tokens;
    end if;

    select request_count into v_today_count
    from public.ai_usage_daily
    where user_id = v_row.user_id
      and day = v_today;
    v_quota := pg_catalog.jsonb_build_object(
      'limit', c_daily_limit,
      'remaining', c_daily_limit - coalesce(v_today_count, 0),
      'resetAt', v_reset_at
    );
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'alreadyFinalized', false,
      'status', p_status,
      'quotaCharged', p_quota_charged,
      'quota', v_quota
    );
  end if;

  if p_status is null or p_status not in (
    'succeeded',
    'canceled',
    'failed_upstream',
    'invalid_output',
    'released',
    'abandoned'
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INVALID_STATUS');
  end if;

  -- Unfinished rows outside the genuine V1 or exact V2 route domains are not
  -- eligible for a first settlement.
  if v_row.route_schema_version is distinct from 'route_snapshot_v1'
     or v_row.state is distinct from 'reserved' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'SERVICE_UNAVAILABLE'
    );
  end if;

  v_usage_absent := p_usage is null or p_usage = 'null'::jsonb;
  if p_metadata is null or p_metadata = 'null'::jsonb then
    v_metadata_object := '{}'::jsonb;
  elsif pg_catalog.jsonb_typeof(p_metadata) = 'object' then
    v_metadata_object := p_metadata;
  else
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INTERNAL_ERROR');
  end if;

  if not v_metadata_object ? 'usage_schema_version'
     or pg_catalog.jsonb_typeof(v_metadata_object -> 'usage_schema_version') = 'null' then
    v_source := 'legacy_v1';
  elsif pg_catalog.jsonb_typeof(v_metadata_object -> 'usage_schema_version') = 'string'
        and v_metadata_object ->> 'usage_schema_version' in ('legacy_v1', 'attempt_v2') then
    v_source := v_metadata_object ->> 'usage_schema_version';
  else
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INTERNAL_ERROR');
  end if;

  if v_source = 'attempt_v2' and not v_usage_absent then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'AMBIGUOUS_USAGE_SOURCE'
    );
  end if;

  for v_attempt in
    select *
    from public.ai_provider_attempt_ledger
    where reservation_id = p_reservation_id
    order by attempt_no
    for update
  loop
    v_child_count := v_child_count + 1;
    v_attempt_nos := pg_catalog.array_append(v_attempt_nos, v_attempt.attempt_no);
    v_last_attempt := v_attempt;

    if v_attempt.status = 'started' then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'ATTEMPT_IN_PROGRESS'
      );
    end if;

    if v_attempt.status not in (
      'succeeded',
      'invalid_output',
      'failed_upstream',
      'timed_out',
      'canceled',
      'unknown'
    ) then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'SERVICE_UNAVAILABLE'
      );
    end if;

    if (
      v_attempt.route_schema_version,
      v_attempt.config_generation,
      v_attempt.routing_policy_version_id,
      v_attempt.profile_version_id,
      v_attempt.price_version_id,
      v_attempt.legal_bundle_version,
      v_attempt.runtime_contract_id,
      v_attempt.runtime_contract_sha256,
      v_attempt.gateway_kind,
      v_attempt.model_id,
      v_attempt.wire_api_kind,
      v_attempt.display_disclosure_key
    ) is distinct from (
      v_row.route_schema_version,
      v_row.config_generation,
      v_row.routing_policy_version_id,
      v_row.profile_version_id,
      v_row.price_version_id,
      v_row.legal_bundle_version,
      v_row.runtime_contract_id,
      v_row.runtime_contract_sha256,
      v_row.gateway_kind,
      v_row.model_id,
      v_row.wire_api_kind,
      v_row.display_disclosure_key
    ) then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'SERVICE_UNAVAILABLE'
      );
    end if;

    if v_currency is null then
      v_currency := v_attempt.billing_currency;
    elsif v_currency is distinct from v_attempt.billing_currency then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'SERVICE_UNAVAILABLE'
      );
    end if;

    if v_attempt.usage_observation_kind = 'observed' then
      if v_attempt.input_total_tokens is null
         or v_attempt.input_cache_read_tokens is null
         or v_attempt.input_standard_tokens is null
         or v_attempt.output_tokens is null then
        return pg_catalog.jsonb_build_object(
          'ok', false,
          'reason', 'SERVICE_UNAVAILABLE'
        );
      end if;
      v_sum_input_total := v_sum_input_total + v_attempt.input_total_tokens::numeric;
      v_sum_cache_read := v_sum_cache_read + v_attempt.input_cache_read_tokens::numeric;
      v_sum_input_standard := v_sum_input_standard + v_attempt.input_standard_tokens::numeric;
      v_sum_output := v_sum_output + v_attempt.output_tokens::numeric;
      v_all_usage_complete := v_all_usage_complete
        and v_attempt.usage_complete is true;

      if v_attempt.input_cache_write_tokens is null then
        v_all_cache_write_known := false;
      else
        v_sum_cache_write := v_sum_cache_write
          + v_attempt.input_cache_write_tokens::numeric;
      end if;

      if v_attempt.reasoning_tokens is null then
        v_all_reasoning_known := false;
      else
        v_sum_reasoning := v_sum_reasoning + v_attempt.reasoning_tokens::numeric;
      end if;

      v_all_cache_not_applicable := v_all_cache_not_applicable
        and v_attempt.cache_usage_reporting = 'not_applicable';
      v_any_cache_reported := v_any_cache_reported
        or v_attempt.cache_usage_reporting = 'reported';
    elsif v_attempt.usage_observation_kind = 'unavailable' then
      v_all_usage_complete := false;
      v_all_cache_write_known := false;
      v_all_reasoning_known := false;
      v_all_cache_not_applicable := false;
    else
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'SERVICE_UNAVAILABLE'
      );
    end if;

    v_any_billable_true := v_any_billable_true
      or v_attempt.provider_billable is true;
    v_all_billable_false := v_all_billable_false
      and v_attempt.provider_billable is false;

    if v_attempt.estimated_cost_nanos is not null then
      if v_attempt.estimated_currency is distinct from v_currency then
        return pg_catalog.jsonb_build_object(
          'ok', false,
          'reason', 'SERVICE_UNAVAILABLE'
        );
      end if;
      v_known_estimated_sum := v_known_estimated_sum
        + v_attempt.estimated_cost_nanos::numeric;
      v_known_estimated_count := v_known_estimated_count + 1;
    elsif v_attempt.estimated_currency is not null then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'SERVICE_UNAVAILABLE'
      );
    end if;

    if v_attempt.provider_billable is distinct from false
       and v_attempt.estimated_cost_nanos is null then
      v_estimated_incomplete := true;
    end if;

    if v_attempt.provider_billable is false then
      if v_attempt.provider_reported_cost_nanos is not null
         and (
           v_attempt.provider_reported_currency is distinct from v_currency
           or v_attempt.provider_reported_cost_nanos <> 0
         ) then
        return pg_catalog.jsonb_build_object(
          'ok', false,
          'reason', 'SERVICE_UNAVAILABLE'
        );
      end if;
    else
      v_provider_applicable_count := v_provider_applicable_count + 1;
      if v_attempt.provider_reported_cost_nanos is not null then
        if v_attempt.provider_reported_currency is distinct from v_currency then
          return pg_catalog.jsonb_build_object(
            'ok', false,
            'reason', 'SERVICE_UNAVAILABLE'
          );
        end if;
        v_provider_reported_count := v_provider_reported_count + 1;
        v_provider_reported_sum := v_provider_reported_sum
          + v_attempt.provider_reported_cost_nanos::numeric;
      elsif v_attempt.provider_reported_currency is not null then
        return pg_catalog.jsonb_build_object(
          'ok', false,
          'reason', 'SERVICE_UNAVAILABLE'
        );
      end if;
    end if;

    if v_attempt.cost_reconciliation_status is distinct from (case
      when v_attempt.estimated_cost_nanos is null then 'incomplete_usage'
      when v_attempt.provider_reported_cost_nanos is null then 'not_available'
      when v_attempt.estimated_cost_nanos = v_attempt.provider_reported_cost_nanos then 'matched'
      else 'mismatch'
    end) then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'SERVICE_UNAVAILABLE'
      );
    end if;
  end loop;

  if v_child_count = 0 then
    if p_status = 'abandoned' then
      return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INVALID_STATUS');
    end if;
    if v_source = 'attempt_v2' then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'NO_PROVIDER_ATTEMPTS'
      );
    end if;
    if v_row.state is distinct from 'reserved'
       or v_row.attempt_count <> 0
       or v_row.provider_started_at is not null then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'SERVICE_UNAVAILABLE'
      );
    end if;
    if p_status is distinct from 'released'
       or p_quota_charged is distinct from false
       or p_provider_billable is distinct from false
       or not v_usage_absent then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'INTERNAL_ERROR'
      );
    end if;

    begin
      insert into public.ai_usage_daily (user_id, day)
      values (v_row.user_id, v_quota_day)
      on conflict do nothing;

      select * into v_user_quota
      from public.ai_usage_daily
      where user_id = v_row.user_id
        and day = v_quota_day
      for update;

      if v_user_quota.request_count <= 0 then
        raise exception 'V2 zero-attempt refund underflow'
          using errcode = '22003';
      end if;

      update public.ai_request_ledger
      set state = 'finalized',
          status = 'released',
          quota_charged = false,
          provider_billable = false,
          usage_complete = false,
          finalized_at = v_now,
          attempt_count = 0
      where reservation_id = p_reservation_id;

      update public.ai_usage_daily
      set request_count = request_count - 1
      where user_id = v_row.user_id
        and day = v_quota_day;
    exception
      when others then
        return pg_catalog.jsonb_build_object(
          'ok', false,
          'reason', 'SERVICE_UNAVAILABLE'
        );
    end;

    select request_count into v_today_count
    from public.ai_usage_daily
    where user_id = v_row.user_id
      and day = v_today;
    v_quota := pg_catalog.jsonb_build_object(
      'limit', c_daily_limit,
      'remaining', c_daily_limit - coalesce(v_today_count, 0),
      'resetAt', v_reset_at
    );
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'alreadyFinalized', false,
      'status', 'released',
      'quotaCharged', false,
      'quota', v_quota
    );
  end if;

  if v_source <> 'attempt_v2' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'ATTEMPT_USAGE_SOURCE_REQUIRED'
    );
  end if;
  if not v_usage_absent then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'AMBIGUOUS_USAGE_SOURCE'
    );
  end if;

  -- These values are caller input on attempt_v2. Validate every cast
  -- mechanically before aggregation can enter the daily settlement block.
  if p_quota_charged is null
     or (
       v_metadata_object ? 'item_count'
       and pg_catalog.jsonb_typeof(v_metadata_object -> 'item_count') <> 'null'
       and case
         when pg_catalog.jsonb_typeof(v_metadata_object -> 'item_count')
           is distinct from 'number' then true
         when (v_metadata_object ->> 'item_count')
           !~ '^(0|[1-9][0-9]*)$' then true
         else (v_metadata_object ->> 'item_count')::numeric > c_max_integer
       end
     )
     or (
       v_metadata_object ? 'context_level'
       and pg_catalog.jsonb_typeof(v_metadata_object -> 'context_level') <> 'null'
       and (
         pg_catalog.jsonb_typeof(v_metadata_object -> 'context_level')
           is distinct from 'number'
         or v_metadata_object ->> 'context_level' not in ('0', '1', '2')
       )
     ) then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INTERNAL_ERROR');
  end if;
  if v_row.attempt_count is distinct from v_child_count
     or v_attempt_nos not in (
       array[1]::smallint[],
       array[1, 2]::smallint[]
     )
     or v_row.provider_started_at is not null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'SERVICE_UNAVAILABLE'
    );
  end if;
  if p_status = 'abandoned' and (
       not v_owner_call
       or p_quota_charged is distinct from false
     ) then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INVALID_STATUS');
  end if;

  select
    version.adapter_kind,
    version.credential_alias,
    version.endpoint_alias,
    version.capability_contract_id,
    version.cache_policy_id,
    version.legal_manifest_id,
    version.model_id,
    version.wire_api_kind,
    version.display_disclosure_key,
    profile.gateway_kind
  into v_profile
  from public.ai_provider_profile_versions as version
  join public.ai_provider_profiles as profile
    on profile.id = version.profile_id
  where version.id = v_row.profile_version_id;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'SERVICE_UNAVAILABLE'
    );
  end if;

  select * into v_price
  from public.ai_price_versions
  where id = v_row.price_version_id
    and profile_version_id = v_row.profile_version_id;
  if not found
     or v_price.components_sealed_at is null
     or v_price.currency is distinct from v_currency then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'SERVICE_UNAVAILABLE'
    );
  end if;

  for v_attempt in
    select *
    from public.ai_provider_attempt_ledger
    where reservation_id = p_reservation_id
    order by attempt_no
  loop
    if (
      v_attempt.adapter_kind,
      v_attempt.credential_alias,
      v_attempt.endpoint_alias,
      v_attempt.capability_contract_id,
      v_attempt.cache_policy_id,
      v_attempt.legal_manifest_id,
      v_attempt.model_id,
      v_attempt.wire_api_kind,
      v_attempt.gateway_kind,
      v_attempt.calculator_kind,
      v_attempt.billing_currency
    ) is distinct from (
      v_profile.adapter_kind,
      v_profile.credential_alias,
      v_profile.endpoint_alias,
      v_profile.capability_contract_id,
      v_profile.cache_policy_id,
      v_profile.legal_manifest_id,
      v_profile.model_id,
      v_profile.wire_api_kind,
      v_profile.gateway_kind,
      v_price.calculator_kind,
      v_price.currency
    ) then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'SERVICE_UNAVAILABLE'
      );
    end if;
  end loop;

  if v_sum_input_total > c_max_bigint
     or v_sum_cache_read > c_max_bigint
     or v_sum_input_standard > c_max_bigint
     or v_sum_output > c_max_bigint
     or v_sum_cache_write > c_max_bigint
     or v_sum_reasoning > c_max_bigint
     or v_known_estimated_sum > c_max_bigint
     or v_provider_reported_sum > c_max_bigint
     or v_sum_input_total < v_sum_cache_read then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'SERVICE_UNAVAILABLE'
    );
  end if;

  v_input_total := v_sum_input_total::bigint;
  v_cache_read := v_sum_cache_read::bigint;
  v_input_standard := v_sum_input_standard::bigint;
  v_output := v_sum_output::bigint;
  v_cache_write := case
    when v_all_cache_write_known then v_sum_cache_write::bigint
    else null
  end;
  v_reasoning := case
    when v_all_reasoning_known then v_sum_reasoning::bigint
    else null
  end;
  v_request_usage_complete := v_all_usage_complete;
  v_cache_reporting := case
    when v_all_cache_not_applicable then 'not_applicable'
    when v_all_cache_write_known and v_any_cache_reported then 'reported'
    else 'unavailable'
  end;
  v_derived_billable := case
    when v_any_billable_true then true
    when v_all_billable_false then false
    else null
  end;

  if p_provider_billable is distinct from v_derived_billable then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INTERNAL_ERROR');
  end if;

  if not v_request_usage_complete then
    v_incomplete_fields := pg_catalog.array_append(
      v_incomplete_fields,
      'attempt_usage'
    );
  end if;
  if v_cache_write is null then
    v_incomplete_fields := pg_catalog.array_append(
      v_incomplete_fields,
      'input_cache_write'
    );
  end if;
  if v_reasoning is null then
    v_incomplete_fields := pg_catalog.array_append(
      v_incomplete_fields,
      'reasoning'
    );
  end if;
  if v_derived_billable is null then
    v_incomplete_fields := pg_catalog.array_append(
      v_incomplete_fields,
      'provider_billable'
    );
  end if;
  if v_estimated_incomplete then
    v_incomplete_fields := pg_catalog.array_append(
      v_incomplete_fields,
      'estimated_cost'
    );
  end if;

  v_known_estimated := case
    when v_known_estimated_count = 0 then null
    else v_known_estimated_sum::bigint
  end;
  v_estimated := case
    when v_estimated_incomplete then null
    else v_known_estimated
  end;

  if v_provider_applicable_count = 0 then
    v_provider_reported := null;
  elsif v_provider_reported_count = v_provider_applicable_count then
    v_provider_reported := v_provider_reported_sum::bigint;
  else
    v_provider_reported := null;
  end if;

  v_reconciliation := case
    when v_estimated_incomplete then 'incomplete_usage'
    when v_provider_applicable_count = 0 then 'not_available'
    when v_provider_reported_count = v_provider_applicable_count then
      case when v_estimated = v_provider_reported then 'matched' else 'mismatch' end
    when v_provider_reported_count > 0 then 'pending'
    else 'not_available'
  end;

  v_legacy_cached := v_cache_read;
  v_legacy_uncached := (v_sum_input_total - v_sum_cache_read)::bigint;
  v_legacy_output := v_output;
  v_usage_incomplete_increment := case
    when v_request_usage_complete then 0 else 1
  end;
  v_cost_incomplete_increment := case
    when v_estimated_incomplete then 1 else 0
  end;
  v_provider_report_incomplete_increment := case
    when v_provider_applicable_count > 0 and v_provider_reported is null then 1
    else 0
  end;

  if v_cache_reporting = 'reported' and
       v_input_total::numeric is distinct from
         v_cache_read::numeric + v_cache_write::numeric + v_input_standard::numeric
     or v_cache_reporting = 'not_applicable' and (
       v_cache_read <> 0
       or v_cache_write <> 0
       or v_input_total <> v_input_standard
     )
     or v_cache_reporting = 'unavailable' and (
       v_cache_write is not null
       or v_input_total::numeric < v_cache_read::numeric + v_input_standard::numeric
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'SERVICE_UNAVAILABLE'
    );
  end if;

  begin
    insert into public.ai_usage_daily (user_id, day)
    select v_row.user_id, locked_day.day
    from (
      select distinct candidate_day as day
      from pg_catalog.unnest(array[v_quota_day, v_today]) as candidate_day
      order by candidate_day
    ) as locked_day
    on conflict do nothing;

    perform 1
    from public.ai_usage_daily
    where user_id = v_row.user_id
      and day = any(array[v_quota_day, v_today])
    order by day
    for update;

    select * into v_user_today
    from public.ai_usage_daily
    where user_id = v_row.user_id
      and day = v_today;
    select * into v_user_quota
    from public.ai_usage_daily
    where user_id = v_row.user_id
      and day = v_quota_day;

    insert into public.ai_profile_usage_daily (
      day,
      profile_version_id,
      billing_currency,
      input_cache_write_tokens,
      reasoning_tokens,
      estimated_cost_nanos
    ) values (
      v_today,
      v_row.profile_version_id,
      v_currency,
      0,
      0,
      0
    ) on conflict do nothing;
    select * into v_profile_daily
    from public.ai_profile_usage_daily
    where day = v_today
      and profile_version_id = v_row.profile_version_id
      and billing_currency = v_currency
    for update;

    insert into public.ai_global_usage_daily (day)
    values (v_today)
    on conflict do nothing;
    select * into v_global_daily
    from public.ai_global_usage_daily
    where day = v_today
    for update;

    if not p_quota_charged and v_user_quota.request_count <= 0 then
      raise exception 'V2 refund underflow' using errcode = '22003';
    end if;

    v_user_new_cached := v_user_today.input_cached_tokens::numeric + v_legacy_cached::numeric;
    v_user_new_uncached := v_user_today.input_uncached_tokens::numeric + v_legacy_uncached::numeric;
    v_user_new_output := v_user_today.output_tokens::numeric + v_legacy_output::numeric;
    v_global_new_cached := v_global_daily.input_cached_tokens::numeric + v_legacy_cached::numeric;
    v_global_new_uncached := v_global_daily.input_uncached_tokens::numeric + v_legacy_uncached::numeric;
    v_global_new_output := v_global_daily.output_tokens::numeric + v_legacy_output::numeric;

    v_profile_new_request_count := v_profile_daily.request_count::numeric + 1;
    v_profile_new_usage_incomplete_count :=
      v_profile_daily.usage_incomplete_count::numeric + v_usage_incomplete_increment;
    v_profile_new_cost_incomplete_count :=
      v_profile_daily.cost_incomplete_count::numeric + v_cost_incomplete_increment;
    v_profile_new_provider_incomplete_count :=
      v_profile_daily.provider_report_incomplete_count::numeric
      + v_provider_report_incomplete_increment;
    v_profile_new_input_total :=
      v_profile_daily.input_total_tokens::numeric + v_input_total::numeric;
    v_profile_new_cache_read :=
      v_profile_daily.input_cache_read_tokens::numeric + v_cache_read::numeric;
    v_profile_new_input_standard :=
      v_profile_daily.input_standard_tokens::numeric + v_input_standard::numeric;
    v_profile_new_output :=
      v_profile_daily.output_tokens::numeric + v_output::numeric;
    v_profile_new_cache_write := case
      when v_profile_daily.input_cache_write_tokens is null or v_cache_write is null then null
      else v_profile_daily.input_cache_write_tokens::numeric + v_cache_write::numeric
    end;
    v_profile_new_reasoning := case
      when v_profile_daily.reasoning_tokens is null or v_reasoning is null then null
      else v_profile_daily.reasoning_tokens::numeric + v_reasoning::numeric
    end;
    v_profile_new_known_estimated :=
      v_profile_daily.known_estimated_cost_nanos::numeric
      + coalesce(v_known_estimated, 0)::numeric;
    v_profile_new_estimated := case
      when v_profile_new_cost_incomplete_count = 0 then v_profile_new_known_estimated
      else null
    end;
    v_profile_new_provider_reported := case
      when v_provider_reported is null then
        v_profile_daily.provider_reported_cost_nanos::numeric
      else coalesce(
        v_profile_daily.provider_reported_cost_nanos,
        0
      )::numeric + v_provider_reported::numeric
    end;

    if v_user_new_cached > c_max_bigint
       or v_user_new_uncached > c_max_bigint
       or v_user_new_output > c_max_bigint
       or v_global_new_cached > c_max_bigint
       or v_global_new_uncached > c_max_bigint
       or v_global_new_output > c_max_bigint
       or v_profile_new_request_count > c_max_integer
       or v_profile_new_usage_incomplete_count > c_max_integer
       or v_profile_new_cost_incomplete_count > c_max_integer
       or v_profile_new_provider_incomplete_count > c_max_integer
       or v_profile_new_input_total > c_max_bigint
       or v_profile_new_cache_read > c_max_bigint
       or v_profile_new_input_standard > c_max_bigint
       or v_profile_new_output > c_max_bigint
       or v_profile_new_cache_write > c_max_bigint
       or v_profile_new_reasoning > c_max_bigint
       or v_profile_new_known_estimated > c_max_bigint
       or v_profile_new_estimated > c_max_bigint
       or v_profile_new_provider_reported > c_max_bigint then
      raise exception 'V2 settlement arithmetic overflow'
        using errcode = '22003';
    end if;

    update public.ai_request_ledger
    set state = 'finalized',
        status = p_status,
        quota_charged = p_quota_charged,
        provider_billable = v_derived_billable,
        finalized_at = v_now,
        input_cached_tokens = v_legacy_cached,
        input_uncached_tokens = v_legacy_uncached,
        output_tokens = v_legacy_output,
        usage_complete = v_request_usage_complete,
        attempt_count = v_child_count,
        provider_request_id = v_last_attempt.provider_request_id,
        finish_reason = v_last_attempt.finish_reason,
        failure_stage = v_last_attempt.failure_stage,
        latency_ms = v_last_attempt.latency_ms,
        usage_schema_version = 'request_usage_aggregate_v2',
        input_total_tokens = v_input_total,
        input_cache_read_tokens = v_cache_read,
        input_cache_write_tokens = v_cache_write,
        input_standard_tokens = v_input_standard,
        reasoning_tokens = v_reasoning,
        cache_usage_reporting = v_cache_reporting,
        incomplete_fields = v_incomplete_fields,
        cost_basis = 'frozen_price_version_v1',
        billing_currency = v_currency,
        known_estimated_cost_nanos = v_known_estimated,
        estimated_cost_nanos = v_estimated,
        provider_reported_currency = case
          when v_provider_reported is null then null else v_currency
        end,
        provider_reported_cost_nanos = v_provider_reported,
        cost_reconciliation_status = v_reconciliation,
        granularity = coalesce(v_metadata_object ->> 'granularity', granularity),
        item_count = coalesce(
          (v_metadata_object ->> 'item_count')::integer,
          item_count
        ),
        context_level = coalesce(
          (v_metadata_object ->> 'context_level')::smallint,
          context_level
        ),
        language = coalesce(v_metadata_object ->> 'language', language),
        prompt_version = coalesce(
          v_metadata_object ->> 'prompt_version',
          prompt_version
        ),
        validator_version = coalesce(
          v_metadata_object ->> 'validator_version',
          validator_version
        )
    where reservation_id = p_reservation_id;

    if not p_quota_charged then
      update public.ai_usage_daily
      set request_count = request_count - 1
      where user_id = v_row.user_id
        and day = v_quota_day;
    end if;
    update public.ai_usage_daily
    set input_cached_tokens = v_user_new_cached::bigint,
        input_uncached_tokens = v_user_new_uncached::bigint,
        output_tokens = v_user_new_output::bigint
    where user_id = v_row.user_id
      and day = v_today;

    update public.ai_global_usage_daily
    set input_cached_tokens = v_global_new_cached::bigint,
        input_uncached_tokens = v_global_new_uncached::bigint,
        output_tokens = v_global_new_output::bigint
    where day = v_today;

    update public.ai_profile_usage_daily
    set request_count = v_profile_new_request_count::integer,
        usage_incomplete_count = v_profile_new_usage_incomplete_count::integer,
        cost_incomplete_count = v_profile_new_cost_incomplete_count::integer,
        provider_report_incomplete_count =
          v_profile_new_provider_incomplete_count::integer,
        input_total_tokens = v_profile_new_input_total::bigint,
        input_cache_read_tokens = v_profile_new_cache_read::bigint,
        input_cache_write_tokens = v_profile_new_cache_write::bigint,
        input_standard_tokens = v_profile_new_input_standard::bigint,
        output_tokens = v_profile_new_output::bigint,
        reasoning_tokens = v_profile_new_reasoning::bigint,
        known_estimated_cost_nanos = v_profile_new_known_estimated::bigint,
        estimated_cost_nanos = v_profile_new_estimated::bigint,
        provider_reported_cost_nanos = v_profile_new_provider_reported::bigint
    where day = v_today
      and profile_version_id = v_row.profile_version_id
      and billing_currency = v_currency;
  exception
    when others then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'SERVICE_UNAVAILABLE'
      );
  end;

  select request_count into v_today_count
  from public.ai_usage_daily
  where user_id = v_row.user_id
    and day = v_today;
  v_quota := pg_catalog.jsonb_build_object(
    'limit', c_daily_limit,
    'remaining', c_daily_limit - coalesce(v_today_count, 0),
    'resetAt', v_reset_at
  );
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'alreadyFinalized', false,
    'status', p_status,
    'quotaCharged', p_quota_charged,
    'quota', v_quota
  );
end;
$$;

revoke all on function public.finalize_ai_polish_request(
  uuid, text, boolean, boolean, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_ai_polish_request(
  uuid, text, boolean, boolean, jsonb, jsonb
) to service_role;

commit;
