import { persistedCvSchema, type CvData } from "@/lib/cv/schema";

const DRAFT_KEY_PREFIX = "typst-cv-builder:draft:";

function draftKey(userId: string, cvId: string) {
  return `${DRAFT_KEY_PREFIX}${userId}:${cvId}`;
}

export function saveCvDraft(userId: string | null | undefined, cvId: string, data: CvData) {
  if (!userId || typeof window === "undefined") return;

  try {
    window.localStorage.setItem(draftKey(userId, cvId), JSON.stringify(data));
  } catch {
    // localStorage can be unavailable or full; drafts are a best-effort safety net.
  }
}

export function loadCvDraft(userId: string | null | undefined, cvId: string): CvData | null {
  if (!userId || typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(draftKey(userId, cvId));
    if (!raw) return null;

    const parsed = persistedCvSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function clearCvDraft(userId: string | null | undefined, cvId: string) {
  if (!userId || typeof window === "undefined") return;

  window.localStorage.removeItem(draftKey(userId, cvId));
}
