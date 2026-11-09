import { legalDisplaySchema } from "@/lib/legal/legal-display";
import { polishAvailabilityResponseSchema } from "./contract";
const external = (index: number) => `ldoc_${String(index).padStart(12, "0")}`;
export const fixtureConfigurationFacts = [
  { displayName: "DeepSeek" },
  { displayName: "MiMo" },
  { displayName: "Google AI Studio" }
] as const;
export function fixtureLegalDisplay(index = 1) {
  const fact = fixtureConfigurationFacts[index - 1];
  const common = {
    document_id: "1", external_id: external(1), document_audit_id: "1",
    kind: "AI_COMMON", content_digest: "1".repeat(64), effective_date: "2026-11-08",
    zh_title: "AI 使用说明", en_title: "AI processing terms",
    zh_body: "## AI 使用说明\n\n仅发送明确选择的内容。", en_body: "## AI processing terms\n\nOnly explicitly selected content is transmitted.",
    enabled: true, revision: "1", recipient_name: null
  };
  return legalDisplaySchema.parse({
    contract: "cv_app_db_2", common,
    provider: {
      ...common, document_id: String(index + 10), external_id: external(index + 10), document_audit_id: String(index + 10),
      kind: "AI_PROVIDER", content_digest: String(index + 1).repeat(64),
      zh_title: `${fact.displayName} 数据处理说明`, en_title: `${fact.displayName} processing disclosure`,
      zh_body: `## ${fact.displayName}\n\n本次由 ${fact.displayName} 处理所选内容。\n\n本地测试接收方披露。`,
      en_body: `## ${fact.displayName}\n\n${fact.displayName} processes the selected content.\n\nLocal fixture recipient disclosure.`,
      recipient_name: fact.displayName
    }
  });
}
export function fixtureAvailability(indices = [1, 2], accepted = true) {
  return polishAvailabilityResponseSchema.parse({
    requestId: "local-availability",
    availability: {
      enabled: true, contract: "cv_app_db_2", databaseInstanceId: "10000000-0000-4000-8000-000000000001",
      controlRevision: "1", defaultConfigId: "1", reason: null,
      configurations: indices.map(index => ({
        configId: String(index), configRevision: "1", displayName: fixtureConfigurationFacts[index - 1].displayName, status: accepted ? "READY" : "CONSENT_REQUIRED", reason: null,
        legalDisplay: fixtureLegalDisplay(index)
      }))
    }
  });
}
