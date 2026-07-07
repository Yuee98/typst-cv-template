import * as React from "react";

import { cn } from "@/lib/utils";

export function Input({
  className,
  type,
  ref,
  ...props
}: React.ComponentProps<"input"> & { ref?: React.Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        "h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-foreground-subtle focus:border-border-strong focus:ring-2 focus:ring-ring/30 dark:border-white/[0.08] dark:bg-white/[0.04]",
        className,
      )}
      {...props}
    />
  );
}