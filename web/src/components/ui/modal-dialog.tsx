"use client";

import type { ReactNode, RefObject } from "react";
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

export function ModalDialog({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  className,
  closeLabel = "Close",
  restoreFocusRef,
}: {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  className?: string;
  closeLabel?: string;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const triggerRef = useRef<HTMLElement | null>(null);

  const descriptionAriaProps = description ? {} : { "aria-describedby": undefined };

  return (
    <Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <Portal>
        <Overlay className="fixed inset-0 z-50 bg-slate-950/35 print:hidden" />
        <Content
          aria-modal="true"
          onOpenAutoFocus={() => {
            triggerRef.current = document.activeElement as HTMLElement;
          }}
          onCloseAutoFocus={(event) => {
            const target = restoreFocusRef?.current ?? triggerRef.current;
            if (target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
          {...descriptionAriaProps}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-slate-200 bg-white shadow-xl outline-none",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <Title className="text-sm font-semibold text-slate-950">
                {title}
              </Title>
              {description && (
                <Description className="mt-1 text-sm leading-5 text-slate-500">
                  {description}
                </Description>
              )}
            </div>
            <Close asChild>
              <Button type="button" variant="ghost" size="icon" aria-label={closeLabel}>
                <X />
              </Button>
            </Close>
          </div>
          <div className="space-y-4 px-4 py-4">{children}</div>
          {footer && (
            <div className="flex items-center justify-end gap-2 px-4 py-3">
              {footer}
            </div>
          )}
        </Content>
      </Portal>
    </Root>
  );
}
