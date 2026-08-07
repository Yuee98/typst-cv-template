"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import { isAiPolishUiEnabled } from "@/lib/polish/feature-flags";

export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 rounded-b-xl border border-border glass-panel px-4 py-3 shadow-sm print:hidden">
      {children}
    </header>
  );
}

export function ToolbarGroup({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export function ToolbarSeparator() {
  return <span aria-hidden="true" className="hidden h-6 w-px bg-border sm:block" />;
}

export function ToolbarTitle() {
  const t = useTranslations("ToolbarTitle");
  const aiPolishEnabled = isAiPolishUiEnabled();

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {/* The SVG is tiny and already served directly as the app icon. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/icon.svg"
        alt=""
        aria-hidden="true"
        className="size-8 shrink-0 rounded-lg shadow-sm ring-1 ring-white/10 sm:size-9"
      />
      <div className="min-w-0">
        <h1 className="text-base font-semibold text-foreground">
          {t(aiPolishEnabled ? "aiTitle" : "title")}
        </h1>
        <p className="text-xs text-foreground-muted">
          {t(aiPolishEnabled ? "aiSubtitle" : "subtitle")}
        </p>
      </div>
    </div>
  );
}
