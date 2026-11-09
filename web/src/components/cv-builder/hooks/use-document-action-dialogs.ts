import { useLayoutEffect, useRef, useState } from "react";

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
type DialogActor = { userId: string | null };
type OwnedDialog<T> = { actor: DialogActor; dialog: T };

export function useDocumentActionDialogs({
  userId,
  documents,
  onRename,
  onDuplicate,
  onDelete,
}: {
  userId: string | null;
  documents: CvDocumentSummary[];
  onRename: (id: string, nextTitle: string) => void | Promise<void>;
  onDuplicate: (id: string, options?: { title?: string }) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}) {
  const [actor, setActor] = useState<DialogActor>({ userId });
  if (actor.userId !== userId) setActor({ userId });
  const actorRef = useRef(actor);
  useLayoutEffect(() => { actorRef.current = actor; }, [actor]);
  const [renameState, setRenameDialog] = useState<OwnedDialog<RenameDialogState>>({ actor, dialog: null });
  const [duplicateState, setDuplicateDialog] = useState<OwnedDialog<DuplicateDialogState>>({ actor, dialog: null });
  const [deleteState, setDeleteDialog] = useState<OwnedDialog<DeleteDialogState>>({ actor, dialog: null });
  const renameDialog = renameState.actor === actor ? renameState.dialog : null;
  const duplicateDialog = duplicateState.actor === actor ? duplicateState.dialog : null;
  const deleteDialog = deleteState.actor === actor ? deleteState.dialog : null;

  function openRenameDialog(id: string) {
    if (actorRef.current !== actor) return;
    const current = documents.find((document) => document.id === id);
    if (!current) return;
    setRenameDialog({ actor, dialog: { documentId: id, currentTitle: current.title } });
  }

  function closeRenameDialog() {
    if (actorRef.current !== actor) return;
    setRenameDialog({ actor, dialog: null });
  }

  async function submitRenameDialog(nextTitle: string) {
    if (!renameDialog) return;
    await onRename(renameDialog.documentId, nextTitle);
    if (actorRef.current !== renameState.actor) return;
    setRenameDialog(current => current === renameState ? { actor: current.actor, dialog: null } : current);
  }

  function openDuplicateDialog(id: string, defaultTitle: string) {
    if (actorRef.current !== actor) return;
    const current = documents.find((document) => document.id === id);
    if (!current) return;
    setDuplicateDialog({ actor, dialog: { documentId: id, defaultTitle } });
  }

  function closeDuplicateDialog() {
    if (actorRef.current !== actor) return;
    setDuplicateDialog({ actor, dialog: null });
  }

  async function submitDuplicateDialog(nextTitle: string) {
    if (!duplicateDialog) return;
    await onDuplicate(duplicateDialog.documentId, { title: nextTitle });
    if (actorRef.current !== duplicateState.actor) return;
    setDuplicateDialog(current => current === duplicateState ? { actor: current.actor, dialog: null } : current);
  }

  function openDeleteDialog(id: string) {
    if (actorRef.current !== actor) return;
    const current = documents.find((document) => document.id === id);
    if (!current) return;
    setDeleteDialog({ actor, dialog: { documentId: id, title: current.title } });
  }

  function closeDeleteDialog() {
    if (actorRef.current !== actor) return;
    setDeleteDialog({ actor, dialog: null });
  }

  async function confirmDeleteDialog() {
    if (!deleteDialog) return;
    await onDelete(deleteDialog.documentId);
    if (actorRef.current !== deleteState.actor) return;
    setDeleteDialog(current => current === deleteState ? { actor: current.actor, dialog: null } : current);
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
