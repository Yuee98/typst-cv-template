// @vitest-environment jsdom

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCvCloudDocumentListQuery } from "@/components/cv-builder/hooks/use-cv-cloud-document-list-query";
import { listCloudCvDocuments } from "@/lib/cv/cloud-storage";

vi.mock("@/lib/cv/cloud-storage", () => ({
  listCloudCvDocuments: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useCvCloudDocumentListQuery refetch contract", () => {
  it("rejects production refetch failures so cloud sync cannot report false-ready", async () => {
    const failure = new Error("document list unavailable");
    vi.mocked(listCloudCvDocuments).mockRejectedValueOnce(failure);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const session = { user: { id: "user-1" } } as Session;
    const supabase = {} as SupabaseClient;
    const hook = renderHook(
      () => useCvCloudDocumentListQuery({ enabled: false, session, supabase }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      },
    );

    await act(async () => {
      await expect(hook.result.current.refetch()).rejects.toBe(failure);
    });
    expect(listCloudCvDocuments).toHaveBeenCalledWith(supabase);
    queryClient.clear();
  });
});
