// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTermsGate } from "@/components/cv-builder/hooks/use-terms-gate";
import { acceptCurrentTerms, hasAcceptedCurrentTerms } from "@/lib/legal/terms-acceptance";

import messages from "../../../../messages/en.json";

vi.mock("@/lib/legal/terms-acceptance", () => ({
  acceptCurrentTerms: vi.fn(),
  hasAcceptedCurrentTerms: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  window.sessionStorage.clear();
});

const fakeSupabase = {} as SupabaseClient;

function renderTerms({ userId = "user-a" as string | null } = {}) {
  const onError = vi.fn();
  const hook = renderHook(
    ({ currentUserId }: { currentUserId: string | null }) => {
      const tTermsGate = useTranslations("TermsGate");
      return useTermsGate({
        tTermsGate,
        userId: currentUserId,
        onError,
        supabase: fakeSupabase,
      });
    },
    {
      wrapper: ({ children }) => (
        <NextIntlClientProvider locale="en" messages={messages}>
          {children}
        </NextIntlClientProvider>
      ),
      initialProps: { currentUserId: userId },
    },
  );
  return { ...hook, onError };
}

describe("useTermsGate direct behavior", () => {
  it("does not query without a signed-in session/client", async () => {
    const h = renderTerms({ userId: null });

    let accepted = true;
    await act(async () => {
      accepted = await h.result.current.ensure();
    });

    expect(accepted).toBe(false);
    expect(hasAcceptedCurrentTerms).not.toHaveBeenCalled();
    expect(h.result.current.status).toBe("unknown");
  });

  it("opens the acceptance modal when current terms are not accepted", async () => {
    vi.mocked(hasAcceptedCurrentTerms).mockResolvedValueOnce(false);
    const h = renderTerms();

    await act(async () => {
      await h.result.current.refresh(fakeSupabase);
    });

    expect(h.result.current.status).toBe("required");
    expect(h.result.current.modalOpen).toBe(true);
    expect(h.result.current.modalChecked).toBe(false);
  });

  it("accepts current terms only after the checkbox is checked", async () => {
    vi.mocked(hasAcceptedCurrentTerms).mockResolvedValueOnce(false);
    vi.mocked(acceptCurrentTerms).mockResolvedValue(undefined);
    const h = renderTerms();

    await act(async () => {
      await h.result.current.refresh(fakeSupabase);
    });

    let accepted = true;
    await act(async () => {
      accepted = await h.result.current.accept();
    });
    expect(accepted).toBe(false);
    expect(acceptCurrentTerms).not.toHaveBeenCalled();
    expect(h.result.current.modalError).toContain("Check");

    act(() => {
      h.result.current.setModalChecked(true);
    });
    await act(async () => {
      accepted = await h.result.current.accept();
    });

    expect(accepted).toBe(true);
    expect(acceptCurrentTerms).toHaveBeenCalledWith(fakeSupabase);
    expect(h.result.current.status).toBe("accepted");
    expect(h.result.current.modalOpen).toBe(false);
  });

  it("consumes a pending acceptance after a successful record", async () => {
    vi.mocked(hasAcceptedCurrentTerms).mockResolvedValueOnce(false);
    vi.mocked(acceptCurrentTerms).mockResolvedValue(undefined);
    const h = renderTerms();

    act(() => {
      h.result.current.markPendingAcceptance();
    });
    await act(async () => {
      await h.result.current.refresh(fakeSupabase, { showModal: false });
    });

    expect(acceptCurrentTerms).toHaveBeenCalledWith(fakeSupabase);
    expect(h.result.current.status).toBe("accepted");
    expect(window.sessionStorage.getItem("typst-cv-builder:pending-terms-acceptance")).toBeNull();
  });

  it("reports refresh failures while leaving the gate unknown", async () => {
    vi.mocked(hasAcceptedCurrentTerms).mockRejectedValueOnce(new Error("terms unavailable"));
    const h = renderTerms();

    await act(async () => {
      await h.result.current.refresh(fakeSupabase);
    });

    expect(h.result.current.status).toBe("unknown");
    expect(h.onError).toHaveBeenCalledWith("terms unavailable");
  });

  it("makes an accepted status unknown immediately when the account changes", async () => {
    vi.mocked(hasAcceptedCurrentTerms)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const h = renderTerms();

    await act(async () => {
      await h.result.current.refresh(fakeSupabase);
    });
    expect(h.result.current.status).toBe("accepted");

    h.rerender({ currentUserId: "user-b" });
    expect(h.result.current.status).toBe("unknown");

    await act(async () => {
      await h.result.current.refresh(fakeSupabase, { showModal: false });
    });
    expect(h.result.current.status).toBe("required");
  });

  it("ignores a terms result that settles after the account changes", async () => {
    let resolveAccepted!: (accepted: boolean) => void;
    vi.mocked(hasAcceptedCurrentTerms).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveAccepted = resolve;
      }),
    );
    const h = renderTerms();
    let refreshPromise!: Promise<boolean>;

    act(() => {
      refreshPromise = h.result.current.refresh(fakeSupabase);
    });
    h.rerender({ currentUserId: "user-b" });
    expect(h.result.current.status).toBe("unknown");

    await act(async () => {
      resolveAccepted(true);
      await refreshPromise;
    });

    expect(h.result.current.status).toBe("unknown");
    expect(h.onError).not.toHaveBeenCalled();
  });
});
