-- Durable provider-transmission truth and DB-authoritative V2 quota settlement.
--
-- A normal terminal attempt records whether the adapter was entered. NULL is
-- reserved for facts whose transmission boundary is genuinely unknown (old
-- terminal rows and stale started rows reconciled after a process loss).

begin;

alter table public.ai_provider_attempt_ledger
  add column transmitted boolean;

comment on column public.ai_provider_attempt_ledger.transmitted is
  'Durable adapter-entry observation. true=entered, false=definitely pre-entry, null=unknown/legacy.';

create or replace function public.capture_ai_provider_attempt_transmission()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_transmitted text;
begin
  if tg_op = 'INSERT' then
    if new.transmitted is not null then
      raise exception 'started provider attempts cannot contain transmission truth'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.status = 'started' and new.status <> 'started' then
    if new.status = 'unknown' then
      new.transmitted := null;
      return new;
    end if;

    v_transmitted := pg_catalog.current_setting(
      'app.ai_provider_attempt_transmitted',
      true
    );
    if v_transmitted not in ('true', 'false') then
      raise exception 'terminal attempt requires audited transmission truth'
        using errcode = '23514';
    end if;
    new.transmitted := v_transmitted::boolean;
  end if;
  return new;
end;
$$;

create trigger ai_provider_attempt_ledger_00_transmission
before insert or update on public.ai_provider_attempt_ledger
for each row execute function public.capture_ai_provider_attempt_transmission();

-- Preserve the reviewed seven-argument implementation as an owner-only
-- primitive. The public eight-argument wrapper supplies the extra durable
-- fact and verifies its exact replay after the primitive returns.
alter function public.complete_ai_polish_provider_attempt(
  uuid, text, boolean, jsonb, jsonb, jsonb, jsonb
) rename to complete_ai_polish_provider_attempt_internal;

revoke all on function public.complete_ai_polish_provider_attempt_internal(
  uuid, text, boolean, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role;

create function public.complete_ai_polish_provider_attempt(
  p_attempt_id uuid,
  p_status text,
  p_transmitted boolean,
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
  v_persisted_transmitted boolean;
begin
  if p_transmitted is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'TRANSMISSION_TRUTH_REQUIRED'
    );
  end if;

  -- These outcomes can exist only after adapter entry. timed_out,
  -- failed_upstream and canceled retain both pre-entry and post-entry shapes.
  if p_status in ('succeeded', 'invalid_output') and not p_transmitted then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'TRANSMISSION_STATUS_CONFLICT'
    );
  end if;

  perform pg_catalog.set_config(
    'app.ai_provider_attempt_transmitted',
    p_transmitted::text,
    true
  );
  v_result := public.complete_ai_polish_provider_attempt_internal(
    p_attempt_id,
    p_status,
    p_provider_billable,
    p_usage,
    p_route,
    p_cost,
    p_metadata
  );
  perform pg_catalog.set_config(
    'app.ai_provider_attempt_transmitted',
    '',
    true
  );

  if pg_catalog.jsonb_typeof(v_result) is distinct from 'object'
     or (v_result ->> 'ok')::boolean is distinct from true then
    return v_result;
  end if;

  select attempt.transmitted into v_persisted_transmitted
  from public.ai_provider_attempt_ledger as attempt
  where attempt.attempt_id = p_attempt_id;

  if not found
     or v_persisted_transmitted is distinct from p_transmitted then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'ATTEMPT_COMPLETION_CONFLICT'
    );
  end if;
  return v_result;
exception
  when others then
    perform pg_catalog.set_config(
      'app.ai_provider_attempt_transmitted',
      '',
      true
    );
    raise;
end;
$$;

revoke all on function public.complete_ai_polish_provider_attempt(
  uuid, text, boolean, boolean, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.complete_ai_polish_provider_attempt(
  uuid, text, boolean, boolean, jsonb, jsonb, jsonb, jsonb
) to service_role;

revoke execute on function public.capture_ai_provider_attempt_transmission()
  from public, anon, authenticated, service_role;

-- The old six-argument finalize implementation remains the single accounting
-- primitive. Public V1 compatibility is restored through a schema-gated
-- wrapper; V2 is admitted only through the audited seven-argument wrapper.
alter function public.finalize_ai_polish_request(
  uuid, text, boolean, boolean, jsonb, jsonb
) rename to finalize_ai_polish_request_internal;

revoke all on function public.finalize_ai_polish_request_internal(
  uuid, text, boolean, boolean, jsonb, jsonb
) from public, anon, authenticated, service_role;

create function public.derive_ai_polish_v2_settlement(
  p_reservation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.ai_request_ledger%rowtype;
  v_attempt public.ai_provider_attempt_ledger%rowtype;
  v_last_status text;
  v_child_count integer := 0;
  v_attempt_nos smallint[] := array[]::smallint[];
  v_any_unknown_transmission boolean := false;
  v_any_transmission_or_unknown boolean := false;
  v_any_billable boolean := false;
  v_all_nonbillable boolean := true;
  v_status text;
  v_quota_charged boolean;
  v_provider_billable boolean;
begin
  select * into v_request
  from public.ai_request_ledger
  where reservation_id = p_reservation_id
  for update;

  if not found
     or v_request.route_schema_version is distinct from 'route_snapshot_v1'
     or v_request.state is distinct from 'reserved' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'SERVICE_UNAVAILABLE'
    );
  end if;

  for v_attempt in
    select attempt.*
    from public.ai_provider_attempt_ledger as attempt
    where attempt.reservation_id = p_reservation_id
    order by attempt.attempt_no
    for update
  loop
    v_child_count := v_child_count + 1;
    v_attempt_nos := pg_catalog.array_append(v_attempt_nos, v_attempt.attempt_no);
    v_last_status := v_attempt.status;

    if v_attempt.status = 'started' then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'ATTEMPT_IN_PROGRESS'
      );
    end if;

    v_any_transmission_or_unknown := v_any_transmission_or_unknown
      or v_attempt.transmitted is distinct from false;
    v_any_unknown_transmission := v_any_unknown_transmission
      or v_attempt.transmitted is null;
    v_any_billable := v_any_billable or v_attempt.provider_billable is true;
    v_all_nonbillable := v_all_nonbillable
      and v_attempt.provider_billable is false;
  end loop;

  if v_child_count = 0 then
    if v_request.attempt_count is distinct from 0
       or v_request.provider_started_at is not null then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'SERVICE_UNAVAILABLE'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'status', 'released',
      'quotaCharged', false,
      'providerBillable', false,
      'childCount', 0
    );
  end if;

  if v_request.attempt_count is distinct from v_child_count
     or v_attempt_nos not in (
       array[1]::smallint[],
       array[1, 2]::smallint[]
     )
     or v_request.provider_started_at is not null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'SERVICE_UNAVAILABLE'
    );
  end if;

  -- Legacy terminal rows predate the durable adapter-entry fact. Their terminal
  -- status cannot prove whether transmission occurred, so the entire
  -- reservation remains held even when another child has known transmission.
  if v_any_unknown_transmission then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'TRANSMISSION_UNKNOWN_HELD'
    );
  end if;

  v_status := case v_last_status
    when 'succeeded' then 'succeeded'
    when 'canceled' then 'canceled'
    when 'invalid_output' then 'invalid_output'
    when 'failed_upstream' then 'failed_upstream'
    when 'timed_out' then 'failed_upstream'
    -- There is no charged-abandoned accounting path in the inherited
    -- primitive. Unknown transmission therefore remains held, not finalized.
    when 'unknown' then null
    else null
  end;
  if v_status is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'TRANSMISSION_UNKNOWN_HELD'
    );
  end if;

  v_quota_charged := case v_status
    when 'succeeded' then true
    when 'canceled' then v_any_transmission_or_unknown
    when 'failed_upstream' then false
    when 'invalid_output' then false
  end;
  v_provider_billable := case
    when v_any_billable then true
    when v_all_nonbillable then false
    else null
  end;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'status', v_status,
    'quotaCharged', v_quota_charged,
    'providerBillable', v_provider_billable,
    'childCount', v_child_count
  );
end;
$$;

revoke all on function public.derive_ai_polish_v2_settlement(uuid)
  from public, anon, authenticated, service_role;

create function public.finalize_ai_polish_request(
  p_reservation_id uuid,
  p_status text,
  p_quota_charged boolean,
  p_provider_billable boolean default null,
  p_usage jsonb default null,
  p_metadata jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.ai_request_ledger%rowtype;
begin
  select * into v_request
  from public.ai_request_ledger
  where reservation_id = p_reservation_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'NOT_FOUND');
  end if;
  if v_request.route_schema_version is not null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'AUDITED_SIGNATURE_REQUIRED'
    );
  end if;
  if v_request.state is distinct from 'finalized'
     and p_status = 'abandoned' then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'INVALID_STATUS');
  end if;

  return public.finalize_ai_polish_request_internal(
    p_reservation_id,
    p_status,
    p_quota_charged,
    p_provider_billable,
    p_usage,
    p_metadata
  );
end;
$$;

create function public.finalize_ai_polish_request(
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
  select * into v_request
  from public.ai_request_ledger
  where reservation_id = p_reservation_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'NOT_FOUND');
  end if;

  -- Frozen replay precedes hostile assertion parsing, matching V1 behavior.
  if v_request.state = 'finalized' then
    if v_request.status is distinct from p_status
       or v_request.quota_charged is distinct from p_quota_charged
       or v_request.provider_billable is distinct from p_provider_billable then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'FINALIZE_CONFLICT'
      );
    end if;
    -- Let the internal primitive produce the canonical quota snapshot.
    return public.finalize_ai_polish_request_internal(
      p_reservation_id,
      p_status,
      p_quota_charged,
      p_provider_billable,
      p_usage,
      p_metadata
    );
  end if;

  if v_request.route_schema_version is distinct from 'route_snapshot_v1'
     or p_settlement_contract is distinct from 'durable_transmission_v1'
     or p_status not in (
       'succeeded', 'canceled', 'failed_upstream', 'invalid_output', 'released'
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'AUDITED_SETTLEMENT_REJECTED'
    );
  end if;

  v_derived := public.derive_ai_polish_v2_settlement(p_reservation_id);
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
      'ok', false,
      'reason', 'SETTLEMENT_ASSERTION_CONFLICT'
    );
  end if;

  return public.finalize_ai_polish_request_internal(
    p_reservation_id,
    v_derived_status,
    v_derived_quota,
    v_derived_billable,
    p_usage,
    p_metadata
  );
end;
$$;

revoke all on function public.finalize_ai_polish_request(
  uuid, text, boolean, boolean, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_ai_polish_request(
  uuid, text, boolean, boolean, jsonb, jsonb
) to service_role;

revoke all on function public.finalize_ai_polish_request(
  uuid, text, boolean, boolean, jsonb, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_ai_polish_request(
  uuid, text, boolean, boolean, jsonb, jsonb, text
) to service_role;

-- Reconcile with the same child aggregate as request-time finalize. A stale
-- started child is genuinely unknown because this change does not add an
-- independent adapter-entry write. It therefore remains reserved/charged and
-- unfinished (fail closed) instead of being misclassified or refunded.
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
      select attempt.*
      from public.ai_provider_attempt_ledger as attempt
      where attempt.reservation_id = v_request.reservation_id
      order by attempt.attempt_no
      for update
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

    if v_child_count = 0 then
      if v_request.attempt_count = 0
         and v_request.provider_started_at is null then
        v_result := public.finalize_ai_polish_request_internal(
          v_request.reservation_id, 'released', false, false, null, null
        );
        if (v_result ->> 'ok')::boolean is distinct from true then
          raise exception 'stale V2 release failed closed';
        end if;
        v_released := v_released + 1;
      end if;
      continue;
    end if;

    if not v_eligible
       or v_request.attempt_count is distinct from v_child_count
       or v_attempt_nos not in (
         array[1]::smallint[],
         array[1, 2]::smallint[]
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
      -- Admission is not transmission evidence. Keep the reservation charged
      -- and its immutable known siblings intact until an operator can resolve
      -- the genuinely unknown attempt; repeated reconciliation is a no-op.
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
      pg_catalog.jsonb_build_object('usage_schema_version', 'attempt_v2')
    );
    if (v_result ->> 'ok')::boolean is distinct from true then
      raise exception 'stale V2 settlement failed closed';
    end if;
    -- Keep the legacy counter as the number of stale non-release settlements;
    -- the persisted request status is now the exact recovered terminal status.
    v_abandoned := v_abandoned + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'releasedCount', v_released,
    'abandonedCount', v_abandoned,
    'latencyOverflowCount', v_latency_overflow
  ) || case
    when v_held_unknown > 0 then pg_catalog.jsonb_build_object(
      'heldUnknownCount', v_held_unknown
    )
    else '{}'::jsonb
  end;
end;
$$;

revoke execute on function public.reconcile_stale_ai_polish_reservations(interval)
  from public, anon, authenticated;
grant execute on function public.reconcile_stale_ai_polish_reservations(interval)
  to service_role;

commit;
