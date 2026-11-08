import { describe, expect, it, vi } from "vitest";
import { acceptAiLegalDisclosure, acceptCurrentTerms, getLegalDocument, hasAcceptedTerms, legalCurrentSchema } from "./terms-acceptance";
import { legalDisplayFixture, legalDocumentFixture } from "./test-fixtures";
const user = "00000000-0000-4000-8000-000000000001",
  instance = "00000000-0000-4000-8000-000000000002";
vi.mock("@/lib/supabase/user-client", () => ({
  bindSupabaseUser: async (client: {
    user: string;
  }, expected: string) => {
    if (client.user !== expected) throw new Error("Authenticated user changed");
    return client;
  }
}));
vi.mock("@/lib/supabase/app-context", () => ({
  requireAppContext: vi.fn(),
  clientWriteContext: async () => ({
    contract_code: "cv_app_db_2",
    database_instance_id: instance,
    expected_auth_user_id: user
  })
}));
const target = legalDocumentFixture(),
  display = legalDisplayFixture();
function client() {
  return {
    user,
    rpc: vi.fn().mockResolvedValue({
      data: {
        accepted: true,
        acceptance_audit_id: "10"
      },
      error: null
    })
  };
}
describe("audited legal acceptance", () => {
  it("writes only the exact displayed document audit", async () => {
    const c = client();
    await acceptCurrentTerms(c as never, target, user);
    expect(c.rpc).toHaveBeenCalledWith("legal_accept_document", {
      p_input: {
        contract_code: "cv_app_db_2",
        database_instance_id: instance,
        expected_auth_user_id: user,
        document_id: target.document_id,
        document_audit_id: target.document_audit_id
      }
    });
  });
  it("accepts both AI documents atomically", async () => {
    const c = client();
    c.rpc.mockResolvedValue({
      data: {
        accepted: true,
        common_acceptance_audit_id: "10",
        provider_acceptance_audit_id: "11"
      },
      error: null
    });
    await acceptAiLegalDisclosure(c as never, {
      expectedUserId: user,
      legalDisplay: display
    });
    expect(c.rpc).toHaveBeenCalledExactlyOnceWith("legal_accept_ai", {
      p_input: {
        contract_code: "cv_app_db_2",
        database_instance_id: instance,
        expected_auth_user_id: user,
        common: {
          document_id: "2",
          document_audit_id: "2"
        },
        provider: {
          document_id: "3",
          document_audit_id: "3"
        }
      }
    });
  });
  it("does not write after an account switch", async () => {
    const c = client();
    await expect(acceptCurrentTerms(c as never, target, instance)).rejects.toThrow(/user changed/);
    expect(c.rpc).not.toHaveBeenCalled();
  });
  it("rejects undisplayed terms and old contracts", async () => {
    const c = client();
    await expect(acceptCurrentTerms(c as never)).rejects.toThrow(/displayed/);
    expect(legalCurrentSchema.safeParse({
      terms: {}
    }).success).toBe(false);
  });
  it("propagates a stale target rejection instead of accepting latest content", async () => {
    const c = client();
    c.rpc.mockResolvedValue({
      data: null,
      error: new Error("CONFLICT")
    });
    await expect(acceptCurrentTerms(c as never, target, user)).rejects.toThrow("CONFLICT");
    expect(c.rpc).toHaveBeenCalledTimes(1);
  });
  it("reads acceptance with a token fixed to its owner and derived digest", async () => {
    const eq = vi.fn().mockReturnThis(),
      maybeSingle = vi.fn().mockResolvedValue({
        data: {
          document_id: "1"
        },
        error: null
      });
    const from = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq,
        maybeSingle
      })
    });
    eq.mockReturnValue({
      eq,
      maybeSingle
    });
    const c = {
      ...client(),
      from
    };
    expect(await hasAcceptedTerms(c as never, target, user)).toBe(true);
    expect(eq).toHaveBeenCalledWith("content_digest", target.content_digest);
    await expect(hasAcceptedTerms(c as never, target, instance)).rejects.toThrow(/user changed/);
    expect(from).toHaveBeenCalledTimes(1);
  });
  it("rejects a historical read that returns another audit", async () => {
    const c = client();
    c.rpc.mockResolvedValue({
      data: {
        ...target,
        document_audit_id: "99"
      },
      error: null
    });
    await expect(getLegalDocument(c as never, target)).rejects.toThrow(/Invalid legal target/);
  });
});
