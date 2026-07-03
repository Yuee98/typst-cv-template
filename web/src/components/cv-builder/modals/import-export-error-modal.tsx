"use client";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";

export function ImportExportErrorModal({
  error,
  onClose,
}: {
  error: string;
  onClose: () => void;
}) {
  return (
    <Modal
      title="Import/Export Error"
      onClose={onClose}
      footer={
        <Button type="button" onClick={onClose}>
          OK
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </div>
        <p className="text-sm text-slate-600">
          Please check the file format and try again. If the problem persists, ensure the file is a valid CV JSON export.
        </p>
      </div>
    </Modal>
  );
}
