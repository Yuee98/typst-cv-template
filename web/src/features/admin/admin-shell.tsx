"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ADMIN_SECTIONS, type AdminSection } from "@/lib/admin/contract";
import { cn } from "@/lib/utils";
import type { AdminMessages } from "./messages";
import { adminNavigationPath } from "./navigation";

export function AdminShell({
  locale,
  t,
  section,
  environment,
  onSignOut,
  children,
}: {
  locale: "zh" | "en";
  t: AdminMessages;
  section?: AdminSection;
  environment?: string | null;
  onSignOut?: () => void;
  children: ReactNode;
}) {
  return <main className="admin-shell h-dvh min-w-0 overflow-x-hidden overflow-y-auto bg-bg text-foreground">
    <div className="mx-auto w-full max-w-[1440px] space-y-6 px-4 py-6 md:px-8 md:py-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {/* The small site icon is served directly for both app surfaces. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" aria-hidden="true" className="size-10 shrink-0 rounded-xl" />
          <div className="min-w-0 space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">{t.brand}</h1>
            {environment && <p className="text-xs text-foreground-muted">
              {t.environment}: <span className="inline-flex rounded-md border border-border bg-surface px-2 py-0.5 font-medium text-foreground">{environment}</span>
            </p>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <a href={`/${locale}`} referrerPolicy="no-referrer" className="rounded-md px-1 py-2 text-sm text-foreground-muted underline underline-offset-4 hover:text-foreground">
            {t.backToEditor}
          </a>
          {onSignOut && <Button type="button" variant="secondary" onClick={onSignOut}>{t.signOut}</Button>}
        </div>
      </header>
      {section && <nav aria-label={t.navigation} className="flex gap-2 overflow-x-auto rounded-xl border border-border bg-surface p-2 shadow-sm">
        {ADMIN_SECTIONS.map(item => <Link
          key={item}
          href={adminNavigationPath(locale, item)!}
          aria-current={section === item ? "page" : undefined}
          className={cn(
            "shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            section === item ? "bg-accent text-accent-foreground" : "text-foreground-muted hover:bg-surface-hover hover:text-foreground",
          )}
        >{t[item]}</Link>)}
      </nav>}
      <div className="min-w-0 space-y-6">{children}</div>
    </div>
  </main>;
}
