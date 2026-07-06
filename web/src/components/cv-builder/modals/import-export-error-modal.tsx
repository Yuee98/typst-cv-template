"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";

export function ImportExportErrorModal({
  open,
  error,
  onClose,
}: {
  open: boolean;
  error: string;
  onClose: () => void;
}) {
  const t = useTranslations("ImportExportErrorModal");

  return (
    <ModalDialog
      open={open}
      title={t("title")}
      closeLabel={t("close")}
      onClose={onClose}
      footer={
        <Button type="button" onClick={onClose}>
          {t("ok")}
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </div>
        <p className="text-sm text-slate-600">
          {t("description")}
        </p>
      </div>
    </ModalDialog>
  );
}
