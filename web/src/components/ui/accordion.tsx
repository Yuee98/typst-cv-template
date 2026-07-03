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

export const AccordionItem = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>
>(({ className, ...props }, ref) => (
  <AccordionPrimitive.Item
    ref={ref}
    className={cn("border-b border-slate-200", className)}
    {...props}
  />
));
AccordionItem.displayName = AccordionPrimitive.Item.displayName;

export const AccordionTrigger = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Header className="flex flex-1">
    <AccordionPrimitive.Trigger
      ref={ref}
      className={cn(
        "flex min-h-11 w-full flex-1 items-center justify-between gap-3 py-2 text-left text-sm font-semibold text-slate-900 outline-none transition-colors hover:text-slate-600 [&[data-state=open]>svg]:rotate-180",
        className,
      )}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronDown className="size-4 shrink-0 transition-transform" />
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
));
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

export const AccordionContent = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(({ className, children, ...props }, ref) => {
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
});
AccordionContent.displayName = AccordionPrimitive.Content.displayName;
