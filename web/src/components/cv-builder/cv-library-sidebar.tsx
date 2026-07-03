"use client";

import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  CloudUpload,
  Copy,
  Download,
  FileJson,
  FilePlus2,
  HardDrive,
  LockKeyhole,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CvDocumentSummary, CvStorageKind } from "@/lib/cv/storage";

function StorageIcon({ storageKind }: { storageKind: CvStorageKind }) {
  if (storageKind === "encrypted") {
    return <LockKeyhole className="size-4" />;
  }

  if (storageKind === "cloud") {
    return <Cloud className="size-4" />;
  }

  return <HardDrive className="size-4" />;
}

function storageLabel(storageKind: CvStorageKind) {
  if (storageKind === "encrypted") return "Encrypted";
  if (storageKind === "cloud") return "Cloud";
  return "Local";
}

function StorageBadge({ storageKind }: { storageKind: CvStorageKind }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium",
        storageKind === "encrypted" && "border-violet-200 bg-violet-50 text-violet-700",
        storageKind === "cloud" && "border-sky-200 bg-sky-50 text-sky-700",
        storageKind === "local" && "border-slate-200 bg-slate-50 text-slate-600",
      )}
    >
      <StorageIcon storageKind={storageKind} />
      {storageLabel(storageKind)}
    </span>
  );
}

function CompactStorageMark({ storageKind }: { storageKind: CvStorageKind }) {
  return (
    <span
      className={cn(
        "absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full border bg-white",
        storageKind === "encrypted" && "border-violet-200 text-violet-700",
        storageKind === "cloud" && "border-sky-200 text-sky-700",
        storageKind === "local" && "border-slate-200 text-slate-600",
      )}
    >
      <StorageIcon storageKind={storageKind} />
    </span>
  );
}

export function CvLibrarySidebar({
  documents,
  activeDocumentId,
  collapsed,
  cloudActionsEnabled,
  onToggleCollapsed,
  onCreateEmpty,
  onCreateSample,
  onImportJson,
  onSelect,
  onRename,
  onDuplicate,
  onExport,
  onDelete,
  onMoveToCloud,
  onEnableEncryption,
}: {
  documents: CvDocumentSummary[];
  activeDocumentId: string | null;
  collapsed: boolean;
  cloudActionsEnabled: boolean;
  onToggleCollapsed: () => void;
  onCreateEmpty: () => void;
  onCreateSample: () => void;
  onImportJson: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string) => void;
  onDuplicate: (id: string) => void;
  onExport: (id: string) => void;
  onDelete: (id: string) => void;
  onMoveToCloud: (id: string) => void;
  onEnableEncryption: (id: string) => void;
}) {
  const [createMenuOpen, setCreateMenuOpen] = useState(false);

  function runCreateAction(action: () => void) {
    setCreateMenuOpen(false);
    action();
  }

  const createMenu = createMenuOpen && (
    <div
      className={cn(
        "absolute z-20 w-44 rounded-md border border-slate-200 bg-white p-1 shadow-lg",
        collapsed ? "left-2 top-24" : "right-2 top-11",
      )}
    >
      <button
        type="button"
        className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-700 hover:bg-slate-50"
        onClick={() => runCreateAction(onCreateEmpty)}
      >
        <FilePlus2 className="size-4" />
        Empty CV
      </button>
      <button
        type="button"
        className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-700 hover:bg-slate-50"
        onClick={() => runCreateAction(onCreateSample)}
      >
        <FilePlus2 className="size-4" />
        Sample CV
      </button>
      <button
        type="button"
        className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-700 hover:bg-slate-50"
        onClick={() => runCreateAction(onImportJson)}
      >
        <FileJson className="size-4" />
        Import JSON
      </button>
    </div>
  );

  return (
    <aside
      className={cn(
        "library-sidebar relative flex h-full min-h-[720px] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm transition-[width] print:hidden",
        collapsed ? "w-14" : "w-full lg:w-72",
      )}
    >
      <div
        className={cn(
          "flex min-h-12 items-center border-b border-slate-200 px-2",
          collapsed ? "justify-center" : "justify-between gap-2",
        )}
      >
        {collapsed ? (
          <Button type="button" variant="ghost" size="icon" onClick={onToggleCollapsed} title="Expand CV library">
            <ChevronRight />
          </Button>
        ) : (
          <>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-slate-950">CVs</h2>
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setCreateMenuOpen((open) => !open)}
                title="New CV"
              >
                <Plus />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onToggleCollapsed}
                title="Collapse CV library"
              >
                <ChevronLeft />
              </Button>
            </div>
          </>
        )}
      </div>

      {collapsed && (
        <div className="border-b border-slate-200 p-2">
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={() => setCreateMenuOpen((open) => !open)}
            title="New CV"
          >
            <Plus />
          </Button>
        </div>
      )}
      {createMenu}

      <div className={cn("min-h-0 flex-1 overflow-y-auto", collapsed ? "p-2" : "p-2")}>
        <div className="flex flex-col gap-2">
          {documents.map((document) => {
            const selected = document.id === activeDocumentId;

            if (collapsed) {
              return (
                <button
                  key={document.id}
                  type="button"
                  title={`${document.title} (${storageLabel(document.storageKind)})`}
                  onClick={() => onSelect(document.id)}
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
                key={document.id}
                className={cn(
                  "rounded-md border p-2 transition-colors",
                  selected ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-white hover:bg-slate-50",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect(document.id)}
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
                  <Button type="button" variant="ghost" size="icon" onClick={() => onRename(document.id)} title="Rename">
                    <Pencil />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => onDuplicate(document.id)}
                    title="Duplicate"
                  >
                    <Copy />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => onExport(document.id)}
                    title="Export JSON"
                  >
                    <Download />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => onMoveToCloud(document.id)}
                    disabled={!cloudActionsEnabled || document.storageKind !== "local"}
                    title="Move to cloud"
                  >
                    <CloudUpload />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => onEnableEncryption(document.id)}
                    disabled={!cloudActionsEnabled || document.storageKind === "encrypted"}
                    title="Enable encryption"
                  >
                    <LockKeyhole />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => onDelete(document.id)}
                    title="Delete"
                    className="ml-auto text-rose-700 hover:bg-rose-50"
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
