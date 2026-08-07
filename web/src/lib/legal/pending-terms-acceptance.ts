import { TERMS_VERSION } from "@/content/legal";

const PENDING_TERMS_ACCEPTANCE_KEY = "typst-cv-builder:pending-terms-acceptance";

export const TERMS_ACCEPTANCE_FLOW_PARAM = "terms_acceptance_flow";

export type PendingTermsAcceptance =
  | { oauthFlowId: string }
  | { userId: string };

type StoredPendingTermsAcceptance =
  | { kind: "oauth"; oauthFlowHash: string; version: string }
  | { kind: "password"; userIdHash: string; version: string };

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createTermsAcceptanceFlowId() {
  return crypto.randomUUID();
}

export async function markPendingTermsAcceptance(pending: PendingTermsAcceptance) {
  if (typeof window === "undefined") return;

  const stored: StoredPendingTermsAcceptance = "userId" in pending
    ? { kind: "password", userIdHash: await sha256(pending.userId), version: TERMS_VERSION }
    : { kind: "oauth", oauthFlowHash: await sha256(pending.oauthFlowId), version: TERMS_VERSION };
  window.sessionStorage.setItem(PENDING_TERMS_ACCEPTANCE_KEY, JSON.stringify(stored));
}

export function clearPendingTermsAcceptance() {
  if (typeof window === "undefined") return;

  window.sessionStorage.removeItem(PENDING_TERMS_ACCEPTANCE_KEY);
}

export async function consumePendingTermsAcceptance(userId: string) {
  if (typeof window === "undefined") {
    return false;
  }

  const raw = window.sessionStorage.getItem(PENDING_TERMS_ACCEPTANCE_KEY);
  if (!raw) {
    return false;
  }

  let pending: StoredPendingTermsAcceptance;
  try {
    pending = JSON.parse(raw) as StoredPendingTermsAcceptance;
  } catch {
    clearPendingTermsAcceptance();
    return false;
  }

  if (pending.version !== TERMS_VERSION) {
    clearPendingTermsAcceptance();
    return false;
  }

  const oauthFlowId = new URLSearchParams(window.location.search).get(TERMS_ACCEPTANCE_FLOW_PARAM);
  const matches = pending.kind === "password"
    ? pending.userIdHash === await sha256(userId)
    : Boolean(oauthFlowId && pending.oauthFlowHash === await sha256(oauthFlowId));
  if (!matches) {
    return false;
  }

  clearPendingTermsAcceptance();
  return true;
}
