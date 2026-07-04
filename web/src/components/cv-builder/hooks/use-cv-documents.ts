import type { MutableRefObject } from "react";
import { useEffect, useMemo, useState } from "react";

import { summarizeLocalDocument } from "@/lib/cv/cv-utils";
import {
  loadCvLibraryCollapsed,
  sortCvDocumentSummariesByStoredOrder,
  storeCvDocumentOrder,
  storeCvLibraryCollapsed,
  type CvDocumentSummary,
  type LocalCvDocument,
} from "@/lib/cv/storage";

export function useCvDocuments({ initializedRef }: { initializedRef: MutableRefObject<boolean> }) {
  const [documents, setDocuments] = useState<CvDocumentSummary[]>([]);
  const [activeDocumentId, setActiveDocumentIdRaw] = useState<string | null>(null);
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);

  const activeDocument = useMemo(
    () => documents.find((document) => document.id === activeDocumentId) ?? null,
    [activeDocumentId, documents],
  );

  function setActiveDocumentId(id: string | null) {
    setActiveDocumentIdRaw(id);
  }

  function setOrderedDocuments(
    nextDocuments: CvDocumentSummary[] | ((current: CvDocumentSummary[]) => CvDocumentSummary[]),
  ) {
    setDocuments((current) => {
      const next = typeof nextDocuments === "function" ? nextDocuments(current) : nextDocuments;
      return sortCvDocumentSummariesByStoredOrder(next);
    });
  }

  function reorderDocuments(fromIndex: number, toIndex: number) {
    setDocuments((current) => {
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) {
        return current;
      }

      next.splice(toIndex, 0, moved);
      storeCvDocumentOrder(next);
      return next;
    });
  }

  function upsertDocumentSummary(summary: CvDocumentSummary) {
    setOrderedDocuments((current) =>
      current.some((item) => item.id === summary.id)
        ? current.map((item) => (item.id === summary.id ? summary : item))
        : [summary, ...current],
    );
  }

  function replaceLocalDocumentSummary(document: LocalCvDocument) {
    upsertDocumentSummary(summarizeLocalDocument(document));
  }

  function replaceCloudSummaries(cloudDocuments: CvDocumentSummary[]) {
    setOrderedDocuments((current) => [
      ...cloudDocuments,
      ...current.filter((document) => document.storageKind === "local"),
    ]);
  }

  function removeCloudSummaries() {
    setOrderedDocuments((current) => current.filter((document) => document.storageKind === "local"));
  }

  function loadCollapsedPreference() {
    setLibraryCollapsed(loadCvLibraryCollapsed());
  }

  function toggleLibraryCollapsed() {
    const nextCollapsed = !libraryCollapsed;
    setLibraryCollapsed(nextCollapsed);
    storeCvLibraryCollapsed(nextCollapsed);
  }

  useEffect(() => {
    if (!initializedRef.current) {
      return;
    }

    storeCvDocumentOrder(documents);
  }, [documents, initializedRef]);

  return {
    activeDocument,
    activeDocumentId,
    documents,
    libraryCollapsed,
    loadCollapsedPreference,
    removeCloudSummaries,
    reorderDocuments,
    replaceCloudSummaries,
    replaceLocalDocumentSummary,
    setActiveDocumentId,
    setOrderedDocuments,
    toggleLibraryCollapsed,
    upsertDocumentSummary,
  };
}
