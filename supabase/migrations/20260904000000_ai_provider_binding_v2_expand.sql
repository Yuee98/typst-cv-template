-- ADM-I03. Additive catalogs/representation only. Existing routes, gates,
-- legal current, runtime contracts and frozen version values are unchanged.
begin;

create table public.ai_adapter_catalog (
  adapter_id text primary key check (adapter_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  display_name text not null check (length(btrim(display_name)) between 1 and 200),
  wire_api_kind text not null check (wire_api_kind in ('chat_completions_v1','responses_v1')),
  deprecated_at timestamptz,
  created_at timestamptz not null default now()
);
insert into public.ai_adapter_catalog(adapter_id,display_name,wire_api_kind) values
  ('deepseek_chat_v1','DeepSeek Chat','chat_completions_v1'),
  ('mimo_responses_v1','MiMo Responses','responses_v1');

-- Only scalar shape here; exact destination/recipient approval is additionally
-- required from deployed runtime policy and sealed evidence before any send.
create function public.ai_endpoint_shape_v2(p_url text) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(length(p_url) between 10 and 512
    and p_url ~ '^https://[a-z0-9][a-z0-9.-]*/[A-Za-z0-9._~/-]+$'
    and p_url !~ '[[:space:][:cntrl:]@?#]'
    and split_part(split_part(p_url,'://',2),'/',1) !~ '^[0-9.]+$'
    and split_part(split_part(p_url,'://',2),'/',1) not in ('localhost','localhost.localdomain'),false);
$$;
revoke all on function public.ai_endpoint_shape_v2(text) from public,anon,authenticated,service_role;

create table public.ai_providers (
  id uuid primary key default extensions.gen_random_uuid(),
  provider_key text not null unique check (provider_key ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  recipient_key text not null check (recipient_key ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  gateway_kind text not null check (gateway_kind in ('direct_deepseek','direct_mimo')),
  display_name text not null check (length(btrim(display_name)) between 1 and 200),
  default_adapter_id text references public.ai_adapter_catalog(adapter_id),
  default_endpoint_url text check (default_endpoint_url is null or public.ai_endpoint_shape_v2(default_endpoint_url)),
  default_credential_env_name text check (default_credential_env_name ~ '^AI_PROVIDER_KEY_[A-Z0-9_]{1,160}$'),
  default_model_id text check (default_model_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  archived_at timestamptz,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now()
);
insert into public.ai_providers(id,provider_key,recipient_key,gateway_kind,display_name,
  default_adapter_id,default_endpoint_url,default_credential_env_name,default_model_id) values
 ('706513a5-462b-4bba-93b0-53e50661416e','deepseek.official','deepseek','direct_deepseek','DeepSeek',
  'deepseek_chat_v1','https://api.deepseek.com/chat/completions','AI_PROVIDER_KEY_DEEPSEEK_PRIMARY','deepseek-v4-flash'),
 ('d1a481e6-5baf-4b2f-8f2d-da28c2b92ed9','mimo.cn','xiaomi-mimo','direct_mimo','MiMo',
  'mimo_responses_v1','https://api.xiaomimimo.com/v1/responses','AI_PROVIDER_KEY_MIMO_PRIMARY','mimo-v2.5-pro');

alter table public.ai_adapter_catalog enable row level security;
alter table public.ai_providers enable row level security;
revoke all on public.ai_adapter_catalog,public.ai_providers from public,anon,authenticated,service_role;

alter table public.ai_provider_profiles add column provider_id uuid references public.ai_providers(id);
-- Exact existing identity mappings only. No guessed mapping of unknown rows.
update public.ai_provider_profiles set provider_id='706513a5-462b-4bba-93b0-53e50661416e'
 where profile_key='deepseek.official.deepseek-v4-flash.chat.v1' and gateway_kind='direct_deepseek' and model_vendor='deepseek';
update public.ai_provider_profiles set provider_id='d1a481e6-5baf-4b2f-8f2d-da28c2b92ed9'
 where profile_key='mimo.cn.mimo-v2.5-pro.responses.v1' and gateway_kind='direct_mimo' and model_vendor='xiaomi-mimo';

alter table public.ai_provider_profile_versions
  add column execution_schema_version text not null default 'profile_execution_config_v1',
  add column endpoint_url text,
  add column credential_env_name text,
  alter column endpoint_alias drop not null,
  alter column credential_alias drop not null,
  add constraint ai_profile_adapter_catalog_fk foreign key(adapter_kind)
    references public.ai_adapter_catalog(adapter_id) not valid;
-- Stop on unregistered history. A catalog row is never invented to make a
-- migration pass. Old unknown adapters require explicit operator inventory.
alter table public.ai_provider_profile_versions validate constraint ai_profile_adapter_catalog_fk;
alter table public.ai_provider_profile_versions add constraint ai_profile_execution_branch_check check (coalesce(
  (execution_schema_version='profile_execution_config_v1' and endpoint_url is null and credential_env_name is null
    and endpoint_alias is not null and credential_alias is not null)
  or (execution_schema_version='profile_execution_config_v2' and endpoint_alias is null and credential_alias is null
    and public.ai_endpoint_shape_v2(endpoint_url) and credential_env_name is not null
    and credential_env_name ~ '^AI_PROVIDER_KEY_[A-Z0-9_]{1,160}$'
    and model_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),false));

create function public.guard_ai_provider_directory_v2() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'provider directory history cannot be deleted' using errcode='23514'; end if;
  if (new.id,new.provider_key,new.recipient_key,new.gateway_kind,new.created_at)
    is distinct from (old.id,old.provider_key,old.recipient_key,old.gateway_kind,old.created_at) then
    raise exception 'provider recipient identity is immutable' using errcode='23514';
  end if;
  if old.revision=9223372036854775807 then raise exception 'provider revision exhausted' using errcode='22003'; end if;
  new.revision:=old.revision+1;
  return new;
end;
$$;
create trigger guard_ai_provider_directory_v2 before update or delete on public.ai_providers
 for each row execute function public.guard_ai_provider_directory_v2();
revoke all on function public.guard_ai_provider_directory_v2() from public,anon,authenticated,service_role;

create function public.guard_ai_profile_provider_v2() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='UPDATE' and new.provider_id is distinct from old.provider_id then
    raise exception 'profile provider identity is immutable' using errcode='23514';
  end if;
  if new.provider_id is not null and not exists(select 1 from public.ai_providers
    where id=new.provider_id and gateway_kind=new.gateway_kind) then
    raise exception 'profile provider gateway mismatch' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger guard_ai_profile_provider_v2 before insert or update on public.ai_provider_profiles
 for each row execute function public.guard_ai_profile_provider_v2();
revoke all on function public.guard_ai_profile_provider_v2() from public,anon,authenticated,service_role;

create function public.guard_ai_profile_binding_v2() returns trigger
language plpgsql set search_path='' as $$
begin
  -- The existing generic execution-fields immutable trigger automatically
  -- includes all new columns; even legacy active rows cannot be backfilled.
  if new.execution_schema_version='profile_execution_config_v2' then
    if not exists(select 1 from public.ai_provider_profiles where id=new.profile_id and provider_id is not null) then
      raise exception 'v2 profile requires a provider identity' using errcode='23514';
    end if;
    if not exists(select 1 from public.ai_adapter_catalog where adapter_id=new.adapter_kind and wire_api_kind=new.wire_api_kind) then
      raise exception 'adapter wire API mismatch' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger guard_ai_profile_binding_v2 before insert on public.ai_provider_profile_versions
 for each row execute function public.guard_ai_profile_binding_v2();
revoke all on function public.guard_ai_profile_binding_v2() from public,anon,authenticated,service_role;

alter table public.ai_provider_attempt_ledger
  add column execution_schema_version text not null default 'profile_execution_config_v1',
  add column endpoint_url text,
  add column credential_env_name text,
  add column runtime_build_id text,
  add column binding_manifest_revision text,
  alter column endpoint_alias drop not null,
  alter column credential_alias drop not null;
alter table public.ai_provider_attempt_ledger add constraint ai_attempt_execution_branch_check check (coalesce(
  (execution_schema_version='profile_execution_config_v1' and endpoint_url is null and credential_env_name is null
    and endpoint_alias is not null and credential_alias is not null and runtime_build_id is null and binding_manifest_revision is null)
  or (execution_schema_version='profile_execution_config_v2' and endpoint_alias is null and credential_alias is null
    and public.ai_endpoint_shape_v2(endpoint_url) and credential_env_name is not null
    and credential_env_name ~ '^AI_PROVIDER_KEY_[A-Z0-9_]{1,160}$'
    and runtime_build_id ~ '^[a-z0-9][a-z0-9._:-]{0,199}$' and runtime_build_id is not null
    and binding_manifest_revision ~ '^[a-z0-9][a-z0-9._-]{0,199}$' and binding_manifest_revision is not null),false));

-- Preserve every pre-existing scalar condition, admitting null aliases only
-- through the separately enforced strict v2 connection branch.
alter table public.ai_provider_attempt_ledger drop constraint ai_provider_attempt_ledger_snapshot_shape_check;
alter table public.ai_provider_attempt_ledger add constraint ai_provider_attempt_ledger_snapshot_shape_check check (coalesce((
  route_schema_version='route_snapshot_v1' and config_generation>=0
  and length(btrim(legal_bundle_version)) between 1 and 200
  and runtime_contract_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
  and gateway_kind in ('direct_deepseek','direct_mimo','openrouter')
  and wire_api_kind in ('chat_completions_v1','responses_v1')
  and length(btrim(model_id)) between 1 and 200
  and length(btrim(display_disclosure_key)) between 1 and 200
  and length(btrim(adapter_kind)) between 1 and 200
  and (execution_schema_version='profile_execution_config_v2' or
    (length(btrim(credential_alias)) between 1 and 200 and length(btrim(endpoint_alias)) between 1 and 200))
  and length(btrim(capability_contract_id)) between 1 and 200
  and length(btrim(cache_policy_id)) between 1 and 200
  and length(btrim(legal_manifest_id)) between 1 and 200
  and length(btrim(calculator_kind)) between 1 and 200
  and billing_currency ~ '^[A-Z]{3}$'),false));

create function public.guard_ai_attempt_binding_v2() returns trigger
language plpgsql set search_path='' as $$
declare v_profile public.ai_provider_profile_versions%rowtype;
begin
  if tg_op='UPDATE' then
    if (new.execution_schema_version,new.endpoint_url,new.credential_env_name,new.runtime_build_id,new.binding_manifest_revision)
      is distinct from (old.execution_schema_version,old.endpoint_url,old.credential_env_name,old.runtime_build_id,old.binding_manifest_revision) then
      raise exception 'attempt execution binding and provenance are immutable' using errcode='23514';
    end if;
  elsif new.execution_schema_version='profile_execution_config_v2'
     or new.endpoint_url is not null
     or new.credential_env_name is not null
     or new.runtime_build_id is not null
     or new.binding_manifest_revision is not null then
    select * into v_profile from public.ai_provider_profile_versions where id=new.profile_version_id;
    if not found or (new.execution_schema_version,new.endpoint_url,new.credential_env_name)
      is distinct from (v_profile.execution_schema_version,v_profile.endpoint_url,v_profile.credential_env_name) then
      raise exception 'attempt execution binding differs from frozen profile' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger guard_ai_attempt_binding_v2 before insert or update on public.ai_provider_attempt_ledger
 for each row execute function public.guard_ai_attempt_binding_v2();
revoke all on function public.guard_ai_attempt_binding_v2() from public,anon,authenticated,service_role;

commit;
