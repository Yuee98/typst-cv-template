"use client";

import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { TERMS_VERSION, getLegalContent } from "@/content/legal";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";

export function TermsAcceptanceModal({
  checked,
  error,
  accepting,
  onCheckedChange,
  onAccept,
  onClose,
}: {
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
    <Modal
      title={t("title")}
      description={t("description")}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={accepting}>
            {t("cancel")}
          </Button>
          <Button type="button" onClick={onAccept} disabled={!checked || accepting}>
            {accepting ? t("saving") : t("accept")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {error}
          </div>
        )}
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {t("version", { version: TERMS_VERSION })}
          </div>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-5 text-slate-700">
            {legal.termsAcceptanceSummary.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <label className="flex items-start gap-2 text-sm leading-5 text-slate-700">
          <input
            type="checkbox"
            className="mt-1 size-4 rounded border-slate-300"
            checked={checked}
            onChange={(event) => onCheckedChange(event.target.checked)}
          />
          <span>
            {t("terms.agreeTo")}{" "}
            <Link className="font-medium text-emerald-700 hover:text-emerald-600" href="/terms" target="_blank" rel="noreferrer">
              {t("terms.termsOfUse")}
            </Link>{" "}
            {t("terms.andAcknowledge")}{" "}
            <Link className="font-medium text-emerald-700 hover:text-emerald-600" href="/privacy" target="_blank" rel="noreferrer">
              {t("terms.privacyPolicy")}
            </Link>
            .
          </span>
        </label>
      </div>
    </Modal>
  );
}
