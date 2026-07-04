import type { SupabaseClient } from "@supabase/supabase-js";
import { useState } from "react";

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
  hasSession,
  onError,
  supabase,
}: {
  hasSession: boolean;
  onError: (message: string) => void;
  supabase: SupabaseClient | null;
}) {
  const [status, setStatus] = useState<TermsStatus>("unknown");
  const [modalOpen, setModalOpen] = useState(false);
  const [modalChecked, setModalChecked] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);

  function promptForAcceptance() {
    setStatus("required");
    setModalOpen(true);
    setModalChecked(false);
    setModalError(null);
  }

  function reset() {
    setStatus("unknown");
    setModalOpen(false);
    setModalChecked(false);
    setModalError(null);
  }

  async function refresh(
    client: SupabaseClient,
    { showModal = true }: { showModal?: boolean } = {},
  ) {
    try {
      let accepted = await hasAcceptedCurrentTerms(client);
      if (!accepted && consumePendingTermsAcceptance()) {
        await acceptCurrentTerms(client);
        accepted = true;
      }

      setStatus(accepted ? "accepted" : "required");
      if (!accepted && showModal) {
        promptForAcceptance();
      }
      return accepted;
    } catch (termsError) {
      setStatus("unknown");
      onError(errorMessage(termsError));
      return false;
    }
  }

  async function ensure(client: SupabaseClient | null = supabase) {
    if (!client || !hasSession) {
      return false;
    }

    if (status === "accepted") {
      return true;
    }

    const accepted = await refresh(client);
    if (!accepted) {
      promptForAcceptance();
    }
    return accepted;
  }

  async function accept() {
    if (!supabase || !hasSession) {
      setModalError("Sign in before accepting the Terms and Privacy Notice.");
      return false;
    }

    if (!modalChecked) {
      setModalError("Check the box before accepting.");
      return false;
    }

    setAccepting(true);
    setModalError(null);

    try {
      await acceptCurrentTerms(supabase);
      setStatus("accepted");
      setModalOpen(false);
      setModalChecked(false);
      return true;
    } catch (termsError) {
      setModalError(errorMessage(termsError));
      return false;
    } finally {
      setAccepting(false);
    }
  }

  async function recordAccepted(client: SupabaseClient) {
    await acceptCurrentTerms(client);
    setStatus("accepted");
    clearPendingTermsAcceptance();
  }

  return {
    accepting,
    modalChecked,
    modalError,
    modalOpen,
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
