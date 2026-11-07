import { z } from "zod";
const externalId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{12}$`));
const text = (max: number) => z.string().trim().min(1).max(max);
const block = z.discriminatedUnion("kind", [z.strictObject({
  kind: z.literal("paragraph"),
  text: text(4000)
}), z.strictObject({
  kind: z.literal("bulletList"),
  items: z.array(text(1000)).min(1).max(20)
})]);
export const legalLanguageSchema = z.strictObject({
  providerLabel: text(200),
  modelLabel: text(200),
  blocks: z.array(block).min(1).max(24)
});
export const legalDisplaySchema = z.strictObject({
  contract: z.literal("cv_app_db_1"),
  disclosureId: externalId("lds"),
  bundleId: externalId("lgb"),
  providerId: externalId("prv"),
  recipientCode: text(200),
  modelId: text(200),
  manifestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  zh: legalLanguageSchema,
  en: legalLanguageSchema
}).refine(value => new TextEncoder().encode(JSON.stringify([value.zh, value.en])).byteLength <= 32768, "Disclosure text exceeds size limit");
export type LegalDisplay = z.infer<typeof legalDisplaySchema>;
