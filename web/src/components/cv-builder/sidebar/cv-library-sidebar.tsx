"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import {
  ChevronLeft,
  ChevronRight,
  FileJson,
  FilePlus2,
  Plus,
} from "lucide-react";
import { type ChangeEvent, type ReactNode, useRef } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { CvDocumentSummary } from "@/lib/cv/storage";

import { CvDocumentCard } from "./cv-document-card";

function SortableCard({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled: boolean;
  children: (args: {
    isDragging: boolean;
    activatorRef: (node: HTMLButtonElement | null) => void;
    attributes: DraggableAttributes;
    listeners: DraggableSyntheticListeners;
  }) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const style = {
    transform: DndCSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "w-full",
        isDragging && "opacity-70",
      )}
    >
      {children({
        isDragging,
        activatorRef: (node) => setActivatorNodeRef(node),
        attributes,
        listeners,
      })}
    </div>
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
  restoreFocusRef,
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
  restoreFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const t = useTranslations("CvLibrary");
  const importInputRef = useRef<HTMLInputElement>(null);
  const newCvButtonRef = useRef<HTMLButtonElement>(null);
  const cardListRef = useRef<HTMLDivElement>(null);

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

  function setDeleteRestoreFocus(id: string) {
    if (!restoreFocusRef) return;
    const index = documents.findIndex((document) => document.id === id);
    const nextId = documents[index + 1]?.id ?? documents[index - 1]?.id ?? null;
    const target = nextId
      ? (cardListRef.current?.querySelector(
          `[data-cv-card-select="${CSS.escape(nextId)}"]`,
        ) as HTMLElement | null)
      : newCvButtonRef.current;
    restoreFocusRef.current = target ?? null;
  }

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

  function handleImportFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    onImportFile(file);
  }

  return (
    <aside
      className={cn(
        "library-sidebar relative flex h-full flex-col overflow-hidden rounded-xl border border-border glass-panel shadow-sm transition-[width] print:hidden",
        collapsed ? "w-14" : "w-full lg:w-72",
      )}
    >
      <>
        <div
          className={cn(
            "flex min-h-12 items-center border-b border-border px-2",
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
                <h2 className="truncate text-sm font-semibold text-foreground">{t("title")}</h2>
              </div>
              <div className="relative flex items-center gap-1">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      ref={newCvButtonRef}
                      type="button"
                      variant="ghost"
                      size="icon"
                      title={t("newCv")}
                    >
                      <Plus />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem icon={<FilePlus2 className="size-4" />} onSelect={onCreateEmpty}>
                      {t("emptyCv")}
                    </DropdownMenuItem>
                    <DropdownMenuItem icon={<FilePlus2 className="size-4" />} onSelect={onCreateSample}>
                      {t("sampleCv")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      icon={<FileJson className="size-4" />}
                      onSelect={() => importInputRef.current?.click()}
                    >
                      {t("importJson")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={onToggleCollapsed}
                  title={t("collapse")}
                >
                  <ChevronLeft />
                </Button>
              </div>
            </>
          )}
        </div>

        {collapsed && (
          <div className="border-b border-border p-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  ref={newCvButtonRef}
                  type="button"
                  variant="secondary"
                  size="icon"
                  title={t("newCv")}
                >
                  <Plus />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem icon={<FilePlus2 className="size-4" />} onSelect={onCreateEmpty}>
                  {t("emptyCv")}
                </DropdownMenuItem>
                <DropdownMenuItem icon={<FilePlus2 className="size-4" />} onSelect={onCreateSample}>
                  {t("sampleCv")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  icon={<FileJson className="size-4" />}
                  onSelect={() => importInputRef.current?.click()}
                >
                  {t("importJson")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </>

      {error && !collapsed && (
        <div className="border-b border-danger-border bg-danger-soft px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs text-danger-foreground">{error}</p>
            <button
              type="button"
              onClick={onDismissError}
              className="shrink-0 text-danger hover:text-danger-foreground"
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
            <div ref={cardListRef} className="flex flex-col gap-2">
              {documents.map((document) => (
                <SortableCard
                  key={document.id}
                  id={document.id}
                  disabled={collapsed}
                >
                  {({ activatorRef, attributes, listeners }) => (
                    <CvDocumentCard
                      document={document}
                      selected={document.id === activeDocumentId}
                      collapsed={collapsed}
                      cloudActionsEnabled={cloudActionsEnabled}
                      onSelect={() => onSelect(document.id)}
                      activatorRef={activatorRef}
                      dragAttributes={attributes}
                      dragListeners={listeners}
                      onRename={() => onRename(document.id)}
                      onDuplicate={() => onDuplicate(document.id)}
                      onMoveToCloud={() => onMoveToCloud(document.id)}
                      onEnableEncryption={() => onEnableEncryption(document.id)}
                      onDelete={() => {
                        setDeleteRestoreFocus(document.id);
                        onDelete(document.id);
                      }}
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
