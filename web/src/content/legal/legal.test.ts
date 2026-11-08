import { describe, expect, it } from "vitest";
import { legalEn, legalZh } from "./index";
import { legalSeedDocuments } from "./seed";
import { parseLegalMarkdown } from "@/lib/legal/markdown";
describe("reviewed bilingual legal seed", () => {
  it("has current terms, one common document and three scoped provider documents", () => {
    expect(legalSeedDocuments.map(doc => doc.kind)).toEqual(["TERMS", "AI_COMMON", "AI_PROVIDER", "AI_PROVIDER", "AI_PROVIDER"]);
    for (const doc of legalSeedDocuments) {
      expect(parseLegalMarkdown(doc.zh_body).length).toBeGreaterThan(3);
      expect(parseLegalMarkdown(doc.en_body).length).toBeGreaterThan(3);
    }
  });
  it("separates provider-specific facts from the common body", () => {
    const common = legalSeedDocuments.find(doc => doc.kind === "AI_COMMON")!;
    expect(common.en_body).not.toContain("## Provider Annex");
    expect(common.en_body).not.toMatch(/legal bundle|Manifest ID/);
    expect(common.zh_body).not.toMatch(/legal bundle|Manifest ID/);
    const providers = legalSeedDocuments.filter(doc => doc.kind === "AI_PROVIDER");
    expect(providers.map(doc => doc.model_id)).toEqual(["deepseek-flash", "mimo-v2.6-flash", "gemini-3.8-flash"]);
    expect(providers.every(doc => doc.endpoint_url?.startsWith("https://"))).toBe(true);
  });
  it("retains technical versus policy evidence dates without inventing a policy review", () => {
    expect(legalEn.deepseekEvidence.reviewedAt).toContain("2026-11-07");
    expect(legalEn.deepseekEvidence.reviewedAt).toContain("2026-08-23");
    expect(legalZh.deepseekEvidence.reviewedAt).toContain("2026-08-23");
  });
  it("does not turn unresolved retention/regions into guarantees", () => {
    for (const legal of [legalEn, legalZh]) {
      for (const evidence of legal.providerEvidence) {
        expect(evidence.unknowns.length).toBeGreaterThan(0);
        expect(evidence.sources.length).toBeGreaterThan(0);
      }
    }
    expect(legalEn.deepseekEvidence.training).toContain("no API-specific no-training");
    expect(legalEn.deepseekEvidence.retention).toContain("does not establish zero retention");
    expect(legalEn.mimoEvidence.processingRegion).toContain("not guaranteed");
  });
  it("distinguishes Google billing data use from interaction storage", () => {
    const google = legalEn.geminiEvidence;
    expect(google.training).toContain("Unpaid Services");
    expect(google.training).toContain("Paid Services");
    expect(google.training).toContain("a key or model name alone does not prove");
    expect(google.retention).toContain("Separate abuse-monitoring");
    expect(google.cache).toContain("does not disable every cache");
  });
  it("keeps explicit selection and no silent cross-provider fallback", () => {
    const english = JSON.stringify(legalEn.aiTermsDocument),
      chinese = JSON.stringify(legalZh.aiTermsDocument);
    expect(english).toContain("does not automatically accept");
    expect(english).toContain("undisclosed automatic cross-provider fallback");
    expect(chinese).toContain("不代表自动同意");
    expect(english).toContain("90 days");
    expect(chinese).toContain("90 天");
  });
});
