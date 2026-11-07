-- A full batch of unchanged indeterminate HELD requests must not starve recovery.
begin;
create or replace function ai.reconcile (p_limit integer default 100)
  returns integer
  language plpgsql
  volatile
  security invoker
  set search_path = ''
as $$
declare
  v_request record;
  v_count integer := 0;
begin
  if not exists (select 1 from admin.environment where id = 1) then
    return 0;
  end if;
  if p_limit is null or p_limit not between 1 and 1000 then
    perform common.fail ('INVALID_REQUEST');
  end if;
  perform 1 from ai.runtime_control where id = 1 for update;
  for v_request in
    select r.id
    from ai.requests r
    where r.state in ('RESERVED', 'RUNNING', 'HELD')
      and r.time_progress < clock_timestamp() - interval '600 seconds'
      and (
        r.state <> 'HELD'
        or not exists (
          select 1 from ai.attempts a
          where a.request_id = r.id and a.state in ('STARTED', 'UNKNOWN')
        )
      )
    order by r.id
    limit p_limit
    for update of r skip locked
  loop
    if exists (
      select 1 from ai.attempts a
      where a.request_id = v_request.id and a.state in ('STARTED', 'UNKNOWN')
    ) then
      -- Hold a newly stale in-flight request once. Its unchanged unknown facts
      -- are not actionable again until a trusted producer records completion.
      update ai.requests set state = 'HELD' where id = v_request.id;
    else
      perform ai.finalize_locked (v_request.id);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;
revoke all on function ai.reconcile (integer) from public, anon, authenticated, service_role, app_api_owner;
comment on function ai.reconcile (integer) is 'Owner/cron-only bounded recovery. Stale in-flight requests transition to HELD once; unchanged HELD requests with STARTED/UNKNOWN attempts do not consume batch slots. Zero-attempt and fully known terminal requests progress, including HELD requests after trusted late completion. Unknown facts, reserved quota, control-first lock order and idempotent settlement remain unchanged.';
commit;
