export type LegalLink =
  | Readonly<{
      kind: "internal";
      label: string;
      href: `/${string}`;
      locale: "zh" | "en";
    }>
  | Readonly<{
      kind: "external";
      label: string;
      href: `https://${string}`;
    }>;

export type LegalSection = {
  id?: string;
  heading: string;
  body: string[];
  bullets?: string[];
  links?: LegalLink[];
};

export type LegalDocument = {
  title: string;
  effectiveDate: string;
  intro: string[];
  sections: LegalSection[];
};

export type AiProviderLegalManifest = Readonly<{
  manifestId: string;
  displayKey: string;
  reviewedAt: string;
  provider: string;
  gatewayOperator: string;
  modelVendor: string;
  models: readonly string[];
  upstream: string;
  submittedData: readonly string[];
  providerSubjectId: string;
  processingRegion: string;
  cache: string;
  retention: string;
  training: string;
  transfer: string;
  unknowns: readonly string[];
  sources: readonly `https://${string}`[];
}>;

export function defineAiProviderLegalManifest(
  manifest: AiProviderLegalManifest,
): AiProviderLegalManifest {
  return Object.freeze({
    ...manifest,
    models: Object.freeze([...manifest.models]),
    submittedData: Object.freeze([...manifest.submittedData]),
    unknowns: Object.freeze([...manifest.unknowns]),
    sources: Object.freeze([...manifest.sources]),
  });
}
