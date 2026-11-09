begin;
set local search_path = '';
create table admin.environment (
  id smallint primary key check (id = 1),
  name text not null check (name in ('LOCAL', 'PREVIEW', 'PRODUCTION')),
  database_instance_id uuid not null unique,
  contract_code text not null check (contract_code = 'cv_app_db_2')
);
create table admin.members (
  id bigint generated always as identity primary key,
  auth_user_id uuid unique references auth.users (id) on delete set null,
  time_revoked timestamptz,
  revision bigint not null default 1 check (revision > 0),
  active_auth_user_id uuid generated always as ( case when time_revoked is null then
    auth_user_id
  end) stored references auth.users (id) on delete restrict,
  check (time_revoked is not null or auth_user_id is not null)
);
create index ix_active_admin_auth on admin.members (active_auth_user_id)
where
  active_auth_user_id is not null;
create table admin.operations (
  id bigint generated always as identity primary key,
  actor_auth_user_id uuid references auth.users (id) on delete set null,
  operation_key uuid not null,
  operation text not null,
  payload_digest text not null,
  entity_kind text,
  entity_id bigint,
  revision bigint,
  time_committed timestamptz not null default clock_timestamp(),
  unique (actor_auth_user_id, operation_key)
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
    schemaname = 'admin' loop
      execute format('alter table %I.%I enable row level security', 'admin', r.tablename);
      execute format('create policy api_owner on %I.%I to app_api_owner using(true) with check(true)', 'admin', r.tablename);
      execute format('revoke all on %I.%I from public,anon,authenticated,service_role', 'admin', r.tablename);
      execute format('grant select,insert,update,delete on %I.%I to app_api_owner', 'admin', r.tablename);
    end loop;
end
$$;
grant usage, select on all sequences in schema admin to app_api_owner;
commit;
