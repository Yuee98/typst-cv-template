import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";

import { errorMessage } from "@/lib/cv/cv-utils";
import { cvSchema, type CvData } from "@/lib/cv/schema";
import type { CvDocumentSummary } from "@/lib/cv/storage";
import type { CvStorageAdapters } from "@/lib/cv/storage-adapters";

export function useCvPersistence({
  activeDocument,
  activeDocumentId,
  clearDraft,
  form,
  handleStorageDeferredError,
  loadDataIntoForm,
  onDirtyChange,
  onError,
  storageAdapters,
  upsertDocumentSummary,
}: {
  activeDocument: CvDocumentSummary | null;
  activeDocumentId: string | null;
  clearDraft: (cvId: string) => void;
  form: UseFormReturn<CvData>;
  handleStorageDeferredError: (error: unknown, mode: "unlock" | "duplicate") => boolean;
  loadDataIntoForm: (id: string, data: CvData) => void;
  onDirtyChange: (dirty: boolean) => void;
  onError: (message: string) => void;
  storageAdapters: CvStorageAdapters;
  upsertDocumentSummary: (summary: CvDocumentSummary) => void;
}) {
  const [saving, setSaving] = useState(false);

  async function saveCurrentDocument({ silent = false }: { silent?: boolean } = {}) {
    if (!activeDocumentId || !activeDocument) {
      return false;
    }

    if (saving) {
      return false;
    }

    const parsed = cvSchema.safeParse(form.getValues());
    if (!parsed.success) {
      onError("The current form data does not match the CV schema.");
      return false;
    }

    void silent;

    setSaving(true);
    try {
      const updated = await storageAdapters[activeDocument.storageKind].save(activeDocument, parsed.data);
      upsertDocumentSummary(updated);
    } catch (saveError) {
      if (handleStorageDeferredError(saveError, "unlock")) {
        return false;
      }

      onError(errorMessage(saveError));
      return false;
    } finally {
      setSaving(false);
    }

    onDirtyChange(false);
    if (activeDocument.storageKind === "cloud") {
      clearDraft(activeDocumentId);
    }
    return true;
  }

  async function discardChanges() {
    if (!activeDocumentId || !activeDocument) {
      return;
    }

    try {
      if (activeDocument.storageKind === "cloud") {
        clearDraft(activeDocumentId);
      }

      if (activeDocument.storageKind === "cloud" || activeDocument.storageKind === "encrypted") {
        const document = await storageAdapters[activeDocument.storageKind].load(activeDocument);
        loadDataIntoForm(document.summary.id, document.data);
      }
    } catch (discardError) {
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
