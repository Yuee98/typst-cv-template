import type { UseFormReturn } from "react-hook-form";
import { useLayoutEffect, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";

import { useDocumentActionDialogs } from "@/components/cv-builder/hooks/use-document-action-dialogs";

import { isDraftRedundant } from "@/lib/cv/baseline";
import { cloneCvData, createEmptyCvData, errorMessage } from "@/lib/cv/cv-utils";
import { getSampleCvData } from "@/lib/cv/sample-data";
import { captureEncryptionPasswordOwner } from "@/lib/cv/encryption-storage";
import type { Locale } from "@/i18n/routing";
import type { CvData } from "@/lib/cv/schema";
import {
  createLocalCvDocument,
  saveActiveCvDocumentId,
  type CvDocumentSummary,
} from "@/lib/cv/storage";
import type { CvStorageAdapters } from "@/lib/cv/storage-adapters";

export function useCvDocumentActions({
  userId,
  activeDocument,
  activeDocumentId,
  clearDraft,
  documents,
  form,
  handleStorageDeferredError,
  loadDataIntoForm,
  loadDraft,
  onError,
  replaceLocalDocumentSummary,
  resetActiveDocument,
  saveCurrentDocument,
  setActiveDocumentId,
  setOrderedDocuments,
  storageAdapters,
  upsertDocumentSummary,
}: {
  userId: string | null;
  activeDocument: CvDocumentSummary | null;
  activeDocumentId: string | null;
  clearDraft: (cvId: string) => void;
  documents: CvDocumentSummary[];
  form: UseFormReturn<CvData>;
  handleStorageDeferredError: (error: unknown, mode: "unlock" | "duplicate") => boolean;
  loadDataIntoForm: (id: string, data: CvData, options?: { baselineData?: CvData; cloudRevision?: string }) => void;
  loadDraft: (cvId: string) => CvData | null;
  onError: (message: string) => void;
  replaceLocalDocumentSummary: (document: ReturnType<typeof createLocalCvDocument>) => void;
  resetActiveDocument: () => void;
  saveCurrentDocument: (options?: { silent?: boolean }) => Promise<boolean>;
  setActiveDocumentId: (id: string | null) => void;
  setOrderedDocuments: (documents: CvDocumentSummary[] | ((current: CvDocumentSummary[]) => CvDocumentSummary[])) => void;
  storageAdapters: CvStorageAdapters;
  upsertDocumentSummary: (summary: CvDocumentSummary) => void;
}) {
  const locale = useLocale() as Locale;
  const t = useTranslations("CvDocumentActions");
  const ownerRef = useRef({ userId });
  const activeDocumentIdRef = useRef(activeDocumentId);
  const formIntentRef = useRef<{ documentId?: string }>({});
  useLayoutEffect(() => {
    if (ownerRef.current.userId !== userId) ownerRef.current = { userId };
    activeDocumentIdRef.current = activeDocumentId;
  }, [userId, activeDocumentId]);
  function actorGuard() {
    const actor = ownerRef.current;
    const ownsPassword = actor.userId ? captureEncryptionPasswordOwner(actor.userId) : () => true;
    return () => ownsPassword() && ownerRef.current === actor && actor.userId === userId;
  }
  function formIntentGuard(documentId?: string) {
    const ownsActor = actorGuard();
    const intent = { documentId };
    if (ownsActor()) formIntentRef.current = intent;
    return () => ownsActor() && formIntentRef.current === intent;
  }

  async function selectDocument(id: string) {
    // Even selecting the current document cancels any older pending transition.
    const ownsIntent = formIntentGuard(id);
    if (!ownsIntent()) return;
    if (id === activeDocumentId) {
      return;
    }

    // Auto-save only for local CVs when switching away.
    if (activeDocumentId && activeDocument?.storageKind === "local") {
      if (!(await saveCurrentDocument({ silent: true }))) {
        return;
      }
    }
    if (!ownsIntent()) return;

    const documentSummary = documents.find((document) => document.id === id);
    if (!documentSummary) {
      onError(t("selectedLoadError"));
      return;
    }

    try {
      const document = await storageAdapters[documentSummary.storageKind].load(documentSummary);
      if (!ownsIntent()) return;
      upsertDocumentSummary(document.summary);

      const draft = documentSummary.storageKind === "cloud" ? loadDraft(id) : null;
      // A draft identical to the server data is redundant; drop it.
      if (isDraftRedundant(draft, document.data)) {
        clearDraft(id);
      }
      // Same rule as the cloud sync path: a recovered draft fills the form,
      // but the persisted (server) data stays the baseline.
      loadDataIntoForm(document.summary.id, draft ?? document.data, {
        baselineData: document.data,
        ...(document.cloudRevision === undefined ? {} : { cloudRevision: document.cloudRevision }),
      });
    } catch (loadError) {
      if (!ownsIntent()) return;
      if (handleStorageDeferredError(loadError, "unlock")) {
        return;
      }

      onError(errorMessage(loadError));
    }
  }

  async function createDocumentFromData(data: CvData, title: string) {
    const ownsIntent = formIntentGuard();
    if (!ownsIntent()) return;
    if (activeDocumentId && !(await saveCurrentDocument({ silent: true }))) {
      return;
    }
    if (!ownsIntent()) return;

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
    const ownsActor = actorGuard();
    const current = documents.find((document) => document.id === id);
    if (!current) {
      return;
    }

    try {
      const updated = await storageAdapters[current.storageKind].rename(current, nextTitle);
      if (!ownsActor()) return;
      upsertDocumentSummary(updated);
    } catch (renameError) {
      if (!ownsActor()) return;
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
    const ownsIntent = formIntentGuard();
    if (!ownsIntent()) return;
    const current = documents.find((document) => document.id === id);
    if (!current) return;

    try {
      const source = await storageAdapters[current.storageKind].load(current, {
        passphraseOverride: options?.passphraseOverride,
      });
      if (!ownsIntent()) return;
      const document = createLocalCvDocument(
        source.data,
        options?.title ?? t("copyTitle", { title: source.summary.title }),
      );
      replaceLocalDocumentSummary(document);
      loadDataIntoForm(document.id, document.data);
    } catch (duplicateError) {
      if (!ownsIntent()) return;
      if (handleStorageDeferredError(duplicateError, "duplicate")) {
        return;
      }

      onError(errorMessage(duplicateError));
    }
  }

  async function deleteDocument(id: string) {
    const ownsActor = actorGuard();
    const startingIntent = formIntentRef.current;
    const current = documents.find((document) => document.id === id);
    if (!current) {
      return;
    }

    try {
      await storageAdapters[current.storageKind].delete(current);
      if (!ownsActor()) return;
      setOrderedDocuments(currentDocuments => currentDocuments.filter(document => document.id !== id));

      // Removing a list entry must not reset a newer document's form or pending load.
      // Reaffirming the same active document still allows its deletion to clear it.
      const latestIntent = formIntentRef.current;
      const shouldResetForm = id === activeDocumentIdRef.current &&
        (latestIntent === startingIntent || latestIntent.documentId === id);
      // A load that already read this deleted document cannot adopt its stale snapshot.
      if (latestIntent.documentId === id) formIntentRef.current = {};
      if (shouldResetForm) {
        setActiveDocumentId(null);
        saveActiveCvDocumentId(null);
        form.reset(createEmptyCvData(locale));
        resetActiveDocument();
      }
    } catch (deleteError) {
      if (!ownsActor()) return;
      if (handleStorageDeferredError(deleteError, "unlock")) {
        return;
      }

      onError(errorMessage(deleteError));
    }
  }

  const documentActionDialogs = useDocumentActionDialogs({
    userId,
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
