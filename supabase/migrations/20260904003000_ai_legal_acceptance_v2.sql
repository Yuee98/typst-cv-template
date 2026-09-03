-- I05 successor disclosure and exact-consent read/write boundary. The v1
-- static terms functions and existing acceptance rows remain unchanged.
begin;

alter table public.ai_legal_display_versions_v2
  add constraint ai_legal_display_versions_v2_content_identity_unique
  unique (display_disclosure_key, legal_bundle_version, content_sha256);

create table public.user_ai_legal_acceptances_v2 (
  user_id uuid not null references auth.users(id) on delete cascade,
  legal_bundle_version text not null,
  display_disclosure_key text not null,
  content_sha256 text not null,
  accepted_at timestamptz not null default clock_timestamp(),

  primary key (
    user_id, legal_bundle_version, display_disclosure_key, content_sha256
  ),
  constraint user_ai_legal_acceptances_v2_display_fkey foreign key (
    display_disclosure_key, legal_bundle_version, content_sha256
  ) references public.ai_legal_display_versions_v2 (
    display_disclosure_key, legal_bundle_version, content_sha256
  ),
  constraint user_ai_legal_acceptances_v2_bundle_check
    check (legal_bundle_version ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  constraint user_ai_legal_acceptances_v2_display_check
    check (display_disclosure_key ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  constraint user_ai_legal_acceptances_v2_hash_check
    check (content_sha256 ~ '^[0-9a-f]{64}$')
);

create function public.guard_user_ai_legal_acceptance_v2()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'v2 legal acceptances are immutable'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from public.ai_current_legal_bundle_v2 as current
    join public.ai_legal_display_versions_v2 as display
      on display.legal_bundle_version = current.legal_bundle_version
    where current.singleton
      and current.legal_bundle_version = new.legal_bundle_version
      and display.display_disclosure_key = new.display_disclosure_key
      and display.content_sha256 = new.content_sha256
      and display.sealed_at is not null
  ) then
    raise exception 'v2 legal acceptance requires the current sealed display'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger guard_user_ai_legal_acceptance_v2
before insert or update on public.user_ai_legal_acceptances_v2
for each row execute function public.guard_user_ai_legal_acceptance_v2();

create function public.has_accepted_ai_legal_disclosure_v2(
  p_user_id uuid,
  p_legal_bundle_version text,
  p_display_disclosure_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from public.user_ai_legal_acceptances_v2 as acceptance
    join public.ai_legal_display_versions_v2 as display
      on display.display_disclosure_key = acceptance.display_disclosure_key
     and display.legal_bundle_version = acceptance.legal_bundle_version
     and display.content_sha256 = acceptance.content_sha256
    where acceptance.user_id = p_user_id
      and acceptance.legal_bundle_version = p_legal_bundle_version
      and acceptance.display_disclosure_key = p_display_disclosure_key
      and display.sealed_at is not null
  ), false);
$$;

create function public.accept_ai_legal_disclosure_v2(
  p_expected_user_id uuid,
  p_legal_bundle_version text,
  p_display_disclosure_key text,
  p_content_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_current public.ai_current_legal_bundle_v2%rowtype;
  v_display public.ai_legal_display_versions_v2%rowtype;
begin
  v_user_id := auth.uid();
  if v_user_id is null
     or v_user_id is distinct from p_expected_user_id
     or auth.role() is distinct from 'authenticated' then
    raise exception 'authenticated user mismatch' using errcode = '42501';
  end if;

  select * into v_current
  from public.ai_current_legal_bundle_v2
  where singleton
  for share;
  select * into v_display
  from public.ai_legal_display_versions_v2
  where display_disclosure_key = p_display_disclosure_key
    and legal_bundle_version = p_legal_bundle_version
    and content_sha256 = p_content_sha256
    and sealed_at is not null;

  if v_current.legal_bundle_version is distinct from p_legal_bundle_version
     or v_display.display_disclosure_key is null then
    raise exception 'current sealed legal disclosure mismatch'
      using errcode = '23514';
  end if;

  insert into public.user_ai_legal_acceptances_v2 (
    user_id, legal_bundle_version, display_disclosure_key, content_sha256
  ) values (
    v_user_id, p_legal_bundle_version, p_display_disclosure_key,
    p_content_sha256
  ) on conflict do nothing;

  -- The existing reserve routine still checks the bundle-level row. The new
  -- request-ledger trigger below independently requires this exact display
  -- acceptance for every V2 profile, so the compatibility row cannot bypass
  -- the successor boundary.
  insert into public.user_terms_acceptances (
    user_id, document_key, version
  ) values (
    v_user_id, 'ai_terms', p_legal_bundle_version
  ) on conflict (user_id, document_key, version) do nothing;

  return jsonb_build_object(
    'schemaVersion', 'ai_legal_acceptance_v2',
    'legalBundleVersion', p_legal_bundle_version,
    'displayDisclosureKey', p_display_disclosure_key,
    'contentSha256', p_content_sha256,
    'accepted', true
  );
end;
$$;

create function public.get_ai_legal_display_v2(
  p_legal_bundle_version text,
  p_display_disclosure_key text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'schemaVersion', 'legal_display_v2',
    'displayDisclosureKey', display.display_disclosure_key,
    'legalBundleVersion', display.legal_bundle_version,
    'legalManifestId', display.legal_manifest_id,
    'providerId', display.provider_id,
    'recipientKey', display.recipient_key,
    'modelId', display.model_id,
    'contentSha256', display.content_sha256,
    'factIds', to_jsonb(display.fact_ids),
    'evidenceIds', to_jsonb(display.evidence_ids),
    'zh', display.content -> 'zh',
    'en', display.content -> 'en'
  )
  from public.ai_legal_display_versions_v2 as display
  where display.legal_bundle_version = p_legal_bundle_version
    and display.display_disclosure_key = p_display_disclosure_key
    and display.sealed_at is not null;
$$;

create function public.get_ai_polish_availability_v2(
  p_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base jsonb;
  v_version public.ai_provider_profile_versions%rowtype;
  v_display jsonb;
begin
  v_base := public.get_ai_polish_availability_v1(p_user_id);
  if v_base ->> 'enabled' is distinct from 'true' then
    return v_base || jsonb_build_object(
      'schemaVersion', 'ai_polish_availability_v2',
      'legalDisplay', null
    );
  end if;

  select * into v_version
  from public.ai_provider_profile_versions
  where id = (v_base ->> 'profileVersionId')::uuid;
  if not found then
    return jsonb_build_object(
      'schemaVersion', 'ai_polish_availability_v2',
      'enabled', false,
      'configGeneration', null,
      'routingPolicyVersionId', null,
      'profileVersionId', null,
      'legalBundleVersion', null,
      'runtimeContractId', null,
      'displayDisclosureKey', null,
      'legalDisplay', null,
      'termsAccepted', false
    );
  end if;

  if v_version.execution_schema_version = 'profile_execution_config_v1' then
    return v_base || jsonb_build_object(
      'schemaVersion', 'ai_polish_availability_v2',
      'legalDisplay', null
    );
  end if;

  if v_version.execution_schema_version is distinct from
       'profile_execution_config_v2'
     or not exists (
       select 1
       from public.ai_runtime_target_bindings_v2 as binding
       where binding.runtime_contract_id = v_base ->> 'runtimeContractId'
         and binding.profile_version_id = v_version.id
         and binding.legal_bundle_version = v_base ->> 'legalBundleVersion'
         and binding.display_disclosure_key =
           v_base ->> 'displayDisclosureKey'
     ) then
    return jsonb_build_object(
      'schemaVersion', 'ai_polish_availability_v2',
      'enabled', false,
      'configGeneration', null,
      'routingPolicyVersionId', null,
      'profileVersionId', null,
      'legalBundleVersion', null,
      'runtimeContractId', null,
      'displayDisclosureKey', null,
      'legalDisplay', null,
      'termsAccepted', false
    );
  end if;

  v_display := public.get_ai_legal_display_v2(
    v_base ->> 'legalBundleVersion',
    v_base ->> 'displayDisclosureKey'
  );
  if v_display is null then
    return jsonb_build_object(
      'schemaVersion', 'ai_polish_availability_v2',
      'enabled', false,
      'configGeneration', null,
      'routingPolicyVersionId', null,
      'profileVersionId', null,
      'legalBundleVersion', null,
      'runtimeContractId', null,
      'displayDisclosureKey', null,
      'legalDisplay', null,
      'termsAccepted', false
    );
  end if;

  return v_base || jsonb_build_object(
    'schemaVersion', 'ai_polish_availability_v2',
    'legalDisplay', v_display,
    'termsAccepted', public.has_accepted_ai_legal_disclosure_v2(
      p_user_id,
      v_base ->> 'legalBundleVersion',
      v_base ->> 'displayDisclosureKey'
    )
  );
exception
  when others then
    return jsonb_build_object(
      'schemaVersion', 'ai_polish_availability_v2',
      'enabled', false,
      'configGeneration', null,
      'routingPolicyVersionId', null,
      'profileVersionId', null,
      'legalBundleVersion', null,
      'runtimeContractId', null,
      'displayDisclosureKey', null,
      'legalDisplay', null,
      'termsAccepted', false
    );
end;
$$;

create function public.guard_ai_request_legal_acceptance_v2()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_execution_schema_version text;
begin
  select version.execution_schema_version
  into v_execution_schema_version
  from public.ai_provider_profile_versions as version
  where version.id = new.profile_version_id;
  if v_execution_schema_version = 'profile_execution_config_v2'
     and not public.has_accepted_ai_legal_disclosure_v2(
       new.user_id,
       new.legal_bundle_version,
       new.display_disclosure_key
     ) then
    raise exception 'exact v2 legal disclosure acceptance is required'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger guard_ai_request_legal_acceptance_v2
before insert on public.ai_request_ledger
for each row execute function public.guard_ai_request_legal_acceptance_v2();

alter table public.user_ai_legal_acceptances_v2 enable row level security;
revoke all on public.user_ai_legal_acceptances_v2
  from public, anon, authenticated, service_role;

revoke all on function public.guard_user_ai_legal_acceptance_v2(),
  public.has_accepted_ai_legal_disclosure_v2(uuid, text, text),
  public.accept_ai_legal_disclosure_v2(uuid, text, text, text),
  public.get_ai_legal_display_v2(text, text),
  public.get_ai_polish_availability_v2(uuid),
  public.guard_ai_request_legal_acceptance_v2()
  from public, anon, authenticated, service_role;

grant execute on function public.accept_ai_legal_disclosure_v2(
  uuid, text, text, text
) to authenticated;
grant execute on function public.get_ai_legal_display_v2(text, text),
  public.get_ai_polish_availability_v2(uuid)
  to service_role;

commit;
