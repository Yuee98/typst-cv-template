import { describe, expect, it } from "vitest";
import { DEEPSEEK_LEGAL_DISPLAY_KEY, DEEPSEEK_LEGAL_MANIFEST_ID, MIMO_LEGAL_DISPLAY_KEY, MIMO_LEGAL_MANIFEST_ID, GEMINI_LEGAL_DISPLAY_KEY, GEMINI_LEGAL_MANIFEST_ID } from "./constants";
import * as en from "./en";
import * as zh from "./zh";
describe("AI legal bundle", () => {
  it("preserves the reviewed source manifest identities", () => {
    for (const localized of [en, zh]) {
      expect(localized.aiProviderLegalManifests.map(({
        manifestId
      }) => manifestId)).toEqual([DEEPSEEK_LEGAL_MANIFEST_ID, MIMO_LEGAL_MANIFEST_ID, GEMINI_LEGAL_MANIFEST_ID]);
      expect(localized.aiProviderLegalManifests.map(({
        displayKey
      }) => displayKey)).toEqual([DEEPSEEK_LEGAL_DISPLAY_KEY, MIMO_LEGAL_DISPLAY_KEY, GEMINI_LEGAL_DISPLAY_KEY]);
      for (const manifest of localized.aiProviderLegalManifests) {
        expect(Object.isFrozen(manifest)).toBe(true);
        expect(Object.isFrozen(manifest.models)).toBe(true);
        expect(Object.isFrozen(manifest.submittedData)).toBe(true);
        expect(Object.isFrozen(manifest.unknowns)).toBe(true);
        expect(Object.isFrozen(manifest.sources)).toBe(true);
      }
    }
  });
  it("separates Responses technical review from retained policy evidence", () => {
    for (const localized of [en, zh]) {
      const manifest = localized.deepseekLegalManifest;
      expect(manifest.manifestId).toBe("deepseek-official-responses-2026-11-07-v1");
      expect(manifest.displayKey).toBe("deepseek-official-responses-v1");
      expect(manifest.reviewedAt).toContain("2026-11-07");
      expect(manifest.reviewedAt).toContain("2026-08-23");
      expect(manifest.models.join(" ")).toContain("deepseek-flash");
      expect(manifest.upstream).toContain("https://api.deepseek.com/responses");
      expect(manifest.providerSubjectId).toContain("user");
      expect(manifest.providerSubjectId).not.toContain("user_id");
      expect(manifest.retention).toContain("store");
      expect(manifest.sources).toContain("https://api-docs.deepseek.com/api/create-response/");
      expect(manifest.sources).toContain("https://api-docs.deepseek.com/guides/responses_api/");
      expect(localized.mimoLegalManifest.reviewedAt).not.toContain("2026-11-07");
    }
    expect(en.deepseekLegalManifest.retention).toMatch(/unsupported.*not sent/);
    expect(zh.deepseekLegalManifest.retention).toContain("不受支持，本服务不发送");
  });
  it("renders all provider annexes from the manifests in both locales", () => {
    expect(zh.aiTermsDocument.sections.map(({
      heading
    }) => heading)).toEqual(expect.arrayContaining(["提供方附录：DeepSeek 官方开放平台", "提供方附录：MiMo 官方 API（中国大陆 profile）", "提供方附录：Google Gemini API（AI Studio）"]));
    expect(en.aiTermsDocument.sections.map(({
      heading
    }) => heading)).toEqual(expect.arrayContaining(["Provider Annex: Official DeepSeek Open Platform", "Provider Annex: Official MiMo API (mainland-China profile)", "Provider Annex: Google Gemini API (AI Studio)"]));
    for (const localized of [en, zh]) {
      const rendered = JSON.stringify(localized.aiTermsDocument);
      for (const manifest of localized.aiProviderLegalManifests) {
        expect(rendered).toContain(manifest.manifestId);
        expect(rendered).toContain(manifest.displayKey);
        for (const source of manifest.sources) {
          expect(rendered).toContain(source);
        }
      }
      const annexIds = localized.aiTermsDocument.sections.filter(({
        id
      }) => id?.startsWith("provider-annex-")).map(({
        id
      }) => id);
      expect(annexIds).toEqual(["provider-annex-deepseek-official-responses-v1", "provider-annex-mimo-cn-v1", "provider-annex-google-ai-studio-interactions-v1"]);
      const sourceLinks = localized.aiTermsDocument.sections.flatMap(({
        links
      }) => links ?? []).filter(({
        kind
      }) => kind === "external");
      expect(sourceLinks).toHaveLength(localized.aiProviderLegalManifests.reduce((sum, manifest) => sum + manifest.sources.length, 0));
      expect(sourceLinks.every(({
        href
      }) => href.startsWith("https://"))).toBe(true);
    }
  });
  it("links every privacy AI disclosure to the localized annex anchors", () => {
    for (const [localized, locale] of [[en, "en"], [zh, "zh"]] as const) {
      const disclosureLinks = localized.privacyDocument.sections.flatMap(({
        links
      }) => links ?? []);
      expect(disclosureLinks).toEqual(expect.arrayContaining([expect.objectContaining({
        kind: "internal",
        href: "/ai-terms#provider-deepseek",
        locale
      }), expect.objectContaining({
        kind: "internal",
        href: "/ai-terms#provider-mimo",
        locale
      }), expect.objectContaining({ kind: "internal", href: "/ai-terms#provider-gemini", locale })]));
    }
  });
  it("keeps the neutral processing contract aligned across languages", () => {
    expect(zh.aiTermsDocument.sections).toHaveLength(en.aiTermsDocument.sections.length);
    expect(zh.privacyDocument.sections).toHaveLength(en.privacyDocument.sections.length);
    const zhNeutral = JSON.stringify(zh.aiTermsDocument.sections.slice(0, 4));
    const enNeutral = JSON.stringify(en.aiTermsDocument.sections.slice(0, 4));
    expect(zhNeutral).toContain("明文");
    expect(enNeutral).toContain("plaintext");
    expect(zhNeutral).toContain("端到端加密");
    expect(enNeutral).toContain("end-to-end encryption");
    expect(zhNeutral).toContain("元数据 ledger/log");
    expect(enNeutral).toContain("metadata ledgers/logs");
    expect(zhNeutral).toContain("配额");
    expect(enNeutral).toContain("Quota");
  });
  it("does not turn unresolved provider behavior into guarantees", () => {
    expect(en.deepseekLegalManifest.retention).toMatch(/no fixed|zero-retention/i);
    expect(en.deepseekLegalManifest.training).toMatch(/no API(?:-specific)? no-training/i);
    expect(en.deepseekLegalManifest.processingRegion).toMatch(/API-specific.*unverified/i);
    expect(en.deepseekLegalManifest.transfer).toMatch(/API-specific.*unverified/i);
    expect(en.deepseekLegalManifest.unknowns.join(" ")).toMatch(/processing\/storage location/i);
    expect(zh.deepseekLegalManifest.processingRegion).toMatch(/API 特定.*尚未核实/u);
    expect(zh.deepseekLegalManifest.transfer).toMatch(/API 特定.*尚未核实/u);
    expect(zh.deepseekLegalManifest.unknowns.join(" ")).toMatch(/处理\/存储地点/u);
    for (const statement of [en.deepseekLegalManifest.processingRegion, en.deepseekLegalManifest.transfer]) {
      expect(statement).not.toMatch(/API content (?:may|will|is) (?:be )?processed in (?:the )?PRC/i);
    }
    for (const statement of [zh.deepseekLegalManifest.processingRegion, zh.deepseekLegalManifest.transfer]) {
      expect(statement).not.toMatch(/API 内容(?:可能|将|会)?在中国(?:境内)?处理/u);
    }
    expect(en.deepseekLegalManifest.sources).toContain("https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html");
    expect(en.deepseekLegalManifest.sources).toContain("https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html");
    expect(en.deepseekLegalManifest.training).toMatch(/Open Platform Terms do not grant DeepSeek training use/i);
    expect(zh.deepseekLegalManifest.training).toMatch(/开放平台条款并未授予 DeepSeek 训练使用权/u);
    expect(en.mimoLegalManifest.cache).toMatch(/could not verify/i);
    expect(en.mimoLegalManifest.processingRegion).toMatch(/not guaranteed/i);
    expect(en.mimoLegalManifest.unknowns.join(" ")).toMatch(/company operating the service in mainland China/i);
    expect(zh.mimoLegalManifest.providerSubjectId).toBe("不发送 provider subject ID。");
    expect(en.mimoLegalManifest.providerSubjectId).toBe("No provider subject ID is sent.");
  });
  it("distinguishes Google tier-dependent data use from interaction storage", () => {
    for (const localized of [en, zh]) {
      const manifest = localized.geminiLegalManifest;
      expect(manifest.models[0]).toContain("gemini-3.8-flash");
      expect(manifest.upstream).toContain("https://generativelanguage.googleapis.com/v1/interactions");
      expect(manifest.reviewedAt).toContain("2026-11-07");
      expect(manifest.sources).toContain("https://ai.google.dev/gemini-api/terms");
      expect(manifest.cache).toContain("24");
    }
    expect(en.geminiLegalManifest.providerSubjectId).toMatch(/^No provider subject ID/);
    expect(en.geminiLegalManifest.training).toMatch(/Unpaid Services.*human review/);
    expect(en.geminiLegalManifest.training).toMatch(/Paid Services.*active Cloud Billing/);
    expect(en.geminiLegalManifest.training).toMatch(/developers in the EEA, Switzerland and UK/);
    expect(en.geminiLegalManifest.training).toMatch(/Voluntarily shared/);
    expect(en.geminiLegalManifest.retention).toMatch(/no overall zero-retention/);
    expect(zh.geminiLegalManifest.training).toContain("开发者位于欧洲经济区、瑞士和英国");
    expect(zh.geminiLegalManifest.retention).toContain("不承诺整体零留存");
  });
  it("describes separate consent as the service operator's flow", () => {
    expect(zh.aiTermsDocument.intro.join(" ")).toContain("本服务运营者选择");
    expect(en.aiTermsDocument.intro.join(" ")).toContain("service operator's chosen");
  });
});
describe("provider selection disclosure", () => {
  it("describes explicit selection and matching consent in both languages", () => {
    expect(zh.aiTermsDocument.intro.join(" ")).toContain("可以从当前时间段允许");
    expect(en.aiTermsDocument.intro.join(" ")).toContain("You can choose among");
    expect(zh.aiTermsDocument.intro.join(" ")).not.toContain("不提供 provider selector");
    expect(en.aiTermsDocument.intro.join(" ")).not.toContain("does not provide a provider selector");
  });
});
