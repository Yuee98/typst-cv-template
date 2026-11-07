import { polishAvailabilityResponseSchema } from "./contract";
const external = (prefix: string, index: number) => `${prefix}_${String(index).padStart(12, "0")}`;
export function fixtureAvailability(indices = [1, 2], accepted = true) {
  return polishAvailabilityResponseSchema.parse({
    requestId: "local-availability",
    availability: {
      enabled: true,
      contract: "cv_app_db_1",
      databaseInstanceId: "10000000-0000-4000-8000-000000000001",
      configGeneration: "1",
      policyVersionId: external("plv", 1),
      ruleOrdinal: 1,
      defaultOptionId: external("opt", 1),
      observedAt: "2026-11-07T00:00:00.000Z",
      nextChangeAt: null,
      reason: null,
      options: indices.map(index => ({
        optionId: external("opt", index),
        profileVersionId: external("pfv", index),
        providerName: index === 3 ? "Google AI Studio" : index === 2 ? "MiMo" : "DeepSeek",
        modelName: `fixture-model-${index}`,
        status: accepted ? "READY" : "CONSENT_REQUIRED",
        reason: null,
        legalDisplay: {
          contract: "cv_app_db_1",
          disclosureId: external("lds", index),
          bundleId: external("lgb", 1),
          manifestDigest: "1".repeat(64),
          providerId: external("prv", index === 3 ? 3 : index === 2 ? 2 : 1),
          recipientCode: index === 3 ? "GOOGLE_AI_STUDIO" : index === 2 ? "MIMO" : "DEEPSEEK",
          modelId: `fixture-model-${index}`,
          contentDigest: "1".repeat(64),
          zh: {
            providerLabel: index === 3 ? "Google AI Studio" : index === 2 ? "MiMo" : "DeepSeek",
            modelLabel: `测试模型 ${index}`,
            blocks: [{
              kind: "paragraph",
              text: "此项为本地测试披露。"
            }]
          },
          en: {
            providerLabel: index === 3 ? "Google AI Studio" : index === 2 ? "MiMo" : "DeepSeek",
            modelLabel: `Fixture model ${index}`,
            blocks: [{
              kind: "paragraph",
              text: "Local test disclosure."
            }]
          }
        }
      }))
    }
  });
}
