import * as React from "react";

import { cn } from "@/lib/utils";

export function Textarea({
  className,
  ref,
  ...props
}: React.ComponentProps<"textarea"> & { ref?: React.Ref<HTMLTextAreaElement> }) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "min-h-20 w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm leading-6 text-foreground shadow-sm outline-none transition-colors placeholder:text-foreground-subtle focus:border-border-strong focus:ring-2 focus:ring-ring/30 dark:border-white/[0.08] dark:bg-white/[0.04]",
        className,
      )}
      {...props}
    />
  );
}