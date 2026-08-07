import { describe, expect, it } from "vitest";

import { isLocale } from "@/i18n/routing";

describe("locale routing", () => {
  it("recognizes only the supported locale prefixes", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("zh")).toBe(true);
    expect(isLocale("EN")).toBe(false);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});
