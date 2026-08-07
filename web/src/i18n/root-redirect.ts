import type { Locale } from "./routing";

export function preferredLocale(languages: readonly string[]): Locale {
  return languages.some((language) => language.toLowerCase().startsWith("en")) ? "en" : "zh";
}

export function rootLocaleRedirectLocation(locale: Locale, search: string, hash: string) {
  return `/${locale}/${search}${hash}`;
}
