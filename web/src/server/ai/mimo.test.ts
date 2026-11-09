import { describe, expect, it } from "vitest";
import { createMimoResponsesTransport } from "./mimo";
import { usageForDatabase } from "./accounting";
import { POLISH_STABLE_PROMPT_BLOCK_ID, POLISH_VARIABLE_PROMPT_BLOCK_ID } from "./prompt";
import type { PolishInferenceRequest } from "./inference";

const endpoint = "https://api.xiaomimimo.com/v1/responses", model = "configured-mimo-model";
const text = '{"items":[{"id":"i0","polished":"Improved service reliability."}]}';
function request(): PolishInferenceRequest {
  return {
    schemaVersion: "polish_inference_request",
    prompt: { blocks: [
      { id: POLISH_STABLE_PROMPT_BLOCK_ID, role: "developer", stability: "stable", content: "Polish wording and return JSON." },
      { id: POLISH_VARIABLE_PROMPT_BLOCK_ID, role: "user", stability: "variable", content: "Improve service reliability." }
    ], explicitCacheBoundaryAfter: POLISH_STABLE_PROMPT_BLOCK_ID },
    outputContract: { kind: "json_object", schemaName: "polish_items_v1", schema: {} },
    providerSubjectId: "a".repeat(64), maxOutputTokens: 128, promptVersion: "test", validatorVersion: "test", language: "en", targets: [{ id: "i0", text: "Improve service reliability." }]
  };
}
function payload(reportedModel: string | undefined = model) {
  return {
    id: "mimo-fixture-response", object: "response", model: reportedModel, status: "completed", error: null,
    output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 6, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 16 }
  };
}
async function complete(reportedModel: string | undefined) {
  return completePayload({ model: reportedModel });
}
async function completePayload(patch: Record<string, unknown>) {
  const response = { ...payload(), ...patch };
  const adapter = createMimoResponsesTransport({ endpoint, modelId: model, apiKey: "synthetic-mimo-key", fetch: async () => Response.json(response) });
  return adapter.complete(request(), { signal: new AbortController().signal, timeoutMs: 1000 });
}
describe("MiMo model observation", () => {
  it("accepts an exact reported model", async () => {
    const result = await complete(model);
    expect(result.text).toBe(text);
    expect(result.finishReason).toBe("stop");
    expect(result.route.actualModelId).toBe(model);
  });
  it.each(["another-reported-model", "", "private/model\nidentifier"])("rejects an explicit model mismatch while retaining settlement facts: %j", async reportedModel => {
    const result = await complete(reportedModel);
    expect(result.text).toBe("");
    expect(result.finishReason).toBe("unknown");
    expect(result.usage).toEqual({ schemaVersion: "normalized_usage", inputTotalTokens: 10, inputCacheReadTokens: 4, inputCacheWriteTokens: null, inputStandardTokens: 6, outputTokens: 6, reasoningTokens: 2, cacheUsageReporting: "unavailable", usageComplete: true });
    expect(usageForDatabase(result.usage)).toEqual({ input_total: "10", cache_read: "4", cache_write: null, input_standard: "6", output: "6", reasoning: "2" });
    expect(result.route).toEqual({ providerRequestId: "mimo-fixture-response", actualUpstreamEndpoint: endpoint });
  });
  it("keeps an absent model observation unknown without discarding an otherwise valid response", async () => {
    const result = await complete(undefined);
    expect(result.text).toBe(text);
    expect(result.finishReason).toBe("stop");
    expect(result.route.actualModelId).toBeUndefined();
  });
});
describe("MiMo Responses envelope and terminal output", () => {
  it.each(["chat.completion", "interaction", undefined])("rejects unsupported or missing envelope object %j and retains usage", async object => {
    const result = await completePayload({ object });
    expect(result.text).toBe("");
    expect(result.finishReason).toBe("unknown");
    expect(usageForDatabase(result.usage)).toEqual({ input_total: "10", cache_read: "4", cache_write: null, input_standard: "6", output: "6", reasoning: "2" });
    expect(result.route).toMatchObject({ providerRequestId: "mimo-fixture-response", actualUpstreamEndpoint: endpoint });
  });
  it.each(["in_progress", "incomplete"])("does not accept a completed envelope with a %s assistant message", async status => {
    const result = await completePayload({ output: [{ ...payload().output[0], status }] });
    expect(result.text).toBe("");
    expect(result.finishReason).toBe("unknown");
    expect(result.usage.outputTokens).toBe(6);
    expect(result.usage.reasoningTokens).toBe(2);
    expect(result.route.providerRequestId).toBe("mimo-fixture-response");
  });
  it.each([
    { output: undefined },
    { output: null },
    { output: [] },
    { output: [{ type: "reasoning" }] },
    { output: [{ type: "unknown_output" }] },
    { output: [{ ...payload().output[0], role: "user" }] },
    { output: [{ ...payload().output[0], content: [] }] },
    { output: [{ ...payload().output[0], content: [{ type: "output_text", text: "" }] }] },
    { output: [{ ...payload().output[0], content: [{ type: "refusal", refusal: "private-refusal" }] }] },
    { output: [payload().output[0], { type: "unknown_output" }] }
  ])("rejects empty or unsupported completed output without discarding settlement facts: %j", async patch => {
    const result = await completePayload(patch);
    expect(result.text).toBe("");
    expect(result.finishReason).toBe("unknown");
    expect(result.usage).toEqual({ schemaVersion: "normalized_usage", inputTotalTokens: 10, inputCacheReadTokens: 4, inputCacheWriteTokens: null, inputStandardTokens: 6, outputTokens: 6, reasoningTokens: 2, cacheUsageReporting: "unavailable", usageComplete: true });
    expect(result.route.providerRequestId).toBe("mimo-fixture-response");
    expect(JSON.stringify(result)).not.toContain("private-refusal");
  });
  it.each(["in_progress", "incomplete"])("retains the token-limit finish and usage of a genuinely incomplete envelope with a %s message", async status => {
    const result = await completePayload({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ ...payload().output[0], status }] });
    expect(result.finishReason).toBe("length");
    expect(result.usage.outputTokens).toBe(6);
    expect(result.route.providerRequestId).toBe("mimo-fixture-response");
  });
});
