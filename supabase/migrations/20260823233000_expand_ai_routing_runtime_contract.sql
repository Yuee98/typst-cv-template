-- Runtime-contract catalogs and strict routing-policy validation foundation.
--
-- This migration is expand-only. It creates no runtime-contract rows, no
-- provider/profile/price/policy rows, and does not activate a routing pointer.

begin;

-- ---------------------------------------------------------------------------
-- Profile disclosure and legal-root composite identity.
-- ---------------------------------------------------------------------------

alter table public.ai_provider_profile_versions
  add column display_disclosure_key text,
  add constraint ai_provider_profile_versions_display_disclosure_key_check
    check (
      display_disclosure_key is null
      or display_disclosure_key ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    );

-- The existing profile-version guard compares every non-lifecycle column, so
-- the new disclosure key is immutable without a second overlapping trigger.

alter table public.ai_legal_bundle_versions
  add constraint ai_legal_bundle_versions_contract_identity_unique
    unique (legal_bundle_version, bundle_contract_sha256);

-- ---------------------------------------------------------------------------
-- Immutable service-runtime contract catalog.
-- ---------------------------------------------------------------------------

create table public.ai_service_runtime_contract_versions (
  runtime_contract_id text primary key,
  runtime_contract_sha256 text not null,
  reviewed_source_commit_oid text not null,
  legal_bundle_version text not null,
  bundle_contract_sha256 text not null,
  runtime_target_set_sha256 text not null,
  created_at timestamptz not null default clock_timestamp(),
  sealed_at timestamptz,

  constraint ai_service_runtime_contract_versions_id_check
    check (runtime_contract_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  constraint ai_service_runtime_contract_versions_hash_check
    check (runtime_contract_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ai_service_runtime_contract_versions_source_commit_check
    check (reviewed_source_commit_oid ~ '^sha1:[0-9a-f]{40}$'),
  constraint ai_service_runtime_contract_versions_bundle_hash_check
    check (bundle_contract_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ai_service_runtime_contract_versions_target_set_hash_check
    check (runtime_target_set_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ai_service_runtime_contract_versions_sealed_at_check
    check (sealed_at is null or sealed_at >= created_at),
  constraint ai_service_runtime_contract_versions_identity_unique
    unique (runtime_contract_id, runtime_contract_sha256),
  constraint ai_service_runtime_contract_versions_legal_bundle_fkey
    foreign key (legal_bundle_version, bundle_contract_sha256)
    references public.ai_legal_bundle_versions(
      legal_bundle_version,
      bundle_contract_sha256
    )
    match full
);

create table public.ai_service_runtime_target_versions (
  runtime_target_id text primary key,
  runtime_target_sha256 text not null,
  profile_key text not null,
  legal_manifest_id text not null,
  manifest_sha256 text not null,
  route_descriptor_id text not null,
  route_descriptor_sha256 text not null,
  created_at timestamptz not null default clock_timestamp(),

  constraint ai_service_runtime_target_versions_id_check
    check (runtime_target_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  constraint ai_service_runtime_target_versions_hash_check
    check (runtime_target_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ai_service_runtime_target_versions_profile_key_check
    check (profile_key ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  constraint ai_service_runtime_target_versions_manifest_id_check
    check (legal_manifest_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  constraint ai_service_runtime_target_versions_manifest_hash_check
    check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ai_service_runtime_target_versions_route_id_check
    check (route_descriptor_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  constraint ai_service_runtime_target_versions_route_hash_check
    check (route_descriptor_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ai_service_runtime_target_versions_identity_unique
    unique (runtime_target_id, runtime_target_sha256),
  constraint ai_service_runtime_target_versions_projection_unique
    unique (
      runtime_target_id,
      runtime_target_sha256,
      profile_key,
      legal_manifest_id,
      manifest_sha256,
      route_descriptor_id,
      route_descriptor_sha256
    ),
  constraint ai_service_runtime_target_versions_manifest_fkey
    foreign key (legal_manifest_id, manifest_sha256)
    references public.ai_legal_manifest_versions(
      legal_manifest_id,
      manifest_sha256
    )
    match full
);

create table public.ai_service_runtime_contract_targets (
  runtime_contract_id text not null,
  runtime_contract_sha256 text not null,
  runtime_target_id text not null,
  runtime_target_sha256 text not null,
  profile_key text not null,
  legal_manifest_id text not null,
  manifest_sha256 text not null,
  route_descriptor_id text not null,
  route_descriptor_sha256 text not null,
  created_at timestamptz not null default clock_timestamp(),

  primary key (runtime_contract_id, runtime_target_id),
  constraint ai_service_runtime_contract_targets_profile_unique
    unique (runtime_contract_id, profile_key),
  constraint ai_service_runtime_contract_targets_contract_id_check
    check (runtime_contract_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  constraint ai_service_runtime_contract_targets_contract_hash_check
    check (runtime_contract_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ai_service_runtime_contract_targets_target_id_check
    check (runtime_target_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  constraint ai_service_runtime_contract_targets_target_hash_check
    check (runtime_target_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ai_service_runtime_contract_targets_profile_key_check
    check (profile_key ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  constraint ai_service_runtime_contract_targets_manifest_id_check
    check (legal_manifest_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  constraint ai_service_runtime_contract_targets_manifest_hash_check
    check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ai_service_runtime_contract_targets_route_id_check
    check (route_descriptor_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  constraint ai_service_runtime_contract_targets_route_hash_check
    check (route_descriptor_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ai_service_runtime_contract_targets_contract_fkey
    foreign key (runtime_contract_id, runtime_contract_sha256)
    references public.ai_service_runtime_contract_versions(
      runtime_contract_id,
      runtime_contract_sha256
    )
    match full,
  constraint ai_service_runtime_contract_targets_projection_fkey
    foreign key (
      runtime_target_id,
      runtime_target_sha256,
      profile_key,
      legal_manifest_id,
      manifest_sha256,
      route_descriptor_id,
      route_descriptor_sha256
    )
    references public.ai_service_runtime_target_versions(
      runtime_target_id,
      runtime_target_sha256,
      profile_key,
      legal_manifest_id,
      manifest_sha256,
      route_descriptor_id,
      route_descriptor_sha256
    )
    match full
);

create or replace function public.guard_ai_service_runtime_target_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'ai_service_runtime_target_versions rows cannot be updated'
      using errcode = '23514';
  end if;

  raise exception 'ai_service_runtime_target_versions rows cannot be deleted'
    using errcode = '23514';
end;
$$;

create trigger guard_ai_service_runtime_target_version
before update or delete on public.ai_service_runtime_target_versions
for each row execute function public.guard_ai_service_runtime_target_version();

create or replace function public.guard_ai_service_runtime_contract_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_target_count bigint;
  v_target_set_sha256 text;
begin
  if tg_op = 'DELETE' then
    raise exception 'ai_service_runtime_contract_versions rows cannot be deleted'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if new.sealed_at is not null then
      raise exception 'runtime contracts must be inserted unsealed'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.sealed_at is not null then
    raise exception 'sealed runtime contract headers are immutable'
      using errcode = '23514';
  end if;

  if (to_jsonb(new) - 'sealed_at') is distinct from
     (to_jsonb(old) - 'sealed_at') then
    raise exception 'runtime contract header fields are immutable'
      using errcode = '23514';
  end if;

  if new.sealed_at is null then
    return new;
  end if;

  if new.sealed_at < new.created_at then
    raise exception 'runtime contract seal cannot precede creation'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.ai_legal_bundle_versions as bundle
    where bundle.legal_bundle_version = new.legal_bundle_version
      and bundle.bundle_contract_sha256 = new.bundle_contract_sha256
      and bundle.sealed_at is not null
  ) then
    raise exception 'runtime contract requires an already sealed legal bundle'
      using errcode = '23514';
  end if;

  -- The UPDATE already owns this exact root row lock. Membership mutation
  -- obtains the same root FOR UPDATE before changing a child, so the hash is
  -- recomputed from one serial target set in both race orderings.
  select
    count(*),
    encode(
      extensions.digest(
        convert_to(
          string_agg(
            octet_length(convert_to(runtime_target_id, 'UTF8'))::text
              || ':' || runtime_target_id || ':' || runtime_target_sha256,
            E'\n' order by runtime_target_id collate "C"
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
  into v_target_count, v_target_set_sha256
  from public.ai_service_runtime_contract_targets
  where runtime_contract_id = new.runtime_contract_id
    and runtime_contract_sha256 = new.runtime_contract_sha256;

  if v_target_count = 0 then
    raise exception 'runtime contract cannot seal an empty target set'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.ai_service_runtime_contract_targets as membership
    where membership.runtime_contract_id = new.runtime_contract_id
      and membership.runtime_contract_sha256 = new.runtime_contract_sha256
      and not exists (
        select 1
        from public.ai_legal_bundle_manifests as bundle_manifest
        where bundle_manifest.legal_bundle_version = new.legal_bundle_version
          and bundle_manifest.legal_manifest_id = membership.legal_manifest_id
          and bundle_manifest.manifest_sha256 = membership.manifest_sha256
      )
  ) then
    raise exception 'runtime contract target is not a member of its bound legal bundle'
      using errcode = '23514';
  end if;

  if new.runtime_target_set_sha256 is distinct from v_target_set_sha256 then
    raise exception 'runtime contract target-set hash mismatch'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger guard_ai_service_runtime_contract_version
before insert or update or delete on public.ai_service_runtime_contract_versions
for each row execute function public.guard_ai_service_runtime_contract_version();

create or replace function public.guard_ai_service_runtime_contract_target()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_runtime_contract_id text;
  v_runtime_contract_sha256 text;
  v_sealed_at timestamptz;
begin
  if tg_op = 'UPDATE' then
    if new.runtime_contract_id is distinct from old.runtime_contract_id
       or new.runtime_contract_sha256 is distinct from old.runtime_contract_sha256 then
      raise exception 'runtime contract membership parent pair is immutable'
        using errcode = '23514';
    end if;
    if new.created_at is distinct from old.created_at then
      raise exception 'runtime contract membership creation time is immutable'
        using errcode = '23514';
    end if;
  end if;

  v_runtime_contract_id := case when tg_op = 'INSERT'
    then new.runtime_contract_id else old.runtime_contract_id end;
  v_runtime_contract_sha256 := case when tg_op = 'INSERT'
    then new.runtime_contract_sha256 else old.runtime_contract_sha256 end;

  select sealed_at into v_sealed_at
  from public.ai_service_runtime_contract_versions
  where runtime_contract_id = v_runtime_contract_id
    and runtime_contract_sha256 = v_runtime_contract_sha256
  for update;

  if not found then
    raise exception 'runtime contract membership parent does not exist'
      using errcode = '23503';
  end if;

  if v_sealed_at is not null then
    raise exception 'sealed runtime contract target sets are immutable'
      using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger guard_ai_service_runtime_contract_target
before insert or update or delete on public.ai_service_runtime_contract_targets
for each row execute function public.guard_ai_service_runtime_contract_target();

alter table public.ai_service_runtime_contract_versions enable row level security;
alter table public.ai_service_runtime_target_versions enable row level security;
alter table public.ai_service_runtime_contract_targets enable row level security;

revoke all on public.ai_service_runtime_contract_versions
  from public, anon, authenticated, service_role;
revoke all on public.ai_service_runtime_target_versions
  from public, anon, authenticated, service_role;
revoke all on public.ai_service_runtime_contract_targets
  from public, anon, authenticated, service_role;

revoke execute on function public.guard_ai_service_runtime_contract_version()
  from public, anon, authenticated, service_role;
revoke execute on function public.guard_ai_service_runtime_target_version()
  from public, anon, authenticated, service_role;
revoke execute on function public.guard_ai_service_runtime_contract_target()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Runtime binding in immutable policy and request snapshots.
-- ---------------------------------------------------------------------------

alter table public.ai_routing_policy_versions
  add column runtime_contract_id text,
  add column runtime_contract_sha256 text,
  add constraint ai_routing_policy_versions_runtime_pair_check check (
    num_nonnulls(runtime_contract_id, runtime_contract_sha256) in (0, 2)
    and (
      runtime_contract_id is null
      or runtime_contract_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    )
    and (
      runtime_contract_sha256 is null
      or runtime_contract_sha256 ~ '^[0-9a-f]{64}$'
    )
  ),
  add constraint ai_routing_policy_versions_runtime_contract_fkey
    foreign key (runtime_contract_id, runtime_contract_sha256)
    references public.ai_service_runtime_contract_versions(
      runtime_contract_id,
      runtime_contract_sha256
    )
    match full;

alter table public.ai_request_ledger
  add column runtime_contract_id text,
  add column runtime_contract_sha256 text,
  add constraint ai_request_ledger_runtime_contract_fkey
    foreign key (runtime_contract_id, runtime_contract_sha256)
    references public.ai_service_runtime_contract_versions(
      runtime_contract_id,
      runtime_contract_sha256
    )
    match full;

alter table public.ai_request_ledger
  drop constraint ai_request_ledger_route_snapshot_check;

alter table public.ai_request_ledger
  add constraint ai_request_ledger_route_snapshot_check check (
    (
      route_schema_version is null
      and num_nonnulls(
        config_generation,
        routing_policy_version_id,
        profile_version_id,
        price_version_id,
        legal_bundle_version,
        runtime_contract_id,
        runtime_contract_sha256,
        gateway_kind,
        model_id,
        wire_api_kind,
        display_disclosure_key
      ) = 0
    )
    or
    (
      route_schema_version is not distinct from 'route_snapshot_v1'
      and num_nonnulls(
        config_generation,
        routing_policy_version_id,
        profile_version_id,
        price_version_id,
        legal_bundle_version,
        runtime_contract_id,
        runtime_contract_sha256,
        gateway_kind,
        model_id,
        wire_api_kind,
        display_disclosure_key
      ) = 11
      and config_generation >= 0
      and legal_bundle_version ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
      and runtime_contract_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
      and runtime_contract_sha256 ~ '^[0-9a-f]{64}$'
      and gateway_kind in ('direct_deepseek', 'direct_mimo', 'openrouter')
      and length(btrim(model_id)) between 1 and 200
      and wire_api_kind in ('chat_completions_v1', 'responses_v1')
      and display_disclosure_key ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    )
    or
    (
      route_schema_version is not distinct from 'legacy_pricing_v1'
      and profile_version_id is not null
      and price_version_id is not null
      and num_nonnulls(
        config_generation,
        routing_policy_version_id,
        legal_bundle_version,
        runtime_contract_id,
        runtime_contract_sha256,
        gateway_kind,
        model_id,
        wire_api_kind,
        display_disclosure_key
      ) = 0
    )
  );

create or replace function public.guard_ai_request_route_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_profile_display_disclosure_key text;
  v_components_sealed_at timestamptz;
  v_pricing_lane text;
begin
  if tg_op = 'UPDATE' and old.route_schema_version is not null and (
    new.route_schema_version,
    new.config_generation,
    new.routing_policy_version_id,
    new.profile_version_id,
    new.price_version_id,
    new.legal_bundle_version,
    new.runtime_contract_id,
    new.runtime_contract_sha256,
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
    old.runtime_contract_id,
    old.runtime_contract_sha256,
    old.gateway_kind,
    old.model_id,
    old.wire_api_kind,
    old.display_disclosure_key
  ) then
    raise exception 'ai_request_ledger route binding is immutable once frozen'
      using errcode = '23514';
  end if;

  if new.route_schema_version is not distinct from 'legacy_pricing_v1'
     and (
       tg_op = 'INSERT'
       or (
         tg_op = 'UPDATE'
         and old.route_schema_version is null
       )
     ) then
    if new.profile_version_id is not null
       and new.price_version_id is not null
       and num_nonnulls(
         new.config_generation,
         new.routing_policy_version_id,
         new.legal_bundle_version,
         new.runtime_contract_id,
         new.runtime_contract_sha256,
         new.gateway_kind,
         new.model_id,
         new.wire_api_kind,
         new.display_disclosure_key
       ) = 0
       and new.usage_schema_version is not distinct from 'legacy_v1'
       and new.cost_basis is not distinct from 'legacy_request_aggregate' then
      raise exception 'legacy pricing bindings cannot be created by direct ledger writes'
        using errcode = '23514';
    end if;
  end if;

  if new.route_schema_version is not distinct from 'route_snapshot_v1'
     and new.profile_version_id is not null then
    select display_disclosure_key
    into v_profile_display_disclosure_key
    from public.ai_provider_profile_versions
    where id = new.profile_version_id
    for share;

    if not found then
      raise exception 'request route profile version does not exist'
        using errcode = '23503';
    end if;

    if new.display_disclosure_key
       is distinct from v_profile_display_disclosure_key then
      raise exception 'request route disclosure differs from immutable profile disclosure'
        using errcode = '23514';
    end if;
  end if;

  if new.price_version_id is not null then
    select components_sealed_at, pricing_lane
    into v_components_sealed_at, v_pricing_lane
    from public.ai_price_versions
    where id = new.price_version_id
    for share;

    if not found then
      raise exception 'request route price version does not exist'
        using errcode = '23503';
    end if;

    if new.route_schema_version is not distinct from 'legacy_pricing_v1'
       and v_pricing_lane <> 'legacy' then
      raise exception 'legacy pricing binding requires the reserved legacy lane'
        using errcode = '23514';
    end if;

    if new.route_schema_version is not distinct from 'route_snapshot_v1'
       and v_pricing_lane = 'legacy' then
      raise exception 'current route snapshots cannot reference the legacy lane'
        using errcode = '23514';
    end if;

    if v_components_sealed_at is null then
      raise exception 'request route requires an already sealed price version'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Exact calculator structure and unforgeable owner-only price sealing.
-- ---------------------------------------------------------------------------

create table public.ai_price_component_seal_intents (
  price_version_id uuid primary key
    references public.ai_price_versions(id),
  requested_at timestamptz not null,
  requested_txid bigint not null,
  applied_at timestamptz,

  constraint ai_price_component_seal_intents_time_check
    check (applied_at is null or applied_at >= requested_at)
);

alter table public.ai_price_component_seal_intents enable row level security;
revoke all on public.ai_price_component_seal_intents
  from public, anon, authenticated, service_role;

create or replace function public.assert_ai_price_structure_v1(
  p_price_version_id uuid
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_calculator_kind text;
  v_parameters jsonb;
  v_component_count bigint;
  v_required_component_count bigint;
begin
  if p_price_version_id is null then
    raise exception 'price structure requires a non-null price version id'
      using errcode = '23514';
  end if;

  select calculator_kind, parameters
  into v_calculator_kind, v_parameters
  from public.ai_price_versions
  where id = p_price_version_id;

  if not found then
    raise exception 'price structure parent does not exist'
      using errcode = '23503';
  end if;

  if v_calculator_kind is distinct from 'linear_token_v1'
     or v_parameters is distinct from '{}'::jsonb then
    raise exception 'unsupported or malformed price calculator structure'
      using errcode = '23514';
  end if;

  select
    count(*),
    count(*) filter (
      where component in ('input_standard', 'input_cache_read', 'output')
    )
  into v_component_count, v_required_component_count
  from public.ai_price_components
  where price_version_id = p_price_version_id;

  if v_component_count <> 3 or v_required_component_count <> 3 then
    raise exception 'linear_token_v1 requires exactly input_standard, input_cache_read, and output components'
      using errcode = '23514';
  end if;
end;
$$;

create or replace function public.guard_ai_price_component_seal_intent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'price component seal intents cannot be deleted'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if new.applied_at is not null
       or new.requested_txid is distinct from txid_current() then
      raise exception 'price component seal intent authority mismatch'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.price_version_id is distinct from old.price_version_id
     or new.requested_at is distinct from old.requested_at
     or new.requested_txid is distinct from old.requested_txid
     or old.applied_at is not null
     or new.applied_at is null
     or new.applied_at < new.requested_at
     or pg_trigger_depth() <= 1 then
    raise exception 'price component seal intent facts are immutable'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger guard_ai_price_component_seal_intent
before insert or update or delete on public.ai_price_component_seal_intents
for each row execute function public.guard_ai_price_component_seal_intent();

create or replace function public.guard_ai_price_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ai_price_versions rows cannot be deleted'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if new.components_sealed_at is not null then
      raise exception 'ai_price_versions components seal is trigger-managed'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if (to_jsonb(new) - array['valid_to', 'components_sealed_at'])
     is distinct from
     (to_jsonb(old) - array['valid_to', 'components_sealed_at']) then
    raise exception 'ai_price_versions immutable fields cannot be changed'
      using errcode = '23514';
  end if;

  if old.valid_to is null
     and new.valid_to is not null
     and new.components_sealed_at is not distinct from old.components_sealed_at then
    return new;
  end if;

  if old.components_sealed_at is null
     and new.components_sealed_at is not null
     and new.valid_to is not distinct from old.valid_to
     and pg_trigger_depth() > 1
     and exists (
       select 1
       from public.ai_price_component_seal_intents
       where price_version_id = new.id
         and requested_txid = txid_current()
         and requested_at = new.components_sealed_at
         and applied_at is null
     ) then
    return new;
  end if;

  raise exception 'ai_price_versions permits only one-time valid_to closure or owner-authorized component sealing'
    using errcode = '23514';
end;
$$;

create or replace function public.apply_ai_price_component_seal_intent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created_at timestamptz;
  v_components_sealed_at timestamptz;
begin
  select created_at, components_sealed_at
  into v_created_at, v_components_sealed_at
  from public.ai_price_versions
  where id = new.price_version_id
  for update;

  if not found then
    raise exception 'price component seal parent does not exist'
      using errcode = '23503';
  end if;
  if v_components_sealed_at is not null then
    raise exception 'price components are already sealed'
      using errcode = '23514';
  end if;
  if new.requested_at < v_created_at
     or new.requested_txid is distinct from txid_current() then
    raise exception 'price component seal intent is stale or predates its price'
      using errcode = '23514';
  end if;

  perform public.assert_ai_price_structure_v1(new.price_version_id);

  update public.ai_price_versions
  set components_sealed_at = new.requested_at
  where id = new.price_version_id
    and components_sealed_at is null;

  if not found then
    raise exception 'price component seal transition lost its parent lock'
      using errcode = '23514';
  end if;

  update public.ai_price_component_seal_intents
  set applied_at = greatest(clock_timestamp(), new.requested_at)
  where price_version_id = new.price_version_id
    and applied_at is null;

  if not found then
    raise exception 'price component seal intent was not applied exactly once'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger apply_ai_price_component_seal_intent
after insert on public.ai_price_component_seal_intents
for each row execute function public.apply_ai_price_component_seal_intent();

create or replace function public.seal_ai_price_components_v1(
  p_price_version_ids uuid[],
  p_sealed_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_price record;
  v_locked_count bigint := 0;
begin
  if p_price_version_ids is null
     or cardinality(p_price_version_ids) = 0
     or array_position(p_price_version_ids, null) is not null
     or p_sealed_at is null then
    raise exception 'price sealing requires non-empty unique UUIDs and a timestamp'
      using errcode = '23514';
  end if;

  if (
    select count(distinct price_id)
    from unnest(p_price_version_ids) as requested(price_id)
  ) <> cardinality(p_price_version_ids) then
    raise exception 'price sealing requires unique UUIDs'
      using errcode = '23514';
  end if;

  for v_price in
    select id, created_at, components_sealed_at
    from public.ai_price_versions
    where id = any(p_price_version_ids)
    order by id::text collate "C"
    for update
  loop
    v_locked_count := v_locked_count + 1;
    if v_price.components_sealed_at is not null then
      raise exception 'price components are already sealed'
        using errcode = '23514';
    end if;
    if p_sealed_at < v_price.created_at then
      raise exception 'price component seal cannot precede price creation'
        using errcode = '23514';
    end if;
    perform public.assert_ai_price_structure_v1(v_price.id);
  end loop;

  if v_locked_count <> cardinality(p_price_version_ids) then
    raise exception 'price sealing target does not exist'
      using errcode = '23503';
  end if;

  for v_price in
    select requested.price_id as id
    from unnest(p_price_version_ids) as requested(price_id)
    order by requested.price_id::text collate "C"
  loop
    insert into public.ai_price_component_seal_intents (
      price_version_id,
      requested_at,
      requested_txid
    ) values (
      v_price.id,
      p_sealed_at,
      txid_current()
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Strict routing-rules and policy/runtime/legal/price validator.
-- ---------------------------------------------------------------------------

create or replace function public.validate_ai_routing_policy_row_v1(
  p_policy public.ai_routing_policy_versions,
  p_phase text,
  p_at timestamptz,
  p_discovery_only boolean
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_default_route jsonb;
  v_window jsonb;
  v_route jsonb;
  v_target record;
  v_profile record;
  v_price public.ai_price_versions%rowtype;
  v_runtime public.ai_service_runtime_contract_versions%rowtype;
  v_expected_profile_statuses text[];
  v_start_minute integer;
  v_end_minute integer;
  v_weekday_count integer;
begin
  if p_policy is null
     or p_phase is null
     or p_phase not in ('validated', 'canary', 'active', 'reserve')
     or p_at is null then
    raise exception 'routing policy validation phase and timestamp are required'
      using errcode = '23514';
  end if;

  if not (
    (p_phase = 'validated' and p_policy.status = 'validated')
    or (p_phase = 'canary' and p_policy.status = 'canary')
    or (p_phase = 'active' and p_policy.status = 'active')
    or (p_phase = 'reserve' and p_policy.status in ('canary', 'active'))
  ) then
    raise exception 'routing policy status does not match validation phase'
      using errcode = '23514';
  end if;

  if p_policy.timezone is distinct from 'Asia/Shanghai'
     or jsonb_typeof(p_policy.rules) is distinct from 'object'
     or not (p_policy.rules ?& array['schemaVersion', 'defaultRoute', 'windows'])
     or (p_policy.rules - array['schemaVersion', 'defaultRoute', 'windows'])
       is distinct from '{}'::jsonb
     or jsonb_typeof(p_policy.rules->'schemaVersion') is distinct from 'string'
     or p_policy.rules->>'schemaVersion' is distinct from 'routing_rules_v1'
     or jsonb_typeof(p_policy.rules->'defaultRoute') is distinct from 'object'
     or jsonb_typeof(p_policy.rules->'windows') is distinct from 'array'
     or jsonb_array_length(p_policy.rules->'windows') > 32 then
    raise exception 'routing_rules_v1 top-level shape is invalid'
      using errcode = '23514';
  end if;

  v_default_route := p_policy.rules->'defaultRoute';
  if not (v_default_route ?& array['profileVersionId', 'priceVersionId'])
     or (v_default_route - array['profileVersionId', 'priceVersionId'])
       is distinct from '{}'::jsonb
     or jsonb_typeof(v_default_route->'profileVersionId') is distinct from 'string'
     or jsonb_typeof(v_default_route->'priceVersionId') is distinct from 'string'
     or v_default_route->>'profileVersionId'
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_default_route->>'priceVersionId'
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'routing_rules_v1 defaultRoute is invalid'
      using errcode = '23514';
  end if;

  if p_policy.default_profile_version_id::text
     is distinct from v_default_route->>'profileVersionId' then
    raise exception 'routing policy default profile differs from defaultRoute'
      using errcode = '23514';
  end if;

  for v_window in
    select value from jsonb_array_elements(p_policy.rules->'windows')
  loop
    if jsonb_typeof(v_window) is distinct from 'object'
       or not (v_window ?& array['weekdays', 'startMinute', 'endMinute', 'route'])
       or (v_window - array['weekdays', 'startMinute', 'endMinute', 'route'])
         is distinct from '{}'::jsonb
       or jsonb_typeof(v_window->'weekdays') is distinct from 'array'
       or jsonb_array_length(v_window->'weekdays') = 0
       or jsonb_typeof(v_window->'startMinute') is distinct from 'number'
       or jsonb_typeof(v_window->'endMinute') is distinct from 'number'
       or (v_window->>'startMinute') !~ '^(0|[1-9][0-9]{0,3})$'
       or (v_window->>'endMinute') !~ '^(0|[1-9][0-9]{0,3})$'
       or jsonb_typeof(v_window->'route') is distinct from 'object' then
      raise exception 'routing_rules_v1 window shape is invalid'
        using errcode = '23514';
    end if;

    v_start_minute := (v_window->>'startMinute')::integer;
    v_end_minute := (v_window->>'endMinute')::integer;
    if v_start_minute < 0
       or v_start_minute >= v_end_minute
       or v_end_minute > 1440 then
      raise exception 'routing_rules_v1 window minute range is invalid'
        using errcode = '23514';
    end if;

    select count(*), count(distinct weekday.value)
    into v_weekday_count, v_end_minute
    from jsonb_array_elements(v_window->'weekdays') as weekday(value)
    where jsonb_typeof(weekday.value) = 'number'
      and weekday.value #>> '{}' ~ '^[1-7]$';

    if v_weekday_count <> jsonb_array_length(v_window->'weekdays')
       or v_end_minute <> v_weekday_count then
      raise exception 'routing_rules_v1 weekdays must be unique ISO weekday integers'
        using errcode = '23514';
    end if;

    v_route := v_window->'route';
    if not (v_route ?& array['profileVersionId', 'priceVersionId'])
       or (v_route - array['profileVersionId', 'priceVersionId'])
         is distinct from '{}'::jsonb
       or jsonb_typeof(v_route->'profileVersionId') is distinct from 'string'
       or jsonb_typeof(v_route->'priceVersionId') is distinct from 'string'
       or v_route->>'profileVersionId'
         !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or v_route->>'priceVersionId'
         !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'routing_rules_v1 window route is invalid'
        using errcode = '23514';
    end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(p_policy.rules->'windows') with ordinality as left_window(value, ordinal)
    join jsonb_array_elements(p_policy.rules->'windows') with ordinality as right_window(value, ordinal)
      on left_window.ordinal < right_window.ordinal
    where (left_window.value->>'startMinute')::integer
            < (right_window.value->>'endMinute')::integer
      and (right_window.value->>'startMinute')::integer
            < (left_window.value->>'endMinute')::integer
      and exists (
        select 1
        from jsonb_array_elements_text(left_window.value->'weekdays') as left_day(value)
        join jsonb_array_elements_text(right_window.value->'weekdays') as right_day(value)
          using (value)
      )
  ) then
    raise exception 'routing_rules_v1 windows overlap'
      using errcode = '23514';
  end if;

  if p_discovery_only then
    return;
  end if;

  if p_policy.legal_bundle_version is distinct from public.current_ai_terms_version()
     or p_policy.runtime_contract_id is null
     or p_policy.runtime_contract_sha256 is null then
    raise exception 'routing policy requires the current legal bundle and exact runtime pair'
      using errcode = '23514';
  end if;

  select * into v_runtime
  from public.ai_service_runtime_contract_versions
  where runtime_contract_id = p_policy.runtime_contract_id
    and runtime_contract_sha256 = p_policy.runtime_contract_sha256;

  if not found
     or v_runtime.sealed_at is null
     or v_runtime.legal_bundle_version is distinct from p_policy.legal_bundle_version
     or not exists (
       select 1
       from public.ai_legal_bundle_versions as bundle
       where bundle.legal_bundle_version = p_policy.legal_bundle_version
         and bundle.bundle_contract_sha256 = v_runtime.bundle_contract_sha256
         and bundle.sealed_at is not null
     ) then
    raise exception 'routing policy runtime contract is unsealed or legal-unbound'
      using errcode = '23514';
  end if;

  if p_phase = 'reserve' and not exists (
    select 1
    from public.ai_feature_config
    where id = true
      and active_routing_policy_version_id = p_policy.id
  ) then
    raise exception 'reserve validation requires the current routing pointer'
      using errcode = '23514';
  end if;

  v_expected_profile_statuses := case
    when p_phase = 'validated' then array['validated', 'canary', 'active']
    when p_phase = 'canary' then array['canary', 'active']
    when p_phase = 'active' then array['active']
    when p_policy.status = 'canary' then array['canary', 'active']
    else array['active']
  end;

  for v_target in
    select distinct
      target.profile_version_id,
      target.price_version_id
    from (
      select
        (p_policy.rules->'defaultRoute'->>'profileVersionId')::uuid as profile_version_id,
        (p_policy.rules->'defaultRoute'->>'priceVersionId')::uuid as price_version_id
      union all
      select
        (window_entry.value->'route'->>'profileVersionId')::uuid,
        (window_entry.value->'route'->>'priceVersionId')::uuid
      from jsonb_array_elements(p_policy.rules->'windows') as window_entry(value)
    ) as target
    order by target.profile_version_id, target.price_version_id
  loop
    select
      version.*,
      profile.profile_key,
      profile.retired_at as profile_retired_at
    into v_profile
    from public.ai_provider_profile_versions as version
    join public.ai_provider_profiles as profile on profile.id = version.profile_id
    where version.id = v_target.profile_version_id;

    if not found
       or v_profile.status <> all(v_expected_profile_statuses)
       or v_profile.retired_at is not null
       or v_profile.profile_retired_at is not null
       or v_profile.display_disclosure_key is null then
      raise exception 'routing target profile is unavailable for policy phase'
        using errcode = '23514';
    end if;

    select * into v_price
    from public.ai_price_versions
    where id = v_target.price_version_id
      and profile_version_id = v_target.profile_version_id;

    if not found
       or v_price.pricing_lane = 'legacy'
       or v_price.components_sealed_at is null
       or (v_price.valid_to is not null and p_at >= v_price.valid_to)
       or (v_price.provider_effective_to is not null and p_at >= v_price.provider_effective_to)
       or (
         p_phase <> 'validated'
         and (
           p_at < v_price.valid_from
           or (
             v_price.provider_effective_from is not null
             and p_at < v_price.provider_effective_from
           )
         )
       ) then
      raise exception 'routing target price is unavailable for policy phase'
        using errcode = '23514';
    end if;

    perform public.assert_ai_price_structure_v1(v_price.id);

    if not exists (
      select 1
      from public.ai_legal_bundle_manifests as bundle_manifest
      join public.ai_legal_manifest_versions as manifest
        on manifest.legal_manifest_id = bundle_manifest.legal_manifest_id
       and manifest.manifest_sha256 = bundle_manifest.manifest_sha256
      join public.ai_service_runtime_contract_targets as membership
        on membership.runtime_contract_id = p_policy.runtime_contract_id
       and membership.runtime_contract_sha256 = p_policy.runtime_contract_sha256
       and membership.profile_key = v_profile.profile_key
       and membership.legal_manifest_id = bundle_manifest.legal_manifest_id
       and membership.manifest_sha256 = bundle_manifest.manifest_sha256
      join public.ai_service_runtime_target_versions as runtime_target
        on runtime_target.runtime_target_id = membership.runtime_target_id
       and runtime_target.runtime_target_sha256 = membership.runtime_target_sha256
       and runtime_target.profile_key = membership.profile_key
       and runtime_target.legal_manifest_id = membership.legal_manifest_id
       and runtime_target.manifest_sha256 = membership.manifest_sha256
       and runtime_target.route_descriptor_id = membership.route_descriptor_id
       and runtime_target.route_descriptor_sha256 = membership.route_descriptor_sha256
      where bundle_manifest.legal_bundle_version = p_policy.legal_bundle_version
        and bundle_manifest.legal_manifest_id = v_profile.legal_manifest_id
    ) then
      raise exception 'routing target lacks exact legal/runtime coverage'
        using errcode = '23514';
    end if;
  end loop;
end;
$$;

-- DB-013 will introduce the audited operator lifecycle. Until then, direct
-- role DML is not lifecycle authority: an ungranted owner-only primitive must
-- prove the complete lock-ordered snapshot and leave a transaction-bound,
-- single-use intent for the existing row guard.
create table public.ai_routing_policy_transition_intents (
  policy_version_id uuid primary key
    references public.ai_routing_policy_versions(id),
  from_status text not null,
  to_status text not null,
  requested_at timestamptz not null,
  requested_txid bigint not null,
  constraint ai_routing_policy_transition_intents_status_check check (
    from_status in ('draft', 'validated', 'canary')
    and to_status in ('validated', 'canary', 'active')
    and from_status <> to_status
  )
);

alter table public.ai_routing_policy_transition_intents enable row level security;
revoke all on public.ai_routing_policy_transition_intents
  from public, anon, authenticated, service_role;

create or replace function public.guard_ai_routing_policy_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed boolean;
  v_consumed_policy_id uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'ai_routing_policy_versions rows cannot be deleted'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'ai_routing_policy_versions must be inserted as draft'
        using errcode = '23514';
    end if;
    if num_nonnulls(new.validated_at, new.activated_at, new.retired_at) > 0 then
      raise exception 'ai_routing_policy_versions lifecycle timestamps are trigger-managed'
        using errcode = '23514';
    end if;
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

    if new.status is distinct from old.status then
      delete from public.ai_routing_policy_transition_intents
      where policy_version_id = old.id
        and from_status = old.status
        and to_status = new.status
        and requested_txid = txid_current()
      returning policy_version_id into v_consumed_policy_id;

      if v_consumed_policy_id is null then
        raise exception 'direct routing policy lifecycle transitions await DB-013 authority'
          using errcode = '23514';
      end if;
    end if;
  end if;

  if new.status in ('validated', 'canary', 'active') and new.validated_at is null then
    new.validated_at := greatest(clock_timestamp(), new.created_at);
  end if;
  if new.status = 'active' and new.activated_at is null then
    new.activated_at := greatest(clock_timestamp(), new.created_at, new.validated_at);
  end if;
  if new.status = 'retired' and new.retired_at is null then
    new.retired_at := greatest(
      clock_timestamp(),
      new.created_at,
      new.validated_at,
      new.activated_at
    );
  end if;
  return new;
end;
$$;

create or replace function public.lock_and_validate_ai_routing_policy_row_v1(
  p_policy public.ai_routing_policy_versions,
  p_phase text,
  p_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- This first pass is parse/ID discovery only. Callers already hold config
  -- then policy; dependency locks below preserve runtime -> profile parent ->
  -- profile version -> price ordering before authoritative revalidation.
  perform public.validate_ai_routing_policy_row_v1(
    p_policy,
    p_phase,
    p_at,
    true
  );

  perform 1
  from public.ai_service_runtime_contract_versions
  where runtime_contract_id = p_policy.runtime_contract_id
    and runtime_contract_sha256 = p_policy.runtime_contract_sha256
  for share;

  perform 1
  from public.ai_provider_profiles as profile
  join public.ai_provider_profile_versions as version
    on version.profile_id = profile.id
  where version.id in (
    select distinct target.profile_version_id
    from (
      select (p_policy.rules->'defaultRoute'->>'profileVersionId')::uuid
        as profile_version_id
      union all
      select (window_entry.value->'route'->>'profileVersionId')::uuid
      from jsonb_array_elements(p_policy.rules->'windows') as window_entry(value)
    ) as target
  )
  order by profile.id
  for share of profile;

  perform 1
  from public.ai_provider_profile_versions as version
  where version.id in (
    select distinct target.profile_version_id
    from (
      select (p_policy.rules->'defaultRoute'->>'profileVersionId')::uuid
        as profile_version_id
      union all
      select (window_entry.value->'route'->>'profileVersionId')::uuid
      from jsonb_array_elements(p_policy.rules->'windows') as window_entry(value)
    ) as target
  )
  order by version.id
  for share;

  perform 1
  from public.ai_price_versions as price
  where price.id in (
    select distinct target.price_version_id
    from (
      select (p_policy.rules->'defaultRoute'->>'priceVersionId')::uuid
        as price_version_id
      union all
      select (window_entry.value->'route'->>'priceVersionId')::uuid
      from jsonb_array_elements(p_policy.rules->'windows') as window_entry(value)
    ) as target
  )
  order by price.id
  for share;

  perform public.validate_ai_routing_policy_row_v1(
    p_policy,
    p_phase,
    p_at,
    false
  );
end;
$$;

create or replace function public.transition_ai_routing_policy_v1(
  p_policy_id uuid,
  p_to_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_policy public.ai_routing_policy_versions%rowtype;
  v_candidate public.ai_routing_policy_versions%rowtype;
  v_at timestamptz := clock_timestamp();
  v_allowed boolean;
begin
  if p_policy_id is null
     or p_to_status is null
     or p_to_status not in ('validated', 'canary', 'active') then
    raise exception 'owner transition requires a policy id and promotion phase'
      using errcode = '23514';
  end if;

  perform 1
  from public.ai_feature_config
  where id = true
  for share;
  if not found then
    raise exception 'ai feature config singleton is missing'
      using errcode = '23514';
  end if;

  select * into v_policy
  from public.ai_routing_policy_versions
  where id = p_policy_id
  for update;
  if not found then
    raise exception 'routing policy does not exist'
      using errcode = '23503';
  end if;

  v_allowed := case v_policy.status
    when 'draft' then p_to_status = 'validated'
    when 'validated' then p_to_status in ('canary', 'active')
    when 'canary' then p_to_status = 'active'
    else false
  end;
  if not v_allowed then
    raise exception 'owner routing policy promotion is invalid: % -> %',
      v_policy.status, p_to_status using errcode = '23514';
  end if;

  v_candidate := v_policy;
  v_candidate.status := p_to_status;
  perform public.lock_and_validate_ai_routing_policy_row_v1(
    v_candidate,
    p_to_status,
    v_at
  );

  insert into public.ai_routing_policy_transition_intents (
    policy_version_id,
    from_status,
    to_status,
    requested_at,
    requested_txid
  ) values (
    v_policy.id,
    v_policy.status,
    p_to_status,
    v_at,
    txid_current()
  );

  update public.ai_routing_policy_versions
  set status = p_to_status
  where id = v_policy.id;

  if exists (
    select 1
    from public.ai_routing_policy_transition_intents
    where policy_version_id = v_policy.id
  ) then
    raise exception 'routing policy transition intent was not consumed'
      using errcode = '23514';
  end if;
end;
$$;

create or replace function public.assert_ai_routing_policy_v1(
  p_policy_id uuid,
  p_phase text,
  p_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_policy public.ai_routing_policy_versions%rowtype;
begin
  if p_policy_id is null
     or p_phase is null
     or p_phase not in ('validated', 'canary', 'active', 'reserve')
     or p_at is null then
    raise exception 'routing policy id, exact phase, and timestamp are required'
      using errcode = '23514';
  end if;

  perform 1
  from public.ai_feature_config
  where id = true
  for share;
  if not found then
    raise exception 'ai feature config singleton is missing'
      using errcode = '23514';
  end if;

  select * into v_policy
  from public.ai_routing_policy_versions
  where id = p_policy_id
  for share;
  if not found then
    raise exception 'routing policy does not exist'
      using errcode = '23503';
  end if;

  perform public.lock_and_validate_ai_routing_policy_row_v1(
    v_policy,
    p_phase,
    p_at
  );
end;
$$;

create or replace function public.validate_ai_routing_policy_transition_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status
     and new.status in ('validated', 'canary', 'active') then
    perform public.validate_ai_routing_policy_row_v1(
      new,
      new.status,
      clock_timestamp(),
      false
    );
  end if;
  return null;
end;
$$;

create trigger validate_ai_routing_policy_transition_v1
after update of status on public.ai_routing_policy_versions
for each row execute function public.validate_ai_routing_policy_transition_v1();

create or replace function public.guard_ai_feature_routing_pointer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_policy public.ai_routing_policy_versions%rowtype;
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
      where id = new.active_routing_policy_version_id
      for update;

      if not found or v_policy.status not in ('canary', 'active') then
        raise exception 'active routing pointer requires a canary or active policy'
          using errcode = '23514';
      end if;

      perform public.assert_ai_routing_policy_v1(
        v_policy.id,
        v_policy.status,
        clock_timestamp()
      );
    end if;

    if old.config_generation = 9223372036854775807 then
      raise exception 'ai_feature_config config_generation exhausted'
        using errcode = '22003';
    end if;
    new.config_generation := old.config_generation + 1;
    new.routing_updated_at := now();
  elsif new.config_generation is distinct from old.config_generation
     or new.routing_updated_at is distinct from old.routing_updated_at
     or new.routing_updated_by is distinct from old.routing_updated_by
     or new.routing_change_reason is distinct from old.routing_change_reason then
    raise exception 'routing audit and generation change only with the routing pointer'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_ai_request_route_snapshot()
  from public, anon, authenticated, service_role;
revoke execute on function public.assert_ai_price_structure_v1(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.guard_ai_price_component_seal_intent()
  from public, anon, authenticated, service_role;
revoke execute on function public.apply_ai_price_component_seal_intent()
  from public, anon, authenticated, service_role;
revoke execute on function public.seal_ai_price_components_v1(uuid[], timestamptz)
  from public, anon, authenticated, service_role;
revoke execute on function public.validate_ai_routing_policy_row_v1(
  public.ai_routing_policy_versions,
  text,
  timestamptz,
  boolean
) from public, anon, authenticated, service_role;
revoke execute on function public.guard_ai_routing_policy_version()
  from public, anon, authenticated, service_role;
revoke execute on function public.lock_and_validate_ai_routing_policy_row_v1(
  public.ai_routing_policy_versions,
  text,
  timestamptz
) from public, anon, authenticated, service_role;
revoke execute on function public.transition_ai_routing_policy_v1(uuid, text)
  from public, anon, authenticated, service_role;
revoke execute on function public.assert_ai_routing_policy_v1(uuid, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke execute on function public.validate_ai_routing_policy_transition_v1()
  from public, anon, authenticated, service_role;
revoke execute on function public.guard_ai_feature_routing_pointer()
  from public, anon, authenticated, service_role;

commit;
