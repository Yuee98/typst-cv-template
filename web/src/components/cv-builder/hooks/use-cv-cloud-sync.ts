import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useEffect, type Dispatch, type SetStateAction } from "react";

import type { CloudStatus } from "@/components/cv-builder/hooks/use-cloud-session";
import { useCvCloudActiveDocumentQuery } from "@/components/cv-builder/hooks/use-cv-cloud-document-query";
import { errorMessage } from "@/lib/cv/cv-utils";
import { loadTrustDevice } from "@/lib/cv/encryption-storage";
import type { CvData } from "@/lib/cv/schema";
import type { CvDocumentSummary } from "@/lib/cv/storage";

type CloudSyncTermsGate = {
  ensure: (client?: SupabaseClient | null) => Promise<boolean>;
  refresh: (client: SupabaseClient) => Promise<boolean>;
  reset: () => void;
};

export function useCvCloudSync({
  activeDocumentId,
  documentsData,
  loadDataIntoForm,
  loadDraft,
  onDirtyChange,
  onError,
  refetchDocuments,
  removeCloudSummaries,
  replaceCloudSummaries,
  session,
  sessionInitialized,
  setCloudStatus,
  setTermsAccepted,
  setTrustDevice,
  supabase,
  termsGate,
  upsertDocumentSummary,
}: {
  activeDocumentId: string | null;
  documentsData: CvDocumentSummary[] | undefined;
  loadDataIntoForm: (id: string, data: CvData) => void;
  loadDraft: (cvId: string) => CvData | null;
  onDirtyChange: (dirty: boolean) => void;
  onError: (message: string) => void;
  refetchDocuments: () => Promise<unknown>;
  removeCloudSummaries: () => void;
  replaceCloudSummaries: (cloudDocuments: CvDocumentSummary[]) => void;
  session: Session | null;
  sessionInitialized: boolean;
  setCloudStatus: Dispatch<SetStateAction<CloudStatus>>;
  setTermsAccepted: (accepted: boolean) => void;
  setTrustDevice: (trustDevice: boolean) => void;
  supabase: SupabaseClient | null;
  termsGate: CloudSyncTermsGate;
  upsertDocumentSummary: (summary: CvDocumentSummary) => void;
}) {
  const { data: activeCloudDocument, error: activeDocumentError } = useCvCloudActiveDocumentQuery({
    activeDocumentId,
    documentsData: documentsData ?? [],
    session,
    supabase,
  });

  async function refreshCloudDocuments(
    { skipTermsCheck = false }: { skipTermsCheck?: boolean } = {},
  ) {
    if (!supabase) {
      return;
    }

    if (!skipTermsCheck && !(await termsGate.ensure(supabase))) {
      setCloudStatus("idle");
      return;
    }

    setCloudStatus("loading");

    try {
      await refetchDocuments();
      setCloudStatus("ready");
    } catch (cloudError) {
      setCloudStatus("error");
      onError(errorMessage(cloudError));
    }
  }

  // Sync cloud summaries when list data changes.
  // documentsData is undefined before the first fetch; null check distinguishes
  // "not loaded yet" from "server returned empty list".
  useEffect(() => {
    if (documentsData == null) {
      return;
    }

    replaceCloudSummaries(documentsData);
    // replaceCloudSummaries is stable within a session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentsData]);

  // Load active cloud document into form when query data arrives.
  // Skipped when activeDocumentId already matches (selectDocument already loaded it).
  useEffect(() => {
    if (!activeCloudDocument || activeCloudDocument.id === activeDocumentId) {
      return;
    }

    upsertDocumentSummary(activeCloudDocument);
    const draft = loadDraft(activeCloudDocument.id);
    loadDataIntoForm(activeCloudDocument.id, draft ?? activeCloudDocument.data);
    if (draft) {
      onDirtyChange(true);
    }
    // loadDataIntoForm, loadDraft, etc. are stable within a session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCloudDocument, activeDocumentId]);

  // Surface active document query errors to the user.
  useEffect(() => {
    if (activeDocumentError) {
      onError(errorMessage(activeDocumentError));
    }
  }, [activeDocumentError, onError]);

  useEffect(() => {
    if (!sessionInitialized || !supabase) {
      return;
    }

    const client = supabase;
    let cancelled = false;

    if (!session) {
      removeCloudSummaries();
      termsGate.reset();
      setTermsAccepted(false);
      setCloudStatus("idle");
      return;
    }

    setTrustDevice(loadTrustDevice(session.user.id));
    void (async () => {
      const accepted = await termsGate.refresh(client);
      if (cancelled) {
        return;
      }

      if (accepted) {
        await refreshCloudDocuments({ skipTermsCheck: true });
      } else {
        removeCloudSummaries();
        setCloudStatus("idle");
      }
    })();

    return () => {
      cancelled = true;
    };
    // refreshCloudDocuments is intentionally not a dependency; this reacts only to auth session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionInitialized, session, supabase]);

  return {
    refreshCloudDocuments,
  };
}
