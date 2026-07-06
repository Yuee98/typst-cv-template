import { useState } from "react";

import type { CvDocumentSummary } from "@/lib/cv/storage";

export type RenameDialogState = {
  documentId: string;
  currentTitle: string;
} | null;

export type DuplicateDialogState = {
  documentId: string;
  defaultTitle: string;
} | null;

export type DeleteDialogState = {
  documentId: string;
  title: string;
} | null;

export function useDocumentActionDialogs({
  documents,
  onRename,
  onDuplicate,
  onDelete,
}: {
  documents: CvDocumentSummary[];
  onRename: (id: string, nextTitle: string) => void | Promise<void>;
  onDuplicate: (id: string, options?: { title?: string }) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}) {
  const [renameDialog, setRenameDialog] = useState<RenameDialogState>(null);
  const [duplicateDialog, setDuplicateDialog] = useState<DuplicateDialogState>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState>(null);

  function openRenameDialog(id: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) return;
    setRenameDialog({ documentId: id, currentTitle: current.title });
  }

  function closeRenameDialog() {
    setRenameDialog(null);
  }

  async function submitRenameDialog(nextTitle: string) {
    if (!renameDialog) return;
    await onRename(renameDialog.documentId, nextTitle);
    setRenameDialog(null);
  }

  function openDuplicateDialog(id: string, defaultTitle: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) return;
    setDuplicateDialog({ documentId: id, defaultTitle });
  }

  function closeDuplicateDialog() {
    setDuplicateDialog(null);
  }

  async function submitDuplicateDialog(nextTitle: string) {
    if (!duplicateDialog) return;
    await onDuplicate(duplicateDialog.documentId, { title: nextTitle });
    setDuplicateDialog(null);
  }

  function openDeleteDialog(id: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) return;
    setDeleteDialog({ documentId: id, title: current.title });
  }

  function closeDeleteDialog() {
    setDeleteDialog(null);
  }

  async function confirmDeleteDialog() {
    if (!deleteDialog) return;
    await onDelete(deleteDialog.documentId);
    setDeleteDialog(null);
  }

  return {
    renameDialog,
    duplicateDialog,
    deleteDialog,
    openRenameDialog,
    closeRenameDialog,
    submitRenameDialog,
    openDuplicateDialog,
    closeDuplicateDialog,
    submitDuplicateDialog,
    openDeleteDialog,
    closeDeleteDialog,
    confirmDeleteDialog,
  };
}
