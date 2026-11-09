import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createAiDatabase } from "@/server/ai/database";
import { withFixture } from "./fixtures";
const enabled = process.env.CV_DB_SQL_TEST === "true" || Boolean(process.env.SUPABASE_TEST_URL);
type Option = { config_id: string; revision: string; legal_display: { common: { document_audit_id: string }; provider: { document_audit_id: string } } };
describe.skipIf(!enabled)("native currency ledger isolation", () => {
  it("freezes CNY/CNY/USD prices and analytics without FX or mixed totals", async () => {
    await withFixture(async fixture => {
      const db = createAiDatabase(fixture.client as unknown as SupabaseClient);
      const base = { contract_code: "cv_app_db_2", database_instance_id: fixture.instanceId, owner_auth_user_id: fixture.userId };
      const availability = await db.call("ai_availability", base) as { control_revision: string; configurations: Option[] };
      for (const option of availability.configurations) {
        const reservation = await db.call("ai_reserve", { ...base, client_request_key: crypto.randomUUID(), request_fingerprint: "c".repeat(64), config_id: option.config_id, expected_config_revision: option.revision, expected_control_revision: availability.control_revision, common_document_audit_id: option.legal_display.common.document_audit_id, provider_document_audit_id: option.legal_display.provider.document_audit_id }) as { request_id: string };
        const input = { ...base, request_id: reservation.request_id };
        const snapshot = await db.call("ai_execution_snapshot", input) as { price: { currency: string } };
        expect(snapshot.price.currency).toBe(option.config_id === "3" ? "USD" : "CNY");
        expect(await db.call("ai_attempt_start", { ...input, attempt_no: 1 })).toMatchObject({ may_transmit: true });
        await db.call("ai_attempt_complete", { ...input, attempt_no: 1, state: "SUCCEEDED", transmitted: true, provider_billable: true, retry_allowed: false, usage_complete: true, usage: { input_total: "3", input_standard: "2", cache_read: "1", cache_write: null, output: "4", reasoning: "2" } });
        expect(await db.call("ai_finalize", input)).toMatchObject({ state: "FINALIZED", charged: true });
      }
      const result = await fixture.analytics();
      const data = result.data as { day_basis: string; quota_day_basis: string; configurations: Array<{ currency: string; known_estimated_cost_nanos: string; settled_count: string }> };
      expect(data.day_basis).toBe("UTC_RESERVE_DAY");expect(data.quota_day_basis).toBe("UTC_PROVIDER_ADMISSION_DAY");
      const totals = new Map<string, bigint>();
      for (const row of data.configurations) { expect(row.settled_count).toBe("1");totals.set(row.currency, (totals.get(row.currency) ?? BigInt(0)) + BigInt(row.known_estimated_cost_nanos)); }
      expect(totals).toEqual(new Map([["CNY", BigInt(22)], ["USD", BigInt(11)]]));
    });
  });
});
