-- Parent-serialized cancellation observations and immutable retry admission.
-- Cancellation and attempt sequence are settlement facts, never caller-owned
-- billability hints. Ambiguous/legacy facts remain reserved fail closed.

begin;

alter table public.ai_request_ledger
  add column cancellation_state text,
  add column cancellation_observed_at timestamptz,
  add constraint ai_request_ledger_cancellation_state_check check (coalesce((
    cancellation_state is null and cancellation_observed_at is null
    or cancellation_state in ('observed', 'ambiguous')
       and cancellation_observed_at is not null
  ), false));

alter table public.ai_provider_attempt_ledger
  add column retry_eligible boolean;

comment on column public.ai_request_ledger.cancellation_state is
  'Parent-serialized request cancellation: observed or fail-closed ambiguous.';
comment on column public.ai_provider_attempt_ledger.retry_eligible is
  'Immutable terminal authorization for attempt 2; NULL is unknown/legacy.';

create function public.guard_ai_request_cancellation_fact()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_write text;
begin
  if tg_op = 'INSERT' then
    if new.cancellation_state is not null
       or new.cancellation_observed_at is not null then
      raise exception 'request cancellation fact must be RPC-owned'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.cancellation_state, new.cancellation_observed_at)
     is not distinct from (old.cancellation_state, old.cancellation_observed_at) then
    return new;
  end if;
  v_write := pg_catalog.current_setting('app.ai_request_cancellation_write', true);
  if v_write not in ('observed', 'ambiguous')
     or new.cancellation_state is distinct from (case
       when old.cancellation_state = 'observed' then 'observed'
       when v_write = 'observed' then 'observed'
       else 'ambiguous'
     end)
     or (
       old.cancellation_observed_at is null
       and new.cancellation_observed_at is null
       or old.cancellation_observed_at is not null
          and new.cancellation_observed_at is distinct from
            old.cancellation_observed_at
     ) then
    raise exception 'request cancellation fact is immutable and RPC-owned'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger ai_request_ledger_00_cancellation_fact
before insert or update on public.ai_request_ledger
for each row execute function public.guard_ai_request_cancellation_fact();

revoke execute on function public.guard_ai_request_cancellation_fact()
  from public, anon, authenticated, service_role;

create function public.capture_ai_provider_attempt_retry_eligibility()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_retry_eligible text;
begin
  if tg_op = 'INSERT' then
    if new.retry_eligible is not null then
      raise exception 'started provider attempts cannot be retry eligible'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.status = 'started' and new.status <> 'started' then
    if new.status = 'unknown' then
      new.retry_eligible := null;
      return new;
    end if;
    v_retry_eligible := pg_catalog.current_setting(
      'app.ai_provider_attempt_retry_eligible', true
    );
    if v_retry_eligible not in ('true', 'false') then
      raise exception 'terminal attempt requires audited retry eligibility'
        using errcode = '23514';
    end if;
    new.retry_eligible := v_retry_eligible::boolean;
    if new.retry_eligible and (
      new.attempt_no <> 1
      or new.status not in ('failed_upstream', 'timed_out', 'invalid_output')
    ) then
      raise exception 'retry eligibility conflicts with terminal attempt'
        using errcode = '23514';
    end if;
  elsif new.retry_eligible is distinct from old.retry_eligible then
    raise exception 'retry eligibility is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger ai_provider_attempt_ledger_01_retry_eligibility
before insert or update on public.ai_provider_attempt_ledger
for each row execute function public.capture_ai_provider_attempt_retry_eligibility();

revoke execute on function public.capture_ai_provider_attempt_retry_eligibility()
  from public, anon, authenticated, service_role;

-- The reviewed eight-argument implementation remains owner-only. The sole
-- public nine-argument overload persists and verifies both durable facts.
alter function public.complete_ai_polish_provider_attempt(
  uuid, text, boolean, boolean, jsonb, jsonb, jsonb, jsonb
) rename to complete_ai_polish_provider_attempt_transmission_internal;

revoke all on function public.complete_ai_polish_provider_attempt_transmission_internal(
  uuid, text, boolean, boolean, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role;

create function public.complete_ai_polish_provider_attempt(
  p_attempt_id uuid,
  p_status text,
  p_transmitted boolean,
  p_retry_eligible boolean,
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
  v_result jsonb;
  v_persisted_retry_eligible boolean;
begin
  if p_retry_eligible is null
     or p_retry_eligible and p_status not in (
       'failed_upstream', 'timed_out', 'invalid_output'
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'RETRY_ELIGIBILITY_CONFLICT'
    );
  end if;

  perform pg_catalog.set_config(
    'app.ai_provider_attempt_retry_eligible', p_retry_eligible::text, true
  );
  v_result := public.complete_ai_polish_provider_attempt_transmission_internal(
    p_attempt_id, p_status, p_transmitted, p_provider_billable,
    p_usage, p_route, p_cost, p_metadata
  );
  perform pg_catalog.set_config(
    'app.ai_provider_attempt_retry_eligible', '', true
  );

  if pg_catalog.jsonb_typeof(v_result) is distinct from 'object'
     or (v_result ->> 'ok')::boolean is distinct from true then
    return v_result;
  end if;

  select attempt.retry_eligible into v_persisted_retry_eligible
  from public.ai_provider_attempt_ledger as attempt
  where attempt.attempt_id = p_attempt_id;
  if not found
     or v_persisted_retry_eligible is distinct from p_retry_eligible then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'ATTEMPT_COMPLETION_CONFLICT'
    );
  end if;
  return v_result;
exception
  when others then
    perform pg_catalog.set_config(
      'app.ai_provider_attempt_retry_eligible', '', true
    );
    raise;
end;
$$;

revoke all on function public.complete_ai_polish_provider_attempt(
  uuid, text, boolean, boolean, boolean, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.complete_ai_polish_provider_attempt(
  uuid, text, boolean, boolean, boolean, jsonb, jsonb, jsonb, jsonb
) to service_role;

-- Parent lock makes cancellation monotonic with start, completion and settle.
-- observed dominates ambiguous so a response-loss marker can never downgrade
-- a cancellation that another observation already proved.
create function public.record_ai_polish_request_cancellation(
  p_reservation_id uuid,
  p_observation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.ai_request_ledger%rowtype;
  v_state text;
begin
  if p_observation not in ('observed', 'ambiguous') then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'INVALID_OBSERVATION'
    );
  end if;
  select * into v_request
  from public.ai_request_ledger
  where reservation_id = p_reservation_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'NOT_FOUND');
  end if;
  if v_request.state = 'finalized' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'ALREADY_FINALIZED'
    );
  end if;
  if v_request.state is distinct from 'reserved'
     or v_request.route_schema_version is distinct from 'route_snapshot_v1' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'SERVICE_UNAVAILABLE'
    );
  end if;
  v_state := case
    when v_request.cancellation_state = 'observed' then 'observed'
    when p_observation = 'observed' then 'observed'
    else 'ambiguous'
  end;
  perform pg_catalog.set_config(
    'app.ai_request_cancellation_write', p_observation, true
  );
  update public.ai_request_ledger
  set cancellation_state = v_state,
      cancellation_observed_at = coalesce(
        cancellation_observed_at, pg_catalog.clock_timestamp()
      )
  where reservation_id = p_reservation_id;
  perform pg_catalog.set_config('app.ai_request_cancellation_write', '', true);
  return pg_catalog.jsonb_build_object(
    'ok', true, 'reservationId', p_reservation_id, 'state', v_state
  );
exception
  when others then
    perform pg_catalog.set_config('app.ai_request_cancellation_write', '', true);
    raise;
end;
$$;

revoke all on function public.record_ai_polish_request_cancellation(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_ai_polish_request_cancellation(uuid, text)
  to service_role;

-- Wrap the reviewed start implementation. The same parent lock proves the
-- immutable attempt-1 terminal edge before attempt 2 can be admitted/replayed.
alter function public.start_ai_polish_provider_attempt(uuid, integer)
  rename to start_ai_polish_provider_attempt_internal;
revoke all on function public.start_ai_polish_provider_attempt_internal(uuid, integer)
  from public, anon, authenticated, service_role;

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
  v_first public.ai_provider_attempt_ledger%rowtype;
begin
  if p_attempt_no is null or p_attempt_no not in (1, 2) then
    raise exception 'provider attempt number must be 1 or 2'
      using errcode = '22023';
  end if;
  select * into v_request
  from public.ai_request_ledger
  where reservation_id = p_reservation_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'NOT_FOUND');
  end if;
  if v_request.state = 'finalized' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'ALREADY_FINALIZED'
    );
  end if;
  if v_request.cancellation_state is not null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'CANCELLATION_OBSERVED'
    );
  end if;
  if p_attempt_no = 2 then
    select * into v_first
    from public.ai_provider_attempt_ledger
    where reservation_id = p_reservation_id and attempt_no = 1;
    if not found
       or v_first.status not in ('failed_upstream', 'timed_out', 'invalid_output')
       or v_first.terminal_at is null
       or v_first.retry_eligible is distinct from true then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'reason', 'RETRY_SEQUENCE_REJECTED'
      );
    end if;
  end if;
  return public.start_ai_polish_provider_attempt_internal(
    p_reservation_id, p_attempt_no
  );
end;
$$;

revoke all on function public.start_ai_polish_provider_attempt(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.start_ai_polish_provider_attempt(uuid, integer)
  to service_role;

-- Owner-only derivation. Request-time finalization may close an unused retry
-- edge; reconciliation may not guess that the process did not die in delay.
create function public.derive_ai_polish_v2_settlement_sequence(
  p_reservation_id uuid,
  p_allow_open_retry boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.ai_request_ledger%rowtype;
  v_attempt public.ai_provider_attempt_ledger%rowtype;
  v_first public.ai_provider_attempt_ledger%rowtype;
  v_last_status text;
  v_child_count integer := 0;
  v_attempt_nos smallint[] := array[]::smallint[];
  v_any_transmitted boolean := false;
  v_any_unknown boolean := false;
  v_any_billable boolean := false;
  v_all_nonbillable boolean := true;
  v_status text;
  v_quota_charged boolean;
  v_provider_billable boolean;
begin
  select * into v_request from public.ai_request_ledger
  where reservation_id = p_reservation_id for update;
  if not found
     or v_request.route_schema_version is distinct from 'route_snapshot_v1'
     or v_request.state is distinct from 'reserved' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'SERVICE_UNAVAILABLE'
    );
  end if;
  if v_request.cancellation_state = 'ambiguous' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'TRANSMISSION_UNKNOWN_HELD',
      'detail', 'CANCELLATION_AMBIGUOUS'
    );
  end if;

  for v_attempt in
    select attempt.* from public.ai_provider_attempt_ledger as attempt
    where attempt.reservation_id = p_reservation_id
    order by attempt.attempt_no for update
  loop
    v_child_count := v_child_count + 1;
    v_attempt_nos := pg_catalog.array_append(v_attempt_nos, v_attempt.attempt_no);
    v_last_status := v_attempt.status;
    if v_attempt.attempt_no = 1 then v_first := v_attempt; end if;
    if v_attempt.status = 'started' then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'reason', 'ATTEMPT_IN_PROGRESS'
      );
    end if;
    v_any_transmitted := v_any_transmitted or v_attempt.transmitted is true;
    v_any_unknown := v_any_unknown
      or v_attempt.transmitted is null or v_attempt.retry_eligible is null;
    v_any_billable := v_any_billable or v_attempt.provider_billable is true;
    v_all_nonbillable := v_all_nonbillable and v_attempt.provider_billable is false;
  end loop;

  if v_request.attempt_count is distinct from v_child_count
     or v_request.provider_started_at is not null
     or v_attempt_nos not in (
       array[]::smallint[], array[1]::smallint[], array[1,2]::smallint[]
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'TRANSMISSION_UNKNOWN_HELD',
      'detail', 'INVALID_ATTEMPT_SEQUENCE'
    );
  end if;
  if v_child_count = 0 then
    if v_request.cancellation_state = 'ambiguous' then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'reason', 'TRANSMISSION_UNKNOWN_HELD'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'status', 'released', 'quotaCharged', false,
      'providerBillable', false, 'childCount', 0
    );
  end if;
  if v_any_unknown then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'TRANSMISSION_UNKNOWN_HELD'
    );
  end if;
  if v_first.retry_eligible is true and (
    v_first.attempt_no <> 1
    or v_first.status not in ('failed_upstream', 'timed_out', 'invalid_output')
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'TRANSMISSION_UNKNOWN_HELD',
      'detail', 'INVALID_RETRY_EDGE'
    );
  end if;
  if v_child_count = 2 and (
    v_first.status not in ('failed_upstream', 'timed_out', 'invalid_output')
    or v_first.retry_eligible is distinct from true
    or v_attempt.retry_eligible is distinct from false
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'TRANSMISSION_UNKNOWN_HELD',
      'detail', 'INVALID_RETRY_EDGE'
    );
  end if;
  if v_child_count = 1 and v_first.retry_eligible is true
     and not p_allow_open_retry
     and v_request.cancellation_state is null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'TRANSMISSION_UNKNOWN_HELD',
      'detail', 'RETRY_SEQUENCE_OPEN'
    );
  end if;
  -- A reconciler cannot distinguish ordinary process loss from a cancellation
  -- whose write and readback both failed. Only a durable cancellation fact is
  -- autonomous settlement authority; a live finalizer may close its own
  -- terminal operation after exact completion readback.
  if not p_allow_open_retry and v_request.cancellation_state is null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'TRANSMISSION_UNKNOWN_HELD',
      'detail', 'SETTLEMENT_INTENT_UNKNOWN'
    );
  end if;

  if v_request.cancellation_state = 'observed' then
    v_status := 'canceled';
  else
    v_status := case v_last_status
      when 'succeeded' then 'succeeded'
      when 'canceled' then 'canceled'
      when 'invalid_output' then 'invalid_output'
      when 'failed_upstream' then 'failed_upstream'
      when 'timed_out' then 'failed_upstream'
      else null
    end;
  end if;
  if v_status is null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'TRANSMISSION_UNKNOWN_HELD'
    );
  end if;
  v_quota_charged := case v_status
    when 'succeeded' then true
    when 'canceled' then v_any_transmitted
    else false
  end;
  v_provider_billable := case
    when v_any_billable then true
    when v_all_nonbillable then false
    else null
  end;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'status', v_status, 'quotaCharged', v_quota_charged,
    'providerBillable', v_provider_billable, 'childCount', v_child_count
  );
end;
$$;

revoke all on function public.derive_ai_polish_v2_settlement_sequence(uuid, boolean)
  from public, anon, authenticated, service_role;

create or replace function public.derive_ai_polish_v2_settlement(
  p_reservation_id uuid
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.derive_ai_polish_v2_settlement_sequence(
    p_reservation_id, false
  );
$$;
revoke all on function public.derive_ai_polish_v2_settlement(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.finalize_ai_polish_request(
  p_reservation_id uuid,
  p_status text,
  p_quota_charged boolean,
  p_provider_billable boolean,
  p_usage jsonb,
  p_metadata jsonb,
  p_settlement_contract text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.ai_request_ledger%rowtype;
  v_derived jsonb;
  v_derived_status text;
  v_derived_quota boolean;
  v_derived_billable boolean;
begin
  select * into v_request from public.ai_request_ledger
  where reservation_id = p_reservation_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'NOT_FOUND');
  end if;
  if v_request.state = 'finalized' then
    if v_request.status is distinct from p_status
       or v_request.quota_charged is distinct from p_quota_charged
       or v_request.provider_billable is distinct from p_provider_billable then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'reason', 'FINALIZE_CONFLICT'
      );
    end if;
    return public.finalize_ai_polish_request_internal(
      p_reservation_id, p_status, p_quota_charged, p_provider_billable,
      p_usage, p_metadata
    );
  end if;
  if v_request.route_schema_version is distinct from 'route_snapshot_v1'
     or p_settlement_contract is distinct from
       'durable_cancellation_sequence_v1'
     or p_status not in (
       'succeeded', 'canceled', 'failed_upstream', 'invalid_output', 'released'
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'AUDITED_SETTLEMENT_REJECTED'
    );
  end if;
  v_derived := public.derive_ai_polish_v2_settlement_sequence(
    p_reservation_id, true
  );
  if pg_catalog.jsonb_typeof(v_derived) is distinct from 'object'
     or (v_derived ->> 'ok')::boolean is distinct from true then
    return v_derived;
  end if;
  v_derived_status := v_derived ->> 'status';
  v_derived_quota := (v_derived ->> 'quotaCharged')::boolean;
  v_derived_billable := (v_derived ->> 'providerBillable')::boolean;
  if p_status is distinct from v_derived_status
     or p_quota_charged is distinct from v_derived_quota
     or p_provider_billable is distinct from v_derived_billable then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'SETTLEMENT_ASSERTION_CONFLICT'
    );
  end if;
  return public.finalize_ai_polish_request_internal(
    p_reservation_id, v_derived_status, v_derived_quota, v_derived_billable,
    p_usage, p_metadata
  );
end;
$$;

revoke all on function public.finalize_ai_polish_request(
  uuid, text, boolean, boolean, jsonb, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_ai_polish_request(
  uuid, text, boolean, boolean, jsonb, jsonb, text
) to service_role;

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
  v_derived jsonb;
  v_released integer := 0;
  v_abandoned integer := 0;
  v_held_unknown integer := 0;
  v_latency_overflow integer := 0;
  v_child_count integer;
  v_attempt_nos smallint[];
  v_eligible boolean;
  v_started_count integer;
  v_overflow_count integer;
begin
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
  if not pg_catalog.isfinite(v_cutoff) or v_cutoff >= v_reconcile_at then
    raise exception 'stale interval must produce a finite past cutoff'
      using errcode = '22023';
  end if;

  for v_request in
    select request.* from public.ai_request_ledger as request
    where request.state <> 'finalized' and (
      request.route_schema_version is null and (
        request.state = 'reserved' and request.reserved_at < v_cutoff
        or request.state = 'provider_started'
           and request.provider_started_at < v_cutoff
      )
      or request.route_schema_version = 'route_snapshot_v1'
         and request.state = 'reserved' and (
           request.attempt_count = 0 and request.reserved_at < v_cutoff
           or exists (
             select 1 from public.ai_provider_attempt_ledger as candidate
             where candidate.reservation_id = request.reservation_id and (
               candidate.status = 'started' and candidate.started_at < v_cutoff
               or candidate.status <> 'started'
                  and candidate.terminal_at < v_cutoff
             )
           )
         )
    )
    order by request.reservation_id
    for update of request skip locked
  loop
    if v_request.route_schema_version is null then
      if exists (
        select 1 from public.ai_provider_attempt_ledger as child
        where child.reservation_id = v_request.reservation_id
      ) then
        continue;
      end if;
      if v_request.state = 'reserved' then
        v_result := public.finalize_ai_polish_request_internal(
          v_request.reservation_id, 'released', false, false, null, null
        );
        if (v_result ->> 'ok')::boolean is distinct from true then
          raise exception 'stale V1 release failed closed';
        end if;
        v_released := v_released + 1;
      elsif v_request.state = 'provider_started'
            and v_request.provider_started_at < v_cutoff then
        update public.ai_request_ledger
        set state = 'finalized', status = 'abandoned', quota_charged = false,
            provider_billable = null, usage_complete = false,
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

    if v_request.route_schema_version is distinct from 'route_snapshot_v1'
       or v_request.state is distinct from 'reserved' then
      continue;
    end if;
    v_child_count := 0;
    v_attempt_nos := array[]::smallint[];
    v_eligible := true;
    v_started_count := 0;
    v_overflow_count := 0;
    for v_attempt in
      select attempt.* from public.ai_provider_attempt_ledger as attempt
      where attempt.reservation_id = v_request.reservation_id
      order by attempt.attempt_no for update
    loop
      v_child_count := v_child_count + 1;
      v_attempt_nos := pg_catalog.array_append(v_attempt_nos, v_attempt.attempt_no);
      if v_attempt.status = 'started' then
        v_started_count := v_started_count + 1;
        if v_attempt.started_at >= v_cutoff then
          v_eligible := false;
        elsif pg_catalog.floor(
          extract(epoch from (v_reconcile_at - v_attempt.started_at)) * 1000
        ) not between 0 and c_max_latency_ms then
          v_overflow_count := v_overflow_count + 1;
        end if;
      elsif v_attempt.terminal_at is null or v_attempt.terminal_at >= v_cutoff then
        v_eligible := false;
      end if;
    end loop;

    if not v_eligible
       or v_request.attempt_count is distinct from v_child_count
       or v_attempt_nos not in (
         array[]::smallint[], array[1]::smallint[], array[1,2]::smallint[]
       )
       or v_request.provider_started_at is not null then
      continue;
    end if;
    if v_overflow_count > 0 then
      v_latency_overflow := v_latency_overflow + v_overflow_count;
      raise warning 'stale provider attempt latency is not representable';
      continue;
    end if;
    if v_started_count > 0 then
      v_held_unknown := v_held_unknown + 1;
      continue;
    end if;

    v_derived := public.derive_ai_polish_v2_settlement(v_request.reservation_id);
    if (v_derived ->> 'ok')::boolean is distinct from true then
      if v_derived ->> 'reason' = 'TRANSMISSION_UNKNOWN_HELD' then
        v_held_unknown := v_held_unknown + 1;
        continue;
      end if;
      raise exception 'stale V2 derivation failed closed';
    end if;
    v_result := public.finalize_ai_polish_request_internal(
      v_request.reservation_id,
      v_derived ->> 'status',
      (v_derived ->> 'quotaCharged')::boolean,
      (v_derived ->> 'providerBillable')::boolean,
      null,
      case when v_child_count = 0 then null else
        pg_catalog.jsonb_build_object('usage_schema_version', 'attempt_v2') end
    );
    if (v_result ->> 'ok')::boolean is distinct from true then
      raise exception 'stale V2 settlement failed closed';
    end if;
    if v_child_count = 0 then
      v_released := v_released + 1;
    else
      v_abandoned := v_abandoned + 1;
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'releasedCount', v_released,
    'abandonedCount', v_abandoned,
    'latencyOverflowCount', v_latency_overflow
  ) || case when v_held_unknown > 0 then
    pg_catalog.jsonb_build_object('heldUnknownCount', v_held_unknown)
  else '{}'::jsonb end;
end;
$$;

revoke execute on function public.reconcile_stale_ai_polish_reservations(interval)
  from public, anon, authenticated;
grant execute on function public.reconcile_stale_ai_polish_reservations(interval)
  to service_role;

commit;
