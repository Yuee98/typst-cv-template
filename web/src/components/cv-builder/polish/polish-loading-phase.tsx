"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * Phase 2 (loading): skeleton plus the quota honesty hint. Every close path
 * (this cancel button, the X, Esc, overlay) aborts the in-flight request —
 * the footer button is wired to flow.cancel, the rest to flow.close.
 */
export function PolishLoadingPhase() {
  const t = useTranslations("PolishDialog");
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="flex items-center gap-2 text-sm text-foreground-muted">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("loading.title")}
      </div>
      <div className="space-y-2" aria-hidden>
        <div className="h-3 w-3/4 animate-pulse rounded bg-surface-hover" />
        <div className="h-3 w-full animate-pulse rounded bg-surface-hover" />
        <div className="h-3 w-5/6 animate-pulse rounded bg-surface-hover" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-surface-hover" />
      </div>
      <p className="text-xs leading-5 text-foreground-subtle">{t("loading.cancelHint")}</p>
    </div>
  );
}
