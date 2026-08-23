-- Multi-provider request aggregate foundation and exact legal-bundle gate.
-- Expand-only: every new request column is nullable so legacy rows and RPCs
-- remain valid until the V2 lifecycle is activated in later migrations.

alter table public.ai_request_ledger
  add column route_schema_version text,
  add column config_generation bigint,
  add column routing_policy_version_id uuid
    references public.ai_routing_policy_versions(id),
  add column profile_version_id uuid
    references public.ai_provider_profile_versions(id),
  add column price_version_id uuid
    references public.ai_price_versions(id),
  add column legal_bundle_version text,
  add column gateway_kind text,
  add column model_id text,
  add column wire_api_kind text,
  add column display_disclosure_key text,
  add column usage_schema_version text,
  add column input_total_tokens bigint,
  add column input_cache_read_tokens bigint,
  add column input_cache_write_tokens bigint,
  add column input_standard_tokens bigint,
  add column reasoning_tokens bigint,
  add column cache_usage_reporting text,
  add column incomplete_fields text[],
  add column cost_basis text,
  add column billing_currency text,
  add column known_estimated_cost_nanos bigint,
  add column estimated_cost_nanos bigint,
  add column provider_reported_currency text,
  add column provider_reported_cost_nanos bigint,
  add column cost_reconciliation_status text,

  add constraint ai_request_ledger_route_snapshot_check check (
    (
      num_nonnulls(
        route_schema_version,
        config_generation,
        routing_policy_version_id,
        profile_version_id,
        price_version_id,
        legal_bundle_version,
        gateway_kind,
        model_id,
        wire_api_kind,
        display_disclosure_key
      ) = 0
    )
    or
    (
      num_nonnulls(
        route_schema_version,
        config_generation,
        routing_policy_version_id,
        profile_version_id,
        price_version_id,
        legal_bundle_version,
        gateway_kind,
        model_id,
        wire_api_kind,
        display_disclosure_key
      ) = 10
      and
      route_schema_version = 'route_snapshot_v1'
      and config_generation >= 0
      and length(btrim(legal_bundle_version)) > 0
      and gateway_kind in ('direct_deepseek', 'direct_mimo', 'openrouter')
      and length(btrim(model_id)) > 0
      and wire_api_kind in ('chat_completions_v1', 'responses_v1')
      and length(btrim(display_disclosure_key)) > 0
    )
  ),
  add constraint ai_request_ledger_usage_schema_check check (
    usage_schema_version is null
    or usage_schema_version in ('legacy_v1', 'request_usage_aggregate_v2')
  ),
  add constraint ai_request_ledger_v2_usage_nonnegative_check check (
    (input_total_tokens is null or input_total_tokens >= 0)
    and (input_cache_read_tokens is null or input_cache_read_tokens >= 0)
    and (input_cache_write_tokens is null or input_cache_write_tokens >= 0)
    and (input_standard_tokens is null or input_standard_tokens >= 0)
    and (reasoning_tokens is null or reasoning_tokens >= 0)
    and (reasoning_tokens is null or output_tokens is null or reasoning_tokens <= output_tokens)
  ),
  add constraint ai_request_ledger_cache_reporting_check check (
    cache_usage_reporting is null
    or cache_usage_reporting in ('reported', 'unavailable', 'not_applicable')
  ),
  add constraint ai_request_ledger_usage_conservation_check check (
    cache_usage_reporting is null
    or (
      cache_usage_reporting = 'reported'
      and input_total_tokens is not null
      and input_cache_read_tokens is not null
      and input_cache_write_tokens is not null
      and input_standard_tokens is not null
      and input_total_tokens = input_cache_read_tokens + input_cache_write_tokens + input_standard_tokens
    )
    or (
      cache_usage_reporting = 'unavailable'
      and input_total_tokens is not null
      and input_cache_read_tokens is not null
      and input_cache_write_tokens is null
      and input_standard_tokens is not null
      and input_total_tokens = input_cache_read_tokens + input_standard_tokens
    )
    or (
      cache_usage_reporting = 'not_applicable'
      and input_total_tokens is not null
      and input_cache_read_tokens = 0
      and input_cache_write_tokens = 0
      and input_standard_tokens is not null
      and input_total_tokens = input_standard_tokens
    )
  ),
  add constraint ai_request_ledger_v2_usage_shape_check check (
    usage_schema_version is distinct from 'request_usage_aggregate_v2'
    or (
      input_total_tokens is not null
      and input_cache_read_tokens is not null
      and input_standard_tokens is not null
      and output_tokens is not null
      and cache_usage_reporting is not null
      and incomplete_fields is not null
      and cost_reconciliation_status is not null
    )
  ),
  add constraint ai_request_ledger_incomplete_fields_check check (
    incomplete_fields is null
    or incomplete_fields <@ array[
      'attempt_usage',
      'input_cache_write',
      'reasoning',
      'provider_billable',
      'estimated_cost'
    ]::text[]
    and array_position(incomplete_fields, null) is null
  ),
  add constraint ai_request_ledger_v2_incomplete_consistency_check check (
    usage_schema_version is distinct from 'request_usage_aggregate_v2'
    or (
      incomplete_fields is not null
      and (
        (usage_complete is true and array_position(incomplete_fields, 'attempt_usage') is null)
        or (usage_complete is false and array_position(incomplete_fields, 'attempt_usage') is not null)
      )
      and (input_cache_write_tokens is null) =
        (array_position(incomplete_fields, 'input_cache_write') is not null)
      and (reasoning_tokens is null) =
        (array_position(incomplete_fields, 'reasoning') is not null)
      and (provider_billable is null) =
        (array_position(incomplete_fields, 'provider_billable') is not null)
      and (estimated_cost_nanos is null) =
        (array_position(incomplete_fields, 'estimated_cost') is not null)
      and cardinality(incomplete_fields) =
        case when array_position(incomplete_fields, 'attempt_usage') is null then 0 else 1 end
        + case when array_position(incomplete_fields, 'input_cache_write') is null then 0 else 1 end
        + case when array_position(incomplete_fields, 'reasoning') is null then 0 else 1 end
        + case when array_position(incomplete_fields, 'provider_billable') is null then 0 else 1 end
        + case when array_position(incomplete_fields, 'estimated_cost') is null then 0 else 1 end
    )
  ),
  add constraint ai_request_ledger_cost_check check (
    (cost_basis is null or length(btrim(cost_basis)) > 0)
    and (billing_currency is null or billing_currency ~ '^[A-Z]{3}$')
    and (known_estimated_cost_nanos is null or known_estimated_cost_nanos >= 0)
    and (known_estimated_cost_nanos is null or billing_currency is not null)
    and (estimated_cost_nanos is null or estimated_cost_nanos >= 0)
    and (
      estimated_cost_nanos is null
      or (
        billing_currency is not null
        and known_estimated_cost_nanos is not null
        and estimated_cost_nanos = known_estimated_cost_nanos
      )
    )
    and (
      provider_reported_currency is null
      and provider_reported_cost_nanos is null
      or provider_reported_currency is not null
      and provider_reported_currency ~ '^[A-Z]{3}$'
      and provider_reported_cost_nanos is not null
      and provider_reported_cost_nanos >= 0
    )
    and (
      billing_currency is null
      or provider_reported_currency is null
      or billing_currency = provider_reported_currency
    )
    and (
      cost_reconciliation_status is null
      or cost_reconciliation_status in (
        'not_available',
        'pending',
        'matched',
        'mismatch',
        'incomplete_usage'
      )
    )
    and (
      cost_reconciliation_status is null
      or case cost_reconciliation_status
        when 'not_available' then
          estimated_cost_nanos is not null
          and provider_reported_currency is null
          and provider_reported_cost_nanos is null
        when 'pending' then
          estimated_cost_nanos is not null
          and provider_reported_currency is null
          and provider_reported_cost_nanos is null
        when 'matched' then
          estimated_cost_nanos is not null
          and provider_reported_currency is not null
          and provider_reported_cost_nanos is not null
          and estimated_cost_nanos = provider_reported_cost_nanos
        when 'mismatch' then
          estimated_cost_nanos is not null
          and provider_reported_currency is not null
          and provider_reported_cost_nanos is not null
          and estimated_cost_nanos <> provider_reported_cost_nanos
        when 'incomplete_usage' then
          estimated_cost_nanos is null
          and incomplete_fields is not null
          and array_position(incomplete_fields, 'estimated_cost') is not null
        else false
      end
    )
  );

alter table public.ai_request_ledger
  add constraint ai_request_ledger_price_profile_fk
  foreign key (price_version_id, profile_version_id)
  references public.ai_price_versions(id, profile_version_id);

-- Price component inserts and the first request snapshot reference serialize
-- on the same ai_price_versions row. The reference transition also persists a
-- one-way seal, so request-ledger cleanup can never reopen historical prices:
--
--   request row (already locked by INSERT/UPDATE) -> price row UPDATE/seal
--   component INSERT -> price row FOR UPDATE -> read persistent seal
--
-- Both paths hold a conflicting parent-row lock through transaction end. The
-- component path never locks a request row, so it cannot form a circular wait.
-- If the component commits first, the request freezes it; if the request seals
-- first, the waiting component sees the seal and is rejected.
create or replace function public.guard_ai_price_component()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_components_sealed_at timestamptz;
begin
  if tg_op = 'UPDATE' or tg_op = 'DELETE' then
    raise exception 'ai_price_components rows are immutable'
      using errcode = '23514';
  end if;

  select components_sealed_at into v_components_sealed_at
  from public.ai_price_versions
  where id = new.price_version_id
  for update;

  if v_components_sealed_at is not null then
    raise exception 'cannot add components to a price version frozen by a request'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger guard_ai_price_component on public.ai_price_components;
create trigger guard_ai_price_component
before insert or update or delete on public.ai_price_components
for each row execute function public.guard_ai_price_component();

create or replace function public.guard_ai_request_route_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.route_schema_version is not null and (
    new.route_schema_version,
    new.config_generation,
    new.routing_policy_version_id,
    new.profile_version_id,
    new.price_version_id,
    new.legal_bundle_version,
    new.gateway_kind,
    new.model_id,
    new.wire_api_kind,
    new.display_disclosure_key
  ) is distinct from (
    old.route_schema_version,
    old.config_generation,
    old.routing_policy_version_id,
    old.profile_version_id,
    old.price_version_id,
    old.legal_bundle_version,
    old.gateway_kind,
    old.model_id,
    old.wire_api_kind,
    old.display_disclosure_key
  ) then
    raise exception 'ai_request_ledger route snapshot is immutable once frozen'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' and new.price_version_id is not null then
    update public.ai_price_versions
    set components_sealed_at = now()
    where id = new.price_version_id
      and components_sealed_at is null;
  elsif tg_op = 'UPDATE'
        and old.price_version_id is null
        and new.price_version_id is not null then
    update public.ai_price_versions
    set components_sealed_at = now()
    where id = new.price_version_id
      and components_sealed_at is null;
  end if;
  return new;
end;
$$;

create trigger guard_ai_request_route_snapshot
before insert or update on public.ai_request_ledger
for each row execute function public.guard_ai_request_route_snapshot();

-- Global operational aggregate grouped by immutable profile and native
-- currency. No cross-currency total exists in this schema.
create table public.ai_profile_usage_daily (
  day date not null,
  profile_version_id uuid not null
    references public.ai_provider_profile_versions(id),
  billing_currency text not null,
  request_count integer not null default 0 check (request_count >= 0),
  usage_incomplete_count integer not null default 0 check (usage_incomplete_count >= 0),
  cost_incomplete_count integer not null default 0 check (cost_incomplete_count >= 0),
  input_total_tokens bigint not null default 0 check (input_total_tokens >= 0),
  input_cache_read_tokens bigint not null default 0 check (input_cache_read_tokens >= 0),
  input_standard_tokens bigint not null default 0 check (input_standard_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  input_cache_write_tokens bigint check (input_cache_write_tokens is null or input_cache_write_tokens >= 0),
  reasoning_tokens bigint check (reasoning_tokens is null or reasoning_tokens >= 0),
  known_estimated_cost_nanos bigint not null default 0 check (known_estimated_cost_nanos >= 0),
  estimated_cost_nanos bigint check (estimated_cost_nanos is null or estimated_cost_nanos >= 0),
  provider_reported_cost_nanos bigint check (provider_reported_cost_nanos is null or provider_reported_cost_nanos >= 0),
  updated_at timestamptz not null default now(),

  primary key (day, profile_version_id, billing_currency),
  constraint ai_profile_usage_daily_currency_check
    check (billing_currency ~ '^[A-Z]{3}$'),
  constraint ai_profile_usage_daily_cost_check check (
    estimated_cost_nanos is null
    or estimated_cost_nanos = known_estimated_cost_nanos
  ),
  constraint ai_profile_usage_daily_reasoning_check
    check (reasoning_tokens is null or reasoning_tokens <= output_tokens)
);

create trigger set_ai_profile_usage_daily_updated_at
before update on public.ai_profile_usage_daily
for each row execute function public.set_updated_at();

alter table public.ai_profile_usage_daily enable row level security;
revoke all on public.ai_profile_usage_daily from public, anon, authenticated;
grant select, insert, update, delete on public.ai_profile_usage_daily to service_role;

-- ---------------------------------------------------------------------------
-- Exact, service-role-only legal bundle predicate.
-- ---------------------------------------------------------------------------

create or replace function public.current_ai_terms_version()
returns text
language sql
stable
set search_path = ''
as $$
  select '2026-08-23-multi-provider-v1'::text;
$$;

revoke execute on function public.current_ai_terms_version() from public;
grant execute on function public.current_ai_terms_version() to authenticated, service_role;

create or replace function public.has_accepted_ai_legal_bundle(
  p_user_id uuid,
  p_legal_bundle_version text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_user_id is not null
    and p_legal_bundle_version is not null
    and p_legal_bundle_version = public.current_ai_terms_version()
    and exists (
      select 1
      from public.user_terms_acceptances
      where user_id = p_user_id
        and document_key = 'ai_terms'
        and version = p_legal_bundle_version
    );
$$;

revoke execute on function public.has_accepted_ai_legal_bundle(uuid, text)
  from public, anon, authenticated;
grant execute on function public.has_accepted_ai_legal_bundle(uuid, text)
  to service_role;

revoke execute on function public.guard_ai_request_route_snapshot()
  from public, anon, authenticated, service_role;
