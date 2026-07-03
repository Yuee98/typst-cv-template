import type { SupabaseClient } from "@supabase/supabase-js";

import { TERMS_VERSION } from "@/content/legal";

const acceptanceColumns = "accepted_at,version";

export async function hasAcceptedCurrentTerms(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("user_terms_acceptances")
    .select(acceptanceColumns)
    .eq("document_key", "terms")
    .eq("version", TERMS_VERSION)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return Boolean(data);
}

export async function acceptCurrentTerms(supabase: SupabaseClient) {
  const { error } = await supabase
    .from("user_terms_acceptances")
    .upsert(
      {
        document_key: "terms",
        version: TERMS_VERSION,
      },
      { ignoreDuplicates: true, onConflict: "user_id,document_key,version" },
    );

  if (error) {
    throw error;
  }
}
