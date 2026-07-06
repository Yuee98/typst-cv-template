"use client";

import { CloudUpload, Copy, LockKeyhole, Pencil, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CvDocumentSummary } from "@/lib/cv/storage";
import type { Locale } from "@/i18n/routing";

import { CompactStorageMark, StorageBadge } from "./storage-indicator";

export function CvDocumentCard({
  document,
  selected,
  collapsed,
  cloudActionsEnabled,
  onRename,
  onDuplicate,
  onMoveToCloud,
  onEnableEncryption,
  onDelete,
}: {
  document: CvDocumentSummary;
  selected: boolean;
  collapsed: boolean;
  cloudActionsEnabled: boolean;
  onRename: () => void;
  onDuplicate: () => void;
  onMoveToCloud: () => void;
  onEnableEncryption: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("CvDocumentCard");
  const tStorage = useTranslations("StorageIndicator");
  const locale = useLocale() as Locale;

  if (collapsed) {
    return (
      <div
        title={`${document.title} (${tStorage(document.storageKind)})`}
        className={cn(
          "pointer-events-none relative flex size-9 items-center justify-center rounded-md border text-slate-600 transition-colors hover:bg-slate-50",
          selected
            ? "border-emerald-300 bg-emerald-50 text-emerald-700"
            : "border-slate-200 bg-white",
        )}
      >
        <span className="text-sm font-semibold">{document.title.trim().charAt(0).toUpperCase() || t("fallbackInitial")}</span>
        <CompactStorageMark storageKind={document.storageKind} />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-md border p-2 transition-colors",
        selected ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-white hover:bg-slate-50",
      )}
    >
      <div className="flex w-full min-w-0 items-start justify-between gap-2 text-left">
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-slate-950">{document.title}</span>
          <span className="mt-1 block text-xs text-slate-500">
            {new Intl.DateTimeFormat(locale, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }).format(new Date(document.updatedAt))}
          </span>
        </span>
        <StorageBadge storageKind={document.storageKind} />
      </div>

      <div className="mt-2 flex items-center gap-1">
        <Button type="button" variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); onRename(); }} title={t("rename")}>
          <Pencil />
        </Button>
        <Button type="button" variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); onDuplicate(); }} title={t("duplicate")}>
          <Copy />
        </Button>
        {document.storageKind === "local" && cloudActionsEnabled && (
          <Button type="button" variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); onMoveToCloud(); }} title={t("moveToCloud")}>
            <CloudUpload />
          </Button>
        )}
        {document.storageKind !== "encrypted" && cloudActionsEnabled && (
          <Button type="button" variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); onEnableEncryption(); }} title={t("enableEncryption")}>
            <LockKeyhole />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title={t("delete")}
          className="ml-auto text-rose-700 hover:bg-rose-50"
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}
