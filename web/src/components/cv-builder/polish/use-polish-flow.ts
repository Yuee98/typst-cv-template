"use client";

/**
 * usePolishFlow — the dialog-facing state owner of the AI polish flow and
 * the API surface unit 3.5 wires the editor entry buttons to.
 *
 * Responsibilities (everything the pure reducer deliberately does NOT do):
 * - build snapshots from the live form via the scope builder (disclosure and
 *   request always come from the SAME snapshot),
 * - mint clientRequestId per confirm (crypto.randomUUID) and fire the
 *   request through the injectable PolishApiClient with an AbortController,
 * - quota fetch (GET /api/polish/quota — skipped when signed out / no
 *   Supabase, i.e. static mode never requests it),
 * - AI terms gate: query acceptance on open, write the acceptance BEFORE the
 *   first polish request, re-show the red checkbox on 403 AI_TERMS_REQUIRED,
 * - stale guards: whole-snapshot path baseline at confirm/response time,
 *   per-item expectedCurrent checks before every write-back (getValues
 *   point-in-time reads only — no watch subscriptions),
 * - write accepted values back into RHF; undo restores the original.
 *
 * All request/response content stays inside the dialog: the hook returns
 * state and intents only, no editor coupling beyond the RHF instance.
 *
 * Ref discipline: only genuinely mutable non-render state lives in refs (the
 * in-flight AbortController, the snapshot path baseline, the mounted flag);
 * everything else is read from render-scoped state via hook dependencies, so
 * no ref is ever written during render (react-hooks/refs).
 */

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { FieldPath, UseFormReturn } from "react-hook-form";

import type { CvData } from "@/lib/cv/schema";
import { acceptCurrentAiTerms, hasAcceptedCurrentAiTerms } from "@/lib/legal/terms-acceptance";
import type {
  PolishContextLevel,
  PolishLanguage,
  PolishQuota,
  PolishStylePreset,
} from "@/lib/polish/contract";

import {
  aiTermsAllowConfirm,
  aiTermsGateReducer,
  createInitialAiTermsGateState,
  type AiTermsGateState,
} from "./ai-terms-gate";
import {
  createPolishClientFromEnv,
  PolishApiError,
  type PolishApiClient,
} from "./polish-client";
import { POLISH_TRANSPORT_ERROR_CODES } from "./polish-errors";
import {
  createInitialState,
  polishReducer,
  type PolishError,
  type PolishItemStatus,
  type PolishParams,
  type PolishState,
} from "./polish-reducer";
import {
  buildPolishSnapshot,
  type PolishScope,
  type PolishScopeFailureCode,
  type PolishSnapshot,
} from "./scope-builder";
import {
  captureSnapshotPathValues,
  checkWriteBack,
  isSnapshotStale,
  planWriteBack,
  type SnapshotPathValues,
} from "./stale-guard";

/** Terms-acceptance backend; the default talks to Supabase, tests/dev inject. */
export interface PolishTermsGateway {
  hasAccepted(): Promise<boolean>;
  accept(): Promise<void>;
}

export interface UsePolishFlowOptions {
  form: UseFormReturn<CvData>;
  /** Active document; opening without one is a no-op. */
  documentId: string | null;
  /** E2EE document: the dialog shows the prominent plaintext warning. */
  encrypted?: boolean;
  /** Output language of the polish request (cv.typstLang). */
  language: PolishLanguage;
  session: Session | null;
  supabase: SupabaseClient | null;
  /** Injectable API client (mock/dev/tests); defaults to the env factory. */
  client?: PolishApiClient;
  /** Injectable terms backend; defaults to the Supabase-backed gateway. */
  termsGateway?: PolishTermsGateway;
  /** Injectable token source for the default client. */
  getAccessToken?: () => Promise<string | null>;
}

export type PolishQuotaStatus = "idle" | "loading" | "ready" | "error";

export interface PolishFlow {
  isOpen: boolean;
  state: PolishState<PolishSnapshot>;
  scope: PolishScope | null;
  /** Non-null when the current scope cannot produce a submittable snapshot. */
  scopeFailure: PolishScopeFailureCode | null;
  signedIn: boolean;
  /** From options: E2EE documents get the prominent plaintext warning. */
  encrypted: boolean;
  /** Point-in-time RHF read (preview group labels; never a subscription). */
  getValue: (path: string) => unknown;
  quota: PolishQuota | null;
  quotaStatus: PolishQuotaStatus;
  terms: {
    status: AiTermsGateState["status"];
    serverRejected: boolean;
    checked: boolean;
    setChecked: (checked: boolean) => void;
  };
  /** The disclosure changed underneath the dialog; the user must re-review. */
  configChangedHint: boolean;
  /** Preview: item ids whose write-back was blocked by the stale guard. */
  staleItemIds: ReadonlySet<string>;
  /** Preview: reference paths drifted — context no longer matches the request. */
  referencesStale: boolean;
  canConfirm: boolean;
  open: (scope: PolishScope) => void;
  close: () => void;
  setLevel: (level: PolishContextLevel) => void;
  setStylePreset: (preset: PolishStylePreset | undefined) => void;
  setStyleInstruction: (instruction: string) => void;
  confirm: () => void;
  /** loading → abort the in-flight request (counts toward quota server-side). */
  cancel: () => void;
  /** error → same as confirm (fresh clientRequestId). */
  retry: () => void;
  /** preview/error → config, keeping accepted write-backs (rerun semantics). */
  backToConfig: () => void;
  acceptItem: (id: string) => void;
  rejectItem: (id: string) => void;
  undoAcceptItem: (id: string) => void;
  undoRejectItem: (id: string) => void;
  acceptAll: () => void;
  rejectAll: () => void;
  /** Config phase: retry a failed terms-acceptance query. */
  refreshTerms: () => void;
  /** Config phase: retry a failed quota fetch. */
  quotaRetry: () => void;
}

export function usePolishFlow(options: UsePolishFlowOptions): PolishFlow {
  const {
    form,
    documentId,
    language,
    encrypted = false,
    session,
    supabase,
    getAccessToken: injectedGetAccessToken,
  } = options;

  const [state, dispatch] = useReducer(
    polishReducer<PolishSnapshot>,
    undefined,
    () => createInitialState<PolishSnapshot>(),
  );
  const [isOpen, setIsOpen] = useState(false);
  const [scope, setScope] = useState<PolishScope | null>(null);
  const [scopeFailure, setScopeFailure] = useState<PolishScopeFailureCode | null>(null);
  const [quota, setQuota] = useState<PolishQuota | null>(null);
  const [quotaStatus, setQuotaStatus] = useState<PolishQuotaStatus>("idle");
  const [termsState, dispatchTerms] = useReducer(
    aiTermsGateReducer,
    undefined,
    createInitialAiTermsGateState,
  );
  const [termsChecked, setTermsChecked] = useState(false);
  const [configChangedHint, setConfigChangedHint] = useState(false);
  const [staleItemIds, setStaleItemIds] = useState<ReadonlySet<string>>(() => new Set());
  const [referencesStale, setReferencesStale] = useState(false);

  // Mutable non-render state only.
  const abortRef = useRef<AbortController | null>(null);
  const pathValuesRef = useRef<SnapshotPathValues>({});
  const mountedRef = useRef(true);

  const getAccessToken = useCallback(
    () =>
      injectedGetAccessToken
        ? injectedGetAccessToken()
        : (async () => {
            if (supabase) {
              const { data } = await supabase.auth.getSession();
              return data.session?.access_token ?? null;
            }
            return session?.access_token ?? null;
          })(),
    [injectedGetAccessToken, session, supabase],
  );

  const client = useMemo(
    () => options.client ?? createPolishClientFromEnv({ getAccessToken }),
    [options.client, getAccessToken],
  );

  const termsGateway = useMemo<PolishTermsGateway | null>(() => {
    if (options.termsGateway) return options.termsGateway;
    if (!supabase) return null;
    return {
      hasAccepted: () => hasAcceptedCurrentAiTerms(supabase),
      accept: () => acceptCurrentAiTerms(supabase),
    };
  }, [options.termsGateway, supabase]);

  const getValue = useCallback(
    (path: string) => form.getValues(path as FieldPath<CvData>),
    [form],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  // ── snapshot building ──────────────────────────────────────────────

  const buildSnapshot = useCallback(
    (forScope: PolishScope, params: PolishParams, clientRequestId: string) => {
      if (!documentId) {
        return { ok: false as const, code: "invalid_scope" as const };
      }
      return buildPolishSnapshot({
        documentId,
        cv: form.getValues(),
        language,
        scope: forScope,
        level: params.level,
        stylePreset: params.stylePreset,
        styleInstruction: params.styleInstruction,
        clientRequestId,
      });
    },
    [documentId, form, language],
  );

  /** Rebuild the config-phase snapshot + disclosure from the current form. */
  const configure = useCallback(
    (params: PolishParams, forScope: PolishScope) => {
      const built = buildSnapshot(forScope, params, crypto.randomUUID());
      if (!built.ok) {
        setScopeFailure(built.code);
        return;
      }
      setScopeFailure(null);
      pathValuesRef.current = captureSnapshotPathValues(built.snapshot, getValue);
      dispatch({ type: "CONFIGURE", params, snapshot: built.snapshot });
    },
    [buildSnapshot, getValue],
  );

  // ── quota & terms fetching ─────────────────────────────────────────

  const refreshQuota = useCallback(async () => {
    if (!session) {
      setQuota(null);
      setQuotaStatus("idle");
      return;
    }
    setQuotaStatus("loading");
    try {
      const response = await client.getQuota();
      if (!mountedRef.current) return;
      setQuota(response.quota);
      setQuotaStatus("ready");
    } catch {
      if (!mountedRef.current) return;
      setQuotaStatus("error");
    }
  }, [client, session]);

  const queryTerms = useCallback(async () => {
    if (!session || !termsGateway) {
      dispatchTerms({ type: "RESET" });
      return;
    }
    dispatchTerms({ type: "QUERY_START" });
    try {
      const accepted = await termsGateway.hasAccepted();
      if (!mountedRef.current) return;
      dispatchTerms({ type: "QUERY_RESOLVE", accepted });
    } catch {
      if (!mountedRef.current) return;
      dispatchTerms({ type: "FAIL" });
    }
  }, [session, termsGateway]);

  // ── open / close ───────────────────────────────────────────────────

  const open = useCallback(
    (nextScope: PolishScope) => {
      if (!documentId) return;
      setScope(nextScope);
      setIsOpen(true);
      setConfigChangedHint(false);
      setStaleItemIds(new Set());
      setReferencesStale(false);
      setTermsChecked(false);
      dispatch({ type: "RESET" });
      // RESET keeps the params; the CONFIGURE below is batched after it and
      // lands on the fresh initial (config) state.
      configure(state.params, nextScope);
      void refreshQuota();
      void queryTerms();
    },
    [configure, documentId, queryTerms, refreshQuota, state.params],
  );

  const close = useCallback(() => {
    // Every close path during loading aborts the request (roadmap); the
    // aborted continuation returns without dispatching, and even a response
    // that still lands no-ops because RESET cleared the in-flight id.
    abortRef.current?.abort();
    abortRef.current = null;
    dispatch({ type: "RESET" });
    setIsOpen(false);
    setScope(null);
    setScopeFailure(null);
    setConfigChangedHint(false);
    setStaleItemIds(new Set());
    setReferencesStale(false);
  }, []);

  // The snapshot is tied to its document: a document switch hides the dialog
  // (derived, no effect). Practically unreachable while the modal traps
  // focus — pure defense; the next open() rebuilds everything anyway.
  const documentMismatch =
    state.snapshot !== null && documentId !== state.snapshot.documentId;

  // ── config-phase param setters ─────────────────────────────────────

  const reconfigure = useCallback(
    (params: PolishParams) => {
      if (state.phase !== "config" || !scope) return;
      setConfigChangedHint(false);
      configure(params, scope);
    },
    [configure, scope, state.phase],
  );

  const setLevel = useCallback(
    (level: PolishContextLevel) => reconfigure({ ...state.params, level }),
    [reconfigure, state.params],
  );

  const setStylePreset = useCallback(
    (stylePreset: PolishStylePreset | undefined) =>
      reconfigure({ ...state.params, stylePreset }),
    [reconfigure, state.params],
  );

  const setStyleInstruction = useCallback(
    (styleInstruction: string) =>
      reconfigure({
        ...state.params,
        styleInstruction: styleInstruction === "" ? undefined : styleInstruction,
      }),
    [reconfigure, state.params],
  );

  // ── confirm / request lifecycle ────────────────────────────────────

  const confirm = useCallback(async () => {
    const phase = state.phase;
    if (phase !== "config" && phase !== "error") return;
    if (!scope || !documentId || scopeFailure !== null) return;
    if (!session) return;
    if (!aiTermsAllowConfirm(termsState, termsChecked)) return;

    // Pre-flight stale guard: the disclosure must match what will be sent.
    // Content changed underneath → rebuild the disclosure and ask for a
    // re-review instead of silently sending different content.
    if (isSnapshotStale(pathValuesRef.current, getValue)) {
      if (phase === "error") dispatch({ type: "RERUN" });
      configure(state.params, scope);
      setConfigChangedHint(true);
      return;
    }
    setConfigChangedHint(false);

    // Progressive consent: write the acceptance BEFORE the polish request.
    if (termsState.status === "required") {
      if (!termsGateway) return;
      dispatchTerms({ type: "ACCEPT_START" });
      try {
        await termsGateway.accept();
        dispatchTerms({ type: "ACCEPT_RESOLVE" });
      } catch {
        dispatchTerms({ type: "FAIL" });
        return;
      }
    }

    // Dedup keys are single-use: mint a fresh one for every attempt (retries
    // and reruns included). The rebuilt snapshot is deterministic, so it
    // equals the disclosed one — the stale check above proves it.
    const clientRequestId = crypto.randomUUID();
    const built = buildSnapshot(scope, state.params, clientRequestId);
    if (!built.ok) {
      setScopeFailure(built.code);
      if (phase === "error") dispatch({ type: "RERUN" });
      return;
    }
    pathValuesRef.current = captureSnapshotPathValues(built.snapshot, getValue);
    dispatch({
      type: "CONFIRM",
      params: state.params,
      snapshot: built.snapshot,
      clientRequestId,
    });

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await client.polish(built.snapshot.apiRequest, {
        signal: controller.signal,
      });
      abortRef.current = null;
      if (controller.signal.aborted || !mountedRef.current) return;
      setQuota(response.quota);
      setQuotaStatus("ready");
      // Whole-snapshot guard: targets or sent context drifted while in
      // flight → degrade to SNAPSHOT_STALE instead of applying the response.
      if (isSnapshotStale(pathValuesRef.current, getValue)) {
        dispatch({ type: "MARK_SNAPSHOT_STALE" });
      }
      dispatch({
        type: "REQUEST_SUCCESS",
        clientRequestId,
        serverRequestId: response.requestId,
        items: response.items,
      });
    } catch (error) {
      abortRef.current = null;
      if (!mountedRef.current) return;
      if (
        error instanceof PolishApiError &&
        error.code === POLISH_TRANSPORT_ERROR_CODES.requestAborted
      ) {
        return; // cancel()/close() already moved the reducer on
      }
      if (error instanceof PolishApiError && error.code === "AI_TERMS_REQUIRED") {
        // Local view said accepted but the server disagrees: back to config
        // with the checkbox re-shown in red — never the generic error phase.
        dispatchTerms({ type: "SERVER_REJECTED" });
        dispatch({ type: "ABORT" });
        return;
      }
      dispatch({
        type: "REQUEST_FAILURE",
        clientRequestId,
        serverRequestId: error instanceof PolishApiError ? error.requestId : undefined,
        error: toPolishError(error),
      });
    }
  }, [
    buildSnapshot,
    client,
    configure,
    documentId,
    getValue,
    scope,
    scopeFailure,
    session,
    state.params,
    state.phase,
    termsGateway,
    termsChecked,
    termsState,
  ]);

  const cancel = useCallback(() => {
    if (state.phase !== "loading") return;
    abortRef.current?.abort();
    abortRef.current = null;
    dispatch({ type: "ABORT" });
  }, [state.phase]);

  const retry = useCallback(() => {
    void confirm();
  }, [confirm]);

  const backToConfig = useCallback(() => {
    if ((state.phase !== "preview" && state.phase !== "error") || !scope) return;
    dispatch({ type: "RERUN" });
    // Rebuild the disclosure from the current form: accepted write-backs
    // become the new baseline (reducer rerun semantics).
    configure(state.params, scope);
    setStaleItemIds(new Set());
    setReferencesStale(false);
    setConfigChangedHint(false);
  }, [configure, scope, state.params, state.phase]);

  // ── preview-phase item transitions (write-back + stale guard) ──────

  const transitionItem = useCallback(
    (
      id: string,
      next: PolishItemStatus,
      actionType: "ACCEPT_ITEM" | "REJECT_ITEM" | "UNDO_ACCEPT_ITEM" | "UNDO_REJECT_ITEM",
    ) => {
      const item = state.items.find((candidate) => candidate.id === id);
      if (!item) return;
      const plan = planWriteBack(item, next);
      const check = checkWriteBack(plan, getValue(item.path));
      if (!check.ok) {
        // The field drifted underneath: block the transition, flag the item.
        setStaleItemIds((previous) => new Set(previous).add(id));
        return;
      }
      if (plan.write) {
        form.setValue(item.path as FieldPath<CvData>, plan.value, {
          shouldDirty: true,
          shouldValidate: true,
        });
      }
      setStaleItemIds((previous) => {
        if (!previous.has(id)) return previous;
        const nextSet = new Set(previous);
        nextSet.delete(id);
        return nextSet;
      });
      // Accepted write-backs legitimately move target paths; re-check only
      // the reference baseline for the "context changed" hint.
      setReferencesStale(
        isSnapshotStale(pathValuesRef.current, getValue, state.snapshot?.referencePaths ?? []),
      );
      dispatch({ type: actionType, id });
    },
    [form, getValue, state.items, state.snapshot],
  );

  const acceptItem = useCallback(
    (id: string) => transitionItem(id, "accepted", "ACCEPT_ITEM"),
    [transitionItem],
  );
  const rejectItem = useCallback(
    (id: string) => transitionItem(id, "rejected", "REJECT_ITEM"),
    [transitionItem],
  );
  const undoAcceptItem = useCallback(
    (id: string) => transitionItem(id, "pending", "UNDO_ACCEPT_ITEM"),
    [transitionItem],
  );
  const undoRejectItem = useCallback(
    (id: string) => transitionItem(id, "pending", "UNDO_REJECT_ITEM"),
    [transitionItem],
  );

  const acceptAll = useCallback(() => {
    for (const item of state.items) {
      if (item.state !== "accepted") transitionItem(item.id, "accepted", "ACCEPT_ITEM");
    }
  }, [state.items, transitionItem]);

  const rejectAll = useCallback(() => {
    for (const item of state.items) {
      if (item.state !== "rejected") transitionItem(item.id, "rejected", "REJECT_ITEM");
    }
  }, [state.items, transitionItem]);

  const refreshTerms = useCallback(() => {
    void queryTerms();
  }, [queryTerms]);

  const quotaRetry = useCallback(() => {
    void refreshQuota();
  }, [refreshQuota]);

  // ── derived ────────────────────────────────────────────────────────

  const signedIn = Boolean(session);
  const canConfirm =
    state.phase === "config" &&
    scopeFailure === null &&
    state.snapshot !== null &&
    signedIn &&
    (termsState.status === "accepted" || termsState.status === "required") &&
    aiTermsAllowConfirm(termsState, termsChecked) &&
    (quota === null || quota.remaining > 0);

  return {
    isOpen: isOpen && !documentMismatch,
    state,
    scope,
    scopeFailure,
    signedIn,
    encrypted,
    getValue,
    quota,
    quotaStatus,
    terms: {
      status: termsState.status,
      serverRejected: termsState.serverRejected,
      checked: termsChecked,
      setChecked: setTermsChecked,
    },
    configChangedHint,
    staleItemIds,
    referencesStale,
    canConfirm,
    open,
    close,
    setLevel,
    setStylePreset,
    setStyleInstruction,
    confirm: () => void confirm(),
    cancel,
    retry,
    backToConfig,
    acceptItem,
    rejectItem,
    undoAcceptItem,
    undoRejectItem,
    acceptAll,
    rejectAll,
    refreshTerms,
    quotaRetry,
  };
}

function toPolishError(error: unknown): PolishError {
  if (error instanceof PolishApiError) {
    return {
      code: error.code,
      message: error.message,
      resetAt: error.resetAt,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  return { code: POLISH_TRANSPORT_ERROR_CODES.networkError };
}
