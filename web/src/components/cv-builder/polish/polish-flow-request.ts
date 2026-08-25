import type { PolishPostRequest, PolishSuccessResponse } from "@/lib/polish/contract";

import {
  PolishApiError,
  type PolishApiClient,
} from "./polish-client";
import { POLISH_TRANSPORT_ERROR_CODES } from "./polish-errors";
import type { PolishError } from "./polish-reducer";
import {
  belongsToOwner,
  isOperationOwned,
  type ActivePolishOperation,
} from "./polish-flow-types";

/**
 * Inputs owned by the coordinator for one frozen request attempt.  The
 * extracted task runner never publishes identity or replaces the token; it
 * only checks those commit-synchronous barriers before handing outcomes back
 * to the reducer coordinator.
 */
export interface PolishRequestLifecycleContext {
  operation: ActivePolishOperation;
  postRequest: PolishPostRequest;
  controller: AbortController;
  client: PolishApiClient;
  isMounted: () => boolean;
  activeOperation: () => ActivePolishOperation | null;
  currentUserId: () => string | null;
  clearOperationIfOwned: (operation: ActivePolishOperation) => void;
  isBaselineStaleAfterAwait: () => boolean;
  refreshQuotaOnSettle: () => void;
  onSuccess: (response: PolishSuccessResponse, snapshotStale: boolean) => void;
  onTermsRequired: () => void;
  onRouteChanged: () => void;
  onFailure: (error: unknown) => void;
}

/**
 * Run the request half of a confirm attempt.  Terms acceptance stays in the
 * coordinator because it owns the pre-request snapshot/identity barrier;
 * this module owns only request settlement and its late-result guard.
 */
export async function runPolishRequest(
  context: PolishRequestLifecycleContext,
): Promise<void> {
  const {
    operation,
    postRequest,
    controller,
    client,
  } = context;

  const settleCanceledOperation = () => {
    if (
      operation.refreshQuotaOnSettle &&
      context.isMounted() &&
      belongsToOwner(context.currentUserId(), operation)
    ) {
      context.refreshQuotaOnSettle();
    }
  };

  try {
    const response = await client.polish(postRequest, {
      signal: controller.signal,
    });
    if (!context.isMounted()) return;
    if (
      controller.signal.aborted ||
      !isOperationOwned(context.activeOperation(), operation)
    ) {
      // Superseded while in flight (cancel → re-confirm, close, switch): no
      // reducer/quota/terms effects, even when the response raced the abort.
      settleCanceledOperation();
      return;
    }
    context.clearOperationIfOwned(operation);
    context.onSuccess(response, context.isBaselineStaleAfterAwait());
  } catch (error) {
    if (
      error instanceof PolishApiError &&
      error.code === POLISH_TRANSPORT_ERROR_CODES.requestAborted
    ) {
      settleCanceledOperation();
      return; // cancel()/close() already moved the reducer on
    }
    if (!context.isMounted()) return;
    if (!isOperationOwned(context.activeOperation(), operation)) {
      settleCanceledOperation();
      return;
    }
    context.clearOperationIfOwned(operation);
    if (error instanceof PolishApiError && error.code === "AI_TERMS_REQUIRED") {
      context.onTermsRequired();
      return;
    }
    if (error instanceof PolishApiError && error.code === "AI_ROUTE_CHANGED") {
      context.onRouteChanged();
      return;
    }
    context.onFailure(error);
  }
}

export function toPolishError(error: unknown): PolishError {
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
