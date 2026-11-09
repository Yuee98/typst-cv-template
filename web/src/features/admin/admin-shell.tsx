"use client";

import Link from "next/link";
import { ArrowLeft, LogOut, UserRoundCheck } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { LocaleSwitcher, ThemeToggle, Toolbar, ToolbarGroup } from "@/components/layout/toolbar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { tabTriggerClassName } from "@/components/ui/tabs";
import { ADMIN_SECTIONS, type AdminSection } from "@/lib/admin/contract";
import type { AdminMessages } from "./messages";
import { adminNavigationPath } from "./navigation";

export function AdminShell({
  locale,
  t,
  section,
  environment,
  accountEmail,
  onSignOut,
  children
}: {
  locale: "zh" | "en";
  t: AdminMessages;
  section?: AdminSection;
  environment?: string | null;
  accountEmail?: string | null;
  onSignOut?: () => void;
  children: ReactNode;
}) {
  const navigationRef = useRef<HTMLElement | null>(null);
  const activeLinkRef = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    const navigation = navigationRef.current;
    const link = activeLinkRef.current;
    if (!navigation || !link) return;
    const revealActive = () => {
      const viewport = navigation.getBoundingClientRect();
      const active = link.getBoundingClientRect();
      const style = getComputedStyle(navigation);
      const left = viewport.left + navigation.clientLeft + parseFloat(style.paddingLeft);
      const right = viewport.left + navigation.clientLeft + navigation.clientWidth - parseFloat(style.paddingRight);
      let delta = 0;
      if (active.left < left || active.width > right - left) delta = active.left - left;
      else if (active.right > right) delta = active.right - right;
      if (delta) navigation.scrollLeft = Math.max(0, Math.min(navigation.scrollWidth - navigation.clientWidth, navigation.scrollLeft + delta));
    };
    revealActive();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(revealActive);
    observer.observe(navigation);
    observer.observe(link);
    return () => observer.disconnect();
  }, [section, locale]);
  const environmentLabel = environment ? `${t.environment}: ${environment}` : undefined;
  const environmentDisplay = environment === "PRODUCTION" ? "PROD" : environment === "PREVIEW" ? "TEST" : environment;

  return <main className="admin-shell h-dvh min-w-0 overflow-x-hidden overflow-y-auto bg-bg text-foreground">
    <div className="admin-shell-inner mx-auto w-full max-w-[1440px]">
      <div className="admin-header app-toolbar-surface">
        <Toolbar className="admin-toolbar rounded-none border-0 bg-transparent shadow-none">
          <div className="toolbar-brand flex min-w-0 flex-1 items-center gap-2.5">
            {/* The same small site icon is used on the editor and Admin. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.svg" alt="" aria-hidden="true" className="size-8 shrink-0 rounded-lg shadow-sm ring-1 ring-white/10 sm:size-9" />
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold text-foreground">{t.brand}</h1>
              {environment && <span data-environment={environment} aria-label={environmentLabel} title={environmentLabel} className="inline-flex max-w-full rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] font-medium leading-none text-foreground-muted">{environmentDisplay}</span>}
            </div>
          </div>
          <ToolbarGroup>
            <ThemeToggle />
            <LocaleSwitcher />
            <Button asChild variant="secondary" size="icon">
              <a href={`/${locale}`} referrerPolicy="no-referrer" aria-label={t.backToEditor} title={t.backToEditor}><ArrowLeft /></a>
            </Button>
            {onSignOut && <DropdownMenu>
              <DropdownMenuTrigger asChild><Button type="button" variant="secondary" size="icon" aria-label={t.account} title={t.account}><UserRoundCheck /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52 max-w-72">
                <DropdownMenuLabel className="truncate border-b border-border px-2 pb-2 pt-0">{accountEmail || t.account}</DropdownMenuLabel>
                <DropdownMenuItem icon={<LogOut className="size-4" />} onSelect={onSignOut}>{t.signOut}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>}
          </ToolbarGroup>
        </Toolbar>
        {section && <nav ref={navigationRef} aria-label={t.navigation} className="admin-navigation flex min-w-0 gap-1 overflow-x-auto border-t border-border px-3 pb-2 pt-1">
          {ADMIN_SECTIONS.map(item => <Link key={item} ref={item === section ? activeLinkRef : undefined} href={adminNavigationPath(locale, item)!} aria-current={section === item ? "page" : undefined} data-state={section === item ? "active" : "inactive"} className={tabTriggerClassName}>{t[item]}</Link>)}
        </nav>}
      </div>
      <div className="admin-content min-w-0 space-y-4 py-4">{children}</div>
    </div>
  </main>;
}
