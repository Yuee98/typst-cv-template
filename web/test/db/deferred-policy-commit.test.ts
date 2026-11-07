import { describe, expect, it } from "vitest";
import { observedConfigChecks } from "@/server/admin/validation-service";
import { withProviderLiveDbFixture } from "../../../scripts/provider-live-db-fixture";
const enabled = process.env.CV_DB_SQL_TEST === "true" || Boolean(process.env.SUPABASE_TEST_URL);
describe.skipIf(!enabled)("authenticated deferred policy constraints", () => {
  it("commits an Admin RPC under authenticated and rejects incomplete graphs after role restoration", async () => {
    await withProviderLiveDbFixture(async fixture => {
      const components = {
        INPUT_STANDARD: "1000000",
        INPUT_CACHE_READ: "100000",
        INPUT_CACHE_WRITE: "0",
        OUTPUT: "2000000"
      };
      const configured = await fixture.configure([{
        providerCode: "DEEPSEEK",
        modelId: "local-synthetic-deepseek",
        credentialRef: "AI_PROVIDER_KEY_DEEPSEEK_COMMIT_TEST",
        priceComponents: components
      }, {
        providerCode: "MIMO",
        modelId: "local-synthetic-mimo",
        credentialRef: "AI_PROVIDER_KEY_MIMO_COMMIT_TEST",
        priceComponents: components
      }, {
        providerCode: "GEMINI",
        modelId: "gemini-3.8-flash",
        credentialRef: "AI_PROVIDER_KEY_GEMINI_COMMIT_TEST",
        priceComponents: components
      }], profiles => {
        expect(profiles.length).toBeGreaterThan(0);
        return observedConfigChecks(profiles, {
          AI_PROVIDER_KEY_DEEPSEEK_COMMIT_TEST: "local-no-network-dummy",
          AI_PROVIDER_KEY_MIMO_COMMIT_TEST: "local-no-network-dummy",
          AI_PROVIDER_KEY_GEMINI_COMMIT_TEST: "local-no-network-dummy"
        });
      });
      expect(configured.availability.enabled).toBe(true);
      expect(configured.availability.options.map((option: {
        status: string;
      }) => option.status)).toEqual(["READY", "READY", "READY"]);
      expect(await fixture.verifyPolicyCommits()).toEqual({
        validCommitted: true,
        invalidCommitRejected: true,
        immediateCheckRejected: true
      });
      const observed = await fixture.observe();
      expect(observed.requests).toEqual([]);
      expect(observed.quota).toEqual([]);
    });
  }, 30000);
});
