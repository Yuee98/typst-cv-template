-- ADM-I08: approved authoring projections for the Admin UI. The function
-- keeps a fixed query per section and never exposes credentials or raw ledger
-- payloads.
begin;

create or replace function public.admin_records_query_v1(p_section text)
returns text
language plpgsql
set search_path = ''
as $$
begin
  return case p_section
  when 'users' then $query$
    select u.id,coalesce(u.email,'') as search_text,jsonb_build_object(
      'id',u.id,'email',u.email,'createdAt',u.created_at,
      'isAdmin',p.user_id is not null and p.revoked_at is null,'revision',p.revision::text,
      'banned',u.banned_until is not null and u.banned_until>clock_timestamp()) as item
    from auth.users u left join public.admin_principals p on p.user_id=u.id where u.deleted_at is null
  $query$
  when 'providers' then $query$
    select provider.id,provider.provider_key || ' ' || provider.display_name as search_text,
      jsonb_build_object(
        'id',provider.id,'providerKey',provider.provider_key,
        'displayName',provider.display_name,'recipientKey',provider.recipient_key,
        'gatewayKind',provider.gateway_kind,
        'defaultAdapterId',provider.default_adapter_id,
        'defaultEndpointUrl',provider.default_endpoint_url,
        'defaultCredentialEnvName',provider.default_credential_env_name,
        'defaultModelId',provider.default_model_id,
        'adapterOptions',coalesce((select jsonb_agg(jsonb_build_object(
          'adapterId',catalog.adapter_id,'displayName',catalog.display_name,
          'wireApiKind',catalog.wire_api_kind) order by catalog.adapter_id)
          from public.ai_adapter_catalog catalog
          where catalog.deprecated_at is null and exists (
            select 1 from public.ai_runtime_code_capabilities_v2 capability
            where capability.adapter_kind=catalog.adapter_id
              and capability.wire_api_kind=catalog.wire_api_kind
          )),'[]'::jsonb),
        'revision',provider.revision::text,
        'archived',provider.archived_at is not null,
        'createdAt',provider.created_at) as item
    from public.ai_providers provider
  $query$
  when 'profiles' then $query$
    select v.id,p.profile_key || ' ' || v.model_id as search_text,jsonb_build_object(
      'id',v.id,'profileId',v.profile_id,'providerId',p.provider_id,
      'profileKey',p.profile_key,'profileDisplayName',p.display_name,
      'modelVendor',p.model_vendor,'version',v.version,'status',v.status,
      'latestVersion',(select max(latest.version) from public.ai_provider_profile_versions latest
        where latest.profile_id=v.profile_id),
      'executionSchemaVersion',v.execution_schema_version,
      'gatewayKind',p.gateway_kind,'adapterKind',v.adapter_kind,
      'wireApiKind',v.wire_api_kind,'modelId',v.model_id,
      'capabilityContractId',v.capability_contract_id,
      'cachePolicyId',v.cache_policy_id,'legalManifestId',v.legal_manifest_id,
      'displayDisclosureKey',v.display_disclosure_key,
      'endpointAlias',v.endpoint_alias,'credentialAlias',v.credential_alias,
      'endpointUrl',v.endpoint_url,'credentialEnvName',v.credential_env_name,
      'suggestedAdapterId',coalesce(v.adapter_kind,provider.default_adapter_id),
      'suggestedEndpointUrl',coalesce(v.endpoint_url,provider.default_endpoint_url),
      'suggestedCredentialEnvName',coalesce(v.credential_env_name,provider.default_credential_env_name),
      'suggestedModelId',coalesce(v.model_id,provider.default_model_id),
      'adapterOptions',coalesce((select jsonb_agg(jsonb_build_object(
        'adapterId',catalog.adapter_id,'displayName',catalog.display_name,
        'wireApiKind',catalog.wire_api_kind) order by catalog.adapter_id)
        from public.ai_adapter_catalog catalog
        where catalog.deprecated_at is null and exists (
          select 1 from public.ai_runtime_code_capabilities_v2 capability
          where capability.adapter_kind=catalog.adapter_id
            and capability.wire_api_kind=catalog.wire_api_kind
        )),'[]'::jsonb),
      'config',v.config,'configSha256',v.config_sha256,'createdAt',v.created_at) as item
    from public.ai_provider_profile_versions v
    join public.ai_provider_profiles p on p.id=v.profile_id
    left join public.ai_providers provider on provider.id=p.provider_id
  $query$
  when 'prices' then $query$
    select v.id,v.currency || ' ' || v.pricing_lane as search_text,
      jsonb_build_object(
        'id',v.id,'profileVersionId',v.profile_version_id,
        'pricingLane',v.pricing_lane,'version',v.version,
        'latestVersion',(select max(latest.version) from public.ai_price_versions latest
          where latest.profile_version_id=v.profile_version_id and latest.pricing_lane=v.pricing_lane),
        'currency',v.currency,'calculatorKind',v.calculator_kind,
        'validFrom',v.valid_from,'validTo',v.valid_to,
        'providerEffectiveFrom',v.provider_effective_from,
        'providerEffectiveTo',v.provider_effective_to,
        'sourceUrl',v.source_url,'sourceCheckedAt',v.source_checked_at,
        'sourceSnapshotSha256',v.source_snapshot_sha256,
        'parameters',v.parameters,
        'components',coalesce((select jsonb_object_agg(component,nanos_per_million::text order by component)
          from public.ai_price_components where price_version_id=v.id),'{}'::jsonb),
        'sealedAt',v.components_sealed_at,'createdAt',v.created_at) as item
    from public.ai_price_versions v
  $query$
  when 'policies' then $query$
    select v.id,v.policy_key as search_text,jsonb_build_object(
      'id',v.id,'policyKey',v.policy_key,'version',v.version,
      'latestVersion',(select max(latest.version) from public.ai_routing_policy_versions latest
        where latest.policy_key=v.policy_key),'status',v.status,
      'timezone',v.timezone,'rules',v.rules,
      'defaultProfileVersionId',v.default_profile_version_id,
      'legalBundleVersion',v.legal_bundle_version,
      'runtimeContractId',v.runtime_contract_id,'configSha256',v.config_sha256,
      'createdAt',v.created_at) as item
    from public.ai_routing_policy_versions v
  $query$
  when 'audit' then $query$
    select audit.id,audit.operation as search_text,jsonb_build_object(
      'id',audit.id,'occurredAt',audit.occurred_at,
      'eventSchemaVersion','admin_audit_event_v1','eventType',audit.operation,
      'source','admin','sourceId',audit.id,
      'operationId',(select committed.id from public.admin_committed_operations committed
        where committed.domain_audit_id=audit.id
        order by committed.committed_at desc limit 1),
      'operation',audit.operation,'actor',audit.actor,
      'targetId',audit.target_id,'reason',audit.reason) as item
      from public.admin_audit_events audit
    union all
    select lifecycle.audit_id,lifecycle.operation,jsonb_build_object(
      'id',lifecycle.audit_id,'occurredAt',lifecycle.occurred_at,
      'eventSchemaVersion','lifecycle_audit_event_v1',
      'eventType',lifecycle.operation,'source','lifecycle',
      'sourceId',lifecycle.audit_id,'operationId',null,
      'operation',lifecycle.operation,'actor',lifecycle.actor,
      'targetId',coalesce(lifecycle.policy_version_id,
        lifecycle.profile_version_id,lifecycle.profile_id,lifecycle.price_version_id),
      'reason',lifecycle.reason)
      from public.ai_routing_lifecycle_audit lifecycle
  $query$
  else null end;
end;
$$;

revoke all on function public.admin_records_query_v1(text)
from public, anon, authenticated, service_role;

commit;
