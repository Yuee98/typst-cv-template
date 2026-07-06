import type { RefObject } from "react";

import { DeleteConfirmModal } from "@/components/cv-builder/modals/delete-confirm-modal";
import { DuplicatePromptModal } from "@/components/cv-builder/modals/duplicate-prompt-modal";
import { RenamePromptModal } from "@/components/cv-builder/modals/rename-prompt-modal";
import type {
  DeleteDialogState,
  DuplicateDialogState,
  RenameDialogState,
} from "@/components/cv-builder/hooks/use-document-action-dialogs";

export function DocumentActionDialogs({
  renameDialog,
  duplicateDialog,
  deleteDialog,
  onCloseRenameDialog,
  onSubmitRenameDialog,
  onCloseDuplicateDialog,
  onSubmitDuplicateDialog,
  onCloseDeleteDialog,
  onConfirmDeleteDialog,
  deleteRestoreFocusRef,
}: {
  renameDialog: RenameDialogState;
  duplicateDialog: DuplicateDialogState;
  deleteDialog: DeleteDialogState;
  onCloseRenameDialog: () => void;
  onSubmitRenameDialog: (nextTitle: string) => void;
  onCloseDuplicateDialog: () => void;
  onSubmitDuplicateDialog: (nextTitle: string) => void;
  onCloseDeleteDialog: () => void;
  onConfirmDeleteDialog: () => void;
  deleteRestoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <>
      <RenamePromptModal
        key={renameDialog ? `rename-${renameDialog.documentId}` : "rename-closed"}
        open={!!renameDialog}
        currentTitle={renameDialog?.currentTitle ?? ""}
        onClose={onCloseRenameDialog}
        onSubmit={onSubmitRenameDialog}
      />
      <DuplicatePromptModal
        key={duplicateDialog ? `duplicate-${duplicateDialog.documentId}` : "duplicate-closed"}
        open={!!duplicateDialog}
        defaultTitle={duplicateDialog?.defaultTitle ?? ""}
        onClose={onCloseDuplicateDialog}
        onSubmit={onSubmitDuplicateDialog}
      />
      <DeleteConfirmModal
        open={!!deleteDialog}
        title={deleteDialog?.title ?? ""}
        onClose={onCloseDeleteDialog}
        onConfirm={onConfirmDeleteDialog}
        restoreFocusRef={deleteRestoreFocusRef}
      />
    </>
  );
}
