import { describe, expect, it, vi } from "vitest";
import fixtures from "../../../test/fixtures/profile-execution-v2.json";
import mimoResponse from "../../../test/fixtures/mimo-responses/success.json";
import { createPreparedDeepSeekChatAdapter } from "./deepseek";
import { createPreparedMimoResponsesAdapter } from "./mimo";
import { prepareProviderTransportV2 } from "./provider-binding-v2";
import { buildPolishPromptBlocks, POLISH_PROMPT_VERSION } from "./prompt";
import type { PolishInferenceRequestV2 } from "./inference-v2";
import { calculateEstimatedCost } from "./pricing";

function request(): PolishInferenceRequestV2 {
  return {
    schemaVersion: "polish_inference_request_v2",
    prompt: buildPolishPromptBlocks({ language: "en", sectionId: "experience", granularity: "item",
      items: [{ id: "i0", kind: "experience_bullet", text: "Led the migration." }], contextLevel: 0, references: [], stylePreset: "professional" }),
    outputContract: { kind: "json_object", schemaName: "polish_items_v1", schema: {} },
    maxOutputTokens: 1024, providerSubjectId: "pseudonymous-subject", promptVersion: POLISH_PROMPT_VERSION,
    validatorVersion: "polish-validator-v1", language: "en", targets: [{ id: "i0", text: "internal-only-target" }],
  };
}
const price = {
  schemaVersion: "price_snapshot_v1" as const, priceVersionId: "test-price", currency: "CNY", calculatorKind: "linear_token_v1" as const,
  components: { input_standard: "1000000000", input_cache_read: "500000000", input_cache_write: "0", output: "2000000000" }, parameters: {},
};

describe.each(["deepseek", "mimo"] as const)("prepared %s transport", kind => {
  const fixture = fixtures[kind];
  // Accepted scalar boundary includes slashes and identifiers beyond the old
  // registry's observation length. No real Provider capability is asserted.
  const modelId = "synthetic/" + "m".repeat(150);
  function prepared() {
    return prepareProviderTransportV2({
      profile: { ...fixture, modelId }, recipient: { providerId: fixture.providerId, recipientKey: kind === "deepseek" ? "deepseek" : "xiaomi-mimo" },
      manifest: { schemaVersion: "ai_provider_bindings_v1", revision: "test-binding", bindings: [{
        credentialEnvName: fixture.credentialEnvName, providerId: fixture.providerId,
        recipientKey: kind === "deepseek" ? "deepseek" : "xiaomi-mimo", origin: new URL(fixture.endpointUrl).origin,
      }] }, expectedManifestRevision: "test-binding", runtimeBuildId: "test-build", resolveSecret: () => "fake-key",
    });
  }
  const create = kind === "deepseek" ? createPreparedDeepSeekChatAdapter : createPreparedMimoResponsesAdapter;
  const options = () => ({ signal: new AbortController().signal, timeoutMs: 1000 });
  const payload = () => kind === "deepseek" ? {
    model: modelId, id: "chat-test-id", choices: [{ message: { content: '{"items":[]}' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 3, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 },
  } : { ...mimoResponse, model: modelId };

  it("uses frozen model/endpoint/key in the real builder and normalizes usage/cost", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload()));
    const result = await create(prepared(), fetchMock).complete(request(), options());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(fixture.endpointUrl);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get(kind === "deepseek" ? "Authorization" : "api-key"))
      .toBe(kind === "deepseek" ? "Bearer fake-key" : "fake-key");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(modelId);
    expect(String(init?.body)).not.toContain("internal-only-target");
    if (kind === "mimo") expect(body).not.toHaveProperty("user_id");
    else expect(body.user_id).toBe("pseudonymous-subject");
    expect(result.route.actualModelId).toBe(modelId);
    expect(result.route.actualUpstreamEndpoint).toBe(fixture.endpointUrl);
    expect(calculateEstimatedCost(result.usage, price)).toEqual({ status: "complete", incompleteReasons: [],
      estimatedCost: { currency: "CNY", nanos: kind === "deepseek" ? "14000" : "140000" } });
  });
  it("rejects redirects and a forged prepared object without retrying or leaking error bodies", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive-error-body", { status: 307, headers: { Location: "https://evil.test/collect" } }));
    await expect(create(prepared(), fetchMock).complete(request(), options())).rejects.toThrow(/HTTP 307/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(() => create({ ...prepared(), endpoint: "https://evil.test/collect" }, fetchMock)).toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("does not turn an unexpected upstream model into an authoritative observation", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...payload(), model: "unexpected-model" }));
    const result = await create(prepared(), fetchMock).complete(request(), options());
    expect(result.route.actualModelId).toBeUndefined();
  });
});
