import { useState } from "react";

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
  canExport,
  getCurrentData,
  getDownloadTitle,
  locale = defaultLocale,
  onImportExportError,
  onPreviewError,
}: {
  canExport: () => boolean;
  getCurrentData: () => CvData;
  getDownloadTitle: (data: CvData) => string;
  locale?: Locale;
  onImportExportError: (error: string) => void;
  onPreviewError: (error: string | null) => void;
}) {
  const [exportingFormat, setExportingFormat] = useState<CvExportFormat | null>(null);

  async function downloadPdf() {
    if (!canExport()) return;

    setExportingFormat("pdf");
    onPreviewError(null);

    try {
      const data = getCurrentData();
      await downloadCvPdf(data, getDownloadTitle(data), locale);
    } catch (pdfError) {
      onPreviewError(errorMessage(pdfError));
    } finally {
      setExportingFormat(null);
    }
  }

  async function exportDocument() {
    if (!canExport()) return;

    setExportingFormat("json");

    try {
      const data = getCurrentData();
      downloadCvJson(data, getDownloadTitle(data), locale);
    } catch (exportError) {
      onImportExportError(errorMessage(exportError));
    } finally {
      setExportingFormat(null);
    }
  }

  async function exportTypstSource() {
    if (!canExport()) return;

    setExportingFormat("typst-source");

    try {
      const data = getCurrentData();
      downloadTypstSource(data, getDownloadTitle(data), locale);
    } catch (exportError) {
      onImportExportError(errorMessage(exportError));
    } finally {
      setExportingFormat(null);
    }
  }

  async function exportTypstPackage() {
    if (!canExport()) return;

    setExportingFormat("typst-package");

    try {
      const data = getCurrentData();
      await downloadTypstPackage(data, getDownloadTitle(data), locale);
    } catch (exportError) {
      onImportExportError(errorMessage(exportError));
    } finally {
      setExportingFormat(null);
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
