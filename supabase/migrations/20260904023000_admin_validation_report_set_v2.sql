-- B3 successor: validation reports form a bijection with effective routes.
-- v1 only checked that every selected report matched some route, allowing two
-- reports for A to satisfy routes A and B.
begin;

do $$
begin
  if to_regprocedure('public.admin_assert_policy_validation_reports_v1(uuid,uuid[],timestamptz)') is not null
     and to_regprocedure('public.admin_assert_policy_validation_reports_legacy_internal_v1(uuid,uuid[],timestamptz)') is null then
    alter function public.admin_assert_policy_validation_reports_v1(uuid,uuid[],timestamptz)
      rename to admin_assert_policy_validation_reports_legacy_internal_v1;
  end if;
end;
$$;

create or replace function public.admin_assert_policy_validation_reports_v2(
  p_policy_version_id uuid, p_validation_report_ids uuid[], p_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_policy public.ai_routing_policy_versions%rowtype;
  v_evidence jsonb;
  v_routes jsonb;
begin
  select * into v_policy from public.ai_routing_policy_versions where id=p_policy_version_id;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  v_evidence := public.admin_assert_policy_validation_reports_legacy_internal_v1(
    p_policy_version_id,p_validation_report_ids,p_at);
  v_routes := v_evidence -> 'effectiveRoutes';
  if jsonb_array_length(v_routes) <> cardinality(p_validation_report_ids) then
    raise exception 'VALIDATION_REPORT_MISMATCH' using errcode='23514';
  end if;
  -- Every effective route has exactly one selected report with the complete
  -- canonical tuple.  The reverse direction is guaranteed by v1's route
  -- membership check and distinct report-id/cardinality checks.
  if exists (
    select 1 from jsonb_array_elements(v_routes) route(value)
    where (select count(*) from public.admin_validation_reports_v1 report
      join public.admin_reviewed_deployments_v1 deployment
        on deployment.id=report.reviewed_deployment_id
       and deployment.environment=report.environment
       and deployment.project_ref=report.project_ref
       and deployment.runtime_build_id=report.runtime_build_id
       and deployment.binding_manifest_revision=report.binding_manifest_revision
       and deployment.binding_manifest_sha256=report.binding_manifest_sha256
      where report.id=any(p_validation_report_ids)
        and report.passed and report.expires_at>p_at and deployment.valid_until>p_at
        and report.runtime_contract_id=v_policy.runtime_contract_id
        and report.legal_bundle_version=v_policy.legal_bundle_version
        and report.profile_version_id::text=route.value->>'profileVersionId'
        and report.price_version_id::text=route.value->>'priceVersionId'
        and report.runtime_target_id=route.value->>'runtimeTargetId'
        and report.runtime_target_sha256=route.value->>'runtimeTargetSha256'
        and report.provider_id::text=route.value->>'providerId'
        and report.code_capability_id=route.value->>'codeCapabilityId'
        and report.code_capability_sha256=route.value->>'codeCapabilitySha256'
        and report.legal_manifest_id=route.value->>'legalManifestId'
        and report.display_disclosure_key=route.value->>'displayDisclosureKey') <> 1
  ) then raise exception 'VALIDATION_REPORT_ROUTE_BIJECTION_MISMATCH' using errcode='23514'; end if;
  return v_evidence || jsonb_build_object('schemaVersion','admin_policy_validation_v2');
end;
$$;

-- Preserve the established caller signature while routing every caller
-- through the strict successor implementation.
create or replace function public.admin_assert_policy_validation_reports_v1(
  p_policy_version_id uuid, p_validation_report_ids uuid[], p_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return public.admin_assert_policy_validation_reports_v2(
    p_policy_version_id,p_validation_report_ids,p_at);
end;
$$;

revoke all on function public.admin_assert_policy_validation_reports_v2(uuid,uuid[],timestamptz)
  from public,anon,authenticated,service_role;
revoke all on function public.admin_assert_policy_validation_reports_v1(uuid,uuid[],timestamptz)
  from public,anon,authenticated,service_role;
commit;
