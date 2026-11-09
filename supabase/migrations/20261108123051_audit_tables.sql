begin;
set local search_path = '';
create table audit.configurations (
  audit_id bigint generated always as identity primary key,
  operation_id bigint references admin.operations (id),
  time_changed timestamptz not null default clock_timestamp(),
  actor_kind text not null check (actor_kind in ('USER', 'SYSTEM', 'MIGRATION')),
  actor_auth_user_id uuid,
  reason text not null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  id bigint,
  name text,
  display_name text,
  adapter_id smallint,
  endpoint_url text,
  model_id text,
  credential_ref text,
  legal_document_id bigint,
  enabled boolean,
  revision bigint
);
create index ix_configurations_history on audit.configurations (id, audit_id desc);
create table audit.prices (
  audit_id bigint generated always as identity primary key,
  operation_id bigint references admin.operations (id),
  time_changed timestamptz not null default clock_timestamp(),
  actor_kind text not null check (actor_kind in ('USER', 'SYSTEM', 'MIGRATION')),
  actor_auth_user_id uuid,
  reason text not null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  config_id bigint,
  currency text,
  input_standard_nanos_per_million bigint,
  input_cache_read_nanos_per_million bigint,
  input_cache_write_nanos_per_million bigint,
  output_nanos_per_million bigint
);
create index ix_prices_history on audit.prices (config_id, audit_id desc);
create table audit.rules (
  audit_id bigint generated always as identity primary key,
  operation_id bigint references admin.operations (id),
  time_changed timestamptz not null default clock_timestamp(),
  actor_kind text not null check (actor_kind in ('USER', 'SYSTEM', 'MIGRATION')),
  actor_auth_user_id uuid,
  reason text not null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  id bigint,
  weekday smallint,
  start_minute integer,
  end_minute integer,
  enabled boolean,
  revision bigint
);
create index ix_rules_history on audit.rules (id, audit_id desc);
create table audit.rule_members (
  audit_id bigint generated always as identity primary key,
  operation_id bigint references admin.operations (id),
  time_changed timestamptz not null default clock_timestamp(),
  actor_kind text not null check (actor_kind in ('USER', 'SYSTEM', 'MIGRATION')),
  actor_auth_user_id uuid,
  reason text not null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  rule_id bigint,
  config_id bigint,
  is_default boolean
);
create index ix_rule_members_history on audit.rule_members (config_id, audit_id desc);
create table audit.runtime_control (
  audit_id bigint generated always as identity primary key,
  operation_id bigint references admin.operations (id),
  time_changed timestamptz not null default clock_timestamp(),
  actor_kind text not null check (actor_kind in ('USER', 'SYSTEM', 'MIGRATION')),
  actor_auth_user_id uuid,
  reason text not null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  id smallint,
  enabled boolean,
  audience text,
  user_daily_limit bigint,
  global_daily_limit bigint,
  user_minute_limit bigint,
  revision bigint
);
create index ix_runtime_control_history on audit.runtime_control (id, audit_id desc);
create table audit.allowed_users (
  audit_id bigint generated always as identity primary key,
  operation_id bigint references admin.operations (id),
  time_changed timestamptz not null default clock_timestamp(),
  actor_kind text not null check (actor_kind in ('USER', 'SYSTEM', 'MIGRATION')),
  actor_auth_user_id uuid,
  reason text not null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  auth_user_id uuid
);
create index ix_allowed_users_history on audit.allowed_users (auth_user_id, audit_id desc);
create table audit.documents (
  audit_id bigint generated always as identity primary key,
  operation_id bigint references admin.operations (id),
  time_changed timestamptz not null default clock_timestamp(),
  actor_kind text not null check (actor_kind in ('USER', 'SYSTEM', 'MIGRATION')),
  actor_auth_user_id uuid,
  reason text not null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  id bigint,
  external_id text,
  kind text,
  zh_title text,
  en_title text,
  zh_body text,
  en_body text,
  effective_date date,
  recipient_name text,
  enabled boolean,
  revision bigint,
  content_digest text
);
create index ix_documents_history on audit.documents (id, audit_id desc);
create table audit.acceptances (
  audit_id bigint generated always as identity primary key,
  operation_id bigint references admin.operations (id),
  time_changed timestamptz not null default clock_timestamp(),
  actor_kind text not null check (actor_kind in ('USER', 'SYSTEM', 'MIGRATION')),
  actor_auth_user_id uuid,
  reason text not null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  id bigint,
  owner_auth_user_id uuid,
  document_id bigint,
  document_audit_id bigint,
  time_accepted timestamptz
);
create index ix_acceptances_history on audit.acceptances (id, audit_id desc);
create table audit.members (
  audit_id bigint generated always as identity primary key,
  operation_id bigint references admin.operations (id),
  time_changed timestamptz not null default clock_timestamp(),
  actor_kind text not null check (actor_kind in ('USER', 'SYSTEM', 'MIGRATION')),
  actor_auth_user_id uuid,
  reason text not null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  id bigint,
  auth_user_id uuid,
  time_revoked timestamptz,
  revision bigint
);
create index ix_members_history on audit.members (id, audit_id desc);
create table audit.environment (
  audit_id bigint generated always as identity primary key,
  operation_id bigint references admin.operations (id),
  time_changed timestamptz not null default clock_timestamp(),
  actor_kind text not null check (actor_kind in ('USER', 'SYSTEM', 'MIGRATION')),
  actor_auth_user_id uuid,
  reason text not null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  id smallint,
  name text,
  database_instance_id uuid,
  contract_code text
);
create index ix_environment_history on audit.environment (id, audit_id desc);
create unique index uq_document_audit_identity on audit.documents (audit_id, id);
create unique index uq_acceptance_audit_identity on audit.acceptances (audit_id, id);
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
    schemaname = 'audit' loop
      execute format('alter table audit.%I enable row level security', r.tablename);
      execute format('create policy api_owner on audit.%I to app_api_owner using(true) with check(true)', r.tablename);
    end loop;
end
$$;
grant usage, select on all sequences in schema audit to app_api_owner;
grant select, insert on all tables in schema audit to app_api_owner;
commit;
