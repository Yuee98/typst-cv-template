import { describe, expect, it } from "vitest";
import { aiDisclosureHref, parseLegalReadTarget, termsDocumentHref } from "./document-links";

const terms = { external_id: "ldv_111111111111", content_digest: "a".repeat(64) };
const disclosure = { bundleId: "lgb_111111111111", manifestDigest: "b".repeat(64), disclosureId: "lds_111111111111", contentDigest: "c".repeat(64) };
const query = (href: string) => new URL(href, "https://preview.test").searchParams;

describe("versioned legal reading links", () => {
  it("retains the exact ordinary terms target", () => {
    expect(parseLegalReadTarget("terms", query(termsDocumentHref(terms)))).toEqual({ type: "terms", documentId: terms.external_id, contentDigest: terms.content_digest });
  });
  it("retains the selected disclosure and its whole bundle binding", () => {
    expect(parseLegalReadTarget("ai_terms", query(aiDisclosureHref(disclosure)))).toEqual({ type: "disclosure", ...disclosure });
  });
  it.each(["terms", "ai_terms"] as const)("keeps the %s directory available without pins", kind => {
    expect(parseLegalReadTarget(kind, new URLSearchParams("utm_source=footer"))).toEqual({ type: "current" });
  });
  it.each(["bundle", "manifest", "disclosure", "digest"])("rejects missing or duplicate AI %s instead of reading the current directory", key => {
    const missing = query(aiDisclosureHref(disclosure));
    missing.delete(key);
    expect(parseLegalReadTarget("ai_terms", missing)).toEqual({ type: "invalid" });
    const duplicate = query(aiDisclosureHref(disclosure));
    duplicate.append(key, duplicate.get(key)!);
    expect(parseLegalReadTarget("ai_terms", duplicate)).toEqual({ type: "invalid" });
  });
  it.each(["document", "digest"])("rejects partial or duplicate ordinary %s pins", key => {
    const missing = query(termsDocumentHref(terms)); missing.delete(key);
    expect(parseLegalReadTarget("terms", missing)).toEqual({ type: "invalid" });
    const duplicate = query(termsDocumentHref(terms)); duplicate.append(key, duplicate.get(key)!);
    expect(parseLegalReadTarget("terms", duplicate)).toEqual({ type: "invalid" });
  });
  it("rejects wrong kinds, IDs and digests", () => {
    expect(parseLegalReadTarget("terms", query(aiDisclosureHref(disclosure)))).toEqual({ type: "invalid" });
    expect(parseLegalReadTarget("ai_terms", query(termsDocumentHref(terms)))).toEqual({ type: "invalid" });
    for (const [key, value] of [["bundle", "lds_111111111111"], ["disclosure", "invalid"], ["manifest", ""], ["digest", "not-a-digest"]]) {
      const invalid = query(aiDisclosureHref(disclosure)); invalid.set(key, value);
      expect(parseLegalReadTarget("ai_terms", invalid)).toEqual({ type: "invalid" });
    }
  });
});
