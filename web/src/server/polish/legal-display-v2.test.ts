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

  it.each([
    ["unknown top-level field", { ...base, extra: true }],
    ["unknown block field", { ...base, en: { ...base.en, blocks: [{ kind: "paragraph", text: "x", html: "<p>x</p>" }] } }],
    ["empty fact ids", { ...base, factIds: [] }],
    ["duplicate evidence ids", { ...base, evidenceIds: ["evidence.provider.v2", "evidence.provider.v2"] }],
    ["invalid provider UUID", { ...base, providerId: "provider-v2" }],
    ["empty bullet list", { ...base, en: { ...base.en, blocks: [{ kind: "bulletList", items: [] }] } }],
  ])("rejects %s", (_name, input) => {
    expect(() => parseLegalDisplayV2(input)).toThrow();
  });
});
