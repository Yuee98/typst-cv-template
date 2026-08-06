import { describe, expect, it } from "vitest";
import { POLISH_TRANSPORT_ERROR_CODES } from "./polish-errors";
import { createPolishHttpClient, PolishApiError } from "./polish-client";
import { CLIENT_REQUEST_ID, SUCCESS_BODY, fetchReturning, jsonResponse, makeRequest } from "./polish-client-test-fixtures";

function httpClient(fetchImpl: typeof fetch, overrides = {}) {
  return createPolishHttpClient({
    getAccessToken: async () => "token-abc",
    fetchImpl,
    ...overrides,
  });
}

describe("createPolishHttpClient", () => {
  it("POSTs the request with the Bearer token and parses the success body", async () => {
    let seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return jsonResponse(200, SUCCESS_BODY);
    }) as unknown as typeof fetch;

    const client = httpClient(fetchImpl);
    const result = await client.polish(makeRequest());

    expect(result).toEqual(SUCCESS_BODY);
    expect(seen.url).toBe("/api/polish");
    expect(seen.init?.method).toBe("POST");
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token-abc");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(seen.init?.body as string).clientRequestId).toBe(CLIENT_REQUEST_ID);
  });

  it("omits the Authorization header when there is no token", async () => {
    let seenHeaders: Record<string, string> | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seenHeaders = init.headers as Record<string, string>;
      return jsonResponse(401, {
        requestId: "srv-2",
        error: { code: "UNAUTHORIZED", message: "no token" },
      });
    }) as unknown as typeof fetch;

    const client = createPolishHttpClient({
      getAccessToken: async () => null,
      fetchImpl,
    });
    const error = await client.polish(makeRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolishApiError);
    expect((error as PolishApiError).code).toBe("UNAUTHORIZED");
    expect(seenHeaders?.Authorization).toBeUndefined();
  });

  it("extracts code, resetAt, retryAfterSeconds and requestId from a contract error", async () => {
    const fetchImpl = fetchReturning(
      jsonResponse(429, {
        requestId: "srv-9",
        error: {
          code: "QUOTA_EXCEEDED",
          message: "daily quota exhausted",
          resetAt: "2026-08-03T00:00:00.000Z",
          retryAfterSeconds: 3600,
        },
      }),
    );
    const error = (await httpClient(fetchImpl)
      .polish(makeRequest())
      .catch((e: unknown) => e)) as PolishApiError;
    expect(error.code).toBe("QUOTA_EXCEEDED");
    expect(error.status).toBe(429);
    expect(error.resetAt).toBe("2026-08-03T00:00:00.000Z");
    expect(error.retryAfterSeconds).toBe(3600);
    expect(error.requestId).toBe("srv-9");
  });

  it("maps an off-contract error body by status and honors Retry-After", async () => {
    const fetchImpl = fetchReturning(
      jsonResponse(429, "too many", { "Retry-After": "42", "X-Request-Id": "srv-h" }),
    );
    const error = (await httpClient(fetchImpl)
      .polish(makeRequest())
      .catch((e: unknown) => e)) as PolishApiError;
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryAfterSeconds).toBe(42);
    expect(error.requestId).toBe("srv-h");
  });

  it("rejects a success body that fails the contract schema", async () => {
    const fetchImpl = fetchReturning(jsonResponse(200, { requestId: "srv-1", items: [] }));
    const error = (await httpClient(fetchImpl)
      .polish(makeRequest())
      .catch((e: unknown) => e)) as PolishApiError;
    expect(error.code).toBe(POLISH_TRANSPORT_ERROR_CODES.invalidResponseBody);
    // No response content leaks into the error message (Invariant 8).
    expect(error.message).not.toContain("srv-1");
  });

  it("maps a fetch rejection to NETWORK_ERROR", async () => {
    const fetchImpl = (() =>
      Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    const error = (await httpClient(fetchImpl)
      .polish(makeRequest())
      .catch((e: unknown) => e)) as PolishApiError;
    expect(error.code).toBe(POLISH_TRANSPORT_ERROR_CODES.networkError);
  });

  it("maps caller cancellation to REQUEST_ABORTED", async () => {
    const controller = new AbortController();
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
        setTimeout(() => controller.abort(), 10);
      })) as unknown as typeof fetch;

    const error = (await httpClient(fetchImpl)
      .polish(makeRequest(), { signal: controller.signal })
      .catch((e: unknown) => e)) as PolishApiError;
    expect(error.code).toBe(POLISH_TRANSPORT_ERROR_CODES.requestAborted);
  });

  it("maps a silent overrun to CLIENT_TIMEOUT", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      })) as unknown as typeof fetch;

    const client = httpClient(fetchImpl, { timeoutMs: 20 });
    const error = (await client
      .polish(makeRequest())
      .catch((e: unknown) => e)) as PolishApiError;
    expect(error.code).toBe(POLISH_TRANSPORT_ERROR_CODES.clientTimeout);
  });

  it("getQuota parses the quota envelope", async () => {
    const fetchImpl = ((url: string) => {
      expect(url).toBe("/api/polish/quota");
      return Promise.resolve(
        jsonResponse(200, {
          requestId: "srv-q",
          quota: { limit: 20, remaining: 7, resetAt: "2026-08-03T00:00:00.000Z" },
        }),
      );
    }) as unknown as typeof fetch;
    const result = await httpClient(fetchImpl).getQuota();
    expect(result.quota.remaining).toBe(7);
  });

  it("getQuota surfaces contract errors the same way", async () => {
    const fetchImpl = fetchReturning(
      jsonResponse(401, {
        requestId: "srv-q",
        error: { code: "UNAUTHORIZED", message: "expired" },
      }),
    );
    const error = (await httpClient(fetchImpl)
      .getQuota()
      .catch((e: unknown) => e)) as PolishApiError;
    expect(error.code).toBe("UNAUTHORIZED");
  });
});
