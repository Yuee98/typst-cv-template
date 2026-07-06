import type { UseFormReturn } from "react-hook-form";
import { useLocale, useTranslations } from "next-intl";

import { useDocumentActionDialogs } from "@/components/cv-builder/hooks/use-document-action-dialogs";

import { cloneCvData, createEmptyCvData, errorMessage } from "@/lib/cv/cv-utils";
import { getSampleCvData } from "@/lib/cv/sample-data";
import type { Locale } from "@/i18n/routing";
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
  const locale = useLocale() as Locale;
  const t = useTranslations("CvDocumentActions");

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
      onError(t("selectedLoadError"));
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
    if (activeDocumentId && !(await saveCurrentDocument({ silent: true }))) {
      return;
    }

    const document = createLocalCvDocument(data, title);
    replaceLocalDocumentSummary(document);
    loadDataIntoForm(document.id, document.data);
  }

  async function createSampleDocument() {
    await createDocumentFromData(cloneCvData(getSampleCvData(locale)), t("sampleTitle"));
  }

  async function createEmptyDocument() {
    await createDocumentFromData(createEmptyCvData(locale), t("emptyTitle"));
  }

  async function renameDocument(id: string, nextTitle: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) {
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

  async function duplicateDocument(
    id: string,
    options?: { passphraseOverride?: string; title?: string },
  ) {
    const current = documents.find((document) => document.id === id);
    if (!current) return;

    try {
      const source = await storageAdapters[current.storageKind].load(current, {
        passphraseOverride: options?.passphraseOverride,
      });
      const document = createLocalCvDocument(
        source.data,
        options?.title ?? t("copyTitle", { title: source.summary.title }),
      );
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

    try {
      await storageAdapters[current.storageKind].delete(current);

      const nextDocuments = documents.filter((document) => document.id !== id);
      setOrderedDocuments(nextDocuments);

      if (id === activeDocumentId) {
        setActiveDocumentId(null);
        saveActiveCvDocumentId(null);
        form.reset(createEmptyCvData(locale));
        resetActiveDocument();
      }
    } catch (deleteError) {
      if (handleStorageDeferredError(deleteError, "unlock")) {
        return;
      }

      onError(errorMessage(deleteError));
    }
  }

  const documentActionDialogs = useDocumentActionDialogs({
    documents,
    onRename: renameDocument,
    onDuplicate: duplicateDocument,
    onDelete: deleteDocument,
  });

  function openDuplicateDialog(id: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) return;
    documentActionDialogs.openDuplicateDialog(id, t("copyTitle", { title: current.title }));
  }

  return {
    createDocumentFromData,
    createEmptyDocument,
    createSampleDocument,
    deleteDocument,
    duplicateDocument,
    renameDocument,
    selectDocument,
    ...documentActionDialogs,
    openDuplicateDialog,
  };
}
