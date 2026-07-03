"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export function MenuItem({
  icon,
  children,
  className,
  ...props
}: {
  icon?: ReactNode;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}

export function MenuDivider({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-slate-200 px-2 pb-2">
      {children}
    </div>
  );
}

export function MenuContainer({
  align = "right",
  children,
}: {
  align?: "left" | "right";
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "absolute z-30 mt-2 w-64 rounded-md border border-slate-200 bg-white p-2 shadow-lg",
        align === "right" ? "right-0" : "left-0",
      )}
    >
      <div className="space-y-1">{children}</div>
    </div>
  );
}
