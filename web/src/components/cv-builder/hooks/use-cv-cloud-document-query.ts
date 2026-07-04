import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

import { loadCloudCvDocument, type CloudCvDocument } from "@/lib/cv/cloud-storage";
import type { CvDocumentSummary } from "@/lib/cv/storage";

export function cvCloudDocumentQueryKey(userId: string | undefined, id: string) {
  return ["cv-document", userId ?? "signed-out", id] as const;
}

export function useCvCloudDocumentQuery({
  session,
}: {
  session: Session | null;
}) {
  const queryClient = useQueryClient();
  const userId = session?.user.id;

  async function fetchCloudDocument(client: SupabaseClient, id: string) {
    if (!userId) {
      throw new Error("Sign in before opening this cloud CV.");
    }

    return queryClient.fetchQuery({
      queryKey: cvCloudDocumentQueryKey(userId, id),
      queryFn: () => loadCloudCvDocument(client, id),
      staleTime: 0,
    });
  }

  function setCloudDocument(id: string, document: CloudCvDocument) {
    if (!userId) {
      return;
    }

    queryClient.setQueryData(cvCloudDocumentQueryKey(userId, id), document);
  }

  function removeCloudDocument(id: string) {
    if (!userId) {
      return;
    }

    queryClient.removeQueries({ queryKey: cvCloudDocumentQueryKey(userId, id) });
  }

  return {
    fetchCloudDocument,
    setCloudDocument,
    removeCloudDocument,
  };
}

function resolveActiveCloudDocumentId(
  activeDocumentId: string | null,
  documentsData: CvDocumentSummary[],
): string | null {
  const active = documentsData.find((d) => d.id === activeDocumentId);
  if (active?.storageKind === "cloud") {
    return active.id;
  }

  if (!activeDocumentId && documentsData[0]?.storageKind === "cloud") {
    return documentsData[0].id;
  }

  return null;
}

export function useCvCloudActiveDocumentQuery({
  activeDocumentId,
  documentsData,
  session,
  supabase,
}: {
  activeDocumentId: string | null;
  documentsData: CvDocumentSummary[];
  session: Session | null;
  supabase: SupabaseClient | null;
}) {
  const userId = session?.user.id;
  const cloudDocumentId = resolveActiveCloudDocumentId(activeDocumentId, documentsData);

  return useQuery<CloudCvDocument>({
    enabled: Boolean(supabase && userId && cloudDocumentId),
    queryKey: cvCloudDocumentQueryKey(userId, cloudDocumentId ?? "__none__"),
    queryFn: () => loadCloudCvDocument(supabase!, cloudDocumentId!),
  });
}
