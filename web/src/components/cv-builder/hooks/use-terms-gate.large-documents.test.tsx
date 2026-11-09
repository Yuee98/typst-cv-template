// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { legalDocumentFixture } from "@/lib/legal/test-fixtures";
import { useTermsGate } from "./use-terms-gate";

vi.mock("@/lib/supabase/app-context", () => ({ requireAppContext: vi.fn() }));
vi.mock("@/lib/supabase/user-client", () => ({
  bindSupabaseUser: async (client: { userId: string }, expectedUserId: string) => {
    if (client.userId !== expectedUserId) throw new Error("Authenticated user changed");
    return client;
  }
}));
afterEach(cleanup);

it("checks ordinary terms with more than 100 enabled current documents", async () => {
  const terms = legalDocumentFixture();
  const documents = [legalDocumentFixture("AI_COMMON", "2"), ...Array.from({ length: 99 }, (_, index) => legalDocumentFixture("AI_PROVIDER", String(index + 3))), terms];
  const acceptance = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { document_id: terms.document_id }, error: null })
  };
  const client = {
    userId: "10000000-0000-4000-8000-000000000001",
    rpc: vi.fn().mockResolvedValue({ data: { documents }, error: null }),
    from: vi.fn().mockReturnValue(acceptance)
  };
  const onError = vi.fn();
  const { result } = renderHook(() => useTermsGate({
    userId: client.userId, supabase: client as never, onError, tTermsGate: ((key: string) => key) as never
  }));
  let accepted = false;
  await act(async () => { accepted = await result.current.ensure(); });
  expect(accepted).toBe(true);
  expect(result.current.status).toBe("accepted");
  expect(result.current.terms).toEqual(terms);
  expect(result.current.modalOpen).toBe(false);
  expect(client.rpc).toHaveBeenCalledExactlyOnceWith("legal_current");
  expect(client.from).toHaveBeenCalledExactlyOnceWith("legal_my_acceptances");
  expect(acceptance.eq).toHaveBeenCalledWith("document_id", terms.document_id);
  expect(acceptance.eq).toHaveBeenCalledWith("content_digest", terms.content_digest);
  expect(onError).not.toHaveBeenCalled();
});
