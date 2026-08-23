-- Multi-provider AI foundation (expand-only).
--
-- This migration adds immutable, versioned provider/profile, native-currency
-- pricing, and routing-policy metadata. It does not seed a provider, activate
-- a route, or change the legacy DeepSeek request lifecycle.

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- Stable provider profile identity + immutable execution versions
-- ---------------------------------------------------------------------------

create table public.ai_provider_profiles (
  id uuid primary key default extensions.gen_random_uuid(),
  profile_key text not null unique,
  display_name text not null,
  gateway_kind text not null,
  model_vendor text not null,
  created_at timestamptz not null default now(),
  retired_at timestamptz,

  constraint ai_provider_profiles_key_check
    check (profile_key ~ '^[a-z0-9][a-z0-9._-]*$'),
  constraint ai_provider_profiles_display_name_check
    check (length(btrim(display_name)) > 0),
  constraint ai_provider_profiles_gateway_kind_check
    check (gateway_kind in ('direct_deepseek', 'direct_mimo', 'openrouter')),
  constraint ai_provider_profiles_model_vendor_check
    check (length(btrim(model_vendor)) > 0),
  constraint ai_provider_profiles_retired_at_check
    check (retired_at is null or retired_at >= created_at)
);

create table public.ai_provider_profile_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  profile_id uuid not null references public.ai_provider_profiles(id),
  version integer not null check (version > 0),
  status text not null default 'draft',
  adapter_kind text not null,
  wire_api_kind text not null,
  credential_alias text not null,
  endpoint_alias text not null,
  model_id text not null,
  model_snapshot text,
  upstream_route jsonb not null default '{}'::jsonb,
  capability_contract_id text not null,
  cache_policy_id text not null,
  legal_manifest_id text not null,
  config jsonb not null default '{}'::jsonb,
  config_sha256 text not null,
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  activated_at timestamptz,
  retired_at timestamptz,

  constraint ai_provider_profile_versions_identity_unique
    unique (profile_id, version),
  constraint ai_provider_profile_versions_id_profile_unique
    unique (id, profile_id),
  constraint ai_provider_profile_versions_status_check
    check (status in ('draft', 'validated', 'canary', 'active', 'retired')),
  constraint ai_provider_profile_versions_aliases_check check (
    length(btrim(adapter_kind)) > 0
    and wire_api_kind in ('chat_completions_v1', 'responses_v1')
    and length(btrim(credential_alias)) > 0
    and length(btrim(endpoint_alias)) > 0
    and length(btrim(model_id)) > 0
    and length(btrim(capability_contract_id)) > 0
    and length(btrim(cache_policy_id)) > 0
    and length(btrim(legal_manifest_id)) > 0
  ),
  constraint ai_provider_profile_versions_json_check check (
    jsonb_typeof(upstream_route) = 'object'
    and jsonb_typeof(config) = 'object'
  ),
  constraint ai_provider_profile_versions_hash_check
    check (config_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ai_provider_profile_versions_timestamps_check check (
    (validated_at is null or validated_at >= created_at)
    and (activated_at is null or activated_at >= created_at)
    and (retired_at is null or retired_at >= created_at)
  )
);

create or replace function public.guard_ai_provider_profile_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ai_provider_profiles rows cannot be deleted'
      using errcode = '23514';
  end if;

  if new.profile_key is distinct from old.profile_key
     or new.gateway_kind is distinct from old.gateway_kind
     or new.model_vendor is distinct from old.model_vendor
     or new.created_at is distinct from old.created_at then
    raise exception 'ai_provider_profiles identity is immutable'
      using errcode = '23514';
  end if;

  if old.retired_at is not null and new.retired_at is distinct from old.retired_at then
    raise exception 'retired ai_provider_profiles rows are immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger guard_ai_provider_profile_identity
before update or delete on public.ai_provider_profiles
for each row execute function public.guard_ai_provider_profile_identity();

create or replace function public.guard_ai_provider_profile_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allowed boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'ai_provider_profile_versions rows cannot be deleted'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' and num_nonnulls(new.validated_at, new.activated_at, new.retired_at) > 0 then
    raise exception 'ai_provider_profile_versions lifecycle timestamps are trigger-managed'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - array['status', 'validated_at', 'activated_at', 'retired_at'])
       is distinct from
       (to_jsonb(old) - array['status', 'validated_at', 'activated_at', 'retired_at']) then
      raise exception 'ai_provider_profile_versions execution fields are immutable'
        using errcode = '23514';
    end if;
    if new.validated_at is distinct from old.validated_at
       or new.activated_at is distinct from old.activated_at
       or new.retired_at is distinct from old.retired_at then
      raise exception 'ai_provider_profile_versions lifecycle timestamps are trigger-managed'
        using errcode = '23514';
    end if;

    v_allowed := case old.status
      when 'draft' then new.status in ('draft', 'validated', 'retired')
      when 'validated' then new.status in ('validated', 'canary', 'active', 'retired')
      when 'canary' then new.status in ('canary', 'active', 'retired')
      when 'active' then new.status in ('active', 'retired')
      when 'retired' then new.status = 'retired'
      else false
    end;
    if not v_allowed then
      raise exception 'invalid ai_provider_profile_versions status transition: % -> %',
        old.status, new.status using errcode = '23514';
    end if;
  end if;

  if new.status in ('validated', 'canary', 'active') and new.validated_at is null then
    new.validated_at := now();
  end if;
  if new.status = 'active' and new.activated_at is null then
    new.activated_at := now();
  end if;
  if new.status = 'retired' and new.retired_at is null then
    new.retired_at := now();
  end if;
  return new;
end;
$$;

create trigger guard_ai_provider_profile_version
before insert or update or delete on public.ai_provider_profile_versions
for each row execute function public.guard_ai_provider_profile_version();

-- ---------------------------------------------------------------------------
-- Native-currency price versions and components
-- ---------------------------------------------------------------------------

create table public.ai_price_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  profile_version_id uuid not null references public.ai_provider_profile_versions(id),
  version integer not null check (version > 0),
  currency text not null,
  calculator_kind text not null,
  valid_from timestamptz not null,
  valid_to timestamptz,
  source_url text not null,
  source_checked_at timestamptz not null,
  source_snapshot_sha256 text not null,
  parameters jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint ai_price_versions_identity_unique
    unique (profile_version_id, version),
  constraint ai_price_versions_id_profile_unique
    unique (id, profile_version_id),
  constraint ai_price_versions_currency_check
    check (currency ~ '^[A-Z]{3}$'),
  constraint ai_price_versions_calculator_check
    check (length(btrim(calculator_kind)) > 0),
  constraint ai_price_versions_range_check
    check (valid_to is null or valid_to > valid_from),
  constraint ai_price_versions_source_check check (
    source_url ~ '^https://'
    and source_snapshot_sha256 ~ '^[0-9a-f]{64}$'
    and jsonb_typeof(parameters) = 'object'
  ),
  constraint ai_price_versions_no_overlap
    exclude using gist (
      profile_version_id with =,
      tstzrange(valid_from, valid_to, '[)') with &&
    )
);

create table public.ai_price_components (
  price_version_id uuid not null references public.ai_price_versions(id),
  component text not null,
  nanos_per_million bigint not null check (nanos_per_million >= 0),

  primary key (price_version_id, component),
  constraint ai_price_components_component_check check (
    component in (
      'input_standard',
      'input_cache_read',
      'input_cache_write',
      'output'
    )
  )
);

create or replace function public.guard_ai_price_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ai_price_versions rows cannot be deleted'
      using errcode = '23514';
  end if;

  -- A previously open interval may be closed once when a successor price is
  -- introduced. All price identity, calculator, source and parameter facts
  -- remain immutable; an already closed interval cannot be rewritten.
  if (to_jsonb(new) - 'valid_to') is distinct from (to_jsonb(old) - 'valid_to')
     or old.valid_to is not null
     or new.valid_to is null then
    raise exception 'ai_price_versions rows are immutable except one-time valid_to closure'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger guard_ai_price_version
before update or delete on public.ai_price_versions
for each row execute function public.guard_ai_price_version();

create or replace function public.guard_ai_price_component()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' or tg_op = 'DELETE' then
    raise exception 'ai_price_components rows are immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger guard_ai_price_component
before update or delete on public.ai_price_components
for each row execute function public.guard_ai_price_component();

-- ---------------------------------------------------------------------------
-- Immutable routing policies + audited singleton pointer
-- ---------------------------------------------------------------------------

create table public.ai_routing_policy_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  policy_key text not null,
  version integer not null check (version > 0),
  status text not null default 'draft',
  timezone text not null,
  rules jsonb not null default '{}'::jsonb,
  default_profile_version_id uuid not null
    references public.ai_provider_profile_versions(id),
  legal_bundle_version text not null,
  config_sha256 text not null,
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  activated_at timestamptz,
  retired_at timestamptz,

  constraint ai_routing_policy_versions_identity_unique
    unique (policy_key, version),
  constraint ai_routing_policy_versions_status_check
    check (status in ('draft', 'validated', 'canary', 'active', 'retired')),
  constraint ai_routing_policy_versions_key_check
    check (policy_key ~ '^[a-z0-9][a-z0-9._-]*$'),
  constraint ai_routing_policy_versions_timezone_check
    check (timezone = 'Asia/Shanghai'),
  constraint ai_routing_policy_versions_rules_check
    check (jsonb_typeof(rules) = 'object'),
  constraint ai_routing_policy_versions_legal_check
    check (length(btrim(legal_bundle_version)) > 0),
  constraint ai_routing_policy_versions_hash_check
    check (config_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ai_routing_policy_versions_timestamps_check check (
    (validated_at is null or validated_at >= created_at)
    and (activated_at is null or activated_at >= created_at)
    and (retired_at is null or retired_at >= created_at)
  )
);

create or replace function public.guard_ai_routing_policy_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allowed boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'ai_routing_policy_versions rows cannot be deleted'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' and num_nonnulls(new.validated_at, new.activated_at, new.retired_at) > 0 then
    raise exception 'ai_routing_policy_versions lifecycle timestamps are trigger-managed'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - array['status', 'validated_at', 'activated_at', 'retired_at'])
       is distinct from
       (to_jsonb(old) - array['status', 'validated_at', 'activated_at', 'retired_at']) then
      raise exception 'ai_routing_policy_versions execution fields are immutable'
        using errcode = '23514';
    end if;
    if new.validated_at is distinct from old.validated_at
       or new.activated_at is distinct from old.activated_at
       or new.retired_at is distinct from old.retired_at then
      raise exception 'ai_routing_policy_versions lifecycle timestamps are trigger-managed'
        using errcode = '23514';
    end if;

    v_allowed := case old.status
      when 'draft' then new.status in ('draft', 'validated', 'retired')
      when 'validated' then new.status in ('validated', 'canary', 'active', 'retired')
      when 'canary' then new.status in ('canary', 'active', 'retired')
      when 'active' then new.status in ('active', 'retired')
      when 'retired' then new.status = 'retired'
      else false
    end;
    if not v_allowed then
      raise exception 'invalid ai_routing_policy_versions status transition: % -> %',
        old.status, new.status using errcode = '23514';
    end if;
  end if;

  if new.status in ('validated', 'canary', 'active') and new.validated_at is null then
    new.validated_at := now();
  end if;
  if new.status = 'active' and new.activated_at is null then
    new.activated_at := now();
  end if;
  if new.status = 'retired' and new.retired_at is null then
    new.retired_at := now();
  end if;
  return new;
end;
$$;

create trigger guard_ai_routing_policy_version
before insert or update or delete on public.ai_routing_policy_versions
for each row execute function public.guard_ai_routing_policy_version();

alter table public.ai_feature_config
  add column active_routing_policy_version_id uuid
    references public.ai_routing_policy_versions(id),
  add column config_generation bigint not null default 0
    check (config_generation >= 0),
  add column routing_updated_at timestamptz,
  add column routing_updated_by text,
  add column routing_change_reason text;

create or replace function public.guard_ai_feature_routing_pointer()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_policy public.ai_routing_policy_versions%rowtype;
  v_profile_status text;
begin
  if new.active_routing_policy_version_id is distinct from old.active_routing_policy_version_id then
    if new.routing_updated_by is null or length(btrim(new.routing_updated_by)) = 0
       or new.routing_change_reason is null or length(btrim(new.routing_change_reason)) = 0
       or new.routing_change_reason is not distinct from old.routing_change_reason then
      raise exception 'routing pointer changes require a fresh routing_change_reason and routing_updated_by'
        using errcode = '23514';
    end if;

    if new.active_routing_policy_version_id is not null then
      select * into v_policy
      from public.ai_routing_policy_versions
      where id = new.active_routing_policy_version_id;

      if not found or v_policy.status not in ('validated', 'canary', 'active') then
        raise exception 'active routing pointer requires an activatable policy'
          using errcode = '23514';
      end if;
      if v_policy.legal_bundle_version <> public.current_ai_terms_version() then
        raise exception 'routing policy legal bundle is not current'
          using errcode = '23514';
      end if;

      select status into v_profile_status
      from public.ai_provider_profile_versions
      where id = v_policy.default_profile_version_id;
      if v_profile_status not in ('validated', 'canary', 'active') then
        raise exception 'routing policy default profile is not activatable'
          using errcode = '23514';
      end if;
    end if;

    if old.config_generation = 9223372036854775807 then
      raise exception 'ai_feature_config config_generation exhausted'
        using errcode = '22003';
    end if;
    new.config_generation := old.config_generation + 1;
    new.routing_updated_at := now();
  elsif new.config_generation is distinct from old.config_generation then
    raise exception 'config_generation changes only with the routing pointer'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger guard_ai_feature_routing_pointer
before update on public.ai_feature_config
for each row execute function public.guard_ai_feature_routing_pointer();

-- ---------------------------------------------------------------------------
-- Security posture: all configuration is server/operator-only.
-- ---------------------------------------------------------------------------

alter table public.ai_provider_profiles enable row level security;
alter table public.ai_provider_profile_versions enable row level security;
alter table public.ai_price_versions enable row level security;
alter table public.ai_price_components enable row level security;
alter table public.ai_routing_policy_versions enable row level security;

revoke all on public.ai_provider_profiles from public, anon, authenticated;
revoke all on public.ai_provider_profile_versions from public, anon, authenticated;
revoke all on public.ai_price_versions from public, anon, authenticated;
revoke all on public.ai_price_components from public, anon, authenticated;
revoke all on public.ai_routing_policy_versions from public, anon, authenticated;

grant select, insert, update, delete on public.ai_provider_profiles to service_role;
grant select, insert, update, delete on public.ai_provider_profile_versions to service_role;
grant select, insert, update, delete on public.ai_price_versions to service_role;
grant select, insert, update, delete on public.ai_price_components to service_role;
grant select, insert, update, delete on public.ai_routing_policy_versions to service_role;

revoke execute on function public.guard_ai_provider_profile_identity() from public, anon, authenticated, service_role;
revoke execute on function public.guard_ai_provider_profile_version() from public, anon, authenticated, service_role;
revoke execute on function public.guard_ai_price_version() from public, anon, authenticated, service_role;
revoke execute on function public.guard_ai_price_component() from public, anon, authenticated, service_role;
revoke execute on function public.guard_ai_routing_policy_version() from public, anon, authenticated, service_role;
revoke execute on function public.guard_ai_feature_routing_pointer() from public, anon, authenticated, service_role;
