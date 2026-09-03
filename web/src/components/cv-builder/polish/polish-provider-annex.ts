import {
  DEEPSEEK_LEGAL_DISPLAY_KEY,
  MIMO_LEGAL_DISPLAY_KEY,
} from "@/content/legal/constants";

export type PolishProviderAnnexHref =
  | `/ai-terms#provider-annex-${typeof DEEPSEEK_LEGAL_DISPLAY_KEY}`
  | `/ai-terms#provider-annex-${typeof MIMO_LEGAL_DISPLAY_KEY}`;

/**
 * Resolve only code-reviewed display keys. The API value is never interpolated
 * into a URL, and an unknown future key remains non-confirmable until its legal
 * annex ships in this client.
 */
export function resolvePolishProviderAnnexHref(
  displayDisclosureKey: string,
): PolishProviderAnnexHref | null {
  switch (displayDisclosureKey) {
    case DEEPSEEK_LEGAL_DISPLAY_KEY:
      return `/ai-terms#provider-annex-${DEEPSEEK_LEGAL_DISPLAY_KEY}`;
    case MIMO_LEGAL_DISPLAY_KEY:
      return `/ai-terms#provider-annex-${MIMO_LEGAL_DISPLAY_KEY}`;
    default:
      return null;
  }
}
