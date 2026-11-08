import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAiDatabase } from "@/server/ai/database";
import { executePolish } from "@/server/ai/runtime";
import { readAvailability } from "@/server/ai/availability";
import { polishPostRequestSchema, polishExpectedRouteFromAvailability } from "@/lib/polish/contract";
import { withFixture } from "./fixtures";
const enabled = process.env.CV_DB_SQL_TEST === "true" || Boolean(process.env.SUPABASE_TEST_URL);
describe.skipIf(!enabled)("typed SQL configuration + AI runtime", () => {
  it("runs each code adapter through real service-role admission, frozen snapshot, terminal facts and idempotent settlement", async () => {
    await withFixture(async fixture => {
      const db = createAiDatabase(fixture.client as unknown as SupabaseClient);
      const availability = await readAvailability(db, fixture.userId, fixture.instanceId, {}, false);
      expect(availability.configurations.map(item => item.status)).toEqual(["READY", "READY", "READY"]);
      let transmissions = 0;
      for (const config of availability.configurations) {
        const request = polishPostRequestSchema.parse({ clientRequestId: crypto.randomUUID(), granularity: "item", sectionId: "profile", language: "en", items: [{ id: "i0", kind: "profile", text: "Five years of backend development experience." }], context: { level: 0, references: [] }, expectedRoute: polishExpectedRouteFromAvailability(availability, config.configId) });
        const dependencies = { db, secret: "local-synthetic-request-hmac", prepare: (_configuration: unknown, transmit: () => void) => ({ async complete() {
          transmit(); transmissions++;
          return { schemaVersion: "polish_inference_result" as const, text: JSON.stringify({ items: [{ id: "i0", polished: request.items[0].text }] }), finishReason: "stop" as const, usage: { schemaVersion: "normalized_usage" as const, inputTotalTokens: 3, inputStandardTokens: 2, inputCacheReadTokens: 1, inputCacheWriteTokens: null, outputTokens: 4, reasoningTokens: 2, cacheUsageReporting: "unavailable" as const, usageComplete: true }, route: {} };
        } }) };
        const response = await executePolish(dependencies, fixture.userId, request, new AbortController().signal);
        expect(response.items[0].polished).toBe(request.items[0].text);
        await expect(executePolish(dependencies, fixture.userId, request, new AbortController().signal)).rejects.toMatchObject({ code: "CONFLICT", reason: "ALREADY_FINALIZED" });
      }
      expect(transmissions).toBe(3);
      const facts = await fixture.observe();
      expect(facts.requests).toHaveLength(3);
      for (const request of facts.requests as Array<Record<string, unknown>>) expect(request).toMatchObject({ state: "FINALIZED", outcome: "SUCCEEDED", charged: true, attempts: [{ attemptNo: 1, state: "SUCCEEDED", estimatedCostNanos: "11" }] });
    });
  });
});
