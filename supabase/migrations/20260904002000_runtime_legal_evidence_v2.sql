-- I05 additive runtime and legal evidence. Existing v1 rows, routines and
-- descriptors remain unchanged; no route, pointer or legal current is moved.
begin;

-- ---------------------------------------------------------------------------
-- Reviewed code capability. This authorizes parameterized implementation
-- semantics only; it never authorizes a concrete destination or model.
-- ---------------------------------------------------------------------------

create table public.ai_runtime_code_capabilities_v2 (
  code_capability_id text primary key,
  gateway_kind text not null,
  adapter_kind text not null references public.ai_adapter_catalog(adapter_id),
  wire_api_kind text not null,
  capability_contract_id text not null,
  cache_policy_id text not null,
  calculator_kind text not null,
  implementation_evidence_ids text[] not null,
  descriptor_sha256 text not null,
  created_at timestamptz not null default clock_timestamp(),

  constraint ai_runtime_code_capabilities_v2_id_check
    check (code_capability_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  constraint ai_runtime_code_capabilities_v2_gateway_check
    check (gateway_kind in ('direct_deepseek', 'direct_mimo')),
  constraint ai_runtime_code_capabilities_v2_wire_check
    check (wire_api_kind in ('chat_completions_v1', 'responses_v1')),
  constraint ai_runtime_code_capabilities_v2_semantics_check check (
    capability_contract_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    and cache_policy_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    and calculator_kind ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
  ),
  constraint ai_runtime_code_capabilities_v2_evidence_check
    check (cardinality(implementation_evidence_ids) between 1 and 32),
  constraint ai_runtime_code_capabilities_v2_hash_check
    check (descriptor_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ai_runtime_code_capabilities_v2_identity_unique
    unique (code_capability_id, descriptor_sha256)
);

create function public.guard_ai_runtime_code_capability_v2()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_evidence_id text;
  v_payload text;
  v_hash text;
begin
  if tg_op = 'UPDATE' then
    raise exception 'runtime code capability rows cannot be updated'
      using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'runtime code capability rows cannot be deleted'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from unnest(new.implementation_evidence_ids) as evidence(id)
    where evidence.id is null
       or evidence.id !~ '^[a-z0-9][a-z0-9._-]{0,199}$'
  ) or cardinality(new.implementation_evidence_ids) is distinct from (
    select count(distinct evidence.id)
    from unnest(new.implementation_evidence_ids) as evidence(id)
  ) then
    raise exception 'runtime code capability evidence ids are invalid'
      using errcode = '23514';
  end if;

  v_payload := concat_ws(E'\n',
    octet_length(convert_to('runtime_code_capability_v2', 'UTF8'))::text || ':runtime_code_capability_v2',
    octet_length(convert_to(new.code_capability_id, 'UTF8'))::text || ':' || new.code_capability_id,
    octet_length(convert_to(new.gateway_kind, 'UTF8'))::text || ':' || new.gateway_kind,
    octet_length(convert_to(new.adapter_kind, 'UTF8'))::text || ':' || new.adapter_kind,
    octet_length(convert_to(new.wire_api_kind, 'UTF8'))::text || ':' || new.wire_api_kind,
    octet_length(convert_to(new.capability_contract_id, 'UTF8'))::text || ':' || new.capability_contract_id,
    octet_length(convert_to(new.cache_policy_id, 'UTF8'))::text || ':' || new.cache_policy_id,
    octet_length(convert_to(new.calculator_kind, 'UTF8'))::text || ':' || new.calculator_kind
  );
  foreach v_evidence_id in array new.implementation_evidence_ids loop
    v_payload := v_payload || E'\n'
      || octet_length(convert_to(v_evidence_id, 'UTF8'))::text
      || ':' || v_evidence_id;
  end loop;
  v_hash := encode(extensions.digest(convert_to(v_payload, 'UTF8'), 'sha256'), 'hex');
  if new.descriptor_sha256 is distinct from v_hash then
    raise exception 'runtime code capability descriptor hash mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger guard_ai_runtime_code_capability_v2
before insert or update or delete on public.ai_runtime_code_capabilities_v2
for each row execute function public.guard_ai_runtime_code_capability_v2();

insert into public.ai_runtime_code_capabilities_v2 (
  code_capability_id, gateway_kind, adapter_kind, wire_api_kind,
  capability_contract_id, cache_policy_id, calculator_kind,
  implementation_evidence_ids, descriptor_sha256
) values
  (
    'runtime-capability.deepseek-chat-v1.2026-09-04',
    'direct_deepseek', 'deepseek_chat_v1', 'chat_completions_v1',
    'deepseek_chat_json_object_v1',
    'deepseek_automatic_context_cache_v1', 'linear_token_v1',
    array['implementation.deepseek-chat-v1.transport-and-parser.2026-09-04'],
    '4e5a92750f77f148e6422dcf05b03d99333b357879dba5fdb7248d16dd08bdf2'
  ),
  (
    'runtime-capability.mimo-responses-v1.2026-09-04',
    'direct_mimo', 'mimo_responses_v1', 'responses_v1',
    'mimo_responses_output_text_v1',
    'mimo_automatic_prompt_cache_v1', 'linear_token_v1',
    array['implementation.mimo-responses-v1.transport-and-parser.2026-09-04'],
    '3d26f7177a60396d63c0c09e7fad914b7a090bad6222c3836482ba512a009b5e'
  );

-- ---------------------------------------------------------------------------
-- Legal display versions. JSON is a small text-only renderer contract. It
-- cannot carry HTML, links, scripts, component names or arbitrary fetches.
-- ---------------------------------------------------------------------------

create function public.ai_legal_display_content_shape_v2(p_content jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(p_content) = 'object'
    and (
      select array_agg(key order by key)
      from jsonb_object_keys(p_content) as fields(key)
    ) = array['en', 'schemaVersion', 'zh']::text[]
    and p_content ->> 'schemaVersion' = 'legal_display_content_v2'
    and not exists (
      select 1
      from (values ('en'), ('zh')) as languages(code)
      cross join lateral (
        select p_content -> languages.code as body
      ) as selected
      where jsonb_typeof(selected.body) is distinct from 'object'
         or (
           select array_agg(key order by key)
           from jsonb_object_keys(selected.body) as fields(key)
         ) is distinct from array['blocks', 'modelLabel', 'providerLabel']::text[]
         or jsonb_typeof(selected.body -> 'providerLabel') is distinct from 'string'
         or jsonb_typeof(selected.body -> 'modelLabel') is distinct from 'string'
         or length(selected.body ->> 'providerLabel') not between 1 and 200
         or length(selected.body ->> 'modelLabel') not between 1 and 200
         or jsonb_typeof(selected.body -> 'blocks') is distinct from 'array'
         or jsonb_array_length(selected.body -> 'blocks') not between 1 and 24
         or exists (
           select 1
           from jsonb_array_elements(selected.body -> 'blocks') as block(value)
           where jsonb_typeof(block.value) is distinct from 'object'
              or case block.value ->> 'kind'
                when 'paragraph' then
                  (
                    select array_agg(key order by key)
                    from jsonb_object_keys(block.value) as fields(key)
                  ) is distinct from array['kind', 'text']::text[]
                  or length(block.value ->> 'text') not between 1 and 4000
                when 'bulletList' then
                  (
                    select array_agg(key order by key)
                    from jsonb_object_keys(block.value) as fields(key)
                  ) is distinct from array['items', 'kind']::text[]
                  or jsonb_typeof(block.value -> 'items') is distinct from 'array'
                  or jsonb_array_length(block.value -> 'items') not between 1 and 20
                  or exists (
                    select 1
                    from jsonb_array_elements(block.value -> 'items') as item(value)
                    where jsonb_typeof(item.value) is distinct from 'string'
                       or length(item.value #>> '{}') not between 1 and 1000
                  )
                else true
              end
         )
    ),
    false
  );
$$;

create table public.ai_legal_display_versions_v2 (
  display_disclosure_key text primary key,
  legal_bundle_version text not null,
  legal_manifest_id text not null,
  provider_id uuid not null references public.ai_providers(id),
  recipient_key text not null,
  model_id text not null,
  content jsonb not null,
  content_sha256 text not null,
  fact_ids text[] not null,
  evidence_ids text[] not null,
  created_at timestamptz not null default clock_timestamp(),
  sealed_at timestamptz,

  constraint ai_legal_display_versions_v2_key_check
    check (display_disclosure_key ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  constraint ai_legal_display_versions_v2_bundle_manifest_fkey
    foreign key (legal_bundle_version, legal_manifest_id)
    references public.ai_legal_bundle_manifests(
      legal_bundle_version, legal_manifest_id
    ),
  constraint ai_legal_display_versions_v2_recipient_check
    check (recipient_key ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  constraint ai_legal_display_versions_v2_model_check
    check (model_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  constraint ai_legal_display_versions_v2_content_check check (
    public.ai_legal_display_content_shape_v2(content)
    and octet_length(content::text) between 1 and 32768
  ),
  constraint ai_legal_display_versions_v2_hash_check
    check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ai_legal_display_versions_v2_fact_check
    check (cardinality(fact_ids) between 1 and 64),
  constraint ai_legal_display_versions_v2_evidence_check
    check (cardinality(evidence_ids) between 1 and 64),
  constraint ai_legal_display_versions_v2_seal_check
    check (sealed_at is null or sealed_at >= created_at),
  constraint ai_legal_display_versions_v2_projection_unique unique (
    display_disclosure_key, legal_bundle_version, legal_manifest_id,
    provider_id, recipient_key, model_id
  )
);

create function public.guard_ai_legal_display_version_v2()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_id text;
  v_provider_recipient text;
begin
  if tg_op = 'DELETE' then
    raise exception 'legal display versions cannot be deleted'
      using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.sealed_at is not null then
      raise exception 'legal display versions must be inserted unsealed'
        using errcode = '23514';
    end if;
  else
    if old.sealed_at is not null then
      raise exception 'sealed legal display versions are immutable'
        using errcode = '23514';
    end if;
    if (to_jsonb(new) - 'sealed_at') is distinct from
       (to_jsonb(old) - 'sealed_at') or new.sealed_at is null then
      raise exception 'legal display versions permit only a one-time seal'
        using errcode = '23514';
    end if;
  end if;

  foreach v_id in array new.fact_ids || new.evidence_ids loop
    if v_id is null or v_id !~ '^[a-z0-9][a-z0-9._-]{0,199}$' then
      raise exception 'legal display fact or evidence id is invalid'
        using errcode = '23514';
    end if;
  end loop;
  if cardinality(new.fact_ids) is distinct from (
      select count(distinct id) from unnest(new.fact_ids) as valueset(id)
    ) or cardinality(new.evidence_ids) is distinct from (
      select count(distinct id) from unnest(new.evidence_ids) as valueset(id)
    ) then
    raise exception 'legal display fact and evidence ids must be unique'
      using errcode = '23514';
  end if;
  if new.content_sha256 is distinct from encode(
    extensions.digest(convert_to(new.content::text, 'UTF8'), 'sha256'), 'hex'
  ) then
    raise exception 'legal display content hash mismatch'
      using errcode = '23514';
  end if;

  select provider.recipient_key into v_provider_recipient
  from public.ai_providers as provider
  where provider.id = new.provider_id;
  if not found or v_provider_recipient is distinct from new.recipient_key then
    raise exception 'legal display recipient differs from provider identity'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and not exists (
    select 1
    from public.ai_legal_bundle_versions as bundle
    join public.ai_legal_bundle_manifests as membership
      on membership.legal_bundle_version = bundle.legal_bundle_version
    where bundle.legal_bundle_version = new.legal_bundle_version
      and bundle.sealed_at is not null
      and membership.legal_manifest_id = new.legal_manifest_id
  ) then
    raise exception 'legal display requires a sealed bundle manifest'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger guard_ai_legal_display_version_v2
before insert or update or delete on public.ai_legal_display_versions_v2
for each row execute function public.guard_ai_legal_display_version_v2();

-- ---------------------------------------------------------------------------
-- One protected v2 current identity, initialized from the unchanged v1
-- function. Future owner-controlled switching can change only this row.
-- ---------------------------------------------------------------------------

create table public.ai_current_legal_bundle_v2 (
  singleton boolean primary key default true check (singleton),
  legal_bundle_version text not null
    references public.ai_legal_bundle_versions(legal_bundle_version),
  revision bigint not null check (revision > 0),
  updated_at timestamptz not null default clock_timestamp()
);

create function public.guard_ai_current_legal_bundle_v2()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'current legal bundle identity cannot be deleted'
      using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.singleton is distinct from true or new.revision is distinct from 1 then
      raise exception 'current legal bundle must start at revision one'
        using errcode = '23514';
    end if;
  else
    if new.singleton is distinct from old.singleton
       or new.legal_bundle_version is not distinct from old.legal_bundle_version
       or new.revision is distinct from old.revision + 1
       or new.updated_at <= old.updated_at then
      raise exception 'current legal bundle transition is invalid'
        using errcode = '23514';
    end if;
  end if;
  if not exists (
    select 1 from public.ai_legal_bundle_versions as bundle
    where bundle.legal_bundle_version = new.legal_bundle_version
      and bundle.sealed_at is not null
  ) then
    raise exception 'current legal bundle must be sealed'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger guard_ai_current_legal_bundle_v2
before insert or update or delete on public.ai_current_legal_bundle_v2
for each row execute function public.guard_ai_current_legal_bundle_v2();

insert into public.ai_current_legal_bundle_v2 (
  singleton, legal_bundle_version, revision
) values (true, public.current_ai_terms_version(), 1);

create function public.get_ai_current_legal_bundle_v2()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'schemaVersion', 'ai_current_legal_bundle_v2',
    'legalBundleVersion', current.legal_bundle_version,
    'revision', current.revision
  )
  from public.ai_current_legal_bundle_v2 as current
  join public.ai_legal_bundle_versions as bundle
    on bundle.legal_bundle_version = current.legal_bundle_version
   and bundle.sealed_at is not null
  where current.singleton;
$$;

-- ---------------------------------------------------------------------------
-- Exact destination evidence attached to an existing runtime target. The
-- existing target hash remains the runtime identity; no execution_sha256 is
-- introduced. Duplicate scalar fields make crossed tuples fail explicitly.
-- ---------------------------------------------------------------------------

create table public.ai_runtime_target_bindings_v2 (
  runtime_contract_id text not null,
  runtime_target_id text not null,
  runtime_target_sha256 text not null,
  route_descriptor_id text not null,
  route_descriptor_sha256 text not null,
  profile_version_id uuid not null,
  price_version_id uuid not null,
  provider_id uuid not null references public.ai_providers(id),
  recipient_key text not null,
  code_capability_id text not null,
  code_capability_sha256 text not null,
  gateway_kind text not null,
  adapter_kind text not null,
  wire_api_kind text not null,
  endpoint_url text not null,
  credential_env_name text not null,
  model_id text not null,
  capability_contract_id text not null,
  cache_policy_id text not null,
  calculator_kind text not null,
  legal_bundle_version text not null,
  legal_manifest_id text not null,
  legal_manifest_sha256 text not null,
  display_disclosure_key text not null,
  external_evidence_ids text[] not null,
  created_at timestamptz not null default clock_timestamp(),

  primary key (runtime_contract_id, runtime_target_id),
  constraint ai_runtime_target_bindings_v2_profile_unique
    unique (runtime_contract_id, profile_version_id),
  constraint ai_runtime_target_bindings_v2_membership_fkey
    foreign key (runtime_contract_id, runtime_target_id)
    references public.ai_service_runtime_contract_targets(
      runtime_contract_id, runtime_target_id
    ),
  constraint ai_runtime_target_bindings_v2_profile_price_fkey
    foreign key (price_version_id, profile_version_id)
    references public.ai_price_versions(id, profile_version_id),
  constraint ai_runtime_target_bindings_v2_capability_fkey
    foreign key (code_capability_id, code_capability_sha256)
    references public.ai_runtime_code_capabilities_v2(
      code_capability_id, descriptor_sha256
    ),
  constraint ai_runtime_target_bindings_v2_bundle_manifest_fkey
    foreign key (legal_bundle_version, legal_manifest_id)
    references public.ai_legal_bundle_manifests(
      legal_bundle_version, legal_manifest_id
    ),
  constraint ai_runtime_target_bindings_v2_display_fkey
    foreign key (
      display_disclosure_key, legal_bundle_version, legal_manifest_id,
      provider_id, recipient_key, model_id
    ) references public.ai_legal_display_versions_v2(
      display_disclosure_key, legal_bundle_version, legal_manifest_id,
      provider_id, recipient_key, model_id
    ),
  constraint ai_runtime_target_bindings_v2_ids_check check (
    runtime_contract_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    and runtime_target_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    and route_descriptor_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    and recipient_key ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
    and display_disclosure_key ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
  ),
  constraint ai_runtime_target_bindings_v2_hashes_check check (
    runtime_target_sha256 ~ '^[0-9a-f]{64}$'
    and route_descriptor_sha256 ~ '^[0-9a-f]{64}$'
    and code_capability_sha256 ~ '^[0-9a-f]{64}$'
    and legal_manifest_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint ai_runtime_target_bindings_v2_endpoint_check
    check (public.ai_endpoint_shape_v2(endpoint_url)),
  constraint ai_runtime_target_bindings_v2_credential_check
    check (credential_env_name ~ '^AI_PROVIDER_KEY_[A-Z0-9_]{1,160}$'),
  constraint ai_runtime_target_bindings_v2_model_check
    check (model_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  constraint ai_runtime_target_bindings_v2_evidence_check
    check (cardinality(external_evidence_ids) between 1 and 64)
);

create function public.guard_ai_runtime_target_binding_v2()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_contract public.ai_service_runtime_contract_versions%rowtype;
  v_target public.ai_service_runtime_contract_targets%rowtype;
  v_version public.ai_provider_profile_versions%rowtype;
  v_profile public.ai_provider_profiles%rowtype;
  v_provider public.ai_providers%rowtype;
  v_price public.ai_price_versions%rowtype;
  v_capability public.ai_runtime_code_capabilities_v2%rowtype;
  v_display public.ai_legal_display_versions_v2%rowtype;
  v_evidence_id text;
begin
  if tg_op = 'UPDATE' then
    raise exception 'runtime target bindings cannot be updated'
      using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'runtime target bindings cannot be deleted'
      using errcode = '23514';
  end if;

  select * into v_contract
  from public.ai_service_runtime_contract_versions
  where runtime_contract_id = new.runtime_contract_id
  for update;
  if not found or v_contract.sealed_at is not null then
    raise exception 'runtime target binding requires an unsealed contract'
      using errcode = '23514';
  end if;

  select * into v_target
  from public.ai_service_runtime_contract_targets
  where runtime_contract_id = new.runtime_contract_id
    and runtime_target_id = new.runtime_target_id;
  select * into v_version
  from public.ai_provider_profile_versions
  where id = new.profile_version_id;
  select * into v_profile
  from public.ai_provider_profiles
  where id = v_version.profile_id;
  select * into v_provider
  from public.ai_providers
  where id = new.provider_id;
  select * into v_price
  from public.ai_price_versions
  where id = new.price_version_id;
  select * into v_capability
  from public.ai_runtime_code_capabilities_v2
  where code_capability_id = new.code_capability_id;
  select * into v_display
  from public.ai_legal_display_versions_v2
  where display_disclosure_key = new.display_disclosure_key;

  if v_target.runtime_target_id is null
     or v_version.id is null
     or v_profile.id is null
     or v_provider.id is null
     or v_price.id is null
     or v_capability.code_capability_id is null
     or v_display.display_disclosure_key is null
     or v_display.sealed_at is null then
    raise exception 'runtime target binding evidence is incomplete'
      using errcode = '23514';
  end if;

  if (
    new.runtime_target_sha256,
    new.route_descriptor_id,
    new.route_descriptor_sha256,
    v_profile.profile_key,
    new.legal_manifest_id,
    new.legal_manifest_sha256
  ) is distinct from (
    v_target.runtime_target_sha256,
    v_target.route_descriptor_id,
    v_target.route_descriptor_sha256,
    v_target.profile_key,
    v_target.legal_manifest_id,
    v_target.manifest_sha256
  ) then
    raise exception 'runtime target binding differs from target membership'
      using errcode = '23514';
  end if;

  if v_version.execution_schema_version is distinct from 'profile_execution_config_v2'
     or (
       new.provider_id, new.gateway_kind, new.adapter_kind, new.wire_api_kind,
       new.endpoint_url, new.credential_env_name, new.model_id,
       new.capability_contract_id, new.cache_policy_id,
       new.legal_manifest_id, new.display_disclosure_key
     ) is distinct from (
       v_profile.provider_id, v_profile.gateway_kind, v_version.adapter_kind,
       v_version.wire_api_kind, v_version.endpoint_url,
       v_version.credential_env_name, v_version.model_id,
       v_version.capability_contract_id, v_version.cache_policy_id,
       v_version.legal_manifest_id, v_version.display_disclosure_key
     ) then
    raise exception 'runtime target binding differs from profile version'
      using errcode = '23514';
  end if;

  if (new.provider_id, new.recipient_key, new.gateway_kind)
     is distinct from (v_provider.id, v_provider.recipient_key, v_provider.gateway_kind)
     or (new.price_version_id, new.profile_version_id, new.calculator_kind)
     is distinct from (v_price.id, v_price.profile_version_id, v_price.calculator_kind)
     or v_price.components_sealed_at is null then
    raise exception 'runtime target binding differs from provider or sealed price'
      using errcode = '23514';
  end if;

  if (
    new.code_capability_sha256, new.gateway_kind, new.adapter_kind,
    new.wire_api_kind, new.capability_contract_id, new.cache_policy_id,
    new.calculator_kind
  ) is distinct from (
    v_capability.descriptor_sha256, v_capability.gateway_kind,
    v_capability.adapter_kind, v_capability.wire_api_kind,
    v_capability.capability_contract_id, v_capability.cache_policy_id,
    v_capability.calculator_kind
  ) then
    raise exception 'runtime target binding differs from code capability'
      using errcode = '23514';
  end if;

  if (new.legal_bundle_version, new.legal_manifest_id, new.provider_id,
      new.recipient_key, new.model_id)
     is distinct from (v_display.legal_bundle_version,
      v_display.legal_manifest_id, v_display.provider_id,
      v_display.recipient_key, v_display.model_id)
     or v_contract.legal_bundle_version is distinct from new.legal_bundle_version
     or not exists (
       select 1
       from public.ai_legal_bundle_manifests as membership
       where membership.legal_bundle_version = new.legal_bundle_version
         and membership.legal_manifest_id = new.legal_manifest_id
         and membership.manifest_sha256 = new.legal_manifest_sha256
     ) then
    raise exception 'runtime target binding differs from legal evidence'
      using errcode = '23514';
  end if;

  foreach v_evidence_id in array new.external_evidence_ids loop
    if v_evidence_id is null
       or v_evidence_id !~ '^[a-z0-9][a-z0-9._-]{0,199}$' then
      raise exception 'runtime target external evidence id is invalid'
        using errcode = '23514';
    end if;
  end loop;
  if cardinality(new.external_evidence_ids) is distinct from (
    select count(distinct id)
    from unnest(new.external_evidence_ids) as evidence(id)
  ) then
    raise exception 'runtime target external evidence ids must be unique'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger guard_ai_runtime_target_binding_v2
before insert or update or delete on public.ai_runtime_target_bindings_v2
for each row execute function public.guard_ai_runtime_target_binding_v2();

-- The original v2 entry point is still dark. Its successor body now requires
-- and returns the exact runtime evidence instead of a profile-only projection.
create or replace function public.get_ai_polish_execution_snapshot_v2(
  p_reservation_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base jsonb;
  v_version public.ai_provider_profile_versions%rowtype;
  v_profile public.ai_provider_profiles%rowtype;
  v_provider public.ai_providers%rowtype;
  v_price public.ai_price_versions%rowtype;
  v_binding public.ai_runtime_target_bindings_v2%rowtype;
begin
  v_base := public.get_ai_polish_execution_snapshot_v1(
    p_reservation_id,
    p_user_id
  );
  if v_base ->> 'ok' is distinct from 'true' then return v_base; end if;

  select * into v_version from public.ai_provider_profile_versions
  where id = (v_base #>> '{routeSnapshot,profileVersionId}')::uuid;
  if not found then
    return jsonb_build_object('schemaVersion', 'ai_polish_execution_snapshot_v1',
      'ok', false, 'reason', 'SERVICE_UNAVAILABLE');
  end if;
  if v_version.execution_schema_version = 'profile_execution_config_v1' then
    return v_base;
  end if;

  select * into v_profile from public.ai_provider_profiles
  where id = v_version.profile_id;
  select * into v_provider from public.ai_providers
  where id = v_profile.provider_id;
  select * into v_price from public.ai_price_versions
  where id = (v_base #>> '{routeSnapshot,priceVersionId}')::uuid;
  select * into v_binding from public.ai_runtime_target_bindings_v2
  where runtime_contract_id = v_base #>> '{routeSnapshot,runtimeContractId}'
    and profile_version_id = v_version.id
    and price_version_id = v_price.id;

  if v_version.execution_schema_version is distinct from 'profile_execution_config_v2'
     or v_binding.runtime_target_id is null
     or v_version.credential_alias is not null
     or v_version.endpoint_alias is not null
     or not public.ai_endpoint_shape_v2(v_version.endpoint_url)
     or v_version.credential_env_name !~ '^AI_PROVIDER_KEY_[A-Z0-9_]{1,160}$'
     or v_provider.id is distinct from v_profile.provider_id
     or v_provider.gateway_kind is distinct from v_profile.gateway_kind
     or v_price.profile_version_id is distinct from v_version.id
     or (v_binding.profile_version_id, v_binding.price_version_id,
         v_binding.provider_id, v_binding.recipient_key,
         v_binding.gateway_kind, v_binding.adapter_kind,
         v_binding.wire_api_kind, v_binding.endpoint_url,
         v_binding.credential_env_name, v_binding.model_id,
         v_binding.capability_contract_id, v_binding.cache_policy_id,
         v_binding.calculator_kind, v_binding.legal_bundle_version,
         v_binding.legal_manifest_id, v_binding.display_disclosure_key)
        is distinct from
        (v_version.id, v_price.id, v_provider.id, v_provider.recipient_key,
         v_profile.gateway_kind, v_version.adapter_kind,
         v_version.wire_api_kind, v_version.endpoint_url,
         v_version.credential_env_name, v_version.model_id,
         v_version.capability_contract_id, v_version.cache_policy_id,
         v_price.calculator_kind, v_base #>> '{routeSnapshot,legalBundleVersion}',
         v_version.legal_manifest_id, v_version.display_disclosure_key) then
    return jsonb_build_object('schemaVersion', 'ai_polish_execution_snapshot_v1',
      'ok', false, 'reason', 'SERVICE_UNAVAILABLE');
  end if;

  return jsonb_set(
    jsonb_set(
      jsonb_set(v_base, '{schemaVersion}',
        to_jsonb('ai_polish_execution_snapshot_v2'::text)),
      '{profileExecutionConfig}',
      jsonb_build_object(
        'schemaVersion', v_version.execution_schema_version,
        'profileKey', v_profile.profile_key,
        'providerId', v_provider.id,
        'gatewayKind', v_profile.gateway_kind,
        'adapterKind', v_version.adapter_kind,
        'wireApiKind', v_version.wire_api_kind,
        'endpointUrl', v_version.endpoint_url,
        'credentialEnvName', v_version.credential_env_name,
        'modelId', v_version.model_id,
        'capabilityContractId', v_version.capability_contract_id,
        'cachePolicyId', v_version.cache_policy_id,
        'legalManifestId', v_version.legal_manifest_id,
        'calculatorKind', v_price.calculator_kind,
        'displayDisclosureKey', v_version.display_disclosure_key,
        'config', v_version.config
      )
    ),
    '{runtimeEvidence}',
    jsonb_build_object(
      'schemaVersion', 'runtime_execution_evidence_v2',
      'runtimeContractId', v_binding.runtime_contract_id,
      'runtimeTargetId', v_binding.runtime_target_id,
      'runtimeTargetSha256', v_binding.runtime_target_sha256,
      'routeDescriptorId', v_binding.route_descriptor_id,
      'routeDescriptorSha256', v_binding.route_descriptor_sha256,
      'profileVersionId', v_binding.profile_version_id,
      'priceVersionId', v_binding.price_version_id,
      'providerId', v_binding.provider_id,
      'recipientKey', v_binding.recipient_key,
      'codeCapabilityId', v_binding.code_capability_id,
      'codeCapabilitySha256', v_binding.code_capability_sha256,
      'gatewayKind', v_binding.gateway_kind,
      'adapterKind', v_binding.adapter_kind,
      'wireApiKind', v_binding.wire_api_kind,
      'endpointUrl', v_binding.endpoint_url,
      'credentialEnvName', v_binding.credential_env_name,
      'modelId', v_binding.model_id,
      'capabilityContractId', v_binding.capability_contract_id,
      'cachePolicyId', v_binding.cache_policy_id,
      'calculatorKind', v_binding.calculator_kind,
      'legalBundleVersion', v_binding.legal_bundle_version,
      'legalManifestId', v_binding.legal_manifest_id,
      'legalManifestSha256', v_binding.legal_manifest_sha256,
      'displayDisclosureKey', v_binding.display_disclosure_key,
      'externalEvidenceIds', to_jsonb(v_binding.external_evidence_ids)
    )
  );
exception
  when others then
    return jsonb_build_object('schemaVersion', 'ai_polish_execution_snapshot_v1',
      'ok', false, 'reason', 'SERVICE_UNAVAILABLE');
end;
$$;

-- Catalogs are read only through narrow security-definer projections.
alter table public.ai_runtime_code_capabilities_v2 enable row level security;
alter table public.ai_legal_display_versions_v2 enable row level security;
alter table public.ai_current_legal_bundle_v2 enable row level security;
alter table public.ai_runtime_target_bindings_v2 enable row level security;

revoke all on public.ai_runtime_code_capabilities_v2,
  public.ai_legal_display_versions_v2,
  public.ai_current_legal_bundle_v2,
  public.ai_runtime_target_bindings_v2
  from public, anon, authenticated, service_role;

revoke all on function public.guard_ai_runtime_code_capability_v2(),
  public.ai_legal_display_content_shape_v2(jsonb),
  public.guard_ai_legal_display_version_v2(),
  public.guard_ai_current_legal_bundle_v2(),
  public.guard_ai_runtime_target_binding_v2(),
  public.get_ai_current_legal_bundle_v2(),
  public.get_ai_polish_execution_snapshot_v2(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_ai_current_legal_bundle_v2(),
  public.get_ai_polish_execution_snapshot_v2(uuid, uuid)
  to service_role;

commit;
