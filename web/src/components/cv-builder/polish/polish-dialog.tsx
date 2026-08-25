"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useWatch } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import type { PolishLanguage } from "@/lib/polish/contract";
import { cn } from "@/lib/utils";

import { PolishConfigPhase } from "./polish-config-phase";
import { PolishEntryProvider } from "./polish-entry-context";
import { PolishErrorPhase } from "./polish-error-phase";
import { classifyPolishError, isRetryablePolishError } from "./polish-errors";
import { savePendingPolishIntent, takePendingPolishIntent } from "./polish-intent";
import { PolishLoadingPhase } from "./polish-loading-phase";
import { PolishPreviewPhase } from "./polish-preview-phase";
import type { PolishScope } from "./scope-builder";
import {
  usePolishFlow,
  type PolishFlow,
  type UsePolishFlowOptions,
} from "./use-polish-flow";

/**
 * The single-dialog, three-phase polish flow (roadmap「PolishDialog：单
 * dialog 三阶段状态机」). Size: config/loading/error stay at the ModalDialog
 * default (max-w-md); preview widens to a lightbox-ish max-w-3xl with an
 * internally scrolling list — the dialog never unmounts between phases, so
 * the size change is a plain CSS transition without flicker.
 *
 * Close semantics: in loading every close path (X / Esc / overlay / footer
 * cancel) aborts the request via flow.close / flow.cancel; in preview the
 * form already holds the accepted write-backs when the dialog closes. While
 * the AI-terms acceptance write is in flight ALL close paths are disabled —
 * the reviewed snapshot must not be sendable from a dismissed dialog (the
 * hook additionally invalidates the continuation on any programmatic close).
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
  const accepting = flow.terms.status === "accepting";

  return (
    <ModalDialog
      open={flow.isOpen}
      title={t("title")}
      description={t(`phaseDescription.${phase}`)}
      closeLabel={t("close")}
      onClose={flow.close}
      closeDisabled={accepting}
      className={cn(
        "transition-all duration-200",
        phase === "preview" && "max-h-[80dvh] sm:max-w-3xl",
      )}
      footer={<PhaseFooter flow={flow} />}
    >
      {phase === "config" && <PolishConfigPhase flow={flow} />}
      {phase === "loading" && (
        <div role="status" aria-live="polite" aria-atomic="true">
          <PolishLoadingPhase />
        </div>
      )}
      {phase === "preview" && <PolishPreviewPhase flow={flow} language={language} />}
      {phase === "error" && <PolishErrorPhase flow={flow} />}
    </ModalDialog>
  );
}

/**
 * The AI-only composition boundary. CvBuilder requires this module only when
 * the public feature flag is compiled on, so static exports neither call the
 * flow hook nor ship the client that fetches the polish API.
 */
export function PolishFlowProvider({
  children,
  onRequestSignIn,
  ...flowOptions
}: Omit<UsePolishFlowOptions, "language"> & {
  children: ReactNode;
  onRequestSignIn: () => void;
}) {
  const language = useWatch({ control: flowOptions.form.control, name: "typstLang" }) ?? "en";
  const flow = usePolishFlow({ ...flowOptions, language });
  const { open: openPolishFlow } = flow;

  const requestPolish = useCallback(
    (scope: PolishScope) => {
      if (flowOptions.session) {
        openPolishFlow(scope);
        return;
      }
      if (flowOptions.documentId) {
        savePendingPolishIntent({
          documentId: flowOptions.documentId,
          scope,
          createdAt: Date.now(),
        });
      }
      onRequestSignIn();
    },
    [flowOptions.session, flowOptions.documentId, onRequestSignIn, openPolishFlow],
  );

  useEffect(() => {
    if (!flowOptions.session || !flowOptions.documentId) return;
    const scope = takePendingPolishIntent(flowOptions.documentId);
    if (scope) openPolishFlow(scope);
  }, [flowOptions.session, flowOptions.documentId, openPolishFlow]);

  const entryValue = useMemo(() => ({ requestPolish }), [requestPolish]);

  return (
    <PolishEntryProvider value={entryValue}>
      {children}
      <PolishDialog flow={flow} language={language} />
    </PolishEntryProvider>
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
