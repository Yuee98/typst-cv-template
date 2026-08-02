import { describe, expect, it } from "vitest";

import {
  aiTermsAllowConfirm,
  aiTermsGateReducer,
  createInitialAiTermsGateState,
  type AiTermsGateState,
} from "./ai-terms-gate";

const initial = createInitialAiTermsGateState();

function inStatus(status: AiTermsGateState["status"]): AiTermsGateState {
  return { status, serverRejected: false };
}

describe("query flow", () => {
  it("starts unknown and moves to checking on QUERY_START", () => {
    expect(initial).toEqual({ status: "unknown", serverRejected: false });
    expect(aiTermsGateReducer(initial, { type: "QUERY_START" })).toEqual({
      status: "checking",
      serverRejected: false,
    });
  });

  it("resolves to accepted or required", () => {
    const checking = aiTermsGateReducer(initial, { type: "QUERY_START" });
    expect(aiTermsGateReducer(checking, { type: "QUERY_RESOLVE", accepted: true }).status).toBe(
      "accepted",
    );
    expect(aiTermsGateReducer(checking, { type: "QUERY_RESOLVE", accepted: false }).status).toBe(
      "required",
    );
  });

  it("can re-query from error and required, but not while accepted/accepting", () => {
    expect(aiTermsGateReducer(inStatus("error"), { type: "QUERY_START" }).status).toBe(
      "checking",
    );
    expect(aiTermsGateReducer(inStatus("required"), { type: "QUERY_START" }).status).toBe(
      "checking",
    );
    const accepted = inStatus("accepted");
    expect(aiTermsGateReducer(accepted, { type: "QUERY_START" })).toBe(accepted);
    const accepting = inStatus("accepting");
    expect(aiTermsGateReducer(accepting, { type: "QUERY_START" })).toBe(accepting);
  });

  it("FAIL only applies while checking or accepting", () => {
    const checking = aiTermsGateReducer(initial, { type: "QUERY_START" });
    expect(aiTermsGateReducer(checking, { type: "FAIL" }).status).toBe("error");
    expect(aiTermsGateReducer(inStatus("unknown"), { type: "FAIL" })).toEqual(inStatus("unknown"));
  });
});

describe("accept flow", () => {
  it("required → accepting → accepted", () => {
    const required = inStatus("required");
    const accepting = aiTermsGateReducer(required, { type: "ACCEPT_START" });
    expect(accepting).toEqual({ status: "accepting", serverRejected: false });
    expect(aiTermsGateReducer(accepting, { type: "ACCEPT_RESOLVE" })).toEqual({
      status: "accepted",
      serverRejected: false,
    });
  });

  it("acceptance write failure lands in error", () => {
    const accepting = inStatus("accepting");
    expect(aiTermsGateReducer(accepting, { type: "FAIL" }).status).toBe("error");
  });

  it("ACCEPT_START only fires from required", () => {
    const accepted = inStatus("accepted");
    expect(aiTermsGateReducer(accepted, { type: "ACCEPT_START" })).toBe(accepted);
  });
});

describe("SERVER_REJECTED (403 AI_TERMS_REQUIRED)", () => {
  it("forces back to required with the red-checkbox flag even when locally accepted", () => {
    const accepted = inStatus("accepted");
    expect(aiTermsGateReducer(accepted, { type: "SERVER_REJECTED" })).toEqual({
      status: "required",
      serverRejected: true,
    });
  });

  it("is idempotent and is cleared by the next query/accept", () => {
    const rejected = aiTermsGateReducer(inStatus("accepted"), { type: "SERVER_REJECTED" });
    expect(aiTermsGateReducer(rejected, { type: "SERVER_REJECTED" })).toBe(rejected);
    expect(aiTermsGateReducer(rejected, { type: "QUERY_START" }).serverRejected).toBe(false);
    expect(aiTermsGateReducer(rejected, { type: "ACCEPT_START" }).serverRejected).toBe(false);
  });
});

describe("RESET", () => {
  it("returns to the initial state", () => {
    const accepted = inStatus("accepted");
    expect(aiTermsGateReducer(accepted, { type: "RESET" })).toEqual(initial);
  });
});

describe("aiTermsAllowConfirm", () => {
  it("accepted always allows, required needs the checkbox, everything else blocks", () => {
    expect(aiTermsAllowConfirm(inStatus("accepted"), false)).toBe(true);
    expect(aiTermsAllowConfirm(inStatus("required"), true)).toBe(true);
    expect(aiTermsAllowConfirm(inStatus("required"), false)).toBe(false);
    expect(aiTermsAllowConfirm(inStatus("checking"), true)).toBe(false);
    expect(aiTermsAllowConfirm(inStatus("accepting"), true)).toBe(false);
    expect(aiTermsAllowConfirm(inStatus("error"), true)).toBe(false);
    expect(aiTermsAllowConfirm(inStatus("unknown"), true)).toBe(false);
  });
});
