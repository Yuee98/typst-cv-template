import { describe, expect, it } from "vitest";

import {
  AI_LEGAL_BUNDLE_VERSION,
  AI_TERMS_VERSION,
  DEEPSEEK_LEGAL_DISPLAY_KEY,
  DEEPSEEK_LEGAL_MANIFEST_ID,
  MIMO_LEGAL_DISPLAY_KEY,
  MIMO_LEGAL_MANIFEST_ID,
} from "./constants";
import * as en from "./en";
import * as zh from "./zh";

describe("AI legal bundle", () => {
  it("uses the exact immutable bundle and manifest identifiers", () => {
    expect(AI_LEGAL_BUNDLE_VERSION).toBe("2026-08-23-multi-provider-v1");
    expect(AI_TERMS_VERSION).toBe(AI_LEGAL_BUNDLE_VERSION);

    for (const localized of [en, zh]) {
      expect(localized.aiProviderLegalManifests.map(({ manifestId }) => manifestId)).toEqual([
        DEEPSEEK_LEGAL_MANIFEST_ID,
        MIMO_LEGAL_MANIFEST_ID,
      ]);
      expect(
        localized.aiProviderLegalManifests.map(({ displayKey }) => displayKey),
      ).toEqual([DEEPSEEK_LEGAL_DISPLAY_KEY, MIMO_LEGAL_DISPLAY_KEY]);

      for (const manifest of localized.aiProviderLegalManifests) {
        expect(Object.isFrozen(manifest)).toBe(true);
        expect(Object.isFrozen(manifest.models)).toBe(true);
        expect(Object.isFrozen(manifest.submittedData)).toBe(true);
        expect(Object.isFrozen(manifest.unknowns)).toBe(true);
        expect(Object.isFrozen(manifest.sources)).toBe(true);
      }
    }
  });

  it("renders both provider annexes from the manifests in both locales", () => {
    expect(zh.aiTermsDocument.sections.map(({ heading }) => heading)).toEqual(
      expect.arrayContaining([
        "提供方附录：DeepSeek 官方开放平台",
        "提供方附录：MiMo 官方 API（中国大陆 profile）",
      ]),
    );
    expect(en.aiTermsDocument.sections.map(({ heading }) => heading)).toEqual(
      expect.arrayContaining([
        "Provider Annex: Official DeepSeek Open Platform",
        "Provider Annex: Official MiMo API (mainland-China profile)",
      ]),
    );

    for (const localized of [en, zh]) {
      const rendered = JSON.stringify(localized.aiTermsDocument);
      for (const manifest of localized.aiProviderLegalManifests) {
        expect(rendered).toContain(manifest.manifestId);
        expect(rendered).toContain(manifest.displayKey);
        for (const source of manifest.sources) {
          expect(rendered).toContain(source);
        }
      }

      const annexIds = localized.aiTermsDocument.sections
        .filter(({ id }) => id?.startsWith("provider-annex-"))
        .map(({ id }) => id);
      expect(annexIds).toEqual([
        "provider-annex-deepseek-official-v1",
        "provider-annex-mimo-cn-v1",
      ]);

      const sourceLinks = localized.aiTermsDocument.sections
        .flatMap(({ links }) => links ?? [])
        .filter(({ kind }) => kind === "external");
      expect(sourceLinks).toHaveLength(
        localized.deepseekLegalManifest.sources.length +
          localized.mimoLegalManifest.sources.length,
      );
      expect(sourceLinks.every(({ href }) => href.startsWith("https://"))).toBe(true);
    }
  });

  it("links both privacy AI disclosures to the localized annex anchors", () => {
    for (const [localized, locale] of [
      [en, "en"],
      [zh, "zh"],
    ] as const) {
      const disclosureLinks = localized.privacyDocument.sections.flatMap(
        ({ links }) => links ?? [],
      );

      expect(disclosureLinks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "internal",
            href: "/ai-terms#provider-annex-deepseek-official-v1",
            locale,
          }),
          expect.objectContaining({
            kind: "internal",
            href: "/ai-terms#provider-annex-mimo-cn-v1",
            locale,
          }),
        ]),
      );
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
    expect(en.deepseekLegalManifest.training).toMatch(/no API no-training/i);
    expect(en.deepseekLegalManifest.processingRegion).toMatch(/API-specific.*unverified/i);
    expect(en.deepseekLegalManifest.transfer).toMatch(/API-specific.*unverified/i);
    expect(en.deepseekLegalManifest.unknowns.join(" ")).toMatch(/processing\/storage location/i);
    expect(zh.deepseekLegalManifest.processingRegion).toMatch(/API 特定.*尚未核实/u);
    expect(zh.deepseekLegalManifest.transfer).toMatch(/API 特定.*尚未核实/u);
    expect(zh.deepseekLegalManifest.unknowns.join(" ")).toMatch(/处理\/存储地点/u);
    for (const statement of [
      en.deepseekLegalManifest.processingRegion,
      en.deepseekLegalManifest.transfer,
    ]) {
      expect(statement).not.toMatch(/API content (?:may|will|is) (?:be )?processed in (?:the )?PRC/i);
    }
    for (const statement of [
      zh.deepseekLegalManifest.processingRegion,
      zh.deepseekLegalManifest.transfer,
    ]) {
      expect(statement).not.toMatch(/API 内容(?:可能|将|会)?在中国(?:境内)?处理/u);
    }
    expect(en.deepseekLegalManifest.sources).toContain(
      "https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html",
    );
    expect(en.mimoLegalManifest.cache).toMatch(/could not verify/i);
    expect(en.mimoLegalManifest.processingRegion).toMatch(/not guaranteed/i);
    expect(en.mimoLegalManifest.unknowns.join(" ")).toMatch(
      /company operating the service in mainland China/i,
    );
    expect(zh.mimoLegalManifest.providerSubjectId).toBe("不发送 provider subject ID。");
    expect(en.mimoLegalManifest.providerSubjectId).toBe(
      "No provider subject ID is sent.",
    );
  });

  it("describes separate consent as the service operator's flow", () => {
    expect(zh.aiTermsDocument.intro.join(" ")).toContain("本服务运营者选择");
    expect(en.aiTermsDocument.intro.join(" ")).toContain(
      "service operator's chosen",
    );
  });
});
