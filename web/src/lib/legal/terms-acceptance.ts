import type { SupabaseClient } from "@supabase/supabase-js";

import {
  AI_LEGAL_BUNDLE_VERSION,
  AI_TERMS_VERSION,
  TERMS_VERSION,
} from "@/content/legal";

export type LegalDocumentKey = "terms" | "ai_terms";

/**
 * Explicit bundle-to-document mapping for versions this build can display
 * and ask the user to accept. Historical AI terms are intentionally absent:
 * the multi-provider bundle is a material change and requires exact consent.
 */
export const AI_LEGAL_BUNDLE_TERMS_VERSION_MAP = Object.freeze({
  [AI_LEGAL_BUNDLE_VERSION]: AI_TERMS_VERSION,
} as const);

export type KnownAiLegalBundleVersion =
  keyof typeof AI_LEGAL_BUNDLE_TERMS_VERSION_MAP;

export function parseKnownAiLegalBundleVersion(
  value: unknown,
): KnownAiLegalBundleVersion {
  if (
    typeof value !== "string" ||
    !Object.hasOwn(AI_LEGAL_BUNDLE_TERMS_VERSION_MAP, value) ||
    AI_LEGAL_BUNDLE_TERMS_VERSION_MAP[
      value as KnownAiLegalBundleVersion
    ] !== value
  ) {
    throw new Error("Unknown AI legal bundle version.");
  }
  return value as KnownAiLegalBundleVersion;
}

const acceptanceColumns = "accepted_at,version";

export async function hasAcceptedLegalDocument(
  supabase: SupabaseClient,
  documentKey: LegalDocumentKey,
  version: string,
) {
  const { data, error } = await supabase
    .from("user_terms_acceptances")
    .select(acceptanceColumns)
    .eq("document_key", documentKey)
    .eq("version", version)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return Boolean(data);
}

export async function acceptLegalDocument(
  supabase: SupabaseClient,
  documentKey: LegalDocumentKey,
  version: string,
) {
  const { error } = await supabase
    .from("user_terms_acceptances")
    .upsert(
      {
        document_key: documentKey,
        version,
      },
      { ignoreDuplicates: true, onConflict: "user_id,document_key,version" },
    );

  if (error) {
    throw error;
  }
}

export function hasAcceptedCurrentTerms(supabase: SupabaseClient) {
  return hasAcceptedLegalDocument(supabase, "terms", TERMS_VERSION);
}

export function acceptCurrentTerms(supabase: SupabaseClient) {
  return acceptLegalDocument(supabase, "terms", TERMS_VERSION);
}

export function hasAcceptedCurrentAiTerms(supabase: SupabaseClient) {
  return hasAcceptedAiLegalBundle(supabase, AI_TERMS_VERSION);
}

export function acceptCurrentAiTerms(supabase: SupabaseClient) {
  return acceptAiLegalBundle(supabase, AI_TERMS_VERSION);
}

export async function hasAcceptedAiLegalBundle(
  supabase: SupabaseClient,
  legalBundleVersion: unknown,
) {
  return hasAcceptedLegalDocument(
    supabase,
    "ai_terms",
    parseKnownAiLegalBundleVersion(legalBundleVersion),
  );
}

export async function acceptAiLegalBundle(
  supabase: SupabaseClient,
  legalBundleVersion: unknown,
) {
  await acceptLegalDocument(
    supabase,
    "ai_terms",
    parseKnownAiLegalBundleVersion(legalBundleVersion),
  );
}
