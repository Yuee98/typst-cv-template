import { describe, expect, it, vi } from "vitest";
import { createDeepSeekResponsesTransport, DeepSeekResponsesAdapterError } from "./deepseek";
import { POLISH_STABLE_PROMPT_BLOCK_ID, POLISH_VARIABLE_PROMPT_BLOCK_ID } from "./prompt";
import type { PolishInferenceRequest } from "./inference";
const endpoint = "https://api.deepseek.com/responses";
const model = "configured-deepseek-model";
const text = '{"items":[{"id":"i0","polished":"Improved service reliability."}]}';
function request(): PolishInferenceRequest {
  return {
    schemaVersion: "polish_inference_request",
    prompt: {
      blocks: [{
        id: POLISH_STABLE_PROMPT_BLOCK_ID,
        role: "developer",
        stability: "stable",
        content: "Polish resume wording and return JSON."
      }, {
        id: POLISH_VARIABLE_PROMPT_BLOCK_ID,
        role: "user",
        stability: "variable",
        content: "Improve service reliability."
      }],
      explicitCacheBoundaryAfter: POLISH_STABLE_PROMPT_BLOCK_ID
    },
    outputContract: {
      kind: "json_object",
      schemaName: "polish_items_v1",
      schema: {}
    },
    providerSubjectId: "a".repeat(64),
    maxOutputTokens: 128,
    promptVersion: "test",
    validatorVersion: "test",
    language: "en",
    targets: [{
      id: "i0",
      text: "Improve service reliability."
    }]
  };
}
function payload(patch: Record<string, unknown> = {}) {
  return {
    id: "response-fixture-1",
    object: "response",
    model,
    status: "completed",
    error: null,
    store: false,
    output: [{
      type: "reasoning",
      content: [{
        type: "reasoning_text",
        text: "Do not include this in the answer."
      }]
    }, {
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        text
      }]
    }],
    usage: {
      input_tokens: 10,
      input_tokens_details: {
        cached_tokens: 4
      },
      output_tokens: 6,
      output_tokens_details: {
        reasoning_tokens: 2
      },
      total_tokens: 16
    },
    ...patch
  };
}
function adapter(fetchImpl: typeof fetch) {
  return createDeepSeekResponsesTransport({
    endpoint,
    modelId: model,
    apiKey: "synthetic-key",
    fetch: fetchImpl
  });
}
function complete(fetchImpl: typeof fetch, value = request()) {
  return adapter(fetchImpl).complete(value, {
    signal: new AbortController().signal,
    timeoutMs: 1000
  });
}
describe("DeepSeek Responses protocol", () => {
  it("sends only the documented stateless Responses fields with the HMAC subject", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(payload()));
    const value = request();
    const result = await complete(fetchImpl, value);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(endpoint);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: "Bearer synthetic-key",
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model,
      instructions: value.prompt.blocks[0].content,
      input: value.prompt.blocks[1].content,
      max_output_tokens: 128,
      stream: false,
      reasoning: {
        effort: "none"
      },
      text: {
        format: {
          type: "json_object"
        }
      },
      user: "a".repeat(64)
    });
    expect(result.text).toBe(text);
    expect(result.finishReason).toBe("stop");
    expect(result.route).toMatchObject({
      providerRequestId: "response-fixture-1",
      actualUpstreamEndpoint: endpoint,
      actualModelId: model
    });
  });
  it("normalizes reported cache reads and counts reasoning within output exactly once", async () => {
    const result = await complete(async () => Response.json(payload()));
    expect(result.usage).toEqual({
      schemaVersion: "normalized_usage",
      inputTotalTokens: 10,
      inputCacheReadTokens: 4,
      inputCacheWriteTokens: null,
      inputStandardTokens: 6,
      outputTokens: 6,
      reasoningTokens: 2,
      cacheUsageReporting: "unavailable",
      usageComplete: true
    });
  });
  it("preserves an absent reasoning breakdown as unknown", async () => {
    const usage = {
      ...payload().usage,
      output_tokens_details: undefined
    };
    expect((await complete(async () => Response.json(payload({
      usage
    })))).usage.reasoningTokens).toBeNull();
  });
  it("concatenates output text parts and does not return reasoning items", async () => {
    const output = [{
      type: "reasoning"
    }, {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{
        type: "output_text",
        text: text.slice(0, 20)
      }, {
        type: "output_text",
        text: text.slice(20)
      }]
    }];
    expect((await complete(async () => Response.json(payload({
      output
    })))).text).toBe(text);
  });
  it.each([["max_output_tokens", "length"], ["content_filter", "content_filter"]])("maps incomplete reason %s to %s", async (reason, finishReason) => {
    expect((await complete(async () => Response.json(payload({
      status: "incomplete",
      incomplete_details: {
        reason
      }
    })))).finishReason).toBe(finishReason);
  });
  it.each([["max_output_tokens", "length"], ["content_filter", "content_filter"]])("preserves incomplete reason %s even without visible output", async (reason, finishReason) => {
    const result = await complete(async () => Response.json(payload({
      status: "incomplete",
      incomplete_details: {
        reason
      },
      output: []
    })));
    expect(result.finishReason).toBe(finishReason);
    expect(result.text).toBe("");
    expect(result.usage.outputTokens).toBe(6);
  });
  it.each([{
    status: "failed",
    error: {
      code: "provider-failure",
      message: "upstream-private-text"
    }
  }, {
    status: "in_progress"
  }, {
    status: "unexpected"
  }, {
    output: []
  }, {
    output: [{
      type: "function_call",
      name: "unexpected-tool"
    }]
  }, {
    output: [{
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [{
        type: "output_text",
        text
      }]
    }]
  }, {
    output: [{
      type: "message",
      role: "user",
      status: "completed",
      content: [{
        type: "output_text",
        text
      }]
    }]
  }, {
    object: "chat.completion",
    choices: [{
      message: {
        content: text
      }
    }]
  }])("does not report malformed or nonterminal output as a successful completion: %j", async patch => {
    const result = await complete(async () => Response.json(payload(patch)));
    expect(result.finishReason).toBe("unknown");
    expect(result.usage.inputTotalTokens).toBe(10);
  });
  it.each(["another-reported-model", "", "private/model\nidentifier"])("rejects an explicit model mismatch while retaining settlement facts: %j", async reportedModel => {
    const result = await complete(async () => Response.json(payload({
      model: reportedModel
    }), { headers: { "x-request-id": "safe-header-request" } }));
    expect(result.text).toBe("");
    expect(result.finishReason).toBe("unknown");
    expect(result.usage).toEqual({
      schemaVersion: "normalized_usage", inputTotalTokens: 10, inputCacheReadTokens: 4, inputCacheWriteTokens: null,
      inputStandardTokens: 6, outputTokens: 6, reasoningTokens: 2, cacheUsageReporting: "unavailable", usageComplete: true
    });
    expect(result.route).toMatchObject({ providerRequestId: "response-fixture-1", gatewayRequestId: "safe-header-request", actualUpstreamEndpoint: endpoint });
    expect(result.route.actualModelId).toBeUndefined();
  });
  it("keeps an absent model observation unknown without discarding an otherwise valid response", async () => {
    const result = await complete(async () => Response.json(payload({ model: undefined })));
    expect(result.text).toBe(text);
    expect(result.finishReason).toBe("stop");
    expect(result.route.actualModelId).toBeUndefined();
  });
  it.each([{
    input_tokens: "10"
  }, {
    input_tokens: -1
  }, {
    input_tokens: 1.5
  }, {
    total_tokens: 17
  }, {
    input_tokens_details: {
      cached_tokens: 11
    }
  }, {
    input_tokens_details: {}
  }, {
    input_tokens_details: null
  }, {
    output_tokens_details: {
      reasoning_tokens: 7
    }
  }, {
    input_tokens: Number.MAX_SAFE_INTEGER,
    input_tokens_details: {
      cached_tokens: 0
    }
  }])("rejects malformed or nonconserving Responses usage: %j", async patch => {
    await expect(complete(async () => Response.json(payload({
      usage: {
        ...payload().usage,
        ...patch
      }
    })))).rejects.toBeInstanceOf(DeepSeekResponsesAdapterError);
  });
  it("rejects a Chat-style response instead of falling back to the retired protocol", async () => {
    await expect(complete(async () => Response.json({
      choices: [{
        message: {
          content: text
        },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 6,
        total_tokens: 16
      }
    }))).rejects.toBeInstanceOf(DeepSeekResponsesAdapterError);
  });
  it.each([(value: PolishInferenceRequest) => ({
    ...value,
    providerSubjectId: "raw-user-id"
  }), (value: PolishInferenceRequest) => ({
    ...value,
    maxOutputTokens: 0
  }), (value: PolishInferenceRequest) => ({
    ...value,
    maxOutputTokens: 393217
  }), (value: PolishInferenceRequest) => ({
    ...value,
    outputContract: {
      ...value.outputContract,
      kind: "json_schema" as const
    }
  }), (value: PolishInferenceRequest) => ({
    ...value,
    prompt: {
      ...value.prompt,
      explicitCacheBoundaryAfter: undefined
    }
  })])("rejects a noncanonical request before granting transmission", async mutate => {
    const fetchImpl = vi.fn(),
      beforeSend = vi.fn();
    const transport = createDeepSeekResponsesTransport({
      endpoint,
      modelId: model,
      apiKey: "synthetic-key",
      fetch: fetchImpl,
      beforeSend
    });
    await expect(transport.complete(mutate(request()), {
      signal: new AbortController().signal,
      timeoutMs: 1000
    })).rejects.toMatchObject({
      retryable: false
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(beforeSend).not.toHaveBeenCalled();
  });
  it("does not transmit when the caller already aborted", async () => {
    const fetchImpl = vi.fn(),
      controller = new AbortController(),
      reason = new Error("caller stopped");
    controller.abort(reason);
    await expect(adapter(fetchImpl).complete(request(), {
      signal: controller.signal,
      timeoutMs: 1000
    })).rejects.toBe(reason);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("distinguishes the adapter timeout without retaining transport details", async () => {
    const timeout = new AbortController();
    const timer = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    try {
      const fetchImpl: typeof fetch = async () => {
        timeout.abort();
        throw new Error("private-network-detail");
      };
      const error = await complete(fetchImpl).catch(error => error);
      expect(error).toMatchObject({
        code: "UPSTREAM_TIMEOUT"
      });
      expect(error.cause).toBeUndefined();
    } finally {
      timer.mockRestore();
    }
  });
  it("rejects unexpected response URL changes without forwarding another request", async () => {
    const response = Response.json(payload());
    Object.defineProperty(response, "url", {
      value: "https://untrusted.invalid/responses"
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => response);
    await expect(complete(fetchImpl)).rejects.toMatchObject({
      retryable: false
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("retains only safe HTTP metadata and caps numeric Retry-After for 429", async () => {
    const error = await complete(async () => new Response("private-provider-body", {
      status: 429,
      headers: {
        "retry-after": "99",
        "x-request-id": "safe-request-1"
      }
    })).catch(error => error);
    expect(error).toMatchObject({
      upstreamStatus: 429,
      retryAfterMs: 5000,
      providerRequestId: "safe-request-1"
    });
    expect(error.message).not.toContain("private-provider-body");
    expect(error.cause).toBeUndefined();
  });
  it("does not treat a 503 Retry-After header as a 429 delay", async () => {
    await expect(complete(async () => new Response("private-provider-body", {
      status: 503,
      headers: {
        "retry-after": "99"
      }
    }))).rejects.toMatchObject({
      upstreamStatus: 503,
      retryAfterMs: undefined
    });
  });
  it("omits unsafe upstream identifiers and preserves the safe gateway identifier", async () => {
    const result = await complete(async () => Response.json(payload({
      id: "unsafe id\nprivate"
    }), {
      headers: {
        "x-request-id": "safe-header-1"
      }
    }));
    expect(result.route).toMatchObject({
      providerRequestId: "safe-header-1",
      gatewayRequestId: "safe-header-1"
    });
  });
});
