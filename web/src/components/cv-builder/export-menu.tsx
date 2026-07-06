"use client";

import {
  ChevronDown,
  Download,
  FileArchive,
  FileCode2,
  FileDown,
  FileJson,
  Loader2,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CvExportFormat } from "@/lib/cv/export-utils";

export function ExportMenu({
  disabled,
  exportingFormat,
  onDownloadPdf,
  onExportTypstPackage,
  onExportTypstSource,
  onExportJson,
}: {
  disabled: boolean;
  exportingFormat: CvExportFormat | null;
  onDownloadPdf: () => void;
  onExportTypstPackage: () => void;
  onExportTypstSource: () => void;
  onExportJson: () => void;
}) {
  const t = useTranslations("ExportMenu");
  const busy = exportingFormat != null;

  function itemIcon(format: CvExportFormat, icon: ReactNode) {
    return exportingFormat === format ? <Loader2 className="size-4 animate-spin" /> : icon;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || busy}
          title={busy ? t("exporting") : t("export")}
          aria-label={busy ? t("exporting") : t("export")}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Download />}
          <span>{t("export")}</span>
          <ChevronDown className="!size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          icon={itemIcon("pdf", <FileDown className="size-4" />)}
          disabled={busy}
          onSelect={onDownloadPdf}
        >
          {t("pdf")}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={itemIcon("typst-package", <FileArchive className="size-4" />)}
          disabled={busy}
          onSelect={onExportTypstPackage}
        >
          {t("typstPackage")}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={itemIcon("typst-source", <FileCode2 className="size-4" />)}
          disabled={busy}
          onSelect={onExportTypstSource}
        >
          {t("typstSource")}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={itemIcon("json", <FileJson className="size-4" />)}
          disabled={busy}
          onSelect={onExportJson}
        >
          {t("dataJson")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
