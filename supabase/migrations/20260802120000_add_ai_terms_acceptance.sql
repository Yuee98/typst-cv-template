-- Add AI polish terms ("ai_terms") as a second accepted legal document
-- alongside the existing Terms of Use ("terms") in user_terms_acceptances.

-- 1. Widen the document_key check so both document keys are allowed.
alter table public.user_terms_acceptances
  drop constraint user_terms_acceptances_document_key_check;

alter table public.user_terms_acceptances
  add constraint user_terms_acceptances_document_key_check
  check (document_key in ('terms', 'ai_terms'));

-- 2. Version function for the AI terms, mirroring current_terms_version().
create or replace function public.current_ai_terms_version()
returns text
language sql
stable
set search_path = ''
as $$
  select '2026-08-02'::text;
$$;

revoke execute on function public.current_ai_terms_version() from public;
grant execute on function public.current_ai_terms_version() to authenticated, service_role;

-- 3. RLS: users can only insert the current ai_terms version for themselves.
-- The existing select policy ("Users can read their own terms acceptances")
-- is not scoped to a document_key, so it already covers ai_terms rows.
create policy "Users can accept current ai terms for themselves"
on public.user_terms_acceptances
for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and document_key = 'ai_terms'
  and version = public.current_ai_terms_version()
);

-- 4. Acceptance check helper, mirroring has_accepted_current_terms():
-- security invoker (no need to bypass RLS), pinned search_path, and
-- execution restricted to authenticated/service_role.
create or replace function public.has_accepted_current_ai_terms()
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
      and document_key = 'ai_terms'
      and version = public.current_ai_terms_version()
  );
$$;

revoke execute on function public.has_accepted_current_ai_terms() from public;
grant execute on function public.has_accepted_current_ai_terms() to authenticated, service_role;
