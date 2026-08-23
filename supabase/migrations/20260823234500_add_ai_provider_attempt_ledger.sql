-- Immutable per-transmission facts for the multi-provider lifecycle.
--
-- Expand-only: this table is intentionally not populated for legacy requests
-- and no RPC starts or completes an attempt in this migration. Later lifecycle
-- migrations own those operations. The schema stores only bounded metadata;
-- prompt/CV/output content and raw provider bodies/messages are forbidden.

create table public.ai_provider_attempt_ledger (
  attempt_id uuid primary key default extensions.gen_random_uuid(),
  reservation_id uuid not null
    references public.ai_request_ledger(reservation_id) on delete cascade,
  attempt_no smallint not null,

  -- The complete reservation route plus code-registry-safe aliases are copied
  -- at start. The trigger below proves them against the frozen parent/profile/
  -- price rows and then makes them immutable.
  route_schema_version text not null,
  config_generation bigint not null,
  routing_policy_version_id uuid not null,
  profile_version_id uuid not null,
  price_version_id uuid not null,
  legal_bundle_version text not null,
  gateway_kind text not null,
  model_id text not null,
  wire_api_kind text not null,
  display_disclosure_key text not null,
  adapter_kind text not null,
  credential_alias text not null,
  endpoint_alias text not null,
  capability_contract_id text not null,
  cache_policy_id text not null,
  legal_manifest_id text not null,
  calculator_kind text not null,
  billing_currency text not null,

  status text not null default 'started',
  started_at timestamptz not null default now(),
  terminal_at timestamptz,
  provider_billable boolean,

  usage_observation_kind text,
  usage_schema_version text,
  input_total_tokens bigint,
  input_cache_read_tokens bigint,
  input_cache_write_tokens bigint,
  input_standard_tokens bigint,
  output_tokens bigint,
  reasoning_tokens bigint,
  cache_usage_reporting text,
  usage_complete boolean,

  route_observation_schema_version text,
  gateway_request_id text,
  provider_request_id text,
  actual_upstream_endpoint text,
  actual_model_id text,
  router_attempt_count smallint,

  cost_observation_schema_version text,
  estimated_currency text,
  estimated_cost_nanos bigint,
  provider_reported_currency text,
  provider_reported_cost_nanos bigint,
  cost_reconciliation_status text,

  finish_reason text,
  failure_stage text,
  latency_ms integer,

  constraint ai_provider_attempt_ledger_reservation_attempt_unique
    unique (reservation_id, attempt_no),
  constraint ai_provider_attempt_ledger_attempt_no_check
    check (attempt_no between 1 and 2),
  constraint ai_provider_attempt_ledger_snapshot_shape_check check (
    route_schema_version = 'route_snapshot_v1'
    and config_generation >= 0
    and length(btrim(legal_bundle_version)) between 1 and 200
    and gateway_kind in ('direct_deepseek', 'direct_mimo', 'openrouter')
    and wire_api_kind in ('chat_completions_v1', 'responses_v1')
    and length(btrim(model_id)) between 1 and 200
    and length(btrim(display_disclosure_key)) between 1 and 200
    and length(btrim(adapter_kind)) between 1 and 200
    and length(btrim(credential_alias)) between 1 and 200
    and length(btrim(endpoint_alias)) between 1 and 200
    and length(btrim(capability_contract_id)) between 1 and 200
    and length(btrim(cache_policy_id)) between 1 and 200
    and length(btrim(legal_manifest_id)) between 1 and 200
    and length(btrim(calculator_kind)) between 1 and 200
    and billing_currency ~ '^[A-Z]{3}$'
  ),
  constraint ai_provider_attempt_ledger_status_check check (
    status in (
      'started',
      'succeeded',
      'invalid_output',
      'failed_upstream',
      'timed_out',
      'canceled',
      'unknown'
    )
  ),
  constraint ai_provider_attempt_ledger_lifecycle_check check (
    (
      status = 'started'
      and terminal_at is null
      and provider_billable is null
      and usage_observation_kind is null
      and usage_schema_version is null
      and input_total_tokens is null
      and input_cache_read_tokens is null
      and input_cache_write_tokens is null
      and input_standard_tokens is null
      and output_tokens is null
      and reasoning_tokens is null
      and cache_usage_reporting is null
      and usage_complete is null
      and route_observation_schema_version is null
      and gateway_request_id is null
      and provider_request_id is null
      and actual_upstream_endpoint is null
      and actual_model_id is null
      and router_attempt_count is null
      and cost_observation_schema_version is null
      and estimated_currency is null
      and estimated_cost_nanos is null
      and provider_reported_currency is null
      and provider_reported_cost_nanos is null
      and cost_reconciliation_status is null
      and finish_reason is null
      and failure_stage is null
      and latency_ms is null
    )
    or
    (
      status <> 'started'
      and terminal_at is not null
      and terminal_at >= started_at
      and usage_observation_kind is not null
      and route_observation_schema_version = 'route_observation_v1'
      and cost_observation_schema_version = 'cost_observation_v1'
      and cost_reconciliation_status is not null
      and latency_ms is not null
    )
  ),
  constraint ai_provider_attempt_ledger_token_bounds_check check (
    (input_total_tokens is null or input_total_tokens between 0 and 9007199254740991)
    and (input_cache_read_tokens is null or input_cache_read_tokens between 0 and 9007199254740991)
    and (input_cache_write_tokens is null or input_cache_write_tokens between 0 and 9007199254740991)
    and (input_standard_tokens is null or input_standard_tokens between 0 and 9007199254740991)
    and (output_tokens is null or output_tokens between 0 and 9007199254740991)
    and (reasoning_tokens is null or reasoning_tokens between 0 and 9007199254740991)
    and (reasoning_tokens is null or output_tokens is not null and reasoning_tokens <= output_tokens)
  ),
  constraint ai_provider_attempt_ledger_usage_observation_check check (coalesce((
    (
      usage_observation_kind = 'unavailable'
      and usage_schema_version is null
      and input_total_tokens is null
      and input_cache_read_tokens is null
      and input_cache_write_tokens is null
      and input_standard_tokens is null
      and output_tokens is null
      and reasoning_tokens is null
      and cache_usage_reporting is null
      and usage_complete is false
    )
    or
    (
      usage_observation_kind = 'observed'
      and usage_schema_version is not null
      and usage_schema_version = 'normalized_usage_v2'
      and input_total_tokens is not null
      and input_cache_read_tokens is not null
      and input_standard_tokens is not null
      and output_tokens is not null
      and cache_usage_reporting is not null
      and cache_usage_reporting in ('reported', 'unavailable', 'not_applicable')
      and usage_complete is not null
      and (
        cache_usage_reporting = 'reported'
        and input_cache_write_tokens is not null
        and input_total_tokens = input_cache_read_tokens + input_cache_write_tokens + input_standard_tokens
        or cache_usage_reporting = 'unavailable'
        and input_cache_write_tokens is null
        and input_total_tokens = input_cache_read_tokens + input_standard_tokens
        or cache_usage_reporting = 'not_applicable'
        and input_cache_read_tokens = 0
        and input_cache_write_tokens = 0
        and input_total_tokens = input_standard_tokens
      )
    )
    or
    (
      status = 'started'
      and usage_observation_kind is null
    )
  ), false)),
  constraint ai_provider_attempt_ledger_route_observation_check check (coalesce((
    (
      status = 'started'
      and route_observation_schema_version is null
    )
    or
    (
      status <> 'started'
      and route_observation_schema_version = 'route_observation_v1'
      and (
        gateway_request_id is null
        or (
          length(gateway_request_id) between 1 and 256
          and btrim(gateway_request_id) = gateway_request_id
          and gateway_request_id !~ '[[:cntrl:]]'
          and gateway_request_id !~* '(bearer|basic)[[:space:]]+|(api[_-]?key|password|secret)[[:space:]]*[:=]'
        )
      )
      and (
        provider_request_id is null
        or (
          length(provider_request_id) between 1 and 256
          and btrim(provider_request_id) = provider_request_id
          and provider_request_id !~ '[[:cntrl:]]'
          and provider_request_id !~* '(bearer|basic)[[:space:]]+|(api[_-]?key|password|secret)[[:space:]]*[:=]'
        )
      )
      and (
        actual_model_id is null
        or (
          length(actual_model_id) between 1 and 256
          and btrim(actual_model_id) = actual_model_id
          and actual_model_id !~ '[[:cntrl:]]'
          and actual_model_id !~* '(bearer|basic)[[:space:]]+|(api[_-]?key|password|secret)[[:space:]]*[:=]'
        )
      )
      and (
        actual_upstream_endpoint is null
        or (
          length(actual_upstream_endpoint) between 9 and 512
          and actual_upstream_endpoint ~ '^https://'
          and actual_upstream_endpoint !~ '[[:space:][:cntrl:]?#]'
          and split_part(split_part(actual_upstream_endpoint, '://', 2), '/', 1) !~ '@'
        )
      )
      and (router_attempt_count is null or router_attempt_count between 1 and 100)
    )
  ), false)),
  constraint ai_provider_attempt_ledger_cost_bounds_check check (
    (estimated_cost_nanos is null or estimated_cost_nanos >= 0)
    and (provider_reported_cost_nanos is null or provider_reported_cost_nanos >= 0)
    and (
      estimated_currency is null and estimated_cost_nanos is null
      or estimated_currency is not null
      and estimated_currency = billing_currency
      and estimated_cost_nanos is not null
    )
    and (
      provider_reported_currency is null and provider_reported_cost_nanos is null
      or provider_reported_currency is not null
      and provider_reported_currency = billing_currency
      and provider_reported_cost_nanos is not null
    )
  ),
  constraint ai_provider_attempt_ledger_cost_reconciliation_check check (coalesce((
    (
      status = 'started'
      and cost_observation_schema_version is null
      and cost_reconciliation_status is null
    )
    or
    (
      status <> 'started'
      and cost_observation_schema_version = 'cost_observation_v1'
      and case cost_reconciliation_status
        when 'not_available' then
          estimated_cost_nanos is not null
          and provider_reported_cost_nanos is null
        when 'pending' then
          estimated_cost_nanos is not null
          and provider_reported_cost_nanos is null
        when 'matched' then
          estimated_cost_nanos is not null
          and provider_reported_cost_nanos is not null
          and estimated_cost_nanos = provider_reported_cost_nanos
        when 'mismatch' then
          estimated_cost_nanos is not null
          and provider_reported_cost_nanos is not null
          and estimated_cost_nanos <> provider_reported_cost_nanos
        when 'incomplete_usage' then
          estimated_cost_nanos is null
        else false
      end
      and (
        usage_observation_kind <> 'unavailable'
        or cost_reconciliation_status = 'incomplete_usage'
      )
    )
  ), false)),
  constraint ai_provider_attempt_ledger_metadata_check check (
    (finish_reason is null or finish_reason in (
      'stop',
      'length',
      'content_filter',
      'insufficient_system_resource',
      'unknown'
    ))
    and (
      failure_stage is null
      or failure_stage ~ '^[a-z][a-z0-9_]{0,63}$'
    )
    and (latency_ms is null or latency_ms >= 0)
  )
);

create index ai_provider_attempt_ledger_reservation_status_idx
on public.ai_provider_attempt_ledger (reservation_id, status, attempt_no);

create or replace function public.guard_ai_provider_attempt_ledger()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_request public.ai_request_ledger%rowtype;
  v_profile record;
  v_price public.ai_price_versions%rowtype;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'started' then
      raise exception 'ai_provider_attempt_ledger rows must be inserted as started'
        using errcode = '23514';
    end if;

    select * into v_request
    from public.ai_request_ledger
    where reservation_id = new.reservation_id
    for key share;

    if not found or v_request.route_schema_version is null then
      raise exception 'provider attempts require a frozen parent route snapshot'
        using errcode = '23514';
    end if;

    if (
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
      v_request.route_schema_version,
      v_request.config_generation,
      v_request.routing_policy_version_id,
      v_request.profile_version_id,
      v_request.price_version_id,
      v_request.legal_bundle_version,
      v_request.gateway_kind,
      v_request.model_id,
      v_request.wire_api_kind,
      v_request.display_disclosure_key
    ) then
      raise exception 'provider attempt route snapshot differs from its reservation'
        using errcode = '23514';
    end if;

    select
      version.adapter_kind,
      version.credential_alias,
      version.endpoint_alias,
      version.capability_contract_id,
      version.cache_policy_id,
      version.legal_manifest_id,
      version.model_id,
      version.wire_api_kind,
      profile.gateway_kind
    into v_profile
    from public.ai_provider_profile_versions as version
    join public.ai_provider_profiles as profile on profile.id = version.profile_id
    where version.id = new.profile_version_id;

    if not found or (
      new.adapter_kind,
      new.credential_alias,
      new.endpoint_alias,
      new.capability_contract_id,
      new.cache_policy_id,
      new.legal_manifest_id,
      new.model_id,
      new.wire_api_kind,
      new.gateway_kind
    ) is distinct from (
      v_profile.adapter_kind,
      v_profile.credential_alias,
      v_profile.endpoint_alias,
      v_profile.capability_contract_id,
      v_profile.cache_policy_id,
      v_profile.legal_manifest_id,
      v_profile.model_id,
      v_profile.wire_api_kind,
      v_profile.gateway_kind
    ) then
      raise exception 'provider attempt aliases differ from its frozen profile'
        using errcode = '23514';
    end if;

    select * into v_price
    from public.ai_price_versions
    where id = new.price_version_id
      and profile_version_id = new.profile_version_id;

    if not found or (new.calculator_kind, new.billing_currency)
      is distinct from (v_price.calculator_kind, v_price.currency) then
      raise exception 'provider attempt cost aliases differ from its frozen price'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.status <> 'started' then
      raise exception 'terminal provider attempt facts are immutable'
        using errcode = '23514';
    end if;

    if (
      new.attempt_id,
      new.reservation_id,
      new.attempt_no,
      new.route_schema_version,
      new.config_generation,
      new.routing_policy_version_id,
      new.profile_version_id,
      new.price_version_id,
      new.legal_bundle_version,
      new.gateway_kind,
      new.model_id,
      new.wire_api_kind,
      new.display_disclosure_key,
      new.adapter_kind,
      new.credential_alias,
      new.endpoint_alias,
      new.capability_contract_id,
      new.cache_policy_id,
      new.legal_manifest_id,
      new.calculator_kind,
      new.billing_currency,
      new.started_at
    ) is distinct from (
      old.attempt_id,
      old.reservation_id,
      old.attempt_no,
      old.route_schema_version,
      old.config_generation,
      old.routing_policy_version_id,
      old.profile_version_id,
      old.price_version_id,
      old.legal_bundle_version,
      old.gateway_kind,
      old.model_id,
      old.wire_api_kind,
      old.display_disclosure_key,
      old.adapter_kind,
      old.credential_alias,
      old.endpoint_alias,
      old.capability_contract_id,
      old.cache_policy_id,
      old.legal_manifest_id,
      old.calculator_kind,
      old.billing_currency,
      old.started_at
    ) then
      raise exception 'provider attempt identity and frozen snapshot are immutable'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger guard_ai_provider_attempt_ledger
before insert or update on public.ai_provider_attempt_ledger
for each row execute function public.guard_ai_provider_attempt_ledger();

alter table public.ai_provider_attempt_ledger enable row level security;
revoke all on public.ai_provider_attempt_ledger from public, anon, authenticated;
grant select, insert, update, delete on public.ai_provider_attempt_ledger to service_role;

revoke execute on function public.guard_ai_provider_attempt_ledger()
  from public, anon, authenticated, service_role;
