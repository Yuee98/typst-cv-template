-- Permit only the transaction-local admission receipt seal performed by
-- start_ai_polish_provider_attempt_v3; all other attempt immutability remains.
begin;

create or replace function public.guard_ai_provider_attempt_ledger()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_request public.ai_request_ledger%rowtype;
  v_profile record;
  v_price public.ai_price_versions%rowtype;
  v_expected_upstream_endpoint text;
begin
  if tg_op = 'DELETE' then
    -- Direct child deletion could erase immutable provider facts. Retention
    -- and account deletion remain possible after the parent FK cascade has
    -- made the parent row no longer visible to this trigger.
    perform 1
    from public.ai_request_ledger
    where reservation_id = old.reservation_id;

    if found then
      raise exception 'ai_provider_attempt_ledger rows cannot be deleted directly'
        using errcode = '23514';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status is distinct from 'started' then
      raise exception 'ai_provider_attempt_ledger rows must be inserted as started'
        using errcode = '23514';
    end if;

    -- Let the table's NOT NULL and scalar shape constraints remain the
    -- authoritative rejection boundary for absent or malformed identities.
    -- Only a well-shaped ID reaches the parent-snapshot equality guard.
    if new.runtime_contract_id is null
       or new.runtime_contract_id !~ '^[a-z0-9][a-z0-9._-]{0,199}$' then
      return new;
    end if;

    select * into v_request
    from public.ai_request_ledger
    where reservation_id = new.reservation_id
    for update;

    if not found
       or v_request.route_schema_version is null
       or v_request.state is distinct from 'reserved' then
      raise exception 'provider attempts require a reserved parent with a frozen route snapshot'
        using errcode = '23514';
    end if;

    if (
      new.route_schema_version,
      new.config_generation,
      new.routing_policy_version_id,
      new.profile_version_id,
      new.price_version_id,
      new.legal_bundle_version,
      new.runtime_contract_id,
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
      v_request.runtime_contract_id,
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
    -- The successor start routine first inserts through the existing lifecycle
    -- and then seals its admission receipt in the same transaction. This is
    -- the only same-status update allowed; a separate earlier trigger verifies
    -- the all-null to exact-receipt transition and makes it immutable.
    if old.status = 'started' and new.status = 'started'
       and old.runtime_admission_id is null
       and new.runtime_admission_id is not null
       and current_user in ('postgres','supabase_admin')
       and (to_jsonb(new) - array[
         'runtime_admission_id','runtime_admission_revision',
         'runtime_target_set_sha256','admitted_runtime_target_id',
         'admitted_runtime_target_sha256','runtime_validation_report_id'
       ]) is not distinct from (to_jsonb(old) - array[
         'runtime_admission_id','runtime_admission_revision',
         'runtime_target_set_sha256','admitted_runtime_target_id',
         'admitted_runtime_target_sha256','runtime_validation_report_id'
       ]) then
      return new;
    end if;
    if old.status is distinct from 'started' then
      raise exception 'terminal provider attempt facts are immutable'
        using errcode = '23514';
    end if;

    if new.status is not distinct from 'started' then
      raise exception 'provider attempt updates must transition started to terminal'
        using errcode = '23514';
    end if;

    select * into v_request
    from public.ai_request_ledger
    where reservation_id = old.reservation_id
    for update;

    if not found or v_request.state is distinct from 'reserved' then
      raise exception 'provider attempt completion requires its parent to remain reserved'
        using errcode = '23514';
    end if;

    select
      version.endpoint_alias,
      version.model_id,
      version.wire_api_kind,
      profile.gateway_kind
    into v_profile
    from public.ai_provider_profile_versions as version
    join public.ai_provider_profiles as profile on profile.id = version.profile_id
    where version.id = v_request.profile_version_id
      and version.id = old.profile_version_id
    for key share of version, profile;

    if not found or v_profile.model_id is distinct from v_request.model_id then
      raise exception 'provider attempt completion requires its frozen parent profile'
        using errcode = '23514';
    end if;

    if new.actual_model_id is not null
       and new.actual_model_id is distinct from v_request.model_id then
      raise exception 'observed model must equal the frozen reservation model'
        using errcode = '23514';
    end if;

    -- Rejection-only mirror of the code registry. RT-009 must validate the
    -- same endpoint alias before persistence; unknown aliases/combinations
    -- intentionally have no DB endpoint and therefore require NULL.
    v_expected_upstream_endpoint := case
      when v_profile.endpoint_alias = 'deepseek_official'
       and v_profile.gateway_kind = 'direct_deepseek'
       and v_profile.wire_api_kind = 'chat_completions_v1'
        then 'https://api.deepseek.com/chat/completions'
      when v_profile.endpoint_alias = 'mimo_cn_official'
       and v_profile.gateway_kind = 'direct_mimo'
       and v_profile.wire_api_kind = 'responses_v1'
        then 'https://api.xiaomimimo.com/v1/responses'
      else null
    end;

    if new.actual_upstream_endpoint is not null
       and (
         v_expected_upstream_endpoint is null
         or new.actual_upstream_endpoint is distinct from v_expected_upstream_endpoint
       ) then
      raise exception 'observed endpoint must match the frozen profile endpoint alias'
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
      new.runtime_contract_id,
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
      old.runtime_contract_id,
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

revoke all on function public.guard_ai_provider_attempt_ledger()
  from public, anon, authenticated, service_role;

commit;
