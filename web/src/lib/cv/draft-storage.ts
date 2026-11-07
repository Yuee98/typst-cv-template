import { z } from "zod";
import { cloudCacheScope } from "@/lib/supabase/app-context";
import { cvSchema, type CvData } from "@/lib/cv/schema";
const draftSchema = z.strictObject({
  contract: z.literal("cv_draft_1"),
  baseRevision: z.string().regex(/^[1-9][0-9]*$/),
  data: cvSchema
});
function draftKey(userId: string, cvId: string) {
  return `typst-cv-builder:draft:${cloudCacheScope()}:${userId}:${cvId}`;
}
export function saveCvDraft(userId: string | null | undefined, cvId: string, data: CvData, baseRevision: string) {
  if (!userId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(draftKey(userId, cvId), JSON.stringify(draftSchema.parse({
      contract: "cv_draft_1",
      baseRevision,
      data
    })));
  } catch {/* Draft storage can be full or unavailable; it never changes the persisted baseline. */}
}
export function loadCvDraft(userId: string | null | undefined, cvId: string): z.infer<typeof draftSchema> | null {
  if (!userId || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(draftKey(userId, cvId));
    if (!raw) return null;
    const parsed = draftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
export function clearCvDraft(userId: string | null | undefined, cvId: string) {
  if (userId && typeof window !== "undefined") window.localStorage.removeItem(draftKey(userId, cvId));
}
