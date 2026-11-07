import { describe, expect, it, vi } from "vitest";
import { acceptAiLegalDisclosure, acceptCurrentTerms, legalCurrentSchema } from "./terms-acceptance";
import type { LegalDisplay } from "./legal-display";
vi.mock("@/lib/supabase/user-client", () => ({
  bindSupabaseUser: async (client: {
    auth: {
      getUser: () => Promise<{
        data: {
          user: {
            id: string;
          };
        };
      }>;
    };
  }, expectedUserId: string) => {
    const result = await client.auth.getUser();
    if (result.data.user.id !== expectedUserId) throw new Error("Authenticated user changed");
    return client;
  }
}));
const user = "00000000-0000-4000-8000-000000000001";
const instance = "00000000-0000-4000-8000-000000000002";
const language = {
  providerLabel: "Provider",
  modelLabel: "Model",
  blocks: [{
    kind: "paragraph" as const,
    text: "Terms and selected provider disclosure"
  }]
};
const display: LegalDisplay = {
  contract: "cv_app_db_1",
  disclosureId: "lds_0123456789AB",
  bundleId: "lgb_0123456789AB",
  providerId: "prv_0123456789AB",
  recipientCode: "DEEPSEEK",
  modelId: "model",
  contentDigest: "a".repeat(64),
  manifestDigest: "b".repeat(64),
  zh: language,
  en: language
};
function client() {
  const rpc = vi.fn().mockImplementation(async (name: string) => name === "app_context" ? {
    data: {
      ready: true,
      contract_code: "cv_app_db_1",
      database_instance_id: instance
    },
    error: null
  } : {
    data: {
      accepted: true,
      target_id: display.disclosureId,
      content_digest: display.contentDigest
    },
    error: null
  });
  return {
    rpc,
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: {
          user: {
            id: user
          }
        },
        error: null
      })
    }
  };
}
describe("exact current legal consent", () => {
  it("binds acceptance to the displayed disclosure and current database instance", async () => {
    const c = client();
    await acceptAiLegalDisclosure(c as never, {
      expectedUserId: user,
      legalDisplay: display
    });
    expect(c.rpc).toHaveBeenLastCalledWith("legal_accept_disclosure", {
      p_input: {
        contract_code: "cv_app_db_1",
        database_instance_id: instance,
        expected_auth_user_id: user,
        disclosure_id: display.disclosureId,
        bundle_id: display.bundleId,
        manifest_digest: display.manifestDigest,
        content_digest: display.contentDigest
      }
    });
  });
  it("does not write after an account switch", async () => {
    const c = client();
    await expect(acceptAiLegalDisclosure(c as never, {
      expectedUserId: instance,
      legalDisplay: display
    })).rejects.toThrow(/user changed/);
    expect(c.rpc).not.toHaveBeenCalled();
  });
  it("rejects a receipt for a different provider disclosure", async () => {
    const c = client();
    c.rpc.mockImplementation(async (name: string) => name === "app_context" ? {
      data: {
        ready: true,
        contract_code: "cv_app_db_1",
        database_instance_id: instance
      },
      error: null
    } : {
      data: {
        accepted: true,
        target_id: "lds_BBBBBBBBBBBB",
        content_digest: display.contentDigest
      },
      error: null
    });
    await expect(acceptAiLegalDisclosure(c as never, {
      expectedUserId: user,
      legalDisplay: display
    })).rejects.toThrow(/receipt/);
  });
  it("never accepts undisplayed current terms or old current DTOs", async () => {
    const c = client();
    await expect(acceptCurrentTerms(c as never)).rejects.toThrow(/displayed/);
    expect(c.rpc).not.toHaveBeenCalled();
    expect(legalCurrentSchema.safeParse({
      schemaVersion: "legal_current_v2"
    }).success).toBe(false);
  });
});
