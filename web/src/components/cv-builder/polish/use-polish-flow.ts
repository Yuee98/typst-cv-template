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
 * - stale guards: whole-snapshot identity baseline (document + request
 *   language + target/reference path values) at confirm/response time,
 *   per-item expectedCurrent checks before every write-back (getValues
 *   point-in-time reads only — no watch subscriptions),
 * - write accepted values back into RHF; undo restores the original.
 *
 * Async ownership (the reducer cannot guard hook-level side effects):
 * every confirm() claims an ActivePolishOperation — a token holding the
 * attempt's clientRequestId, its AbortController and cancel settlement
 * flags. open/close/cancel/unmount/account change/document change and any
 * disclosure rebuild REPLACE or clear the token, which kills every pending
 * continuation: after each await the continuation verifies it still owns the
 * token (object identity) before dispatching or touching quota/terms state,
 * and clears the controller only while it is still the owner. A canceled
 * operation's late settle therefore never disturbs a newer request.
 *
 * Snapshot freezing: confirm() sends the snapshot the user REVIEWED
 * (state.snapshot); the terms-acceptance await never triggers a rebuild from
 * the live form — only the single-use clientRequestId is swapped in. If the
 * post-acceptance baseline check fails, the disclosure is rebuilt and the
 * flow returns to config for explicit re-review instead of silently sending.
 *
 * User scoping: the terms gate and quota are keyed to session.user.id. An
 * account change aborts in-flight work, resets the terms reducer and the
 * checkbox, clears quota and closes/resets the dialog; terms/quota
 * continuations verify they still belong to the same user before applying.
 *
 * All request/response content stays inside the dialog: the hook returns
 * state and intents only, no editor coupling beyond the RHF instance.
 *
 * Ref discipline: only genuinely mutable non-render state lives in refs (the
 * active operation token, the snapshot baseline, identity snapshots for
 * async continuations, the mounted flag); identity refs are written only
 * inside effects, never during render (react-hooks/refs).
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
  /**
   * loading → abort the in-flight request (counts toward quota server-side).
   * The displayed remaining count is discarded and confirm stays blocked
   * until the quota re-read — fired from the canceled request's settlement
   * point, not from abort() — completes.
   */
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

/**
 * Ownership token of one confirm attempt (see the file header). Continuations
 * compare the ref against THEIR token before any side effect; replacement or
 * clearing means "you were superseded — stop".
 */
interface ActivePolishOperation {
  /** Dedup key minted at CONFIRM time; null during terms acceptance. */
  clientRequestId: string | null;
  /** In-flight request controller; null until the request fires. */
  controller: AbortController | null;
  /**
   * cancel() marks the operation so its settlement point (the catch branch)
   * re-reads quota — the server may still be settling the canceled request
   * at abort() time, so reading there could return the pre-request count.
   */
  refreshQuotaOnSettle: boolean;
}

/**
 * Everything a snapshot's validity depends on beyond its path values: the
 * document it was built from and the request language (cv.typstLang). A
 * same-document cloud reset can flip typstLang while leaving every target/
 * reference string identical — the path-only check would miss it.
 */
interface SnapshotBaseline {
  documentId: string;
  language: PolishLanguage;
  pathValues: SnapshotPathValues;
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
  const activeOperationRef = useRef<ActivePolishOperation | null>(null);
  const baselineRef = useRef<SnapshotBaseline | null>(null);
  const mountedRef = useRef(true);
  // Identity snapshots for async continuations (event handlers read the
  // render-scope props directly; continuations must not trust stale closures).
  const documentIdRef = useRef(documentId);
  const languageRef = useRef(language);
  const sessionUserIdRef = useRef(session?.user.id ?? null);

  const sessionUserId = session?.user.id ?? null;

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

  /**
   * Kill the active operation: abort its request (when one fired) and clear
   * the token. Every pending continuation of that operation stops at its
   * next ownership check. Never throws; safe to call anytime.
   */
  const invalidateActiveOperation = useCallback(() => {
    const operation = activeOperationRef.current;
    if (!operation) return;
    operation.controller?.abort();
    activeOperationRef.current = null;
  }, []);

  /** Clear the token only when the caller still owns it (relay: never let a
   * late operation clear a newer one's controller). */
  const clearOperationIfOwned = useCallback((operation: ActivePolishOperation) => {
    if (activeOperationRef.current === operation) {
      activeOperationRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidateActiveOperation();
    };
  }, [invalidateActiveOperation]);

  // Keep the identity refs current for async continuations. Runs after every
  // render; this effect is the ONLY writer of these refs.
  useEffect(() => {
    documentIdRef.current = documentId;
    languageRef.current = language;
    sessionUserIdRef.current = sessionUserId;
  });

  // Account switch (including sign-out) underneath the hook: the terms gate
  // and quota are user-scoped, so everything derived from the previous
  // account is invalidated — in-flight work aborts, the dialog closes and
  // the next open re-queries terms + quota for the NEW user.
  const previousSessionUserIdRef = useRef(sessionUserId);
  useEffect(() => {
    if (previousSessionUserIdRef.current === sessionUserId) return;
    previousSessionUserIdRef.current = sessionUserId;
    invalidateActiveOperation();
    baselineRef.current = null;
    dispatchTerms({ type: "RESET" });
    setTermsChecked(false);
    setQuota(null);
    setQuotaStatus("idle");
    dispatch({ type: "RESET" });
    setIsOpen(false);
    setScope(null);
    setScopeFailure(null);
    setConfigChangedHint(false);
    setStaleItemIds(new Set());
    setReferencesStale(false);
  }, [sessionUserId, invalidateActiveOperation]);

  // Document switch underneath the hook: the snapshot is tied to its
  // document, so anything built for the previous one is invalidated — abort
  // in flight, reset the machine, close the dialog. (The modal usually traps
  // focus; this is the hard guarantee, documentMismatch below the soft one.)
  const previousDocumentIdRef = useRef(documentId);
  useEffect(() => {
    if (previousDocumentIdRef.current === documentId) return;
    previousDocumentIdRef.current = documentId;
    invalidateActiveOperation();
    baselineRef.current = null;
    dispatch({ type: "RESET" });
    setIsOpen(false);
    setScope(null);
    setScopeFailure(null);
    setConfigChangedHint(false);
    setStaleItemIds(new Set());
    setReferencesStale(false);
  }, [documentId, invalidateActiveOperation]);

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

  /**
   * Rebuild the config-phase snapshot + disclosure from the current form and
   * capture its identity baseline. Rebuilding the disclosure supersedes any
   * pending async attempt (e.g. a param change during terms acceptance): the
   * reviewed content changed, so the old continuation must not send.
   */
  const configure = useCallback(
    (params: PolishParams, forScope: PolishScope) => {
      invalidateActiveOperation();
      const built = buildSnapshot(forScope, params, crypto.randomUUID());
      if (!built.ok) {
        baselineRef.current = null;
        setScopeFailure(built.code);
        return;
      }
      setScopeFailure(null);
      baselineRef.current = {
        documentId: built.snapshot.documentId,
        language: built.snapshot.apiRequest.language,
        pathValues: captureSnapshotPathValues(built.snapshot, getValue),
      };
      dispatch({ type: "CONFIGURE", params, snapshot: built.snapshot });
    },
    [buildSnapshot, getValue, invalidateActiveOperation],
  );

  /**
   * Whole-snapshot staleness from render scope (event handlers): the active
   * document and language must still be the snapshot's, and every captured
   * target/reference path must still hold its captured value.
   */
  const isBaselineStale = useCallback((): boolean => {
    const baseline = baselineRef.current;
    if (!baseline) return true;
    if (!documentId || documentId !== baseline.documentId) return true;
    if (language !== baseline.language) return true;
    return isSnapshotStale(baseline.pathValues, getValue);
  }, [documentId, language, getValue]);

  // ── quota & terms fetching ─────────────────────────────────────────

  const refreshQuota = useCallback(async () => {
    const userId = session?.user.id ?? null;
    if (!userId) {
      setQuota(null);
      setQuotaStatus("idle");
      return;
    }
    setQuotaStatus("loading");
    try {
      const response = await client.getQuota();
      // Apply only while still mounted AND still the same account.
      if (!mountedRef.current || sessionUserIdRef.current !== userId) return;
      setQuota(response.quota);
      setQuotaStatus("ready");
    } catch {
      if (!mountedRef.current || sessionUserIdRef.current !== userId) return;
      setQuotaStatus("error");
    }
  }, [client, session]);

  const queryTerms = useCallback(async () => {
    const userId = session?.user.id ?? null;
    if (!userId || !termsGateway) {
      dispatchTerms({ type: "RESET" });
      return;
    }
    dispatchTerms({ type: "QUERY_START" });
    try {
      const accepted = await termsGateway.hasAccepted();
      // A previous account's query must never resolve into the new account's
      // gate (the reducer's QUERY_START no-op while "accepted" is deliberate).
      if (!mountedRef.current || sessionUserIdRef.current !== userId) return;
      dispatchTerms({ type: "QUERY_RESOLVE", accepted });
    } catch {
      if (!mountedRef.current || sessionUserIdRef.current !== userId) return;
      dispatchTerms({ type: "FAIL" });
    }
  }, [session, termsGateway]);

  // ── open / close ───────────────────────────────────────────────────

  const open = useCallback(
    (nextScope: PolishScope) => {
      if (!documentId) return;
      invalidateActiveOperation();
      baselineRef.current = null;
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
    [configure, documentId, invalidateActiveOperation, queryTerms, refreshQuota, state.params],
  );

  const close = useCallback(() => {
    // Every close path invalidates the active operation: the in-flight
    // request aborts, and a terms-acceptance continuation resolving after
    // close finds no token and never sends (relay: no request after
    // cancellation). Even a response that still lands no-ops because RESET
    // cleared the in-flight id.
    invalidateActiveOperation();
    baselineRef.current = null;
    dispatch({ type: "RESET" });
    setIsOpen(false);
    setScope(null);
    setScopeFailure(null);
    setConfigChangedHint(false);
    setStaleItemIds(new Set());
    setReferencesStale(false);
  }, [invalidateActiveOperation]);

  // The snapshot is tied to its document: a document switch also hides the
  // dialog immediately (derived, no effect) while the effect above performs
  // the abort/reset — defense in depth for the same invariant.
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

    // Continuation-scope staleness: the identity refs, not this closure's
    // render-scope props, decide after an await.
    const isBaselineStaleAfterAwait = (): boolean => {
      const baseline = baselineRef.current;
      if (!baseline) return true;
      if (documentIdRef.current !== baseline.documentId) return true;
      if (languageRef.current !== baseline.language) return true;
      return isSnapshotStale(baseline.pathValues, getValue);
    };

    // Pre-flight stale guard: the disclosure must match what will be sent.
    // Content (or document/language) changed underneath → rebuild the
    // disclosure and ask for a re-review instead of silently sending.
    if (isBaselineStale()) {
      if (phase === "error") dispatch({ type: "RERUN" });
      configure(state.params, scope);
      setConfigChangedHint(true);
      return;
    }
    setConfigChangedHint(false);

    // Freeze the reviewed snapshot. Everything sent derives from THIS
    // object; the terms-acceptance await below never re-reads the form.
    const reviewedSnapshot = state.snapshot;
    if (!reviewedSnapshot) return;

    // Claim async ownership of this attempt. open/close/cancel/unmount,
    // account/document changes and disclosure rebuilds replace or clear the
    // token; every continuation below re-verifies ownership after each await.
    const operation: ActivePolishOperation = {
      clientRequestId: null,
      controller: null,
      refreshQuotaOnSettle: false,
    };
    activeOperationRef.current = operation;
    const confirmedByUserId = session.user.id;

    // Progressive consent: write the acceptance BEFORE the polish request.
    if (termsState.status === "required") {
      if (!termsGateway) {
        clearOperationIfOwned(operation);
        return;
      }
      dispatchTerms({ type: "ACCEPT_START" });
      try {
        await termsGateway.accept();
      } catch {
        // The write failed for the user who clicked confirm; only that user
        // may see the failure state.
        if (mountedRef.current && sessionUserIdRef.current === confirmedByUserId) {
          dispatchTerms({ type: "FAIL" });
        }
        clearOperationIfOwned(operation);
        return;
      }
      if (!mountedRef.current) return;
      // The acceptance record is user-scoped, not operation-scoped: the user
      // DID accept, so record it even when this attempt was superseded
      // (no-ops harmlessly after an account change reset the gate).
      if (sessionUserIdRef.current === confirmedByUserId) {
        dispatchTerms({ type: "ACCEPT_RESOLVE" });
      }
      // Ownership + identity: closing, unmounting, switching account or
      // document, or changing level/style/form during acceptance kills the
      // continuation — no request may be sent for a dismissed dialog.
      if (activeOperationRef.current !== operation) return;
      if (sessionUserIdRef.current !== confirmedByUserId) return;
      if (isBaselineStaleAfterAwait()) {
        clearOperationIfOwned(operation);
        if (phase === "error") dispatch({ type: "RERUN" });
        // Never silently rebuild from the live form: refresh the disclosure
        // and hand it back for explicit re-review.
        configure(state.params, scope);
        setConfigChangedHint(true);
        return;
      }
    }

    // Dedup keys are single-use: mint a fresh one for every attempt (retries
    // and reruns included). The request body is the frozen reviewed snapshot
    // with ONLY the clientRequestId swapped — never a live-form rebuild.
    const clientRequestId = crypto.randomUUID();
    const requestSnapshot: PolishSnapshot = {
      ...reviewedSnapshot,
      apiRequest: { ...reviewedSnapshot.apiRequest, clientRequestId },
    };
    operation.clientRequestId = clientRequestId;
    dispatch({
      type: "CONFIRM",
      params: state.params,
      snapshot: requestSnapshot,
      clientRequestId,
    });

    const controller = new AbortController();
    operation.controller = controller;
    // A canceled operation owes the UI exactly one side effect at its
    // settlement point — the quota re-read (fired from HERE, not from
    // abort() time, so it cannot return the pre-request count of a
    // still-settling server-side deduction). Every other late effect dies.
    const settleCanceledOperation = () => {
      if (operation.refreshQuotaOnSettle && mountedRef.current) {
        void refreshQuota();
      }
    };
    try {
      const response = await client.polish(requestSnapshot.apiRequest, {
        signal: controller.signal,
      });
      if (!mountedRef.current) return;
      if (controller.signal.aborted || activeOperationRef.current !== operation) {
        // Superseded while in flight (cancel → re-confirm, close, switch):
        // no reducer/quota/terms effects, even if the response raced the abort.
        settleCanceledOperation();
        return;
      }
      activeOperationRef.current = null;
      setQuota(response.quota);
      setQuotaStatus("ready");
      // Whole-snapshot guard: document/language/targets/sent context drifted
      // while in flight → degrade to SNAPSHOT_STALE instead of applying.
      if (isBaselineStaleAfterAwait()) {
        dispatch({ type: "MARK_SNAPSHOT_STALE" });
      }
      dispatch({
        type: "REQUEST_SUCCESS",
        clientRequestId,
        serverRequestId: response.requestId,
        items: response.items,
      });
    } catch (error) {
      if (
        error instanceof PolishApiError &&
        error.code === POLISH_TRANSPORT_ERROR_CODES.requestAborted
      ) {
        settleCanceledOperation();
        return; // cancel()/close() already moved the reducer on
      }
      if (!mountedRef.current) return;
      if (activeOperationRef.current !== operation) {
        settleCanceledOperation();
        return;
      }
      activeOperationRef.current = null;
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
    clearOperationIfOwned,
    client,
    configure,
    documentId,
    getValue,
    isBaselineStale,
    refreshQuota,
    scope,
    scopeFailure,
    session,
    state.params,
    state.phase,
    state.snapshot,
    termsGateway,
    termsChecked,
    termsState,
  ]);

  const cancel = useCallback(() => {
    if (state.phase !== "loading") return;
    const operation = activeOperationRef.current;
    if (operation) {
      operation.refreshQuotaOnSettle = true;
      operation.controller?.abort();
      activeOperationRef.current = null;
    } else {
      // Loading without an owned operation should not happen; never leave
      // the quota stuck in the stale/loading state if it does.
      void refreshQuota();
    }
    dispatch({ type: "ABORT" });
    // The displayed remaining count is now unreliable: drop it and block
    // confirm until the re-read (fired from the request's settlement point)
    // completes.
    setQuota(null);
    setQuotaStatus("loading");
  }, [refreshQuota, state.phase]);

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
      const snapshot = state.snapshot;
      const plan = planWriteBack(item, next);

      // Snapshot-identity barrier BEFORE any state change: never write first
      // and warn afterward. Accepting AI text requires the active document
      // to be the snapshot's document, the current language to equal the
      // sent request language, and every sent reference path to still hold
      // its captured value. Undoing an accept is exempt from the reference/
      // language legs: restoring the original must stay possible so users
      // can always back out a write-back (the document leg stays — the path
      // now belongs to a different document otherwise).
      const undoAccept = actionType === "UNDO_ACCEPT_ITEM";
      const identityStale =
        !snapshot ||
        !documentId ||
        documentId !== snapshot.documentId ||
        (!undoAccept && language !== snapshot.apiRequest.language);
      const referencesDrifted =
        !undoAccept &&
        isSnapshotStale(
          baselineRef.current?.pathValues ?? {},
          getValue,
          snapshot?.referencePaths ?? [],
        );
      if (identityStale || referencesDrifted) {
        // Block the transition, flag the item, surface the rerun hint.
        setStaleItemIds((previous) => new Set(previous).add(id));
        if (referencesDrifted) setReferencesStale(true);
        return;
      }

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
        isSnapshotStale(
          baselineRef.current?.pathValues ?? {},
          getValue,
          snapshot?.referencePaths ?? [],
        ),
      );
      dispatch({ type: actionType, id });
    },
    [documentId, form, getValue, language, state.items, state.snapshot],
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
    const snapshot = state.snapshot;
    // Batch preflight BEFORE any write: document/language/reference drift
    // blocks the whole batch up front instead of partially applying it and
    // discovering staleness halfway through.
    const referencesDrifted = isSnapshotStale(
      baselineRef.current?.pathValues ?? {},
      getValue,
      snapshot?.referencePaths ?? [],
    );
    if (
      !snapshot ||
      !documentId ||
      documentId !== snapshot.documentId ||
      language !== snapshot.apiRequest.language ||
      referencesDrifted
    ) {
      setStaleItemIds((previous) => {
        const nextSet = new Set(previous);
        for (const item of state.items) {
          if (item.state !== "accepted") nextSet.add(item.id);
        }
        return nextSet;
      });
      if (referencesDrifted) setReferencesStale(true);
      return;
    }
    for (const item of state.items) {
      if (item.state !== "accepted") transitionItem(item.id, "accepted", "ACCEPT_ITEM");
    }
  }, [documentId, getValue, language, state.items, state.snapshot, transitionItem]);

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
    // A quota re-read in flight (initial load, or the post-cancel refresh)
    // means the remaining count is unknown/stale: no confirm until it lands.
    quotaStatus !== "loading" &&
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
