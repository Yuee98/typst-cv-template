"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { MenuContainer } from "@/components/ui/menu-item";
import { useClickOutside } from "@/hooks/use-click-outside";
import { cn } from "@/lib/utils";

type ToolbarMenuControls = {
  open: boolean;
  close: () => void;
  toggle: () => void;
};

type MenuPosition = {
  left: number;
  top: number;
};

export function ToolbarMenu({
  align = "center",
  menuClassName,
  trigger,
  children,
}: {
  align?: "left" | "center" | "right";
  menuClassName?: string;
  trigger: (controls: ToolbarMenuControls) => ReactNode;
  children: (controls: Pick<ToolbarMenuControls, "close">) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const floatingMenuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const outsideRefs = useMemo(() => [menuRef, floatingMenuRef], []);
  const close = useCallback(() => {
    setMenuPosition(null);
    setOpen(false);
  }, []);
  const toggle = useCallback(() => {
    setMenuPosition(null);
    setOpen((current) => !current);
  }, []);

  useClickOutside(outsideRefs, close, open);

  useLayoutEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement as HTMLElement;
    } else if (triggerRef.current?.isConnected) {
      triggerRef.current.focus();
    }
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;

    function updateMenuPosition() {
      const trigger = menuRef.current;
      const menu = floatingMenuRef.current;
      if (!trigger || !menu) return;

      const viewportMargin = 8;
      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const maxLeft = window.innerWidth - viewportMargin - menuRect.width;
      const boundedMaxLeft = Math.max(viewportMargin, maxLeft);
      let left =
        align === "right"
          ? triggerRect.right - menuRect.width
          : align === "left"
            ? triggerRect.left
            : triggerRect.left + triggerRect.width / 2 - menuRect.width / 2;
      let top = triggerRect.bottom + viewportMargin;

      if (top + menuRect.height > window.innerHeight - viewportMargin) {
        top = Math.max(viewportMargin, triggerRect.top - viewportMargin - menuRect.height);
      }

      left = Math.min(Math.max(left, viewportMargin), boundedMaxLeft);

      setMenuPosition((currentPosition) => {
        const nextPosition = { left, top };

        if (
          currentPosition
          && Math.abs(currentPosition.left - nextPosition.left) < 0.5
          && Math.abs(currentPosition.top - nextPosition.top) < 0.5
        ) {
          return currentPosition;
        }

        return nextPosition;
      });
    }

    const frame = window.requestAnimationFrame(updateMenuPosition);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [align, open]);

  const menuStyle = useMemo(() => {
    if (!menuPosition) {
      return { left: 0, top: 0, visibility: "hidden" as const };
    }

    return menuPosition;
  }, [menuPosition]);

  const menu = open && typeof document !== "undefined"
    ? createPortal(
      <MenuContainer
        ref={floatingMenuRef}
        align="left"
        className={cn(
          "fixed mt-0 w-max min-w-40 max-h-[calc(100vh-1rem)] max-w-[calc(100vw-1rem)] overflow-auto",
          menuClassName,
        )}
        style={menuStyle}
      >
        {children({ close })}
      </MenuContainer>,
      document.body,
    )
    : null;

  return (
    <div className="relative" ref={menuRef}>
      {trigger({ open, close, toggle })}
      {menu}
    </div>
  );
}
