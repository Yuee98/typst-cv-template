import { describe, expect, it, vi } from "vitest";
import { createGeminiInteractionsTransport, GeminiInteractionsAdapterError } from "./gemini";
import { prepareProvider } from "./provider";
import { fixtureExecutionConfiguration } from "./fixtures";
import { usageForDatabase } from "./accounting";
import { POLISH_STABLE_PROMPT_BLOCK_ID, POLISH_VARIABLE_PROMPT_BLOCK_ID } from "./prompt";
import type { PolishInferenceRequest } from "./inference";

const endpoint = "https://generativelanguage.googleapis.com/v1/interactions", model = "gemini-3.8-flash";
const text = '{"items":[{"id":"i0","polished":"Improved service reliability."}]}';
function request(): PolishInferenceRequest {
  return {
    schemaVersion: "polish_inference_request",
    prompt: { blocks: [
      { id: POLISH_STABLE_PROMPT_BLOCK_ID, role: "developer", stability: "stable", content: "Polish wording and return JSON." },
      { id: POLISH_VARIABLE_PROMPT_BLOCK_ID, role: "user", stability: "variable", content: "Improve service reliability." }
    ], explicitCacheBoundaryAfter: POLISH_STABLE_PROMPT_BLOCK_ID },
    outputContract: { kind: "json_object", schemaName: "polish_items_v1", schema: {} },
    providerSubjectId: "a".repeat(64), maxOutputTokens: 256, promptVersion: "test", validatorVersion: "test", language: "en", targets: [{ id: "i0", text: "Improve service reliability." }]
  };
}
function payload(patch: Record<string, unknown> = {}) {
  return {
    id: "v1_fixture_interaction", object: "interaction", model, status: "completed",
    steps: [{ type: "thought", signature: "private-signature", summary: [{ type: "text", text: "Private thought summary." }] }, { type: "model_output", content: [{ type: "text", text }] }],
    usage: { total_input_tokens: 100, total_output_tokens: 7, total_thought_tokens: 5, total_cached_tokens: 20, total_tool_use_tokens: 0, total_tokens: 112 },
    ...patch
  };
}
function adapter(fetchImpl: typeof fetch) { return createGeminiInteractionsTransport({ endpoint, modelId: model, apiKey: "synthetic-google-key", fetch: fetchImpl }); }
function complete(fetchImpl: typeof fetch, input = request()) { return adapter(fetchImpl).complete(input, { signal: new AbortController().signal, timeoutMs: 1000 }); }
describe("Google Gemini Interactions", () => {
  it("sends the exact stable v1 stateless request with structured JSON and no subject/history/tools", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(payload()));
    const result = await complete(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(endpoint);
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { "x-goog-api-key": "synthetic-google-key", "Content-Type": "application/json", Accept: "application/json" } });
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      model, system_instruction: request().prompt.blocks[0].content, input: request().prompt.blocks[1].content,
      stream: false, store: false, background: false,
      generation_config: { thinking_level: "low", thinking_summaries: "none", max_output_tokens: 256 },
      response_format: { type: "text", mime_type: "application/json", schema: {
        type: "object", properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, polished: { type: "string" } }, required: ["id", "polished"], additionalProperties: false } } }, required: ["items"], additionalProperties: false
      } }
    });
    expect(String(init?.body)).not.toContain(request().providerSubjectId);
    expect(result.text).toBe(text);
    expect(result.finishReason).toBe("stop");
    expect(result.route).toMatchObject({ providerRequestId: "v1_fixture_interaction", actualUpstreamEndpoint: endpoint, actualModelId: model });
  });
  it("dispatches a database-configured Gemini connection through Interactions", async () => {
    const profile = { ...fixtureExecutionConfiguration(3), model_id: model }, fetchImpl = vi.fn<typeof fetch>(async () => Response.json(payload()));
    const provider = prepareProvider(profile, { AI_PROVIDER_KEY_FIXTURE_3: "synthetic-google-key" }, fetchImpl);
    expect((await provider.complete(request(), { signal: new AbortController().signal, timeoutMs: 1000 })).text).toBe(text);
    expect(fetchImpl.mock.calls[0][0]).toBe(endpoint);
  });
  it("normalizes visible output plus thinking into one billed output bucket", async () => {
    const result = await complete(async () => Response.json(payload()));
    expect(result.usage).toEqual({ schemaVersion: "normalized_usage", inputTotalTokens: 100, inputCacheReadTokens: 20, inputCacheWriteTokens: null, inputStandardTokens: 80, outputTokens: 12, reasoningTokens: 5, cacheUsageReporting: "unavailable", usageComplete: true });
    expect(usageForDatabase(result.usage)).toEqual({ input_total: "100", cache_read: "20", cache_write: null, input_standard: "80", output: "12", reasoning: "5" });
  });
  it("ignores known thought steps but concatenates only text from model outputs", async () => {
    const result = await complete(async () => Response.json(payload({ steps: [{ type: "thought", signature: "private" }, { type: "model_output", content: [{ type: "text", text: text.slice(0, 12) }] }, { type: "model_output", content: [{ type: "text", text: text.slice(12) }] }] })));
    expect(result.text).toBe(text);
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it.each(["failed", "cancelled", "in_progress", "requires_action", "requires_continuation", "unexpected"])("does not report status %s as success and preserves known usage", async status => {
    const result = await complete(async () => Response.json(payload({ status })));
    expect(result.finishReason).toBe("unknown");
    expect(result.usage.outputTokens).toBe(12);
  });
  it("preserves thinking costs when the token limit leaves no visible text", async () => {
    const result = await complete(async () => Response.json(payload({ status: "incomplete", steps: [{ type: "thought", signature: "private" }], usage: { ...payload().usage, total_output_tokens: 0, total_tokens: 105 } })));
    expect(result.finishReason).toBe("length");
    expect(result.text).toBe("");
    expect(result.usage.outputTokens).toBe(5);
    expect(result.usage.reasoningTokens).toBe(5);
  });
  it.each([
    { steps: [] }, { steps: [{ type: "function_call", name: "unexpected" }] }, { steps: [{ type: "model_output", content: [{ type: "image", data: "private" }] }] }, { steps: [{ type: "model_output", content: [{ type: "text", text: 42 }] }] }, { steps: [{ type: "unknown_step" }] }
  ])("rejects unsupported output steps without erasing reported usage: %j", async ({ steps }) => {
    const result = await complete(async () => Response.json(payload({ steps })));
    expect(result.finishReason).toBe("unknown");
    expect(result.text).toBe("");
    expect(result.usage.inputTotalTokens).toBe(100);
  });
  it("does not read OpenAI Responses output as an Interactions response", async () => {
    const result = await complete(async () => Response.json(payload({ object: "response", steps: undefined, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] })));
    expect(result.finishReason).toBe("unknown");
    expect(result.text).toBe("");
  });
  it("does not accept completed responses carrying diagnostic errors and retains usage", async () => {
    const result = await complete(async () => Response.json(payload({ errors: [{ code: "platform-error", message: "private-diagnostic-message" }] })));
    expect(result.finishReason).toBe("unknown");
    expect(result.text).toBe("");
    expect(result.usage.outputTokens).toBe(12);
    expect(JSON.stringify(result)).not.toContain("private-diagnostic-message");
  });
  it("accepts an explicitly empty diagnostic errors list", async () => {
    expect((await complete(async () => Response.json(payload({ errors: [] })))).finishReason).toBe("stop");
  });
  it.each([null, {}])("rejects a malformed diagnostic errors list: %j", async errors => {
    expect((await complete(async () => Response.json(payload({ errors })))).finishReason).toBe("unknown");
  });
  it.each(["models/another-gemini", "", "private/model\nidentifier"])("rejects an explicit model mismatch while retaining settlement facts: %j", async reportedModel => {
    const result = await complete(async () => Response.json(payload({ model: reportedModel }), { headers: { "x-goog-request-id": "safe-google-request" } }));
    expect(result.text).toBe("");
    expect(result.finishReason).toBe("unknown");
    expect(result.usage).toEqual({ schemaVersion: "normalized_usage", inputTotalTokens: 100, inputCacheReadTokens: 20, inputCacheWriteTokens: null, inputStandardTokens: 80, outputTokens: 12, reasoningTokens: 5, cacheUsageReporting: "unavailable", usageComplete: true });
    expect(usageForDatabase(result.usage)).toEqual({ input_total: "100", cache_read: "20", cache_write: null, input_standard: "80", output: "12", reasoning: "5" });
    expect(result.route).toMatchObject({ providerRequestId: "v1_fixture_interaction", gatewayRequestId: "safe-google-request", actualUpstreamEndpoint: endpoint });
    expect(result.route.actualModelId).toBeUndefined();
  });
  it("keeps an absent model observation unknown without discarding an otherwise valid response", async () => {
    const result = await complete(async () => Response.json(payload({ model: undefined })));
    expect(result.text).toBe(text);
    expect(result.finishReason).toBe("stop");
    expect(result.route.actualModelId).toBeUndefined();
  });
  it.each(["total_input_tokens", "total_output_tokens", "total_thought_tokens", "total_cached_tokens", "total_tool_use_tokens", "total_tokens"])("does not replace missing %s with zero", async field => {
    await expect(complete(async () => Response.json(payload({ usage: { ...payload().usage, [field]: undefined } })))).rejects.toBeInstanceOf(GeminiInteractionsAdapterError);
  });
  it.each([
    { total_cached_tokens: 101 }, { total_thought_tokens: -1 }, { total_thought_tokens: "5" }, { total_input_tokens: 1.5 }, { total_output_tokens: Number.MAX_SAFE_INTEGER }, { total_tokens: 111 }, { total_tool_use_tokens: 1 }
  ])("rejects malformed, nonconserving or unsupported-tool usage: %j", async change => {
    await expect(complete(async () => Response.json(payload({ usage: { ...payload().usage, ...change } })))).rejects.toBeInstanceOf(GeminiInteractionsAdapterError);
  });
  it.each([0, 65537, 1.5])("does not transmit an invalid output budget %s", async maxOutputTokens => {
    const fetchImpl = vi.fn(), beforeSend = vi.fn();
    const transport = createGeminiInteractionsTransport({ endpoint, modelId: model, apiKey: "synthetic-key", fetch: fetchImpl, beforeSend });
    await expect(transport.complete({ ...request(), maxOutputTokens }, { signal: new AbortController().signal, timeoutMs: 1000 })).rejects.toMatchObject({ retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(beforeSend).not.toHaveBeenCalled();
  });
  it("honors caller cancellation without starting a request", async () => {
    const fetchImpl = vi.fn(), controller = new AbortController(), reason = new Error("stopped");
    controller.abort(reason);
    await expect(adapter(fetchImpl).complete(request(), { signal: controller.signal, timeoutMs: 1000 })).rejects.toBe(reason);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("normalizes timeout without retaining private transport causes", async () => {
    const timeout = new AbortController(), timer = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    try {
      const error = await complete(async () => { timeout.abort(); throw new Error("private-network-detail"); }).catch(error => error);
      expect(error.code).toBe("UPSTREAM_TIMEOUT");
      expect(error.message).not.toContain("private-network-detail");
      expect(error.cause).toBeUndefined();
    } finally { timer.mockRestore(); }
  });
  it("rejects redirected targets after a single fetch", async () => {
    const response = Response.json(payload());
    Object.defineProperty(response, "url", { value: "https://untrusted.invalid/redirect" });
    const fetchImpl = vi.fn<typeof fetch>(async () => response);
    await expect(complete(fetchImpl)).rejects.toMatchObject({ retryable: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("exposes only safe HTTP metadata and bounded numeric Retry-After", async () => {
    const error = await complete(async () => new Response("private-body", { status: 429, headers: { "retry-after": "60", "x-goog-request-id": "safe-fixture" } })).catch(error => error);
    expect(error).toMatchObject({ upstreamStatus: 429, retryAfterMs: 5000, providerRequestId: "safe-fixture" });
    expect(error.message).not.toContain("private-body");
  });
});
