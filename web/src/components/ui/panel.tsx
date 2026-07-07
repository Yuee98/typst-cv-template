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
    <section className={cn("rounded-xl border border-border glass-panel shadow-sm", className)}>
      {(title || actions) && (
        <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border px-4">
          {title && <h2 className="text-sm font-semibold text-foreground">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}