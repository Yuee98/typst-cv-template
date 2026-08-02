import type { MutableRefObject } from "react";
import { useEffect, useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { useTranslations } from "next-intl";

import { cloudDraftTick, matchesCvBaseline, type CvBaseline } from "@/lib/cv/baseline";
import { errorMessage } from "@/lib/cv/cv-utils";
import { cvSchema, type CvData } from "@/lib/cv/schema";
import type { CvDocumentSummary } from "@/lib/cv/storage";
import { buildTypstDocument } from "@/lib/cv/typst";
import { defaultLocale, type Locale } from "@/i18n/routing";
import { renderTypstSvg, type LoadStage } from "@/lib/typst/render";

export function useCvPreview({
  tImportExport,
  locale = defaultLocale,
  activeDocument,
  activeDocumentId,
  clearDraft,
  form,
  getDirtyBaseline,
  initializedRef,
  onDirtyChange,
  saveCurrentDocument,
  saveDraft,
  watchedData,
}: {
  tImportExport: ReturnType<typeof useTranslations<"ImportExport">>;
  locale?: Locale;
  activeDocument: CvDocumentSummary | null;
  activeDocumentId: string | null;
  clearDraft: (cvId: string) => void;
  form: UseFormReturn<CvData>;
  getDirtyBaseline: () => CvBaseline | null;
  initializedRef: MutableRefObject<boolean>;
  onDirtyChange: (dirty: boolean) => void;
  saveCurrentDocument: (options?: { silent?: boolean }) => Promise<boolean>;
  saveDraft: (cvId: string, data: CvData) => void;
  watchedData: unknown;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [status, setStatus] = useState<LoadStage>("idle");
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isResettingRef = useRef(false);
  const renderId = useRef(0);

  function reset() {
    renderId.current += 1;
    setSvg(null);
    setStatus("idle");
    setPercent(null);
    setError(null);
  }

  function resetForFormLoad() {
    isResettingRef.current = true;
    reset();
  }

  useEffect(() => {
    if (!initializedRef.current || !activeDocumentId) {
      return;
    }

    const timer = window.setTimeout(async () => {
      const isResetting = isResettingRef.current;
      if (isResetting) {
        isResettingRef.current = false;
      }

      const parsed = cvSchema.safeParse(form.getValues());
      if (!parsed.success) {
        setStatus("error");
        setError(tImportExport("currentSchemaError"));
        return;
      }

      // Auto-save: only for local CVs (skip during reset)
      if (!isResetting) {
        if (activeDocument?.storageKind === "local") {
          // On success the save updates the persisted baseline itself; on
          // failure the baseline stays put and the derived dirty flag is
          // reported so the editor never shows a false clean state.
          const dirty = !matchesCvBaseline(getDirtyBaseline(), activeDocumentId, parsed.data);
          const saved = await saveCurrentDocument({ silent: true });
          if (!saved) {
            onDirtyChange(dirty);
            return;
          }
        } else if (activeDocument?.storageKind === "cloud") {
          // Cloud CVs: keep the localStorage draft as a safety net while the
          // form differs from the persisted baseline; a form back at the
          // baseline makes the draft redundant, so clear it instead.
          const { dirty, action } = cloudDraftTick(getDirtyBaseline(), activeDocumentId, parsed.data);
          if (action === "save-draft") {
            saveDraft(activeDocumentId, parsed.data);
          } else {
            clearDraft(activeDocumentId);
          }
          onDirtyChange(dirty);
        } else {
          // Encrypted CVs: no auto-save, no draft
          onDirtyChange(!matchesCvBaseline(getDirtyBaseline(), activeDocumentId, parsed.data));
        }
      }

      // Always render preview
      const nextRenderId = renderId.current + 1;
      renderId.current = nextRenderId;
      setStatus("loading-assets");
      setPercent(0);
      setError(null);

      try {
        const document = buildTypstDocument(parsed.data);
        const nextSvg = await renderTypstSvg(
          document,
          (progress) => {
            if (renderId.current === nextRenderId) {
              setStatus(progress.stage);
              setPercent(progress.percent);
            }
          },
          locale,
        );
        if (renderId.current === nextRenderId) {
          setSvg(nextSvg);
          setStatus("ready");
          setPercent(null);
        }
      } catch (renderError) {
        if (renderId.current === nextRenderId) {
          setStatus("error");
          setPercent(null);
          setError(errorMessage(renderError));
        }
      }
    }, 500);

    return () => window.clearTimeout(timer);
    // saveCurrentDocument updates document summaries, so depending on it would retrigger saves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedData, form, activeDocumentId, activeDocument?.storageKind]);

  return {
    error,
    percent,
    reset,
    resetForFormLoad,
    setError,
    status,
    svg,
  };
}
