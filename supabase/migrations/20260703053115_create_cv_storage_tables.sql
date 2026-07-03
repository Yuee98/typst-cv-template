create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.cv_documents (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  storage_mode text not null check (storage_mode in ('plain', 'encrypted')),
  data jsonb,
  encrypted_payload jsonb,
  schema_version integer not null default 5,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint cv_documents_title_not_blank check (length(btrim(title)) > 0),
  constraint cv_documents_body_matches_storage_mode check (
    (
      storage_mode = 'plain'
      and data is not null
      and encrypted_payload is null
    )
    or
    (
      storage_mode = 'encrypted'
      and data is null
      and encrypted_payload is not null
    )
  )
);

create index cv_documents_user_updated_idx
on public.cv_documents (user_id, updated_at desc);

create trigger set_cv_documents_updated_at
before update on public.cv_documents
for each row
execute function public.set_updated_at();

alter table public.cv_documents enable row level security;

grant select, insert, update, delete on public.cv_documents to authenticated;

create policy "Users can read their own CV documents"
on public.cv_documents
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can insert their own CV documents"
on public.cv_documents
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their own CV documents"
on public.cv_documents
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their own CV documents"
on public.cv_documents
for delete
to authenticated
using ((select auth.uid()) = user_id);

create table public.cv_key_wrappings (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('passphrase', 'device')),
  device_name text,
  wrapped_vault_key jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,

  constraint cv_key_wrappings_device_name_not_blank check (
    device_name is null or length(btrim(device_name)) > 0
  )
);

create index cv_key_wrappings_user_kind_idx
on public.cv_key_wrappings (user_id, kind);

create unique index cv_key_wrappings_one_passphrase_per_user_idx
on public.cv_key_wrappings (user_id)
where kind = 'passphrase';

create trigger set_cv_key_wrappings_updated_at
before update on public.cv_key_wrappings
for each row
execute function public.set_updated_at();

alter table public.cv_key_wrappings enable row level security;

grant select, insert, update, delete on public.cv_key_wrappings to authenticated;

create policy "Users can read their own key wrappings"
on public.cv_key_wrappings
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can insert their own key wrappings"
on public.cv_key_wrappings
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their own key wrappings"
on public.cv_key_wrappings
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their own key wrappings"
on public.cv_key_wrappings
for delete
to authenticated
using ((select auth.uid()) = user_id);
