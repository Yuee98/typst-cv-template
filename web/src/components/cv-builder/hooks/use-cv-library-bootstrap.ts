import { useEffect, type MutableRefObject } from "react";
import type { UseFormReturn } from "react-hook-form";

import { cloneCvData, summarizeLocalDocument } from "@/lib/cv/cv-utils";
import type { CvData } from "@/lib/cv/schema";
import { sampleCvData } from "@/lib/cv/sample-data";
import {
  createLocalCvDocument,
  initializeCvDocumentLibrary,
  loadCvDocument,
  saveActiveCvDocumentId,
  type CvDocumentSummary,
} from "@/lib/cv/storage";

type SetOrderedDocuments = (
  documents: CvDocumentSummary[] | ((current: CvDocumentSummary[]) => CvDocumentSummary[]),
) => void;

export function useCvLibraryBootstrap({
  form,
  initializedRef,
  loadCollapsedPreference,
  setActiveDocumentId,
  setOrderedDocuments,
}: {
  form: UseFormReturn<CvData>;
  initializedRef: MutableRefObject<boolean>;
  loadCollapsedPreference: () => void;
  setActiveDocumentId: (id: string | null) => void;
  setOrderedDocuments: SetOrderedDocuments;
}) {
  useEffect(() => {
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) {
        return;
      }

      const library = initializeCvDocumentLibrary(cloneCvData(sampleCvData));
      const activeSummary = library.documents.find((document) => document.id === library.activeDocumentId);
      const isCloudActive = activeSummary?.storageKind === "cloud" || activeSummary?.storageKind === "encrypted";
      const initialDocument = library.activeDocumentId ? loadCvDocument(library.activeDocumentId) : null;

      if (!initialDocument && library.documents.length === 0) {
        setOrderedDocuments([]);
        setActiveDocumentId(null);
        loadCollapsedPreference();
        initializedRef.current = true;
        return;
      }

      // Cloud/encrypted CVs keep their active ID; cloud sync loads them later.
      if (!initialDocument && isCloudActive && library.activeDocumentId) {
        setOrderedDocuments(library.documents);
        setActiveDocumentId(library.activeDocumentId);
        loadCollapsedPreference();
        initializedRef.current = true;
        return;
      }

      const documentToLoad = initialDocument ?? createLocalCvDocument(cloneCvData(sampleCvData), "Untitled CV");
      const nextDocuments = initialDocument
        ? library.documents
        : [summarizeLocalDocument(documentToLoad), ...library.documents];

      setOrderedDocuments(nextDocuments);
      setActiveDocumentId(documentToLoad.id);
      saveActiveCvDocumentId(documentToLoad.id);
      loadCollapsedPreference();
      form.reset(documentToLoad.data);
      initializedRef.current = true;
    });

    return () => {
      cancelled = true;
    };
    // This is a one-time local library bootstrap; helper dependencies would retrigger storage hydration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, initializedRef]);
}
