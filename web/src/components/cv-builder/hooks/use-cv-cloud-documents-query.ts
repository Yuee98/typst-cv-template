import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

import {
  listCloudCvDocuments,
  loadCloudCvDocument,
  type CloudCvDocument,
} from "@/lib/cv/cloud-storage";
import type { CvDocumentSummary } from "@/lib/cv/storage";

export function cvCloudDocumentsQueryKey(userId: string | undefined) {
  return ["cv-documents", userId ?? "signed-out"] as const;
}

export function cvCloudDocumentQueryKey(userId: string | undefined, id: string) {
  return ["cv-document", userId ?? "signed-out", id] as const;
}

export function useCvCloudDocumentsQuery({
  enabled = false,
  session,
  supabase,
}: {
  enabled?: boolean;
  session: Session | null;
  supabase: SupabaseClient | null;
}) {
  const queryClient = useQueryClient();
  const userId = session?.user.id;
  const documentsQuery = useQuery({
    enabled: Boolean(enabled && supabase && userId),
    queryKey: cvCloudDocumentsQueryKey(userId),
    queryFn: async () => {
      if (!supabase || !userId) {
        return [];
      }

      return listCloudCvDocuments(supabase);
    },
  });

  async function fetchCloudDocuments(client: SupabaseClient | null = supabase) {
    if (!client || !userId) {
      return [];
    }

    return queryClient.fetchQuery({
      queryKey: cvCloudDocumentsQueryKey(userId),
      queryFn: () => listCloudCvDocuments(client),
      staleTime: 0,
    });
  }

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

  function setCloudDocuments(updater: (current: CvDocumentSummary[]) => CvDocumentSummary[]) {
    if (!userId) {
      return;
    }

    queryClient.setQueryData<CvDocumentSummary[]>(
      cvCloudDocumentsQueryKey(userId),
      (current) => updater(current ?? []),
    );
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
    documentsQuery,
    fetchCloudDocument,
    fetchCloudDocuments,
    removeCloudDocument,
    setCloudDocument,
    setCloudDocuments,
  };
}
