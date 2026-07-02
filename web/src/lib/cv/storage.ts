import { cvSchema, type CvData } from "./schema";

const CV_STORAGE_KEY = "typst-cv-builder:data";

export function loadStoredCvData(): CvData | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(CV_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = cvSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function storeCvData(data: CvData) {
  window.localStorage.setItem(CV_STORAGE_KEY, JSON.stringify(data));
}

export function clearStoredCvData() {
  window.localStorage.removeItem(CV_STORAGE_KEY);
}
