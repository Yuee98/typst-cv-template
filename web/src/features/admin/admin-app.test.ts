import { describe, expect, it } from "vitest";
import { adminMutationRequestSchema, entityIdSchema } from "@/lib/admin/contract";
import { formatPrice, parsePrice } from "./admin-entity-dialog";
describe("current aggregate contract", () => {
  it("preserves bigint revisions and rejects former external identities", () => {
    const parsed = adminMutationRequestSchema.parse({
      operation: "admin_ai_disable",
      contract_code: "cv_app_db_2",
      database_instance_id: "00000000-0000-4000-8000-000000000001",
      operation_key: "00000000-0000-4000-8000-000000000002",
      reason: "Emergency disable AI",
      expected_revision: "9007199254740993"
    });
    expect("expected_revision" in parsed && parsed.expected_revision).toBe("9007199254740993");
    expect(entityIdSchema.safeParse("9007199254740993").success).toBe(true);
    expect(entityIdSchema.safeParse("pfv_0123456789AB").success).toBe(false);
  });
  it("formats and parses prices without floating-point rounding", () => {
    expect(formatPrice("9007199254740993")).toBe("9007199.254740993");
    expect(parsePrice("9007199.254740993")).toBe("9007199254740993");
    expect(() => parsePrice("1.1234567891")).toThrow();
    expect(() => parsePrice("-1")).toThrow();
  });

});
