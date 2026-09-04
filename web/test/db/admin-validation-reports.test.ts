import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createAnonClient,
  createServiceClient,
  createTestUser,
  deleteTestUser,
  RUN_DB_TESTS,
  signInAsUser,
  type TestUser,
} from "./helpers";
import {
  authorSyntheticRuntimeContract,
  authorSyntheticRuntimeContractSet,
  DEEPSEEK_LEGAL_MANIFEST_ID,
  DEEPSEEK_LEGAL_MANIFEST_SHA256,
  INITIAL_LEGAL_BUNDLE_VERSION,
  runOwnerSql,
} from "./runtime-contract-fixtures";

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const profileVersionId = crypto.randomUUID();
const priceVersionId = crypto.randomUUID();
const reviewedDeploymentId = crypto.randomUUID();
const modelId = "synthetic-admin-validation-model";
const displayKey = `test-display.${profileVersionId.replaceAll("-", "")}`;
const runtimeBuildId = `local-build:${reviewedDeploymentId}`;
const bindingRevision = `local-binding.${reviewedDeploymentId}`;
const bindingManifestSha256 = "1".repeat(64);
const capabilityId =
  "runtime-capability.deepseek-chat-v1.2026-09-04";
const mimoCapabilityId =
  "runtime-capability.mimo-responses-v1.2026-09-04";
const capabilitySha256 =
  "4e5a92750f77f148e6422dcf05b03d99333b357879dba5fdb7248d16dd08bdf2";

function totpCode(secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.replaceAll("=", "").toUpperCase()) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("invalid TOTP secret");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.alloc(Math.floor(bits.length / 8));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2);
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", bytes).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return (binary % 1_000_000).toString().padStart(6, "0");
}

describe.skipIf(!RUN_DB_TESTS)("Admin validation report authority", () => {
  let service: SupabaseClient;
  let admin: SupabaseClient;
  let ordinary: SupabaseClient;
  let adminUser: TestUser;
  let ordinaryUser: TestUser;
  let ownsEnvironment = false;
  let runtime: ReturnType<typeof authorSyntheticRuntimeContract>;
  let adminSessionId: string;
  let adminIssuer: string;

  beforeAll(async () => {
    service = createServiceClient();
    runtime = authorSyntheticRuntimeContract({
      profileKey: "deepseek.official.deepseek-v4-flash.chat.v1",
    });
    adminUser = await createTestUser(service, "admin-report");
    ordinaryUser = await createTestUser(service, "admin-report-ordinary");
    admin = await signInAsUser(adminUser);
    ordinary = await signInAsUser(ordinaryUser);
    const token = (await admin.auth.getSession()).data.session!.access_token;
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    ) as { iss: string; session_id: string };
    adminSessionId = claims.session_id;
    adminIssuer = claims.iss;
    const exists = runOwnerSql(
      "select count(*) from public.admin_environment;",
    ).stdout.match(/\n\s*(\d+)\s*\n/)?.[1];
    if (exists !== "0") {
      throw new Error(
        "Admin tests require an uninitialized local Admin environment; never overwrite operator state",
      );
    }
    runOwnerSql(
      `select public.admin_bootstrap_v1(${literal(adminUser.id)},'local','local',${literal(claims.iss)},'local report test bootstrap');`,
    );
    ownsEnvironment = true;

    const fixtureVersion =
      1_000_000 +
      (Number.parseInt(profileVersionId.slice(0, 8), 16) % 1_000_000_000);
    runOwnerSql(String.raw`
      begin;
      set local session_replication_role = replica;
      insert into public.ai_provider_profile_versions
      select (jsonb_populate_record(
        null::public.ai_provider_profile_versions,
        to_jsonb(source_version) || jsonb_build_object(
          'id', '${profileVersionId}', 'version', ${fixtureVersion},
          'status', 'validated',
          'execution_schema_version', 'profile_execution_config_v2',
          'credential_alias', null, 'endpoint_alias', null,
          'endpoint_url', 'https://api.deepseek.com/chat/completions',
          'credential_env_name', 'AI_PROVIDER_KEY_DEEPSEEK_PRIMARY',
          'model_id', '${modelId}',
          'display_disclosure_key', '${displayKey}',
          'validated_at', clock_timestamp(), 'activated_at', null,
          'retired_at', null
        )
      )).*
      from public.ai_provider_profile_versions as source_version
      join public.ai_provider_profiles as profile
        on profile.id = source_version.profile_id
      where profile.profile_key = 'deepseek.official.deepseek-v4-flash.chat.v1'
      order by source_version.version limit 1;

      insert into public.ai_price_versions
      select (jsonb_populate_record(
        null::public.ai_price_versions,
        to_jsonb(price) || jsonb_build_object(
          'id', '${priceVersionId}', 'profile_version_id', '${profileVersionId}',
          'version', ${fixtureVersion},
          'components_sealed_at', clock_timestamp()
        )
      )).*
      from public.ai_price_versions as price
      join public.ai_provider_profile_versions as version
        on version.id = price.profile_version_id
      join public.ai_provider_profiles as profile on profile.id = version.profile_id
      where profile.profile_key = 'deepseek.official.deepseek-v4-flash.chat.v1'
        and price.valid_from <= statement_timestamp()
        and (price.valid_to is null or price.valid_to > statement_timestamp())
        and (price.provider_effective_from is null
          or price.provider_effective_from <= statement_timestamp())
        and (price.provider_effective_to is null
          or price.provider_effective_to > statement_timestamp())
      order by price.version desc limit 1;
      insert into public.ai_price_components(price_version_id,component,nanos_per_million)
      select '${priceVersionId}', component, nanos_per_million
      from public.ai_price_components
      where price_version_id = (
        select price.id from public.ai_price_versions as price
        join public.ai_provider_profile_versions as version
          on version.id = price.profile_version_id
        join public.ai_provider_profiles as profile on profile.id = version.profile_id
        where profile.profile_key = 'deepseek.official.deepseek-v4-flash.chat.v1'
          and price.id <> '${priceVersionId}'
          and price.valid_from <= statement_timestamp()
          and (price.valid_to is null or price.valid_to > statement_timestamp())
          and (price.provider_effective_from is null
            or price.provider_effective_from <= statement_timestamp())
          and (price.provider_effective_to is null
            or price.provider_effective_to > statement_timestamp())
        order by price.version desc limit 1
      );

      with content(value) as (values (jsonb_build_object(
        'schemaVersion','legal_display_content_v2',
        'en',jsonb_build_object('providerLabel','Synthetic DeepSeek',
          'modelLabel','${modelId}','blocks',jsonb_build_array(
            jsonb_build_object('kind','paragraph','text','Local validation fixture.'))),
        'zh',jsonb_build_object('providerLabel','DeepSeek 本地测试',
          'modelLabel','${modelId}','blocks',jsonb_build_array(
            jsonb_build_object('kind','paragraph','text','本地验证测试。')))
      )))
      insert into public.ai_legal_display_versions_v2(
        display_disclosure_key,legal_bundle_version,legal_manifest_id,
        provider_id,recipient_key,model_id,content,content_sha256,
        fact_ids,evidence_ids,created_at,sealed_at
      )
      select '${displayKey}','${INITIAL_LEGAL_BUNDLE_VERSION}',
        'deepseek-official-2026-08-23-v1',profile.provider_id,
        provider.recipient_key,'${modelId}',content.value,
        encode(extensions.digest(convert_to(content.value::text,'UTF8'),'sha256'),'hex'),
        array['fact.admin-validation'],array['evidence.admin-validation'],
        statement_timestamp(),statement_timestamp()
      from public.ai_provider_profiles as profile
      join public.ai_providers as provider on provider.id=profile.provider_id
      cross join content
      where profile.profile_key='deepseek.official.deepseek-v4-flash.chat.v1';

      insert into public.ai_runtime_target_bindings_v2(
        runtime_contract_id,runtime_target_id,runtime_target_sha256,
        route_descriptor_id,route_descriptor_sha256,profile_version_id,
        price_version_id,provider_id,recipient_key,code_capability_id,
        code_capability_sha256,gateway_kind,adapter_kind,wire_api_kind,
        endpoint_url,credential_env_name,model_id,capability_contract_id,
        cache_policy_id,calculator_kind,legal_bundle_version,legal_manifest_id,
        legal_manifest_sha256,display_disclosure_key,external_evidence_ids
      )
      select membership.runtime_contract_id,membership.runtime_target_id,
        membership.runtime_target_sha256,membership.route_descriptor_id,
        membership.route_descriptor_sha256,version.id,price.id,provider.id,
        provider.recipient_key,capability.code_capability_id,
        capability.descriptor_sha256,profile.gateway_kind,version.adapter_kind,
        version.wire_api_kind,version.endpoint_url,version.credential_env_name,
        version.model_id,version.capability_contract_id,version.cache_policy_id,
        price.calculator_kind,'${INITIAL_LEGAL_BUNDLE_VERSION}',
        membership.legal_manifest_id,membership.manifest_sha256,
        version.display_disclosure_key,array['evidence.synthetic-local-db']
      from public.ai_service_runtime_contract_targets as membership
      join public.ai_provider_profiles as profile
        on profile.profile_key=membership.profile_key
      join public.ai_provider_profile_versions as version
        on version.profile_id=profile.id and version.id='${profileVersionId}'
      join public.ai_providers as provider on provider.id=profile.provider_id
      join public.ai_price_versions as price on price.id='${priceVersionId}'
      join public.ai_runtime_code_capabilities_v2 as capability
        on capability.code_capability_id='${capabilityId}'
      where membership.runtime_contract_id='${runtime.runtimeContractId}';
      commit;
    `);

    runOwnerSql(String.raw`
      select public.admin_import_reviewed_deployment_v1(
        '${reviewedDeploymentId}','local','local','${runtimeBuildId}',
        '${bindingRevision}','${bindingManifestSha256}',
        array['${mimoCapabilityId}','${capabilityId}'],
        array['evidence.reviewed-z','evidence.reviewed-a'],
        'sha1:0123456789abcdef0123456789abcdef01234567','${"2".repeat(64)}',
        clock_timestamp()+interval '1 day'
      );
    `);
  });

  afterAll(async () => {
    if (ownsEnvironment) {
      runOwnerSql(`delete from public.admin_principals where user_id=${literal(adminUser.id)};
        delete from public.admin_environment where environment='local';`);
    }
    if (adminUser) await deleteTestUser(service, adminUser.id);
    if (ordinaryUser) await deleteTestUser(service, ordinaryUser.id);
  });

  it("allows only the service producer to load a registered candidate", async () => {
    const canonicalSets = runOwnerSql(String.raw`
      select array_to_string(deployment.reviewed_evidence_ids, '|') || ';' || (
        select string_agg(capability.code_capability_id, '|' order by capability.code_capability_id)
        from public.admin_reviewed_deployment_capabilities_v1 as capability
        where capability.reviewed_deployment_id = deployment.id
      )
      from public.admin_reviewed_deployments_v1 as deployment
      where deployment.id = '${reviewedDeploymentId}';
    `).stdout;
    expect(canonicalSets).toContain(
      `evidence.reviewed-a|evidence.reviewed-z;${capabilityId}|${mimoCapabilityId}`,
    );
    const args = {
      p_reviewed_deployment_id: reviewedDeploymentId,
      p_runtime_contract_id: runtime.runtimeContractId,
      p_runtime_target_id: runtime.runtimeTargetId,
    };
    for (const client of [createAnonClient(), ordinary, admin]) {
      expect(
        (await client.rpc("get_admin_validation_candidate_v1", args)).error
          ?.code,
      ).toBe("42501");
    }
    const candidate = await service.rpc(
      "get_admin_validation_candidate_v1",
      args,
    );
    expect(candidate.error).toBeNull();
    expect(candidate.data).toMatchObject({
      schemaVersion: "admin_validation_candidate_v1",
      deployment: {
        id: reviewedDeploymentId,
        runtimeBuildId,
        bindingManifestRevision: bindingRevision,
      },
      profileExecutionConfig: {
        schemaVersion: "profile_execution_config_v2",
        modelId,
      },
      runtimeTarget: {
        runtimeContractId: runtime.runtimeContractId,
        runtimeTargetId: runtime.runtimeTargetId,
        profileVersionId,
        priceVersionId,
      },
    });
  });

  it("records strict pass/fail reports without granting reviewed authority", async () => {
    const baseArgs = {
      p_reviewed_deployment_id: reviewedDeploymentId,
      p_runtime_contract_id: runtime.runtimeContractId,
      p_runtime_target_id: runtime.runtimeTargetId,
      p_observed_runtime_build_id: runtimeBuildId,
      p_observed_binding_manifest_revision: bindingRevision,
      p_observed_binding_manifest_sha256: bindingManifestSha256,
      p_observed_code_capability_sha256: capabilitySha256,
      p_endpoint_policy_valid: true,
      p_manifest_binding_valid: true,
      p_credential_configured: true,
      p_compiled_capability_valid: true,
    };
    for (const client of [ordinary, admin]) {
      expect(
        (await client.rpc("record_admin_validation_report_v1", baseArgs))
          .error?.code,
      ).toBe("42501");
    }
    const passed = await service.rpc(
      "record_admin_validation_report_v1",
      baseArgs,
    );
    expect(passed.error).toBeNull();
    expect(passed.data).toMatchObject({
      schemaVersion: "admin_validation_report_v1",
      reviewedDeploymentId,
      runtimeTargetId: runtime.runtimeTargetId,
      passed: true,
      checks: {
        endpointPolicy: true,
        manifestBinding: true,
        credentialConfigured: true,
        compiledCapability: true,
        databaseBinding: true,
      },
    });
    const failed = await service.rpc("record_admin_validation_report_v1", {
      ...baseArgs,
      p_credential_configured: false,
    });
    expect(failed.error).toBeNull();
    expect(failed.data.passed).toBe(false);
    const selected = await service.rpc("get_admin_runtime_validation_v1", {
      p_runtime_contract_id: runtime.runtimeContractId,
      p_runtime_target_id: runtime.runtimeTargetId,
    });
    expect(selected.error).toBeNull();
    expect(selected.data).toMatchObject({
      schemaVersion: "runtime_deployment_validation_v1",
      reportId: passed.data.reportId,
      runtimeBuildId,
    });

    const boundedDeploymentId = crypto.randomUUID();
    const boundedBuildId = `local-build:${boundedDeploymentId}`;
    runOwnerSql(String.raw`
      select public.admin_import_reviewed_deployment_v1(
        '${boundedDeploymentId}','local','local','${boundedBuildId}',
        '${bindingRevision}','${bindingManifestSha256}',array['${capabilityId}'],
        array['evidence.reviewed-short-lived-build'],
        'sha1:0123456789abcdef0123456789abcdef01234567','${"3".repeat(64)}',
        clock_timestamp()+interval '2 minutes'
      );
    `);
    const bounded = await service.rpc("record_admin_validation_report_v1", {
      ...baseArgs,
      p_reviewed_deployment_id: boundedDeploymentId,
      p_observed_runtime_build_id: boundedBuildId,
    });
    expect(bounded.error).toBeNull();
    expect(Date.parse(bounded.data.expiresAt)).toBeLessThanOrEqual(
      Date.now() + 2 * 60_000,
    );
  });

  it("rejects unknown observed build, manifest, capability and candidate", async () => {
    const baseArgs = {
      p_reviewed_deployment_id: reviewedDeploymentId,
      p_runtime_contract_id: runtime.runtimeContractId,
      p_runtime_target_id: runtime.runtimeTargetId,
      p_observed_runtime_build_id: runtimeBuildId,
      p_observed_binding_manifest_revision: bindingRevision,
      p_observed_binding_manifest_sha256: bindingManifestSha256,
      p_observed_code_capability_sha256: capabilitySha256,
      p_endpoint_policy_valid: true,
      p_manifest_binding_valid: true,
      p_credential_configured: true,
      p_compiled_capability_valid: true,
    };
    for (const changed of [
      { p_observed_runtime_build_id: "unknown-build" },
      { p_observed_binding_manifest_revision: "wrong-revision" },
      { p_observed_binding_manifest_sha256: "0".repeat(64) },
      { p_observed_code_capability_sha256: "0".repeat(64) },
      { p_runtime_target_id: `unknown-target.${crypto.randomUUID()}` },
    ]) {
      const result = await service.rpc("record_admin_validation_report_v1", {
        ...baseArgs,
        ...changed,
      });
      expect(result.error).not.toBeNull();
    }
  });

  it("keeps importer and all report tables outside application DML", async () => {
    for (const client of [createAnonClient(), ordinary, admin, service]) {
      expect(
        (
          await client.rpc("admin_import_reviewed_deployment_v1", {
            p_id: crypto.randomUUID(),
            p_environment: "local",
            p_project_ref: "local",
            p_runtime_build_id: runtimeBuildId,
            p_binding_manifest_revision: bindingRevision,
            p_binding_manifest_sha256: bindingManifestSha256,
            p_code_capability_ids: [capabilityId],
            p_reviewed_evidence_ids: ["evidence.forged"],
            p_reviewed_source_commit_oid:
              "sha1:0123456789abcdef0123456789abcdef01234567",
            p_reviewed_source_sha256: "2".repeat(64),
            p_valid_until: new Date(Date.now() + 60_000).toISOString(),
          })
        ).error?.code,
      ).toBe("42501");
      for (const table of [
        "admin_reviewed_deployments_v1",
        "admin_reviewed_deployment_capabilities_v1",
        "admin_validation_reports_v1",
      ]) {
        expect((await client.from(table).select("*")).error?.code).toBe(
          "42501",
        );
      }
    }
  });

  it("keeps authority cutover explicit and produces readback from the exact routed report set", async () => {
    const report = await service.rpc("record_admin_validation_report_v1", {
      p_reviewed_deployment_id: reviewedDeploymentId,
      p_runtime_contract_id: runtime.runtimeContractId,
      p_runtime_target_id: runtime.runtimeTargetId,
      p_observed_runtime_build_id: runtimeBuildId,
      p_observed_binding_manifest_revision: bindingRevision,
      p_observed_binding_manifest_sha256: bindingManifestSha256,
      p_observed_code_capability_sha256: capabilitySha256,
      p_endpoint_policy_valid: true,
      p_manifest_binding_valid: true,
      p_credential_configured: true,
      p_compiled_capability_valid: true,
    });
    expect(report.error).toBeNull();
    const reportId = (report.data as { reportId: string }).reportId;
    const claims = JSON.stringify({
      sub: adminUser.id,
      role: "authenticated",
      session_id: adminSessionId,
      iss: adminIssuer,
      is_anonymous: false,
    });
    const authoredPolicyKey = `admin.authored.${crypto.randomUUID()}`;
    const authored = runOwnerSql(String.raw`
      begin;
      update public.admin_environment set control_plane_mode='jwt_v1' where id=true;
      set local role authenticated;
      set local request.jwt.claims=${literal(claims)};
      select public.admin_create_routing_policy_v1(
        'local','local',${literal(authoredPolicyKey)},0,
        '{"schemaVersion":"routing_rules_v1","defaultRoute":{"profileVersionId":"${profileVersionId}","priceVersionId":"${priceVersionId}"},"windows":[]}'::jsonb,
        '${profileVersionId}','${INITIAL_LEGAL_BUNDLE_VERSION}',
        '${runtime.runtimeContractId}',array['${reportId}'::uuid],
        'local authored policy test','${crypto.randomUUID()}'
      );
      reset role;
      rollback;
    `).stdout;
    expect(authored).toContain(
      '"schemaVersion": "admin_committed_operation_v1"',
    );
    expect(authored).toContain(
      '"schemaVersion": "admin_routing_policy_result_v1"',
    );
    expect(authored).toContain(`"policyKey": "${authoredPolicyKey}"`);
    expect(authored).toContain(`"validationReportIds": ["${reportId}"]`);
    const policyId = crypto.randomUUID();
    const policyKey = `admin.cutover.${policyId}`;
    const output = runOwnerSql(String.raw`
      begin;
      set local session_replication_role=replica;
      insert into public.ai_routing_policy_versions(
        id,policy_key,version,status,timezone,rules,default_profile_version_id,
        legal_bundle_version,config_sha256,runtime_contract_id,
        validated_at,created_at
      ) values (
        '${policyId}', '${policyKey}', 1, 'canary', 'Asia/Shanghai',
        '{"schemaVersion":"routing_rules_v1","defaultRoute":{"profileVersionId":"${profileVersionId}","priceVersionId":"${priceVersionId}"},"windows":[]}'::jsonb,
        '${profileVersionId}', '${INITIAL_LEGAL_BUNDLE_VERSION}', '${"8".repeat(64)}',
        '${runtime.runtimeContractId}', clock_timestamp(), clock_timestamp()
      );
      update public.ai_feature_config set ai_polish_enabled=false,
        active_routing_policy_version_id='${policyId}' where id=true;
      set local session_replication_role=origin;

      select public.admin_admit_runtime_deployment_v2(
        '${reviewedDeploymentId}',jsonb_build_array(jsonb_build_object(
          'runtimeContractId','${runtime.runtimeContractId}',
          'runtimeTargetId','${runtime.runtimeTargetId}',
          'validationReportId','${reportId}'
        )),'local sealed runtime admission test'
      );
      do $tamper_body$
      begin
        begin
          create or replace function public.start_ai_polish_provider_attempt_v4(
          p_reservation_id uuid, p_attempt_no integer, p_runtime_admission jsonb
          ) returns jsonb language plpgsql security definer set search_path = '' as $stub$
          begin return jsonb_build_object('tampered', true); end;
          $stub$;
          perform public.admin_cutover_authority_v2(
            '${reviewedDeploymentId}',
            (select admission_id from public.admin_admitted_runtime_deployments_v2
              where reviewed_deployment_id='${reviewedDeploymentId}'),
            array['${reportId}'::uuid],0,0,'body tamper must rollback');
          raise exception 'body tamper unexpectedly accepted';
        exception when others then
          if sqlerrm not like '%CUTOVER_AUTHORITY_MISMATCH%' then raise; end if;
        end;
        if (select control_plane_mode from public.admin_environment where id=true) <> 'legacy'
           or (select closing_cycle_id from public.admin_ai_control_state_v1 where id=true) is not null
           or exists (select 1 from public.admin_runtime_authority_receipts_v2 where admission_id=(select admission_id from public.admin_admitted_runtime_deployments_v2 where reviewed_deployment_id='${reviewedDeploymentId}')) then
          raise exception 'body tamper rollback evidence failed';
        end if;
      end;
      $tamper_body$;
      do $tamper_grant$
      begin
        revoke execute on function public.get_ai_polish_execution_snapshot_v4(uuid,uuid,text,text,text,text,text) from service_role;
        begin
          perform public.admin_cutover_authority_v2(
            '${reviewedDeploymentId}',
            (select admission_id from public.admin_admitted_runtime_deployments_v2
              where reviewed_deployment_id='${reviewedDeploymentId}'),
            array['${reportId}'::uuid],0,0,'grant tamper must rollback');
          raise exception 'grant tamper unexpectedly accepted';
        exception when others then
          if sqlerrm not like '%CUTOVER_AUTHORITY_MISMATCH%' then raise; end if;
        end;
        if (select control_plane_mode from public.admin_environment where id=true) <> 'legacy'
           or (select closing_cycle_id from public.admin_ai_control_state_v1 where id=true) is not null
           or exists (select 1 from public.admin_runtime_authority_receipts_v2 where admission_id=(select admission_id from public.admin_admitted_runtime_deployments_v2 where reviewed_deployment_id='${reviewedDeploymentId}')) then
          raise exception 'grant tamper rollback evidence failed';
        end if;
        grant execute on function public.get_ai_polish_execution_snapshot_v4(uuid,uuid,text,text,text,text,text) to service_role;
      end;
      $tamper_grant$;
      do $tamper_readback_delegate$
      begin
        begin
          create or replace function public.record_admin_runtime_readback_v1(
            p_reviewed_deployment_id uuid,p_policy_version_id uuid,
            p_validation_report_ids uuid[],p_observed_runtime_build_id text,
            p_observed_binding_manifest_revision text,
            p_observed_binding_manifest_sha256 text
          ) returns jsonb language plpgsql security definer set search_path='' as $stub$
          begin return jsonb_build_object('tampered',true); end;
          $stub$;
          perform public.admin_cutover_authority_v2(
            '${reviewedDeploymentId}',(select admission_id
              from public.admin_admitted_runtime_deployments_v2
              where reviewed_deployment_id='${reviewedDeploymentId}'),
            array['${reportId}'::uuid],0,0,
            'readback delegate tamper must rollback');
          raise exception 'readback delegate tamper unexpectedly accepted';
        exception when others then
          if sqlerrm not like '%CUTOVER_AUTHORITY_MISMATCH%' then raise; end if;
        end;
        if (select control_plane_mode from public.admin_environment where id=true) <> 'legacy'
           or (select closing_cycle_id from public.admin_ai_control_state_v1 where id=true) is not null
           or not has_function_privilege('service_role',
             'public.start_ai_polish_provider_attempt(uuid,integer)','EXECUTE')
           or exists (select 1 from public.admin_runtime_authority_receipts_v2
             where admission_id=(select admission_id
               from public.admin_admitted_runtime_deployments_v2
               where reviewed_deployment_id='${reviewedDeploymentId}')) then
          raise exception 'readback delegate tamper rollback evidence failed';
        end if;
      end;
      $tamper_readback_delegate$;
      do $tamper_cutover_delegate$
      begin
        begin
          create or replace function public.admin_cutover_authority_legacy_internal_v1(
            p_reviewed_deployment_id uuid,p_validation_report_ids uuid[],
            p_expected_environment_revision bigint,
            p_expected_control_revision bigint,p_reason text
          ) returns jsonb language plpgsql security definer set search_path='' as $stub$
          begin
            return jsonb_build_object('activePolicyVersionId',(
              select active_routing_policy_version_id
              from public.ai_feature_config where id=true));
          end;
          $stub$;
          perform public.admin_cutover_authority_v2(
            '${reviewedDeploymentId}',(select admission_id
              from public.admin_admitted_runtime_deployments_v2
              where reviewed_deployment_id='${reviewedDeploymentId}'),
            array['${reportId}'::uuid],0,0,
            'cutover delegate tamper must rollback');
          raise exception 'cutover delegate tamper unexpectedly accepted';
        exception when others then
          if sqlerrm not like '%CUTOVER_AUTHORITY_MISMATCH%' then raise; end if;
        end;
        if (select control_plane_mode from public.admin_environment where id=true) <> 'legacy'
           or (select closing_cycle_id from public.admin_ai_control_state_v1 where id=true) is not null
           or not has_function_privilege('service_role',
             'public.start_ai_polish_provider_attempt(uuid,integer)','EXECUTE')
           or exists (select 1 from public.admin_runtime_authority_receipts_v2
             where admission_id=(select admission_id
               from public.admin_admitted_runtime_deployments_v2
               where reviewed_deployment_id='${reviewedDeploymentId}')) then
          raise exception 'cutover delegate tamper rollback evidence failed';
        end if;
      end;
      $tamper_cutover_delegate$;
      do $tamper_start_core$
      begin
        begin
          create or replace function public.start_ai_polish_provider_attempt_internal(
            p_reservation_id uuid,p_attempt_no integer
          ) returns jsonb language plpgsql security definer set search_path='' as $stub$
          begin return jsonb_build_object('tampered',true); end;
          $stub$;
          perform public.admin_cutover_authority_v2(
            '${reviewedDeploymentId}',(select admission_id
              from public.admin_admitted_runtime_deployments_v2
              where reviewed_deployment_id='${reviewedDeploymentId}'),
            array['${reportId}'::uuid],0,0,
            'start core tamper must rollback');
          raise exception 'start core tamper unexpectedly accepted';
        exception when others then
          if sqlerrm not like '%CUTOVER_AUTHORITY_MISMATCH%' then raise; end if;
        end;
        if (select control_plane_mode from public.admin_environment where id=true) <> 'legacy'
           or (select closing_cycle_id from public.admin_ai_control_state_v1 where id=true) is not null
           or not has_function_privilege('service_role',
             'public.start_ai_polish_provider_attempt(uuid,integer)','EXECUTE')
           or exists (select 1 from public.admin_runtime_authority_receipts_v2
             where admission_id=(select admission_id
               from public.admin_admitted_runtime_deployments_v2
               where reviewed_deployment_id='${reviewedDeploymentId}')) then
          raise exception 'start core tamper rollback evidence failed';
        end if;
      end;
      $tamper_start_core$;
      do $tamper_report_validator$
      begin
        begin
          create or replace function public.admin_assert_policy_validation_reports_v2(
            p_policy_version_id uuid,p_validation_report_ids uuid[],
            p_at timestamptz
          ) returns jsonb language plpgsql security definer set search_path='' as $stub$
          begin
            return public.admin_assert_policy_validation_reports_legacy_internal_v1(
              p_policy_version_id,p_validation_report_ids,p_at);
          end;
          $stub$;
          perform public.admin_cutover_authority_v2(
            '${reviewedDeploymentId}',(select admission_id
              from public.admin_admitted_runtime_deployments_v2
              where reviewed_deployment_id='${reviewedDeploymentId}'),
            array['${reportId}'::uuid],0,0,
            'report validator tamper must rollback');
          raise exception 'report validator tamper unexpectedly accepted';
        exception when others then
          if sqlerrm not like '%CUTOVER_AUTHORITY_MISMATCH%' then raise; end if;
        end;
        if (select control_plane_mode from public.admin_environment where id=true) <> 'legacy'
           or (select closing_cycle_id from public.admin_ai_control_state_v1 where id=true) is not null
           or not has_function_privilege('service_role',
             'public.start_ai_polish_provider_attempt(uuid,integer)','EXECUTE')
           or exists (select 1 from public.admin_runtime_authority_receipts_v2
             where admission_id=(select admission_id
               from public.admin_admitted_runtime_deployments_v2
               where reviewed_deployment_id='${reviewedDeploymentId}')) then
          raise exception 'report validator tamper rollback evidence failed';
        end if;
      end;
      $tamper_report_validator$;
      set local session_replication_role=replica;
      update public.admin_validation_reports_v1 set
        checked_at=statement_timestamp()-interval '12 minutes',
        expires_at=statement_timestamp()-interval '3 minutes'
        where id='${reportId}';
      set local session_replication_role=origin;
      set local role service_role;
      set local request.jwt.claims='{"role":"service_role"}';
      select (public.record_admin_validation_report_v1(
        '${reviewedDeploymentId}','${runtime.runtimeContractId}','${runtime.runtimeTargetId}',
        '${runtimeBuildId}','${bindingRevision}','${bindingManifestSha256}','${capabilitySha256}',
        true,true,true,true)->>'reportId') as fresh_report_id \gset fresh_
      reset role;
      select public.admin_cutover_authority_v2(
        '${reviewedDeploymentId}',(
          select admission_id from public.admin_admitted_runtime_deployments_v2
          where reviewed_deployment_id='${reviewedDeploymentId}'
        ),array[:'fresh_fresh_report_id'::uuid],0,0,
        'local transactional authority cutover test'
      );
      select jsonb_build_object(
        'mode',(select control_plane_mode from public.admin_environment where id=true),
        'cycle',(select closing_cycle_id is not null from public.admin_ai_control_state_v1 where id=true),
        'oldPointerRpc',has_function_privilege('service_role',
          'public.set_ai_routing_policy_pointer_v1(uuid,text,text,text,text,text,timestamptz,text)','EXECUTE'),
        'directGate',has_column_privilege('service_role','public.ai_feature_config','ai_polish_enabled','UPDATE'),
        'dataPlaneProfileLock',has_column_privilege('service_role','public.ai_provider_profile_versions','display_disclosure_key','UPDATE'),
        'dataPlanePriceLock',has_column_privilege('service_role','public.ai_price_versions','components_sealed_at','UPDATE'),
        'legacyStart',has_function_privilege('service_role',
          'public.start_ai_polish_provider_attempt(uuid,integer)','EXECUTE'),
        'legacySnapshot',has_function_privilege('service_role',
          'public.get_ai_polish_execution_snapshot_v1(uuid,uuid)','EXECUTE'),
        'legacySnapshotV3',has_function_privilege('service_role',
          'public.get_ai_polish_execution_snapshot_v3(uuid,uuid)','EXECUTE'),
        'legacyStartV3',has_function_privilege('service_role',
          'public.start_ai_polish_provider_attempt_v3(uuid,integer,uuid,uuid,uuid,text,text,text,text,text,bigint,text,text,text,text)','EXECUTE'),
        'successorStart',has_function_privilege('service_role',
          'public.start_ai_polish_provider_attempt_v4(uuid,integer,jsonb)','EXECUTE'),
        'successorSnapshot',has_function_privilege('service_role',
          'public.get_ai_polish_execution_snapshot_v4(uuid,uuid,text,text,text,text,text)','EXECUTE'),
        'successorReadback',has_function_privilege('service_role',
          'public.record_admin_runtime_readback_v2(uuid,uuid,bigint,text,uuid,uuid[],text,text,text)','EXECUTE'),
        'authorityReceipt',exists(
          select 1 from public.admin_runtime_authority_receipts_v2 receipt
          where receipt.admission_id=(
            select admission_id from public.admin_admitted_runtime_deployments_v2
            where reviewed_deployment_id='${reviewedDeploymentId}'
          ) and receipt.authority_manifest_sha256 ~ '^[0-9a-f]{64}$'
        )
      );
      select admission_id,admission_revision,target_set_sha256
      from public.admin_admitted_runtime_deployments_v2
      where reviewed_deployment_id='${reviewedDeploymentId}'
      \gset admission_
      set local role service_role;
      set local request.jwt.claims='{"role":"service_role"}';
      select public.record_admin_runtime_readback_v2(
        '${reviewedDeploymentId}', :'admission_admission_id'::uuid,
        :admission_admission_revision::bigint, :'admission_target_set_sha256',
         '${policyId}',array[:'fresh_fresh_report_id'::uuid],
        '${runtimeBuildId}','${bindingRevision}','${bindingManifestSha256}'
      );
      reset role;
      select jsonb_build_object('freshReadback',exists(
        select 1 from public.admin_runtime_readback_reports_v1
        where admission_id=:'admission_admission_id'::uuid
          and validation_report_ids=array[:'fresh_fresh_report_id'::uuid]
          and not ('${reportId}'::uuid=any(validation_report_ids))
      ));
      rollback;
    `).stdout;
    expect(output).toContain('"schemaVersion": "admin_authority_cutover_v2"');
    expect(output).toContain('"mode": "jwt_v1"');
    expect(output).toContain('"cycle": true');
    expect(output).toContain('"oldPointerRpc": false');
    expect(output).toContain('"directGate": false');
    expect(output).toContain('"dataPlaneProfileLock": true');
    expect(output).toContain('"dataPlanePriceLock": true');
    expect(output).toContain('"legacyStart": false');
    expect(output).toContain('"legacySnapshot": false');
    expect(output).toContain('"legacySnapshotV3": false');
    expect(output).toContain('"legacyStartV3": false');
    expect(output).toContain('"successorStart": true');
    expect(output).toContain('"successorSnapshot": true');
    expect(output).toContain('"successorReadback": true');
    expect(output).toContain('"authorityReceipt": true');
    expect(output).toContain('"schemaVersion": "admin_runtime_readback_v2"');
    expect(output).toContain('"targetSetSha256"');
    expect(output).toContain(`"policyVersionId": "${policyId}"`);
    expect(output).toContain('"freshReadback": true');
  });

  it("requires one fresh report per route through cutover, readback, and reopen", async () => {
    const suffix = crypto.randomUUID();
    const secondProfileId = crypto.randomUUID();
    const secondProfileVersionId = crypto.randomUUID();
    const secondPriceVersionId = crypto.randomUUID();
    const policyId = crypto.randomUUID();
    const secondProfileKey = `test.admin.validation.second.${suffix}`;
    const secondDisplayKey = `test-display.${suffix.replaceAll("-", "")}`;
    const runtimeSet = authorSyntheticRuntimeContractSet([
      {
        profileKey: "deepseek.official.deepseek-v4-flash.chat.v1",
        legalManifestId: DEEPSEEK_LEGAL_MANIFEST_ID,
        manifestSha256: DEEPSEEK_LEGAL_MANIFEST_SHA256,
      },
      {
        profileKey: secondProfileKey,
        legalManifestId: DEEPSEEK_LEGAL_MANIFEST_ID,
        manifestSha256: DEEPSEEK_LEGAL_MANIFEST_SHA256,
      },
    ]);
    const [routeA, routeB] = runtimeSet.targets;

    runOwnerSql(String.raw`
      begin;
      set local session_replication_role=replica;
      insert into public.ai_provider_profiles
      select (jsonb_populate_record(
        null::public.ai_provider_profiles,
        to_jsonb(source) || jsonb_build_object(
          'id','${secondProfileId}','profile_key','${secondProfileKey}',
          'display_name','Second validation route','created_at',clock_timestamp()
        )
      )).* from public.ai_provider_profiles source
      where source.profile_key='deepseek.official.deepseek-v4-flash.chat.v1';

      insert into public.ai_provider_profile_versions
      select (jsonb_populate_record(
        null::public.ai_provider_profile_versions,
        to_jsonb(source) || jsonb_build_object(
          'id','${secondProfileVersionId}','profile_id','${secondProfileId}',
          'version',1,'display_disclosure_key','${secondDisplayKey}',
          'created_at',clock_timestamp(),'validated_at',clock_timestamp(),
          'activated_at',null,'retired_at',null
        )
      )).* from public.ai_provider_profile_versions source
      where source.id='${profileVersionId}';

      insert into public.ai_price_versions
      select (jsonb_populate_record(
        null::public.ai_price_versions,
        to_jsonb(source) || jsonb_build_object(
          'id','${secondPriceVersionId}',
          'profile_version_id','${secondProfileVersionId}',
          'version',1,'components_sealed_at',clock_timestamp()
        )
      )).* from public.ai_price_versions source
      where source.id='${priceVersionId}';
      insert into public.ai_price_components(price_version_id,component,nanos_per_million)
      select '${secondPriceVersionId}',component,nanos_per_million
      from public.ai_price_components where price_version_id='${priceVersionId}';

      insert into public.ai_legal_display_versions_v2
      select (jsonb_populate_record(
        null::public.ai_legal_display_versions_v2,
        to_jsonb(source) || jsonb_build_object(
          'display_disclosure_key','${secondDisplayKey}',
          'created_at',clock_timestamp(),'sealed_at',clock_timestamp()
        )
      )).* from public.ai_legal_display_versions_v2 source
      where source.display_disclosure_key='${displayKey}'
        and source.legal_bundle_version='${INITIAL_LEGAL_BUNDLE_VERSION}';

      insert into public.ai_runtime_target_bindings_v2(
        runtime_contract_id,runtime_target_id,runtime_target_sha256,
        route_descriptor_id,route_descriptor_sha256,profile_version_id,
        price_version_id,provider_id,recipient_key,code_capability_id,
        code_capability_sha256,gateway_kind,adapter_kind,wire_api_kind,
        endpoint_url,credential_env_name,model_id,capability_contract_id,
        cache_policy_id,calculator_kind,legal_bundle_version,legal_manifest_id,
        legal_manifest_sha256,display_disclosure_key,external_evidence_ids
      )
      select membership.runtime_contract_id,membership.runtime_target_id,
        membership.runtime_target_sha256,membership.route_descriptor_id,
        membership.route_descriptor_sha256,version.id,price.id,provider.id,
        provider.recipient_key,capability.code_capability_id,
        capability.descriptor_sha256,profile.gateway_kind,version.adapter_kind,
        version.wire_api_kind,version.endpoint_url,version.credential_env_name,
        version.model_id,version.capability_contract_id,version.cache_policy_id,
        price.calculator_kind,'${INITIAL_LEGAL_BUNDLE_VERSION}',
        membership.legal_manifest_id,membership.manifest_sha256,
        version.display_disclosure_key,array['evidence.synthetic-two-route']
      from public.ai_service_runtime_contract_targets membership
      join public.ai_provider_profiles profile
        on profile.profile_key=membership.profile_key
      join public.ai_provider_profile_versions version on version.id=case
        when membership.profile_key='${secondProfileKey}'
          then '${secondProfileVersionId}'::uuid
        else '${profileVersionId}'::uuid end
      join public.ai_price_versions price on price.id=case
        when membership.profile_key='${secondProfileKey}'
          then '${secondPriceVersionId}'::uuid
        else '${priceVersionId}'::uuid end
      join public.ai_providers provider on provider.id=profile.provider_id
      join public.ai_runtime_code_capabilities_v2 capability
        on capability.code_capability_id='${capabilityId}'
      where membership.runtime_contract_id='${runtimeSet.runtimeContractId}';
      commit;
    `);

    const validationArgs = (runtimeTargetId: string) => ({
      p_reviewed_deployment_id: reviewedDeploymentId,
      p_runtime_contract_id: runtimeSet.runtimeContractId,
      p_runtime_target_id: runtimeTargetId,
      p_observed_runtime_build_id: runtimeBuildId,
      p_observed_binding_manifest_revision: bindingRevision,
      p_observed_binding_manifest_sha256: bindingManifestSha256,
      p_observed_code_capability_sha256: capabilitySha256,
      p_endpoint_policy_valid: true,
      p_manifest_binding_valid: true,
      p_credential_configured: true,
      p_compiled_capability_valid: true,
    });
    const reportA1 = await service.rpc(
      "record_admin_validation_report_v1",
      validationArgs(routeA.runtimeTargetId),
    );
    const reportA2 = await service.rpc(
      "record_admin_validation_report_v1",
      validationArgs(routeA.runtimeTargetId),
    );
    const reportB1 = await service.rpc(
      "record_admin_validation_report_v1",
      validationArgs(routeB.runtimeTargetId),
    );
    for (const report of [reportA1, reportA2, reportB1]) {
      expect(report.error).toBeNull();
      expect(report.data?.passed).toBe(true);
    }
    const reportA1Id = (reportA1.data as { reportId: string }).reportId;
    const reportA2Id = (reportA2.data as { reportId: string }).reportId;
    const reportB1Id = (reportB1.data as { reportId: string }).reportId;

    const enrolled = await admin.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `two-route-${suffix}`,
    });
    expect(enrolled.error).toBeNull();
    if (!enrolled.data?.id || !enrolled.data.totp?.secret) {
      throw new Error("local TOTP enrollment returned no factor");
    }
    const verified = await admin.auth.mfa.challengeAndVerify({
      factorId: enrolled.data.id,
      code: totpCode(enrolled.data.totp.secret),
    });
    expect(verified.error).toBeNull();
    if (!verified.data?.access_token) {
      throw new Error("local TOTP verification returned no token");
    }
    const claims = Buffer.from(
      verified.data.access_token.split(".")[1],
      "base64url",
    ).toString();
    const rules = JSON.stringify({
      schemaVersion: "routing_rules_v1",
      defaultRoute: {
        profileVersionId,
        priceVersionId,
      },
      windows: [
        {
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          startMinute: 0,
          endMinute: 1,
          route: {
            profileVersionId: secondProfileVersionId,
            priceVersionId: secondPriceVersionId,
          },
        },
      ],
    });

    const output = runOwnerSql(String.raw`
      begin;
      set local session_replication_role=replica;
      insert into public.ai_routing_policy_versions(
        id,policy_key,version,status,timezone,rules,default_profile_version_id,
        legal_bundle_version,config_sha256,runtime_contract_id,
        validated_at,created_at
      ) values (
        '${policyId}','test.admin.validation.multiroute.${suffix}',1,'canary',
        'Asia/Shanghai',${literal(rules)}::jsonb,'${profileVersionId}',
        '${INITIAL_LEGAL_BUNDLE_VERSION}','${"9".repeat(64)}',
        '${runtimeSet.runtimeContractId}',clock_timestamp(),clock_timestamp()
      );
      update public.ai_feature_config set ai_polish_enabled=false,
        active_routing_policy_version_id='${policyId}' where id=true;
      set local session_replication_role=origin;

      select public.admin_admit_runtime_deployment_v2(
        '${reviewedDeploymentId}',jsonb_build_array(
          jsonb_build_object(
            'runtimeContractId','${runtimeSet.runtimeContractId}',
            'runtimeTargetId','${routeA.runtimeTargetId}',
            'validationReportId','${reportA1Id}'
          ),
          jsonb_build_object(
            'runtimeContractId','${runtimeSet.runtimeContractId}',
            'runtimeTargetId','${routeB.runtimeTargetId}',
            'validationReportId','${reportB1Id}'
          )
        ),'two-route admission proof'
      );
      select admission_id,admission_revision,target_set_sha256
      from public.admin_admitted_runtime_deployments_v2
      where reviewed_deployment_id='${reviewedDeploymentId}'
      order by admitted_at desc limit 1 \gset multi_admission_

      do $duplicate_route$
      begin
        begin
          perform public.admin_cutover_authority_v2(
            '${reviewedDeploymentId}',(
              select admission_id
              from public.admin_admitted_runtime_deployments_v2
              where reviewed_deployment_id='${reviewedDeploymentId}'
              order by admitted_at desc limit 1
            ),
            array['${reportA1Id}'::uuid,'${reportA2Id}'::uuid],0,0,
            'duplicate route reports must fail'
          );
          raise exception 'duplicate route reports unexpectedly accepted';
        exception when others then
          if sqlerrm <> 'VALIDATION_REPORT_ROUTE_BIJECTION_MISMATCH' then
            raise;
          end if;
        end;
        if (select control_plane_mode from public.admin_environment where id=true) <> 'legacy'
           or (select closing_cycle_id from public.admin_ai_control_state_v1 where id=true) is not null
           or exists (select 1 from public.admin_runtime_authority_receipts_v2
             where admission_id=(select admission_id
               from public.admin_admitted_runtime_deployments_v2
               where reviewed_deployment_id='${reviewedDeploymentId}'
               order by admitted_at desc limit 1)) then
          raise exception 'duplicate route cutover was not atomic';
        end if;
      end;
      $duplicate_route$;

      select public.admin_cutover_authority_v2(
        '${reviewedDeploymentId}',:'multi_admission_admission_id'::uuid,
        array['${reportA1Id}'::uuid,'${reportB1Id}'::uuid],0,0,
        'two-route cutover proof'
      );
      set local role service_role;
      set local request.jwt.claims='{"role":"service_role"}';
      select (public.record_admin_runtime_readback_v2(
        '${reviewedDeploymentId}',:'multi_admission_admission_id'::uuid,
        :'multi_admission_admission_revision'::bigint,
        :'multi_admission_target_set_sha256','${policyId}',
        array['${reportA1Id}'::uuid,'${reportB1Id}'::uuid],
        '${runtimeBuildId}','${bindingRevision}','${bindingManifestSha256}'
      )->>'reportId') as report_id \gset multi_readback_
      reset role;
      select control.closing_cycle_id,control.revision,
        config.config_generation
      from public.admin_ai_control_state_v1 control
      cross join public.ai_feature_config config
      where control.id=true and config.id=true \gset multi_control_
      set local role authenticated;
      set local request.jwt.claims=${literal(claims)};
      select public.admin_reopen_ai_v1(
        'local','local',:'multi_readback_report_id'::uuid,
        :'multi_control_closing_cycle_id'::uuid,
        :'multi_control_revision'::bigint,'${policyId}',
        :'multi_control_config_generation'::bigint,
        'two-route reopen proof','${crypto.randomUUID()}'
      );
      reset role;
      select jsonb_build_object(
        'routeCount',jsonb_array_length((select effective_routes
          from public.admin_runtime_readback_reports_v1
          where id=:'multi_readback_report_id'::uuid)),
        'reportCount',cardinality((select validation_report_ids
          from public.admin_runtime_readback_reports_v1
          where id=:'multi_readback_report_id'::uuid)),
        'enabled',(select ai_polish_enabled from public.ai_feature_config where id=true)
      );
      rollback;
    `).stdout;
    expect(output).toContain('"schemaVersion": "admin_authority_cutover_v2"');
    expect(output).toContain('"readbackReportId":');
    expect(output).toContain('"operationKind": "ai_reopen"');
    expect(output).toContain('"routeCount": 2');
    expect(output).toContain('"reportCount": 2');
    expect(output).toContain('"enabled": true');
  });
});
