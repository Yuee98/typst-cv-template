"use client";

import { useEffect } from "react";

function preferredLocale() {
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  const normalized = languages.map((language) => language.toLowerCase());

  if (normalized.some((language) => language.startsWith("en"))) {
    return "en";
  }

  return "zh";
}

export default function RootRedirectPage() {
  useEffect(() => {
    window.location.replace(preferredLocale() === "en" ? "/en" : "/zh");
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