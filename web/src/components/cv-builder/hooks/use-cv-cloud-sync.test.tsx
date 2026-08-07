// @vitest-environment jsdom

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCvCloudActiveDocumentQuery } from "@/components/cv-builder/hooks/use-cv-cloud-document-query";
import { useCvCloudSync } from "@/components/cv-builder/hooks/use-cv-cloud-sync";
import { cloneCvData } from "@/lib/cv/cv-utils";
import { loadTrustDevice } from "@/lib/cv/encryption-storage";
import { sampleCvDataEn } from "@/lib/cv/sample-data";
import type { CvData } from "@/lib/cv/schema";
import type { CvDocumentSummary } from "@/lib/cv/storage";

vi.mock("@/components/cv-builder/hooks/use-cv-cloud-document-query", () => ({
  useCvCloudActiveDocumentQuery: vi.fn(),
}));

vi.mock("@/lib/cv/encryption-storage", () => ({
  loadTrustDevice: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useCvCloudActiveDocumentQuery).mockReturnValue({
    data: undefined,
    error: null,
  } as ReturnType<typeof useCvCloudActiveDocumentQuery>);
  vi.mocked(loadTrustDevice).mockReturnValue(false);
});

const session = { user: { id: "user-1" } } as Session;
const supabase = {} as SupabaseClient;

function summary(id: string, storageKind: CvDocumentSummary["storageKind"] = "cloud"): CvDocumentSummary {
  return {
    id,
    title: `${id} title`,
    storageKind,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
}

function renderCloudSync({
  activeDocumentId = null as string | null,
  documentsData = undefined as CvDocumentSummary[] | undefined,
  draft = null as CvData | null,
  refetchError = null as Error | null,
  sessionInitialized = true,
  sessionValue = session as Session | null,
  supabaseValue = supabase as SupabaseClient | null,
  termsRefresh = true as boolean | Promise<boolean>,
}: {
  activeDocumentId?: string | null;
  documentsData?: CvDocumentSummary[];
  draft?: CvData | null;
  refetchError?: Error | null;
  sessionInitialized?: boolean;
  sessionValue?: Session | null;
  supabaseValue?: SupabaseClient | null;
  termsRefresh?: boolean | Promise<boolean>;
} = {}) {
  const clearDraft = vi.fn();
  const loadDataIntoForm = vi.fn();
  const loadDraft = vi.fn().mockReturnValue(draft);
  const onError = vi.fn();
  const refetchDocuments = refetchError
    ? vi.fn().mockRejectedValue(refetchError)
    : vi.fn().mockResolvedValue(undefined);
  const removeCloudSummaries = vi.fn();
  const replaceCloudSummaries = vi.fn();
  const setCloudStatus = vi.fn();
  const setTermsAccepted = vi.fn();
  const setTrustDevice = vi.fn();
  const termsGate = {
    ensure: vi.fn().mockResolvedValue(true),
    refresh: vi.fn().mockReturnValue(Promise.resolve(termsRefresh)),
    reset: vi.fn(),
  };
  const upsertDocumentSummary = vi.fn();

  const hook = renderHook(() =>
    useCvCloudSync({
      locale: "en",
      activeDocumentId,
      clearDraft,
      documentsData,
      loadDataIntoForm,
      loadDraft,
      onError,
      refetchDocuments,
      removeCloudSummaries,
      replaceCloudSummaries,
      session: sessionValue,
      sessionInitialized,
      setCloudStatus,
      setTermsAccepted,
      setTrustDevice,
      supabase: supabaseValue,
      termsGate,
      upsertDocumentSummary,
    }),
  );

  return {
    clearDraft,
    hook,
    loadDataIntoForm,
    loadDraft,
    onError,
    refetchDocuments,
    removeCloudSummaries,
    replaceCloudSummaries,
    setCloudStatus,
    setTermsAccepted,
    setTrustDevice,
    termsGate,
    upsertDocumentSummary,
  };
}

describe("useCvCloudSync session boundaries", () => {
  it("clears cloud-only state on sign-out", () => {
    const h = renderCloudSync({ sessionValue: null });

    expect(h.removeCloudSummaries).toHaveBeenCalledTimes(1);
    expect(h.termsGate.reset).toHaveBeenCalledTimes(1);
    expect(h.setTermsAccepted).toHaveBeenCalledWith(false);
    expect(h.setCloudStatus).toHaveBeenCalledWith("idle");
    expect(h.refetchDocuments).not.toHaveBeenCalled();
  });

  it("restores trusted-device state and refreshes documents only after terms acceptance", async () => {
    vi.mocked(loadTrustDevice).mockReturnValue(true);
    const h = renderCloudSync();

    await waitFor(() => expect(h.refetchDocuments).toHaveBeenCalledTimes(1));

    expect(loadTrustDevice).toHaveBeenCalledWith("user-1");
    expect(h.setTrustDevice).toHaveBeenCalledWith(true);
    expect(h.termsGate.refresh).toHaveBeenCalledWith(supabase);
    expect(h.setCloudStatus).toHaveBeenCalledWith("loading");
    expect(h.setCloudStatus).toHaveBeenCalledWith("ready");
  });

  it("removes cloud summaries when current terms are not accepted", async () => {
    const h = renderCloudSync({ termsRefresh: false });

    await waitFor(() => expect(h.removeCloudSummaries).toHaveBeenCalledTimes(1));
    expect(h.refetchDocuments).not.toHaveBeenCalled();
    expect(h.setCloudStatus).toHaveBeenCalledWith("idle");
  });

  it("ignores a late terms result after unmount", async () => {
    let resolveTerms!: (accepted: boolean) => void;
    const termsRefresh = new Promise<boolean>((resolve) => {
      resolveTerms = resolve;
    });
    const h = renderCloudSync({ termsRefresh });
    h.hook.unmount();

    await act(async () => resolveTerms(true));
    expect(h.refetchDocuments).not.toHaveBeenCalled();
  });
});

describe("useCvCloudSync data and error handling", () => {
  it("loads a restored draft while retaining server data as the baseline", () => {
    const serverData = cloneCvData(sampleCvDataEn);
    const draft = cloneCvData(sampleCvDataEn);
    draft.header.name = "Unsaved draft";
    vi.mocked(useCvCloudActiveDocumentQuery).mockReturnValue({
      data: { ...summary("cloud-1"), data: serverData },
      error: null,
    } as ReturnType<typeof useCvCloudActiveDocumentQuery>);
    const restored = renderCloudSync({ documentsData: [summary("cloud-1")], draft });

    expect(restored.upsertDocumentSummary).toHaveBeenCalledWith(expect.objectContaining({ id: "cloud-1" }));
    expect(restored.loadDataIntoForm).toHaveBeenCalledWith("cloud-1", draft, { baselineData: serverData });
    expect(restored.clearDraft).not.toHaveBeenCalled();
  });

  it("drops a draft that is identical to the server document", () => {
    const serverData = cloneCvData(sampleCvDataEn);
    vi.mocked(useCvCloudActiveDocumentQuery).mockReturnValue({
      data: { ...summary("cloud-1"), data: serverData },
      error: null,
    } as ReturnType<typeof useCvCloudActiveDocumentQuery>);
    const h = renderCloudSync({ documentsData: [summary("cloud-1")], draft: serverData });

    expect(h.clearDraft).toHaveBeenCalledWith("cloud-1");
    expect(h.loadDataIntoForm).toHaveBeenCalledWith("cloud-1", serverData, { baselineData: serverData });
  });

  it("reports active-query and explicit refresh failures", async () => {
    vi.mocked(useCvCloudActiveDocumentQuery).mockReturnValue({
      data: undefined,
      error: new Error("query failed"),
    } as ReturnType<typeof useCvCloudActiveDocumentQuery>);
    const h = renderCloudSync({ sessionInitialized: false, refetchError: new Error("refresh failed") });

    expect(h.onError).toHaveBeenCalledWith("query failed");
    await act(async () => h.hook.result.current.refreshCloudDocuments());

    expect(h.setCloudStatus).toHaveBeenCalledWith("error");
    expect(h.onError).toHaveBeenCalledWith("refresh failed");
  });
});
