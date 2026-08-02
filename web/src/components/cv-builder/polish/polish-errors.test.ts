import { describe, expect, it } from "vitest";

import { POLISH_ERROR_CODES } from "@/lib/polish/contract";

import {
  classifyPolishError,
  formatResetAt,
  isRetryablePolishError,
  POLISH_TRANSPORT_ERROR_CODES,
} from "./polish-errors";
import { POLISH_CLIENT_ERROR_CODES } from "./polish-reducer";

describe("classifyPolishError", () => {
  it("classifies every contract error code into a known kind", () => {
    const expected: Record<(typeof POLISH_ERROR_CODES)[number], string> = {
      INVALID_REQUEST: "invalid_request",
      UNAUTHORIZED: "auth",
      AI_TERMS_REQUIRED: "terms_required",
      REQUEST_IN_PROGRESS: "duplicate",
      DUPLICATE_REQUEST: "duplicate",
      PAYLOAD_TOO_LARGE: "too_large",
      QUOTA_EXCEEDED: "quota_exhausted",
      RATE_LIMITED: "rate_limited",
      INTERNAL_ERROR: "upstream",
      UPSTREAM_ERROR: "upstream",
      INVALID_MODEL_OUTPUT: "invalid_output",
      AI_DISABLED: "disabled",
      SERVICE_UNAVAILABLE: "disabled",
      UPSTREAM_TIMEOUT: "timeout",
    };
    for (const code of POLISH_ERROR_CODES) {
      expect(classifyPolishError({ code }), `code ${code}`).toBe(expected[code]);
    }
  });

  it("classifies reducer client codes", () => {
    expect(classifyPolishError({ code: POLISH_CLIENT_ERROR_CODES.snapshotStale })).toBe("stale");
    expect(classifyPolishError({ code: POLISH_CLIENT_ERROR_CODES.invalidResponse })).toBe(
      "invalid_output",
    );
  });

  it("classifies transport codes", () => {
    expect(classifyPolishError({ code: POLISH_TRANSPORT_ERROR_CODES.networkError })).toBe(
      "network",
    );
    expect(classifyPolishError({ code: POLISH_TRANSPORT_ERROR_CODES.clientTimeout })).toBe(
      "timeout",
    );
    expect(classifyPolishError({ code: POLISH_TRANSPORT_ERROR_CODES.requestAborted })).toBe(
      "aborted",
    );
    expect(classifyPolishError({ code: POLISH_TRANSPORT_ERROR_CODES.invalidResponseBody })).toBe(
      "invalid_request",
    );
  });

  it("falls back to unknown for unrecognized codes", () => {
    expect(classifyPolishError({ code: "SOME_FUTURE_CODE" })).toBe("unknown");
  });
});

describe("isRetryablePolishError", () => {
  it.each([
    ["rate_limited", true],
    ["timeout", true],
    ["invalid_output", true],
    ["stale", true],
    ["network", true],
    ["upstream", true],
    ["quota_exhausted", false],
    ["duplicate", false],
    ["too_large", false],
    ["disabled", false],
    ["auth", false],
    ["terms_required", false],
    ["invalid_request", false],
    ["aborted", false],
    ["unknown", false],
  ] as const)("%s → retryable %s", (kind, retryable) => {
    expect(isRetryablePolishError(kind)).toBe(retryable);
  });
});

describe("formatResetAt", () => {
  it("formats a valid ISO timestamp for the locale", () => {
    const formatted = formatResetAt("2026-08-03T00:00:00.000Z", "en");
    expect(formatted).toContain("Aug");
    expect(formatted).toContain("3");
  });

  it("falls back to the raw string for unparseable input", () => {
    expect(formatResetAt("not-a-date", "en")).toBe("not-a-date");
  });
});
