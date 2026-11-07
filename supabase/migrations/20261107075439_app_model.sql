-- Explicit file transaction also protects CLI versions that execute statements separately.
begin;
set local search_path = pg_catalog, extensions;
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
create table ai.capabilities (
  id smallint primary key,
  code text not null unique,
  name text not null,
  description text not null,
  adapter_kind text not null,
  wire_api_kind text not null,
  execution_contract text not null,
  calculator_kind text not null,
  cache_policy text not null,
  descriptor_digest text not null,
  time_created timestamptz not null default clock_timestamp(),
  time_deprecated timestamptz
);
create table ai.providers (
  id bigint generated always as identity primary key,
  time_created timestamptz not null default clock_timestamp(),
  external_id text not null default common.generate_external_id ('prv_'),
  constraint uq_ai_providers_external_id unique (external_id),
  constraint ck_ai_providers_external_id check (common.is_valid_external_id (external_id, 'prv_', 12)),
  time_updated timestamptz not null default clock_timestamp(),
  revision bigint not null default 1 check (revision > 0),
  code text not null unique,
  name text not null,
  description text not null,
  recipient_code text not null,
  gateway_kind text not null,
  default_capability_id smallint references ai.capabilities (id),
  default_endpoint_url text,
  default_credential_ref text,
  default_model_id text,
  time_archived timestamptz,
  user_created uuid,
  user_updated uuid
);
create table ai.profiles (
  id bigint generated always as identity primary key,
  time_created timestamptz not null default clock_timestamp(),
  external_id text not null default common.generate_external_id ('prf_'),
  constraint uq_ai_profiles_external_id unique (external_id),
  constraint ck_ai_profiles_external_id check (common.is_valid_external_id (external_id, 'prf_', 12)),
  time_updated timestamptz not null default clock_timestamp(),
  revision bigint not null default 1 check (revision > 0),
  provider_id bigint not null references ai.providers (id),
  code text not null,
  name text not null,
  description text not null,
  time_retired timestamptz,
  user_created uuid,
  user_updated uuid,
  unique (provider_id, code),
  unique (id, provider_id)
);
create table legal.document_versions (
  id bigint generated always as identity primary key,
  time_created timestamptz not null default clock_timestamp(),
  external_id text not null default common.generate_external_id ('ldv_'),
  constraint uq_legal_document_versions_external_id unique (external_id),
  constraint ck_legal_document_versions_external_id check (common.is_valid_external_id (external_id, 'ldv_', 12)),
  document_code text not null check (document_code in ('TERMS', 'AI_TERMS')),
  version integer not null check (version > 0),
  renderer_contract text not null,
  content jsonb not null,
  content_digest text not null,
  unique (document_code, version)
);
create table legal.bundles (
  id bigint generated always as identity primary key,
  time_created timestamptz not null default clock_timestamp(),
  external_id text not null default common.generate_external_id ('lgb_'),
  constraint uq_legal_bundles_external_id unique (external_id),
  constraint ck_legal_bundles_external_id check (common.is_valid_external_id (external_id, 'lgb_', 12)),
  code text not null unique,
  ai_document_version_id bigint not null references legal.document_versions (id),
  manifest jsonb not null,
  manifest_digest text not null,
  time_sealed timestamptz
);
create table legal.disclosures (
  id bigint generated always as identity primary key,
  time_created timestamptz not null default clock_timestamp(),
  external_id text not null default common.generate_external_id ('lds_'),
  constraint uq_legal_disclosures_external_id unique (external_id),
  constraint ck_legal_disclosures_external_id check (common.is_valid_external_id (external_id, 'lds_', 12)),
  bundle_id bigint not null references legal.bundles (id),
  provider_id bigint not null references ai.providers (id),
  disclosure_code text not null,
  renderer_contract text not null,
  model_id text not null,
  recipient_code text not null,
  content jsonb not null,
  content_digest text not null,
  unique (bundle_id, disclosure_code),
  unique (id, bundle_id, provider_id)
);
create table ai.profile_versions (
  id bigint generated always as identity primary key,
  time_created timestamptz not null default clock_timestamp(),
  external_id text not null default common.generate_external_id ('pfv_'),
  constraint uq_ai_profile_versions_external_id unique (external_id),
  constraint ck_ai_profile_versions_external_id check (common.is_valid_external_id (external_id, 'pfv_', 12)),
  profile_id bigint not null references ai.profiles (id),
  version integer not null check (version > 0),
  provider_id bigint not null references ai.providers (id),
  capability_id smallint not null references ai.capabilities (id),
  endpoint_url text not null,
  credential_ref text not null,
  model_id text not null,
  adapter_config jsonb not null,
  config_digest text not null,
  legal_disclosure_id bigint not null,
  legal_bundle_id bigint not null,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED', 'RETIRED')),
  time_published timestamptz,
  time_retired timestamptz,
  user_created uuid,
  user_published uuid,
  user_retired uuid,
  unique (profile_id, version),
  unique (id, legal_bundle_id),
  foreign key (profile_id, provider_id) references ai.profiles (id, provider_id),
  foreign key (legal_disclosure_id, legal_bundle_id, provider_id) references legal.disclosures (id, bundle_id, provider_id)
);
create table ai.price_versions (
  creation_txid xid8 not null default pg_current_xact_id (),
  id bigint generated always as identity primary key,
  time_created timestamptz not null default clock_timestamp(),
  external_id text not null default common.generate_external_id ('pcv_'),
  constraint uq_ai_price_versions_external_id unique (external_id),
  constraint ck_ai_price_versions_external_id check (common.is_valid_external_id (external_id, 'pcv_', 12)),
  profile_version_id bigint not null references ai.profile_versions (id),
  lane_code text not null,
  version integer not null check (version > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  calculator_kind text not null,
  parameters jsonb not null,
  time_valid_from timestamptz not null,
  time_valid_until timestamptz,
  time_closed timestamptz,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED', 'RETIRED')),
  config_digest text not null,
  time_published timestamptz,
  time_retired timestamptz,
  user_created uuid,
  user_published uuid,
  user_retired uuid,
  unique (profile_version_id, lane_code, version),
  unique (id, profile_version_id),
  check (coalesce(least (time_valid_until, time_closed), 'infinity'::timestamptz) > time_valid_from),
  exclude using gist (profile_version_id with =, lane_code with =, tstzrange(time_valid_from, least (time_valid_until, time_closed), '[)'
) with &&)
where (time_published is not null)
);
create table ai.price_components (
  price_version_id bigint not null references ai.price_versions (id) on delete cascade,
  component text not null check (component in ('INPUT_STANDARD', 'INPUT_CACHE_READ', 'INPUT_CACHE_WRITE', 'OUTPUT')),
  nanos_per_million bigint not null check (nanos_per_million >= 0),
  primary key (price_version_id, component)
);
create table ai.policies (
  id bigint generated always as identity primary key,
  time_created timestamptz not null default clock_timestamp(),
  external_id text not null default common.generate_external_id ('pol_'),
  constraint uq_ai_policies_external_id unique (external_id),
  constraint ck_ai_policies_external_id check (common.is_valid_external_id (external_id, 'pol_', 12)),
  time_updated timestamptz not null default clock_timestamp(),
  revision bigint not null default 1 check (revision > 0),
  code text not null unique,
  name text not null,
  description text not null,
  time_retired timestamptz,
  user_created uuid,
  user_updated uuid
);
create table ai.policy_versions (
  creation_txid xid8 not null default pg_current_xact_id (),
  id bigint generated always as identity primary key,
  time_created timestamptz not null default clock_timestamp(),
  external_id text not null default common.generate_external_id ('plv_'),
  constraint uq_ai_policy_versions_external_id unique (external_id),
  constraint ck_ai_policy_versions_external_id check (common.is_valid_external_id (external_id, 'plv_', 12)),
  policy_id bigint not null references ai.policies (id),
  version integer not null check (version > 0),
  legal_bundle_id bigint not null references legal.bundles (id),
  time_zone text not null default 'Asia/Shanghai' check (time_zone = 'Asia/Shanghai'),
  config_digest text not null,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED', 'RETIRED')),
  time_published timestamptz,
  time_retired timestamptz,
  user_created uuid,
  user_published uuid,
  user_retired uuid,
  unique (policy_id, version),
  unique (id, legal_bundle_id)
);
create table ai.policy_options (
  id bigint generated always as identity primary key,
  time_created timestamptz not null default clock_timestamp(),
  external_id text not null default common.generate_external_id ('opt_'),
  constraint uq_ai_policy_options_external_id unique (external_id),
  constraint ck_ai_policy_options_external_id check (common.is_valid_external_id (external_id, 'opt_', 12)),
  policy_version_id bigint not null,
  legal_bundle_id bigint not null,
  profile_version_id bigint not null,
  price_lane_code text not null,
  display_order integer not null check (display_order >= 0),
  unique (policy_version_id, profile_version_id, price_lane_code),
  unique (policy_version_id, id),
  unique (id, profile_version_id),
  foreign key (policy_version_id, legal_bundle_id) references ai.policy_versions (id, legal_bundle_id),
  foreign key (profile_version_id, legal_bundle_id) references ai.profile_versions (id, legal_bundle_id)
);
create table ai.routing_rules (
  policy_version_id bigint not null references ai.policy_versions (id),
  ordinal integer not null check (ordinal >= 0),
  is_fallback boolean not null,
  weekday smallint,
  start_minute integer,
  end_minute integer,
  default_option_id bigint not null,
  primary key (policy_version_id, ordinal),
  check ((is_fallback and weekday is null and start_minute is null and end_minute is null) or (not is_fallback and weekday is not null and start_minute is not null and end_minute is not null and weekday between 1 and 7 and 0 <= start_minute and start_minute < end_minute and end_minute <= 1440)),
  exclude using gist (policy_version_id with =, weekday with =, int4range(start_minute, end_minute, '[)'
) with &&)
where (not is_fallback)
);
create table ai.routing_rule_options (
  policy_version_id bigint not null,
  rule_ordinal integer not null,
  option_id bigint not null,
  primary key (policy_version_id, rule_ordinal, option_id),
  foreign key (policy_version_id, rule_ordinal) references ai.routing_rules (policy_version_id, ordinal) deferrable initially deferred,
  foreign key (policy_version_id, option_id) references ai.policy_options (policy_version_id, id)
);
alter table ai.routing_rules
  add constraint fk_default_rule_member foreign key (policy_version_id, ordinal, default_option_id) references ai.routing_rule_options (policy_version_id, rule_ordinal, option_id) deferrable initially deferred;
create unique index uq_policy_fallback on ai.routing_rules (policy_version_id)
where
  is_fallback;
create table ai.runtime_control (
  id bigint primary key check (id = 1),
  enabled boolean not null default false,
  active_policy_version_id bigint references ai.policy_versions (id),
  audience text not null default 'ALLOWLIST' check (audience in ('ALLOWLIST', 'ALL')),
  generation bigint not null default 1 check (generation > 0),
  close_cycle bigint not null default 1 check (close_cycle > 0),
  user_daily_limit bigint not null default 20 check (user_daily_limit >= 0),
  global_daily_limit bigint not null default 2000 check (global_daily_limit >= 0),
  user_minute_limit bigint not null default 3 check (user_minute_limit >= 0),
  time_created timestamptz not null default clock_timestamp(),
  time_updated timestamptz not null default clock_timestamp(),
  revision bigint not null default 1 check (revision > 0),
  user_updated uuid,
  check (not enabled or active_policy_version_id is not null)
);
create table ai.allowed_users (
  auth_user_id uuid primary key references auth.users (id) on delete cascade,
  time_created timestamptz not null default clock_timestamp(),
  user_created uuid
);
create table ai.requests (
  id bigint generated always as identity primary key,
  time_created timestamptz not null default clock_timestamp(),
  external_id text not null default common.generate_external_id ('req_'),
  constraint uq_ai_requests_external_id unique (external_id),
  constraint ck_ai_requests_external_id check (common.is_valid_external_id (external_id, 'req_', 12)),
  owner_auth_user_id uuid references auth.users (id) on delete set null,
  client_request_key uuid,
  request_fingerprint text,
  policy_version_id bigint not null references ai.policy_versions (id),
  rule_ordinal integer not null,
  selected_option_id bigint not null,
  profile_version_id bigint not null,
  price_version_id bigint not null,
  legal_bundle_id bigint not null references legal.bundles (id),
  legal_disclosure_id bigint not null references legal.disclosures (id),
  config_generation bigint not null,
  quota_day date not null,
  provider_admission_day date,
  state text not null default 'RESERVED' check (state in ('RESERVED', 'RUNNING', 'HELD', 'FINALIZED')),
  cancel_sequence bigint not null default 0 check (cancel_sequence >= 0),
  time_canceled timestamptz,
  time_reserved timestamptz not null,
  time_progress timestamptz not null,
  time_finalized timestamptz,
  outcome text check (outcome in ('SUCCEEDED', 'CANCELED', 'FAILED_UPSTREAM', 'INVALID_OUTPUT', 'RELEASED')),
  charged boolean,
  usage jsonb not null default '{}',
  known_usage jsonb not null default '{}',
  billing_currency text not null,
  estimated_cost_nanos bigint,
  known_estimated_cost_nanos bigint,
  provider_reported_cost_nanos bigint,
  incomplete_reasons text[] not null default '{}',
  unique (owner_auth_user_id, client_request_key),
  foreign key (policy_version_id, rule_ordinal, selected_option_id) references ai.routing_rule_options (policy_version_id, rule_ordinal, option_id),
  foreign key (selected_option_id, profile_version_id) references ai.policy_options (id, profile_version_id),
  foreign key (price_version_id, profile_version_id) references ai.price_versions (id, profile_version_id),
  check ((owner_auth_user_id is null and client_request_key is null and request_fingerprint is null) or (owner_auth_user_id is not null and client_request_key is not null and request_fingerprint is not null))
);
create table ai.attempts (
  id bigint generated always as identity primary key,
  time_created timestamptz not null default clock_timestamp(),
  external_id text not null default common.generate_external_id ('att_'),
  constraint uq_ai_attempts_external_id unique (external_id),
  constraint ck_ai_attempts_external_id check (common.is_valid_external_id (external_id, 'att_', 12)),
  request_id bigint not null references ai.requests (id) on delete cascade,
  attempt_no smallint not null check (attempt_no in (1, 2)),
  state text not null default 'STARTED' check (state in ('STARTED', 'SUCCEEDED', 'CANCELED', 'FAILED_UPSTREAM', 'TIMED_OUT', 'INVALID_OUTPUT', 'UNKNOWN')),
  time_started timestamptz not null,
  time_terminal timestamptz,
  transmitted boolean,
  provider_billable boolean,
  retry_allowed boolean,
  fact_digest text,
  usage jsonb not null default '{}',
  estimated_cost_nanos bigint check (estimated_cost_nanos >= 0),
  known_estimated_cost_nanos bigint check (known_estimated_cost_nanos >= 0),
  provider_reported_cost_nanos bigint check (provider_reported_cost_nanos >= 0),
  incomplete_reasons text[] not null default '{}',
  unique (request_id, attempt_no)
);
create table ai.user_usage_daily (
  auth_user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  reserved_count bigint not null default 0 check (reserved_count >= 0),
  charged_count bigint not null default 0 check (charged_count >= 0),
  succeeded_count bigint not null default 0,
  failed_count bigint not null default 0,
  canceled_count bigint not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  incomplete_usage_count bigint not null default 0 check (incomplete_usage_count >= 0),
  primary key (auth_user_id, day)
);
create table ai.global_usage_daily (
  day date primary key,
  admitted_count bigint not null default 0 check (admitted_count >= 0),
  succeeded_count bigint not null default 0,
  failed_count bigint not null default 0,
  canceled_count bigint not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  incomplete_usage_count bigint not null default 0 check (incomplete_usage_count >= 0)
);
create table ai.profile_usage_daily (
  day date not null,
  profile_version_id bigint not null references ai.profile_versions (id),
  currency text not null,
  request_count bigint not null default 0,
  attempt_count bigint not null default 0,
  known_estimated_cost_nanos bigint not null default 0,
  incomplete_count bigint not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  incomplete_usage_count bigint not null default 0 check (incomplete_usage_count >= 0),
  primary key (day, profile_version_id, currency)
);
create table ai.rate_minutes (
  auth_user_id uuid not null references auth.users (id) on delete cascade,
  minute_bucket timestamptz not null,
  request_count bigint not null default 0 check (request_count >= 0),
  primary key (auth_user_id, minute_bucket)
);
create table legal.current_state (
  id bigint primary key check (id = 1),
  terms_document_version_id bigint not null references legal.document_versions (id),
  ai_bundle_id bigint references legal.bundles (id),
  time_created timestamptz not null default clock_timestamp(),
  time_updated timestamptz not null default clock_timestamp(),
  revision bigint not null default 1 check (revision > 0)
);
create table legal.acceptances (
  id bigint generated always as identity primary key,
  time_created timestamptz not null default clock_timestamp(),
  owner_auth_user_id uuid not null references auth.users (id) on delete cascade,
  document_version_id bigint references legal.document_versions (id),
  disclosure_id bigint references legal.disclosures (id),
  accepted_content_digest text not null,
  time_accepted timestamptz not null default clock_timestamp(),
  check ((document_version_id is null) <> (disclosure_id is null))
);
create table admin.environment (
  id bigint primary key check (id = 1),
  name text not null check (name in ('LOCAL', 'PREVIEW', 'PRODUCTION')),
  database_instance_id uuid not null unique,
  contract_code text not null check (contract_code = 'cv_app_db_1'),
  time_created timestamptz not null default clock_timestamp(),
  time_updated timestamptz not null default clock_timestamp(),
  revision bigint not null default 1 check (revision > 0)
);
create table admin.members (
  id bigint generated always as identity primary key,
  time_created timestamptz not null default clock_timestamp(),
  external_id text not null default common.generate_external_id ('adm_'),
  constraint uq_admin_members_external_id unique (external_id),
  constraint ck_admin_members_external_id check (common.is_valid_external_id (external_id, 'adm_', 12)),
  time_updated timestamptz not null default clock_timestamp(),
  revision bigint not null default 1 check (revision > 0),
  auth_user_id uuid not null unique,
  time_revoked timestamptz,
  user_created uuid,
  user_updated uuid
);
create table admin.operations (
  id bigint generated always as identity primary key,
  time_created timestamptz not null default clock_timestamp(),
  external_id text not null default common.generate_external_id ('op_'),
  constraint uq_admin_operations_external_id unique (external_id),
  constraint ck_admin_operations_external_id check (common.is_valid_external_id (external_id, 'op_', 12)),
  actor_auth_user_id uuid not null,
  idempotency_key uuid not null,
  operation_code text not null,
  payload_digest text not null,
  result jsonb not null,
  time_committed timestamptz not null default clock_timestamp(),
  unique (actor_auth_user_id, idempotency_key)
);
create table admin.validations (
  id bigint generated always as identity primary key,
  time_created timestamptz not null default clock_timestamp(),
  external_id text not null default common.generate_external_id ('val_'),
  constraint uq_admin_validations_external_id unique (external_id),
  constraint ck_admin_validations_external_id check (common.is_valid_external_id (external_id, 'val_', 12)),
  target_kind text not null check (target_kind in ('PROFILE', 'PRICE', 'POLICY')),
  profile_version_id bigint references ai.profile_versions (id),
  price_version_id bigint references ai.price_versions (id),
  policy_version_id bigint references ai.policy_versions (id),
  legal_bundle_id bigint not null references legal.bundles (id),
  dependency_digest text not null,
  environment_revision bigint not null,
  passed boolean not null,
  reasons text[] not null,
  time_checked timestamptz not null,
  time_expires timestamptz not null,
  check ((target_kind = 'PROFILE' and profile_version_id is not null and price_version_id is null and policy_version_id is null) or (target_kind = 'PRICE' and price_version_id is not null and profile_version_id is null and policy_version_id is null) or (target_kind = 'POLICY' and policy_version_id is not null and profile_version_id is null and price_version_id is null))
);
create table admin.readbacks (
  id bigint generated always as identity primary key,
  time_created timestamptz not null default clock_timestamp(),
  external_id text not null default common.generate_external_id ('rbk_'),
  constraint uq_admin_readbacks_external_id unique (external_id),
  constraint ck_admin_readbacks_external_id check (common.is_valid_external_id (external_id, 'rbk_', 12)),
  policy_version_id bigint not null references ai.policy_versions (id),
  legal_bundle_id bigint not null references legal.bundles (id),
  generation bigint not null,
  control_revision bigint not null,
  close_cycle bigint not null,
  environment_revision bigint not null,
  dependency_digest text not null,
  passed boolean not null,
  reasons text[] not null,
  time_checked timestamptz not null,
  time_expires timestamptz not null
);
create table audit.events (
  id bigint generated always as identity primary key,
  time_created timestamptz not null default clock_timestamp(),
  external_id text not null default common.generate_external_id ('evt_'),
  constraint uq_audit_events_external_id unique (external_id),
  constraint ck_audit_events_external_id check (common.is_valid_external_id (external_id, 'evt_', 12)),
  actor_kind text not null check (actor_kind in ('USER', 'SYSTEM', 'MIGRATION')),
  actor_auth_user_id uuid,
  operation_id bigint references admin.operations (id),
  entity_kind text not null,
  entity_external_id text,
  action text not null,
  reason text not null,
  summary jsonb not null
);
create unique index uq_accept_document on legal.acceptances (owner_auth_user_id, document_version_id)
where
  document_version_id is not null;
create unique index uq_accept_disclosure on legal.acceptances (owner_auth_user_id, disclosure_id)
where
  disclosure_id is not null;
create index ix_cv_owner_updated on cv.documents (owner_auth_user_id, time_updated desc, id desc);
create index ix_request_state_time on ai.requests (state, time_reserved, id);
create index ix_request_owner_time on ai.requests (owner_auth_user_id, time_reserved desc, id);
create index ix_rule_options_reverse on ai.routing_rule_options (policy_version_id, option_id);
create index ix_audit_time on audit.events (time_created desc, id desc);
create index ix_audit_entity on audit.events (entity_kind, entity_external_id, id desc);
do $$
declare
  r record;
begin
  for r in
  select
    n.nspname,
    c.relname
  from
    pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where
    n.nspname in ('cv', 'ai', 'legal', 'admin', 'audit')
    and c.relkind = 'r' loop
      execute pg_catalog.format('alter table %I.%I enable row level security', r.nspname, r.relname);
      execute pg_catalog.format('create policy api_owner on %I.%I to app_api_owner using(true) with check(true)', r.nspname, r.relname);
      execute pg_catalog.format('comment on table %I.%I is %L', r.nspname, r.relname, 'cv_app_db_1 private ' || r.nspname || ' domain; accessed only through explicit views/RPC.');
    end loop;
end
$$;
drop policy api_owner on cv.documents;
create policy cv_owner on cv.documents to authenticated, app_api_owner
  using (owner_auth_user_id = (
    select
      auth.uid ()))
  with check (owner_auth_user_id = (
    select
      auth.uid ()));
create policy acceptance_owner on legal.acceptances
  for select to authenticated
  using (owner_auth_user_id = (
    select
      auth.uid ()));
grant usage on schema common, cv, ai, legal, admin, audit, extensions, public to app_api_owner;
grant select, insert, update, delete on all tables in schema cv, ai, legal, admin, audit to app_api_owner;
grant usage, select on all sequences in schema cv, ai, legal, admin, audit to app_api_owner;
grant execute on all functions in schema common to app_api_owner;
grant execute on function extensions.gen_random_bytes(integer), extensions.digest(text, text) to app_api_owner;
create trigger maintain_revision
  before update on cv.documents for each row
  execute function common.touch ();
create trigger maintain_revision
  before update on ai.providers for each row
  execute function common.touch ();
create trigger maintain_revision
  before update on ai.profiles for each row
  execute function common.touch ();
create trigger maintain_revision
  before update on ai.policies for each row
  execute function common.touch ();
create trigger maintain_revision
  before update on ai.runtime_control for each row
  execute function common.touch ();
create trigger maintain_revision
  before update on legal.current_state for each row
  execute function common.touch ();
create trigger maintain_revision
  before update on admin.environment for each row
  execute function common.touch ();
create trigger maintain_revision
  before update on admin.members for each row
  execute function common.touch ();
create trigger immutable_definition
  before update on ai.profile_versions for each row
  execute function common.immutable ();
create trigger immutable_definition
  before update on ai.price_versions for each row
  execute function common.immutable ();
create trigger immutable_definition
  before update on ai.policy_versions for each row
  execute function common.immutable ();
create trigger immutable_definition
  before update on legal.document_versions for each row
  execute function common.immutable ();
create trigger immutable_definition
  before update on legal.bundles for each row
  execute function common.immutable ();
create trigger immutable_definition
  before update on legal.disclosures for each row
  execute function common.immutable ();
commit;
