import type { SupabaseClient } from "@supabase/supabase-js";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { TERMS_VERSION } from "@/content/legal";
import { errorMessage } from "@/lib/cv/cv-utils";
import { acceptCurrentTerms, hasAcceptedCurrentTerms } from "@/lib/legal/terms-acceptance";

export type TermsStatus = "unknown" | "accepted" | "required";

const PENDING_TERMS_ACCEPTANCE_KEY = "typst-cv-builder:pending-terms-acceptance";

function markPendingTermsAcceptance() {
  if (typeof window === "undefined") return;

  window.sessionStorage.setItem(PENDING_TERMS_ACCEPTANCE_KEY, TERMS_VERSION);
}

function consumePendingTermsAcceptance() {
  if (
    typeof window === "undefined" ||
    window.sessionStorage.getItem(PENDING_TERMS_ACCEPTANCE_KEY) !== TERMS_VERSION
  ) {
    return false;
  }

  window.sessionStorage.removeItem(PENDING_TERMS_ACCEPTANCE_KEY);
  return true;
}

function clearPendingTermsAcceptance() {
  if (typeof window === "undefined") return;

  window.sessionStorage.removeItem(PENDING_TERMS_ACCEPTANCE_KEY);
}

export function useTermsGate({
  tTermsGate,
  userId,
  onError,
  supabase,
}: {
  tTermsGate: ReturnType<typeof useTranslations<"TermsGate">>;
  userId: string | null;
  onError: (message: string) => void;
  supabase: SupabaseClient | null;
}) {
  const [ownedStatus, setOwnedStatus] = useState<{
    ownerId: string;
    status: TermsStatus;
  } | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalChecked, setModalChecked] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const userIdRef = useRef(userId);
  useLayoutEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
  const ownsVisibleState = ownedStatus?.ownerId === userId;
  const status = ownsVisibleState ? ownedStatus.status : "unknown";

  function isCurrentOwner(ownerId: string | null): ownerId is string {
    return Boolean(ownerId && userIdRef.current === ownerId);
  }

  function promptForAcceptance(ownerId: string | null = userId) {
    if (!isCurrentOwner(ownerId)) {
      return;
    }

    setOwnedStatus({ ownerId, status: "required" });
    setModalOpen(true);
    setModalChecked(false);
    setModalError(null);
    setAccepting(false);
  }

  function reset() {
    setOwnedStatus(null);
    setModalOpen(false);
    setModalChecked(false);
    setModalError(null);
    setAccepting(false);
  }

  async function refresh(
    client: SupabaseClient,
    { showModal = true }: { showModal?: boolean } = {},
  ) {
    const ownerId = userId;
    if (!ownerId) {
      return false;
    }

    try {
      let accepted = await hasAcceptedCurrentTerms(client);
      if (!isCurrentOwner(ownerId)) {
        return false;
      }

      if (!accepted && consumePendingTermsAcceptance()) {
        await acceptCurrentTerms(client);
        if (!isCurrentOwner(ownerId)) {
          return false;
        }
        accepted = true;
      }

      setOwnedStatus({ ownerId, status: accepted ? "accepted" : "required" });
      if (!accepted && showModal) {
        promptForAcceptance(ownerId);
      }
      return accepted;
    } catch (termsError) {
      if (isCurrentOwner(ownerId)) {
        setOwnedStatus({ ownerId, status: "unknown" });
        onError(errorMessage(termsError));
      }
      return false;
    }
  }

  async function ensure(client: SupabaseClient | null = supabase) {
    const ownerId = userId;
    if (!client || !ownerId) {
      return false;
    }

    if (status === "accepted") {
      return true;
    }

    const accepted = await refresh(client);
    if (!accepted) {
      promptForAcceptance(ownerId);
    }
    return accepted;
  }

  async function accept() {
    const ownerId = userId;
    if (!supabase || !ownerId) {
      setModalError(tTermsGate("signInRequired"));
      return false;
    }

    if (!ownsVisibleState || !modalChecked) {
      setModalError(tTermsGate("checkBoxRequired"));
      return false;
    }

    setAccepting(true);
    setModalError(null);

    try {
      await acceptCurrentTerms(supabase);
      if (!isCurrentOwner(ownerId)) {
        return false;
      }
      setOwnedStatus({ ownerId, status: "accepted" });
      setModalOpen(false);
      setModalChecked(false);
      return true;
    } catch (termsError) {
      if (isCurrentOwner(ownerId)) {
        setModalError(errorMessage(termsError));
      }
      return false;
    } finally {
      setAccepting(false);
    }
  }

  async function recordAccepted(client: SupabaseClient) {
    const ownerId = userId;
    if (!ownerId) {
      return;
    }

    await acceptCurrentTerms(client);
    clearPendingTermsAcceptance();
    if (!isCurrentOwner(ownerId)) {
      return;
    }
    setOwnedStatus({ ownerId, status: "accepted" });
  }

  return {
    accepting: ownsVisibleState ? accepting : false,
    modalChecked: ownsVisibleState ? modalChecked : false,
    modalError: ownsVisibleState ? modalError : null,
    modalOpen: ownsVisibleState ? modalOpen : false,
    status,
    accept,
    clearPendingAcceptance: clearPendingTermsAcceptance,
    ensure,
    markPendingAcceptance: markPendingTermsAcceptance,
    recordAccepted,
    refresh,
    reset,
    setModalChecked,
    setModalError,
    setModalOpen,
  };
}
