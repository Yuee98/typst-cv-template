-- Keep one service-role start authority alive across the runtime authority
-- cutover. The nullable receipt is intentional: old v1 reservations retain
-- frozen legacy start semantics, while v2 reservations must provide the
-- complete durable admission receipt.
begin;

create function public.start_ai_polish_provider_attempt_v4(
  p_reservation_id uuid,
  p_attempt_no integer,
  p_runtime_admission jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_request public.ai_request_ledger%rowtype;
begin
  select * into v_request
  from public.ai_request_ledger
  where reservation_id = p_reservation_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'NOT_FOUND');
  end if;

  if p_runtime_admission is null then
    return public.start_ai_polish_provider_attempt(p_reservation_id, p_attempt_no);
  end if;

  if jsonb_typeof(p_runtime_admission) is distinct from 'object' then
    raise exception 'v2 runtime admission receipt is malformed' using errcode = '22023';
  end if;

  if (select count(*) from jsonb_object_keys(p_runtime_admission)) <> 22
     or p_runtime_admission ->> 'schemaVersion' is distinct from 'runtime_deployment_admission_v2'
     or (p_runtime_admission ->> 'admissionId')::uuid is null
     or (p_runtime_admission ->> 'reviewedDeploymentId')::uuid is null
     or (p_runtime_admission ->> 'validationReportId')::uuid is null
     or p_runtime_admission ->> 'environment' is null
     or p_runtime_admission ->> 'projectRef' is null
     or p_runtime_admission ->> 'runtimeBuildId' is null
     or p_runtime_admission ->> 'bindingManifestRevision' is null
     or p_runtime_admission ->> 'bindingManifestSha256' is null
     or p_runtime_admission ->> 'admissionRevision' is null
     or p_runtime_admission ->> 'targetSetSha256' is null
     or p_runtime_admission ->> 'runtimeContractId' is null
     or p_runtime_admission ->> 'runtimeTargetId' is null
     or p_runtime_admission ->> 'runtimeTargetSha256' is null
     or p_runtime_admission ->> 'profileVersionId' is null
     or p_runtime_admission ->> 'priceVersionId' is null
     or p_runtime_admission ->> 'providerId' is null
     or p_runtime_admission ->> 'codeCapabilityId' is null
     or p_runtime_admission ->> 'codeCapabilitySha256' is null
     or p_runtime_admission ->> 'legalBundleVersion' is null
     or p_runtime_admission ->> 'legalManifestId' is null
     or p_runtime_admission ->> 'displayDisclosureKey' is null then
    raise exception 'v2 runtime admission receipt is malformed' using errcode = '22023';
  end if;

  -- Authenticate every duplicated receipt fact against the sealed database
  -- admission before delegating to the existing start implementation.  This
  -- keeps a crossed JSON receipt from being accepted merely because its three
  -- target lookup keys happen to name a real target.
  if not exists (
    select 1
    from public.admin_admitted_runtime_deployments_v2 as admission
    join public.admin_admitted_runtime_targets_v2 as target
      on target.admission_id = admission.admission_id
    where admission.admission_id =
          (p_runtime_admission ->> 'admissionId')::uuid
      and admission.reviewed_deployment_id =
          (p_runtime_admission ->> 'reviewedDeploymentId')::uuid
      and admission.environment = p_runtime_admission ->> 'environment'
      and admission.project_ref = p_runtime_admission ->> 'projectRef'
      and admission.runtime_build_id = p_runtime_admission ->> 'runtimeBuildId'
      and admission.binding_manifest_revision =
          p_runtime_admission ->> 'bindingManifestRevision'
      and admission.binding_manifest_sha256 =
          p_runtime_admission ->> 'bindingManifestSha256'
      and admission.admission_revision =
          (p_runtime_admission ->> 'admissionRevision')::bigint
      and admission.target_set_sha256 =
          p_runtime_admission ->> 'targetSetSha256'
      and admission.sealed_at is not null
      and target.validation_report_id =
          (p_runtime_admission ->> 'validationReportId')::uuid
      and target.runtime_contract_id =
          p_runtime_admission ->> 'runtimeContractId'
      and target.runtime_target_id = p_runtime_admission ->> 'runtimeTargetId'
      and target.runtime_target_sha256 =
          p_runtime_admission ->> 'runtimeTargetSha256'
      and target.profile_version_id =
          (p_runtime_admission ->> 'profileVersionId')::uuid
      and target.price_version_id =
          (p_runtime_admission ->> 'priceVersionId')::uuid
      and target.provider_id = (p_runtime_admission ->> 'providerId')::uuid
      and target.code_capability_id =
          p_runtime_admission ->> 'codeCapabilityId'
      and target.code_capability_sha256 =
          p_runtime_admission ->> 'codeCapabilitySha256'
      and target.legal_bundle_version =
          p_runtime_admission ->> 'legalBundleVersion'
      and target.legal_manifest_id =
          p_runtime_admission ->> 'legalManifestId'
      and target.display_disclosure_key =
          p_runtime_admission ->> 'displayDisclosureKey'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'SERVICE_UNAVAILABLE');
  end if;

  return public.start_ai_polish_provider_attempt_v3(
    p_reservation_id, p_attempt_no,
    (p_runtime_admission ->> 'admissionId')::uuid,
    (p_runtime_admission ->> 'reviewedDeploymentId')::uuid,
    (p_runtime_admission ->> 'validationReportId')::uuid,
    p_runtime_admission ->> 'environment', p_runtime_admission ->> 'projectRef',
    p_runtime_admission ->> 'runtimeBuildId',
    p_runtime_admission ->> 'bindingManifestRevision',
    p_runtime_admission ->> 'bindingManifestSha256',
    (p_runtime_admission ->> 'admissionRevision')::bigint,
    p_runtime_admission ->> 'targetSetSha256',
    p_runtime_admission ->> 'runtimeContractId',
    p_runtime_admission ->> 'runtimeTargetId',
    p_runtime_admission ->> 'runtimeTargetSha256'
  );
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'v2 runtime admission receipt is malformed' using errcode = '22023';
end;
$$;

revoke all on function public.start_ai_polish_provider_attempt_v4(uuid, integer, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.start_ai_polish_provider_attempt_v4(uuid, integer, jsonb)
  to service_role;

commit;
