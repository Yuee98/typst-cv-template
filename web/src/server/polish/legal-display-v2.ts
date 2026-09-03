import { z } from "zod";

const CODE_ID = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,199}$/u);
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);
const UUID = z.string().uuid();
const TEXT = z.string().trim().min(1).max(4_000);
const MODEL_ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u);

const paragraphSchema = z.strictObject({
  kind: z.literal("paragraph"),
  text: TEXT,
});
const bulletListSchema = z.strictObject({
  kind: z.literal("bulletList"),
  items: z.array(TEXT).min(1).max(20),
});
const blockSchema = z.union([paragraphSchema, bulletListSchema]);
const languageSchema = z.strictObject({
  providerLabel: z.string().trim().min(1).max(200),
  modelLabel: z.string().trim().min(1).max(200),
  blocks: z.array(blockSchema).min(1).max(24),
});

export const legalDisplayV2Schema = z.strictObject({
  schemaVersion: z.literal("legal_display_v2"),
  displayDisclosureKey: CODE_ID,
  legalBundleVersion: CODE_ID,
  legalManifestId: CODE_ID,
  providerId: UUID,
  recipientKey: CODE_ID,
  modelId: MODEL_ID,
  contentSha256: SHA256,
  factIds: z.array(CODE_ID).min(1).max(64),
  evidenceIds: z.array(CODE_ID).min(1).max(64),
  zh: languageSchema,
  en: languageSchema,
});

export type LegalDisplayV2 = z.infer<typeof legalDisplayV2Schema>;

function assertUnique(values: readonly string[], name: string) {
  if (new Set(values).size !== values.length) throw new Error(`${name} must not contain duplicates`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Parse a code-owned, content-only descriptor. This never creates links or markup. */
export function parseLegalDisplayV2(value: unknown): LegalDisplayV2 {
  const parsed = legalDisplayV2Schema.parse(value);
  assertUnique(parsed.factIds, "factIds");
  assertUnique(parsed.evidenceIds, "evidenceIds");
  return deepFreeze(parsed);
}
