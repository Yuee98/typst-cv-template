import { describe, expect, it } from "vitest";
import { legalDisplaySchema, legalDocumentSchema } from "./legal-display";
import { legalDisplayFixture, legalDocumentFixture } from "./test-fixtures";
describe("recipient-based legal documents", () => {
  it("rejects incomplete shapes and cross-kind documents", () => {
    expect(legalDisplaySchema.safeParse({ contract: "cv_app_db_1" }).success).toBe(false);
    const display = legalDisplayFixture();
    expect(legalDisplaySchema.safeParse({ ...display, provider: display.common }).success).toBe(false);
  });
  it.each(["<script>bad()</script>", "![tracker](https://evil.test/pixel)", "[bad](javascript:alert)", "[bad](data:text/plain,payload)", "[bad](//evil.test)", "[bad](https://user:pass@evil.test)"])("rejects unsafe Markdown %s", en_body => {
    const display = legalDisplayFixture();
    display.provider.en_body = en_body;
    expect(legalDisplaySchema.safeParse(display).success).toBe(false);
  });
  it("retains exact document and audit references without execution scope", () => {
    const display = legalDisplayFixture();
    expect(legalDisplaySchema.parse(display)).toEqual(display);
    expect(display.provider).toMatchObject({ recipient_name: "Reviewed Service", document_id: "3", document_audit_id: "3" });
    for (const field of ["adapter_id", "endpoint_url", "model_id"]) expect(display.provider).not.toHaveProperty(field);
  });
  it("requires a recipient for a provider disclosure", () => expect(legalDocumentSchema.safeParse({ ...legalDocumentFixture("AI_PROVIDER"), recipient_name: null }).success).toBe(false));
  it.each(["TERMS", "AI_COMMON"] as const)("does not attach a provider recipient to %s", kind => {
    expect(legalDocumentSchema.safeParse({ ...legalDocumentFixture(kind), recipient_name: "Another service" }).success).toBe(false);
  });
});
