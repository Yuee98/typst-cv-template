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
import { GripVertical } from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, useMemo } from "react";

import { cn } from "@/lib/utils";

type SortableRenderArgs<T> = {
  item: T;
  index: number;
  dragHandle: ReactNode;
  isDragging: boolean;
};

export function SortableList<T>({
  items,
  getId,
  onMove,
  renderItem,
  renderContainer,
  className,
  itemClassName,
  handleLabel = "Drag to reorder",
  disabled = false,
}: {
  items: T[];
  getId: (item: T) => string;
  onMove: (fromIndex: number, toIndex: number) => void;
  renderItem: (args: SortableRenderArgs<T>) => ReactNode;
  renderContainer?: (children: ReactNode, className?: string) => ReactNode;
  className?: string;
  itemClassName?: string;
  handleLabel?: string;
  disabled?: boolean;
}) {
  const ids = useMemo(() => items.map(getId), [getId, items]);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const dragDisabled = disabled || items.length < 2;

  function renderPlainItems() {
    return items.map((item, index) => (
      <Fragment key={getId(item)}>
        {renderItem({ item, index, dragHandle: null, isDragging: false })}
      </Fragment>
    ));
  }

  function renderSortableItems() {
    return items.map((item, index) => (
      <SortableListItem
        key={getId(item)}
        id={getId(item)}
        className={itemClassName}
        handleLabel={handleLabel}
      >
        {({ dragHandle, isDragging }) =>
          renderItem({ item, index, dragHandle, isDragging })
        }
      </SortableListItem>
    ));
  }

  function renderListContainer(children: ReactNode) {
    return renderContainer ? renderContainer(children, className) : <div className={className}>{children}</div>;
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    const fromIndex = ids.indexOf(String(active.id));
    const toIndex = ids.indexOf(String(over.id));
    if (fromIndex === -1 || toIndex === -1) {
      return;
    }

    onMove(fromIndex, toIndex);
  }

  if (dragDisabled) {
    return renderListContainer(renderPlainItems());
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {renderListContainer(renderSortableItems())}
      </SortableContext>
    </DndContext>
  );
}

function SortableListItem({
  id,
  children,
  className,
  handleLabel,
}: {
  id: string;
  children: (args: { dragHandle: ReactNode; isDragging: boolean }) => ReactNode;
  className?: string;
  handleLabel: string;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
  };

  const dragHandle = (
    <button
      ref={setActivatorNodeRef}
      type="button"
      className="flex size-8 shrink-0 touch-none items-center justify-center rounded-md border border-transparent text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950"
      aria-label={handleLabel}
      title={handleLabel}
      {...attributes}
      {...listeners}
    >
      <GripVertical className="size-4" />
    </button>
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("relative", isDragging && "opacity-70", className)}
    >
      {children({ dragHandle, isDragging })}
    </div>
  );
}
