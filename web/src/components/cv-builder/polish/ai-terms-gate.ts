/**
 * AI terms gate for the polish dialog (roadmap「首次使用知情同意（渐进式）」).
 *
 * Pure state machine, mirroring the dialog flow:
 *
 * - unknown → checking → accepted | required | error
 * - required → accepting → accepted | error (confirm writes the acceptance
 *   record BEFORE the polish request is fired)
 * - any state → required (serverRejected) when the server answers 403
 *   AI_TERMS_REQUIRED despite the local view — the checkbox reappears in red
 *
 * The checkbox's local "checked" boolean is plain UI state and deliberately
 * NOT part of this machine; the dialog combines it with `status` to enable
 * the confirm button: accepted, or required+checked.
 */

export type AiTermsStatus =
  /** Not queried yet (dialog just opened, or signed out). */
  | "unknown"
  /** Acceptance query in flight. */
  | "checking"
  /** Not accepted — the checkbox gates the confirm button. */
  | "required"
  /** Acceptance write in flight (confirm is blocked meanwhile). */
  | "accepting"
  /** Accepted — no checkbox, confirm allowed. */
  | "accepted"
  /** Query or acceptance write failed; retry offered. */
  | "error";

export interface AiTermsGateState {
  status: AiTermsStatus;
  /**
   * True after the server answered 403 AI_TERMS_REQUIRED: the checkbox is
   * re-shown in its error styling even if the local state had said accepted.
   */
  serverRejected: boolean;
}

export type AiTermsGateAction =
  | { type: "QUERY_START" }
  | { type: "QUERY_RESOLVE"; accepted: boolean }
  | { type: "ACCEPT_START" }
  | { type: "ACCEPT_RESOLVE" }
  | { type: "FAIL" }
  | { type: "SERVER_REJECTED" }
  | { type: "RESET" };

export function createInitialAiTermsGateState(): AiTermsGateState {
  return { status: "unknown", serverRejected: false };
}

export function aiTermsGateReducer(
  state: AiTermsGateState,
  action: AiTermsGateAction,
): AiTermsGateState {
  switch (action.type) {
    case "QUERY_START": {
      if (state.status !== "unknown" && state.status !== "error" && state.status !== "required") {
        return state;
      }
      return { status: "checking", serverRejected: false };
    }
    case "QUERY_RESOLVE": {
      if (state.status !== "checking") return state;
      return { status: action.accepted ? "accepted" : "required", serverRejected: false };
    }
    case "ACCEPT_START": {
      if (state.status !== "required") return state;
      return { status: "accepting", serverRejected: false };
    }
    case "ACCEPT_RESOLVE": {
      if (state.status !== "accepting") return state;
      return { status: "accepted", serverRejected: false };
    }
    case "FAIL": {
      if (state.status !== "checking" && state.status !== "accepting") return state;
      return { status: "error", serverRejected: false };
    }
    case "SERVER_REJECTED": {
      if (state.serverRejected && state.status === "required") return state;
      return { status: "required", serverRejected: true };
    }
    case "RESET":
      return createInitialAiTermsGateState();
  }
}

/** Whether the confirm button may proceed without writing an acceptance. */
export function aiTermsAllowConfirm(state: AiTermsGateState, checked: boolean): boolean {
  if (state.status === "accepted") return true;
  return state.status === "required" && checked;
}
