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
