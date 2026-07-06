import { getRequestConfig } from "next-intl/server";

import { defaultLocale, isLocale } from "./routing";
import { getMessages } from "./messages";

export default getRequestConfig(async ({ locale, requestLocale }) => {
  const requested = locale ?? (await requestLocale);
  const resolvedLocale = isLocale(requested) ? requested : defaultLocale;

  return {
    locale: resolvedLocale,
    messages: getMessages(resolvedLocale),
  };
});
