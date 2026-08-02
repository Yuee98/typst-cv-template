/**
 * Pure state machine for the PolishDialog (AI polish review flow).
 *
 * Phases: config -> loading -> preview, or loading -> error.
 *
 * The reducer owns no I/O: the dialog layer builds snapshots via the scope
 * builder, fires the fetch (AbortController), writes accepted values back to
 * the form, and feeds outcomes back as actions. Two honesty guards live here:
 *
 * - Late responses: REQUEST_SUCCESS / REQUEST_FAILURE carry the
 *   clientRequestId they answer; anything not matching the in-flight request
 *   leaves the state untouched (e.g. a response landing after ABORT).
 * - Stale snapshot: the UI dispatches MARK_SNAPSHOT_STALE when form values at
 *   the snapshot's target/reference paths changed underneath (cloud sync).
 *   A success arriving for a stale snapshot degrades to a SNAPSHOT_STALE
 *   error instead of being applied. In preview the flag only drives UI hints;
 *   per-item write-backs stay guarded by `expectedCurrent`.
 */

export type PolishPhase = "config" | "loading" | "preview" | "error";

export type PolishItemStatus = "pending" | "accepted" | "rejected";

export type PolishContextLevel = 0 | 1 | 2;

export type PolishStylePreset =
  | "professional"
  | "concise"
  | "quantified"
  | "management";

export interface PolishParams {
  level: PolishContextLevel;
  stylePreset?: PolishStylePreset;
  styleInstruction?: string;
}

/**
 * One polish target inside a snapshot. `path` is the react-hook-form field
 * path used for local write-back; it must never be sent to the server — only
 * the opaque `id` leaves the client.
 */
export interface PolishTarget {
  id: string;
  path: string;
  text: string;
}

/**
 * Minimal snapshot shape the reducer relies on. The scope builder's full
 * snapshot ({ documentId, targets, apiRequest, disclosure }) extends this;
 * the reducer treats everything beyond documentId/targets as opaque.
 */
export interface PolishSnapshotBase {
  documentId: string;
  targets: PolishTarget[];
}

export interface PolishItem {
  id: string;
  path: string;
  original: string;
  polished: string;
  state: PolishItemStatus;
}

export interface PolishError {
  code: string;
  message?: string;
  resetAt?: string;
  retryAfterSeconds?: number;
}

/**
 * Client-side error codes produced by the reducer itself; server error codes
 * from the API contract pass through verbatim in REQUEST_FAILURE.
 */
export const POLISH_CLIENT_ERROR_CODES = {
  /** The response's snapshot was invalidated by external form changes. */
  snapshotStale: "SNAPSHOT_STALE",
  /** The response item ids do not exactly match the snapshot targets. */
  invalidResponse: "INVALID_RESPONSE",
} as const;

export interface PolishState<
  S extends PolishSnapshotBase = PolishSnapshotBase,
> {
  phase: PolishPhase;
  /** Params of the latest CONFIGURE / CONFIRM. */
  params: PolishParams;
  /** Snapshot the disclosure is rendered from / the request was built from. */
  snapshot: S | null;
  /** Dedup key of the in-flight or last successful request; null in config/error. */
  clientRequestId: string | null;
  /** Server-generated request id for support correlation, when known. */
  serverRequestId: string | null;
  /** Result entries; non-empty only in preview. */
  items: PolishItem[];
  /** True once the UI reported external form changes against this snapshot. */
  snapshotStale: boolean;
  /** Non-null only in the error phase. */
  error: PolishError | null;
}

export type PolishAction<S extends PolishSnapshotBase = PolishSnapshotBase> =
  /** config only: refresh params + a rebuilt snapshot (dialog open, param change). */
  | { type: "CONFIGURE"; params: PolishParams; snapshot: S }
  /**
   * config/error -> loading: adopt the freshly built snapshot and mint a NEW
   * clientRequestId (manual retries must never reuse a consumed dedup key).
   */
  | { type: "CONFIRM"; params: PolishParams; snapshot: S }
  /** loading -> preview; ignored unless clientRequestId matches the in-flight request. */
  | {
      type: "REQUEST_SUCCESS";
      clientRequestId: string;
      serverRequestId?: string;
      items: ReadonlyArray<{ id: string; polished: string }>;
    }
  /** loading -> error; ignored unless clientRequestId matches the in-flight request. */
  | {
      type: "REQUEST_FAILURE";
      clientRequestId: string;
      serverRequestId?: string;
      error: PolishError;
    }
  /** preview: accept one item; the UI writes `polished` back to the form. */
  | { type: "ACCEPT_ITEM"; id: string }
  /** preview: accepted -> pending; the UI reverts the field to `original`. */
  | { type: "UNDO_ACCEPT_ITEM"; id: string }
  /** preview: reject one item; the field keeps/shows `original`. */
  | { type: "REJECT_ITEM"; id: string }
  /** preview: rejected -> pending. */
  | { type: "UNDO_REJECT_ITEM"; id: string }
  /** preview: accept every item. */
  | { type: "ACCEPT_ALL" }
  /** preview: reject every item. */
  | { type: "REJECT_ALL" }
  /**
   * preview/error -> config: drop unaccepted results (accepted write-backs
   * already live in the form, so they survive); the next CONFIRM rebuilds the
   * snapshot from the current form — accepted values included — and mints a
   * new clientRequestId.
   */
  | { type: "RERUN" }
  /** loading -> config: cancel the in-flight request; its late response no-ops. */
  | { type: "ABORT" }
  /** any phase: flag the current snapshot as invalidated by external changes. */
  | { type: "MARK_SNAPSHOT_STALE" }
  /** any phase -> initial config state (dialog closed); params are kept. */
  | { type: "RESET" };

export type PolishReducer<S extends PolishSnapshotBase = PolishSnapshotBase> = (
  state: PolishState<S>,
  action: PolishAction<S>,
) => PolishState<S>;

export interface PolishReducerDeps {
  /** Mints the dedup key for each CONFIRM. Injected for deterministic tests. */
  createClientRequestId?: () => string;
}

/** Default context level per the roadmap (Level 1: siblings + scope metadata). */
export const DEFAULT_POLISH_PARAMS: PolishParams = { level: 1 };

export function createInitialState<
  S extends PolishSnapshotBase = PolishSnapshotBase,
>(params: PolishParams = DEFAULT_POLISH_PARAMS): PolishState<S> {
  return {
    phase: "config",
    params,
    snapshot: null,
    clientRequestId: null,
    serverRequestId: null,
    items: [],
    snapshotStale: false,
    error: null,
  };
}

/**
 * Value the form field at `item.path` is expected to hold in the item's
 * current state: an accepted item was written back with `polished`, anything
 * else still shows `original`. The UI compares getValues(path) against this
 * before every state switch / write-back (state-dependent stale guard).
 */
export function expectedCurrent(
  item: Pick<PolishItem, "state" | "original" | "polished">,
): string {
  return item.state === "accepted" ? item.polished : item.original;
}

export function countItems(
  items: ReadonlyArray<PolishItem>,
): Record<PolishItemStatus, number> {
  let pending = 0;
  let accepted = 0;
  let rejected = 0;
  for (const item of items) {
    if (item.state === "accepted") accepted += 1;
    else if (item.state === "rejected") rejected += 1;
    else pending += 1;
  }
  return { pending, accepted, rejected };
}

export function createPolishReducer<
  S extends PolishSnapshotBase = PolishSnapshotBase,
>(deps: PolishReducerDeps = {}): PolishReducer<S> {
  const createClientRequestId =
    deps.createClientRequestId ?? (() => crypto.randomUUID());

  return function polishReducer(state, action) {
    switch (action.type) {
      case "CONFIGURE": {
        if (state.phase !== "config") return state;
        // A freshly built snapshot reflects the current form: never stale.
        return {
          ...state,
          params: action.params,
          snapshot: action.snapshot,
          snapshotStale: false,
        };
      }

      case "CONFIRM": {
        if (state.phase !== "config" && state.phase !== "error") return state;
        return {
          ...state,
          phase: "loading",
          params: action.params,
          snapshot: action.snapshot,
          clientRequestId: createClientRequestId(),
          serverRequestId: null,
          items: [],
          snapshotStale: false,
          error: null,
        };
      }

      case "REQUEST_SUCCESS": {
        if (
          state.phase !== "loading" ||
          action.clientRequestId !== state.clientRequestId
        ) {
          // Late or duplicate response (e.g. after ABORT): leave state as-is.
          return state;
        }
        if (state.snapshotStale) {
          return toErrorState(
            state,
            { code: POLISH_CLIENT_ERROR_CODES.snapshotStale },
            action.serverRequestId,
          );
        }
        // The model output is untrusted input: the returned ids must exactly
        // match the snapshot targets and every polished text must be non-empty.
        const targets = state.snapshot?.targets ?? [];
        const polishedById = new Map(
          action.items.map((item) => [item.id, item.polished]),
        );
        const exactIdSet =
          targets.length > 0 &&
          targets.length === action.items.length &&
          targets.every((target) => polishedById.has(target.id));
        const items: PolishItem[] = [];
        if (exactIdSet) {
          for (const target of targets) {
            const polished = polishedById.get(target.id);
            if (typeof polished !== "string" || polished.length === 0) break;
            items.push({
              id: target.id,
              path: target.path,
              original: target.text,
              polished,
              state: "pending",
            });
          }
        }
        if (!exactIdSet || items.length !== targets.length) {
          return toErrorState(
            state,
            { code: POLISH_CLIENT_ERROR_CODES.invalidResponse },
            action.serverRequestId,
          );
        }
        return {
          ...state,
          phase: "preview",
          serverRequestId: action.serverRequestId ?? null,
          items,
        };
      }

      case "REQUEST_FAILURE": {
        if (
          state.phase !== "loading" ||
          action.clientRequestId !== state.clientRequestId
        ) {
          return state;
        }
        return toErrorState(state, action.error, action.serverRequestId);
      }

      case "ACCEPT_ITEM":
        return setItemStatus(state, action.id, "accepted");
      case "REJECT_ITEM":
        return setItemStatus(state, action.id, "rejected");
      case "UNDO_ACCEPT_ITEM":
        return setItemStatus(state, action.id, "pending", "accepted");
      case "UNDO_REJECT_ITEM":
        return setItemStatus(state, action.id, "pending", "rejected");
      case "ACCEPT_ALL":
        return setAllItemsStatus(state, "accepted");
      case "REJECT_ALL":
        return setAllItemsStatus(state, "rejected");

      case "RERUN": {
        if (state.phase !== "preview" && state.phase !== "error") return state;
        // Accepted write-backs live in the form and are kept; old unaccepted
        // results are dropped. Params and the old snapshot stay for display
        // until the next CONFIGURE/CONFIRM rebuilds from the current form.
        return {
          ...state,
          phase: "config",
          clientRequestId: null,
          serverRequestId: null,
          items: [],
          error: null,
        };
      }

      case "ABORT": {
        if (state.phase !== "loading") return state;
        // Clearing clientRequestId turns the late response into a no-op.
        return {
          ...state,
          phase: "config",
          clientRequestId: null,
          serverRequestId: null,
          items: [],
          error: null,
        };
      }

      case "MARK_SNAPSHOT_STALE": {
        if (state.snapshotStale) return state;
        return { ...state, snapshotStale: true };
      }

      case "RESET":
        return createInitialState<S>(state.params);
    }
  };
}

function toErrorState<S extends PolishSnapshotBase>(
  state: PolishState<S>,
  error: PolishError,
  serverRequestId?: string,
): PolishState<S> {
  return {
    ...state,
    phase: "error",
    clientRequestId: null,
    serverRequestId: serverRequestId ?? null,
    items: [],
    snapshotStale: false,
    error,
  };
}

function setItemStatus<S extends PolishSnapshotBase>(
  state: PolishState<S>,
  id: string,
  next: PolishItemStatus,
  requiredPrevious?: PolishItemStatus,
): PolishState<S> {
  if (state.phase !== "preview") return state;
  let changed = false;
  const items = state.items.map((item) => {
    if (item.id !== id || item.state === next) return item;
    if (requiredPrevious !== undefined && item.state !== requiredPrevious) {
      return item;
    }
    changed = true;
    return { ...item, state: next };
  });
  return changed ? { ...state, items } : state;
}

function setAllItemsStatus<S extends PolishSnapshotBase>(
  state: PolishState<S>,
  next: PolishItemStatus,
): PolishState<S> {
  if (state.phase !== "preview") return state;
  if (state.items.every((item) => item.state === next)) return state;
  return {
    ...state,
    items: state.items.map((item) =>
      item.state === next ? item : { ...item, state: next },
    ),
  };
}
