import type {
  PolishAvailability,
  PolishExpectedRoute,
  PolishLanguage,
} from "@/lib/polish/contract";

import type { SnapshotPathValues } from "./stale-guard";

/**
 * Mutable ownership record for one confirm attempt.  The coordinator owns
 * publication/invalidation of this record; async task modules only inspect
 * it and never replace the active token themselves.
 */
export interface ActivePolishOperation {
  /** Immutable owner: the account that clicked confirm. */
  userId: string;
  /** Immutable owner: the document the reviewed snapshot belongs to. */
  documentId: string;
  /** Immutable owner: the request language at confirm time. */
  language: PolishLanguage;
  /** Enabled availability publication reviewed for this exact attempt. */
  availabilityGeneration: number;
  /** Compare-only route assertion frozen before any acceptance await. */
  expectedRoute: PolishExpectedRoute;
  /** Dedup key minted at CONFIRM time; null during terms acceptance. */
  clientRequestId: string | null;
  /** In-flight request controller; null until the request fires. */
  controller: AbortController | null;
  /**
   * cancel() marks the operation so its settlement point (the catch branch)
   * re-reads quota — the server may still be settling the canceled request.
   */
  refreshQuotaOnSettle: boolean;
}

/** One authenticated availability read and its exact async owner. */
export interface ActiveAvailabilityRead {
  /** Immutable account key captured before the request starts. */
  userId: string;
  /** Monotonic read generation; older same-account reads cannot publish. */
  generation: number;
  /** Closing, switching identity or refreshing aborts this exact read. */
  controller: AbortController;
}

export type PolishAvailabilityCandidate = Extract<PolishAvailability, { enabled: true }>;
export type PolishAvailabilityStatus = "idle" | "loading" | "ready" | "disabled" | "error";

export interface PublishedAvailabilityCandidate {
  generation: number;
  candidate: PolishAvailabilityCandidate;
}

/**
 * Everything a snapshot's validity depends on beyond its path values: the
 * document it was built from and the request language.
 */
export interface SnapshotBaseline {
  documentId: string;
  language: PolishLanguage;
  pathValues: SnapshotPathValues;
}

/** Sentinel used while a cancellation's settlement read has not started. */
export const SETTLEMENT_UNRESOLVED = Number.MAX_SAFE_INTEGER;

export function isOperationOwned(
  activeOperation: ActivePolishOperation | null,
  operation: ActivePolishOperation,
): boolean {
  return activeOperation === operation;
}

export function belongsToOwner(
  currentUserId: string | null,
  operation: Pick<ActivePolishOperation, "userId">,
): boolean {
  return currentUserId === operation.userId;
}
