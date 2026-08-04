"use client";

import type { ComponentPropsWithoutRef, ReactNode, RefObject } from "react";
import { useRef } from "react";
import {
  Close,
  Content,
  Description,
  Overlay,
  Portal,
  Root,
  Title,
} from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ContentProps = ComponentPropsWithoutRef<typeof Content>;

export function ModalDialog({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  className,
  closeLabel = "Close",
  initialFocusRef,
  restoreFocusRef,
  bodyClassName,
  footerClassName,
  closeDisabled = false,
  onEscapeKeyDown,
  onPointerDownOutside,
}: {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  className?: string;
  closeLabel?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  /** Extra classes for the scrollable body region. */
  bodyClassName?: string;
  /** Extra classes for the footer row. */
  footerClassName?: string;
  /** When true, the X button, Escape key and overlay clicks cannot close the dialog. */
  closeDisabled?: boolean;
  /** Radix control points; call event.preventDefault() to veto that close path. */
  onEscapeKeyDown?: ContentProps["onEscapeKeyDown"];
  onPointerDownOutside?: ContentProps["onPointerDownOutside"];
}) {
  const triggerRef = useRef<HTMLElement | null>(null);

  const descriptionAriaProps = description ? {} : { "aria-describedby": undefined };

  return (
    <Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !closeDisabled) onClose(); }}>
      <Portal>
        <Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm print:hidden" />
        <Content
          aria-modal="true"
          onOpenAutoFocus={(event) => {
            triggerRef.current = document.activeElement as HTMLElement;
            if (initialFocusRef?.current?.isConnected) {
              event.preventDefault();
              initialFocusRef.current.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            const target = restoreFocusRef?.current ?? triggerRef.current;
            if (target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
          onEscapeKeyDown={onEscapeKeyDown}
          onPointerDownOutside={onPointerDownOutside}
          {...descriptionAriaProps}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-surface shadow-xl outline-none",
            className,
          )}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <Title className="text-sm font-semibold text-foreground">
                {title}
              </Title>
              {description && (
                <Description className="mt-1 text-sm leading-5 text-foreground-muted">
                  {description}
                </Description>
              )}
            </div>
            <Close asChild>
              <Button type="button" variant="ghost" size="icon" aria-label={closeLabel} disabled={closeDisabled}>
                <X />
              </Button>
            </Close>
          </div>
          <div className={cn("min-h-0 space-y-4 overflow-y-auto px-4 py-4", bodyClassName)}>{children}</div>
          {footer && (
            <div className={cn("flex shrink-0 items-center justify-end gap-2 px-4 py-3", footerClassName)}>
              {footer}
            </div>
          )}
        </Content>
      </Portal>
    </Root>
  );
}