import { describe, expect, it } from "vitest";

import { preferredLocale, rootLocaleRedirectLocation } from "@/i18n/root-redirect";

describe("root locale redirect", () => {
  it("prefers English when any browser language is English", () => {
    expect(preferredLocale(["zh-CN", "en-US"])).toBe("en");
    expect(preferredLocale(["EN-gb"])).toBe("en");
  });

  it("defaults non-English and empty language lists to Chinese", () => {
    expect(preferredLocale(["zh-CN"])).toBe("zh");
    expect(preferredLocale(["ja-JP", "fr-FR"])).toBe("zh");
    expect(preferredLocale([])).toBe("zh");
  });

  it("preserves OAuth query and hash payloads in the locale redirect", () => {
    expect(rootLocaleRedirectLocation("en", "?code=abc&state=xyz", "#access_token=token")).toBe(
      "/en/?code=abc&state=xyz#access_token=token",
    );
    expect(rootLocaleRedirectLocation("zh", "", "")).toBe("/zh/");
  });
});
