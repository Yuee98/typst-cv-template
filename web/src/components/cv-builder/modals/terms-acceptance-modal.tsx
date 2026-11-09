"use client";

import { Check, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import type { CurrentTerms } from "@/lib/legal/terms-acceptance";
import { termsDocumentHref } from "@/lib/legal/document-links";
import { Link } from "@/i18n/navigation";
export function TermsAcceptanceModal({
  terms,
  open,
  checked,
  error,
  accepting,
  onCheckedChange,
  onAccept,
  onClose
}: {
  terms: CurrentTerms | null;
  open: boolean;
  checked: boolean;
  error: string | null;
  accepting: boolean;
  onCheckedChange: (checked: boolean) => void;
  onAccept: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("TermsAcceptanceModal");
  return <ModalDialog open={open} title={t("title")} description={t("description")} closeLabel={t("close")} onClose={onClose} footer={<>
          <Button type="button" variant="secondary" onClick={onClose} disabled={accepting}>
            {t("cancel")}
          </Button>
          <Button type="button" onClick={onAccept} disabled={!terms || !checked || accepting}>
            {accepting ? <Loader2 className="animate-spin" /> : <Check />}
            {accepting ? t("saving") : t("accept")}
          </Button>
        </>}>
      <div className="space-y-4">
        {error && <div className="rounded-md border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger-foreground">
            {error}
          </div>}
        <label className="flex items-start gap-2 text-sm leading-5 text-foreground-muted">
          <input type="checkbox" className="mt-1 size-4 rounded border-border-strong" checked={checked} disabled={!terms || accepting} onChange={event => onCheckedChange(event.target.checked)} />
          <span>
            {t("terms.agreeTo")}{" "}
            {terms ? <Link className="font-medium text-accent-soft-foreground hover:text-accent" href={termsDocumentHref(terms)} target="_blank" rel="noopener noreferrer">
              {t("terms.termsOfUse")}
            </Link> : t("terms.termsOfUse")}{" "}
            {t("terms.andAcknowledge")}{" "}
            <Link className="font-medium text-accent-soft-foreground hover:text-accent" href="/privacy" target="_blank" rel="noopener noreferrer">
              {t("terms.privacyPolicy")}
            </Link>
            .
          </span>
        </label>
      </div>
    </ModalDialog>;
}
