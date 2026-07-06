"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 rounded-b-lg border border-slate-200 bg-white px-4 py-3 shadow-sm print:hidden">
      {children}
    </header>
  );
}

export function ToolbarGroup({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export function ToolbarSeparator() {
  return <span aria-hidden="true" className="hidden h-6 w-px bg-slate-200 sm:block" />;
}

export function ToolbarTitle() {
  const t = useTranslations("ToolbarTitle");

  return (
    <div>
      <h1 className="text-base font-semibold text-slate-950">{t("title")}</h1>
      <p className="text-xs text-slate-500">{t("subtitle")}</p>
    </div>
  );
}
