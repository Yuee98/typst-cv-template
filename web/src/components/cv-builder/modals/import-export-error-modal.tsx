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
        <div className="rounded-md border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger-foreground">
          {error}
        </div>
        <p className="text-sm text-foreground-muted">
          {t("description")}
        </p>
      </div>
    </ModalDialog>
  );
}
