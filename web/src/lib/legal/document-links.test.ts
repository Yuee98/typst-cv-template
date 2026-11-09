import { describe, expect, it } from "vitest";
import { aiDisclosureHref, parseLegalReadTarget, termsDocumentHref } from "./document-links";
import { legalDisplayFixture, legalDocumentFixture } from "./test-fixtures";
const terms = legalDocumentFixture(),
  display = legalDisplayFixture();
const query = (href: string) => new URL(href, "https://preview.test").searchParams;
const pin = (doc: typeof terms) => ({
  external_id: doc.external_id,
  document_audit_id: doc.document_audit_id,
  content_digest: doc.content_digest
});
describe("exact audited legal links", () => {
  it("pins ordinary terms including its exact audit", () => expect(parseLegalReadTarget("terms", query(termsDocumentHref(terms)))).toEqual({
    type: "terms",
    document: pin(terms)
  }));
  it("independently pins common and selected-service documents", () => expect(parseLegalReadTarget("ai_terms", query(aiDisclosureHref(display)))).toEqual({
    type: "provider",
    common: pin(display.common),
    provider: pin(display.provider)
  }));
  it.each(["terms", "ai_terms"] as const)("supports the unpinned %s directory", kind => expect(parseLegalReadTarget(kind, new URLSearchParams("utm_source=footer"))).toEqual({
    type: "current"
  }));
  it.each(["common", "common_audit", "common_digest", "provider", "provider_audit", "provider_digest"])("fails closed on missing/duplicate %s", key => {
    const missing = query(aiDisclosureHref(display));
    missing.delete(key);
    expect(parseLegalReadTarget("ai_terms", missing).type).toBe("invalid");
    const duplicate = query(aiDisclosureHref(display));
    duplicate.append(key, duplicate.get(key)!);
    expect(parseLegalReadTarget("ai_terms", duplicate).type).toBe("invalid");
  });
  it.each(["document", "audit", "digest"])("fails closed on incomplete ordinary %s", key => {
    const invalid = query(termsDocumentHref(terms));
    invalid.delete(key);
    expect(parseLegalReadTarget("terms", invalid).type).toBe("invalid");
  });
  it("rejects wrong-kind pins and numeric overflow", () => {
    expect(parseLegalReadTarget("terms", query(aiDisclosureHref(display))).type).toBe("invalid");
    const invalid = query(termsDocumentHref(terms));
    invalid.set("audit", "9223372036854775808");
    expect(parseLegalReadTarget("terms", invalid).type).toBe("invalid");
  });
});
