import { describe, expect, it } from "vitest";
import corpus from "../../../../supabase/test-fixtures/legal-markdown-corpus.json";
import { isLegalHref, parseLegalMarkdown } from "./markdown";
import { legalDocumentSchema } from "./legal-display";
import { legalDocumentFixture } from "./test-fixtures";
import { legalSeedDocuments } from "@/content/legal/seed";

describe("shared SQL and public-reader legal conformance corpus", () => {
  it.each(corpus.hrefs)("href: $id", test => {
    expect(isLegalHref(test.value)).toBe(test.valid);
  });
  it.each(corpus.bodies)("body: $id", test => {
    const value = test.value.repeat(test.repeat ?? 1);
    if (test.valid) expect(() => parseLegalMarkdown(value)).not.toThrow();
    else expect(() => parseLegalMarkdown(value)).toThrow();
    for (const language of ["zh", "en"]) {
      const document = { ...legalDocumentFixture("AI_PROVIDER"), [`${language}_body`]: value };
      const parsed = legalDocumentSchema.safeParse(document);
      expect(parsed.success).toBe(test.valid);
      if (parsed.success) expect(parsed.data).toEqual(document);
    }
  });
  it.each(corpus.metadata)("metadata: $id", test => {
    const document = { ...legalDocumentFixture("AI_PROVIDER"), [test.field]: test.value.repeat(test.repeat ?? 1) };
    const parsed = legalDocumentSchema.safeParse(document);
    expect(parsed.success).toBe(test.valid);
    if (parsed.success) expect(parsed.data).toEqual(document);
  });
  it("keeps all current bilingual seed documents and active source links readable", () => {
    const hrefs = new Set(corpus.hrefs.filter(test => test.valid).map(test => test.value));
    for (const document of legalSeedDocuments) {
      for (const value of [document.zh_body, document.en_body]) {
        expect(() => parseLegalMarkdown(value)).not.toThrow();
        for (const match of value.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)) expect(hrefs.has(match[2])).toBe(true);
      }
    }
  });
  it("preserves the existing empty-block and unmatched-link literal structure", () => {
    expect(parseLegalMarkdown("## \n\n- \n\nUnfinished [link](javascript:alert")).toEqual([
      { kind: "heading", text: "" }, { kind: "list", items: [""] }, { kind: "paragraph", text: "Unfinished [link](javascript:alert" }
    ]);
  });
});
