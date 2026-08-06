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

function renderTerms({ hasSession = true } = {}) {
  const onError = vi.fn();
  const result = renderHook(
    () => {
      const tTermsGate = useTranslations("TermsGate");
      return useTermsGate({
        tTermsGate,
        hasSession,
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
    },
  );
  return { onError, result: result.result };
}

describe("useTermsGate direct behavior", () => {
  it("does not query without a signed-in session/client", async () => {
    const h = renderTerms({ hasSession: false });

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
    vi.mocked(acceptCurrentTerms).mockResolvedValue(undefined);
    const h = renderTerms();

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
});
