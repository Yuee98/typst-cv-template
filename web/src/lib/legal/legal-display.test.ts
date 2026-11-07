import { describe, expect, it } from "vitest";
import { legalDisplaySchema } from "./legal-display";
describe("sole disclosure format", () => {
  it("rejects old or incomplete disclosure shapes", () => {
    expect(legalDisplaySchema.safeParse({
      schemaVersion: "legal_display_v2"
    }).success).toBe(false);
    expect(legalDisplaySchema.safeParse({
      contract: "cv_app_db_1",
      disclosureId: "lds_0123456789AB"
    }).success).toBe(false);
  });
});
