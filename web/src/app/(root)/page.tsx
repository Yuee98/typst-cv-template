"use client";

import { useEffect } from "react";

import { preferredLocale, rootLocaleRedirectLocation } from "@/i18n/root-redirect";

export default function RootRedirectPage() {
  useEffect(() => {
    const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
    const locale = preferredLocale(languages);
    window.location.replace(rootLocaleRedirectLocation(locale, window.location.search, window.location.hash));
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg text-foreground-muted">
      <div className="flex items-center gap-3 text-sm">
        <span className="size-4 animate-spin rounded-full border-2 border-border-strong border-t-accent" />
        <span>Loading...</span>
      </div>
    </main>
  );
}
