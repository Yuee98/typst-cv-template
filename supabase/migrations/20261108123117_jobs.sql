begin;
set local search_path = '';
create function ai.reconcile (p_limit integer default 100)
  returns integer
  language plpgsql
  set search_path = ''
  as $$
declare
  i bigint;
  n integer := 0;
begin
  -- Exclude irreducibly unknown/started facts so oldest held work cannot starve actionable rows.
  for i in
  select
    r.id
  from
    ai.requests r
  where
    r.state <> 'FINALIZED'
    and not exists (
      select
        1
      from
        ai.attempts a
      where
        a.request_id = r.id
        and (a.state in ('STARTED', 'UNKNOWN')
          or a.transmitted is null))
    and (exists (
        select
          1
        from
          ai.attempts a
        where
          a.request_id = r.id)
        or r.time_reserved < common.now() - interval '10 minutes')
  order by
    r.time_progress,
    r.id
  limit greatest (0, least (p_limit, 1000))
  for update
    skip locked loop
      perform
        ai.finalize_locked (i);
      n = n + 1;
    end loop;
  return n;
end
$$;
create function ai.retention_cleanup (p_limit integer default 1000)
  returns integer
  language plpgsql
  set search_path = ''
  as $$
declare
  n integer;
begin
  delete from ai.rate_minutes
  where minute_bucket < common.now() - interval '2 days';
  with old as (
    select
      id
    from
      ai.requests
    where
      state = 'FINALIZED'
      and time_finalized < common.now() - interval '90 days'
    order by
      id
    limit greatest (0, least (p_limit, 10000))
    for update
      skip locked)
  delete from ai.requests
  where id in (
      select
        id
      from
        old);
  get diagnostics n = row_count;
  return n;
end
$$;
create function ai.register_jobs ()
  returns void
  language plpgsql
  set search_path = ''
  as $$
declare
  j bigint;
begin
  j = cron.schedule ('cv-ai-reconcile', '* * * * *', 'select ai.reconcile(100)');
  perform
    cron.alter_job (j, active := false);
  j = cron.schedule ('cv-ai-retention', '17 3 * * *', 'select ai.retention_cleanup(1000)');
  perform
    cron.alter_job (j, active := false);
end
$$;
revoke all on function ai.reconcile (integer), ai.retention_cleanup (integer), ai.register_jobs () from public, anon, authenticated, service_role, app_api_owner;
comment on function ai.register_jobs () is 'Owner-only registration; both jobs inactive until explicit environment rollout.';
commit;
