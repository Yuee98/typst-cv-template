import { describe, expect, it } from "vitest";

import { parseLegalDisplayV2 } from "./legal-display-v2";

const base = {
  schemaVersion: "legal_display_v2",
  displayDisclosureKey: "provider-v2",
  legalBundleVersion: "bundle-v2",
  legalManifestId: "manifest-v2",
  providerId: "00000000-0000-4000-8000-000000000001",
  recipientKey: "provider-recipient",
  modelId: "model-v2",
  contentSha256: "a".repeat(64),
  factIds: ["fact.provider.v2"],
  evidenceIds: ["evidence.provider.v2"],
  zh: { providerLabel: "提供方", modelLabel: "模型", blocks: [{ kind: "paragraph", text: "中文说明。" }] },
  en: { providerLabel: "Provider", modelLabel: "Model", blocks: [{ kind: "bulletList", items: ["English disclosure."] }] },
};

describe("legal display v2 descriptor", () => {
  it("parses and recursively freezes content-only bilingual blocks", () => {
    const result = parseLegalDisplayV2(base);
    expect(result.zh.blocks[0]).toEqual({ kind: "paragraph", text: "中文说明。" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.zh)).toBe(true);
    expect(Object.isFrozen(result.zh.blocks)).toBe(true);
    expect(Object.isFrozen(result.zh.blocks[0])).toBe(true);
  });

  it("preserves every reviewed text character while retaining the digest", () => {
    const spaced = {
      ...base,
      en: {
        providerLabel: "  Provider  ",
        modelLabel: " Model ",
        blocks: [{ kind: "paragraph", text: "  Reviewed text.\n" }],
      },
    };
    const result = parseLegalDisplayV2(spaced);
    expect(result.en).toEqual(spaced.en);
    expect(result.contentSha256).toBe(base.contentSha256);
  });

  it("uses database-compatible Unicode character limits", () => {
    expect(() =>
      parseLegalDisplayV2({
        ...base,
        en: { ...base.en, providerLabel: "😀".repeat(200) },
      }),
    ).not.toThrow();
    expect(() =>
      parseLegalDisplayV2({
        ...base,
        en: { ...base.en, providerLabel: "😀".repeat(201) },
      }),
    ).toThrow();
  });

  it.each([
    ["unknown top-level field", { ...base, extra: true }],
    ["unknown block field", { ...base, en: { ...base.en, blocks: [{ kind: "paragraph", text: "x", html: "<p>x</p>" }] } }],
    ["empty fact ids", { ...base, factIds: [] }],
    ["duplicate evidence ids", { ...base, evidenceIds: ["evidence.provider.v2", "evidence.provider.v2"] }],
    ["invalid provider UUID", { ...base, providerId: "provider-v2" }],
    ["empty bullet list", { ...base, en: { ...base.en, blocks: [{ kind: "bulletList", items: [] }] } }],
    ["blank label", { ...base, en: { ...base.en, providerLabel: " \t " } }],
    ["blank paragraph", { ...base, en: { ...base.en, blocks: [{ kind: "paragraph", text: " \n " }] } }],
    ["oversized bullet", { ...base, en: { ...base.en, blocks: [{ kind: "bulletList", items: ["x".repeat(1_001)] }] } }],
    [
      "oversized UTF-8 text aggregate",
      {
        ...base,
        en: {
          ...base.en,
          blocks: Array.from(
            { length: 3 },
            () => ({ kind: "paragraph", text: "中".repeat(4_000) }),
          ),
        },
      },
    ],
  ])("rejects %s", (_name, input) => {
    expect(() => parseLegalDisplayV2(input)).toThrow();
  });
});
