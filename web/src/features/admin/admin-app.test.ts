vi.mock("@/components/layout/toolbar/locale-switcher", () => ({ LocaleSwitcher: () => null }));
import { describe, expect, it, vi } from "vitest";
import { adminAuditSchema } from "@/lib/admin/contract";
import { adminMessages } from "./messages";
import {
  adminDetailLabels,
  buildAdminQuery,
  localizedAdminValue,
} from "./admin-app";

describe("admin display helpers", () => {
  it("keeps list query bounded to search, cursor and limit", () => {
    expect(
      buildAdminQuery({ search: "model", after: "cursor", limit: 50 }),
    ).toBe("?search=model&after=cursor&limit=50");
  });

  it("localizes boolean values", () => {
    expect(localizedAdminValue(true, "en", adminMessages.en)).toBe("Yes");
    expect(localizedAdminValue(false, "zh", adminMessages.zh)).toBe("否");
  });

  it("renders only explicit configuration lifecycle audit fields", () => {
    const event = adminAuditSchema.parse({
      id: "00000000-0000-4000-8000-000000000001",
      occurredAt: "2026-09-08T00:00:00.000Z",
      eventSchemaVersion: "config_lifecycle_event_v2",
      eventType: "price_seal",
      source: "config_lifecycle",
      sourceId: "00000000-0000-4000-8000-000000000001",
      operationId: "00000000-0000-4000-8000-000000000002",
      correlationAuditId: "00000000-0000-4000-8000-000000000003",
      operation: "price_seal",
      actor: "00000000-0000-4000-8000-000000000004",
      targetId: "00000000-0000-4000-8000-000000000005",
      reason: "seal prepared price",
      runtimeContractId: "test-runtime-v2",
      validationReportIds: ["00000000-0000-4000-8000-000000000006"],
      codeCapabilityId: "runtime-capability.deepseek-chat-v1",
      codeCapabilitySha256: "a".repeat(64),
      change: { fromStatus: "draft", toStatus: "validated" },
    });
    expect(event.source).toBe("config_lifecycle");
    const keys = adminDetailLabels("audit", adminMessages.en).map(([key]) => key);
    expect(keys).toEqual(expect.arrayContaining([
      "correlationAuditId",
      "runtimeContractId",
      "validationReportIds",
      "codeCapabilityId",
      "codeCapabilitySha256",
      "change",
    ]));
    expect(keys).not.toContain("metadata");
  });
});
