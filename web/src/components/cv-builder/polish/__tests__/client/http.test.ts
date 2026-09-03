import { describe, expect, it, vi } from "vitest";
import { POLISH_TRANSPORT_ERROR_CODES } from "../../polish-errors";
import { createPolishHttpClient, PolishApiError } from "../../polish-client";
import {
  CLIENT_REQUEST_ID,
  DISABLED_AVAILABILITY_BODY,
  ENABLED_AVAILABILITY_BODY,
  SUCCESS_BODY,
  fetchReturning,
  jsonResponse,
  makeRequest,
} from "./fixtures";

const USER_ID = "user-a";
const AUTH = { expectedUserId: USER_ID } as const;

function httpClient(fetchImpl: typeof fetch, overrides = {}) {
  return createPolishHttpClient({
    getAuthSnapshot: async () => ({ userId: USER_ID, accessToken: "token-abc" }),
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
    const result = await client.polish(makeRequest(), AUTH);

    expect(result).toEqual(SUCCESS_BODY);
    expect(seen.url).toBe("/api/polish");
    expect(seen.init?.method).toBe("POST");
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token-abc");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(seen.init?.body as string).clientRequestId).toBe(CLIENT_REQUEST_ID);
  });

  it("fails closed before fetch when there is no authenticated snapshot", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const client = createPolishHttpClient({
      getAuthSnapshot: async () => null,
      fetchImpl,
    });
    const error = await client.polish(makeRequest(), AUTH).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolishApiError);
    expect((error as PolishApiError).code).toBe("UNAUTHORIZED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects principal drift before fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = httpClient(fetchImpl, {
      getAuthSnapshot: async () => ({ userId: "user-b", accessToken: "token-b" }),
    });

    const error = (await client
      .getAvailability(AUTH)
      .catch((caught: unknown) => caught)) as PolishApiError;

    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a refreshed token for the same expected user", async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer token-a-refreshed",
      );
      return jsonResponse(200, ENABLED_AVAILABILITY_BODY);
    }) as unknown as typeof fetch;
    const client = httpClient(fetchImpl, {
      getAuthSnapshot: async () => ({
        userId: USER_ID,
        accessToken: "token-a-refreshed",
      }),
    });

    await expect(client.getAvailability(AUTH)).resolves.toEqual(
      ENABLED_AVAILABILITY_BODY,
    );
  });

  it("uses the captured principal/token when the mutable auth source changes later", async () => {
    let current = { userId: USER_ID, accessToken: "token-a" };
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      expect(current.userId).toBe("user-b");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer token-a",
      );
      return jsonResponse(200, ENABLED_AVAILABILITY_BODY);
    }) as unknown as typeof fetch;
    const client = httpClient(fetchImpl, {
      getAuthSnapshot: async () => {
        const captured = { ...current };
        queueMicrotask(() => {
          current = { userId: "user-b", accessToken: "token-b" };
        });
        return captured;
      },
    });

    await expect(client.getAvailability(AUTH)).resolves.toEqual(
      ENABLED_AVAILABILITY_BODY,
    );
  });

  it("aborts while atomic auth acquisition is pending without fetching", async () => {
    let resolveAuth!: (value: { userId: string; accessToken: string }) => void;
    const authPending = new Promise<{ userId: string; accessToken: string }>(
      (resolve) => {
        resolveAuth = resolve;
      },
    );
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = httpClient(fetchImpl, { getAuthSnapshot: () => authPending });
    const controller = new AbortController();

    const pending = client.getQuota({ ...AUTH, signal: controller.signal });
    controller.abort();
    const error = (await pending.catch((caught: unknown) => caught)) as PolishApiError;
    resolveAuth({ userId: USER_ID, accessToken: "late-token" });

    expect(error.code).toBe(POLISH_TRANSPORT_ERROR_CODES.requestAborted);
    expect(fetchImpl).not.toHaveBeenCalled();
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
      .polish(makeRequest(), AUTH)
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
      .polish(makeRequest(), AUTH)
      .catch((e: unknown) => e)) as PolishApiError;
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryAfterSeconds).toBe(42);
    expect(error.requestId).toBe("srv-h");
  });

  it("rejects a success body that fails the contract schema", async () => {
    const fetchImpl = fetchReturning(jsonResponse(200, { requestId: "srv-1", items: [] }));
    const error = (await httpClient(fetchImpl)
      .polish(makeRequest(), AUTH)
      .catch((e: unknown) => e)) as PolishApiError;
    expect(error.code).toBe(POLISH_TRANSPORT_ERROR_CODES.invalidResponseBody);
    // No response content leaks into the error message (Invariant 8).
    expect(error.message).not.toContain("srv-1");
  });

  it("maps a fetch rejection to NETWORK_ERROR", async () => {
    const fetchImpl = (() =>
      Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    const error = (await httpClient(fetchImpl)
      .polish(makeRequest(), AUTH)
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
      .polish(makeRequest(), { ...AUTH, signal: controller.signal })
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
      .polish(makeRequest(), AUTH)
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
    const result = await httpClient(fetchImpl).getQuota(AUTH);
    expect(result.quota.remaining).toBe(7);
  });

  it.each([
    ["enabled", ENABLED_AVAILABILITY_BODY],
    ["disabled", DISABLED_AVAILABILITY_BODY],
  ])("GETs and strictly parses the %s availability envelope", async (_state, body) => {
    let seen: { url?: string; init?: RequestInit } = {};
    const controller = new AbortController();
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return jsonResponse(200, body);
    }) as unknown as typeof fetch;

    const result = await httpClient(fetchImpl).getAvailability({
      ...AUTH,
      signal: controller.signal,
    });

    expect(result).toEqual(body);
    expect(seen.url).toBe("/api/polish/availability");
    expect(seen.init?.method).toBe("GET");
    expect(seen.init?.body).toBeUndefined();
    expect(seen.init?.signal).toBeInstanceOf(AbortSignal);
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe("Bearer token-abc");
  });

  it.each([
    [
      "partial route",
      {
        ...ENABLED_AVAILABILITY_BODY,
        availability: { ...ENABLED_AVAILABILITY_BODY.availability, profileVersionId: undefined },
      },
    ],
    [
      "malformed runtime ID",
      {
        ...ENABLED_AVAILABILITY_BODY,
        availability: {
          ...ENABLED_AVAILABILITY_BODY.availability,
          runtimeContractId: "invalid runtime id",
        },
      },
    ],
    [
      "extra internal route",
      { ...ENABLED_AVAILABILITY_BODY, internalRoute: "deepseek_official" },
    ],
  ])("rejects a success body with %s without leaking it", async (_case, body) => {
    const error = (await httpClient(fetchReturning(jsonResponse(200, body)))
      .getAvailability(AUTH)
      .catch((caught: unknown) => caught)) as PolishApiError;

    expect(error.code).toBe(POLISH_TRANSPORT_ERROR_CODES.invalidResponseBody);
    expect(error.message).not.toContain("deepseek_official");
    expect(error.message).not.toContain("AAAA");
  });

  it("aborts an availability read through the shared caller-cancellation path", async () => {
    const controller = new AbortController();
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
        setTimeout(() => controller.abort(), 10);
      })) as unknown as typeof fetch;

    const pending = httpClient(fetchImpl).getAvailability({
      ...AUTH,
      signal: controller.signal,
    });
    const error = (await pending.catch((caught: unknown) => caught)) as PolishApiError;

    expect(error.code).toBe(POLISH_TRANSPORT_ERROR_CODES.requestAborted);
  });

  it("getQuota surfaces contract errors the same way", async () => {
    const fetchImpl = fetchReturning(
      jsonResponse(401, {
        requestId: "srv-q",
        error: { code: "UNAUTHORIZED", message: "expired" },
      }),
    );
    const error = (await httpClient(fetchImpl)
      .getQuota(AUTH)
      .catch((e: unknown) => e)) as PolishApiError;
    expect(error.code).toBe("UNAUTHORIZED");
  });
});
