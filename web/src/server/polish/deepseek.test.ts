import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PolishProviderError, type PolishProviderRequest } from "./provider";
import {
  createDeepSeekPolishProvider,
  DEEPSEEK_POLISH_MODEL,
  DEFAULT_DEEPSEEK_BASE_URL,
} from "./deepseek";

const TEST_ENV = {
  DEEPSEEK_API_KEY: "test-api-key",
  AI_USER_ID_HMAC_SECRET: "test-hmac-secret",
};
const TEST_USER_ID = "00000000-0000-4000-8000-000000000000";

/** Independent recomputation of the expected `user` field (never the impl's). */
function expectedUserHmac(userId: string = TEST_USER_ID, secret: string = TEST_ENV.AI_USER_ID_HMAC_SECRET) {
  return createHmac("sha256", secret).update(userId).digest("hex");
}

function makeProvider(
  envOverrides: Record<string, string | undefined> = {},
  userId: string | undefined = TEST_USER_ID,
) {
  return createDeepSeekPolishProvider({ env: { ...TEST_ENV, ...envOverrides }, userId });
}

function makeRequest(maxOutputTokens = 1024): PolishProviderRequest {
  return {
    messages: [
      { role: "system", content: "You polish resume text." },
      { role: "user", content: '{"items":[{"id":"i0","text":"Led the migration."}]}' },
    ],
    maxOutputTokens,
  };
}

function callOptions(timeoutMs = 1000): { signal: AbortSignal; timeoutMs: number } {
  return { signal: new AbortController().signal, timeoutMs };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function successPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-test",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: '{"items":[{"id":"i0","polished":"Drove the migration."}]}' },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 40,
      prompt_cache_hit_tokens: 30,
      prompt_cache_miss_tokens: 70,
    },
    ...overrides,
  };
}

/** Fetch stub that stays pending until the request signal aborts (like undici). */
function pendingUntilAbortFetch() {
  return vi.fn().mockImplementation((_url: unknown, init: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("createDeepSeekPolishProvider — configuration (fail-loud)", () => {
  it("throws when DEEPSEEK_API_KEY is missing or empty", () => {
    expect(() => makeProvider({ DEEPSEEK_API_KEY: undefined })).toThrow(/DEEPSEEK_API_KEY/);
    expect(() => makeProvider({ DEEPSEEK_API_KEY: "" })).toThrow(/DEEPSEEK_API_KEY/);
  });

  it("throws when AI_USER_ID_HMAC_SECRET is missing", () => {
    expect(() => makeProvider({ AI_USER_ID_HMAC_SECRET: undefined })).toThrow(
      /AI_USER_ID_HMAC_SECRET/,
    );
  });

  it("throws when no verified user id is provided", () => {
    expect(() => createDeepSeekPolishProvider({ env: TEST_ENV })).toThrow(/userId/);
  });

  it("reads process.env by default", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "env-key");
    vi.stubEnv("AI_USER_ID_HMAC_SECRET", "env-secret");
    const provider = createDeepSeekPolishProvider({ userId: TEST_USER_ID });
    expect(typeof provider.complete).toBe("function");
  });
});

describe("createDeepSeekPolishProvider — request mapping", () => {
  it("posts the pinned DeepSeek parameters to the chat completions endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(successPayload()));
    vi.stubGlobal("fetch", fetchMock);

    await makeProvider().complete(makeRequest(4096), callOptions());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_DEEPSEEK_BASE_URL}/chat/completions`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-api-key",
      "Content-Type": "application/json",
    });

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe(DEEPSEEK_POLISH_MODEL);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual(makeRequest(4096).messages);
    expect(body).not.toHaveProperty("stream");
  });

  it("sends HMAC-SHA256 hex of the user id in the `user` field, never the raw id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(successPayload()));
    vi.stubGlobal("fetch", fetchMock);

    await makeProvider().complete(makeRequest(), callOptions());

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.user).toBe(expectedUserHmac());
    expect(body.user).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(body)).not.toContain(TEST_USER_ID);
  });

  it("derives distinct, stable user hashes per user id and secret", async () => {
    // Fresh Response per call: a Response body can only be read once.
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse(successPayload())),
    );
    vi.stubGlobal("fetch", fetchMock);

    await makeProvider().complete(makeRequest(), callOptions());
    await makeProvider({}, "11111111-1111-4111-8111-111111111111").complete(
      makeRequest(),
      callOptions(),
    );
    await makeProvider({ AI_USER_ID_HMAC_SECRET: "other-secret" }).complete(
      makeRequest(),
      callOptions(),
    );

    const users = fetchMock.mock.calls.map(
      (call) => JSON.parse((call as [string, RequestInit])[1].body as string).user as string,
    );
    expect(users[0]).toBe(expectedUserHmac());
    expect(users[1]).toBe(expectedUserHmac("11111111-1111-4111-8111-111111111111"));
    expect(users[2]).toBe(expectedUserHmac(TEST_USER_ID, "other-secret"));
    expect(new Set(users).size).toBe(3);
  });

  it("honors DEEPSEEK_BASE_URL override and strips trailing slashes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(successPayload()));
    vi.stubGlobal("fetch", fetchMock);

    await makeProvider({ DEEPSEEK_BASE_URL: "https://proxy.example.com/v1/" }).complete(
      makeRequest(),
      callOptions(),
    );

    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe(
      "https://proxy.example.com/v1/chat/completions",
    );
  });
});

describe("createDeepSeekPolishProvider — response mapping", () => {
  it("maps text and usage including cached/uncached read tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(successPayload()));
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeProvider().complete(makeRequest(), callOptions());

    expect(result.text).toBe('{"items":[{"id":"i0","polished":"Drove the migration."}]}');
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({
      promptTokens: 100,
      completionTokens: 40,
      cachedReadTokens: 30,
      uncachedReadTokens: 70,
    });
  });

  it("defaults missing cache fields to zero", async () => {
    const payload = successPayload();
    payload.usage = { prompt_tokens: 100, completion_tokens: 40 } as never;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));

    const result = await makeProvider().complete(makeRequest(), callOptions());

    expect(result.usage).toEqual({
      promptTokens: 100,
      completionTokens: 40,
      cachedReadTokens: 0,
      uncachedReadTokens: 0,
    });
  });

  it("degrades a missing usage block to zeros instead of failing the request", async () => {
    const payload = successPayload();
    delete (payload as Record<string, unknown>).usage;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));

    const result = await makeProvider().complete(makeRequest(), callOptions());

    expect(result.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cachedReadTokens: 0,
      uncachedReadTokens: 0,
    });
  });

  it("passes an empty content string through (the orchestrator owns the non-empty check)", async () => {
    const payload = successPayload();
    (payload.choices[0].message as { content: string }).content = "";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));

    const result = await makeProvider().complete(makeRequest(), callOptions());

    expect(result.text).toBe("");
    expect(result.finishReason).toBe("stop");
  });

  it.each([
    ["stop", "stop"],
    ["length", "length"],
    ["content_filter", "content_filter"],
    ["insufficient_system_resource", "insufficient_system_resource"],
    // Never sent tools, so tool_calls means unexpected model behavior →
    // invalid output ("unknown"), never an upstream failure.
    ["tool_calls", "unknown"],
    ["some_future_reason", "unknown"],
    [undefined, "unknown"],
  ] as const)("normalizes finish_reason %s to %s", async (raw, expected) => {
    const payload = successPayload();
    if (raw === undefined) {
      delete (payload.choices[0] as Record<string, unknown>).finish_reason;
    } else {
      (payload.choices[0] as Record<string, unknown>).finish_reason = raw;
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));

    const result = await makeProvider().complete(makeRequest(), callOptions());

    expect(result.finishReason).toBe(expected);
  });
});

describe("createDeepSeekPolishProvider — transport error normalization", () => {
  it.each([401, 429, 500, 503])(
    "maps HTTP %i to PolishProviderError(UPSTREAM_ERROR) without leaking the body",
    async (status) => {
      const body = { error: { message: "SENSITIVE-UPSTREAM-DETAIL" } };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body, status)));

      const error = await makeProvider()
        .complete(makeRequest(), callOptions())
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PolishProviderError);
      expect(error).toMatchObject({ name: "PolishProviderError", code: "UPSTREAM_ERROR" });
      expect((error as Error).message).toContain(String(status));
      expect((error as Error).message).not.toContain("SENSITIVE-UPSTREAM-DETAIL");
    },
  );

  it("maps a network-level fetch rejection to UPSTREAM_ERROR with cause", async () => {
    const cause = new TypeError("fetch failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(cause));

    const error = await makeProvider()
      .complete(makeRequest(), callOptions())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PolishProviderError);
    expect(error).toMatchObject({ code: "UPSTREAM_ERROR", cause });
    expect((error as Error).message).toContain("fetch failed");
  });

  it("maps an unparseable 200 body to UPSTREAM_ERROR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not json at all", { status: 200 })),
    );

    await expect(makeProvider().complete(makeRequest(), callOptions())).rejects.toMatchObject({
      name: "PolishProviderError",
      code: "UPSTREAM_ERROR",
    });
  });

  it.each([
    ["missing choices", {}],
    ["empty choices", { choices: [] }],
    ["non-string content", { choices: [{ message: { content: null }, finish_reason: "stop" }] }],
  ])("maps a malformed envelope (%s) to UPSTREAM_ERROR", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));

    await expect(makeProvider().complete(makeRequest(), callOptions())).rejects.toMatchObject({
      name: "PolishProviderError",
      code: "UPSTREAM_ERROR",
    });
  });

  it("maps the single-call hard timeout to UPSTREAM_TIMEOUT", async () => {
    vi.stubGlobal("fetch", pendingUntilAbortFetch());

    const error = await makeProvider()
      .complete(makeRequest(), callOptions(30))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PolishProviderError);
    expect(error).toMatchObject({ name: "PolishProviderError", code: "UPSTREAM_TIMEOUT" });
    expect((error as Error).message).toContain("30ms");
  });
});

describe("createDeepSeekPolishProvider — cancellation", () => {
  it("rethrows a pre-aborted signal's reason as-is (never wrapped)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(successPayload()));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    const error = await makeProvider()
      .complete(makeRequest(), { signal: controller.signal, timeoutMs: 1000 })
      .catch((e: unknown) => e);

    expect(error).toBe(controller.signal.reason);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(error).not.toBeInstanceOf(PolishProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rethrows a mid-flight abort as-is, even with a custom reason", async () => {
    vi.stubGlobal("fetch", pendingUntilAbortFetch());
    const controller = new AbortController();
    const customReason = new Error("user canceled");

    const promise = makeProvider().complete(makeRequest(), {
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    controller.abort(customReason);

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBe(customReason);
    expect(error).not.toBeInstanceOf(PolishProviderError);
  });
});
