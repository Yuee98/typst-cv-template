begin;
set local search_path = '';
create table cv.documents (
  id bigint generated always as identity primary key,
  time_created timestamptz not null default clock_timestamp(),
  external_id text not null default common.generate_external_id ('cv_'),
  constraint uq_cv_documents_external_id unique (external_id),
  constraint ck_cv_documents_external_id check (common.is_valid_external_id (external_id, 'cv_', 12)),
  time_updated timestamptz not null default clock_timestamp(),
  revision bigint not null default 1 check (revision > 0),
  owner_auth_user_id uuid not null references auth.users (id) on delete cascade,
  client_create_key uuid not null,
  create_payload_digest text not null,
  title text not null check (length(btrim(title)) between 1 and 200),
  storage_mode text not null check (storage_mode in ('PLAIN', 'ENCRYPTED')),
  data jsonb,
  encrypted_payload jsonb,
  document_schema_version integer not null check (document_schema_version = 7),
  user_created uuid not null,
  user_updated uuid not null,
  unique (owner_auth_user_id, client_create_key),
  check ((storage_mode = 'PLAIN' and data is not null and encrypted_payload is null) or (storage_mode = 'ENCRYPTED' and data is null and encrypted_payload is not null))
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
    schemaname = 'cv' loop
      execute format('alter table %I.%I enable row level security', 'cv', r.tablename);
      execute format('create policy api_owner on %I.%I to app_api_owner using(true) with check(true)', 'cv', r.tablename);
      execute format('revoke all on %I.%I from public,anon,authenticated,service_role', 'cv', r.tablename);
      execute format('grant select,insert,update,delete on %I.%I to app_api_owner', 'cv', r.tablename);
    end loop;
end
$$;
grant usage, select on all sequences in schema cv to app_api_owner;
commit;
