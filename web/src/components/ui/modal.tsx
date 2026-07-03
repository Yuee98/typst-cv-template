"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Modal({
  title,
  description,
  children,
  footer,
  onClose,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4 print:hidden">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className={cn("w-full max-w-md rounded-lg border border-slate-200 bg-white shadow-xl", className)}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <h2 id="modal-title" className="text-sm font-semibold text-slate-950">
              {title}
            </h2>
            {description && <p className="mt-1 text-sm leading-5 text-slate-500">{description}</p>}
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} title="Close">
            <X />
          </Button>
        </div>
        <div className="space-y-4 px-4 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">{footer}</div>}
      </section>
    </div>
  );
}
