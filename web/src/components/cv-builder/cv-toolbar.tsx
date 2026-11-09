"use client";

import type { Session } from "@supabase/supabase-js";
import { Menu } from "lucide-react";
import { useLayoutEffect, useRef, type Ref } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

import {
  AccountMenu,
  GithubMenu,
  LocaleSwitcher,
  ThemeToggle,
  Toolbar,
  ToolbarGroup,
  ToolbarTitle,
  type CloudStatus,
  type TermsStatus,
} from "@/components/layout/toolbar";

export function CvToolbar({
  session,
  cloudStatus,
  termsStatus,
  supabaseConfigured,
  onOpenAuthModal,
  onSyncCloud,
  onSignOut,
  libraryOpen,
  onOpenLibrary,
  libraryTriggerRef,
}: {
  session: Session | null;
  cloudStatus: CloudStatus;
  termsStatus: TermsStatus;
  supabaseConfigured: boolean;
  onOpenAuthModal: (mode: "signIn" | "signUp") => void;
  onSyncCloud: () => void;
  onSignOut: () => void;
  libraryOpen: boolean;
  onOpenLibrary: () => void;
  libraryTriggerRef: Ref<HTMLButtonElement>;
}) {
  const t = useTranslations("CvToolbar");
  const headerRef = useRef<HTMLElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const header = headerRef.current;
    const controls = controlsRef.current;
    if (!header || !controls) return;
    const brand = header.querySelector<HTMLElement>(".toolbar-brand");
    const logo = brand?.querySelector("img");
    const actions = header.querySelector<HTMLElement>(".toolbar-actions");
    if (!brand || !logo || !actions) return;
    let active = true;
    // Fit the actual translated content, independently of its current row.
    // No scroll listener or alternate toolbar instance is needed.
    const measure = () => {
      if (!active) return;
      const style = getComputedStyle(header);
      const menu = header.querySelector<HTMLElement>(".library-trigger");
      const menuWidth = menu?.getBoundingClientRect().width ?? 0;
      const textWidth = Math.max(...Array.from(brand.querySelectorAll<HTMLElement>("h1, p"), element => element.scrollWidth));
      const brandWidth = logo.getBoundingClientRect().width + parseFloat(getComputedStyle(brand).columnGap) + textWidth;
      const gap = parseFloat(style.columnGap);
      const available = header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const wrapped = brandWidth + actions.scrollWidth + menuWidth + gap * (menuWidth > 0 ? 2 : 1) > available;
      header.dataset.wrapped = String(wrapped);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const offset = wrapped ? Math.max(0, header.offsetHeight - controls.offsetHeight - padding - 2) : 0;
      header.style.setProperty("--toolbar-scroll-offset", `${offset}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(brand);
    observer.observe(actions);
    void document.fonts.ready.then(measure);
    document.fonts.addEventListener("loadingdone", measure);
    return () => {
      active = false;
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
    };
  }, []);
  return (
    <Toolbar ref={headerRef} className="cv-toolbar app-toolbar-surface">
      <ToolbarTitle />
      <div ref={controlsRef} className="cv-toolbar-controls">
        <Button ref={libraryTriggerRef} type="button" variant="ghost" size="icon" className="library-trigger" aria-label={t("openLibrary")} title={t("openLibrary")} aria-haspopup="dialog" aria-expanded={libraryOpen} onClick={onOpenLibrary}>
          <Menu />
        </Button>
      <ToolbarGroup>
        <ThemeToggle />
        <LocaleSwitcher />
        <GithubMenu />
        <AccountMenu
          session={session}
          cloudStatus={cloudStatus}
          termsStatus={termsStatus}
          supabaseConfigured={supabaseConfigured}
          onOpenAuthModal={onOpenAuthModal}
          onSyncCloud={onSyncCloud}
          onSignOut={onSignOut}
        />
      </ToolbarGroup>
      </div>
    </Toolbar>
  );
}
