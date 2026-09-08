import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  acceptAiLegalBundle,
  createTestUser,
  signInAsUser,
  type TestUser,
} from "./helpers";
import {
  DEEPSEEK_LEGAL_MANIFEST_ID,
  DEEPSEEK_LEGAL_MANIFEST_SHA256,
  INITIAL_LEGAL_BUNDLE_SHA256,
  INITIAL_LEGAL_BUNDLE_VERSION,
  runOwnerSql,
} from "./runtime-contract-fixtures";

const DEEPSEEK_PROVIDER_ID = "706513a5-462b-4bba-93b0-53e50661416e";
const DEEPSEEK_CAPABILITY_ID =
  "runtime-capability.deepseek-chat-v1.2026-09-04";
const DEEPSEEK_CAPABILITY_SHA256 =
  "4e5a92750f77f148e6422dcf05b03d99333b357879dba5fdb7248d16dd08bdf2";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * A sealed V2 configuration target assembled through the normal table guards.
 *
 * This deliberately creates no reviewed deployment, admission, or runtime
 * build/manifest evidence. It is a database fixture, so it uses the local
 * owner connection for protected catalog inserts, but never disables a trigger
 * or replication role. Later tests own lifecycle publication and users.
 */
export interface ConfigSimplificationV2Fixture {
  readonly profileId: string;
  readonly profileKey: string;
  readonly profileVersionId: string;
  readonly priceVersionId: string;
  readonly runtimeContractId: string;
  readonly runtimeTargetId: string;
  readonly runtimeTargetSha256: string;
  readonly routeDescriptorId: string;
  readonly routeDescriptorSha256: string;
  readonly endpointUrl: "https://api.deepseek.com/chat/completions";
  readonly credentialEnvName: "AI_PROVIDER_KEY_DEEPSEEK_PRIMARY";
  readonly modelId: "deepseek-v4-flash";
  readonly displayDisclosureKey: string;
  readonly legalBundleVersion: string;
  readonly bundleContractSha256: string;
  readonly legalManifestId: typeof DEEPSEEK_LEGAL_MANIFEST_ID;
  readonly codeCapabilityId: typeof DEEPSEEK_CAPABILITY_ID;
  readonly codeCapabilitySha256: typeof DEEPSEEK_CAPABILITY_SHA256;
}

export interface ConfigSimplificationV2FixtureOptions {
  /**
   * Leave the price and contract unsealed, with no target binding. This is the
   * only valid precondition for exercising admin_seal_price_for_activation_v2.
   */
  readonly prepareOnly?: boolean;
  /** A sealed successor bundle may be prepared while the old bundle is live. */
  readonly legalBundleVersion?: string;
  readonly bundleContractSha256?: string;
}

export function createConfigSimplificationV2Fixture(
  options: ConfigSimplificationV2FixtureOptions = {},
): ConfigSimplificationV2Fixture {
  const suffix = crypto.randomUUID();
  const profileId = crypto.randomUUID();
  const profileVersionId = crypto.randomUUID();
  const priceVersionId = crypto.randomUUID();
  const profileKey = `test.config-simplification.deepseek.${suffix}`;
  const runtimeContractId = `test-config-runtime.${suffix}`;
  const runtimeTargetId = `test-config-target.${suffix}`;
  const runtimeTargetSha256 = sha256(runtimeTargetId);
  const routeDescriptorId = `test-config-route.${suffix}`;
  const routeDescriptorSha256 = sha256(routeDescriptorId);
  const targetSetSha256 = sha256(
    `${Buffer.byteLength(runtimeTargetId, "utf8")}:${runtimeTargetId}:${runtimeTargetSha256}`,
  );
  const displayDisclosureKey = `test.config-display.${suffix}`;
  const legalBundleVersion =
    options.legalBundleVersion ?? INITIAL_LEGAL_BUNDLE_VERSION;
  const bundleContractSha256 =
    options.bundleContractSha256 ?? INITIAL_LEGAL_BUNDLE_SHA256;
  const fixture: ConfigSimplificationV2Fixture = {
    profileId,
    profileKey,
    profileVersionId,
    priceVersionId,
    runtimeContractId,
    runtimeTargetId,
    runtimeTargetSha256,
    routeDescriptorId,
    routeDescriptorSha256,
    endpointUrl: "https://api.deepseek.com/chat/completions",
    credentialEnvName: "AI_PROVIDER_KEY_DEEPSEEK_PRIMARY",
    modelId: "deepseek-v4-flash",
    displayDisclosureKey,
    legalBundleVersion,
    bundleContractSha256,
    legalManifestId: DEEPSEEK_LEGAL_MANIFEST_ID,
    codeCapabilityId: DEEPSEEK_CAPABILITY_ID,
    codeCapabilitySha256: DEEPSEEK_CAPABILITY_SHA256,
  };
  const completion = options.prepareOnly
    ? ""
    : String.raw`
    select public.seal_ai_price_components_v1(
      array['${fixture.priceVersionId}'::uuid],clock_timestamp()
    );
    insert into public.ai_runtime_target_bindings_v2(
      runtime_contract_id,runtime_target_id,runtime_target_sha256,
      route_descriptor_id,route_descriptor_sha256,profile_version_id,price_version_id,
      provider_id,recipient_key,code_capability_id,code_capability_sha256,
      gateway_kind,adapter_kind,wire_api_kind,endpoint_url,credential_env_name,
      model_id,capability_contract_id,cache_policy_id,calculator_kind,
      legal_bundle_version,legal_manifest_id,legal_manifest_sha256,
      display_disclosure_key,external_evidence_ids
    ) values (
      '${fixture.runtimeContractId}','${fixture.runtimeTargetId}',
      '${fixture.runtimeTargetSha256}','${fixture.routeDescriptorId}',
      '${fixture.routeDescriptorSha256}','${fixture.profileVersionId}',
      '${fixture.priceVersionId}','${DEEPSEEK_PROVIDER_ID}','deepseek',
      '${fixture.codeCapabilityId}','${fixture.codeCapabilitySha256}',
      'direct_deepseek','deepseek_chat_v1','chat_completions_v1',
      '${fixture.endpointUrl}','${fixture.credentialEnvName}','${fixture.modelId}',
      'deepseek_chat_json_object_v1','deepseek_automatic_context_cache_v1',
      'linear_token_v1','${fixture.legalBundleVersion}','${fixture.legalManifestId}',
      '${DEEPSEEK_LEGAL_MANIFEST_SHA256}','${fixture.displayDisclosureKey}',
      array['evidence.config-simplification']
    );
    update public.ai_service_runtime_contract_versions
      set sealed_at=clock_timestamp()
      where runtime_contract_id='${fixture.runtimeContractId}';
  `;

  const result = runOwnerSql(String.raw`
    begin;
    insert into public.ai_provider_profiles(
      id,profile_key,display_name,gateway_kind,model_vendor,provider_id
    ) values (
      '${fixture.profileId}','${fixture.profileKey}','Config simplification DeepSeek fixture',
      'direct_deepseek','deepseek','${DEEPSEEK_PROVIDER_ID}'
    );
    insert into public.ai_provider_profile_versions(
      id,profile_id,version,status,adapter_kind,wire_api_kind,
      credential_alias,endpoint_alias,endpoint_url,credential_env_name,
      model_id,upstream_route,capability_contract_id,cache_policy_id,
      legal_manifest_id,display_disclosure_key,config,config_sha256,
      execution_schema_version
    ) values (
      '${fixture.profileVersionId}','${fixture.profileId}',1,'draft',
      'deepseek_chat_v1','chat_completions_v1',null,null,
      '${fixture.endpointUrl}','${fixture.credentialEnvName}','${fixture.modelId}',
      '{}'::jsonb,'deepseek_chat_json_object_v1',
      'deepseek_automatic_context_cache_v1','${fixture.legalManifestId}',
      '${fixture.displayDisclosureKey}',
      '{"thinking":"disabled","structuredOutput":"json_object","providerSubjectField":"user_id"}'::jsonb,
      '${"4".repeat(64)}','profile_execution_config_v2'
    );
    insert into public.ai_price_versions(
      id,profile_version_id,pricing_lane,version,currency,calculator_kind,
      valid_from,source_url,source_checked_at,source_snapshot_sha256,parameters
    ) values (
      '${fixture.priceVersionId}','${fixture.profileVersionId}','default',1,
      'CNY','linear_token_v1',clock_timestamp()-interval '1 hour',
      'https://example.com/config-simplification-price',clock_timestamp(),
      '${"5".repeat(64)}','{}'::jsonb
    );
    insert into public.ai_price_components(price_version_id,component,nanos_per_million)
    values ('${fixture.priceVersionId}','input_standard',1),
           ('${fixture.priceVersionId}','input_cache_read',1),
           ('${fixture.priceVersionId}','output',1);

    with content(value) as (values (jsonb_build_object(
      'schemaVersion','legal_display_content_v2',
      'en',jsonb_build_object('providerLabel','DeepSeek','modelLabel','deepseek-v4-flash',
        'blocks',jsonb_build_array(jsonb_build_object('kind','paragraph','text','Local configuration fixture.'))),
      'zh',jsonb_build_object('providerLabel','DeepSeek','modelLabel','deepseek-v4-flash',
        'blocks',jsonb_build_array(jsonb_build_object('kind','paragraph','text','本地配置测试。')))
    )))
    insert into public.ai_legal_display_versions_v2(
      display_disclosure_key,legal_bundle_version,legal_manifest_id,
      provider_id,recipient_key,model_id,content,content_sha256,fact_ids,evidence_ids
    )
    select '${fixture.displayDisclosureKey}','${fixture.legalBundleVersion}',
      '${fixture.legalManifestId}','${DEEPSEEK_PROVIDER_ID}','deepseek',
      '${fixture.modelId}',content.value,
      encode(extensions.digest(convert_to(content.value::text,'UTF8'),'sha256'),'hex'),
      array['fact.config-simplification'],array['evidence.config-simplification']
    from content;
    update public.ai_legal_display_versions_v2 set sealed_at=clock_timestamp()
      where display_disclosure_key='${fixture.displayDisclosureKey}';

    insert into public.ai_service_runtime_target_versions(
      runtime_target_id,runtime_target_sha256,profile_key,legal_manifest_id,
      manifest_sha256,route_descriptor_id,route_descriptor_sha256
    ) values (
      '${fixture.runtimeTargetId}','${fixture.runtimeTargetSha256}',
      '${fixture.profileKey}','${fixture.legalManifestId}',
      '${DEEPSEEK_LEGAL_MANIFEST_SHA256}','${fixture.routeDescriptorId}',
      '${fixture.routeDescriptorSha256}'
    );
    insert into public.ai_service_runtime_contract_versions(
      runtime_contract_id,legal_bundle_version,bundle_contract_sha256,runtime_target_set_sha256
    ) values (
      '${fixture.runtimeContractId}','${fixture.legalBundleVersion}',
      '${fixture.bundleContractSha256}','${targetSetSha256}'
    );
    insert into public.ai_service_runtime_contract_targets(
      runtime_contract_id,runtime_target_id,runtime_target_sha256,profile_key,
      legal_manifest_id,manifest_sha256,route_descriptor_id,route_descriptor_sha256
    ) values (
      '${fixture.runtimeContractId}','${fixture.runtimeTargetId}',
      '${fixture.runtimeTargetSha256}','${fixture.profileKey}','${fixture.legalManifestId}',
      '${DEEPSEEK_LEGAL_MANIFEST_SHA256}','${fixture.routeDescriptorId}',
      '${fixture.routeDescriptorSha256}'
    );
    ${completion}
    commit;
  `);
  if (result.status !== 0) {
    throw new Error(`config simplification V2 fixture failed: ${result.stderr || result.stdout}`);
  }
  return Object.freeze(fixture);
}

export async function createConfigSimplificationUser(
  service: SupabaseClient,
  fixture: ConfigSimplificationV2Fixture,
): Promise<TestUser> {
  const user = await createTestUser(service, "config-simplification-v2");
  await acceptAiLegalBundle(service, user.id, fixture.legalBundleVersion);
  const display = await service.rpc("get_ai_legal_display_v2", {
    p_legal_bundle_version: fixture.legalBundleVersion,
    p_display_disclosure_key: fixture.displayDisclosureKey,
  });
  if (display.error || !display.data?.contentSha256) {
    throw new Error(
      `config simplification legal display failed: ${display.error?.message ?? "missing content hash"}`,
    );
  }
  const authenticated = await signInAsUser(user);
  const accepted = await authenticated.rpc("accept_ai_legal_disclosure_v2", {
    p_expected_user_id: user.id,
    p_legal_bundle_version: fixture.legalBundleVersion,
    p_display_disclosure_key: fixture.displayDisclosureKey,
    p_content_sha256: display.data.contentSha256,
  });
  if (accepted.error) {
    throw new Error(
      `config simplification legal disclosure acceptance failed: ${accepted.error.message}`,
    );
  }
  return user;
}
