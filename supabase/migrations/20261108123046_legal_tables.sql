begin;
set local search_path = '';
create table legal.documents (
  id bigint generated always as identity primary key,
  external_id text not null default common.generate_external_id ('ldoc_'),
  constraint uq_legal_documents_external_id unique (external_id),
  constraint ck_legal_documents_external_id check (common.is_valid_external_id (external_id, 'ldoc_', 12)),
  kind text not null check (kind in ('TERMS', 'AI_COMMON', 'AI_PROVIDER')),
  zh_title text not null,
  en_title text not null,
  zh_body text not null,
  en_body text not null,
  effective_date date not null,
  recipient_name text,
  enabled boolean not null default false,
  revision bigint not null default 1 check (revision > 0),
  content_digest text not null,
  document_audit_id bigint,
  constraint ck_document_recipient check ((kind = 'AI_PROVIDER' and recipient_name is not null and length(btrim(recipient_name)) between 1 and 500) or (kind <> 'AI_PROVIDER' and recipient_name is null))
);
create unique index uq_general_document on legal.documents (kind)
where
  kind <> 'AI_PROVIDER';
create table legal.acceptances (
  id bigint generated always as identity primary key,
  owner_auth_user_id uuid not null references auth.users (id) on delete cascade,
  document_id bigint not null references legal.documents (id),
  document_audit_id bigint not null,
  time_accepted timestamptz not null default clock_timestamp(),
  unique (owner_auth_user_id, document_id)
);
do $$
declare
  r record;
begin
  for r in
  select
    tablename
  from
    pg_catalog.pg_tables
  where
    schemaname = 'legal' loop
      execute format('alter table %I.%I enable row level security', 'legal', r.tablename);
      execute format('create policy api_owner on %I.%I to app_api_owner using(true) with check(true)', 'legal', r.tablename);
      execute format('revoke all on %I.%I from public,anon,authenticated,service_role', 'legal', r.tablename);
      execute format('grant select,insert,update,delete on %I.%I to app_api_owner', 'legal', r.tablename);
    end loop;
end
$$;
grant usage, select on all sequences in schema legal to app_api_owner;
commit;
