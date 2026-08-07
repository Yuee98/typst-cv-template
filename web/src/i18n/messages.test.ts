import { describe, expect, it } from "vitest";

import { getMessages, messagesByLocale } from "@/i18n/messages";

function leafPaths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [prefix];
  }

  return Object.entries(value).flatMap(([key, child]) =>
    leafPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("localized message catalogs", () => {
  it("keeps English and Chinese leaf keys exactly aligned", () => {
    const englishKeys = leafPaths(messagesByLocale.en).sort();
    const chineseKeys = leafPaths(messagesByLocale.zh).sort();

    expect(englishKeys).toEqual(chineseKeys);
    expect(englishKeys.length).toBeGreaterThan(300);
  });

  it("contains no blank translated leaf values", () => {
    for (const [locale, messages] of Object.entries(messagesByLocale)) {
      const blankPaths = leafPaths(messages).filter((path) => {
        const value = path.split(".").reduce<unknown>((current, key) => {
          if (!current || typeof current !== "object") return undefined;
          return (current as Record<string, unknown>)[key];
        }, messages);
        return typeof value === "string" && value.trim().length === 0;
      });

      expect(blankPaths, `${locale} contains blank messages`).toEqual([]);
    }
  });

  it("returns the catalog for the requested supported locale", () => {
    expect(getMessages("en")).toBe(messagesByLocale.en);
    expect(getMessages("zh")).toBe(messagesByLocale.zh);
  });
});
