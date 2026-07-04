import { useQuery } from "@tanstack/react-query";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

import { listCloudCvDocuments } from "@/lib/cv/cloud-storage";
import type { CvDocumentSummary } from "@/lib/cv/storage";

export function cvCloudDocumentListQueryKey(userId: string | undefined) {
  return ["cv-documents", userId ?? "signed-out"] as const;
}

export function useCvCloudDocumentListQuery({
  enabled = false,
  session,
  supabase,
}: {
  enabled?: boolean;
  session: Session | null;
  supabase: SupabaseClient | null;
}) {
  const userId = session?.user.id;

  return useQuery<CvDocumentSummary[]>({
    enabled: Boolean(enabled && supabase && userId),
    queryKey: cvCloudDocumentListQueryKey(userId),
    queryFn: async () => {
      if (!supabase || !userId) {
        return [];
      }

      return listCloudCvDocuments(supabase);
    },
  });
}
