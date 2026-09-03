import type { SupabaseClient } from "@supabase/supabase-js";

import {
  AI_LEGAL_BUNDLE_VERSION,
  AI_TERMS_VERSION,
  TERMS_VERSION,
} from "@/content/legal";
import {
  parseLegalDisplayV2,
  type LegalDisplayV2,
} from "./legal-display-v2";

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

export function acceptCurrentAiTerms(
  supabase: SupabaseClient,
  expectedUserId: string,
) {
  return acceptAiLegalBundle(supabase, AI_TERMS_VERSION, expectedUserId);
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
  expectedUserId: string,
) {
  const version = parseKnownAiLegalBundleVersion(legalBundleVersion);
  if (expectedUserId.length === 0) {
    throw new Error("AI terms acceptance requires an expected user ID.");
  }

  // Capture and verify the authenticated principal immediately before the
  // write. The explicit user_id plus RLS closes a later account-switch race:
  // B cannot write A's row, and A's operation never writes B's row.
  const { data, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (data.session?.user.id !== expectedUserId) {
    throw new Error("Authenticated user changed before AI terms acceptance.");
  }

  const { error } = await supabase
    .from("user_terms_acceptances")
    .upsert(
      {
        user_id: expectedUserId,
        document_key: "ai_terms",
        version,
      },
      { ignoreDuplicates: true, onConflict: "user_id,document_key,version" },
    );

  if (error) throw error;
}

/**
 * Successor consent writes the exact sealed disclosure identity through an
 * authenticated RPC. The DB rechecks the current bundle, user, display key
 * and content digest and also enforces the same tuple at request insertion.
 */
export async function acceptAiLegalDisclosureV2(
  supabase: SupabaseClient,
  input: {
    expectedUserId: string;
    legalDisplay: LegalDisplayV2;
  },
): Promise<void> {
  if (input.expectedUserId.length === 0) {
    throw new Error("AI terms acceptance requires an expected user ID.");
  }
  const legalDisplay = parseLegalDisplayV2(input.legalDisplay);
  const { data: sessionData, error: sessionError } =
    await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (sessionData.session?.user.id !== input.expectedUserId) {
    throw new Error("Authenticated user changed before AI terms acceptance.");
  }

  const { data, error } = await supabase.rpc(
    "accept_ai_legal_disclosure_v2",
    {
      p_expected_user_id: input.expectedUserId,
      p_legal_bundle_version: legalDisplay.legalBundleVersion,
      p_display_disclosure_key: legalDisplay.displayDisclosureKey,
      p_content_sha256: legalDisplay.contentSha256,
    },
  );
  if (error) throw error;
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    Object.keys(data).sort().join(",") !==
      "accepted,contentSha256,displayDisclosureKey,legalBundleVersion,schemaVersion" ||
    data.schemaVersion !== "ai_legal_acceptance_v2" ||
    data.accepted !== true ||
    data.legalBundleVersion !== legalDisplay.legalBundleVersion ||
    data.displayDisclosureKey !== legalDisplay.displayDisclosureKey ||
    data.contentSha256 !== legalDisplay.contentSha256
  ) {
    throw new Error("Invalid AI legal acceptance receipt.");
  }
}
