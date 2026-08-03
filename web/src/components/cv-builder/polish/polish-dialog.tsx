"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import type { PolishLanguage } from "@/lib/polish/contract";
import { cn } from "@/lib/utils";

import { PolishConfigPhase } from "./polish-config-phase";
import { PolishErrorPhase } from "./polish-error-phase";
import { classifyPolishError, isRetryablePolishError } from "./polish-errors";
import { PolishLoadingPhase } from "./polish-loading-phase";
import { PolishPreviewPhase } from "./polish-preview-phase";
import type { PolishFlow } from "./use-polish-flow";

/**
 * The single-dialog, three-phase polish flow (roadmap「PolishDialog：单
 * dialog 三阶段状态机」). Size: config/loading/error stay at the ModalDialog
 * default (max-w-md); preview widens to a lightbox-ish max-w-3xl with an
 * internally scrolling list — the dialog never unmounts between phases, so
 * the size change is a plain CSS transition without flicker.
 *
 * Close semantics: in loading every close path (X / Esc / overlay / footer
 * cancel) aborts the request via flow.close / flow.cancel; in preview the
 * form already holds the accepted write-backs when the dialog closes.
 */
export function PolishDialog({
  flow,
  language,
}: {
  flow: PolishFlow;
  language: PolishLanguage;
}) {
  const t = useTranslations("PolishDialog");
  const phase = flow.state.phase;

  return (
    <ModalDialog
      open={flow.isOpen}
      title={t("title")}
      description={t(`phaseDescription.${phase}`)}
      closeLabel={t("close")}
      onClose={flow.close}
      className={cn(
        "transition-all duration-200",
        phase === "preview" && "max-h-[80dvh] sm:max-w-3xl",
      )}
      footer={<PhaseFooter flow={flow} />}
    >
      {phase === "config" && <PolishConfigPhase flow={flow} />}
      {phase === "loading" && <PolishLoadingPhase />}
      {phase === "preview" && <PolishPreviewPhase flow={flow} language={language} />}
      {phase === "error" && <PolishErrorPhase flow={flow} />}
    </ModalDialog>
  );
}

function PhaseFooter({ flow }: { flow: PolishFlow }) {
  const t = useTranslations("PolishDialog");
  const phase = flow.state.phase;

  if (phase === "config") {
    const accepting = flow.terms.status === "accepting";
    return (
      <>
        <Button type="button" variant="secondary" onClick={flow.close} disabled={accepting}>
          {t("cancel")}
        </Button>
        <Button type="button" onClick={flow.confirm} disabled={!flow.canConfirm || accepting}>
          {accepting && <Loader2 className="animate-spin" />}
          {accepting ? t("terms.accepting") : t("confirm")}
        </Button>
      </>
    );
  }

  if (phase === "loading") {
    return (
      <Button type="button" variant="secondary" onClick={flow.cancel}>
        {t("loading.cancel")}
      </Button>
    );
  }

  if (phase === "preview") {
    return (
      <>
        <Button type="button" variant="ghost" onClick={flow.backToConfig}>
          {t("rerun")}
        </Button>
        <Button type="button" onClick={flow.close}>
          {t("done")}
        </Button>
      </>
    );
  }

  // error
  const error = flow.state.error;
  const retryable = error ? isRetryablePolishError(classifyPolishError(error)) : false;
  return (
    <>
      <Button type="button" variant="secondary" onClick={flow.close}>
        {t("close")}
      </Button>
      <Button type="button" variant="ghost" onClick={flow.backToConfig}>
        {t("adjustParams")}
      </Button>
      {retryable && (
        <Button type="button" onClick={flow.retry}>
          {t("retry")}
        </Button>
      )}
    </>
  );
}
