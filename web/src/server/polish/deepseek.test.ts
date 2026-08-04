import { afterEach, describe, expect, it, vi } from "vitest";
import { PolishProviderError, type PolishProviderRequest } from "./provider";
import {
  createDeepSeekPolishProvider,
  DEEPSEEK_POLISH_MODEL,
  DEFAULT_DEEPSEEK_BASE_URL,
} from "./deepseek";

const TEST_ENV = {
  DEEPSEEK_API_KEY: "test-api-key",
};
/** Pseudonymous id the handler would compute; forwarded upstream unchanged. */
const TEST_PROVIDER_USER_ID = "0".repeat(63) + "a";
/** Distinctive target-only sentinel: proves `targets` never goes upstream. */
const TARGET_ONLY_SENTINEL = "TARGET-ONLY-SENTINEL-7f3a9c";

function makeProvider(envOverrides: Record<string, string | undefined> = {}) {
  return createDeepSeekPolishProvider({ env: { ...TEST_ENV, ...envOverrides } });
}

function makeRequest(maxOutputTokens = 1024): PolishProviderRequest {
  return {
    messages: [
      { role: "system", content: "You polish resume text." },
      { role: "user", content: '{"items":[{"id":"i0","text":"Led the migration."}]}' },
    ],
    maxOutputTokens,
    providerUserId: TEST_PROVIDER_USER_ID,
    targets: [{ id: "i0", text: TARGET_ONLY_SENTINEL }],
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

  it("reads process.env by default", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "env-key");
    const provider = createDeepSeekPolishProvider();
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

  it("forwards request.providerUserId as the documented `user_id` field, unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(successPayload()));
    vi.stubGlobal("fetch", fetchMock);

    await makeProvider().complete(makeRequest(), callOptions());

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    // The provider applies no privacy logic of its own: the pseudonymous id
    // arrives pre-computed from the handler and goes upstream verbatim, under
    // the field DeepSeek documents for identity/KV-cache isolation (user_id,
    // NOT the undocumented `user`).
    expect(body.user_id).toBe(TEST_PROVIDER_USER_ID);
    expect(body).not.toHaveProperty("user");
  });

  it("never forwards the `targets` metadata upstream (pinned interface rule)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(successPayload()));
    vi.stubGlobal("fetch", fetchMock);

    await makeProvider().complete(makeRequest(), callOptions());

    const rawBody = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string;
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    expect(body).not.toHaveProperty("targets");
    expect(rawBody).not.toContain(TARGET_ONLY_SENTINEL);
    expect(Object.keys(body).sort()).toEqual(
      ["max_tokens", "messages", "model", "response_format", "thinking", "user_id"].sort(),
    );
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

  it("extracts the provider request id from the completion id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(successPayload())));

    const result = await makeProvider().complete(makeRequest(), callOptions());

    expect(result.providerRequestId).toBe("chatcmpl-test");
  });

  it("falls back to the x-request-id response header when the body omits the id", async () => {
    const payload = successPayload();
    delete (payload as Record<string, unknown>).id;
    const response = new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json", "x-request-id": "hdr-req-42" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const result = await makeProvider().complete(makeRequest(), callOptions());

    expect(result.providerRequestId).toBe("hdr-req-42");
  });

  it("conserves prompt tokens when the cache fields are missing: unexplained input is UNCACHED", async () => {
    // DeepSeek schema: prompt_tokens = hit + miss. A response without the
    // cache split must not record zero billable input — the unexplained part
    // is booked as uncached reads (the cost-conservative classification).
    const payload = successPayload();
    payload.usage = { prompt_tokens: 100, completion_tokens: 40 } as never;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));

    const result = await makeProvider().complete(makeRequest(), callOptions());

    expect(result.usage).toEqual({
      promptTokens: 100,
      completionTokens: 40,
      cachedReadTokens: 0,
      uncachedReadTokens: 100,
    });
  });

  it("conserves prompt tokens when the cache split under-reports (partial cache usage)", async () => {
    const payload = successPayload();
    payload.usage = {
      prompt_tokens: 100,
      completion_tokens: 40,
      prompt_cache_hit_tokens: 30,
    } as never;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));

    const result = await makeProvider().complete(makeRequest(), callOptions());

    expect(result.usage).toEqual({
      promptTokens: 100,
      completionTokens: 40,
      cachedReadTokens: 30,
      uncachedReadTokens: 70, // 0 reported miss + 70 unexplained
    });
  });

  it("keeps the reported split when hit + miss already covers prompt_tokens", async () => {
    const payload = successPayload();
    payload.usage = {
      prompt_tokens: 100,
      completion_tokens: 40,
      prompt_cache_hit_tokens: 60,
      prompt_cache_miss_tokens: 60, // over-explained: keep reported, never go negative
    } as never;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));

    const result = await makeProvider().complete(makeRequest(), callOptions());

    expect(result.usage).toEqual({
      promptTokens: 100,
      completionTokens: 40,
      cachedReadTokens: 60,
      uncachedReadTokens: 60,
    });
  });

  it("rejects a missing usage block with a controlled UPSTREAM_ERROR (never a fake zero-usage success)", async () => {
    const payload = successPayload();
    delete (payload as Record<string, unknown>).usage;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));

    const error = await makeProvider()
      .complete(makeRequest(), callOptions())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PolishProviderError);
    expect(error).toMatchObject({
      name: "PolishProviderError",
      code: "UPSTREAM_ERROR",
      providerRequestId: "chatcmpl-test",
    });
  });

  it.each([
    ["prompt_tokens", { completion_tokens: 40, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 20 }],
    ["completion_tokens", { prompt_tokens: 30, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 20 }],
  ])("rejects a usage block missing the required total %s", async (_label, usage) => {
    const payload = successPayload();
    payload.usage = usage as never;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));

    await expect(makeProvider().complete(makeRequest(), callOptions())).rejects.toMatchObject({
      name: "PolishProviderError",
      code: "UPSTREAM_ERROR",
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

  it("carries upstreamStatus + providerRequestId on HTTP errors, still without the body", async () => {
    const body = { error: { message: "SENSITIVE-UPSTREAM-DETAIL" } };
    const response = new Response(JSON.stringify(body), {
      status: 429,
      headers: { "Content-Type": "application/json", "x-request-id": "hdr-req-fail-9" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const error = await makeProvider()
      .complete(makeRequest(), callOptions())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PolishProviderError);
    expect(error).toMatchObject({
      code: "UPSTREAM_ERROR",
      upstreamStatus: 429,
      providerRequestId: "hdr-req-fail-9",
    });
    expect((error as Error).message).not.toContain("SENSITIVE-UPSTREAM-DETAIL");
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
  ])(
    "maps a malformed envelope WITHOUT a usage block (%s) to UPSTREAM_ERROR",
    async (_label, body) => {
      // Usage is extracted before the content check (round-2 #2): these
      // payloads carry no usage block, so the controlled UPSTREAM_ERROR comes
      // from normalizeUsage — absence of usage is never faked as zero.
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));

      await expect(makeProvider().complete(makeRequest(), callOptions())).rejects.toMatchObject({
        name: "PolishProviderError",
        code: "UPSTREAM_ERROR",
      });
    },
  );

  it.each([
    ["missing choices", {}],
    ["empty choices", { choices: [] }],
    ["non-string content", { choices: [{ message: { content: null }, finish_reason: "stop" }] }],
  ])(
    "keeps the usage block on a malformed envelope (%s): empty text + unknown finish reason (#2)",
    async (_label, malformed) => {
      // A malformed envelope WITH valid usage is NOT a transport failure: the
      // provider returns text "" + finishReason "unknown" so the orchestrator
      // validator classifies it as invalid output (retryable) while the
      // billable usage is accumulated and recorded — never dropped.
      const payload = {
        id: "chatcmpl-malformed",
        ...malformed,
        usage: {
          prompt_tokens: 12,
          completion_tokens: 3,
          prompt_cache_hit_tokens: 4,
          prompt_cache_miss_tokens: 8,
        },
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));

      const result = await makeProvider().complete(makeRequest(), callOptions());

      expect(result.text).toBe("");
      expect(result.finishReason).toBe("unknown");
      expect(result.usage).toEqual({
        promptTokens: 12,
        completionTokens: 3,
        cachedReadTokens: 4,
        uncachedReadTokens: 8,
      });
      expect(result.providerRequestId).toBe("chatcmpl-malformed");
    },
  );

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
