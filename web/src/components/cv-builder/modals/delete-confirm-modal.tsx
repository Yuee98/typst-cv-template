"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";

export function DeleteConfirmModal({
  open,
  title,
  onClose,
  onConfirm,
  restoreFocusRef,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  onConfirm: () => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const t = useTranslations("CvDocumentActions");
  const activeRestoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      activeRestoreFocusRef.current = null;
    }
  }, [open]);

  return (
    <ModalDialog
      open={open}
      title={t("deleteTitle")}
      description={t("deleteDescription", { title })}
      closeLabel={t("close")}
      onClose={onClose}
      restoreFocusRef={activeRestoreFocusRef}
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              activeRestoreFocusRef.current = null;
              onClose();
            }}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              activeRestoreFocusRef.current = restoreFocusRef?.current ?? null;
              onConfirm();
            }}
          >
            {t("deleteConfirm")}
          </Button>
        </>
      }
    >
      <div />
    </ModalDialog>
  );
}
