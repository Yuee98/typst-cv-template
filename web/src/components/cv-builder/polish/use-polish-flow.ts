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
 * - runtime availability fetch on dialog open / explicit retry, with no
 *   render-time or static-mode request,
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
 * attempt's immutable owner identity (userId + documentId + language), its
 * clientRequestId, its AbortController and cancel settlement flags.
 * open/close/cancel/unmount/account change/document change and any
 * disclosure rebuild REPLACE or clear the token, which kills every pending
 * continuation: after each await the continuation verifies it still owns the
 * token (object identity) AND still belongs to the current owner before
 * dispatching or touching quota/terms state, and clears the controller only
 * while it is still the owner. A canceled operation's late settle therefore
 * never disturbs a newer request.
 *
 * Commit-synchronous invalidation: identity refs are published and
 * superseded operations are invalidated inside a (isomorphic) layout effect
 * — a passive effect would leave a post-commit window in which a resolving
 * acceptance/request continuation still sees the OLD account or document
 * and an owned operation (relay round 2). The mounted flag and the unmount
 * invalidation use a layout-effect cleanup for the same reason: it runs
 * BEFORE the host is removed, not after (relay round 4). Terms
 * queries/acceptances and quota reads additionally carry generation
 * counters so a superseded same-account continuation can never overwrite a
 * newer one.
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
 * Loading-stage dismissal (footer cancel AND X/Escape/overlay close) shares
 * one settlement semantics: the displayed quota is discarded, confirm stays
 * blocked (settlementPending) until the canceled request's settle-point
 * quota re-read — or any read started after it — completes.
 *
 * All request/response content stays inside the dialog: the hook returns
 * state and intents only, no editor coupling beyond the RHF instance.
 *
 * Ref discipline: only genuinely mutable non-render state lives in refs (the
 * active operation token, the snapshot baseline, identity snapshots for
 * async continuations, generation counters, the mounted flag); identity refs
 * are written only inside the layout effect, never during render
 * (react-hooks/refs).
 */

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
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
import {
  assessPreviewTransition,
  hasIdentityStaleTransition,
} from "./polish-flow-preview";
import {
  runPolishRequest,
  toPolishError,
} from "./polish-flow-request";
import {
  SETTLEMENT_UNRESOLVED,
  type ActiveAvailabilityRead,
  type ActivePolishOperation,
  type PolishAvailabilityCandidate,
  type PolishAvailabilityStatus,
  type SnapshotBaseline,
} from "./polish-flow-types";
import {
  createInitialState,
  polishReducer,
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
  /** Current DB-authoritative enabled route candidate; never a user selector. */
  availabilityCandidate: PolishAvailabilityCandidate | null;
  availabilityStatus: PolishAvailabilityStatus;
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
  /** Config phase: discard any old candidate and fetch a fresh one. */
  availabilityRetry: () => void;
}

/**
 * CvBuilder is prerendered for the static export: bare useLayoutEffect would
 * warn on the server, so fall back to useEffect there. Commit-race safety
 * only matters in the browser, where this IS useLayoutEffect.
 */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

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
  const [availabilityCandidate, setAvailabilityCandidate] =
    useState<PolishAvailabilityCandidate | null>(null);
  const [availabilityStatus, setAvailabilityStatus] =
    useState<PolishAvailabilityStatus>("idle");
  const [termsState, dispatchTerms] = useReducer(
    aiTermsGateReducer,
    undefined,
    createInitialAiTermsGateState,
  );
  const [termsChecked, setTermsChecked] = useState(false);
  const [configChangedHint, setConfigChangedHint] = useState(false);
  const [staleItemIds, setStaleItemIds] = useState<ReadonlySet<string>>(() => new Set());
  const [referencesStale, setReferencesStale] = useState(false);
  /**
   * A canceled request's server-side settlement is still owed: confirm stays
   * blocked until the settle-point quota re-read (or a read started after
   * it) completes — even across a dialog reopen.
   */
  const [settlementPending, setSettlementPending] = useState(false);

  // Mutable non-render state only.
  const activeOperationRef = useRef<ActivePolishOperation | null>(null);
  const activeAvailabilityReadRef = useRef<ActiveAvailabilityRead | null>(null);
  const baselineRef = useRef<SnapshotBaseline | null>(null);
  const mountedRef = useRef(true);
  // Identity snapshots for async continuations (event handlers read the
  // render-scope props directly; continuations must not trust stale closures).
  const documentIdRef = useRef(documentId);
  const languageRef = useRef(language);
  const sessionUserIdRef = useRef(session?.user.id ?? null);
  // Generation counters: a superseded same-account terms/quota continuation
  // must never overwrite a newer one.
  const termsGenerationRef = useRef(0);
  const quotaGenerationRef = useRef(0);
  const availabilityGenerationRef = useRef(0);
  // Generation of the cancellation settle-point quota read; only reads with
  // generation >= this value may lift settlementPending.
  const settleGenerationRef = useRef(0);

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

  /** Revoke one availability read before any late continuation can publish. */
  const invalidateAvailabilityRead = useCallback(() => {
    availabilityGenerationRef.current += 1;
    const read = activeAvailabilityReadRef.current;
    if (!read) return;
    read.controller.abort();
    activeAvailabilityReadRef.current = null;
  }, []);

  /** Clear the token only when the caller still owns it (relay: never let a
   * late operation clear a newer one's controller). */
  const clearOperationIfOwned = useCallback((operation: ActivePolishOperation) => {
    if (activeOperationRef.current === operation) {
      activeOperationRef.current = null;
    }
  }, []);

  /**
   * Reset the terms gate to "unknown" and invalidate every in-flight terms
   * continuation (query or acceptance) by bumping the generation. Used when
   * the account changes, when an "accepting" operation is invalidated
   * (close, document switch, param change) and defensively on open —
   * QUERY_START intentionally no-ops while "accepting", so without this a
   * superseded acceptance would lock the gate until it settles.
   */
  const resetTermsGate = useCallback(() => {
    termsGenerationRef.current += 1;
    dispatchTerms({ type: "RESET" });
    setTermsChecked(false);
  }, []);

  // Commit-synchronous unmount invalidation (relay round 4): a passive
  // cleanup would leave a removal→passive window in which a resolving
  // acceptance/response still sees mountedRef true and an owned operation —
  // the layout-effect cleanup runs BEFORE the host is removed, closing the
  // window the same way the identity publication above does for switches.
  useIsomorphicLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Kill every pending terms/quota/availability continuation along with
      // the operation.
      termsGenerationRef.current += 1;
      quotaGenerationRef.current += 1;
      invalidateAvailabilityRead();
      invalidateActiveOperation();
    };
  }, [invalidateActiveOperation, invalidateAvailabilityRead]);

  // Commit-synchronous identity publication + invalidation (relay round 2):
  // a passive effect would leave a post-commit window in which a resolving
  // acceptance/request continuation still sees the OLD account or document
  // and an owned operation. Publishing identity and killing superseded work
  // here closes that window. This layout effect is the ONLY writer of the
  // identity refs — they hold the previously published values on entry.
  useIsomorphicLayoutEffect(() => {
    const accountChanged = sessionUserIdRef.current !== sessionUserId;
    const documentChanged = documentIdRef.current !== documentId;
    sessionUserIdRef.current = sessionUserId;
    documentIdRef.current = documentId;
    languageRef.current = language;
    if (!accountChanged && !documentChanged) return;

    // Account or document switch underneath the hook: the terms gate and
    // quota are user-scoped and the snapshot is tied to its document, so
    // everything derived from the previous identity is invalidated —
    // in-flight work aborts, the dialog closes and the next open re-queries
    // terms + quota for the NEW identity.
    const operation = activeOperationRef.current;
    if (operation?.controller) {
      // An in-flight request is being invalidated: it owes the UI the same
      // settlement quota refresh cancel()/close() would schedule.
      operation.refreshQuotaOnSettle = true;
      if (!accountChanged) {
        // The account reset below already discards quota/pending; a document
        // switch keeps the account, so block confirm explicitly until the
        // settle-point re-read lands.
        setSettlementPending(true);
        settleGenerationRef.current = SETTLEMENT_UNRESOLVED;
        setQuota(null);
        setQuotaStatus("loading");
      }
    }
    invalidateActiveOperation();
    invalidateAvailabilityRead();
    baselineRef.current = null;
    setAvailabilityCandidate(null);
    setAvailabilityStatus("idle");

    if (accountChanged) {
      resetTermsGate();
      setQuota(null);
      setQuotaStatus("idle");
      setSettlementPending(false);
      settleGenerationRef.current = 0;
    } else if (termsState.status === "accepting") {
      // The acceptance write belongs to the previous dialog; unlock the gate
      // so the next open can own a fresh query.
      resetTermsGate();
    }
    dispatch({ type: "RESET" });
    setIsOpen(false);
    setScope(null);
    setScopeFailure(null);
    setConfigChangedHint(false);
    setStaleItemIds(new Set());
    setReferencesStale(false);
  }, [
    sessionUserId,
    documentId,
    language,
    termsState.status,
    invalidateActiveOperation,
    invalidateAvailabilityRead,
    resetTermsGate,
  ]);

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

  const refreshQuota = useCallback(
    async (options?: { settleCancellation?: boolean }) => {
      const userId = session?.user.id ?? null;
      if (!userId) {
        setQuota(null);
        setQuotaStatus("idle");
        return;
      }
      // A stale closure (the account changed after this callback rendered —
      // e.g. a canceled operation's settle point firing under the NEW
      // account) must not touch the new account's quota state: verify the
      // account BEFORE setting "loading" or issuing the request.
      if (sessionUserIdRef.current !== userId) return;
      const generation = ++quotaGenerationRef.current;
      if (options?.settleCancellation) {
        // Only reads started at or after this settlement point may lift the
        // settlement-pending confirm block.
        settleGenerationRef.current = generation;
      }
      setQuotaStatus("loading");
      const applyCompletion = () => {
        if (options?.settleCancellation || generation >= settleGenerationRef.current) {
          setSettlementPending(false);
        }
      };
      try {
        const response = await client.getQuota();
        // Apply only while still mounted, still the same account AND still
        // the newest read — an older same-account read resolving late must
        // not overwrite a newer one.
        if (!mountedRef.current || sessionUserIdRef.current !== userId) return;
        if (quotaGenerationRef.current !== generation) return;
        setQuota(response.quota);
        setQuotaStatus("ready");
        applyCompletion();
      } catch {
        if (!mountedRef.current || sessionUserIdRef.current !== userId) return;
        if (quotaGenerationRef.current !== generation) return;
        setQuotaStatus("error");
        applyCompletion();
      }
    },
    [client, session],
  );

  const queryTerms = useCallback(async () => {
    const userId = session?.user.id ?? null;
    if (!userId || !termsGateway) {
      resetTermsGate();
      return;
    }
    const generation = ++termsGenerationRef.current;
    dispatchTerms({ type: "QUERY_START" });
    try {
      const accepted = await termsGateway.hasAccepted();
      // A previous account's query must never resolve into the new account's
      // gate (the reducer's QUERY_START no-op while "accepted" is deliberate);
      // a superseded same-account query must not overwrite a newer one.
      if (!mountedRef.current || sessionUserIdRef.current !== userId) return;
      if (termsGenerationRef.current !== generation) return;
      dispatchTerms({ type: "QUERY_RESOLVE", accepted });
    } catch {
      if (!mountedRef.current || sessionUserIdRef.current !== userId) return;
      if (termsGenerationRef.current !== generation) return;
      dispatchTerms({ type: "FAIL" });
    }
  }, [session, termsGateway, resetTermsGate]);

  const refreshAvailability = useCallback(
    async (refreshOptions?: { opening?: boolean }) => {
      // Public retries are valid only for the currently open dialog. open()
      // passes an explicit event token because setIsOpen(true) has not
      // committed when the initial request is started.
      if (!refreshOptions?.opening && !isOpen) return;

      invalidateAvailabilityRead();
      setAvailabilityCandidate(null);

      const userId = session?.user.id ?? null;
      if (!userId || sessionUserIdRef.current !== userId) {
        setAvailabilityStatus("idle");
        return;
      }

      const generation = ++availabilityGenerationRef.current;
      const controller = new AbortController();
      const read: ActiveAvailabilityRead = { userId, generation, controller };
      activeAvailabilityReadRef.current = read;
      setAvailabilityStatus("loading");

      try {
        const response = await client.getAvailability({ signal: controller.signal });
        if (!mountedRef.current) return;
        if (activeAvailabilityReadRef.current !== read) return;
        if (sessionUserIdRef.current !== read.userId) return;
        if (availabilityGenerationRef.current !== read.generation) return;

        if (response.availability.enabled) {
          setAvailabilityCandidate(response.availability);
          setAvailabilityStatus("ready");
        } else {
          setAvailabilityCandidate(null);
          setAvailabilityStatus("disabled");
        }
      } catch {
        if (!mountedRef.current) return;
        if (activeAvailabilityReadRef.current !== read) return;
        if (sessionUserIdRef.current !== read.userId) return;
        if (availabilityGenerationRef.current !== read.generation) return;
        setAvailabilityCandidate(null);
        setAvailabilityStatus("error");
      } finally {
        if (activeAvailabilityReadRef.current === read) {
          activeAvailabilityReadRef.current = null;
        }
      }
    },
    [client, invalidateAvailabilityRead, isOpen, session],
  );

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
      if (termsState.status === "accepting") {
        // Defensive: an acceptance write still in flight from a previous
        // dialog holds the gate locked (QUERY_START no-ops while
        // "accepting"); reset so the fresh query below can own it.
        resetTermsGate();
      }
      dispatch({ type: "RESET" });
      // RESET keeps the params; the CONFIGURE below is batched after it and
      // lands on the fresh initial (config) state.
      configure(state.params, nextScope);
      void refreshQuota();
      void queryTerms();
      void refreshAvailability({ opening: true });
    },
    [
      configure,
      documentId,
      invalidateActiveOperation,
      queryTerms,
      refreshAvailability,
      refreshQuota,
      resetTermsGate,
      state.params,
      termsState.status,
    ],
  );

  const close = useCallback(() => {
    const operation = activeOperationRef.current;
    if (state.phase === "loading" && operation?.controller) {
      // X/Escape/overlay share the footer cancel's settlement semantics
      // (relay round 2): the server may still be settling the aborted
      // request, so the displayed count is unreliable until the settle-point
      // re-read — fired from the request's settlement, not from here —
      // completes, even across a reopen.
      operation.refreshQuotaOnSettle = true;
      setSettlementPending(true);
      settleGenerationRef.current = SETTLEMENT_UNRESOLVED;
      setQuota(null);
      setQuotaStatus("loading");
    }
    if (termsState.status === "accepting") {
      // Unlock the gate: the in-flight acceptance is invalidated below, and
      // its late continuation must not move a reopened dialog.
      resetTermsGate();
    }
    // Every close path invalidates the active operation: the in-flight
    // request aborts, and a terms-acceptance continuation resolving after
    // close finds no token and never sends (relay: no request after
    // cancellation). Even a response that still lands no-ops because RESET
    // cleared the in-flight id.
    invalidateActiveOperation();
    invalidateAvailabilityRead();
    baselineRef.current = null;
    dispatch({ type: "RESET" });
    setIsOpen(false);
    setScope(null);
    setScopeFailure(null);
    setConfigChangedHint(false);
    setStaleItemIds(new Set());
    setReferencesStale(false);
    setAvailabilityCandidate(null);
    setAvailabilityStatus("idle");
  }, [
    invalidateActiveOperation,
    invalidateAvailabilityRead,
    resetTermsGate,
    state.phase,
    termsState.status,
  ]);

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
      if (termsState.status === "accepting") {
        // The param change invalidates the in-flight acceptance (configure
        // below); unlock the gate and immediately re-query so the dialog is
        // not stuck in "accepting" until the old write settles.
        resetTermsGate();
        configure(params, scope);
        void queryTerms();
        return;
      }
      configure(params, scope);
    },
    [configure, queryTerms, resetTermsGate, scope, state.phase, termsState.status],
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
    if (availabilityStatus !== "ready" || availabilityCandidate === null) return;
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
      userId: session.user.id,
      documentId,
      language,
      clientRequestId: null,
      controller: null,
      refreshQuotaOnSettle: false,
    };
    activeOperationRef.current = operation;

    // Progressive consent: write the acceptance BEFORE the polish request.
    if (termsState.status === "required") {
      if (!termsGateway) {
        clearOperationIfOwned(operation);
        return;
      }
      const termsGeneration = ++termsGenerationRef.current;
      dispatchTerms({ type: "ACCEPT_START" });
      try {
        await termsGateway.accept();
      } catch {
        // The write failed: report the failure only while this attempt still
        // owns the continuation for the same account — a superseded failure
        // must not move a newer dialog's gate (relay round 2).
        if (
          mountedRef.current &&
          activeOperationRef.current === operation &&
          sessionUserIdRef.current === operation.userId
        ) {
          dispatchTerms({ type: "FAIL" });
        }
        clearOperationIfOwned(operation);
        return;
      }
      if (!mountedRef.current) return;
      // The acceptance record is user-scoped, not operation-scoped: the user
      // DID accept, so record it even when this attempt was superseded — but
      // never overwrite a newer query/acceptance (generation-scoped).
      if (
        sessionUserIdRef.current === operation.userId &&
        termsGenerationRef.current === termsGeneration
      ) {
        dispatchTerms({ type: "ACCEPT_RESOLVE" });
      }
      // Ownership + owner identity: closing, unmounting, switching account
      // or document, or changing level/style/form during acceptance kills
      // the continuation — no request may be sent for a dismissed dialog.
      if (activeOperationRef.current !== operation) return;
      if (sessionUserIdRef.current !== operation.userId) return;
      if (documentIdRef.current !== operation.documentId) return;
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
    await runPolishRequest({
      operation,
      requestSnapshot,
      controller,
      client,
      isMounted: () => mountedRef.current,
      activeOperation: () => activeOperationRef.current,
      currentUserId: () => sessionUserIdRef.current,
      clearOperationIfOwned,
      isBaselineStaleAfterAwait,
      refreshQuotaOnSettle: () => void refreshQuota({ settleCancellation: true }),
      onSuccess: (response, snapshotStale) => {
        setQuota(response.quota);
        setQuotaStatus("ready");
        if (snapshotStale) {
          dispatch({ type: "MARK_SNAPSHOT_STALE" });
        }
        dispatch({
          type: "REQUEST_SUCCESS",
          clientRequestId,
          serverRequestId: response.requestId,
          items: response.items,
        });
      },
      onTermsRequired: () => {
        // Local view said accepted but the server disagrees: back to config
        // with the checkbox re-shown in red — never the generic error phase.
        dispatchTerms({ type: "SERVER_REJECTED" });
        dispatch({ type: "ABORT" });
      },
      onFailure: (error) => {
        dispatch({
          type: "REQUEST_FAILURE",
          clientRequestId,
          serverRequestId: error instanceof PolishApiError ? error.requestId : undefined,
          error: toPolishError(error),
        });
      },
    });
  }, [
    clearOperationIfOwned,
    client,
    configure,
    documentId,
    getValue,
    isBaselineStale,
    language,
    availabilityCandidate,
    availabilityStatus,
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
      // Loading without an owned operation should not happen; settle the
      // quota display immediately instead of waiting for a settlement point.
      void refreshQuota({ settleCancellation: true });
    }
    dispatch({ type: "ABORT" });
    // The displayed remaining count is now unreliable: drop it and block
    // confirm until the re-read (fired from the request's settlement point)
    // completes.
    setQuota(null);
    setQuotaStatus("loading");
    setSettlementPending(true);
    settleGenerationRef.current = SETTLEMENT_UNRESOLVED;
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
      const assessment = assessPreviewTransition({
        item,
        next,
        snapshot,
        documentId,
        language,
        baselinePathValues: baselineRef.current?.pathValues ?? {},
        getValue,
      });

      // Barriers match the transition's actual effect (relay round 2):
      // - INTO accepted (writes AI text): document + language + references +
      //   expectedCurrent, all BEFORE any state change — never write first
      //   and warn afterward;
      // - AWAY from accepted (restores the original): document +
      //   expectedCurrent only — reference/language drift is irrelevant to a
      //   restore, and backing out a write-back must always stay possible;
      // - no-write transitions (pending ↔ rejected): reducer transition
      //   only, no barrier — they never touch the editor.
      if (assessment.needsIdentityGuard) {
        if (hasIdentityStaleTransition(assessment)) {
          // Block the transition, flag the item, surface the rerun hint.
          setStaleItemIds((previous) => new Set(previous).add(id));
          if (assessment.referencesDrifted) setReferencesStale(true);
          return;
        }
        form.setValue(item.path as FieldPath<CvData>, assessment.plan.value, {
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
    // Validate EVERY target before the first write (relay round 2): one
    // stale candidate blocks the whole batch — no partial application.
    // Already-accepted items are validated too: if their live field no
    // longer equals the polished value, reducer state and form state have
    // diverged and "Accept All" cannot truthfully report a full batch.
    const candidates = state.items.map((item) => ({
      item,
      plan: planWriteBack(item, "accepted"),
    }));
    const stale = candidates.filter(
      ({ item, plan }) => !checkWriteBack(plan, getValue(item.path)).ok,
    );
    if (stale.length > 0) {
      setStaleItemIds((previous) => {
        const nextSet = new Set(previous);
        for (const { item } of stale) nextSet.add(item.id);
        return nextSet;
      });
      return;
    }
    for (const { item } of candidates) {
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

  const availabilityRetry = useCallback(() => {
    void refreshAvailability();
  }, [refreshAvailability]);

  // ── derived ────────────────────────────────────────────────────────

  const signedIn = Boolean(session);
  const canConfirm =
    state.phase === "config" &&
    scopeFailure === null &&
    state.snapshot !== null &&
    signedIn &&
    availabilityStatus === "ready" &&
    availabilityCandidate !== null &&
    // A quota re-read in flight (initial load, or the post-cancel refresh)
    // means the remaining count is unknown/stale: no confirm until it lands.
    quotaStatus !== "loading" &&
    // A canceled request's settlement re-read has not completed yet — the
    // server-side deduction may still be in flight, so confirm stays blocked
    // even if an ordinary (pre-settlement) read already landed.
    !settlementPending &&
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
    availabilityCandidate,
    availabilityStatus,
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
    availabilityRetry,
  };
}
