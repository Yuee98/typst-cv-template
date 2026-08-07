import type { SupabaseClient } from "@supabase/supabase-js";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { errorMessage } from "@/lib/cv/cv-utils";
import { acceptCurrentTerms, hasAcceptedCurrentTerms } from "@/lib/legal/terms-acceptance";
import {
  clearPendingTermsAcceptance,
  consumePendingTermsAcceptance,
  markPendingTermsAcceptance,
  type PendingTermsAcceptance,
} from "@/lib/legal/pending-terms-acceptance";

export type TermsStatus = "unknown" | "accepted" | "required";

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
  const operationRef = useRef(0);
  useLayoutEffect(() => {
    if (userIdRef.current !== userId) {
      userIdRef.current = userId;
      operationRef.current += 1;
    }
  }, [userId]);
  const ownsVisibleState = ownedStatus?.ownerId === userId;
  const status = ownsVisibleState ? ownedStatus.status : "unknown";

  function isCurrentOwner(ownerId: string | null): ownerId is string {
    return Boolean(ownerId && userIdRef.current === ownerId);
  }

  function beginOperation() {
    operationRef.current += 1;
    return operationRef.current;
  }

  function ownsOperation(ownerId: string | null, operation: number): ownerId is string {
    return isCurrentOwner(ownerId) && operationRef.current === operation;
  }

  function promptForAcceptance(ownerId: string | null, operation: number) {
    if (!ownsOperation(ownerId, operation)) {
      return;
    }

    setOwnedStatus({ ownerId, status: "required" });
    setModalOpen(true);
    setModalChecked(false);
    setModalError(null);
    setAccepting(false);
  }

  function reset() {
    beginOperation();
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
    const operation = beginOperation();

    try {
      let accepted = await hasAcceptedCurrentTerms(client);
      if (!ownsOperation(ownerId, operation)) {
        return false;
      }

      if (!accepted && await consumePendingTermsAcceptance(ownerId)) {
        await acceptCurrentTerms(client);
        if (!ownsOperation(ownerId, operation)) {
          return false;
        }
        accepted = true;
      }

      setOwnedStatus({ ownerId, status: accepted ? "accepted" : "required" });
      if (!accepted && showModal) {
        promptForAcceptance(ownerId, operation);
      }
      return accepted;
    } catch (termsError) {
      if (ownsOperation(ownerId, operation)) {
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

    return refresh(client);
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

    const operation = beginOperation();
    setAccepting(true);
    setModalError(null);

    try {
      await acceptCurrentTerms(supabase);
      if (!ownsOperation(ownerId, operation)) {
        return false;
      }
      setOwnedStatus({ ownerId, status: "accepted" });
      setModalOpen(false);
      setModalChecked(false);
      return true;
    } catch (termsError) {
      if (ownsOperation(ownerId, operation)) {
        setModalError(errorMessage(termsError));
      }
      return false;
    } finally {
      if (ownsOperation(ownerId, operation)) {
        setAccepting(false);
      }
    }
  }

  async function recordAccepted(client: SupabaseClient, acceptedUserId?: string) {
    const ownerId = acceptedUserId ?? userId;
    if (!ownerId) {
      return;
    }
    const operation = beginOperation();

    await acceptCurrentTerms(client);
    clearPendingTermsAcceptance();
    if (!ownsOperation(ownerId, operation)) {
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
    markPendingAcceptance: (pending: PendingTermsAcceptance) => markPendingTermsAcceptance(pending),
    recordAccepted,
    refresh,
    reset,
    setModalChecked,
    setModalError,
    setModalOpen,
  };
}
