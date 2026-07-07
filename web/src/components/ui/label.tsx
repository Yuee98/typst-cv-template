import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";

import { cn } from "@/lib/utils";

export function Label({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & {
  ref?: React.Ref<React.ComponentRef<typeof LabelPrimitive.Root>>;
}) {
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn("text-xs font-medium uppercase tracking-wide text-foreground-muted", className)}
      {...props}
    />
  );
}