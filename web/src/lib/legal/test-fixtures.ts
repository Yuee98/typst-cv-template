import type { LegalDocument, LegalDisplay } from "./legal-display";
export function legalDocumentFixture(kind: LegalDocument["kind"] = "TERMS", id = "1"): LegalDocument {
  return {
    document_id: id,
    external_id: `ldoc_${id.padStart(12, "0")}`,
    kind,
    document_audit_id: id,
    content_digest: id.padStart(64, "a"),
    effective_date: "2026-11-08",
    zh_title: kind === "TERMS" ? "使用条款" : kind === "AI_COMMON" ? "AI 公共条款" : "服务数据处理说明",
    en_title: kind === "TERMS" ? "Terms of Use" : kind === "AI_COMMON" ? "Common AI terms" : "Service data-processing disclosure",
    zh_body: "中文介绍\n\n## 范围\n\n- 中文条款",
    en_body: "English introduction\n\n## Scope\n\n- English terms",
    enabled: true,
    revision: "1",
    recipient_name: kind === "AI_PROVIDER" ? "Reviewed Service" : null
  };
}
export function legalDisplayFixture(): LegalDisplay {
  return {
    contract: "cv_app_db_2",
    common: legalDocumentFixture("AI_COMMON", "2"),
    provider: legalDocumentFixture("AI_PROVIDER", "3")
  };
}
