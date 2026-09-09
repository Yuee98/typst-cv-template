import type { AdminValidationCandidate } from "./validation-service";
import { COMPILED_RUNTIME_CODE_CAPABILITIES_V2 } from "../polish/runtime-code-capability-v2";
const providerId = "11111111-1111-4111-8111-111111111111";
const profileVersionId = "22222222-2222-4222-8222-222222222222";
const priceVersionId = "33333333-3333-4333-8333-333333333333";
const capability = COMPILED_RUNTIME_CODE_CAPABILITIES_V2[0];
export const environment = {
 ADMIN_ENVIRONMENT: "local", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "local-test-public",
 AI_PROVIDER_KEY_DEEPSEEK_PRIMARY: "secret-value",
};
export const candidate: AdminValidationCandidate = {
  schemaVersion: "admin_config_validation_candidate_v3",
  environment: "local",
  profileExecutionConfig: {
    schemaVersion: "profile_execution_config_v2",
    profileKey: "profile.deepseek",
    providerId,
    gatewayKind: "direct_deepseek",
    adapterKind: "deepseek_chat_v1",
    wireApiKind: "chat_completions_v1",
    endpointUrl: "https://api.deepseek.com/chat/completions",
    credentialEnvName: "AI_PROVIDER_KEY_DEEPSEEK_PRIMARY",
    modelId: "deepseek-chat",
    capabilityContractId: capability.capabilityContractId,
    cachePolicyId: capability.cachePolicyId,
    legalManifestId: "deepseek-official-2026-08-23-v1",
    calculatorKind: "linear_token_v1",
    displayDisclosureKey: "deepseek-official-v1",
    config: {
      thinking: "disabled",
      structuredOutput: "json_object",
      providerSubjectField: "user_id",
    },
  },
  runtimeTarget: {
    runtimeContractId: "runtime.deepseek-v2.v1",
    runtimeTargetId: "runtime-target.deepseek.v1",
    runtimeTargetSha256: "a".repeat(64),
    profileVersionId,
    priceVersionId,
    providerId,
    recipientKey: "deepseek",
    codeCapabilityId: capability.codeCapabilityId,
    codeCapabilitySha256: capability.descriptorSha256,
    legalBundleVersion: "2026-08-23-multi-provider-v1",
    legalManifestId: "deepseek-official-2026-08-23-v1",
    displayDisclosureKey: "deepseek-official-v1",
  },
};
