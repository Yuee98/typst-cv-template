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
import { useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { MenuContainer, MenuItem } from "@/components/ui/menu-item";
import { useClickOutside } from "@/hooks/use-click-outside";
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
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const busy = exportingFormat != null;
  useClickOutside(menuRef, () => setOpen(false), open);

  function run(action: () => void) {
    setOpen(false);
    action();
  }

  function itemIcon(format: CvExportFormat, icon: ReactNode) {
    return exportingFormat === format ? <Loader2 className="size-4 animate-spin" /> : icon;
  }

  return (
    <div className="relative" ref={menuRef}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled || busy}
        onClick={() => setOpen((nextOpen) => !nextOpen)}
        title={busy ? t("exporting") : t("export")}
        aria-label={busy ? t("exporting") : t("export")}
      >
        {busy ? <Loader2 className="animate-spin" /> : <Download />}
        <span>{t("export")}</span>
        <ChevronDown className="!size-3.5" />
      </Button>
      {open && (
        <MenuContainer>
          <MenuItem
            icon={itemIcon("pdf", <FileDown className="size-4" />)}
            disabled={busy}
            onClick={() => run(onDownloadPdf)}
          >
            {t("pdf")}
          </MenuItem>
          <MenuItem
            icon={itemIcon("typst-package", <FileArchive className="size-4" />)}
            disabled={busy}
            onClick={() => run(onExportTypstPackage)}
          >
            {t("typstPackage")}
          </MenuItem>
          <MenuItem
            icon={itemIcon("typst-source", <FileCode2 className="size-4" />)}
            disabled={busy}
            onClick={() => run(onExportTypstSource)}
          >
            {t("typstSource")}
          </MenuItem>
          <MenuItem
            icon={itemIcon("json", <FileJson className="size-4" />)}
            disabled={busy}
            onClick={() => run(onExportJson)}
          >
            {t("dataJson")}
          </MenuItem>
        </MenuContainer>
      )}
    </div>
  );
}
