import { describe, it, expect } from "vitest";
import { classifyPolishError, isRetryablePolishError } from "./polish-errors";
import { PolishApiError } from "./polish-api-error";
import { toPolishError } from "./polish-flow-request";
describe("canonical error reason handling", () => {
  it.each([["FORBIDDEN", "CONSENT_REQUIRED", "terms_required"], ["FORBIDDEN", "NOT_ALLOWED", "forbidden"], ["CONFLICT", "REQUEST_IN_PROGRESS", "duplicate"], ["CONFLICT", "ALREADY_FINALIZED", "duplicate"], ["CONFLICT", "CONFIG_CHANGED", "route_changed"], ["CONFLICT", "OPTION_UNAVAILABLE", "route_changed"], ["CONFLICT", "UNKNOWN_REASON", "unknown"], ["UNAVAILABLE", "HELD", "held"], ["UNAVAILABLE", "FAILED_UPSTREAM", "upstream"], ["UNAVAILABLE", "INVALID_OUTPUT", "invalid_output"], ["CLIENT_UPDATE_REQUIRED", undefined, "client_update"]])("classifies %s/%s as %s", (code, reason, kind) => expect(classifyPolishError({
    code: code!,
    reason
  })).toBe(kind));
  it.each(["held", "duplicate", "forbidden", "client_update", "network", "timeout", "unknown"] as const)("does not offer resend for %s", kind => expect(isRetryablePolishError(kind)).toBe(false));
  it("preserves structured reason through the HTTP/reducer boundary", () => expect(toPolishError(new PolishApiError({
    code: "UNAVAILABLE",
    reason: "HELD"
  }))).toMatchObject({
    code: "UNAVAILABLE",
    reason: "HELD"
  }));
});
