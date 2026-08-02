import type { SupabaseClient } from "@supabase/supabase-js";

import { AI_TERMS_VERSION, TERMS_VERSION } from "@/content/legal";

export type LegalDocumentKey = "terms" | "ai_terms";

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
  return hasAcceptedLegalDocument(supabase, "ai_terms", AI_TERMS_VERSION);
}

export function acceptCurrentAiTerms(supabase: SupabaseClient) {
  return acceptLegalDocument(supabase, "ai_terms", AI_TERMS_VERSION);
}
