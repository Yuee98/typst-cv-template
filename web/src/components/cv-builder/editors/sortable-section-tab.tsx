import {
  useCallback,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { useTranslations } from "next-intl";
import { useSortable } from "@dnd-kit/sortable";

import type { CvSectionId } from "@/lib/cv/schema";
import { cn } from "@/lib/utils";

import { TabsTrigger } from "@/components/ui/tabs";

export const TAB_NAVIGATION_KEYS_DURING_DRAG = new Set([
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export function isTabNavigationKeyDuringDrag(key: string, dragging: boolean): boolean {
  return dragging && TAB_NAVIGATION_KEYS_DURING_DRAG.has(key);
}

export function getSortableSectionTabStyle(
  transform: { x: number; y: number } | null,
  transition: string | undefined,
  isDragging: boolean,
): CSSProperties {
  return {
    transform: transform ? `translate3d(${transform.x}px, 0, 0)` : undefined,
    transition,
    zIndex: isDragging ? 20 : undefined,
  };
}

export function handleSortableTabKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  keyboardDragActive: boolean,
  onDragKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void,
): void {
  onDragKeyDown?.(event);
  if (isTabNavigationKeyDuringDrag(event.key, keyboardDragActive)) {
    event.preventDefault();
  }
}

export function SortableSectionTab({
  id,
  label,
  keyboardDragActive,
}: {
  id: CvSectionId;
  label: string;
  keyboardDragActive: boolean;
}) {
  const t = useTranslations("Editors");
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id });
  const { onKeyDown, ...dragListeners } = listeners ?? {};
  const dragKeyDown = onKeyDown as
    | ((event: KeyboardEvent<HTMLButtonElement>) => void)
    | undefined;
  const setRefs = useCallback(
    (node: HTMLButtonElement | null) => {
      setNodeRef(node);
      setActivatorNodeRef(node);
    },
    [setActivatorNodeRef, setNodeRef],
  );
  const dragAttributes = {
    "aria-describedby": attributes["aria-describedby"],
    "aria-roledescription": attributes["aria-roledescription"],
  };
  const style = getSortableSectionTabStyle(transform, transition, isDragging);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      handleSortableTabKeyDown(event, keyboardDragActive, dragKeyDown);
    },
    [dragKeyDown, keyboardDragActive],
  );

  return (
    <TabsTrigger
      ref={setRefs}
      value={id}
      style={style}
      className={cn(
        "touch-none cursor-grab active:cursor-grabbing",
        isDragging && "opacity-70",
      )}
      title={t("dragTitle")}
      {...dragAttributes}
      aria-label={t("aria.dragSection", { label })}
      {...dragListeners}
      onKeyDown={handleKeyDown}
    >
      {label}
    </TabsTrigger>
  );
}
