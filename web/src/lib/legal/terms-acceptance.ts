import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { bindSupabaseUser } from "@/lib/supabase/user-client";
import { clientWriteContext, requireAppContext } from "@/lib/supabase/app-context";
import { legalDisplaySchema, legalDocumentSchema, legalIdSchema, type LegalDisplay, type LegalDocument } from "./legal-display";
export { legalDocumentSchema } from "./legal-display";
export const legalCurrentSchema = z.strictObject({
  documents: z.array(legalDocumentSchema)
});
export type CurrentLegal = z.infer<typeof legalCurrentSchema>;
export type CurrentTerms = LegalDocument;
export async function getCurrentLegal(supabase: SupabaseClient): Promise<CurrentLegal> {
  await requireAppContext(supabase);
  const {
    data,
    error
  } = await supabase.rpc("legal_current");
  if (error) throw error;
  return legalCurrentSchema.parse(data);
}
export async function getLegalDocument(supabase: SupabaseClient, target: Pick<LegalDocument, "external_id" | "document_audit_id" | "content_digest">): Promise<LegalDocument> {
  await requireAppContext(supabase);
  const {
    data,
    error
  } = await supabase.rpc("legal_document_read", {
    p_input: target
  });
  if (error) throw error;
  const document = legalDocumentSchema.parse(data);
  if (document.external_id !== target.external_id || document.document_audit_id !== target.document_audit_id || document.content_digest !== target.content_digest) throw new Error("Invalid legal target");
  return document;
}
export async function hasAcceptedTerms(supabase: SupabaseClient, target: CurrentTerms, expectedUserId?: string) {
  const userId = expectedUserId ?? (await supabase.auth.getSession()).data.session?.user.id;
  if (!userId) throw new Error("UNAUTHORIZED");
  const bound = await bindSupabaseUser(supabase, userId);
  const {
    data,
    error
  } = await bound.from("legal_my_acceptances").select("document_id,document_audit_id,content_digest").eq("document_id", target.document_id).eq("content_digest", target.content_digest).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
export async function acceptCurrentTerms(supabase: SupabaseClient, target?: CurrentTerms, expectedUserId?: string) {
  if (!target || target.kind !== "TERMS") throw new Error("Terms must be displayed before acceptance");
  if (!expectedUserId) throw new Error("Expected acceptance account is required");
  const bound = await bindSupabaseUser(supabase, expectedUserId);
  const context = await clientWriteContext(supabase);
  const {
    data,
    error
  } = await bound.rpc("legal_accept_document", {
    p_input: {
      ...context,
      document_id: target.document_id,
      document_audit_id: target.document_audit_id
    }
  });
  if (error) throw error;
  z.strictObject({
    accepted: z.literal(true),
    acceptance_audit_id: legalIdSchema
  }).parse(data);
}
export async function acceptAiLegalDisclosure(supabase: SupabaseClient, input: {
  expectedUserId: string;
  legalDisplay: LegalDisplay;
}): Promise<void> {
  const display = legalDisplaySchema.parse(input.legalDisplay);
  const bound = await bindSupabaseUser(supabase, input.expectedUserId);
  const context = await clientWriteContext(supabase);
  const target = (doc: LegalDocument) => ({
    document_id: doc.document_id,
    document_audit_id: doc.document_audit_id
  });
  const {
    data,
    error
  } = await bound.rpc("legal_accept_ai", {
    p_input: {
      ...context,
      common: target(display.common),
      provider: target(display.provider)
    }
  });
  if (error) throw error;
  z.strictObject({
    accepted: z.literal(true),
    common_acceptance_audit_id: legalIdSchema,
    provider_acceptance_audit_id: legalIdSchema
  }).parse(data);
}
