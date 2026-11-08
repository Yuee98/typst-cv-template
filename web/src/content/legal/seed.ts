import { legalEn, legalZh } from "./index";
import type { AiProviderEvidence, LegalDocument } from "./types";
export function documentMarkdown(document: LegalDocument): string {
  return [...document.intro, ...document.sections.flatMap(section => [`## ${section.heading}`, ...section.body, ...(section.bullets?.length ? [section.bullets.map(item => `- ${item}`).join("\n")] : []), ...(section.links?.length ? [section.links.map(link => `- [${link.label}](${link.href.replaceAll("(", "%28").replaceAll(")", "%29")})`).join("\n")] : [])])].join("\n\n");
}
function providerMarkdown(evidence: AiProviderEvidence, zh: boolean): string {
  const heading = (en: string, cn: string, text: string) => `## ${zh ? cn : en}\n\n${text}`;
  return [`${zh ? "实际服务" : "Service"}: ${evidence.provider}\n\n${zh ? "运营者/接收方" : "Operator/recipient"}: ${evidence.gatewayOperator}\n\n${zh ? "模型" : "Model"}: ${evidence.models.join(", ")}`, heading("What is sent", "发送内容", [...evidence.submittedData, evidence.providerSubjectId].join("\n\n")), heading("Processing region", "处理地区", evidence.processingRegion), heading("Caching", "缓存", evidence.cache), heading("Retention", "留存", evidence.retention), heading("Training and service improvement", "训练与服务改进", evidence.training), heading("Transfers", "传输", evidence.transfer), heading("Unverified matters", "尚未确认事项", evidence.unknowns.map(item => `- ${item}`).join("\n")), heading("Sources and review dates", "来源与核验日期", `${evidence.reviewedAt}\n\n${evidence.sources.map((url, i) => `- [${zh ? "官方来源" : "Official source"} ${i + 1}](${url})`).join("\n")}`)].join("\n\n");
}
const pairs = [[legalZh.deepseekEvidence, legalEn.deepseekEvidence], [legalZh.mimoEvidence, legalEn.mimoEvidence], [legalZh.geminiEvidence, legalEn.geminiEvidence]] as const;
const endpoints = ["https://api.deepseek.com/responses", "https://api.xiaomimimo.com/v1/responses", "https://generativelanguage.googleapis.com/v1/interactions"];
const models = ["deepseek-flash", "mimo-v2.6-flash", "gemini-3.8-flash"];
const base = {
  enabled: true,
  recipient_name: null,
  adapter_id: null,
  endpoint_url: null,
  model_id: null
};
export const legalSeedDocuments = [{
  ...base,
  kind: "TERMS",
  effective_date: "2026-07-03",
  zh_title: legalZh.termsDocument.title,
  en_title: legalEn.termsDocument.title,
  zh_body: documentMarkdown(legalZh.termsDocument),
  en_body: documentMarkdown(legalEn.termsDocument)
}, {
  ...base,
  kind: "AI_COMMON",
  effective_date: "2026-11-08",
  zh_title: legalZh.aiTermsDocument.title,
  en_title: legalEn.aiTermsDocument.title,
  zh_body: documentMarkdown(legalZh.aiTermsDocument),
  en_body: documentMarkdown(legalEn.aiTermsDocument)
}, ...pairs.map(([zh, en], i) => ({
  kind: "AI_PROVIDER",
  effective_date: "2026-11-08",
  enabled: true,
  recipient_name: en.provider,
  adapter_id: i + 1,
  endpoint_url: endpoints[i],
  model_id: models[i],
  zh_title: `${zh.provider} · ${models[i]} 数据处理说明`,
  en_title: `${en.provider} · ${models[i]} data-processing disclosure`,
  zh_body: providerMarkdown(zh, true),
  en_body: providerMarkdown(en, false)
}))];
