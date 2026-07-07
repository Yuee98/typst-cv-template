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
import { GripVertical } from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, useMemo, useState } from "react";

import { Accordion } from "@/components/ui/accordion";
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
  handleClassName,
  handleLabel = "Drag to reorder",
  disabled = false,
  onSortStart,
  onSortEnd,
}: {
  items: T[];
  getId: (item: T) => string;
  onMove: (fromIndex: number, toIndex: number) => void;
  renderItem: (args: SortableRenderArgs<T>) => ReactNode;
  renderContainer?: (children: ReactNode, className?: string) => ReactNode;
  className?: string;
  itemClassName?: string;
  handleClassName?: string;
  handleLabel?: string;
  disabled?: boolean;
  onSortStart?: () => void;
  onSortEnd?: () => void;
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
        handleClassName={handleClassName}
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

  function handleDragStart() {
    onSortStart?.();
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      onSortEnd?.();
      return;
    }

    const fromIndex = ids.indexOf(String(active.id));
    const toIndex = ids.indexOf(String(over.id));
    if (fromIndex === -1 || toIndex === -1) {
      onSortEnd?.();
      return;
    }

    onMove(fromIndex, toIndex);
    onSortEnd?.();
  }

  function handleDragCancel() {
    onSortEnd?.();
  }

  if (dragDisabled) {
    return renderListContainer(renderPlainItems());
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
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
  handleClassName,
  handleLabel,
}: {
  id: string;
  children: (args: { dragHandle: ReactNode; isDragging: boolean }) => ReactNode;
  className?: string;
  handleClassName?: string;
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
    transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
    transition,
    zIndex: isDragging ? 20 : undefined,
  };

  const dragHandle = (
    <button
      ref={setActivatorNodeRef}
      type="button"
      className={cn(
        "flex size-8 shrink-0 touch-none items-center justify-center rounded-md border border-transparent text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        handleClassName,
      )}
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

export function SortableAccordionList<T>({
  items,
  getId,
  onMove,
  renderItem,
  className,
  itemClassName,
  handleClassName,
  handleLabel = "Drag to reorder",
  disabled = false,
}: {
  items: T[];
  getId: (item: T) => string;
  onMove: (fromIndex: number, toIndex: number) => void;
  renderItem: (args: SortableRenderArgs<T>) => ReactNode;
  className?: string;
  itemClassName?: string;
  handleClassName?: string;
  handleLabel?: string;
  disabled?: boolean;
}) {
  const [openValues, setOpenValues] = useState<string[]>([]);
  const [sorting, setSorting] = useState(false);

  return (
    <SortableList
      items={items}
      getId={getId}
      onMove={onMove}
      className={className}
      itemClassName={itemClassName}
      handleClassName={cn("-ml-2", handleClassName)}
      handleLabel={handleLabel}
      disabled={disabled}
      onSortStart={() => {
        setSorting(true);
        setOpenValues([]);
      }}
      onSortEnd={() => setSorting(false)}
      renderContainer={(children, containerClassName) => (
        <Accordion
          type="multiple"
          value={openValues}
          onValueChange={setOpenValues}
          sorting={sorting}
          className={containerClassName}
        >
          {children}
        </Accordion>
      )}
      renderItem={renderItem}
    />
  );
}
