import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServiceClient, RUN_DB_TESTS } from "./helpers";
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

describe.skipIf(!RUN_DB_TESTS)("provider execution v2 lifecycle", () => {
  let service: SupabaseClient;
  let harness: SettlementHarness;
  let reservation: SettlementReservation;
  let userId: string;

  beforeAll(async () => {
    service = createServiceClient();
    harness = new SettlementHarness(service);
    await harness.setup();
    const user = await harness.makeUser("provider-execution-v2");
    userId = user.id;
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
  });

  afterAll(async () => {
    const restoredRuntimeTarget = runOwnerSql(String.raw`
      begin;
      set local session_replication_role = replica;
      delete from public.ai_runtime_target_bindings_v2
        where profile_version_id = '${profileVersionId}';
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
    await harness.cleanup();
    runOwnerSql(String.raw`
      begin;
      set local session_replication_role = replica;
      delete from public.ai_legal_display_versions_v2
        where display_disclosure_key = '${displayDisclosureKey}';
      delete from public.ai_price_components
        where price_version_id = '${priceVersionId}';
      delete from public.ai_price_versions where id = '${priceVersionId}';
      delete from public.ai_provider_profile_versions where id = '${profileVersionId}';
      commit;
    `);
  });

  it("reads, admits, completes and settles one frozen v2 execution", async () => {
    const snapshot = await service.rpc("get_ai_polish_execution_snapshot_v2", {
      p_reservation_id: reservation.reservationId,
      p_user_id: userId,
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
    });

    const start = await service.rpc("start_ai_polish_provider_attempt_v2", {
      p_reservation_id: reservation.reservationId,
      p_attempt_no: 1,
      p_runtime_build_id: runtimeBuildId,
      p_binding_manifest_revision: bindingRevision,
    });
    expect(start.error).toBeNull();
    expect(start.data).toMatchObject({
      ok: true,
      attemptNo: 1,
      alreadyStarted: false,
      status: "started",
    });

    const replayMismatch = await service.rpc(
      "start_ai_polish_provider_attempt_v2",
      {
        p_reservation_id: reservation.reservationId,
        p_attempt_no: 1,
        p_runtime_build_id: "different-build",
        p_binding_manifest_revision: bindingRevision,
      },
    );
    expect(replayMismatch.error).toBeNull();
    expect(replayMismatch.data).toEqual({
      ok: false,
      reason: "SERVICE_UNAVAILABLE",
    });

    const attempt = await service
      .from("ai_provider_attempt_ledger")
      .select(
        "execution_schema_version,endpoint_url,credential_env_name,runtime_build_id,binding_manifest_revision",
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
