import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import type { CloudStatus } from "@/components/cv-builder/hooks/use-cloud-session";
import { errorMessage } from "@/lib/cv/cv-utils";
import { loadTrustDevice } from "@/lib/cv/encryption-storage";
import type { CloudCvDocument } from "@/lib/cv/cloud-storage";
import type { CvData } from "@/lib/cv/schema";
import type { CvDocumentSummary } from "@/lib/cv/storage";

type CloudSyncTermsGate = {
  ensure: (client?: SupabaseClient | null) => Promise<boolean>;
  refresh: (client: SupabaseClient) => Promise<boolean>;
  reset: () => void;
};

export function useCvCloudSync({
  activeDocumentIdRef,
  fetchCloudDocument,
  fetchCloudDocuments,
  loadDataIntoForm,
  loadDraft,
  onDirtyChange,
  onError,
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
  activeDocumentIdRef: MutableRefObject<string | null>;
  fetchCloudDocument: (client: SupabaseClient, id: string) => Promise<CloudCvDocument>;
  fetchCloudDocuments: (client?: SupabaseClient | null) => Promise<CvDocumentSummary[]>;
  loadDataIntoForm: (id: string, data: CvData) => void;
  loadDraft: (cvId: string) => CvData | null;
  onDirtyChange: (dirty: boolean) => void;
  onError: (message: string) => void;
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
  async function refreshCloudDocuments(
    client: SupabaseClient | null = supabase,
    { skipTermsCheck = false }: { skipTermsCheck?: boolean } = {},
  ) {
    if (!client) {
      return;
    }

    if (!skipTermsCheck && !(await termsGate.ensure(client))) {
      setCloudStatus("idle");
      return;
    }

    setCloudStatus("loading");

    try {
      const cloudDocuments = await fetchCloudDocuments(client);
      replaceCloudSummaries(cloudDocuments);

      const currentActiveId = activeDocumentIdRef.current;
      const activeIsCloud = cloudDocuments.some((document) => (
        document.id === currentActiveId && document.storageKind === "cloud"
      ));
      const activeIsEncrypted = cloudDocuments.some((document) => (
        document.id === currentActiveId && document.storageKind === "encrypted"
      ));

      if (activeIsCloud && currentActiveId) {
        const document = await fetchCloudDocument(client, currentActiveId);
        upsertDocumentSummary(document);
        const draft = loadDraft(currentActiveId);
        loadDataIntoForm(document.id, draft ?? document.data);
        if (draft) {
          onDirtyChange(true);
        }
      } else if (!activeIsEncrypted && !currentActiveId && cloudDocuments[0]?.storageKind === "cloud") {
        const document = await fetchCloudDocument(client, cloudDocuments[0].id);
        upsertDocumentSummary(document);
        loadDataIntoForm(document.id, document.data);
      }

      setCloudStatus("ready");
    } catch (cloudError) {
      setCloudStatus("error");
      onError(errorMessage(cloudError));
    }
  }

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
        await refreshCloudDocuments(client, { skipTermsCheck: true });
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
