import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyProviderRetry, MAX_PROVIDER_RETRY_AFTER_MS } from "./provider-error";
import { PolishProviderError, type PolishProviderRequest } from "./provider";
import { buildPolishPromptBlocks, POLISH_PROMPT_VERSION } from "./prompt";
import type { PolishInferenceRequestV2 } from "./inference-v2";
import {
  createDeepSeekChatV1Adapter,
  createDeepSeekPolishProvider,
  DeepSeekChatV1AdapterError,
  DEEPSEEK_CHAT_V1_ADAPTER_KIND,
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

function makeV2Request(maxOutputTokens = 1024): PolishInferenceRequestV2 {
  const items = [
    { id: "i0", kind: "experience_bullet" as const, text: "Led the migration." },
  ];
  const prompt = buildPolishPromptBlocks({
    language: "en",
    sectionId: "experience",
    granularity: "item",
    items,
    contextLevel: 0,
    references: [],
    stylePreset: "professional",
  });
  return {
    schemaVersion: "polish_inference_request_v2",
    prompt,
    outputContract: {
      kind: "json_object",
      schemaName: "polish_items_v1",
      schema: { type: "object" },
    },
    maxOutputTokens,
    providerSubjectId: TEST_PROVIDER_USER_ID,
    promptVersion: POLISH_PROMPT_VERSION,
    validatorVersion: "polish-validator-v1",
    language: "en",
    targets: [{ id: "i0", text: TARGET_ONLY_SENTINEL }],
  };
}

function makeV2Adapter(fetchImpl: typeof fetch) {
  return createDeepSeekChatV1Adapter({ env: TEST_ENV, fetch: fetchImpl });
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
    model: DEEPSEEK_POLISH_MODEL,
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

describe("createDeepSeekChatV1Adapter — V1 rollback parity", () => {
  it("fails closed on a missing registered credential", () => {
    expect(() => createDeepSeekChatV1Adapter({ env: {} })).toThrow(
      /credential deepseek_api_key is unavailable/u,
    );
  });

  it("keeps the exact canonical Chat wire bytes across the V1 and V2 factories", async () => {
    const responseFactory = () => jsonResponse(successPayload());
    const legacyFetch = vi.fn().mockImplementation(responseFactory);
    const v2Fetch = vi.fn().mockImplementation(responseFactory);
    const v2Request = makeV2Request(4096);
    const legacyRequest: PolishProviderRequest = {
      messages: v2Request.prompt.blocks.map((block) => ({
        role: block.role === "developer" ? "system" : "user",
        content: block.content,
      })),
      maxOutputTokens: v2Request.maxOutputTokens,
      providerUserId: v2Request.providerSubjectId,
      targets: v2Request.targets,
    };

    await createDeepSeekPolishProvider({ env: TEST_ENV, fetch: legacyFetch }).complete(
      legacyRequest,
      callOptions(),
    );
    await makeV2Adapter(v2Fetch).complete(v2Request, callOptions());

    expect(makeV2Adapter(v2Fetch).kind).toBe(DEEPSEEK_CHAT_V1_ADAPTER_KIND);
    const legacyInit = (legacyFetch.mock.calls[0] as [string, RequestInit])[1];
    const v2Init = (v2Fetch.mock.calls[0] as [string, RequestInit])[1];
    expect(v2Init.body).toBe(legacyInit.body);
    expect(v2Init.body).toBe(
      JSON.stringify({
        model: "deepseek-v4-flash",
        messages: legacyRequest.messages,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        max_tokens: 4096,
        user_id: TEST_PROVIDER_USER_ID,
      }),
    );
    expect(v2Init.body as string).not.toContain(TARGET_ONLY_SENTINEL);
  });

  it("uses the code-owned official endpoint even when the legacy base-url override is present", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(successPayload()));
    const adapter = createDeepSeekChatV1Adapter({
      env: { ...TEST_ENV, DEEPSEEK_BASE_URL: "https://unreviewed.invalid/v1" },
      fetch: fetchMock,
    });

    await adapter.complete(makeV2Request(), callOptions());

    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe(
      "https://api.deepseek.com/chat/completions",
    );
  });
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

describe("createDeepSeekChatV1Adapter — V2 response and usage mapping", () => {
  it("maps hit/miss cache buckets, output reasoning detail, model and both request ids", async () => {
    const response = new Response(
      JSON.stringify(
        successPayload({
          id: "body-request-7",
          model: "deepseek-v4-flash-202608",
          usage: {
            prompt_tokens: 100,
            completion_tokens: 40,
            prompt_cache_hit_tokens: 30,
            prompt_cache_miss_tokens: 70,
            completion_tokens_details: { reasoning_tokens: 10 },
          },
        }),
      ),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-request-id": "header-request-9",
        },
      },
    );
    const fetchMock = vi.fn().mockResolvedValue(response);

    const result = await makeV2Adapter(fetchMock).complete(makeV2Request(), callOptions());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      schemaVersion: "polish_inference_result_v2",
      text: '{"items":[{"id":"i0","polished":"Drove the migration."}]}',
      finishReason: "stop",
      usage: {
        schemaVersion: "normalized_usage_v2",
        inputTotalTokens: 100,
        inputCacheReadTokens: 30,
        inputCacheWriteTokens: null,
        inputStandardTokens: 70,
        outputTokens: 40,
        reasoningTokens: 10,
        cacheUsageReporting: "unavailable",
        usageComplete: true,
      },
      route: {
        gatewayRequestId: "header-request-9",
        providerRequestId: "body-request-7",
        actualUpstreamEndpoint: "https://api.deepseek.com/chat/completions",
        actualModelId: "deepseek-v4-flash-202608",
      },
    });
  });

  it("books missing cache split as standard input without inventing a cache-write count", async () => {
    const payload = successPayload({
      usage: { prompt_tokens: 11, completion_tokens: 4 },
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));

    const result = await makeV2Adapter(fetchMock).complete(makeV2Request(), callOptions());

    expect(result.usage).toMatchObject({
      inputTotalTokens: 11,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: null,
      inputStandardTokens: 11,
      outputTokens: 4,
      reasoningTokens: null,
      cacheUsageReporting: "unavailable",
      usageComplete: true,
    });
  });

  it.each([
    ["missing choices", { choices: [] }],
    ["non-string content", { choices: [{ message: { content: null } }] }],
    ["empty content", { choices: [{ message: { content: "" }, finish_reason: "stop" }] }],
  ])("preserves valid billable usage when content is %s", async (_label, malformed) => {
    const payload = {
      id: "chatcmpl-billable-invalid",
      model: DEEPSEEK_POLISH_MODEL,
      ...malformed,
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        prompt_cache_hit_tokens: 4,
        prompt_cache_miss_tokens: 8,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));

    const result = await makeV2Adapter(fetchMock).complete(makeV2Request(), callOptions());

    expect(result.text).toBe("");
    expect(result.usage).toMatchObject({
      inputTotalTokens: 12,
      inputCacheReadTokens: 4,
      inputStandardTokens: 8,
      outputTokens: 3,
      usageComplete: true,
    });
    expect(result.route.providerRequestId).toBe("chatcmpl-billable-invalid");
    expect(result.finishReason).toBe(_label === "empty content" ? "stop" : "unknown");
  });

  it("keeps unsafe upstream observation strings out of the normalized route", async () => {
    const response = new Response(
      JSON.stringify(
        successPayload({
          id: "Bearer secret",
          model: "bad\nmodel",
        }),
      ),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-request-id": "Bearer secret",
        },
      },
    );
    const fetchMock = vi.fn().mockResolvedValue(response);

    const result = await makeV2Adapter(fetchMock).complete(makeV2Request(), callOptions());

    expect(result.route).toEqual({
      actualUpstreamEndpoint: "https://api.deepseek.com/chat/completions",
      actualModelId: DEEPSEEK_POLISH_MODEL,
    });
  });

  it.each([
    ["missing usage", undefined],
    ["fractional total", { prompt_tokens: 1.5, completion_tokens: 2 }],
    [
      "over-explained input",
      {
        prompt_tokens: 4,
        completion_tokens: 2,
        prompt_cache_hit_tokens: 3,
        prompt_cache_miss_tokens: 2,
      },
    ],
    [
      "reasoning exceeds output",
      {
        prompt_tokens: 4,
        completion_tokens: 2,
        prompt_cache_hit_tokens: 1,
        prompt_cache_miss_tokens: 3,
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    ],
  ])("fails closed on %s instead of fabricating complete usage", async (_label, usage) => {
    const payload = successPayload();
    if (usage === undefined) delete (payload as Record<string, unknown>).usage;
    else payload.usage = usage as never;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));

    const error = await makeV2Adapter(fetchMock)
      .complete(makeV2Request(), callOptions())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeepSeekChatV1AdapterError);
    expect(error).toMatchObject({
      code: "UPSTREAM_ERROR",
      providerRequestId: "chatcmpl-test",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("createDeepSeekChatV1Adapter — safe V2 failures", () => {
  it("emits bounded 429 retry metadata without reading or leaking the raw body", async () => {
    const response = new Response("SENSITIVE-UPSTREAM-DETAIL", {
      status: 429,
      headers: { "x-request-id": "rate-limit-request-1", "retry-after": "99" },
    });
    const fetchMock = vi.fn().mockResolvedValue(response);

    const error = await makeV2Adapter(fetchMock)
      .complete(makeV2Request(), callOptions())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeepSeekChatV1AdapterError);
    expect(error).toMatchObject({
      code: "UPSTREAM_ERROR",
      upstreamStatus: 429,
      providerRequestId: "rate-limit-request-1",
      retryAfterMs: MAX_PROVIDER_RETRY_AFTER_MS,
    });
    expect(classifyProviderRetry(error as DeepSeekChatV1AdapterError)).toEqual({
      retryable: true,
      retryAfterMs: MAX_PROVIDER_RETRY_AFTER_MS,
    });
    expect((error as Error).message).not.toContain("SENSITIVE-UPSTREAM-DETAIL");
    expect(response.bodyUsed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retain a raw network error message or cause", async () => {
    const rawFailure = new TypeError("SENSITIVE-DNS-AND-SECRET");
    const fetchMock = vi.fn().mockRejectedValue(rawFailure);

    const error = await makeV2Adapter(fetchMock)
      .complete(makeV2Request(), callOptions())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeepSeekChatV1AdapterError);
    expect(error).toMatchObject({ code: "UPSTREAM_ERROR" });
    expect((error as Error).message).not.toContain("SENSITIVE-DNS-AND-SECRET");
    expect((error as Error).cause).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves a safe header request id when a successful body is malformed JSON", async () => {
    const response = new Response("not-json-SENSITIVE", {
      status: 200,
      headers: { "x-request-id": "json-failure-request-3" },
    });
    const fetchMock = vi.fn().mockResolvedValue(response);

    const error = await makeV2Adapter(fetchMock)
      .complete(makeV2Request(), callOptions())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeepSeekChatV1AdapterError);
    expect(error).toMatchObject({
      code: "UPSTREAM_ERROR",
      providerRequestId: "json-failure-request-3",
    });
    expect((error as Error).message).not.toContain("not-json-SENSITIVE");
  });

  it("maps its hard timeout without an internal retry", async () => {
    const fetchMock = pendingUntilAbortFetch();

    const error = await makeV2Adapter(fetchMock)
      .complete(makeV2Request(), callOptions(30))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeepSeekChatV1AdapterError);
    expect(error).toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows caller cancellation as-is before and during transmission", async () => {
    const preFetch = vi.fn().mockResolvedValue(jsonResponse(successPayload()));
    const pre = new AbortController();
    pre.abort();
    const preError = await makeV2Adapter(preFetch)
      .complete(makeV2Request(), { signal: pre.signal, timeoutMs: 1000 })
      .catch((caught: unknown) => caught);
    expect(preError).toBe(pre.signal.reason);
    expect(preFetch).not.toHaveBeenCalled();

    const midFetch = pendingUntilAbortFetch();
    const mid = new AbortController();
    const customReason = new Error("caller canceled");
    const pending = makeV2Adapter(midFetch).complete(makeV2Request(), {
      signal: mid.signal,
      timeoutMs: 60_000,
    });
    mid.abort(customReason);
    await expect(pending).rejects.toBe(customReason);
    expect(midFetch).toHaveBeenCalledTimes(1);
  });
});
