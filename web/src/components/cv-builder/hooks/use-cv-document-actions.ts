import type { UseFormReturn } from "react-hook-form";

import { cloneCvData, createEmptyCvData, errorMessage } from "@/lib/cv/cv-utils";
import { sampleCvData } from "@/lib/cv/sample-data";
import type { CvData } from "@/lib/cv/schema";
import {
  createLocalCvDocument,
  saveActiveCvDocumentId,
  type CvDocumentSummary,
} from "@/lib/cv/storage";
import type { CvStorageAdapters } from "@/lib/cv/storage-adapters";

export function useCvDocumentActions({
  activeDocument,
  activeDocumentId,
  documents,
  form,
  handleStorageDeferredError,
  loadDataIntoForm,
  loadDraft,
  onDirtyChange,
  onError,
  replaceLocalDocumentSummary,
  resetActiveDocument,
  saveCurrentDocument,
  setActiveDocumentId,
  setOrderedDocuments,
  storageAdapters,
  upsertDocumentSummary,
}: {
  activeDocument: CvDocumentSummary | null;
  activeDocumentId: string | null;
  documents: CvDocumentSummary[];
  form: UseFormReturn<CvData>;
  handleStorageDeferredError: (error: unknown, mode: "unlock" | "duplicate") => boolean;
  loadDataIntoForm: (id: string, data: CvData) => void;
  loadDraft: (cvId: string) => CvData | null;
  onDirtyChange: (dirty: boolean) => void;
  onError: (message: string) => void;
  replaceLocalDocumentSummary: (document: ReturnType<typeof createLocalCvDocument>) => void;
  resetActiveDocument: () => void;
  saveCurrentDocument: (options?: { silent?: boolean }) => Promise<boolean>;
  setActiveDocumentId: (id: string | null) => void;
  setOrderedDocuments: (documents: CvDocumentSummary[]) => void;
  storageAdapters: CvStorageAdapters;
  upsertDocumentSummary: (summary: CvDocumentSummary) => void;
}) {
  async function selectDocument(id: string) {
    if (id === activeDocumentId) {
      return;
    }

    // Auto-save only for local CVs when switching away.
    if (activeDocumentId && activeDocument?.storageKind === "local") {
      if (!(await saveCurrentDocument({ silent: true }))) {
        return;
      }
    }

    const documentSummary = documents.find((document) => document.id === id);
    if (!documentSummary) {
      onError("The selected CV could not be loaded.");
      return;
    }

    try {
      const document = await storageAdapters[documentSummary.storageKind].load(documentSummary);
      upsertDocumentSummary(document.summary);

      const draft = documentSummary.storageKind === "cloud" ? loadDraft(id) : null;
      loadDataIntoForm(document.summary.id, draft ?? document.data);
      if (draft) {
        onDirtyChange(true);
      }
    } catch (loadError) {
      if (handleStorageDeferredError(loadError, "unlock")) {
        return;
      }

      onError(errorMessage(loadError));
    }
  }

  async function createDocumentFromData(data: CvData, title: string) {
    if (activeDocumentId) {
      await saveCurrentDocument({ silent: true });
    }

    const document = createLocalCvDocument(data, title);
    replaceLocalDocumentSummary(document);
    loadDataIntoForm(document.id, document.data);
  }

  async function createSampleDocument() {
    await createDocumentFromData(cloneCvData(sampleCvData), "Sample CV");
  }

  async function createEmptyDocument() {
    await createDocumentFromData(createEmptyCvData(), "Untitled CV");
  }

  async function renameDocument(id: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) {
      return;
    }

    const nextTitle = window.prompt("Rename CV", current.title);
    if (!nextTitle) {
      return;
    }

    try {
      const updated = await storageAdapters[current.storageKind].rename(current, nextTitle);
      upsertDocumentSummary(updated);
    } catch (renameError) {
      if (handleStorageDeferredError(renameError, "unlock")) {
        return;
      }

      onError(errorMessage(renameError));
    }
  }

  async function duplicateDocument(id: string, passphraseOverride?: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) return;

    try {
      const source = await storageAdapters[current.storageKind].load(current, { passphraseOverride });
      const document = createLocalCvDocument(source.data, `${source.summary.title} Copy`);
      replaceLocalDocumentSummary(document);
      loadDataIntoForm(document.id, document.data);
    } catch (duplicateError) {
      if (handleStorageDeferredError(duplicateError, "duplicate")) {
        return;
      }

      onError(errorMessage(duplicateError));
    }
  }

  async function deleteDocument(id: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) {
      return;
    }

    if (!window.confirm(`Delete "${current.title}"?`)) {
      return;
    }

    try {
      await storageAdapters[current.storageKind].delete(current);

      const nextDocuments = documents.filter((document) => document.id !== id);
      setOrderedDocuments(nextDocuments);

      if (id === activeDocumentId) {
        setActiveDocumentId(null);
        saveActiveCvDocumentId(null);
        form.reset(createEmptyCvData());
        resetActiveDocument();
      }
    } catch (deleteError) {
      if (handleStorageDeferredError(deleteError, "unlock")) {
        return;
      }

      onError(errorMessage(deleteError));
    }
  }

  return {
    createDocumentFromData,
    createEmptyDocument,
    createSampleDocument,
    deleteDocument,
    duplicateDocument,
    renameDocument,
    selectDocument,
  };
}
