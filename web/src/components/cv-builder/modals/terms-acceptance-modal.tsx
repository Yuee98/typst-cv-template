"use client";

import { Check, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { TERMS_VERSION, getLegalContent } from "@/content/legal";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";

export function TermsAcceptanceModal({
  open,
  checked,
  error,
  accepting,
  onCheckedChange,
  onAccept,
  onClose,
}: {
  open: boolean;
  checked: boolean;
  error: string | null;
  accepting: boolean;
  onCheckedChange: (checked: boolean) => void;
  onAccept: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("TermsAcceptanceModal");
  const locale = useLocale() as Locale;
  const legal = getLegalContent(locale);

  return (
    <ModalDialog
      open={open}
      title={t("title")}
      description={t("description")}
      closeLabel={t("close")}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={accepting}>
            {t("cancel")}
          </Button>
          <Button type="button" onClick={onAccept} disabled={!checked || accepting}>
            {accepting ? <Loader2 className="animate-spin" /> : <Check />}
            {accepting ? t("saving") : t("accept")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded-md border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger-foreground">
            {error}
          </div>
        )}
        <div className="rounded-md border border-border bg-surface-hover px-3 py-3">
          <div className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
            {t("version", { version: TERMS_VERSION })}
          </div>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-5 text-foreground-muted">
            {legal.termsAcceptanceSummary.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <label className="flex items-start gap-2 text-sm leading-5 text-foreground-muted">
          <input
            type="checkbox"
            className="mt-1 size-4 rounded border-border-strong"
            checked={checked}
            onChange={(event) => onCheckedChange(event.target.checked)}
          />
          <span>
            {t("terms.agreeTo")}{" "}
            <Link className="font-medium text-accent-soft-foreground hover:text-accent" href="/terms" target="_blank" rel="noreferrer">
              {t("terms.termsOfUse")}
            </Link>{" "}
            {t("terms.andAcknowledge")}{" "}
            <Link className="font-medium text-accent-soft-foreground hover:text-accent" href="/privacy" target="_blank" rel="noreferrer">
              {t("terms.privacyPolicy")}
            </Link>
            .
          </span>
        </label>
      </div>
    </ModalDialog>
  );
}
