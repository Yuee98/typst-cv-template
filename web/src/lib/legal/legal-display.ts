import { z } from "zod";
import { parseLegalMarkdown } from "./markdown";
export const legalIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BigInt("9223372036854775807"));
export const legalExternalIdSchema = z.string().regex(/^ldoc_[0-9A-HJKMNP-TV-Z]{12}$/);
export const legalDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const title = z.string().min(1).max(500).refine(value => value.trim().length > 0);
const body = z.string().min(1).max(65536).refine(value => {
  try {
    parseLegalMarkdown(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid legal Markdown");
export const legalDocumentSchema = z.strictObject({
  document_id: legalIdSchema,
  external_id: legalExternalIdSchema,
  kind: z.enum(["TERMS", "AI_COMMON", "AI_PROVIDER"]),
  document_audit_id: legalIdSchema,
  content_digest: legalDigestSchema,
  effective_date: z.iso.date().refine(value => !value.startsWith("0000-")),
  zh_title: title,
  en_title: title,
  zh_body: body,
  en_body: body,
  enabled: z.boolean(),
  revision: legalIdSchema,
  recipient_name: z.string().min(1).max(500).refine(value => value.trim().length > 0).nullable()
}).refine(doc => doc.kind === "AI_PROVIDER" ? doc.recipient_name !== null : doc.recipient_name === null, "Invalid document recipient");
export type LegalDocument = z.infer<typeof legalDocumentSchema>;
export const legalDisplaySchema = z.strictObject({
  contract: z.literal("cv_app_db_2"),
  common: legalDocumentSchema.refine(doc => doc.kind === "AI_COMMON"),
  provider: legalDocumentSchema.refine(doc => doc.kind === "AI_PROVIDER")
});
export type LegalDisplay = z.infer<typeof legalDisplaySchema>;
export type LegalDocumentTarget = Pick<LegalDocument, "document_id" | "external_id" | "document_audit_id" | "content_digest">;
