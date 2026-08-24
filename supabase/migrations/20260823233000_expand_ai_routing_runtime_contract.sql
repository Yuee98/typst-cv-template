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

commit;
