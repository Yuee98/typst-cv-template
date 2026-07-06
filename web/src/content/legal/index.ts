export * from "./constants";
export * from "./types";

import type { Locale } from "@/i18n/routing";
import * as legalEn from "./en";
import * as legalZh from "./zh";

export function getLegalContent(locale: Locale) {
  return locale === "zh" ? legalZh : legalEn;
}

export { legalEn, legalZh };
