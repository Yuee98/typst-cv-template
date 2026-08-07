import { TERMS_VERSION } from "@/content/legal";

const PENDING_TERMS_ACCEPTANCE_KEY = "typst-cv-builder:pending-terms-acceptance";

export const TERMS_ACCEPTANCE_FLOW_PARAM = "terms_acceptance_flow";

export type PendingTermsAcceptance =
  | { oauthFlowId: string }
  | { userId: string };

type StoredPendingTermsAcceptance =
  | { kind: "oauth"; oauthFlowId: string; version: string }
  | { kind: "password"; userId: string; version: string };

export function createTermsAcceptanceFlowId() {
  return crypto.randomUUID();
}

export function markPendingTermsAcceptance(pending: PendingTermsAcceptance) {
  if (typeof window === "undefined") return;

  const stored: StoredPendingTermsAcceptance = "userId" in pending
    ? { kind: "password", userId: pending.userId, version: TERMS_VERSION }
    : { kind: "oauth", oauthFlowId: pending.oauthFlowId, version: TERMS_VERSION };
  window.sessionStorage.setItem(PENDING_TERMS_ACCEPTANCE_KEY, JSON.stringify(stored));
}

export function clearPendingTermsAcceptance() {
  if (typeof window === "undefined") return;

  window.sessionStorage.removeItem(PENDING_TERMS_ACCEPTANCE_KEY);
}

export function consumePendingTermsAcceptance(userId: string) {
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

  const matches = pending.kind === "password"
    ? pending.userId === userId
    : new URLSearchParams(window.location.search).get(TERMS_ACCEPTANCE_FLOW_PARAM) === pending.oauthFlowId;
  if (!matches) {
    return false;
  }

  clearPendingTermsAcceptance();
  return true;
}
