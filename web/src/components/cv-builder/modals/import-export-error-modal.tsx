"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";

export function ImportExportErrorModal({
  error,
  onClose,
}: {
  error: string;
  onClose: () => void;
}) {
  const t = useTranslations("ImportExportErrorModal");

  return (
    <Modal
      title={t("title")}
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
    </Modal>
  );
}
