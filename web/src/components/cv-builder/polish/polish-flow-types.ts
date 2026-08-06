import type { PolishLanguage } from "@/lib/polish/contract";

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
