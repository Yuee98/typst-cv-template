// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getCurrentLegal: vi.fn(),
  hasAcceptedTerms: vi.fn(),
  acceptCurrentTerms: vi.fn()
}));
vi.mock("@/lib/legal/terms-acceptance", () => mocks);
import { useTermsGate } from "./use-terms-gate";
const terms = {
  external_id: "ldv_0123456789AB",
  content_digest: "a".repeat(64),
  content: {},
  renderer_contract: "legal_document_1"
};
function args(userId: string | null) {
  return {
    userId,
    supabase: {} as never,
    tTermsGate: ((key: string) => key) as never,
    onError: vi.fn()
  };
}
describe("current terms gate", () => {
  it("displays a target before accepting its exact version", async () => {
    mocks.getCurrentLegal.mockResolvedValue({
      terms
    });
    mocks.hasAcceptedTerms.mockResolvedValue(false);
    mocks.acceptCurrentTerms.mockResolvedValue(undefined);
    const {
      result
    } = renderHook(() => useTermsGate(args("A")));
    await act(() => result.current.refresh({} as never));
    expect(result.current.modalOpen).toBe(true);
    expect(result.current.terms).toEqual(terms);
    await act(() => result.current.accept());
    expect(mocks.acceptCurrentTerms).not.toHaveBeenCalled();
    act(() => result.current.setModalChecked(true));
    await act(() => result.current.accept());
    expect(mocks.acceptCurrentTerms).toHaveBeenCalledWith({}, terms, "A");
    expect(result.current.status).toBe("accepted");
  });
  it("never paints an old account's asynchronous result", async () => {
    let resolve!: (value: unknown) => void;
    mocks.getCurrentLegal.mockImplementationOnce(() => new Promise(done => {
      resolve = done;
    }));
    mocks.hasAcceptedTerms.mockResolvedValue(false);
    const {
      result,
      rerender
    } = renderHook(({
      user
    }) => useTermsGate(args(user)), {
      initialProps: {
        user: "A"
      }
    });
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.refresh({} as never);
    });
    rerender({
      user: "B"
    });
    await act(async () => {
      resolve({
        terms
      });
      await pending;
    });
    expect(result.current.terms).toBeNull();
    expect(result.current.status).toBe("unknown");
  });
});
