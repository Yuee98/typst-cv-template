"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronLeft,
  ChevronRight,
  FileJson,
  FilePlus2,
  Plus,
} from "lucide-react";
import { type ChangeEvent, type ReactNode, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CvDocumentSummary } from "@/lib/cv/storage";
import { useClickOutside } from "@/hooks/use-click-outside";

import { CvDocumentCard } from "./cv-document-card";

function SortableCard({
  id,
  disabled,
  selected,
  onClick,
  children,
}: {
  id: string;
  disabled: boolean;
  selected: boolean;
  onClick?: () => void;
  children: (args: { isDragging: boolean }) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
  };

  return (
    <button
      type="button"
      ref={setNodeRef}
      style={style}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "w-full cursor-pointer text-left",
        isDragging && "opacity-70",
      )}
      {...attributes}
      {...listeners}
      onClick={onClick}
    >
      {children({ isDragging })}
    </button>
  );
}

export function CvLibrarySidebar({
  documents,
  activeDocumentId,
  collapsed,
  cloudActionsEnabled,
  error,
  onToggleCollapsed,
  onCreateEmpty,
  onCreateSample,
  onImportFile,
  onSelect,
  onRename,
  onDuplicate,
  onReorder,
  onDelete,
  onMoveToCloud,
  onEnableEncryption,
  onDismissError,
}: {
  documents: CvDocumentSummary[];
  activeDocumentId: string | null;
  collapsed: boolean;
  cloudActionsEnabled: boolean;
  error: string | null;
  onToggleCollapsed: () => void;
  onCreateEmpty: () => void;
  onCreateSample: () => void;
  onImportFile: (file: File | undefined) => void;
  onSelect: (id: string) => void;
  onRename: (id: string) => void;
  onDuplicate: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onDelete: (id: string) => void;
  onMoveToCloud: (id: string) => void;
  onEnableEncryption: (id: string) => void;
  onDismissError: () => void;
}) {
  const t = useTranslations("CvLibrary");
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createMenuRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  useClickOutside(createMenuRef, () => setCreateMenuOpen(false), createMenuOpen);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: {
        start: ["Enter"],
        cancel: ["Escape"],
        end: ["Enter", "Escape"],
      },
    }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = documents.map((d) => d.id);
    const fromIndex = ids.indexOf(String(active.id));
    const toIndex = ids.indexOf(String(over.id));
    if (fromIndex !== -1 && toIndex !== -1) {
      onReorder(fromIndex, toIndex);
    }
  }

  function runCreateAction(action: () => void) {
    setCreateMenuOpen(false);
    action();
  }

  function handleImportFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    onImportFile(file);
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
        {t("emptyCv")}
      </button>
      <button
        type="button"
        className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-700 hover:bg-slate-50"
        onClick={() => runCreateAction(onCreateSample)}
      >
        <FilePlus2 className="size-4" />
        {t("sampleCv")}
      </button>
      <button
        type="button"
        className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-700 hover:bg-slate-50"
        onClick={() => runCreateAction(() => importInputRef.current?.click())}
      >
        <FileJson className="size-4" />
        {t("importJson")}
      </button>
    </div>
  );

  return (
    <aside
      className={cn(
        "library-sidebar relative flex h-full flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm transition-[width] print:hidden",
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
            <Button type="button" variant="ghost" size="icon" onClick={onToggleCollapsed} title={t("expand")}>
              <ChevronRight />
            </Button>
          ) : (
            <>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-slate-950">{t("title")}</h2>
              </div>
              <div className="relative flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setCreateMenuOpen((open) => !open)}
                  title={t("newCv")}
                >
                  <Plus />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={onToggleCollapsed}
                  title={t("collapse")}
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
              title={t("newCv")}
            >
              <Plus />
            </Button>
          </div>
        )}
      </div>

      {error && !collapsed && (
        <div className="border-b border-rose-200 bg-rose-50 px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs text-rose-800">{error}</p>
            <button
              type="button"
              onClick={onDismissError}
              className="shrink-0 text-rose-600 hover:text-rose-800"
            >
              <span className="sr-only">{t("dismiss")}</span>
              <span aria-hidden="true">&times;</span>
            </button>
          </div>
        </div>
      )}

      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleImportFileChange}
      />

      <div className={cn("min-h-0 flex-1 overflow-y-auto", collapsed ? "p-2" : "p-2")}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[({ transform }) => ({ ...transform, x: 0 })]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={documents.map((d) => d.id)}
            strategy={verticalListSortingStrategy}
            disabled={collapsed}
          >
            <div className="flex flex-col gap-2">
              {documents.map((document) => (
                <SortableCard
                  key={document.id}
                  id={document.id}
                  disabled={collapsed}
                  selected={document.id === activeDocumentId}
                  onClick={() => onSelect(document.id)}
                >
                  {() => (
                    <CvDocumentCard
                      document={document}
                      selected={document.id === activeDocumentId}
                      collapsed={collapsed}
                      cloudActionsEnabled={cloudActionsEnabled}
                      onRename={() => onRename(document.id)}
                      onDuplicate={() => onDuplicate(document.id)}
                      onMoveToCloud={() => onMoveToCloud(document.id)}
                      onEnableEncryption={() => onEnableEncryption(document.id)}
                      onDelete={() => onDelete(document.id)}
                    />
                  )}
                </SortableCard>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </aside>
  );
}
