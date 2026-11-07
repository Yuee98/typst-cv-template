import { COMPILED_CAPABILITIES } from "./provider";
/** Synthetic local/CI facts, unrelated to hosted configuration or historical seed identities. */
export const fixtureId = (prefix: string, n: number) => `${prefix}_${String(n).padStart(12, "0")}`;
export const fixtureInstance = "10000000-0000-4000-8000-000000000001";
export const fixtureDigest = "1".repeat(64);
export function fixtureProfile(index = 1) {
  const mimo = index === 2;
  const gemini = index === 3;
  const provider = gemini ? "GEMINI" : mimo ? "MIMO" : "DEEPSEEK";
  return {
    provider_code: provider,
    capability: { ...COMPILED_CAPABILITIES[provider] },
    endpoint_url: gemini ? "https://generativelanguage.googleapis.com/v1/interactions" : mimo ? "https://api.xiaomimimo.com/v1/responses" : "https://api.deepseek.com/responses",
    credential_ref: `AI_PROVIDER_KEY_${provider}_LOCAL`,
    model_id: `fixture-model-${index}`,
    adapter_config: gemini ? {
      thinkingLevel: "low", thinkingSummaries: "none", structuredOutput: "json_schema", sendProviderSubjectId: false, store: false, background: false
    } : mimo ? {
      reasoningEffort: "none",
      structuredOutput: "prompt_only",
      sendProviderSubjectId: false
    } : {
      reasoningEffort: "none",
      structuredOutput: "json_object",
      providerSubjectField: "user"
    },
    config_digest: fixtureDigest
  };
}
export function fixtureOption(index = 1) {
  const gemini = index === 3;
  const label = gemini ? "Google AI Studio" : index === 2 ? "MiMo" : "DeepSeek";
  return {
    option_id: fixtureId("opt", index),
    profile_version_id: fixtureId("pfv", index),
    provider_id: fixtureId("prv", gemini ? 3 : index === 2 ? 2 : 1),
    provider_code: gemini ? "GEMINI" : index === 2 ? "MIMO" : "DEEPSEEK",
    provider_name: label,
    model_id: `fixture-model-${index}`,
    disclosure_id: fixtureId("lds", index),
    bundle_id: fixtureId("lgb", 1),
    manifest_digest: fixtureDigest,
    content_digest: fixtureDigest,
    recipient_code: gemini ? "GOOGLE_AI_STUDIO" : index === 2 ? "MIMO" : "DEEPSEEK",
    content: {
      zh: {
        providerLabel: label,
        modelLabel: `测试模型 ${index}`,
        blocks: [{
          kind: "paragraph",
          text: "此项为本地测试披露，仅发送本次明确选择的内容。"
        }]
      },
      en: {
        providerLabel: label,
        modelLabel: `Fixture model ${index}`,
        blocks: [{
          kind: "paragraph",
          text: "Local fixture disclosure. Only the explicitly selected content is transmitted."
        }]
      }
    },
    status: "READY",
    reason: null,
    runtime_profile: fixtureProfile(index)
  };
}
