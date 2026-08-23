-- Recurring pricing lanes, provider-effective provenance, immutable legal
-- bundle membership, and the historical cost-only request discriminator.
--
-- This migration is schema-only. It deliberately does not seed configuration,
-- expose operator RPCs, seal price components, or activate routing. DB-007 owns
-- the private price validation/sealing helper used by later audited flows.

begin;

-- ---------------------------------------------------------------------------
-- One immutable price row is one rate set in one pricing lane.
-- ---------------------------------------------------------------------------

alter table public.ai_price_versions
  add column pricing_lane text default 'default',
  add column provider_effective_from timestamptz,
  add column provider_effective_to timestamptz;

-- The temporary default above is only a migration backfill mechanism. Keep
-- this explicit update so the invariant remains visible if this migration is
-- replayed against rows written by an older foundation deployment.
update public.ai_price_versions
set pricing_lane = 'default'
where pricing_lane is null;

alter table public.ai_price_versions
  alter column pricing_lane set not null,
  add constraint ai_price_versions_pricing_lane_check
    check (pricing_lane ~ '^[a-z0-9][a-z0-9._-]*$'),
  add constraint ai_price_versions_provider_effective_range_check check (
    provider_effective_from is null
    or provider_effective_to is null
    or provider_effective_to > provider_effective_from
  );

alter table public.ai_price_versions
  drop constraint ai_price_versions_identity_unique,
  drop constraint ai_price_versions_no_overlap;

alter table public.ai_price_versions
  add constraint ai_price_versions_identity_unique
    unique (profile_version_id, pricing_lane, version),
  add constraint ai_price_versions_no_overlap
    exclude using gist (
      profile_version_id with =,
      pricing_lane with =,
      tstzrange(valid_from, valid_to, '[)') with &&
    );

-- Every post-migration author must choose the lane explicitly.
alter table public.ai_price_versions
  alter column pricing_lane drop default;

-- ---------------------------------------------------------------------------
-- Whole-bundle legal manifest seal.
-- ---------------------------------------------------------------------------

create table public.ai_legal_bundle_versions (
  legal_bundle_version text primary key,
  bundle_contract_sha256 text not null,
  manifest_set_sha256 text not null,
  created_at timestamptz not null default clock_timestamp(),
  sealed_at timestamptz,

  constraint ai_legal_bundle_versions_key_check
    check (length(btrim(legal_bundle_version)) > 0),
  constraint ai_legal_bundle_versions_contract_hash_check
    check (bundle_contract_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ai_legal_bundle_versions_manifest_hash_check
    check (manifest_set_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ai_legal_bundle_versions_sealed_at_check
    check (sealed_at is null or sealed_at >= created_at)
);

create table public.ai_legal_bundle_manifests (
  legal_bundle_version text not null
    references public.ai_legal_bundle_versions(legal_bundle_version),
  legal_manifest_id text not null,
  manifest_sha256 text not null,
  created_at timestamptz not null default clock_timestamp(),

  primary key (legal_bundle_version, legal_manifest_id),
  constraint ai_legal_bundle_manifests_id_check
    check (length(btrim(legal_manifest_id)) > 0),
  constraint ai_legal_bundle_manifests_hash_check
    check (manifest_sha256 ~ '^[0-9a-f]{64}$')
);

create or replace function public.guard_ai_legal_bundle_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_manifest_count bigint;
  v_manifest_set_sha256 text;
begin
  if tg_op = 'DELETE' then
    raise exception 'ai_legal_bundle_versions rows cannot be deleted'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if new.sealed_at is not null then
      raise exception 'ai legal bundles must be inserted unsealed'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.sealed_at is not null then
    raise exception 'sealed ai legal bundle headers are immutable'
      using errcode = '23514';
  end if;

  if (to_jsonb(new) - 'sealed_at') is distinct from
     (to_jsonb(old) - 'sealed_at') then
    raise exception 'ai legal bundle header fields are immutable'
      using errcode = '23514';
  end if;

  if new.sealed_at is null then
    return new;
  end if;

  if new.sealed_at < new.created_at then
    raise exception 'ai legal bundle seal cannot precede creation'
      using errcode = '23514';
  end if;

  -- Canonical manifest-set bytes are the C-collated, newline-joined sequence
  --   <UTF-8 byte length of manifest id>:<manifest id>:<lowerhex64 hash>
  -- Length-prefixing makes arbitrary UTF-8 identifiers unambiguous. The hash
  -- covers exactly the complete child set and no wall-clock metadata.
  select
    count(*),
    encode(
      extensions.digest(
        convert_to(
          string_agg(
            octet_length(convert_to(legal_manifest_id, 'UTF8'))::text
              || ':' || legal_manifest_id || ':' || manifest_sha256,
            E'\n' order by legal_manifest_id collate "C"
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
  into v_manifest_count, v_manifest_set_sha256
  from public.ai_legal_bundle_manifests
  where legal_bundle_version = new.legal_bundle_version;

  if v_manifest_count = 0 then
    raise exception 'ai legal bundle cannot seal an empty manifest set'
      using errcode = '23514';
  end if;

  if new.manifest_set_sha256 is distinct from v_manifest_set_sha256 then
    raise exception 'ai legal bundle manifest-set hash mismatch'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger guard_ai_legal_bundle_version
before insert or update or delete on public.ai_legal_bundle_versions
for each row execute function public.guard_ai_legal_bundle_version();

create or replace function public.guard_ai_legal_bundle_manifest()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_legal_bundle_version text;
  v_sealed_at timestamptz;
begin
  v_legal_bundle_version := case when tg_op = 'INSERT' then new.legal_bundle_version
                                 else old.legal_bundle_version end;

  if tg_op = 'UPDATE' then
    if new.legal_bundle_version is distinct from old.legal_bundle_version
       or new.legal_manifest_id is distinct from old.legal_manifest_id
       or new.created_at is distinct from old.created_at then
      raise exception 'ai legal bundle manifest identity is immutable'
        using errcode = '23514';
    end if;
  end if;

  select sealed_at into v_sealed_at
  from public.ai_legal_bundle_versions
  where legal_bundle_version = v_legal_bundle_version
  for update;

  if not found then
    raise exception 'ai legal bundle header does not exist'
      using errcode = '23503';
  end if;

  if v_sealed_at is not null then
    raise exception 'sealed ai legal bundle manifest sets are immutable'
      using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger guard_ai_legal_bundle_manifest
before insert or update or delete on public.ai_legal_bundle_manifests
for each row execute function public.guard_ai_legal_bundle_manifest();

alter table public.ai_legal_bundle_versions enable row level security;
alter table public.ai_legal_bundle_manifests enable row level security;

revoke all on public.ai_legal_bundle_versions from public, anon, authenticated;
revoke all on public.ai_legal_bundle_manifests from public, anon, authenticated;
grant select, insert, update, delete on public.ai_legal_bundle_versions to service_role;
grant select, insert, update, delete on public.ai_legal_bundle_manifests to service_role;

revoke execute on function public.guard_ai_legal_bundle_version()
  from public, anon, authenticated, service_role;
revoke execute on function public.guard_ai_legal_bundle_manifest()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Exact request route discriminators and seal assertion.
-- ---------------------------------------------------------------------------

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
        gateway_kind,
        model_id,
        wire_api_kind,
        display_disclosure_key
      ) = 0
    )
    or
    (
      route_schema_version = 'route_snapshot_v1'
      and num_nonnulls(
        config_generation,
        routing_policy_version_id,
        profile_version_id,
        price_version_id,
        legal_bundle_version,
        gateway_kind,
        model_id,
        wire_api_kind,
        display_disclosure_key
      ) = 9
      and config_generation >= 0
      and length(btrim(legal_bundle_version)) > 0
      and gateway_kind in ('direct_deepseek', 'direct_mimo', 'openrouter')
      and length(btrim(model_id)) > 0
      and wire_api_kind in ('chat_completions_v1', 'responses_v1')
      and length(btrim(display_disclosure_key)) > 0
    )
    or
    (
      route_schema_version = 'legacy_pricing_v1'
      and profile_version_id is not null
      and price_version_id is not null
      and num_nonnulls(
        config_generation,
        routing_policy_version_id,
        legal_bundle_version,
        gateway_kind,
        model_id,
        wire_api_kind,
        display_disclosure_key
      ) = 0
    )
  );

alter table public.ai_request_ledger
  add constraint ai_request_ledger_legacy_pricing_shape_check check (
    route_schema_version is distinct from 'legacy_pricing_v1'
    or (
      usage_schema_version = 'legacy_v1'
      and cost_basis = 'legacy_request_aggregate'
    )
  );

create or replace function public.guard_ai_request_route_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
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
    raise exception 'ai_request_ledger route binding is immutable once frozen'
      using errcode = '23514';
  end if;

  -- Historical cost-only bindings are migration updates, never reservation
  -- inserts. Reserve V1 inserts no route discriminator and Reserve V2 inserts
  -- route_snapshot_v1, so this also fails closed if either path regresses.
  if tg_op = 'INSERT' and new.route_schema_version = 'legacy_pricing_v1' then
    raise exception 'legacy pricing bindings cannot be created by reservation insert'
      using errcode = '23514';
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

    if new.route_schema_version = 'legacy_pricing_v1'
       and v_pricing_lane <> 'legacy' then
      raise exception 'legacy pricing binding requires the reserved legacy lane'
        using errcode = '23514';
    end if;

    if new.route_schema_version = 'route_snapshot_v1'
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

-- Component authoring and audited sealing serialize on the parent price row.
-- This migration keeps the existing immutable component-row rule; every new
-- insert additionally takes the same parent FOR UPDATE lock used by DB-007.
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

  if not found then
    raise exception 'ai_price_components parent price does not exist'
      using errcode = '23503';
  end if;

  if v_components_sealed_at is not null then
    raise exception 'cannot add components to a sealed price version'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_ai_request_route_snapshot()
  from public, anon, authenticated, service_role;
revoke execute on function public.guard_ai_price_component()
  from public, anon, authenticated, service_role;

commit;
