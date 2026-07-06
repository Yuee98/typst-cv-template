"use client";

import { ShieldCheck, AlertTriangle } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";

export type EncryptionModalMode = "enable" | "unlock" | "duplicate";

export function EncryptionModal({
  mode,
  password,
  error,
  trustDevice,
  onPasswordChange,
  onTrustDeviceChange,
  onSubmit,
  onClose,
}: {
  mode: EncryptionModalMode;
  password: string;
  error: string | null;
  trustDevice: boolean;
  onPasswordChange: (password: string) => void;
  onTrustDeviceChange: (trust: boolean) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("EncryptionModal");
  const [confirming, setConfirming] = useState(false);
  const modeTitles: Record<EncryptionModalMode, string> = {
    enable: t("title.enable"),
    unlock: t("title.unlock"),
    duplicate: t("title.duplicate"),
  };

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (mode === "enable" && !confirming) {
      setConfirming(true);
      return;
    }
    onSubmit();
  }

  return (
    <form onSubmit={handleSubmit}>
      <Modal
        title={modeTitles[mode]}
        onClose={onClose}
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={confirming ? () => setConfirming(false) : onClose}
            >
              {confirming ? t("back") : t("cancel")}
            </Button>
            <Button type="submit" disabled={!!error}>
              <ShieldCheck />
              {confirming ? t("confirm") : t("continue")}
            </Button>
          </>
        }
      >
        {confirming ? (
          <div className="space-y-3">
            <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-3">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
              <div className="space-y-2 text-sm leading-5 text-amber-900">
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
              type="password"
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              placeholder={t("placeholder.password")}
            />
            {error && (
              <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {error}
              </p>
            )}
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={trustDevice}
                onChange={(event) => onTrustDeviceChange(event.target.checked)}
                className="size-3.5 accent-slate-900"
              />
              {t("rememberThisDevice")}
            </label>
          </div>
        )}
      </Modal>
    </form>
  );
}
