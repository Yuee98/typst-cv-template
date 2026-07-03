"use client";

import { CloudUpload, Copy, Download, LockKeyhole, Pencil, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CvDocumentSummary } from "@/lib/cv/storage";

import { CompactStorageMark, StorageBadge, storageLabel } from "./storage-indicator";

export function CvDocumentCard({
  document,
  selected,
  collapsed,
  cloudActionsEnabled,
  dragHandle,
  onSelect,
  onRename,
  onDuplicate,
  onExport,
  onMoveToCloud,
  onEnableEncryption,
  onDelete,
}: {
  document: CvDocumentSummary;
  selected: boolean;
  collapsed: boolean;
  cloudActionsEnabled: boolean;
  dragHandle?: ReactNode;
  onSelect: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onMoveToCloud: () => void;
  onEnableEncryption: () => void;
  onDelete: () => void;
}) {
  if (collapsed) {
    return (
      <button
        type="button"
        title={`${document.title} (${storageLabel(document.storageKind)})`}
        onClick={onSelect}
        className={cn(
          "relative flex size-9 items-center justify-center rounded-md border text-slate-600 transition-colors hover:bg-slate-50",
          selected
            ? "border-emerald-300 bg-emerald-50 text-emerald-700"
            : "border-slate-200 bg-white",
        )}
      >
        <span className="text-sm font-semibold">{document.title.trim().charAt(0).toUpperCase() || "C"}</span>
        <CompactStorageMark storageKind={document.storageKind} />
      </button>
    );
  }

  return (
    <div
      className={cn(
        "rounded-md border p-2 transition-colors",
        selected ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-white hover:bg-slate-50",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full min-w-0 items-start justify-between gap-2 text-left"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-slate-950">{document.title}</span>
          <span className="mt-1 block text-xs text-slate-500">
            {new Intl.DateTimeFormat(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }).format(new Date(document.updatedAt))}
          </span>
        </span>
        <StorageBadge storageKind={document.storageKind} />
      </button>

      <div className="mt-2 flex items-center gap-1">
        {dragHandle}
        <Button type="button" variant="ghost" size="icon" onClick={onRename} title="Rename">
          <Pencil />
        </Button>
        <Button type="button" variant="ghost" size="icon" onClick={onDuplicate} title="Duplicate">
          <Copy />
        </Button>
        <Button type="button" variant="ghost" size="icon" onClick={onExport} title="Export JSON">
          <Download />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onMoveToCloud}
          disabled={!cloudActionsEnabled || document.storageKind !== "local"}
          title="Move to cloud"
        >
          <CloudUpload />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onEnableEncryption}
          disabled={!cloudActionsEnabled || document.storageKind === "encrypted"}
          title="Enable encryption"
        >
          <LockKeyhole />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onDelete}
          title="Delete"
          className="ml-auto text-rose-700 hover:bg-rose-50"
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}
