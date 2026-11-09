export type LegalLink = Readonly<{
  kind: "internal";
  label: string;
  href: `/${string}`;
  locale: "zh" | "en";
}> | Readonly<{
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
export type AiProviderEvidence = Readonly<{
  reviewedAt: string;
  provider: string;
  operator: string;
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
export function defineAiProviderEvidence(manifest: AiProviderEvidence): AiProviderEvidence {
  return Object.freeze({
    ...manifest,
    submittedData: Object.freeze([...manifest.submittedData]),
    unknowns: Object.freeze([...manifest.unknowns]),
    sources: Object.freeze([...manifest.sources])
  });
}
