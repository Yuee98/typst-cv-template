"use client";

import { useEffect, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { Content, Overlay, Portal, Root, Title } from "@radix-ui/react-dialog";
import styles from "./responsive-library.module.css";

export const LIBRARY_DOCK_QUERY = "(min-width: 1440px) and (min-aspect-ratio: 4/3) and (min-height: 500px)";

function dockedSnapshot() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(LIBRARY_DOCK_QUERY).matches;
}

function subscribeDocked(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(LIBRARY_DOCK_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function ResponsiveLibrary({
  children,
  open,
  onOpenChange,
  triggerRef,
  title,
}: {
  children: (docked: boolean) => ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLElement | null>;
  title: string;
}) {
  const docked = useSyncExternalStore(subscribeDocked, dockedSnapshot, () => false);

  useEffect(() => {
    if (docked && open) onOpenChange(false);
  }, [docked, open, onOpenChange]);

  function restoreTriggerFocus(event: Event) {
    event.preventDefault();
    // A library action can open another modal in the same React commit. Let
    // its focus scope take ownership before considering the header trigger.
    queueMicrotask(() => {
      if (dockedSnapshot() || document.querySelector('[role="dialog"][aria-modal="true"][data-state="open"]')) return;
      const trigger = triggerRef.current;
      if (trigger?.isConnected && !trigger.closest("[hidden], [inert]") && getComputedStyle(trigger).display !== "none") {
        trigger.focus({ preventScroll: true });
      }
    });
  }

  return <div className="library-column h-full min-h-0 shrink-0" data-docked={docked ? "true" : "false"}>
    {docked ? children(true) : <Root open={open} onOpenChange={onOpenChange}>
      <Portal>
        <Overlay data-library-overlay className={`${styles.overlay} fixed inset-0 z-50 bg-black/50 print:hidden`} />
        <Content
          aria-modal="true"
          aria-describedby={undefined}
          onCloseAutoFocus={restoreTriggerFocus}
          className={`${styles.drawer} library-drawer fixed inset-y-0 left-0 z-50 flex h-dvh w-[min(22rem,calc(100vw-2rem))] flex-col border-r border-border bg-surface text-foreground outline-none print:hidden`}
        >
          <Title className="sr-only">{title}</Title>
          <div className="min-h-0 flex-1 overflow-hidden p-3">{children(false)}</div>
        </Content>
      </Portal>
    </Root>}
  </div>;
}
