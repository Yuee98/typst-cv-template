import { useLayoutEffect, useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { useTranslations } from "next-intl";

import { errorMessage } from "@/lib/cv/cv-utils";
import { cvSchema, type CvData } from "@/lib/cv/schema";
import type { CvDocumentSummary } from "@/lib/cv/storage";
import type { CvStorageAdapters } from "@/lib/cv/storage-adapters";

export function useCvPersistence({
  userId,
  tPersistence,
  activeDocument,
  activeDocumentId,
  clearDraft,
  form,
  handleStorageDeferredError,
  loadDataIntoForm,
  onPersisted,
  onError,
  storageAdapters,
  upsertDocumentSummary,
}: {
  userId: string | null;
  tPersistence: ReturnType<typeof useTranslations<"CvPersistence">>;
  activeDocument: CvDocumentSummary | null;
  activeDocumentId: string | null;
  clearDraft: (cvId: string) => void;
  form: UseFormReturn<CvData>;
  handleStorageDeferredError: (error: unknown, mode: "unlock" | "duplicate") => boolean;
  loadDataIntoForm: (id: string, data: CvData, options?: { baselineData?: CvData; cloudRevision?: string }) => void;
  onPersisted: (id: string, data: CvData) => void;
  onError: (message: string) => void;
  storageAdapters: CvStorageAdapters;
  upsertDocumentSummary: (summary: CvDocumentSummary) => void;
}) {
  const [actor, setActor] = useState({ userId });
  if (actor.userId !== userId) setActor({ userId });
  const ownerRef = useRef(actor);
  useLayoutEffect(() => { ownerRef.current = actor; }, [actor]);
  const [saveState, setSaveState] = useState({ actor, pending: false });
  const saving = saveState.actor === actor && saveState.pending;
  function actorGuard() {
    return () => ownerRef.current === actor;
  }

  async function saveCurrentDocument({ silent = false }: { silent?: boolean } = {}) {
    const ownsActor = actorGuard();
    if (!ownsActor()) return false;
    if (!activeDocumentId || !activeDocument) {
      return false;
    }

    if (saving) {
      return false;
    }

    const parsed = cvSchema.safeParse(form.getValues());
    if (!parsed.success) {
      onError(tPersistence("schemaError"));
      return false;
    }

    void silent;

    setSaveState({ actor, pending: true });
    try {
      const updated = await storageAdapters[activeDocument.storageKind].save(activeDocument, parsed.data);
      if (!ownsActor()) return false;
      upsertDocumentSummary(updated);
    } catch (saveError) {
      if (!ownsActor()) return false;
      if (handleStorageDeferredError(saveError, "unlock")) {
        return false;
      }

      onError(errorMessage(saveError));
      return false;
    } finally {
      if (ownsActor()) setSaveState({ actor, pending: false });
    }

    // The save succeeded: the form data just written becomes the persisted
    // baseline. On failure above, the baseline is left untouched.
    onPersisted(activeDocumentId, parsed.data);
    return true;
  }

  async function discardChanges() {
    const ownsActor = actorGuard();
    if (!ownsActor()) return;
    if (!activeDocumentId || !activeDocument) {
      return;
    }

    try {
      if (activeDocument.storageKind === "cloud") {
        clearDraft(activeDocumentId);
      }

      if (activeDocument.storageKind === "cloud" || activeDocument.storageKind === "encrypted") {
        const document = await storageAdapters[activeDocument.storageKind].load(activeDocument);
        if (!ownsActor()) return;
        if (document.cloudRevision !== undefined) {
          loadDataIntoForm(document.summary.id, document.data, { cloudRevision: document.cloudRevision });
        } else {
          loadDataIntoForm(document.summary.id, document.data);
        }
      }
    } catch (discardError) {
      if (!ownsActor()) return;
      if (handleStorageDeferredError(discardError, "unlock")) {
        return;
      }

      onError(errorMessage(discardError));
    }
  }

  return {
    discardChanges,
    saveCurrentDocument,
    saving,
  };
}
