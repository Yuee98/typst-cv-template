"use client";

import { useEffect } from "react";

/**
 * Mirrors the active locale onto `<html lang>`.
 *
 * The root layout renders `<html>` without a `lang` attribute because the
 * locale is only known inside the `[locale]` segment. This component runs in
 * the `[locale]` layout (which receives `locale` from its params) and keeps
 * `documentElement.lang` in sync, including when the user switches language.
 */
export function HtmlLangSync({ locale }: { locale: string }) {
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return null;
}
