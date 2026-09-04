import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServiceClient, RUN_DB_TESTS, signInAsUser } from "./helpers";
import {
  completePayload,
  SettlementHarness,
  type SettlementReservation,
} from "./provider-attempt-settlement-fixtures";
import { runOwnerSql } from "./runtime-contract-fixtures";

const profileVersionId = crypto.randomUUID();
const priceVersionId = crypto.randomUUID();
const fixtureVersion =
  1_000_000 + (Number.parseInt(profileVersionId.slice(0, 8), 16) % 1_000_000_000);
const modelId = "synthetic-compatible-model";
const endpoint = "https://api.deepseek.com/chat/completions";
const credentialEnvName = "AI_PROVIDER_KEY_DEEPSEEK_PRIMARY";
const runtimeBuildId = "local-test-build";
const bindingRevision = "local-binding-v1";
const displayDisclosureKey = `test-display.${profileVersionId.replaceAll("-", "")}`;
const reviewedDeploymentId = crypto.randomUUID();
const bindingManifestSha256 = "4".repeat(64);

describe.skipIf(!RUN_DB_TESTS)("provider execution v2 lifecycle", () => {
  let service: SupabaseClient;
  let harness: SettlementHarness;
  let reservation: SettlementReservation;
  let userId: string;
  let runtimeTargetId: string;
  let validationReportId: string;
  let admission: {
    admissionId: string;
    admissionRevision: string;
    targetSetSha256: string;
  };

  beforeAll(async () => {
    service = createServiceClient();
    harness = new SettlementHarness(service);
    await harness.setup();
    const user = await harness.makeUser("provider-execution-v2");
    userId = user.id;
    const admin = await signInAsUser(user);
    const accessToken = (await admin.auth.getSession()).data.session!.access_token;
    const issuer = (JSON.parse(
      Buffer.from(accessToken.split(".")[1], "base64url").toString(),
    ) as { iss: string }).iss;
    const environmentCount = runOwnerSql(
      "select count(*) from public.admin_environment;",
    ).stdout.match(/\n\s*(\d+)\s*\n/)?.[1];
    if (environmentCount !== "0") {
      throw new Error("v2 execution fixture requires an empty local Admin identity");
    }
    runOwnerSql(
      `select public.admin_bootstrap_v1('${userId}','local','local','${issuer.replaceAll("'", "''")}','v2 execution report fixture');`,
    );
    reservation = await harness.reserveV2(user);

    const result = runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      begin;
      set local session_replication_role = replica;

      insert into public.ai_provider_profile_versions
      select (jsonb_populate_record(
        null::public.ai_provider_profile_versions,
        to_jsonb(source_version) || jsonb_build_object(
          'id', '${profileVersionId}',
          'version', ${fixtureVersion},
          'status', 'active',
          'execution_schema_version', 'profile_execution_config_v2',
          'credential_alias', null,
          'endpoint_alias', null,
          'endpoint_url', '${endpoint}',
          'credential_env_name', '${credentialEnvName}',
          'model_id', '${modelId}',
          'display_disclosure_key', '${displayDisclosureKey}',
          'validated_at', clock_timestamp(),
          'activated_at', clock_timestamp(),
          'retired_at', null
        )
      )).*
      from public.ai_provider_profile_versions as source_version
      join public.ai_provider_profiles as profile on profile.id = source_version.profile_id
      where profile.profile_key = 'deepseek.official.deepseek-v4-flash.chat.v1'
      order by source_version.version
      limit 1;

      insert into public.ai_price_versions
      select (jsonb_populate_record(
        null::public.ai_price_versions,
        to_jsonb(price) || jsonb_build_object(
          'id', '${priceVersionId}',
          'profile_version_id', '${profileVersionId}',
          'version', ${fixtureVersion}
        )
      )).*
      from public.ai_price_versions as price
      where price.id = '${harness.fixture.priceVersionId}';

      insert into public.ai_price_components(price_version_id, component, nanos_per_million)
      select '${priceVersionId}', component, nanos_per_million
      from public.ai_price_components
      where price_version_id = '${harness.fixture.priceVersionId}';

      update public.ai_service_runtime_target_versions as target
      set profile_key = profile.profile_key
      from public.ai_provider_profile_versions as version
      join public.ai_provider_profiles as profile on profile.id = version.profile_id
      where version.id = '${profileVersionId}'
        and target.runtime_target_id in (
          select membership.runtime_target_id
          from public.ai_service_runtime_contract_targets as membership
          where membership.runtime_contract_id = '${reservation.routeSnapshot.runtimeContractId}'
        );

      update public.ai_service_runtime_contract_targets as membership
      set profile_key = profile.profile_key
      from public.ai_provider_profile_versions as version
      join public.ai_provider_profiles as profile on profile.id = version.profile_id
      where version.id = '${profileVersionId}'
        and membership.runtime_contract_id = '${reservation.routeSnapshot.runtimeContractId}';

      with display_content(value) as (
        values (jsonb_build_object(
          'schemaVersion', 'legal_display_content_v2',
          'en', jsonb_build_object(
            'providerLabel', 'Synthetic DeepSeek test recipient',
            'modelLabel', '${modelId}',
            'blocks', jsonb_build_array(jsonb_build_object(
              'kind', 'paragraph',
              'text', 'Synthetic local database fixture. No provider request is sent.'
            ))
          ),
          'zh', jsonb_build_object(
            'providerLabel', 'DeepSeek 本地合成测试接收方',
            'modelLabel', '${modelId}',
            'blocks', jsonb_build_array(jsonb_build_object(
              'kind', 'paragraph',
              'text', '仅用于本地数据库测试，不会发送 Provider 请求。'
            ))
          )
        ))
      )
      insert into public.ai_legal_display_versions_v2(
        display_disclosure_key, legal_bundle_version, legal_manifest_id,
        provider_id, recipient_key, model_id, content, content_sha256,
        fact_ids, evidence_ids, created_at, sealed_at
      )
      select
        '${displayDisclosureKey}', '${reservation.routeSnapshot.legalBundleVersion}',
        version.legal_manifest_id, profile.provider_id, provider.recipient_key,
        version.model_id, display_content.value,
        encode(extensions.digest(convert_to(display_content.value::text, 'UTF8'), 'sha256'), 'hex'),
        array['fact.synthetic-provider-recipient'],
        array['evidence.synthetic-local-db'], statement_timestamp(),
        statement_timestamp()
      from public.ai_provider_profile_versions as version
      join public.ai_provider_profiles as profile on profile.id = version.profile_id
      join public.ai_providers as provider on provider.id = profile.provider_id
      cross join display_content
      where version.id = '${profileVersionId}';

      insert into public.ai_runtime_target_bindings_v2(
        runtime_contract_id, runtime_target_id, runtime_target_sha256,
        route_descriptor_id, route_descriptor_sha256,
        profile_version_id, price_version_id, provider_id, recipient_key,
        code_capability_id, code_capability_sha256,
        gateway_kind, adapter_kind, wire_api_kind, endpoint_url,
        credential_env_name, model_id, capability_contract_id,
        cache_policy_id, calculator_kind, legal_bundle_version,
        legal_manifest_id, legal_manifest_sha256, display_disclosure_key,
        external_evidence_ids
      )
      select
        membership.runtime_contract_id, membership.runtime_target_id,
        membership.runtime_target_sha256, membership.route_descriptor_id,
        membership.route_descriptor_sha256, version.id, price.id,
        provider.id, provider.recipient_key, capability.code_capability_id,
        capability.descriptor_sha256, profile.gateway_kind,
        version.adapter_kind, version.wire_api_kind, version.endpoint_url,
        version.credential_env_name, version.model_id,
        version.capability_contract_id, version.cache_policy_id,
        price.calculator_kind, '${reservation.routeSnapshot.legalBundleVersion}',
        membership.legal_manifest_id, membership.manifest_sha256,
        version.display_disclosure_key,
        array['evidence.synthetic-local-db']
      from public.ai_service_runtime_contract_targets as membership
      join public.ai_provider_profiles as profile
        on profile.profile_key = membership.profile_key
      join public.ai_provider_profile_versions as version
        on version.profile_id = profile.id and version.id = '${profileVersionId}'
      join public.ai_providers as provider on provider.id = profile.provider_id
      join public.ai_price_versions as price on price.id = '${priceVersionId}'
      join public.ai_runtime_code_capabilities_v2 as capability
        on capability.code_capability_id = 'runtime-capability.deepseek-chat-v1.2026-09-04'
      where membership.runtime_contract_id = '${reservation.routeSnapshot.runtimeContractId}';

      do $assert_binding$
      begin
        if not exists (
          select 1
          from public.ai_runtime_target_bindings_v2
          where runtime_contract_id = '${reservation.routeSnapshot.runtimeContractId}'
            and profile_version_id = '${profileVersionId}'
            and price_version_id = '${priceVersionId}'
        ) then
          raise exception 'v2 runtime binding fixture was not authored';
        end if;
      end
      $assert_binding$;

      update public.ai_request_ledger
      set profile_version_id = '${profileVersionId}',
          price_version_id = '${priceVersionId}',
          model_id = '${modelId}',
          display_disclosure_key = '${displayDisclosureKey}'
      where reservation_id = '${reservation.reservationId}';
      commit;
    `);
    expect(result.status).toBe(0);
    reservation = {
      ...reservation,
      routeSnapshot: {
        ...reservation.routeSnapshot,
        profileVersionId,
        priceVersionId,
        modelId,
        displayDisclosureKey,
      },
    };
    runOwnerSql(String.raw`
      select public.admin_import_reviewed_deployment_v1(
        '${reviewedDeploymentId}','local','local','${runtimeBuildId}',
        '${bindingRevision}','${bindingManifestSha256}',
        array['runtime-capability.deepseek-chat-v1.2026-09-04'],
        array['evidence.local-v2-execution-build'],
        'sha1:0123456789abcdef0123456789abcdef01234567','${"5".repeat(64)}',
        clock_timestamp()+interval '1 day'
      );
    `);
    runtimeTargetId = (
      runOwnerSql(String.raw`
        \pset format unaligned
        \pset tuples_only on
        select runtime_target_id from public.ai_runtime_target_bindings_v2
        where profile_version_id='${profileVersionId}';
      `).stdout.split(/\r?\n/u).map(value => value.trim()).findLast(Boolean)
    )!;
    const report = await service.rpc("record_admin_validation_report_v1", {
      p_reviewed_deployment_id: reviewedDeploymentId,
      p_runtime_contract_id: reservation.routeSnapshot.runtimeContractId,
      p_runtime_target_id: runtimeTargetId,
      p_observed_runtime_build_id: runtimeBuildId,
      p_observed_binding_manifest_revision: bindingRevision,
      p_observed_binding_manifest_sha256: bindingManifestSha256,
      p_observed_code_capability_sha256:
        "4e5a92750f77f148e6422dcf05b03d99333b357879dba5fdb7248d16dd08bdf2",
      p_endpoint_policy_valid: true,
      p_manifest_binding_valid: true,
      p_credential_configured: true,
      p_compiled_capability_valid: true,
    });
    expect(report.error).toBeNull();
    expect(report.data?.passed).toBe(true);
    validationReportId = report.data.reportId as string;
    const duplicateTargets = runOwnerSql(String.raw`
      select public.admin_admit_runtime_deployment_v2(
        '${reviewedDeploymentId}',jsonb_build_array(
          jsonb_build_object(
            'runtimeContractId','${reservation.routeSnapshot.runtimeContractId}',
            'runtimeTargetId','${runtimeTargetId}',
            'validationReportId','${validationReportId}'
          ),
          jsonb_build_object(
            'runtimeContractId','${reservation.routeSnapshot.runtimeContractId}',
            'runtimeTargetId','${runtimeTargetId}',
            'validationReportId','${validationReportId}'
          )
        ),'duplicate target must fail'
      );
    `, { expectFailure: true });
    expect(duplicateTargets.stderr).toContain("INVALID_REQUEST");
    const missingReport = runOwnerSql(String.raw`
      select public.admin_admit_runtime_deployment_v2(
        '${reviewedDeploymentId}',jsonb_build_array(jsonb_build_object(
          'runtimeContractId','${reservation.routeSnapshot.runtimeContractId}',
          'runtimeTargetId','${runtimeTargetId}',
          'validationReportId','${crypto.randomUUID()}'
        )),'missing validation report must fail'
      );
    `, { expectFailure: true });
    expect(missingReport.stderr).toContain("EXACT_ADMISSION_EVIDENCE_REQUIRED");
    const admitted = runOwnerSql(String.raw`
      \pset format unaligned
      \pset tuples_only on
      select public.admin_admit_runtime_deployment_v2(
        '${reviewedDeploymentId}',jsonb_build_array(jsonb_build_object(
          'runtimeContractId','${reservation.routeSnapshot.runtimeContractId}',
          'runtimeTargetId','${runtimeTargetId}',
          'validationReportId','${validationReportId}'
        )),'provider execution v2 integration admission'
      );
    `).stdout.split(/\r?\n/u).map(value => value.trim())
      .findLast(value => value.startsWith("{"));
    if (!admitted) throw new Error("runtime admission receipt was not returned");
    admission = JSON.parse(admitted) as typeof admission;
  });

  afterAll(async () => {
    const restoredRuntimeTarget = runOwnerSql(String.raw`
      begin;
      set local session_replication_role = replica;
      update public.ai_service_runtime_target_versions as target
      set profile_key = profile.profile_key
      from public.ai_provider_profiles as profile
      where profile.id = '${harness.fixture.profileId}'
        and target.runtime_target_id in (
          select membership.runtime_target_id
          from public.ai_service_runtime_contract_targets as membership
          where membership.runtime_contract_id = '${reservation.routeSnapshot.runtimeContractId}'
        );
      update public.ai_service_runtime_contract_targets as membership
      set profile_key = profile.profile_key
      from public.ai_provider_profiles as profile
      where profile.id = '${harness.fixture.profileId}'
        and membership.runtime_contract_id = '${reservation.routeSnapshot.runtimeContractId}';
      commit;
    `);
    expect(
      restoredRuntimeTarget.status,
      restoredRuntimeTarget.stderr,
    ).toBe(0);
    runOwnerSql(`delete from public.admin_principals where user_id='${userId}';
      delete from public.admin_environment where environment='local';`);
    await harness.cleanup();
    runOwnerSql(String.raw`
      begin;
      set local session_replication_role = replica;
      delete from public.admin_admitted_runtime_targets_v2
        where admission_id in (
          select admission_id from public.admin_admitted_runtime_deployments_v2
          where reviewed_deployment_id = '${reviewedDeploymentId}'
        );
      delete from public.admin_admitted_runtime_deployments_v2
        where reviewed_deployment_id = '${reviewedDeploymentId}';
      delete from public.admin_validation_reports_v1
        where reviewed_deployment_id = '${reviewedDeploymentId}';
      delete from public.admin_reviewed_deployment_capabilities_v1
        where reviewed_deployment_id = '${reviewedDeploymentId}';
      delete from public.admin_reviewed_deployments_v1
        where id = '${reviewedDeploymentId}';
      delete from public.ai_runtime_target_bindings_v2
        where profile_version_id = '${profileVersionId}';
      delete from public.ai_legal_display_versions_v2
        where display_disclosure_key = '${displayDisclosureKey}';
      delete from public.ai_price_components
        where price_version_id = '${priceVersionId}';
      delete from public.ai_price_versions where id = '${priceVersionId}';
      delete from public.ai_provider_profile_versions where id = '${profileVersionId}';
      commit;
    `);
  });

  it("discovers, accepts and reserves a configurable v2 target without code labels", () => {
    const cycle = runOwnerSql(String.raw`
      begin;
      set local session_replication_role = replica;
      update public.ai_routing_policy_versions
      set default_profile_version_id = '${profileVersionId}',
          rules = jsonb_set(
            jsonb_set(
              rules,
              '{defaultRoute,profileVersionId}',
              to_jsonb('${profileVersionId}'::text)
            ),
            '{defaultRoute,priceVersionId}',
            to_jsonb('${priceVersionId}'::text)
          )
      where id = '${harness.fixture.policyVersionId}';
      set local session_replication_role = origin;

      do $cycle$
      declare
        v_availability jsonb;
        v_reservation jsonb;
      begin
        v_availability := public.get_ai_polish_availability_v2('${userId}');
        if v_availability ->> 'enabled' is distinct from 'true'
           or v_availability ->> 'profileVersionId' is distinct from '${profileVersionId}'
           or v_availability ->> 'displayDisclosureKey' is distinct from '${displayDisclosureKey}'
           or v_availability -> 'legalDisplay' ->> 'schemaVersion'
             is distinct from 'legal_display_v2'
           or v_availability -> 'legalDisplay' ->> 'modelId'
             is distinct from '${modelId}'
           or v_availability ->> 'termsAccepted' is distinct from 'false' then
          raise exception 'v2 availability did not expose the exact sealed display';
        end if;

        insert into public.user_ai_legal_acceptances_v2(
          user_id, legal_bundle_version, display_disclosure_key, content_sha256
        )
        select '${userId}', display.legal_bundle_version,
          display.display_disclosure_key, display.content_sha256
        from public.ai_legal_display_versions_v2 as display
        where display.display_disclosure_key = '${displayDisclosureKey}';

        v_availability := public.get_ai_polish_availability_v2('${userId}');
        if v_availability ->> 'termsAccepted' is distinct from 'true' then
          raise exception 'v2 availability did not observe exact consent';
        end if;

        v_reservation := public.reserve_ai_polish_request_v2(
          '${userId}',
          extensions.gen_random_uuid(),
          extensions.gen_random_uuid(),
          jsonb_build_object(
            'schema_version', 'expected_route_v1',
            'config_generation', v_availability ->> 'configGeneration',
            'profile_version_id', v_availability ->> 'profileVersionId',
            'legal_bundle_version', v_availability ->> 'legalBundleVersion',
            'runtime_contract_id', v_availability ->> 'runtimeContractId'
          )
        );
        if v_reservation ->> 'allowed' is distinct from 'true'
           or v_reservation -> 'routeSnapshot' ->> 'profileVersionId'
             is distinct from '${profileVersionId}'
           or v_reservation -> 'routeSnapshot' ->> 'displayDisclosureKey'
             is distinct from '${displayDisclosureKey}' then
          raise exception 'exactly accepted v2 target was not reservable';
        end if;
      end
      $cycle$;
      rollback;
    `);
    expect(cycle.status, cycle.stderr).toBe(0);
  });

  it("requires the exact sealed disclosure on every v2 request insert", () => {
    const withoutExactConsent = runOwnerSql(String.raw`
      insert into public.ai_request_ledger
      select (jsonb_populate_record(
        null::public.ai_request_ledger,
        to_jsonb(source_request) || jsonb_build_object(
          'reservation_id', extensions.gen_random_uuid(),
          'request_id', extensions.gen_random_uuid(),
          'client_request_id', extensions.gen_random_uuid(),
          'reserved_at', clock_timestamp()
        )
      )).*
      from public.ai_request_ledger as source_request
      where source_request.reservation_id = '${reservation.reservationId}';
    `, { expectFailure: true });
    expect(withoutExactConsent.stderr).toContain(
      "exact v2 legal disclosure acceptance is required",
    );

    const withExactConsent = runOwnerSql(String.raw`
      begin;
      insert into public.user_ai_legal_acceptances_v2(
        user_id, legal_bundle_version, display_disclosure_key, content_sha256
      )
      select
        '${userId}', display.legal_bundle_version,
        display.display_disclosure_key, display.content_sha256
      from public.ai_legal_display_versions_v2 as display
      where display.legal_bundle_version = '${reservation.routeSnapshot.legalBundleVersion}'
        and display.display_disclosure_key = '${displayDisclosureKey}';

      insert into public.ai_request_ledger
      select (jsonb_populate_record(
        null::public.ai_request_ledger,
        to_jsonb(source_request) || jsonb_build_object(
          'reservation_id', extensions.gen_random_uuid(),
          'request_id', extensions.gen_random_uuid(),
          'client_request_id', extensions.gen_random_uuid(),
          'reserved_at', clock_timestamp()
        )
      )).*
      from public.ai_request_ledger as source_request
      where source_request.reservation_id = '${reservation.reservationId}';
      rollback;
    `);
    expect(withExactConsent.status, withExactConsent.stderr).toBe(0);
  });

  it("reads, admits, completes and settles one frozen v2 execution", async () => {
    const reportedSnapshot = await service.rpc(
      "get_ai_polish_execution_snapshot_v3",
      {
        p_reservation_id: reservation.reservationId,
        p_user_id: userId,
      },
    );
    expect(reportedSnapshot.error).toBeNull();
    expect(reportedSnapshot.data).toMatchObject({
      schemaVersion: "ai_polish_execution_snapshot_v2",
      deploymentValidation: {
        schemaVersion: "runtime_deployment_validation_v1",
        reviewedDeploymentId,
        runtimeBuildId,
        bindingManifestRevision: bindingRevision,
      },
    });
    const snapshot = await service.rpc("get_ai_polish_execution_snapshot_v4", {
      p_reservation_id: reservation.reservationId,
      p_user_id: userId,
      p_environment: "local",
      p_project_ref: "local",
      p_runtime_build_id: runtimeBuildId,
      p_binding_manifest_revision: bindingRevision,
      p_binding_manifest_sha256: bindingManifestSha256,
    });
    expect(snapshot.error).toBeNull();
    expect(snapshot.data, JSON.stringify(snapshot.data)).toMatchObject({
      schemaVersion: "ai_polish_execution_snapshot_v2",
      ok: true,
      reservationId: reservation.reservationId,
      profileExecutionConfig: {
        schemaVersion: "profile_execution_config_v2",
        providerId: "706513a5-462b-4bba-93b0-53e50661416e",
        endpointUrl: endpoint,
        credentialEnvName,
        modelId,
      },
      runtimeEvidence: {
        runtimeContractId: reservation.routeSnapshot.runtimeContractId,
        profileVersionId,
        priceVersionId,
        providerId: "706513a5-462b-4bba-93b0-53e50661416e",
        recipientKey: "deepseek",
        codeCapabilityId: "runtime-capability.deepseek-chat-v1.2026-09-04",
        endpointUrl: endpoint,
        credentialEnvName,
        modelId,
        displayDisclosureKey,
      },
      deploymentValidation: {
        schemaVersion: "runtime_deployment_admission_v2",
        admissionId: admission.admissionId,
        reviewedDeploymentId,
        validationReportId,
        admissionRevision: admission.admissionRevision,
        targetSetSha256: admission.targetSetSha256,
        runtimeTargetId,
      },
    });

    const runtimeAdmission = snapshot.data.deploymentValidation;
    const startArgs = {
      p_reservation_id: reservation.reservationId,
      p_attempt_no: 1,
      p_admission_id: runtimeAdmission.admissionId,
      p_reviewed_deployment_id: runtimeAdmission.reviewedDeploymentId,
      p_validation_report_id: runtimeAdmission.validationReportId,
      p_environment: runtimeAdmission.environment,
      p_project_ref: runtimeAdmission.projectRef,
      p_runtime_build_id: runtimeBuildId,
      p_binding_manifest_revision: bindingRevision,
      p_binding_manifest_sha256: runtimeAdmission.bindingManifestSha256,
      p_admission_revision: runtimeAdmission.admissionRevision,
      p_target_set_sha256: runtimeAdmission.targetSetSha256,
      p_runtime_contract_id: runtimeAdmission.runtimeContractId,
      p_runtime_target_id: runtimeAdmission.runtimeTargetId,
      p_runtime_target_sha256: runtimeAdmission.runtimeTargetSha256,
    };
    const start = await service.rpc("start_ai_polish_provider_attempt_v3", startArgs);
    expect(start.error).toBeNull();
    expect(start.data).toMatchObject({
      ok: true,
      attemptNo: 1,
      alreadyStarted: false,
      status: "started",
    });

    const replayMismatch = await service.rpc(
      "start_ai_polish_provider_attempt_v3",
      { ...startArgs, p_runtime_build_id: "different-build" },
    );
    expect(replayMismatch.error).toBeNull();
    expect(replayMismatch.data).toEqual({
      ok: false,
      reason: "SERVICE_UNAVAILABLE",
    });

    const attempt = await service
      .from("ai_provider_attempt_ledger")
      .select(
        "execution_schema_version,endpoint_url,credential_env_name,runtime_build_id,binding_manifest_revision,runtime_admission_id,runtime_admission_revision,runtime_target_set_sha256,admitted_runtime_target_id,runtime_validation_report_id",
      )
      .eq("attempt_id", start.data.attemptId)
      .single();
    expect(attempt.error).toBeNull();
    expect(attempt.data).toEqual({
      execution_schema_version: "profile_execution_config_v2",
      endpoint_url: endpoint,
      credential_env_name: credentialEnvName,
      runtime_build_id: runtimeBuildId,
      binding_manifest_revision: bindingRevision,
      runtime_admission_id: admission.admissionId,
      runtime_admission_revision: Number(admission.admissionRevision),
      runtime_target_set_sha256: admission.targetSetSha256,
      admitted_runtime_target_id: runtimeTargetId,
      runtime_validation_report_id: validationReportId,
    });

    const sealedAppend = runOwnerSql(String.raw`
      insert into public.admin_admitted_runtime_targets_v2
      select * from public.admin_admitted_runtime_targets_v2
      where admission_id='${admission.admissionId}' limit 1;
    `, { expectFailure: true });
    expect(sealedAppend.stderr).toMatch(/sealed|duplicate|immutable|Exact passed/i);

    runOwnerSql(String.raw`
      select public.admin_revoke_runtime_deployment_v2(
        '${admission.admissionId}',${admission.admissionRevision}::bigint,
        '${admission.targetSetSha256}','integration revoke before retry'
      );
    `);
    const deniedSecond = await service.rpc(
      "start_ai_polish_provider_attempt_v3",
      { ...startArgs, p_attempt_no: 2 },
    );
    expect(deniedSecond.error).toBeNull();
    expect(deniedSecond.data).toEqual({ ok: false, reason: "SERVICE_UNAVAILABLE" });
    const exactReplay = await service.rpc("start_ai_polish_provider_attempt_v3", startArgs);
    expect(exactReplay.error).toBeNull();
    expect(exactReplay.data).toMatchObject({ ok: true, alreadyStarted: true });
    const revokedSnapshot = await service.rpc("get_ai_polish_execution_snapshot_v4", {
      p_reservation_id: reservation.reservationId,
      p_user_id: userId,
      p_environment: "local",
      p_project_ref: "local",
      p_runtime_build_id: runtimeBuildId,
      p_binding_manifest_revision: bindingRevision,
      p_binding_manifest_sha256: bindingManifestSha256,
    });
    expect(revokedSnapshot.error).toBeNull();
    expect(revokedSnapshot.data).toEqual({
      schemaVersion: "ai_polish_execution_snapshot_v1",
      ok: false,
      reason: "SERVICE_UNAVAILABLE",
    });

    const completed = await harness.complete(
      completePayload(start.data.attemptId as string, {
        p_route: {
          schema_version: "route_observation_v1",
          gateway_request_id: null,
          provider_request_id: null,
          actual_upstream_endpoint: null,
          actual_model_id: modelId,
          router_attempt_count: 1,
        },
      }),
    );
    expect(completed).toMatchObject({ ok: true, status: "succeeded" });
    const finalized = await harness.finalize(reservation.reservationId);
    expect(finalized).toMatchObject({ ok: true, status: "succeeded" });
  });
});
