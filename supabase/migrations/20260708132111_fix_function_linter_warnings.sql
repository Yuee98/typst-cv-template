-- Fix search_path warnings for trigger and helper functions
-- by pinning search_path to the empty string so no user schema
-- can be injected via search_path manipulation.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.current_terms_version()
returns text
language sql
stable
set search_path = ''
as $$
  select '2026-07-03'::text;
$$;

-- has_accepted_current_terms is only used inside RLS policies and does not
-- need to bypass RLS, so run as the invoking user (SECURITY INVOKER).
-- Also restrict execution to authenticated/service_role only so anon cannot
-- call it via the PostgREST RPC endpoint.
create or replace function public.has_accepted_current_terms()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_terms_acceptances
    where user_id = auth.uid()
      and document_key = 'terms'
      and version = public.current_terms_version()
  );
$$;

revoke execute on function public.has_accepted_current_terms() from public;
grant execute on function public.has_accepted_current_terms() to authenticated, service_role;
