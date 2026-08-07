import { getMessages } from "@/i18n/messages";
import type { Locale } from "@/i18n/routing";
import { isAiPolishUiEnabled } from "@/lib/polish/feature-flags";

type SiteMetadata = {
  title: string;
  description: string;
};

export function getSiteMetadata(
  locale: Locale,
  aiPolishFlag?: string,
): SiteMetadata {
  const messages = getMessages(locale);
  const aiPolishEnabled = isAiPolishUiEnabled(aiPolishFlag);

  return aiPolishEnabled
    ? {
        title: messages.Metadata.aiTitle,
        description: messages.Metadata.aiDescription,
      }
    : {
        title: messages.Metadata.title,
        description: messages.Metadata.description,
      };
}
