import { persistedCvSchema, type CvData } from "@/lib/cv/schema";
import { titleFromImportedData } from "@/lib/cv/cv-utils";

export type ParsedImportedCvFile = {
  data: CvData;
  title: string;
};

/**
 * Parse one import file without performing any document transition.
 *
 * JSON.parse errors intentionally propagate so the caller can retain its
 * existing localized error path. Schema failures are represented as null so
 * the caller can show the existing import-schema message without coupling this
 * helper to UI state or translation hooks.
 */
export async function parseImportedCvFile(
  file: File | undefined,
  fallbackTitle: string,
): Promise<ParsedImportedCvFile | null> {
  if (!file) {
    return null;
  }

  const parsed = persistedCvSchema.safeParse(JSON.parse(await file.text()));
  if (!parsed.success) {
    return null;
  }

  return {
    data: parsed.data,
    title: titleFromImportedData(parsed.data, fallbackTitle),
  };
}
