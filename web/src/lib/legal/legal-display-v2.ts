import { z } from "zod";

const CODE_ID = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,199}$/u);
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);
const UUID = z.string().uuid();
const MODEL_ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u);
export const LEGAL_DISPLAY_TEXT_UTF8_BYTES_MAX = 32_768;

const nonBlankText = (max: number) =>
  z
    .string()
    .min(1)
    .refine((value) => Array.from(value).length <= max, {
      message: `text must contain at most ${max} Unicode characters`,
    })
    .refine((value) => value.trim().length > 0, {
      message: "text must not be blank",
    });
const LABEL = nonBlankText(200);
const PARAGRAPH_TEXT = nonBlankText(4_000);
const BULLET_TEXT = nonBlankText(1_000);

const paragraphSchema = z.strictObject({
  kind: z.literal("paragraph"),
  text: PARAGRAPH_TEXT,
});
const bulletListSchema = z.strictObject({
  kind: z.literal("bulletList"),
  items: z.array(BULLET_TEXT).min(1).max(20),
});
const blockSchema = z.union([paragraphSchema, bulletListSchema]);
const languageSchema = z.strictObject({
  providerLabel: LABEL,
  modelLabel: LABEL,
  blocks: z.array(blockSchema).min(1).max(24),
});

function displayTextUtf8Bytes(
  display: Pick<LegalDisplayV2, "zh" | "en">,
): number {
  const encoder = new TextEncoder();
  let total = 0;
  for (const language of [display.en, display.zh]) {
    total += encoder.encode(language.providerLabel).byteLength;
    total += encoder.encode(language.modelLabel).byteLength;
    for (const block of language.blocks) {
      if (block.kind === "paragraph") {
        total += encoder.encode(block.text).byteLength;
      } else {
        for (const item of block.items) {
          total += encoder.encode(item).byteLength;
        }
      }
    }
  }
  return total;
}

export const legalDisplayV2Schema = z
  .strictObject({
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
  })
  .superRefine((display, context) => {
    if (displayTextUtf8Bytes(display) > LEGAL_DISPLAY_TEXT_UTF8_BYTES_MAX) {
      context.addIssue({
        code: "custom",
        message: "legal display text exceeds the UTF-8 byte limit",
      });
    }
  });

export type LegalDisplayV2 = z.infer<typeof legalDisplayV2Schema>;

export function isLegalDisplayV2(
  value: unknown,
): value is LegalDisplayV2 {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === "legal_display_v2"
  );
}

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
