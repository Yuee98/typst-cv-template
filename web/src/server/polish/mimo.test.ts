import { afterEach, describe, expect, it, vi } from "vitest";
import contentFilterFixture from "../../../test/fixtures/mimo-responses/content-filter.json";
import incompleteFixture from "../../../test/fixtures/mimo-responses/incomplete-max-output.json";
import successFixture from "../../../test/fixtures/mimo-responses/success.json";
import type { PolishInferenceRequestV2 } from "./inference-v2";
import {
  createMimoResponsesV1Adapter,
  MIMO_RESPONSES_MAX_OUTPUT_TOKENS,
  MIMO_RESPONSES_V1_ADAPTER_KIND,
  MimoResponsesV1AdapterError,
} from "./mimo";
import { classifyProviderRetry, MAX_PROVIDER_RETRY_AFTER_MS } from "./provider-error";
import { buildPolishPromptBlocks, POLISH_PROMPT_VERSION } from "./prompt";

const TEST_ENV = { MIMO_API_KEY: "test-mimo-api-key" };
const SUBJECT_SENTINEL = "subject-must-not-cross-mimo-boundary";
const TARGET_ONLY_SENTINEL = "target-only-metadata-must-not-cross-mimo-boundary";
const SCHEMA_SENTINEL = "schema-must-not-cross-prompt-only-boundary";
const OFFICIAL_ENDPOINT = "https://api.xiaomimimo.com/v1/responses";

function makeRequest(maxOutputTokens = 1024): PolishInferenceRequestV2 {
  const items = [
    { id: "i0", kind: "experience_bullet" as const, text: "Led the migration." },
  ];
  return {
    schemaVersion: "polish_inference_request_v2",
    prompt: buildPolishPromptBlocks({
      language: "en",
      sectionId: "experience",
      granularity: "item",
      items,
      contextLevel: 0,
      references: [],
      stylePreset: "professional",
    }),
    outputContract: {
      kind: "json_object",
      schemaName: "polish_items_v1",
      schema: { sentinel: SCHEMA_SENTINEL },
    },
    maxOutputTokens,
    providerSubjectId: SUBJECT_SENTINEL,
    promptVersion: POLISH_PROMPT_VERSION,
    validatorVersion: "polish-validator-v1",
    language: "en",
    targets: [{ id: "i0", text: TARGET_ONLY_SENTINEL }],
  };
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function makeAdapter(fetchImpl: typeof fetch) {
  return createMimoResponsesV1Adapter({ env: TEST_ENV, fetch: fetchImpl });
}

function callOptions(timeoutMs = 1000): { signal: AbortSignal; timeoutMs: number } {
  return { signal: new AbortController().signal, timeoutMs };
}

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
  vi.restoreAllMocks();
});

describe("createMimoResponsesV1Adapter — request authority", () => {
  it("fails closed when the registered credential is unavailable", () => {
    expect(() => createMimoResponsesV1Adapter({ env: {} })).toThrow(
      /credential mimo_api_key is unavailable/u,
    );
  });

  it("sends only the documented pay-as-you-go Responses fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(successFixture, 200, { "x-request-id": "undocumented-header-id" }),
    );
    const request = makeRequest();
    const adapter = makeAdapter(fetchMock);

    const result = await adapter.complete(request, callOptions());

    expect(adapter.kind).toBe(MIMO_RESPONSES_V1_ADAPTER_KIND);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(OFFICIAL_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("api-key")).toBe(TEST_ENV.MIMO_API_KEY);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "mimo-v2.5-pro",
      instructions: request.prompt.blocks[0].content,
      input: request.prompt.blocks[1].content,
      max_output_tokens: 1024,
      stream: false,
      reasoning: { effort: "none" },
    });
    expect(init.body as string).not.toContain(SUBJECT_SENTINEL);
    expect(init.body as string).not.toContain(TARGET_ONLY_SENTINEL);
    expect(init.body as string).not.toContain(SCHEMA_SENTINEL);
    expect(init.body as string).not.toContain("response_format");
    expect(init.body as string).not.toContain("text.format");
    // MiMo does not document an HTTP request-id header contract. Do not turn
    // an arbitrary header into route authority.
    expect(result.route).not.toHaveProperty("gatewayRequestId");
  });

  it("ignores environment base-url overrides and keeps the code-owned endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(successFixture));
    const adapter = createMimoResponsesV1Adapter({
      env: {
        ...TEST_ENV,
        MIMO_BASE_URL: "https://attacker.invalid/v1",
      },
      fetch: fetchMock,
    });

    await adapter.complete(makeRequest(), callOptions());

    expect(fetchMock).toHaveBeenCalledWith(OFFICIAL_ENDPOINT, expect.any(Object));
  });

  it.each([
    ["json_schema output", (request: PolishInferenceRequestV2) => {
      request.outputContract.kind = "json_schema";
    }],
    ["zero output budget", (request: PolishInferenceRequestV2) => {
      request.maxOutputTokens = 0;
    }],
    ["oversized output budget", (request: PolishInferenceRequestV2) => {
      request.maxOutputTokens = MIMO_RESPONSES_MAX_OUTPUT_TOKENS + 1;
    }],
    ["fractional output budget", (request: PolishInferenceRequestV2) => {
      request.maxOutputTokens = 1.5;
    }],
    ["missing stable block", (request: PolishInferenceRequestV2) => {
      request.prompt.blocks = request.prompt.blocks.slice(1);
    }],
    ["reversed prompt blocks", (request: PolishInferenceRequestV2) => {
      request.prompt.blocks.reverse();
    }],
    ["wrong cache boundary", (request: PolishInferenceRequestV2) => {
      request.prompt.explicitCacheBoundaryAfter = request.prompt.blocks[1].id;
    }],
  ])("rejects %s before transmission", async (_label, mutate) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(successFixture));
    const request = makeRequest();
    mutate(request);

    const error = await makeAdapter(fetchMock)
      .complete(request, callOptions())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MimoResponsesV1AdapterError);
    expect(error).toMatchObject({ code: "UPSTREAM_ERROR", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createMimoResponsesV1Adapter — response and usage mapping", () => {
  it("maps the golden response without assuming output[0] or top-level output_text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(successFixture));

    const result = await makeAdapter(fetchMock).complete(makeRequest(), callOptions());

    expect(result).toEqual({
      schemaVersion: "polish_inference_result_v2",
      text: '{"items":[{"id":"i0","polished":"Drove the migration."}]}',
      finishReason: "stop",
      usage: {
        schemaVersion: "normalized_usage_v2",
        inputTotalTokens: 100,
        inputCacheReadTokens: 40,
        inputCacheWriteTokens: null,
        inputStandardTokens: 60,
        outputTokens: 30,
        reasoningTokens: 5,
        cacheUsageReporting: "unavailable",
        usageComplete: true,
      },
      route: {
        providerRequestId: "resp_mimo_success_001",
        actualUpstreamEndpoint: OFFICIAL_ENDPOINT,
        actualModelId: "mimo-v2.5-pro",
      },
    });
    expect(result.text).not.toBe(successFixture.output_text);
  });

  it("aggregates output_text parts in wire order and treats missing detail buckets explicitly", async () => {
    const payload = {
      ...structuredClone(successFixture),
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "{\"items\":[" },
            { type: "output_text", text: "]}" },
          ],
        },
      ],
      usage: {
        input_tokens: 11,
        input_tokens_details: {},
        output_tokens: 4,
        total_tokens: 15,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));

    const result = await makeAdapter(fetchMock).complete(makeRequest(), callOptions());

    expect(result.text).toBe('{"items":[]}');
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
    ["missing output", undefined, "unknown"],
    ["malformed message content", [{ type: "message", content: null }], "unknown"],
    [
      "empty output text",
      [{ type: "message", content: [{ type: "output_text", text: "" }] }],
      "stop",
    ],
  ])("preserves billable usage when the model output is %s", async (_label, output, finish) => {
    const payload: Record<string, unknown> = structuredClone(successFixture);
    if (output === undefined) delete payload.output;
    else payload.output = output;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));

    const result = await makeAdapter(fetchMock).complete(makeRequest(), callOptions());

    expect(result.text).toBe("");
    expect(result.finishReason).toBe(finish);
    expect(result.usage).toMatchObject({
      inputTotalTokens: 100,
      inputCacheReadTokens: 40,
      outputTokens: 30,
      usageComplete: true,
    });
  });

  it("preserves usage but suppresses output when a 200 envelope carries an error", async () => {
    const payload = {
      ...structuredClone(successFixture),
      error: { code: "provider_error", message: "SENSITIVE PROVIDER DETAIL" },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));

    const result = await makeAdapter(fetchMock).complete(makeRequest(), callOptions());

    expect(result.text).toBe("");
    expect(result.finishReason).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("SENSITIVE PROVIDER DETAIL");
    expect(result.usage.usageComplete).toBe(true);
  });

  it.each([
    ["max-output incomplete", incompleteFixture, "length"],
    ["content-filter incomplete", contentFilterFixture, "content_filter"],
  ])("maps %s without losing observed usage", async (_label, payload, finishReason) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));

    const result = await makeAdapter(fetchMock).complete(makeRequest(), callOptions());

    expect(result.finishReason).toBe(finishReason);
    expect(result.usage.usageComplete).toBe(true);
    expect(result.route.providerRequestId).toBe(payload.id);
  });

  it.each([
    ["missing", undefined],
    ["unsafe", "Bearer secret"],
    ["control character", "resp_bad\nsecret"],
  ])("omits a %s response id from route metadata", async (_label, id) => {
    const payload: Record<string, unknown> = structuredClone(successFixture);
    if (id === undefined) delete payload.id;
    else payload.id = id;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));

    const result = await makeAdapter(fetchMock).complete(makeRequest(), callOptions());

    expect(result.route).not.toHaveProperty("providerRequestId");
    expect(result.usage.usageComplete).toBe(true);
  });

  it.each([undefined, "", "mimo-v2.5-pro\nsecret", "mimo-v2.5-pro-revision-2"])(
    "keeps actualModelId unknown for model %j",
    async (model) => {
      const payload: Record<string, unknown> = structuredClone(successFixture);
      if (model === undefined) delete payload.model;
      else payload.model = model;
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));

      const result = await makeAdapter(fetchMock).complete(makeRequest(), callOptions());

      expect(result.route).not.toHaveProperty("actualModelId");
      expect(result.route.actualUpstreamEndpoint).toBe(OFFICIAL_ENDPOINT);
    },
  );

  it.each([
    ["missing usage", undefined],
    ["fractional input", {
      input_tokens: 1.5,
      input_tokens_details: {},
      output_tokens: 2,
      output_tokens_details: {},
      total_tokens: 3.5,
    }],
    ["cache exceeds input", {
      input_tokens: 4,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens: 2,
      output_tokens_details: {},
      total_tokens: 6,
    }],
    ["total mismatch", {
      input_tokens: 4,
      input_tokens_details: {},
      output_tokens: 2,
      output_tokens_details: {},
      total_tokens: 7,
    }],
    ["reasoning exceeds output", {
      input_tokens: 4,
      input_tokens_details: {},
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 3 },
      total_tokens: 6,
    }],
    ["malformed input details", {
      input_tokens: 4,
      input_tokens_details: null,
      output_tokens: 2,
      output_tokens_details: {},
      total_tokens: 6,
    }],
  ])("fails closed on %s instead of fabricating usage", async (_label, usage) => {
    const payload: Record<string, unknown> = structuredClone(successFixture);
    if (usage === undefined) delete payload.usage;
    else payload.usage = usage;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));

    const error = await makeAdapter(fetchMock)
      .complete(makeRequest(), callOptions())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MimoResponsesV1AdapterError);
    expect(error).toMatchObject({
      code: "UPSTREAM_ERROR",
      providerRequestId: "resp_mimo_success_001",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("createMimoResponsesV1Adapter — safe failures", () => {
  it("emits bounded 429 metadata without reading or leaking the raw body", async () => {
    const response = new Response("SENSITIVE-UPSTREAM-DETAIL", {
      status: 429,
      headers: { "retry-after": "99" },
    });
    const fetchMock = vi.fn().mockResolvedValue(response);

    const error = await makeAdapter(fetchMock)
      .complete(makeRequest(), callOptions())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MimoResponsesV1AdapterError);
    expect(error).toMatchObject({
      code: "UPSTREAM_ERROR",
      upstreamStatus: 429,
      retryAfterMs: MAX_PROVIDER_RETRY_AFTER_MS,
    });
    expect(classifyProviderRetry(error as MimoResponsesV1AdapterError)).toEqual({
      retryable: true,
      retryAfterMs: MAX_PROVIDER_RETRY_AFTER_MS,
    });
    expect((error as Error).message).not.toContain("SENSITIVE-UPSTREAM-DETAIL");
    expect(response.bodyUsed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, false],
    [401, false],
    [402, false],
    [403, false],
    [404, false],
    [421, false],
    [500, true],
    [503, true],
  ])("classifies HTTP %i with retryable=%s", async (status, retryable) => {
    const response = new Response("SENSITIVE", { status });
    const fetchMock = vi.fn().mockResolvedValue(response);

    const error = await makeAdapter(fetchMock)
      .complete(makeRequest(), callOptions())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MimoResponsesV1AdapterError);
    expect(error).toMatchObject({ upstreamStatus: status });
    expect(classifyProviderRetry(error as MimoResponsesV1AdapterError).retryable).toBe(
      retryable,
    );
    expect(response.bodyUsed).toBe(false);
  });

  it("rejects redirects without following or exposing a second endpoint", async () => {
    const response = jsonResponse(successFixture);
    Object.defineProperty(response, "redirected", { value: true });
    Object.defineProperty(response, "url", { value: "https://redirect.invalid/steal" });
    const fetchMock = vi.fn().mockResolvedValue(response);

    const error = await makeAdapter(fetchMock)
      .complete(makeRequest(), callOptions())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MimoResponsesV1AdapterError);
    expect(error).toMatchObject({ code: "UPSTREAM_ERROR", retryable: false });
    expect(error).not.toHaveProperty("route");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retain a raw network error message or cause", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("SENSITIVE-DNS-SECRET"));

    const error = await makeAdapter(fetchMock)
      .complete(makeRequest(), callOptions())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MimoResponsesV1AdapterError);
    expect(error).toMatchObject({ code: "UPSTREAM_ERROR" });
    expect((error as Error).message).not.toContain("SENSITIVE-DNS-SECRET");
    expect((error as Error).cause).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retain a malformed successful response body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("not-json-SENSITIVE", { status: 200 }),
    );

    const error = await makeAdapter(fetchMock)
      .complete(makeRequest(), callOptions())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MimoResponsesV1AdapterError);
    expect(error).toMatchObject({ code: "UPSTREAM_ERROR" });
    expect((error as Error).message).not.toContain("not-json-SENSITIVE");
  });

  it("maps the adapter hard timeout without an internal retry", async () => {
    const fetchMock = pendingUntilAbortFetch();

    const error = await makeAdapter(fetchMock)
      .complete(makeRequest(), callOptions(25))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MimoResponsesV1AdapterError);
    expect(error).toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows caller cancellation as-is before and during transmission", async () => {
    const preFetch = vi.fn().mockResolvedValue(jsonResponse(successFixture));
    const pre = new AbortController();
    pre.abort();
    const preError = await makeAdapter(preFetch)
      .complete(makeRequest(), { signal: pre.signal, timeoutMs: 1000 })
      .catch((caught: unknown) => caught);
    expect(preError).toBe(pre.signal.reason);
    expect(preFetch).not.toHaveBeenCalled();

    const midFetch = pendingUntilAbortFetch();
    const mid = new AbortController();
    const reason = new Error("caller canceled");
    const pending = makeAdapter(midFetch).complete(makeRequest(), {
      signal: mid.signal,
      timeoutMs: 60_000,
    });
    mid.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(midFetch).toHaveBeenCalledTimes(1);
  });
});
