import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { bindSupabaseUser } from "@/lib/supabase/user-client";
import { clientWriteContext, requireAppContext } from "@/lib/supabase/app-context";
import { legalDisplaySchema, legalLanguageSchema, type LegalDisplay } from "./legal-display";
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const externalId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{12}$`));
const link = z.discriminatedUnion("kind", [z.strictObject({
  kind: z.literal("internal"),
  label: z.string(),
  href: z.custom<`/${string}`>(value => typeof value === "string" && /^\/(?!\/)/.test(value)),
  locale: z.enum(["zh", "en"])
}), z.strictObject({
  kind: z.literal("external"),
  label: z.string(),
  href: z.custom<`https://${string}`>(value => typeof value === "string" && z.string().url().startsWith("https://").safeParse(value).success)
})]);
export const legalDocumentSchema = z.strictObject({
  title: z.string().min(1),
  effectiveDate: z.string(),
  intro: z.array(z.string()),
  sections: z.array(z.strictObject({
    id: z.string().optional(),
    heading: z.string(),
    body: z.array(z.string()),
    bullets: z.array(z.string()).optional(),
    links: z.array(link).optional()
  }))
});
const document = z.strictObject({
  external_id: externalId("ldv"),
  content_digest: digest,
  renderer_contract: z.literal("legal_document_1"),
  content: z.strictObject({
    zh: legalDocumentSchema,
    en: legalDocumentSchema
  })
});
export const legalCurrentSchema = z.strictObject({
  terms: document,
  ai_bundle: z.strictObject({
    external_id: externalId("lgb"),
    manifest_digest: digest,
    ai_terms: document,
    disclosures: z.array(z.object({
      external_id: externalId("lds"),
      provider_code: z.string(),
      content_digest: digest,
      renderer_contract: z.literal("legal_display_1"),
      content: z.strictObject({
        zh: legalLanguageSchema,
        en: legalLanguageSchema
      })
    }))
  }).nullable()
});
export type CurrentLegal = z.infer<typeof legalCurrentSchema>;
export type CurrentTerms = CurrentLegal["terms"];
export async function getCurrentLegal(supabase: SupabaseClient): Promise<CurrentLegal> {
  await requireAppContext(supabase);
  const {
    data,
    error
  } = await supabase.rpc("legal_current");
  if (error) throw error;
  return legalCurrentSchema.parse(data);
}
export async function hasAcceptedTerms(supabase: SupabaseClient, target: CurrentTerms, expectedUserId?: string) {
  const userId = expectedUserId ?? (await supabase.auth.getSession()).data.session?.user.id;
  if (!userId) throw new Error("UNAUTHORIZED: Acceptance account is required");
  const bound = await bindSupabaseUser(supabase, userId);
  const {
    data,
    error
  } = await bound.from("legal_my_acceptances").select("document_version_id,accepted_content_digest").eq("document_version_id", target.external_id).eq("accepted_content_digest", target.content_digest).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
export async function acceptCurrentTerms(supabase: SupabaseClient, target?: CurrentTerms, expectedUserId?: string) {
  if (!target) throw new Error("Terms must be displayed before acceptance");
  if (!expectedUserId) throw new Error("Expected acceptance account is required");
  const bound = await bindSupabaseUser(supabase, expectedUserId);
  const context = await clientWriteContext(supabase);
  const {
    data,
    error
  } = await bound.rpc("legal_accept_document", {
    p_input: {
      ...context,
      document_version_id: target.external_id,
      content_digest: target.content_digest
    }
  });
  if (error) throw error;
  const receipt = z.strictObject({
    accepted: z.literal(true),
    target_id: externalId("ldv"),
    content_digest: digest
  }).parse(data);
  if (receipt.target_id !== target.external_id || receipt.content_digest !== target.content_digest) throw new Error("Invalid terms receipt");
}
export async function acceptAiLegalDisclosure(supabase: SupabaseClient, input: {
  expectedUserId: string;
  legalDisplay: LegalDisplay;
}): Promise<void> {
  const display = legalDisplaySchema.parse(input.legalDisplay);
  const bound = await bindSupabaseUser(supabase, input.expectedUserId);
  const context = await clientWriteContext(supabase);
  const {
    data,
    error
  } = await bound.rpc("legal_accept_disclosure", {
    p_input: {
      ...context,
      disclosure_id: display.disclosureId,
      content_digest: display.contentDigest,
      bundle_id: display.bundleId,
      manifest_digest: display.manifestDigest
    }
  });
  if (error) throw error;
  const receipt = z.strictObject({
    accepted: z.literal(true),
    target_id: externalId("lds"),
    content_digest: digest
  }).parse(data);
  if (receipt.target_id !== display.disclosureId || receipt.content_digest !== display.contentDigest) throw new Error("Invalid disclosure receipt");
}
