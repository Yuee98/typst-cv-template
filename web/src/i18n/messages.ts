import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

import type { Locale } from "./routing";

export const messagesByLocale = {
  en,
  zh,
} as const;

export function getMessages(locale: Locale) {
  return messagesByLocale[locale];
}
