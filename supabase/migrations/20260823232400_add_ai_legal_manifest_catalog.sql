-- Global immutable legal-manifest catalog and bundle membership binding.
--
-- This migration is schema-only. It does not register a manifest, author or
-- seal a legal bundle, expose a registration function, or activate routing.
-- Reviewed owner-only CFG migrations are the sole publication mechanism.

begin;

-- Legal identifiers are portable code identifiers, not display strings.
-- Tighten the DB-003A draft checks before any catalog data is published.
alter table public.ai_legal_bundle_versions
  drop constraint ai_legal_bundle_versions_key_check,
  add constraint ai_legal_bundle_versions_key_check
    check (legal_bundle_version ~ '^[a-z0-9][a-z0-9._-]{0,199}$');

alter table public.ai_legal_bundle_manifests
  drop constraint ai_legal_bundle_manifests_id_check,
  add constraint ai_legal_bundle_manifests_id_check
    check (legal_manifest_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$');

-- A manifest ID has exactly one semantic hash globally. The primary key
-- serializes concurrent attempts to publish the same ID, while the composite
-- key is the exact target of bundle membership provenance.
create table public.ai_legal_manifest_versions (
  legal_manifest_id text primary key,
  manifest_sha256 text not null,
  created_at timestamptz not null default clock_timestamp(),

  constraint ai_legal_manifest_versions_id_check
    check (legal_manifest_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  constraint ai_legal_manifest_versions_hash_check
    check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ai_legal_manifest_versions_identity_unique
    unique (legal_manifest_id, manifest_sha256)
);

create or replace function public.guard_ai_legal_manifest_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'ai_legal_manifest_versions rows cannot be updated'
      using errcode = '23514';
  end if;

  raise exception 'ai_legal_manifest_versions rows cannot be deleted'
    using errcode = '23514';
end;
$$;

create trigger guard_ai_legal_manifest_version
before update or delete on public.ai_legal_manifest_versions
for each row execute function public.guard_ai_legal_manifest_version();

alter table public.ai_legal_bundle_manifests
  add constraint ai_legal_bundle_manifests_catalog_fkey
    foreign key (legal_manifest_id, manifest_sha256)
    references public.ai_legal_manifest_versions(
      legal_manifest_id,
      manifest_sha256
    );

alter table public.ai_legal_manifest_versions enable row level security;

revoke all on public.ai_legal_manifest_versions
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.ai_legal_manifest_versions
  to service_role;

-- Normalize the inherited DB-003A grants as well. In particular, authoring
-- never grants schema-level TRUNCATE, REFERENCES, or TRIGGER authority.
revoke all on public.ai_legal_bundle_versions from service_role;
revoke all on public.ai_legal_bundle_manifests from service_role;
grant select, insert, update, delete on public.ai_legal_bundle_versions
  to service_role;
grant select, insert, update, delete on public.ai_legal_bundle_manifests
  to service_role;

-- DB-003B preserves DB-003A's dark-stack service-role authoring posture.
-- Catalog UPDATE/DELETE remain structurally forbidden by the trigger above;
-- DB-013 owns the later operator-lifecycle privilege contraction.

revoke execute on function public.guard_ai_legal_manifest_version()
  from public, anon, authenticated, service_role;

commit;
