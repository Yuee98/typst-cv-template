"use client";

import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { ChevronDown } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

const AccordionSortingContext = React.createContext(false);

export function Accordion({
  sorting = false,
  ...props
}: React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Root> & {
  sorting?: boolean;
}) {
  return (
    <AccordionSortingContext.Provider value={sorting}>
      <AccordionPrimitive.Root {...props} />
    </AccordionSortingContext.Provider>
  );
}

export function AccordionItem({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item> & {
  ref?: React.Ref<React.ComponentRef<typeof AccordionPrimitive.Item>>;
}) {
  return (
    <AccordionPrimitive.Item
      ref={ref}
      className={cn("border-b border-border", className)}
      {...props}
    />
  );
}

export function AccordionTrigger({
  className,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger> & {
  ref?: React.Ref<React.ComponentRef<typeof AccordionPrimitive.Trigger>>;
}) {
  return (
    <AccordionPrimitive.Header className="flex flex-1">
      <AccordionPrimitive.Trigger
        ref={ref}
        className={cn(
          "flex min-h-11 w-full flex-1 items-center justify-between gap-3 py-2 text-left text-sm font-semibold text-foreground outline-none transition-colors hover:text-foreground-muted [&[data-state=open]>svg]:rotate-180",
          className,
        )}
        {...props}
      >
        <span className="min-w-0 flex-1 truncate">{children}</span>
        <ChevronDown className="size-4 shrink-0 transition-transform" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

export function AccordionContent({
  className,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content> & {
  ref?: React.Ref<React.ComponentRef<typeof AccordionPrimitive.Content>>;
}) {
  const sorting = React.useContext(AccordionSortingContext);

  return (
    <AccordionPrimitive.Content
      ref={ref}
      data-sorting={sorting ? "true" : undefined}
      className="accordion-content overflow-hidden"
      {...props}
    >
      <div className={cn("pb-4", className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
}