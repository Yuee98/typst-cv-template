import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Panel({
  title,
  actions,
  children,
  className,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border border-slate-200 bg-white shadow-sm", className)}>
      {(title || actions) && (
        <div className="flex min-h-12 items-center justify-between gap-3 border-b border-slate-200 px-4">
          {title && <h2 className="text-sm font-semibold text-slate-950">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
