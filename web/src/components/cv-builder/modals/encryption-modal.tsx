"use client";

import { ShieldCheck, AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModalDialog } from "@/components/ui/modal-dialog";

export type EncryptionModalMode = "enable" | "unlock" | "duplicate";

export function EncryptionModal({
  open,
  mode,
  password,
  error,
  trustDevice,
  confirming,
  onPasswordChange,
  onTrustDeviceChange,
  onSetError,
  onSetConfirming,
  onSubmit,
  onClose,
}: {
  open: boolean;
  mode: EncryptionModalMode;
  password: string;
  error: string | null;
  trustDevice: boolean;
  confirming: boolean;
  onPasswordChange: (password: string) => void;
  onTrustDeviceChange: (trust: boolean) => void;
  onSetError: (error: string | null) => void;
  onSetConfirming: (confirming: boolean) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("EncryptionModal");
  const modeTitles: Record<EncryptionModalMode, string> = {
    enable: t("title.enable"),
    unlock: t("title.unlock"),
    duplicate: t("title.duplicate"),
  };

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (mode === "enable" && !confirming) {
      if (!password) {
        onSetError(t("error.passwordRequired"));
        return;
      }
      onSetConfirming(true);
      return;
    }
    onSubmit();
  }

  return (
    <ModalDialog
      open={open}
      title={modeTitles[mode]}
      closeLabel={t("close")}
      onClose={onClose}
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            onClick={confirming ? () => onSetConfirming(false) : onClose}
          >
            {confirming ? t("back") : t("cancel")}
          </Button>
          <Button type="submit" form="encryption-form" disabled={!!error}>
            <ShieldCheck />
            {confirming ? t("confirm") : t("continue")}
          </Button>
        </>
      }
    >
      <form id="encryption-form" onSubmit={handleSubmit}>
        {confirming ? (
          <div className="space-y-3">
            <div className="flex items-start gap-3 rounded-md border border-warning-border bg-warning-soft p-3">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
              <div className="space-y-2 text-sm leading-5 text-warning-foreground">
                <p className="font-medium">{t("warning.title")}</p>
                <ul className="list-disc space-y-1 pl-4">
                  <li>{t("warning.item1")}</li>
                  <li>{t("warning.item2")}</li>
                </ul>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <Input
              id="cv-encryption-password"
              name="cv-encryption-password"
              type="password"
              autoComplete="one-time-code"
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              placeholder={t("placeholder.password")}
            />
            {error && (
              <p className="rounded-md border border-danger-border bg-danger-soft px-3 py-2 text-xs text-danger-foreground">
                {error}
              </p>
            )}
            <label className="flex items-center gap-1.5 text-xs text-foreground-muted">
              <input
                type="checkbox"
                checked={trustDevice}
                onChange={(event) => onTrustDeviceChange(event.target.checked)}
                className="size-3.5 accent-accent"
              />
              {t("rememberThisDevice")}
            </label>
          </div>
        )}
      </form>
    </ModalDialog>
  );
}
