begin;
set local search_path = '';
create table ai.adapters (
  id smallint primary key check (id in (1, 2, 3)),
  name text not null check (length(btrim(name)) > 0)
);
create table ai.configurations (
  id bigint generated always as identity primary key,
  name text not null check (length(btrim(name)) between 1 and 200),
  adapter_id smallint not null references ai.adapters (id),
  endpoint_url text not null check (length(endpoint_url) <= 2048 and endpoint_url ~ '^https://[^/@?#[:space:]]+(/[^?#[:space:]]*)?$'),
  model_id text not null check (length(btrim(model_id)) between 1 and 200),
  credential_ref text not null check (credential_ref ~ '^AI_PROVIDER_KEY_[A-Z0-9_]+$'),
  legal_document_id bigint not null,
  enabled boolean not null default false,
  revision bigint not null default 1 check (revision > 0)
);
create table ai.prices (
  config_id bigint primary key references ai.configurations (id) on delete restrict,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  input_standard_nanos_per_million bigint not null check (input_standard_nanos_per_million >= 0),
  input_cache_read_nanos_per_million bigint not null check (input_cache_read_nanos_per_million >= 0),
  input_cache_write_nanos_per_million bigint not null check (input_cache_write_nanos_per_million >= 0),
  output_nanos_per_million bigint not null check (output_nanos_per_million >= 0)
);
create table ai.routing_rules (
  id bigint generated always as identity primary key,
  weekday smallint,
  start_minute integer,
  end_minute integer,
  enabled boolean not null default false,
  revision bigint not null default 1 check (revision > 0),
  constraint ck_rule_shape check ((weekday is null and start_minute is null and end_minute is null) or (weekday is not null and start_minute is not null and end_minute is not null and weekday between 1 and 7 and start_minute >= 0 and start_minute < end_minute and end_minute <= 1440)),
  exclude using gist (weekday with =, int4range(start_minute, end_minute, '[)'
) with &&)
where (enabled and weekday is not null)
);
create unique index uq_enabled_fallback on ai.routing_rules ((true))
where
  enabled and weekday is null;
create table ai.routing_rule_configurations (
  rule_id bigint not null references ai.routing_rules (id) on delete cascade,
  config_id bigint not null references ai.configurations (id),
  is_default boolean not null default false,
  primary key (rule_id, config_id)
);
create unique index uq_rule_default on ai.routing_rule_configurations (rule_id)
where
  is_default;
create index ix_rule_config_config on ai.routing_rule_configurations (config_id);
create table ai.runtime_control (
  id smallint primary key check (id = 1),
  enabled boolean not null default false,
  audience text not null default 'ALLOWLIST' check (audience in ('ALLOWLIST', 'ALL')),
  user_daily_limit bigint not null default 20 check (user_daily_limit >= 0),
  global_daily_limit bigint not null default 2000 check (global_daily_limit >= 0),
  user_minute_limit bigint not null default 3 check (user_minute_limit >= 0),
  revision bigint not null default 1 check (revision > 0)
);
create table ai.allowed_users (
  auth_user_id uuid primary key references auth.users (id) on delete cascade
);
create table ai.requests (
  id bigint generated always as identity primary key,
  external_id text not null default common.generate_external_id ('req_'),
  constraint uq_ai_requests_external_id unique (external_id),
  constraint ck_ai_requests_external_id check (common.is_valid_external_id (external_id, 'req_', 12)),
  owner_auth_user_id uuid references auth.users (id) on delete set null,
  client_request_key uuid,
  request_fingerprint text,
  control_revision bigint not null,
  reserve_day date not null,
  provider_admission_day date,
  state text not null default 'RESERVED' check (state in ('RESERVED', 'RUNNING', 'HELD', 'FINALIZED')),
  time_reserved timestamptz not null default clock_timestamp(),
  time_progress timestamptz not null default clock_timestamp(),
  time_canceled timestamptz,
  time_finalized timestamptz,
  outcome text check (outcome in ('SUCCEEDED', 'CANCELED', 'FAILED_UPSTREAM', 'INVALID_OUTPUT', 'RELEASED')),
  charged boolean,
  unique (owner_auth_user_id, client_request_key),
  check ((owner_auth_user_id is null and client_request_key is null and request_fingerprint is null) or (owner_auth_user_id is not null and client_request_key is not null and request_fingerprint is not null))
);
create table ai.request_snapshots (
  request_id bigint primary key references ai.requests (id) on delete cascade,
  config_id bigint not null,
  config_audit_id bigint not null,
  config_name text not null,
  config_revision bigint not null,
  adapter_id smallint not null check (adapter_id in (1, 2, 3)),
  execution_contract text not null,
  endpoint_url text not null,
  model_id text not null,
  credential_ref text not null,
  currency text not null,
  input_standard_nanos_per_million bigint not null,
  input_cache_read_nanos_per_million bigint not null,
  input_cache_write_nanos_per_million bigint not null,
  output_nanos_per_million bigint not null,
  common_acceptance_audit_id bigint not null,
  provider_acceptance_audit_id bigint not null
);
create table ai.attempts (
  request_id bigint not null references ai.requests (id) on delete cascade,
  attempt_no smallint not null check (attempt_no in (1, 2)),
  state text not null default 'STARTED' check (state in ('STARTED', 'SUCCEEDED', 'CANCELED', 'FAILED_UPSTREAM', 'TIMED_OUT', 'INVALID_OUTPUT', 'UNKNOWN')),
  time_started timestamptz not null default clock_timestamp(),
  time_terminal timestamptz,
  transmitted boolean,
  provider_billable boolean,
  retry_allowed boolean,
  usage_complete boolean,
  input_total bigint check (input_total >= 0),
  input_standard bigint check (input_standard >= 0),
  cache_read bigint check (cache_read >= 0),
  cache_write bigint check (cache_write >= 0),
  output bigint check (output >= 0),
  reasoning bigint check (reasoning >= 0),
  estimated_cost_nanos bigint check (estimated_cost_nanos >= 0),
  known_estimated_cost_nanos bigint check (known_estimated_cost_nanos >= 0),
  cost_incomplete boolean not null default true,
  cost_overflow boolean not null default false,
  fact_digest text,
  primary key (request_id, attempt_no)
);
create table ai.user_quota_daily (
  auth_user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  reserved_count bigint not null default 0 check (reserved_count >= 0),
  charged_count bigint not null default 0 check (charged_count >= 0),
  primary key (auth_user_id, day)
);
create table ai.global_quota_daily (
  day date primary key,
  admitted_count bigint not null default 0 check (admitted_count >= 0)
);
create table ai.rate_minutes (
  auth_user_id uuid not null references auth.users (id) on delete cascade,
  minute_bucket timestamptz not null,
  request_count bigint not null default 0 check (request_count >= 0),
  primary key (auth_user_id, minute_bucket)
);
create table ai.configuration_usage_daily (
  day date not null,
  config_audit_id bigint not null,
  currency text not null,
  settled_count bigint not null default 0,
  succeeded_count bigint not null default 0,
  failed_count bigint not null default 0,
  canceled_count bigint not null default 0,
  released_count bigint not null default 0,
  attempt_count bigint not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  known_estimated_cost_nanos bigint not null default 0,
  incomplete_usage_count bigint not null default 0,
  incomplete_cost_count bigint not null default 0,
  primary key (day, config_audit_id, currency)
);
create index ix_requests_reconcile on ai.requests (time_progress, id)
where
  state <> 'FINALIZED';
create index ix_requests_owner_time on ai.requests (owner_auth_user_id, time_reserved desc, id desc);
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
    schemaname = 'ai' loop
      execute format('alter table %I.%I enable row level security', 'ai', r.tablename);
      execute format('create policy api_owner on %I.%I to app_api_owner using(true) with check(true)', 'ai', r.tablename);
      execute format('revoke all on %I.%I from public,anon,authenticated,service_role', 'ai', r.tablename);
      execute format('grant select,insert,update,delete on %I.%I to app_api_owner', 'ai', r.tablename);
    end loop;
end
$$;
grant usage, select on all sequences in schema ai to app_api_owner;
commit;
