-- A deliberately tiny, read-only database call for the scheduled GitHub
-- Actions keepalive. The publishable key maps unauthenticated requests to the
-- anon role, so expose only this function and no application data.
create or replace function public.keep_project_active()
returns timestamptz
language sql
stable
security invoker
set search_path = ''
as $$
  select now();
$$;

comment on function public.keep_project_active() is
  'Returns the transaction timestamp for a read-only project keepalive query.';

revoke all on function public.keep_project_active() from public, authenticated, service_role;
grant execute on function public.keep_project_active() to anon;
