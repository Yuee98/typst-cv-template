"use client";

import { useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModalDialog } from "@/components/ui/modal-dialog";

export function RenamePromptModal({
  open,
  currentTitle,
  onClose,
  onSubmit,
}: {
  open: boolean;
  currentTitle: string;
  onClose: () => void;
  onSubmit: (nextTitle: string) => void;
}) {
  const t = useTranslations("CvDocumentActions");
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(currentTitle);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || trimmed === currentTitle.trim()) return;
    onSubmit(trimmed);
  }

  return (
    <ModalDialog
      open={open}
      title={t("renameTitle")}
      closeLabel={t("close")}
      initialFocusRef={inputRef}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" form="rename-form" disabled={!value.trim() || value.trim() === currentTitle.trim()}>
            <Pencil />
            {t("renameSubmit")}
          </Button>
        </>
      }
    >
      <form id="rename-form" onSubmit={handleSubmit}>
        <Input
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onFocus={(event) => event.target.select()}
          placeholder={t("renamePlaceholder")}
          aria-label={t("renameTitle")}
        />
      </form>
    </ModalDialog>
  );
}
