import { describe, expect, it } from "vitest";
import { configurations, withFixture } from "./fixtures";
const enabled = process.env.CV_DB_SQL_TEST === "true" || Boolean(process.env.SUPABASE_TEST_URL);
describe.skipIf(!enabled)("current Admin aggregates through authenticated SQL transactions", () => {
  it("atomically saves config and price with one CAS revision and an idempotent typed receipt", async () => {
    await withFixture(async fixture => {
      const read = await fixture.admin("admin_read", { expected_environment: "LOCAL", section: "configurations" });
      const row = (read.data as { records: Array<Record<string, unknown>> }).records[0];
      const operationKey = crypto.randomUUID();
      const input: Record<string, unknown> = { ...row, expected_revision: row.revision, price: { ...configurations[0].price, currency: "USD" }, operation_key: operationKey };
      delete input.revision;
      const receipt = await fixture.admin("admin_configuration_save", input);
      expect(receipt).toMatchObject({ operation: "configuration_save", entity_kind: "configurations", entity_id: row.id, revision: "2" });
      expect(await fixture.admin("admin_configuration_save", input)).toEqual(receipt);
      expect(() => fixture.admin("admin_configuration_save", { ...input, operation_key: crypto.randomUUID() })).toThrow("CONFLICT/REVISION_CHANGED");
      const latest = await fixture.admin("admin_read", { expected_environment: "LOCAL", section: "configurations", id: row.id });
      expect(latest.data).toMatchObject({ revision: "2", price: { currency: "USD" } });
      const documents = await fixture.admin("admin_read", { expected_environment: "LOCAL", section: "configurations", kind: "legal_documents" });
      const terms = (documents.data as { records: Array<{ kind: string; document_id: string }> }).records.find(document => document.kind === "TERMS")!;
      expect(() => fixture.admin("admin_configuration_save", { ...input, expected_revision: "2", operation_key: crypto.randomUUID(), legal_document_id: terms.document_id })).toThrow("INVALID_REQUEST/LEGAL_DOCUMENT_UNAVAILABLE");
      const unchanged = await fixture.admin("admin_read", { expected_environment: "LOCAL", section: "configurations", id: row.id });
      expect(unchanged.data).toEqual(latest.data);
    });
  });
  it("commits a complete rule as authenticated and rejects malformed replacements without partial members", async () => {
    await withFixture(async fixture => {
      const page = await fixture.admin("admin_read", { expected_environment: "LOCAL", section: "rules" });
      const rule = (page.data as { records: Array<Record<string, unknown>> }).records[0];
      const input: Record<string, unknown> = { ...rule, expected_revision: rule.revision };
      delete input.revision;
      expect(await fixture.admin("admin_rule_save", input)).toMatchObject({ entity_kind: "rules", revision: "2" });
      expect(() => fixture.admin("admin_rule_save", { ...input, expected_revision: "2", members: [{ config_id: "1", is_default: false }] })).toThrow("INVALID_REQUEST/EXACTLY_ONE_DEFAULT_REQUIRED");
      const latest = await fixture.admin("admin_read", { expected_environment: "LOCAL", section: "rules", id: rule.id });
      expect(latest.data).toMatchObject({ revision: "2", members: rule.members });
    });
  });
  it("makes emergency disable stale-safe, preserves old cancellation after reopen, and never reexecutes an old receipt", async () => {
    await withFixture(async fixture => {
      const client = fixture.client;
      const base = { contract_code: "cv_app_db_2", database_instance_id: fixture.instanceId, owner_auth_user_id: fixture.userId };
      const read = await client.rpc("ai_availability", { p_input: base });
      const availability = read.data as { control_revision: string; configurations: Array<{ config_id: string; revision: string; legal_display: { common: { document_audit_id: string }; provider: { document_audit_id: string } } }> };
      const option = availability.configurations[0];
      const reserved = await client.rpc("ai_reserve", { p_input: { ...base, client_request_key: crypto.randomUUID(), request_fingerprint: "d".repeat(64), config_id: option.config_id, expected_config_revision: option.revision, expected_control_revision: availability.control_revision, common_document_audit_id: option.legal_display.common.document_audit_id, provider_document_audit_id: option.legal_display.provider.document_audit_id } });
      expect(reserved.error).toBeNull();
      const requestId = (reserved.data as { request_id: string }).request_id;
      const operationKey = crypto.randomUUID();
      const receipt = await fixture.admin("admin_ai_disable", { expected_revision: "1", operation_key: operationKey });
      expect(receipt.operation).toBe("ai_disable");
      const context = await fixture.admin("admin_read", { expected_environment: "LOCAL", section: "controls" });
      const control = (context.context as { control: Record<string, unknown> }).control;
      expect(control.enabled).toBe(false);
      await fixture.admin("admin_ai_update", { ...control, expected_revision: control.revision, enabled: true });
      expect(await fixture.admin("admin_ai_disable", { expected_revision: "1", operation_key: operationKey })).toEqual(receipt);
      const reopened = await fixture.admin("admin_read", { expected_environment: "LOCAL", section: "controls" });
      expect(reopened.context).toMatchObject({ control: { enabled: true } });
      const start = await client.rpc("ai_attempt_start", { p_input: { ...base, request_id: requestId, attempt_no: 1 } });
      expect(start.error).toMatchObject({ message: "UNAVAILABLE", details: "ADMISSION_CLOSED" });
    });
  });

  it("persists cancellation when a selected configuration is disabled and never revives its old reservation", async () => {
    await withFixture(async fixture => {
      const base = { contract_code: "cv_app_db_2", database_instance_id: fixture.instanceId, owner_auth_user_id: fixture.userId };
      const availability = (await fixture.client.rpc("ai_availability", { p_input: base })).data as { control_revision: string; configurations: Array<{ config_id: string; revision: string; legal_display: { common: { document_audit_id: string }; provider: { document_audit_id: string } } }> };
      const option = availability.configurations[0];
      const reserved = await fixture.client.rpc("ai_reserve", { p_input: { ...base, client_request_key: crypto.randomUUID(), request_fingerprint: "e".repeat(64), config_id: option.config_id, expected_config_revision: option.revision, expected_control_revision: availability.control_revision, common_document_audit_id: option.legal_display.common.document_audit_id, provider_document_audit_id: option.legal_display.provider.document_audit_id } });
      expect(reserved.error).toBeNull();
      const requestId = (reserved.data as { request_id: string }).request_id;
      const read = await fixture.admin("admin_read", { expected_environment: "LOCAL", section: "configurations", id: option.config_id });
      const row = read.data as Record<string, unknown>;
      const disabled = await fixture.admin("admin_configuration_save", { ...row, expected_revision: row.revision, enabled: false });
      const snapshot = await fixture.client.rpc("ai_execution_snapshot", { p_input: { ...base, request_id: requestId } });
      expect(snapshot.error).toBeNull();expect(snapshot.data).toMatchObject({ time_canceled: expect.any(String), config_revision: option.revision });
      await fixture.admin("admin_configuration_save", { ...row, expected_revision: disabled.revision, enabled: true });
      const start = await fixture.client.rpc("ai_attempt_start", { p_input: { ...base, request_id: requestId, attempt_no: 1 } });
      expect(start.error).toMatchObject({ message: "UNAVAILABLE", details: "ADMISSION_CLOSED" });
      const final = await fixture.client.rpc("ai_finalize", { p_input: { ...base, request_id: requestId } });
      expect(final.error).toBeNull();expect(final.data).toMatchObject({ state: "FINALIZED", outcome: "RELEASED", charged: false });
    });
  });

});
