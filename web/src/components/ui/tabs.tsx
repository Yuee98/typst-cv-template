"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as React from "react";

import { cn } from "@/lib/utils";

export const Tabs = TabsPrimitive.Root;

export function TabsList({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & {
  ref?: React.Ref<React.ComponentRef<typeof TabsPrimitive.List>>;
}) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        "flex w-full gap-1 overflow-x-auto px-3 py-2",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & {
  ref?: React.Ref<React.ComponentRef<typeof TabsPrimitive.Trigger>>;
}) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "h-8 shrink-0 whitespace-nowrap rounded-md px-3 text-sm font-medium text-foreground-muted outline-none transition-colors hover:text-foreground hover:bg-surface-hover data-[state=active]:bg-surface-active data-[state=active]:text-foreground data-[state=active]:shadow-sm dark:hover:bg-white/[0.04] dark:data-[state=active]:bg-white/[0.14] dark:data-[state=active]:shadow-md dark:data-[state=active]:shadow-black/40 dark:data-[state=active]:ring-1 dark:data-[state=active]:ring-white/[0.1]",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content> & {
  ref?: React.Ref<React.ComponentRef<typeof TabsPrimitive.Content>>;
}) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn("p-4 outline-none", className)}
      {...props}
    />
  );
}