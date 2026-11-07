import { describe, expect, it } from "vitest";
import { localizedAdminValue, buildAdminQuery } from "./admin-app";
import { adminMessages } from "./messages";
import { adminMutationRequestSchema, externalIdSchema } from "@/lib/admin/contract";
describe("current admin contract", () => {
  it("preserves bigint revisions without numeric rounding", () => {
    const parsed = adminMutationRequestSchema.parse({
      operation: "admin_ai_disable",
      contract_code: "cv_app_db_1",
      database_instance_id: "00000000-0000-4000-8000-000000000001",
      operation_key: "00000000-0000-4000-8000-000000000002",
      reason: "emergency",
      expected_revision: "9007199254740993"
    });
    expect("expected_revision" in parsed && parsed.expected_revision).toBe("9007199254740993");
  });
  it("rejects UUIDs and invalid Crockford suffixes as business IDs", () => {
    expect(externalIdSchema.safeParse("prv_0123456789AB").success).toBe(true);
    expect(externalIdSchema.safeParse("prv_0123456789AI").success).toBe(false);
    expect(externalIdSchema.safeParse("00000000-0000-4000-8000-000000000001").success).toBe(false);
  });
  it("uses only current pagination and renders explicit scalar values", () => {
    expect(buildAdminQuery({
      after: "op_0123456789AB",
      limit: 50
    })).toBe("?after=op_0123456789AB&limit=50");
    expect(localizedAdminValue(true, "en", adminMessages.en)).toBe("Yes");
    expect(localizedAdminValue(null, "en", adminMessages.en)).toBe("—");
  });
});
