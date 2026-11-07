import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createAiDatabase } from "@/server/ai/database";
import { observedConfigChecks } from "@/server/admin/validation-service";
import { withProviderLiveDbFixture } from "../../../scripts/provider-live-db-fixture";

const enabled = process.env.CV_DB_SQL_TEST === "true" || Boolean(process.env.SUPABASE_TEST_URL);

describe.skipIf(!enabled)("native currency ledger isolation", () => {
  it("freezes CNY/USD prices and settles/aggregates each currency without converting or mixing amounts", async () => {
    await withProviderLiveDbFixture(async fixture => {
      // Deliberately synthetic rates and ledger events: no Provider request or invoice.
      // 2 standard + 1 cached input + 4 output => ceil(10.1) = 11 native nanos.
      const components = { INPUT_STANDARD: "1000000", INPUT_CACHE_READ: "100000", INPUT_CACHE_WRITE: "0", OUTPUT: "2000000" };
      const configurations = [
        { providerCode: "DEEPSEEK" as const, modelId: "local-synthetic-deepseek", currency: "CNY", credentialRef: "AI_PROVIDER_KEY_DEEPSEEK_CURRENCY_TEST", priceComponents: components },
        { providerCode: "MIMO" as const, modelId: "local-synthetic-mimo", currency: "CNY", credentialRef: "AI_PROVIDER_KEY_MIMO_CURRENCY_TEST", priceComponents: components },
        { providerCode: "GEMINI" as const, modelId: "gemini-3.8-flash", currency: "USD", credentialRef: "AI_PROVIDER_KEY_GEMINI_CURRENCY_TEST", priceComponents: components }
      ];
      const credentials = Object.fromEntries(configurations.map(configuration => [configuration.credentialRef, "local-no-network-dummy"]));
      const configured = await fixture.configure(configurations, profiles => observedConfigChecks(profiles, credentials));
      expect(configured.syntheticPricing).toBe(true);
      const db = createAiDatabase(fixture.client as unknown as SupabaseClient);
      const base = { contract_code: "cv_app_db_1", database_instance_id: fixture.instanceId, owner_auth_user_id: fixture.userId };
      const expectedProfiles: Array<{ profile_version_id: string; currency: string }> = [];
      const usage = { input_total: "3", input_standard: "2", cache_read: "1", cache_write: null, output: "4", reasoning: "2" };

      for (const configuration of configurations) {
        const option = configured.availability.options.find((item: { provider_code: string }) => item.provider_code === configuration.providerCode);
        expect(option.status).toBe("READY");
        const reserved = await db.call("ai_reserve", {
          ...base,
          client_request_key: randomUUID(),
          request_fingerprint: `synthetic-currency-${configuration.providerCode}`,
          selected_option_id: option.option_id,
          expected_generation: configured.availability.generation,
          expected_policy_version_id: configured.availability.policy_version_id,
          expected_profile_version_id: option.profile_version_id,
          disclosure_id: option.disclosure_id,
          content_digest: option.content_digest,
          // The price version, rather than a caller's preferred currency, controls billing.
          billing_currency: configuration.currency === "USD" ? "CNY" : "USD"
        }) as { request_id: string };
        const input = { ...base, request_id: reserved.request_id };
        const snapshot = await db.call("ai_execution_snapshot", input) as { profile_version_id: string; price: { currency: string } };
        expect(snapshot.price.currency).toBe(configuration.currency);
        expect(snapshot.profile_version_id).toBe(option.profile_version_id);
        expectedProfiles.push({ profile_version_id: snapshot.profile_version_id, currency: configuration.currency });
        const attempt = await db.call("ai_attempt_start", { ...input, attempt_no: 1 }) as { attempt_id: string; may_transmit: boolean };
        expect(attempt.may_transmit).toBe(true);
        await db.call("ai_attempt_complete", {
          ...input,
          attempt_id: attempt.attempt_id,
          state: "SUCCEEDED",
          transmitted: true,
          provider_billable: true,
          retry_allowed: false,
          usage,
          // The database recomputes costs from its frozen price and known usage.
          estimated_cost_nanos: "999999",
          known_estimated_cost_nanos: "999999",
          provider_reported_cost_nanos: null
        });
        const finalized = await db.call("ai_finalize", input);
        expect(finalized).toMatchObject({ state: "FINALIZED", outcome: "SUCCEEDED", charged: true });
        expect(await db.call("ai_finalize", input)).toMatchObject({ state: "FINALIZED", outcome: "SUCCEEDED", charged: true });
      }

      const ledger = await fixture.observe();
      expect(ledger.syntheticPricing).toBe(true);
      expect(ledger.requests).toHaveLength(3);
      for (const configuration of configurations) {
        const record = ledger.requests.find((row: { providerCode: string }) => row.providerCode === configuration.providerCode);
        expect(record).toMatchObject({ currency: configuration.currency, state: "FINALIZED", outcome: "SUCCEEDED", charged: true, estimatedCostNanos: "11", knownEstimatedCostNanos: "11", providerReportedCostNanos: null, usage });
        expect(record.attempts).toHaveLength(1);
        expect(record.attempts[0]).toMatchObject({ state: "SUCCEEDED", estimatedCostNanos: "11", knownEstimatedCostNanos: "11", usage });
      }
      expect(ledger.quota).toHaveLength(1);
      expect(ledger.quota[0]).toMatchObject({ reserved: "0", charged: "3" });

      // This is the real Admin RPC, under the fixture's authenticated AAL2 session.
      const analytics = await fixture.analytics();
      expect(analytics.profiles).toHaveLength(3);
      for (const expected of expectedProfiles) {
        const row = analytics.profiles.find((item: { profile_version_id: string }) => item.profile_version_id === expected.profile_version_id);
        expect(row).toMatchObject({ ...expected, request_count: "1", attempt_count: "1", known_estimated_cost_nanos: "11", incomplete_count: "0" });
      }
      const totals = new Map<string, bigint>();
      for (const row of analytics.profiles) totals.set(row.currency, (totals.get(row.currency) ?? BigInt(0)) + BigInt(row.known_estimated_cost_nanos));
      expect(totals).toEqual(new Map([["CNY", BigInt(22)], ["USD", BigInt(11)]]));
      expect(analytics.global).toHaveLength(1);
      expect(analytics.global[0]).toMatchObject({ admitted_count: "3", succeeded_count: "3", input_tokens: "9", output_tokens: "12" });
      expect(Object.keys(analytics.global[0]).some(key => /cost|amount|currency/.test(key))).toBe(false);
    });
  }, 30000);
});
