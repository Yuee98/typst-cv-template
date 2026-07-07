"use client";

import { useRef, useState } from "react";
import { Copy } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModalDialog } from "@/components/ui/modal-dialog";

export function DuplicatePromptModal({
  open,
  defaultTitle,
  onClose,
  onSubmit,
}: {
  open: boolean;
  defaultTitle: string;
  onClose: () => void;
  onSubmit: (nextTitle: string) => void;
}) {
  const t = useTranslations("CvDocumentActions");
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(defaultTitle);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <ModalDialog
      open={open}
      title={t("duplicateTitle")}
      closeLabel={t("close")}
      initialFocusRef={inputRef}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" form="duplicate-form" disabled={!value.trim()}>
            <Copy />
            {t("duplicateSubmit")}
          </Button>
        </>
      }
    >
      <form id="duplicate-form" onSubmit={handleSubmit}>
        <Input
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onFocus={(event) => event.target.select()}
          placeholder={t("duplicatePlaceholder")}
          aria-label={t("duplicateTitle")}
        />
      </form>
    </ModalDialog>
  );
}
