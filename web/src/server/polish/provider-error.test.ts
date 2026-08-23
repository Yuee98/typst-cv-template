import { describe, expect, it } from "vitest";

import {
  classifyProviderRetry,
  MAX_PROVIDER_RETRY_AFTER_MS,
} from "./provider-error";

describe("classifyProviderRetry", () => {
  it.each([400, 401, 402, 403, 404, 409, 421, 422])(
    "does not retry terminal HTTP %i",
    (upstreamStatus) => {
      expect(
        classifyProviderRetry({ code: "UPSTREAM_ERROR", upstreamStatus, retryable: true }),
      ).toEqual({ retryable: false, retryAfterMs: 0 });
    },
  );

  it.each([408, 425, 500, 502, 503])("retries transient HTTP %i", (upstreamStatus) => {
    expect(classifyProviderRetry({ code: "UPSTREAM_ERROR", upstreamStatus })).toEqual({
      retryable: true,
      retryAfterMs: 0,
    });
  });

  it("caps a 429 Retry-After and ignores invalid delays", () => {
    expect(
      classifyProviderRetry({
        code: "UPSTREAM_ERROR",
        upstreamStatus: 429,
        retryAfterMs: MAX_PROVIDER_RETRY_AFTER_MS * 10,
      }),
    ).toEqual({ retryable: true, retryAfterMs: MAX_PROVIDER_RETRY_AFTER_MS });
    expect(
      classifyProviderRetry({
        code: "UPSTREAM_ERROR",
        upstreamStatus: 429,
        retryAfterMs: Number.NaN,
      }),
    ).toEqual({ retryable: true, retryAfterMs: 0 });
  });

  it("retries usage-less network errors/timeouts unless the adapter disables retry", () => {
    expect(classifyProviderRetry({ code: "UPSTREAM_ERROR" }).retryable).toBe(true);
    expect(classifyProviderRetry({ code: "UPSTREAM_TIMEOUT" }).retryable).toBe(true);
    expect(
      classifyProviderRetry({ code: "UPSTREAM_TIMEOUT", retryable: false }).retryable,
    ).toBe(false);
    expect(
      classifyProviderRetry({
        code: "UPSTREAM_ERROR",
        upstreamStatus: 503,
        retryable: false,
      }).retryable,
    ).toBe(false);
  });

  it("does not infer retryability from unknown error shapes", () => {
    expect(classifyProviderRetry({})).toEqual({ retryable: false, retryAfterMs: 0 });
  });
});
