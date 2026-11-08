"use client";

import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminCommittedOperationSchema, adminErrorSchema, adminMutationRequestSchema, type AdminMutationRequest } from "@/lib/admin/contract";
import { currentAdminSession, type AdminSession } from "./admin-session";
export function useAdminMutation(client: SupabaseClient, actor: AdminSession, onCommitted: () => void) {
  const mounted = useRef(true);
  const pending = useRef<AdminMutationRequest | null>(null);
  const unknownOutcome = useRef(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function submit(value: unknown): Promise<boolean> {
    if (!actor.session || busy) return false;
    const captured = actor,
      token = actor.session.access_token;
    const current = () => {
      const latest = currentAdminSession(client);
      return mounted.current && latest.session?.user.id === captured.session?.user.id && latest.principalEpoch === captured.principalEpoch;
    };
    setBusy(true);
    setError(null);
    try {
      pending.current ??= adminMutationRequestSchema.parse(value);
      const input = pending.current;
      const response = await fetch("/api/admin", {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(input)
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        const code = adminErrorSchema.parse(raw).error.code;
        // A retry's preflight/validation rejection cannot prove that the
        // earlier write failed. Only a receipt or a new DB contract/instance
        // releases an operation whose outcome was already unknown.
        const keepUnknown = code !== "CLIENT_UPDATE_REQUIRED" && (unknownOutcome.current || response.status >= 500);
        if (!keepUnknown) pending.current = null;
        unknownOutcome.current = keepUnknown;
        if (current()) {
          setUncertain(keepUnknown);
          setError(keepUnknown ? "RESULT_UNKNOWN" : code);
        }
        if ([401, 403].includes(response.status)) onCommitted();
        return false;
      }
      const receipt = adminCommittedOperationSchema.parse(raw);
      if (receipt.operation !== input.operation.slice("admin_".length) || "id" in input && input.id !== null && input.id !== receipt.entity_id) throw new Error("Invalid mutation receipt");
      pending.current = null;
      unknownOutcome.current = false;
      // A late successful commit must invalidate related caches even after this
      // dialog unmounts. The read callback checks user visit and DB instance.
      onCommitted();
      if (current()) {
        setUncertain(false);
        return true;
      }
      return false;
    } catch (cause) {
      if (current()) {
        unknownOutcome.current = Boolean(pending.current);
        setUncertain(unknownOutcome.current);
        setError(pending.current ? "RESULT_UNKNOWN" : cause instanceof Error ? cause.message : "INVALID_REQUEST");
      }
      return false;
    } finally {
      if (current()) setBusy(false);
    }
  }
  return {
    busy,
    uncertain,
    error,
    submit,
    clearError: () => {
      if (!pending.current) {
        setError(null);
        unknownOutcome.current = false;
        setUncertain(false);
      }
    }
  };
}
