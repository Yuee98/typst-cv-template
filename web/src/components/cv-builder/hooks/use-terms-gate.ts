import type { SupabaseClient } from "@supabase/supabase-js";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { errorMessage } from "@/lib/cv/cv-utils";
import { acceptCurrentTerms, getCurrentLegal, hasAcceptedTerms, type CurrentTerms } from "@/lib/legal/terms-acceptance";
export type TermsStatus = "unknown" | "accepted" | "required";
export function useTermsGate({
  tTermsGate,
  userId,
  onError,
  supabase
}: {
  tTermsGate: ReturnType<typeof useTranslations<"TermsGate">>;
  userId: string | null;
  onError: (message: string) => void;
  supabase: SupabaseClient | null;
}) {
  const [owned, setOwned] = useState<{
    userId: string;
    status: TermsStatus;
    terms: CurrentTerms;
  } | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalChecked, setModalChecked] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const owner = useRef(userId);
  const sequence = useRef(0);
  useLayoutEffect(() => {
    if (owner.current !== userId) {
      owner.current = userId;
      sequence.current += 1;
    }
  }, [userId]);
  const visible = owned?.userId === userId;
  const status = visible ? owned.status : "unknown";
  function reset() {
    sequence.current++;
    setOwned(null);
    setModalOpen(false);
    setModalChecked(false);
    setModalError(null);
    setAccepting(false);
  }
  async function refresh(client: SupabaseClient, {
    showModal = true
  }: {
    showModal?: boolean;
  } = {}) {
    if (!userId) return false;
    const actor = userId;
    const seq = ++sequence.current;
    try {
      const {
        terms
      } = await getCurrentLegal(client);
      const accepted = await hasAcceptedTerms(client, terms);
      if (owner.current !== actor || sequence.current !== seq) return false;
      setOwned({
        userId: actor,
        status: accepted ? "accepted" : "required",
        terms
      });
      setModalChecked(false);
      setModalError(null);
      setModalOpen(!accepted && showModal);
      return accepted;
    } catch (error) {
      if (owner.current === actor && sequence.current === seq) {
        setOwned(null);
        onError(errorMessage(error));
      }
      return false;
    }
  }
  async function ensure(client: SupabaseClient | null = supabase) {
    return client && userId ? refresh(client) : false;
  }
  async function accept() {
    if (!supabase || !userId || !visible || !owned) {
      setModalError(tTermsGate("signInRequired"));
      return false;
    }
    if (!modalChecked) {
      setModalError(tTermsGate("checkBoxRequired"));
      return false;
    }
    const actor = userId;
    const seq = ++sequence.current;
    const target = owned.terms;
    setAccepting(true);
    setModalError(null);
    try {
      await acceptCurrentTerms(supabase, target, actor);
      if (owner.current !== actor || sequence.current !== seq) return false;
      setOwned({
        userId: actor,
        status: "accepted",
        terms: target
      });
      setModalOpen(false);
      setModalChecked(false);
      return true;
    } catch (error) {
      if (owner.current === actor && sequence.current === seq) setModalError(errorMessage(error));
      return false;
    } finally {
      if (owner.current === actor && sequence.current === seq) setAccepting(false);
    }
  }
  return {
    accepting: visible ? accepting : false,
    modalChecked: visible ? modalChecked : false,
    modalError: visible ? modalError : null,
    modalOpen: visible ? modalOpen : false,
    terms: visible ? owned.terms : null,
    status,
    accept,
    ensure,
    refresh,
    reset,
    setModalChecked,
    setModalError,
    setModalOpen
  };
}
