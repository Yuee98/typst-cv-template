import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { cleanup, renderHook } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, vi } from "vitest";

import { useCvCloudActiveDocumentQuery } from "@/components/cv-builder/hooks/use-cv-cloud-document-query";
import { useCvCloudSync } from "@/components/cv-builder/hooks/use-cv-cloud-sync";
import type { CloudCvDocument } from "@/lib/cv/cloud-storage";
import { loadTrustDevice } from "@/lib/cv/encryption-storage";
import type { CvData } from "@/lib/cv/schema";
import type { CvDocumentSummary } from "@/lib/cv/storage";

vi.mock("@/components/cv-builder/hooks/use-cv-cloud-document-query", () => ({
  useCvCloudActiveDocumentQuery: vi.fn(),
}));

vi.mock("@/lib/cv/encryption-storage", () => ({
  loadTrustDevice: vi.fn(),
}));

export const loadTrustDeviceMock = vi.mocked(loadTrustDevice);

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockActiveDocumentQuery({ data: undefined, error: null });
  loadTrustDeviceMock.mockReturnValue(false);
});

export const session = { user: { id: "user-1" } } as Session;
export const sessionB = { user: { id: "user-2" } } as Session;
export const supabase = {} as SupabaseClient;

export function cloudSummary(
  id: string,
): Omit<CloudCvDocument, "data"> {
  return {
    id,
    title: `${id} title`,
    storageKind: "cloud",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
}

export function mockActiveDocumentQuery(
  value: Partial<ReturnType<typeof useCvCloudActiveDocumentQuery>>,
) {
  vi.mocked(useCvCloudActiveDocumentQuery).mockReturnValue(
    value as ReturnType<typeof useCvCloudActiveDocumentQuery>,
  );
}

export function renderCloudSync({
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
    status: "accepted" as const,
  };
  const upsertDocumentSummary = vi.fn();
  const layoutBoundaryObservations: number[] = [];

  const hook = renderHook(({ currentSession }: { currentSession: Session | null }) => {
    const cloudSync = useCvCloudSync({
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
      session: currentSession,
      sessionInitialized,
      setCloudStatus,
      setTermsAccepted,
      setTrustDevice,
      supabase: supabaseValue,
      termsGate,
      upsertDocumentSummary,
    });
    useLayoutEffect(() => {
      layoutBoundaryObservations.push(removeCloudSummaries.mock.calls.length);
    }, [currentSession]);
    return cloudSync;
  }, { initialProps: { currentSession: sessionValue } });

  return {
    clearDraft,
    hook,
    loadDataIntoForm,
    loadDraft,
    layoutBoundaryObservations,
    onError,
    refetchDocuments,
    rerenderSession(currentSession: Session | null) {
      hook.rerender({ currentSession });
    },
    removeCloudSummaries,
    replaceCloudSummaries,
    setCloudStatus,
    setTermsAccepted,
    setTrustDevice,
    termsGate,
    upsertDocumentSummary,
  };
}
