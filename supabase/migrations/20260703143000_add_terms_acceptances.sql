create or replace function public.current_terms_version()
returns text
language sql
stable
as $$
  select '2026-07-03'::text;
$$;

create table public.user_terms_acceptances (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  document_key text not null default 'terms',
  version text not null,
  accepted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint user_terms_acceptances_document_key_check check (document_key = 'terms'),
  constraint user_terms_acceptances_version_not_blank check (length(btrim(version)) > 0),
  constraint user_terms_acceptances_unique_version unique (user_id, document_key, version)
);

create index user_terms_acceptances_user_idx
on public.user_terms_acceptances (user_id, document_key, version);

alter table public.user_terms_acceptances enable row level security;

grant select, insert on public.user_terms_acceptances to authenticated, service_role;
grant execute on function public.current_terms_version() to authenticated, service_role;

create policy "Users can read their own terms acceptances"
on public.user_terms_acceptances
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can accept current terms for themselves"
on public.user_terms_acceptances
for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and document_key = 'terms'
  and version = public.current_terms_version()
);

create or replace function public.has_accepted_current_terms()
returns boolean
language sql
stable
security definer
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

grant execute on function public.has_accepted_current_terms() to authenticated, service_role;

drop policy if exists "Users can read their own CV documents" on public.cv_documents;
drop policy if exists "Users can insert their own CV documents" on public.cv_documents;
drop policy if exists "Users can update their own CV documents" on public.cv_documents;
drop policy if exists "Users can delete their own CV documents" on public.cv_documents;

create policy "Users can read their own CV documents after accepting terms"
on public.cv_documents
for select
to authenticated
using ((select auth.uid()) = user_id and public.has_accepted_current_terms());

create policy "Users can insert their own CV documents after accepting terms"
on public.cv_documents
for insert
to authenticated
with check ((select auth.uid()) = user_id and public.has_accepted_current_terms());

create policy "Users can update their own CV documents after accepting terms"
on public.cv_documents
for update
to authenticated
using ((select auth.uid()) = user_id and public.has_accepted_current_terms())
with check ((select auth.uid()) = user_id and public.has_accepted_current_terms());

create policy "Users can delete their own CV documents"
on public.cv_documents
for delete
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can read their own key wrappings" on public.cv_key_wrappings;
drop policy if exists "Users can insert their own key wrappings" on public.cv_key_wrappings;
drop policy if exists "Users can update their own key wrappings" on public.cv_key_wrappings;
drop policy if exists "Users can delete their own key wrappings" on public.cv_key_wrappings;

create policy "Users can read their own key wrappings after accepting terms"
on public.cv_key_wrappings
for select
to authenticated
using ((select auth.uid()) = user_id and public.has_accepted_current_terms());

create policy "Users can insert their own key wrappings after accepting terms"
on public.cv_key_wrappings
for insert
to authenticated
with check ((select auth.uid()) = user_id and public.has_accepted_current_terms());

create policy "Users can update their own key wrappings after accepting terms"
on public.cv_key_wrappings
for update
to authenticated
using ((select auth.uid()) = user_id and public.has_accepted_current_terms())
with check ((select auth.uid()) = user_id and public.has_accepted_current_terms());

create policy "Users can delete their own key wrappings"
on public.cv_key_wrappings
for delete
to authenticated
using ((select auth.uid()) = user_id);
