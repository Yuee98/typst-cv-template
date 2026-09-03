-- ADM-I09: bounded, content-free Admin analytics. Aggregation stays in the DB;
-- no user identity, CV content, prompts, output or raw upstream IDs leave it.
begin;

create index ai_request_ledger_admin_range_idx
on public.ai_request_ledger (reserved_at, reservation_id);

create index ai_provider_attempt_admin_range_idx
on public.ai_provider_attempt_ledger (started_at, attempt_id);

create function public.admin_get_ai_analytics_v1(
  p_environment text,
  p_project_ref text,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requests jsonb;
  v_attempts jsonb;
  v_usage jsonb;
  v_costs jsonb;
  v_routes jsonb;
  v_cost_groups_truncated boolean;
  v_route_groups_truncated boolean;
begin
  perform public.admin_assert_actor_v1(p_environment, p_project_ref);
  if p_from is null or p_to is null or p_from >= p_to
     or p_to > clock_timestamp() + interval '1 minute'
     or p_to - p_from > interval '31 days' then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  perform pg_catalog.set_config('statement_timeout', '5000', true);

  select jsonb_build_object(
    'total', count(*)::integer,
    'finalized', count(*) filter (where state = 'finalized')::integer,
    'succeeded', count(*) filter (where state = 'finalized' and status = 'succeeded')::integer,
    'failedUpstream', count(*) filter (where state = 'finalized' and status = 'failed_upstream')::integer,
    'invalidOutput', count(*) filter (where state = 'finalized' and status = 'invalid_output')::integer,
    'canceled', count(*) filter (where state = 'finalized' and status = 'canceled')::integer,
    'released', count(*) filter (where state = 'finalized' and status = 'released')::integer,
    'abandoned', count(*) filter (where state = 'finalized' and status = 'abandoned')::integer,
    'retried', count(*) filter (where coalesce(attempt_count, 0) > 1)::integer,
    'latencyP50Ms', percentile_disc(0.5) within group (order by latency_ms)
      filter (where state = 'finalized' and status = 'succeeded' and latency_ms is not null),
    'latencyP95Ms', percentile_disc(0.95) within group (order by latency_ms)
      filter (where state = 'finalized' and status = 'succeeded' and latency_ms is not null)
  ) into v_requests
  from public.ai_request_ledger
  where reserved_at >= p_from and reserved_at < p_to;

  select jsonb_build_object(
    'total', count(*)::integer,
    'transmitted', count(*) filter (where transmitted is true)::integer,
    'succeeded', count(*) filter (where status = 'succeeded')::integer,
    'failedUpstream', count(*) filter (where status = 'failed_upstream')::integer,
    'invalidOutput', count(*) filter (where status = 'invalid_output')::integer,
    'timedOut', count(*) filter (where status = 'timed_out')::integer,
    'canceled', count(*) filter (where status = 'canceled')::integer,
    'unknown', count(*) filter (where status = 'unknown')::integer,
    'unsettled', count(*) filter (
      where status = 'started' and started_at < clock_timestamp() - interval '10 minutes'
    )::integer
  ) into v_attempts
  from public.ai_provider_attempt_ledger
  where started_at >= p_from and started_at < p_to;

  select jsonb_build_object(
    'completeRows', count(*) filter (where usage_complete is true)::integer,
    'incompleteRows', count(*) filter (where usage_complete is distinct from true)::integer,
    'inputCacheReadTokens', coalesce(sum(input_cache_read_tokens), 0)::text,
    'inputCacheWriteTokens', coalesce(sum(input_cache_write_tokens), 0)::text,
    'inputStandardTokens', coalesce(sum(input_standard_tokens), 0)::text,
    'outputTokens', coalesce(sum(output_tokens), 0)::text,
    'reasoningTokens', coalesce(sum(reasoning_tokens), 0)::text
  ) into v_usage
  from public.ai_provider_attempt_ledger
  where started_at >= p_from and started_at < p_to;

  select coalesce(jsonb_agg(jsonb_build_object(
    'currency', currency,
    'requestRows', request_rows,
    'knownEstimatedNanos', known_estimated_nanos,
    'estimatedNanos', estimated_nanos,
    'providerReportedNanos', provider_reported_nanos,
    'matchedRows', matched_rows,
    'mismatchRows', mismatch_rows,
    'incompleteRows', incomplete_rows
  ) order by currency), '[]'::jsonb) into v_costs
  from (
    select billing_currency as currency,
      count(*)::integer as request_rows,
      coalesce(sum(known_estimated_cost_nanos), 0)::text as known_estimated_nanos,
      coalesce(sum(estimated_cost_nanos), 0)::text as estimated_nanos,
      coalesce(sum(provider_reported_cost_nanos), 0)::text as provider_reported_nanos,
      count(*) filter (where cost_reconciliation_status = 'matched')::integer as matched_rows,
      count(*) filter (where cost_reconciliation_status = 'mismatch')::integer as mismatch_rows,
      count(*) filter (where cost_reconciliation_status is null
        or cost_reconciliation_status in ('incomplete_usage','pending','not_available'))::integer as incomplete_rows
    from public.ai_request_ledger
    where reserved_at >= p_from and reserved_at < p_to and billing_currency is not null
    group by billing_currency
    order by billing_currency
    limit 16
  ) cost_rows;

  select count(distinct billing_currency) > 16 into v_cost_groups_truncated
  from public.ai_request_ledger
  where reserved_at >= p_from and reserved_at < p_to
    and billing_currency is not null;

  select coalesce(jsonb_agg(jsonb_build_object(
    'gatewayKind', gateway_kind,
    'modelId', model_id,
    'attempts', attempts,
    'succeeded', succeeded,
    'transmitted', transmitted
  ) order by gateway_kind, model_id), '[]'::jsonb) into v_routes
  from (
    select gateway_kind, model_id, count(*)::integer as attempts,
      count(*) filter (where status = 'succeeded')::integer as succeeded,
      count(*) filter (where transmitted is true)::integer as transmitted
    from public.ai_provider_attempt_ledger
    where started_at >= p_from and started_at < p_to
    group by gateway_kind, model_id
    order by gateway_kind, model_id
    limit 128
  ) route_rows;

  select count(*) > 128 into v_route_groups_truncated
  from (
    select 1 from public.ai_provider_attempt_ledger
    where started_at >= p_from and started_at < p_to
    group by gateway_kind, model_id
  ) route_groups;

  return jsonb_build_object(
    'schemaVersion', 'admin_ai_analytics_v1',
    'range', jsonb_build_object(
      'from', p_from,
      'to', p_to,
      'timezone', 'UTC',
      'retentionDays', 90,
      'retentionBoundary', clock_timestamp() - interval '90 days',
      'rangeMayBeTruncated', p_from < clock_timestamp() - interval '90 days',
      'requestTimeField', 'reserved_at',
      'attemptTimeField', 'started_at'
    ),
    'requests', v_requests,
    'attempts', v_attempts,
    'usage', v_usage,
    'costsByCurrency', v_costs,
    'costGroupsTruncated', v_cost_groups_truncated,
    'routes', v_routes,
    'routeGroupsTruncated', v_route_groups_truncated
  );
end;
$$;

revoke all on function public.admin_get_ai_analytics_v1(text,text,timestamptz,timestamptz)
from public, anon, authenticated, service_role;
grant execute on function public.admin_get_ai_analytics_v1(text,text,timestamptz,timestamptz)
to authenticated;

commit;
