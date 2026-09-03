"use client";

import { CircleAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { classifyPolishError, formatResetAt, type PolishErrorKind } from "./polish-errors";
import type { PolishFlow } from "./use-polish-flow";

/** Kinds that are resolved elsewhere (or never surfaced) share the fallback. */
const MESSAGE_KIND: Record<PolishErrorKind, string> = {
  terms_required: "unknown", // handled in-config via the red checkbox
  quota_exhausted: "quota_exhausted",
  rate_limited: "rate_limited",
  duplicate: "duplicate",
  route_changed: "route_changed",
  too_large: "too_large",
  timeout: "timeout",
  invalid_output: "invalid_output",
  disabled: "disabled",
  auth: "auth",
  stale: "stale",
  network: "network",
  upstream: "upstream",
  invalid_request: "invalid_request",
  aborted: "unknown", // the user cancelled; nothing to show
  unknown: "unknown",
};

/**
 * Error phase:细分 message by contract/transport code, with the structured
 * resetAt / retryAfterSeconds / requestId details when present. Stays inside
 * the dialog — retry mints a fresh clientRequestId, or the user can go back
 * to config to adjust parameters, or close.
 */
export function PolishErrorPhase({ flow }: { flow: PolishFlow }) {
  const t = useTranslations("PolishDialog");
  const locale = useLocale();
  const error = flow.state.error;
  if (!error) return null;

  const kind = classifyPolishError(error);

  return (
    <div className="space-y-3">
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger-foreground"
      >
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="space-y-1">
          <p>{t(`errors.${MESSAGE_KIND[kind]}`)}</p>
          {error.resetAt && (
            <p className="text-xs">{t("errors.resetAt", { resetAt: formatResetAt(error.resetAt, locale) })}</p>
          )}
          {error.code !== "AI_DISABLED" && error.retryAfterSeconds !== undefined && (
            <p className="text-xs">
              {t("errors.retryAfter", { seconds: error.retryAfterSeconds })}
            </p>
          )}
        </div>
      </div>
      {flow.state.serverRequestId && (
        <p className="text-xs text-foreground-subtle">
          {t("errors.requestId", { requestId: flow.state.serverRequestId })}
        </p>
      )}
    </div>
  );
}
