import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from "react";

import type { CloudStatus } from "@/components/cv-builder/hooks/use-cloud-session";
import { useCvCloudActiveDocumentQuery } from "@/components/cv-builder/hooks/use-cv-cloud-document-query";
import { isDraftRedundant } from "@/lib/cv/baseline";
import { errorMessage } from "@/lib/cv/cv-utils";
import { loadTrustDevice } from "@/lib/cv/encryption-storage";
import type { Locale } from "@/i18n/routing";
import type { CvData } from "@/lib/cv/schema";
import type { CvDocumentSummary } from "@/lib/cv/storage";

type CloudSyncTermsGate = {
  ensure: (client?: SupabaseClient | null) => Promise<boolean>;
  refresh: (client: SupabaseClient) => Promise<boolean>;
  reset: () => void;
  status: "unknown" | "accepted" | "required";
};

export function useCvCloudSync({
  locale,
  activeDocumentId,
  clearDraft,
  documentsData,
  loadDataIntoForm,
  loadDraft,
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
  locale: Locale;
  activeDocumentId: string | null;
  clearDraft: (cvId: string) => void;
  documentsData: CvDocumentSummary[] | undefined;
  loadDataIntoForm: (id: string, data: CvData, options?: { baselineData?: CvData }) => void;
  loadDraft: (cvId: string) => CvData | null;
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
  const sessionUserId = session?.user.id ?? null;
  const syncOwnerRef = useRef(sessionUserId);
  const syncGenerationRef = useRef(0);
  useLayoutEffect(() => {
    if (syncOwnerRef.current !== sessionUserId) {
      syncOwnerRef.current = sessionUserId;
      syncGenerationRef.current += 1;
    }
  }, [sessionUserId]);

  function ownsSync(generation: number, ownerId: string | null) {
    return syncGenerationRef.current === generation && syncOwnerRef.current === ownerId;
  }

  const { data: activeCloudDocument, error: activeDocumentError } = useCvCloudActiveDocumentQuery({
    activeDocumentId,
    documentsData: termsGate.status === "accepted" ? (documentsData ?? []) : [],
    locale,
    session,
    supabase,
  });

  async function refetchForOwner(generation: number, ownerId: string) {
    if (!ownsSync(generation, ownerId)) {
      return;
    }

    setCloudStatus("loading");

    try {
      await refetchDocuments();
      if (!ownsSync(generation, ownerId)) {
        return;
      }
      setCloudStatus("ready");
    } catch (cloudError) {
      if (!ownsSync(generation, ownerId)) {
        return;
      }
      setCloudStatus("error");
      onError(errorMessage(cloudError));
    }
  }

  async function refreshCloudDocuments(
    { skipTermsCheck = false }: { skipTermsCheck?: boolean } = {},
  ) {
    const ownerId = sessionUserId;
    const generation = syncGenerationRef.current;
    if (!supabase || !ownerId) {
      return;
    }

    if (!skipTermsCheck) {
      const accepted = await termsGate.ensure(supabase);
      if (!ownsSync(generation, ownerId)) {
        return;
      }
      if (!accepted) {
        setCloudStatus("idle");
        return;
      }
    }

    await refetchForOwner(generation, ownerId);
  }

  // Sync cloud summaries when list data changes.
  // documentsData is undefined before the first fetch; null check distinguishes
  // "not loaded yet" from "server returned empty list".
  useEffect(() => {
    if (documentsData == null || !sessionUserId || termsGate.status !== "accepted") {
      return;
    }

    replaceCloudSummaries(documentsData);
    // replaceCloudSummaries is stable within a session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentsData, sessionUserId, termsGate.status]);

  // Load active cloud document into form when query data arrives.
  // Skipped when activeDocumentId already matches (selectDocument already loaded it).
  useEffect(() => {
    if (
      termsGate.status !== "accepted" ||
      !sessionUserId ||
      !activeCloudDocument ||
      activeCloudDocument.id === activeDocumentId
    ) {
      return;
    }

    upsertDocumentSummary(activeCloudDocument);
    const draft = loadDraft(activeCloudDocument.id);
    // A draft identical to the server data is redundant; drop it.
    if (isDraftRedundant(draft, activeCloudDocument.data)) {
      clearDraft(activeCloudDocument.id);
    }
    // The baseline always stays at the server data, even when a draft is
    // restored into the form — a draft must never become the baseline.
    loadDataIntoForm(activeCloudDocument.id, draft ?? activeCloudDocument.data, {
      baselineData: activeCloudDocument.data,
    });
    // loadDataIntoForm, loadDraft, etc. are stable within a session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCloudDocument, activeDocumentId, sessionUserId, termsGate.status]);

  // Surface active document query errors to the user.
  useEffect(() => {
    if (activeDocumentError && sessionUserId && termsGate.status === "accepted") {
      onError(errorMessage(activeDocumentError));
    }
  }, [activeDocumentError, onError, sessionUserId, termsGate.status]);

  useEffect(() => {
    if (!sessionInitialized || !supabase) {
      return;
    }

    const client = supabase;
    let cancelled = false;
    const generation = syncGenerationRef.current;
    const ownerId = sessionUserId;

    if (!ownerId) {
      removeCloudSummaries();
      termsGate.reset();
      setTermsAccepted(false);
      setCloudStatus("idle");
      return;
    }

    removeCloudSummaries();
    termsGate.reset();
    setTermsAccepted(false);
    setCloudStatus("idle");
    setTrustDevice(loadTrustDevice(ownerId));
    void (async () => {
      const accepted = await termsGate.refresh(client);
      if (cancelled || !ownsSync(generation, ownerId)) {
        return;
      }

      if (accepted) {
        await refetchForOwner(generation, ownerId);
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
  }, [sessionInitialized, sessionUserId, supabase]);

  return {
    refreshCloudDocuments,
  };
}
