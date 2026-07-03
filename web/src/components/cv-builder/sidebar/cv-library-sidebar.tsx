"use client";

import {
  ChevronLeft,
  ChevronRight,
  FileJson,
  FilePlus2,
  Plus,
} from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CvDocumentSummary } from "@/lib/cv/storage";
import { useClickOutside } from "@/hooks/use-click-outside";

import { CvDocumentCard } from "./cv-document-card";

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
  const createMenuRef = useRef<HTMLDivElement>(null);
  useClickOutside(createMenuRef, () => setCreateMenuOpen(false), createMenuOpen);

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
      <div ref={createMenuRef}>
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
              <div className="relative flex items-center gap-1">
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
                {createMenu}
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
      </div>

      <div className={cn("min-h-0 flex-1 overflow-y-auto", collapsed ? "p-2" : "p-2")}>
        <div className="flex flex-col gap-2">
          {documents.map((document) => (
            <CvDocumentCard
              key={document.id}
              document={document}
              selected={document.id === activeDocumentId}
              collapsed={collapsed}
              cloudActionsEnabled={cloudActionsEnabled}
              onSelect={() => onSelect(document.id)}
              onRename={() => onRename(document.id)}
              onDuplicate={() => onDuplicate(document.id)}
              onExport={() => onExport(document.id)}
              onMoveToCloud={() => onMoveToCloud(document.id)}
              onEnableEncryption={() => onEnableEncryption(document.id)}
              onDelete={() => onDelete(document.id)}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}
