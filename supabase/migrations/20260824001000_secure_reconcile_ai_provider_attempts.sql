-- Secure stale reconciliation for the V2 provider-attempt ledger.
--
-- The reconciler deliberately shares the finalize function's owner. Its
-- SECURITY DEFINER boundary is the only caller that may enter DB-010's
-- dormant owner-OID abandoned-settlement path.

create or replace function public.reconcile_stale_ai_polish_reservations(
  p_stale_after interval default interval '10 minutes'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_max_latency_ms constant numeric := 2147483647;
  v_reconcile_at timestamptz := pg_catalog.transaction_timestamp();
  v_cutoff timestamptz;
  v_request public.ai_request_ledger%rowtype;
  v_attempt public.ai_provider_attempt_ledger%rowtype;
  v_result jsonb;
  v_released integer := 0;
  v_abandoned integer := 0;
  v_latency_overflow integer := 0;
  v_child_count integer;
  v_attempt_nos smallint[];
  v_started_count integer;
  v_overflow_count integer;
  v_has_child boolean;
  v_reservation_eligible boolean;
  v_any_billable boolean;
  v_all_nonbillable boolean;
  v_derived_billable boolean;
begin
  -- This complete invocation-wide preflight intentionally precedes every
  -- relation scan, lock, warning, sequence use and mutation.
  if p_stale_after is null or p_stale_after <= interval '0' then
    raise exception 'stale interval must produce a past cutoff'
      using errcode = '22023';
  end if;

  begin
    v_cutoff := v_reconcile_at - p_stale_after;
  exception
    when datetime_field_overflow or numeric_value_out_of_range then
      raise exception 'stale interval cutoff is not representable'
        using errcode = '22023';
  end;

  if not pg_catalog.isfinite(v_cutoff)
     or v_cutoff >= v_reconcile_at then
    raise exception 'stale interval must produce a finite past cutoff'
      using errcode = '22023';
  end if;

  -- The scan is only a candidate optimization. SKIP LOCKED makes concurrent
  -- reconcilers independent; every relevant fact is revalidated after the
  -- request lock and the ordered child locks below.
  for v_request in
    select request.*
    from public.ai_request_ledger as request
    where request.state <> 'finalized'
      and (
        (request.route_schema_version is null and (
          (request.state = 'reserved' and request.reserved_at < v_cutoff)
          or (
            request.state = 'provider_started'
            and request.provider_started_at < v_cutoff
          )
        ))
        or (
          request.route_schema_version = 'route_snapshot_v1'
          and request.state = 'reserved'
          and (
            (
              request.attempt_count = 0
              and request.reserved_at < v_cutoff
            )
            or exists (
              select 1
              from public.ai_provider_attempt_ledger as candidate_attempt
              where candidate_attempt.reservation_id = request.reservation_id
                and (
                  (
                    candidate_attempt.status = 'started'
                    and candidate_attempt.started_at < v_cutoff
                  )
                  or (
                    candidate_attempt.status <> 'started'
                    and candidate_attempt.terminal_at < v_cutoff
                  )
                )
            )
          )
        )
      )
    order by request.reservation_id
    for update of request skip locked
  loop
    -- Genuine V1 compatibility remains byte-for-byte at the response level.
    if v_request.route_schema_version is null then
      -- A genuine V1 reservation predates the attempt ledger and therefore
      -- cannot own any attempt child. The parent lock serializes every
      -- supported lifecycle writer, so this plain existence read is enough to
      -- reject owner/migration corruption without taking a child row lock.
      select exists (
        select 1
        from public.ai_provider_attempt_ledger as legacy_child
        where legacy_child.reservation_id = v_request.reservation_id
      )
      into v_has_child;

      if v_has_child then
        continue;
      end if;

      if v_request.state = 'reserved'
         and v_request.reserved_at < v_cutoff then
        v_result := public.finalize_ai_polish_request(
          v_request.reservation_id,
          'released',
          false,
          false,
          null,
          null
        );
        if pg_catalog.jsonb_typeof(v_result) is distinct from 'object'
           or (v_result ->> 'ok')::boolean is distinct from true
           or v_result ->> 'status' is distinct from 'released' then
          raise exception 'stale V1 release failed closed';
        end if;
        v_released := v_released + 1;
      elsif v_request.state = 'provider_started'
            and v_request.provider_started_at < v_cutoff then
        update public.ai_request_ledger
        set state = 'finalized',
            status = 'abandoned',
            quota_charged = false,
            provider_billable = null,
            usage_complete = false,
            finalized_at = v_reconcile_at
        where reservation_id = v_request.reservation_id
          and state = 'provider_started';

        if found then
          update public.ai_usage_daily
          set request_count = greatest(0, request_count - 1)
          where user_id = v_request.user_id
            and day = (v_request.reserved_at at time zone 'utc')::date;
          v_abandoned := v_abandoned + 1;
        end if;
      end if;
      continue;
    end if;

    -- Unknown future route schemas never inherit V1 or V2 settlement rules.
    if v_request.route_schema_version is distinct from 'route_snapshot_v1'
       or v_request.state is distinct from 'reserved' then
      continue;
    end if;

    v_child_count := 0;
    v_attempt_nos := array[]::smallint[];
    v_started_count := 0;
    v_overflow_count := 0;
    v_reservation_eligible := true;
    v_any_billable := false;
    v_all_nonbillable := true;

    for v_attempt in
      select attempt.*
      from public.ai_provider_attempt_ledger as attempt
      where attempt.reservation_id = v_request.reservation_id
      order by attempt.attempt_no
      for update of attempt
    loop
      v_child_count := v_child_count + 1;
      v_attempt_nos := pg_catalog.array_append(
        v_attempt_nos,
        v_attempt.attempt_no
      );
      v_any_billable := v_any_billable
        or v_attempt.provider_billable is true;
      v_all_nonbillable := v_all_nonbillable
        and v_attempt.provider_billable is false;

      if v_attempt.status = 'started' then
        v_started_count := v_started_count + 1;
        if v_attempt.started_at >= v_cutoff then
          -- A fresh/equality child makes the whole reservation ineligible.
          v_reservation_eligible := false;
        elsif pg_catalog.floor(
          extract(epoch from (v_reconcile_at - v_attempt.started_at))
          * 1000
        ) not between 0 and c_max_latency_ms then
          v_overflow_count := v_overflow_count + 1;
        end if;
      elsif v_attempt.terminal_at is null
            or v_attempt.terminal_at >= v_cutoff then
        -- The strict maximum-terminal watermark is expressed as an
        -- all-terminal predicate so mixed reservations cannot partially move.
        v_reservation_eligible := false;
      end if;
    end loop;

    -- Exact clean V2 pre-start release. Any provider-start/count drift stays
    -- outside this branch and therefore cannot borrow the legacy selector.
    if v_child_count = 0 then
      if v_request.attempt_count = 0
         and v_request.provider_started_at is null
         and v_request.reserved_at < v_cutoff then
        v_result := public.finalize_ai_polish_request(
          v_request.reservation_id,
          'released',
          false,
          false,
          null,
          null
        );
        if pg_catalog.jsonb_typeof(v_result) is distinct from 'object'
           or (v_result ->> 'ok')::boolean is distinct from true
           or v_result ->> 'status' is distinct from 'released' then
          raise exception 'stale V2 pre-start release failed closed';
        end if;
        v_released := v_released + 1;
      end if;
      continue;
    end if;

    -- Revalidate the admitted row set before touching any child. This is the
    -- same closed domain consumed by DB-010 finalize.
    if v_request.attempt_count is distinct from v_child_count
       or v_attempt_nos not in (
         array[1]::smallint[],
         array[1, 2]::smallint[]
       )
       or v_request.provider_started_at is not null
       or not v_reservation_eligible then
      continue;
    end if;

    if v_overflow_count > 0 then
      v_latency_overflow := v_latency_overflow + v_overflow_count;
      raise warning 'stale provider attempt latency is not representable';
      continue;
    end if;

    if v_any_billable then
      v_derived_billable := true;
    elsif v_all_nonbillable then
      v_derived_billable := false;
    else
      v_derived_billable := null;
    end if;

    if v_started_count > 0 then
      update public.ai_provider_attempt_ledger as attempt
      set status = 'unknown',
          terminal_at = v_reconcile_at,
          provider_billable = null,
          usage_observation_kind = 'unavailable',
          usage_schema_version = null,
          input_total_tokens = null,
          input_cache_read_tokens = null,
          input_cache_write_tokens = null,
          input_standard_tokens = null,
          output_tokens = null,
          reasoning_tokens = null,
          cache_usage_reporting = null,
          usage_complete = false,
          route_observation_schema_version = 'route_observation_v1',
          gateway_request_id = null,
          provider_request_id = null,
          actual_upstream_endpoint = null,
          actual_model_id = null,
          router_attempt_count = null,
          cost_observation_schema_version = 'cost_observation_v1',
          estimated_currency = null,
          estimated_cost_nanos = null,
          provider_reported_currency = null,
          provider_reported_cost_nanos = null,
          cost_reconciliation_status = 'incomplete_usage',
          finish_reason = null,
          failure_stage = 'provider_timeout',
          latency_ms = pg_catalog.floor(
            extract(epoch from (v_reconcile_at - attempt.started_at))
            * 1000
          )::integer
      where attempt.reservation_id = v_request.reservation_id
        and attempt.status = 'started';
    end if;

    v_result := public.finalize_ai_polish_request(
      v_request.reservation_id,
      'abandoned',
      false,
      v_derived_billable,
      null,
      pg_catalog.jsonb_build_object(
        'usage_schema_version',
        'attempt_v2'
      )
    );

    if pg_catalog.jsonb_typeof(v_result) is distinct from 'object'
       or (v_result ->> 'ok')::boolean is distinct from true
       or v_result ->> 'status' is distinct from 'abandoned' then
      raise exception 'stale V2 settlement failed closed: %',
        coalesce(v_result ->> 'reason', 'INVALID_RESULT');
    end if;
    v_abandoned := v_abandoned + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'releasedCount', v_released,
    'abandonedCount', v_abandoned,
    'latencyOverflowCount', v_latency_overflow
  );
end;
$$;

create or replace function public.cleanup_ai_polish_metadata()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_cleanup_at timestamptz := pg_catalog.transaction_timestamp();
  v_rate integer;
  v_ledger integer;
  v_usage integer;
  v_global integer;
  v_profile integer;
begin
  delete from public.ai_rate_minutes
  where minute_bucket < v_cleanup_at - interval '2 days';
  get diagnostics v_rate = row_count;

  -- Parent-first deletion lets the existing FK cascade remove attempts. The
  -- attempt guard observes no live parent and permits only this cascade path.
  delete from public.ai_request_ledger
  where state = 'finalized'
    and finalized_at < v_cleanup_at - interval '90 days';
  get diagnostics v_ledger = row_count;

  delete from public.ai_usage_daily
  where day < ((v_cleanup_at at time zone 'utc')::date - 90);
  get diagnostics v_usage = row_count;

  delete from public.ai_global_usage_daily
  where day < ((v_cleanup_at at time zone 'utc')::date - 90);
  get diagnostics v_global = row_count;

  delete from public.ai_profile_usage_daily
  where day < ((v_cleanup_at at time zone 'utc')::date - 90);
  get diagnostics v_profile = row_count;

  return pg_catalog.jsonb_build_object(
    'rateMinutesDeleted', v_rate,
    'ledgerDeleted', v_ledger,
    'usageDailyDeleted', v_usage,
    'globalUsageDailyDeleted', v_global,
    'profileUsageDailyDeleted', v_profile
  );
end;
$$;

-- The attempt ledger is readable but no longer writable by the API role.
-- Lifecycle mutations are confined to the three reviewed RPCs.
revoke all privileges
on table public.ai_provider_attempt_ledger
from public, anon, authenticated, service_role;
grant select on table public.ai_provider_attempt_ledger to service_role;

revoke execute on function public.guard_ai_provider_attempt_ledger()
  from public, anon, authenticated, service_role;
revoke execute on function public.start_ai_polish_provider_attempt(uuid, integer)
  from public, anon, authenticated;
revoke execute on function public.complete_ai_polish_provider_attempt(
  uuid, text, boolean, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated;
revoke execute on function public.reconcile_stale_ai_polish_reservations(interval)
  from public, anon, authenticated;
revoke execute on function public.cleanup_ai_polish_metadata()
  from public, anon, authenticated;

grant execute on function public.start_ai_polish_provider_attempt(uuid, integer)
  to service_role;
grant execute on function public.complete_ai_polish_provider_attempt(
  uuid, text, boolean, jsonb, jsonb, jsonb, jsonb
) to service_role;
grant execute on function public.reconcile_stale_ai_polish_reservations(interval)
  to service_role;
grant execute on function public.cleanup_ai_polish_metadata()
  to service_role;
