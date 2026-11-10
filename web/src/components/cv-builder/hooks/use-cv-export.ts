import { useEffect, useRef, useState } from "react";

import {
  downloadCvJson,
  downloadCvPdf,
  downloadTypstPackage,
  downloadTypstSource,
  type CvExportFormat,
} from "@/lib/cv/export-utils";
import type { CvData } from "@/lib/cv/schema";
import { errorMessage } from "@/lib/cv/cv-utils";
import { defaultLocale, type Locale } from "@/i18n/routing";

export function useCvExport({
  captureExport,
  getCurrentData,
  getDownloadTitle,
  locale = defaultLocale,
  onImportExportError,
  onPreviewError,
}: {
  captureExport: () => (() => boolean) | null;
  getCurrentData: () => CvData;
  getDownloadTitle: (data: CvData) => string;
  locale?: Locale;
  onImportExportError: (error: string) => void;
  onPreviewError: (error: string | null) => void;
}) {
  const [exportingFormat, setExportingFormat] = useState<CvExportFormat | null>(null);
  const operationRef = useRef<object | null>(null);
  useEffect(() => () => { operationRef.current = null; }, []);

  function beginExport(format: CvExportFormat) {
    const ownsSource = captureExport();
    if (!ownsSource?.()) return null;
    const operation = {};
    operationRef.current = operation;
    setExportingFormat(format);
    return {
      isCurrent: () => operationRef.current === operation && ownsSource(),
      finish() {
        if (operationRef.current !== operation) return;
        operationRef.current = null;
        setExportingFormat(null);
      },
    };
  }

  async function downloadPdf() {
    const operation = beginExport("pdf");
    if (!operation) return;
    onPreviewError(null);

    try {
      const data = getCurrentData();
      await downloadCvPdf(data, getDownloadTitle(data), locale, operation.isCurrent);
    } catch (pdfError) {
      if (operation.isCurrent()) onPreviewError(errorMessage(pdfError));
    } finally {
      operation.finish();
    }
  }

  async function exportDocument() {
    const operation = beginExport("json");
    if (!operation) return;

    try {
      const data = getCurrentData();
      downloadCvJson(data, getDownloadTitle(data), locale);
    } catch (exportError) {
      if (operation.isCurrent()) onImportExportError(errorMessage(exportError));
    } finally {
      operation.finish();
    }
  }

  async function exportTypstSource() {
    const operation = beginExport("typst-source");
    if (!operation) return;

    try {
      const data = getCurrentData();
      downloadTypstSource(data, getDownloadTitle(data), locale);
    } catch (exportError) {
      if (operation.isCurrent()) onImportExportError(errorMessage(exportError));
    } finally {
      operation.finish();
    }
  }

  async function exportTypstPackage() {
    const operation = beginExport("typst-package");
    if (!operation) return;

    try {
      const data = getCurrentData();
      await downloadTypstPackage(data, getDownloadTitle(data), locale, operation.isCurrent);
    } catch (exportError) {
      if (operation.isCurrent()) onImportExportError(errorMessage(exportError));
    } finally {
      operation.finish();
    }
  }

  return {
    exportingFormat,
    downloadPdf,
    exportDocument,
    exportTypstPackage,
    exportTypstSource,
  };
}
