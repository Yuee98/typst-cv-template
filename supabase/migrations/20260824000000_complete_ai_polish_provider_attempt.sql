-- Complete immutable provider-attempt facts and settle V2 requests from those
-- facts.  The request settlement half is added below in the same migration;
-- keeping both lifecycle operations in one migration prevents a live partial
-- deployment between completion and aggregation semantics.

begin;

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

commit;
