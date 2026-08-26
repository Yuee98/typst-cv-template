import { describe, expect, it } from "vitest";

import type { PolishInferenceRequestV2 } from "./inference-v2";
import { createMimoResponsesV1Adapter } from "./mimo";
import { buildPolishPromptBlocks, POLISH_PROMPT_VERSION } from "./prompt";
import { POLISH_VALIDATOR_VERSION, validatePolishOutput } from "./validate";

const RUN_MIMO_LIVE_SMOKE = process.env.MIMO_LIVE_SMOKE === "1";
const LIVE_ITEMS = [
  {
    id: "live-i0",
    kind: "experience_bullet" as const,
    text: "Reduced API latency by 40% while preserving reliability.",
  },
];

function liveRequest(): PolishInferenceRequestV2 {
  return {
    schemaVersion: "polish_inference_request_v2",
    prompt: buildPolishPromptBlocks({
      language: "en",
      sectionId: "experience",
      granularity: "item",
      items: LIVE_ITEMS,
      contextLevel: 0,
      references: [],
      stylePreset: "professional",
    }),
    outputContract: {
      kind: "json_object",
      schemaName: "polish_items_v1",
      schema: {
        type: "object",
        required: ["items"],
      },
    },
    maxOutputTokens: 256,
    providerSubjectId: "synthetic-live-conformance-subject",
    promptVersion: POLISH_PROMPT_VERSION,
    validatorVersion: POLISH_VALIDATOR_VERSION,
    language: "en",
    targets: LIVE_ITEMS.map(({ id, text }) => ({ id, text })),
  };
}

describe.skipIf(!RUN_MIMO_LIVE_SMOKE)("MiMo Responses live conformance", () => {
  it(
    "returns a documented route, conserved usage and validator-accepted output",
    async () => {
      const result = await createMimoResponsesV1Adapter().complete(liveRequest(), {
        signal: new AbortController().signal,
        timeoutMs: 30_000,
      });

      expect(result.route.actualUpstreamEndpoint).toBe(
        "https://api.xiaomimimo.com/v1/responses",
      );
      expect(result.route.actualModelId).toBe("mimo-v2.5-pro");
      expect(result.route.providerRequestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
      expect(result.route).not.toHaveProperty("gatewayRequestId");
      expect(result.usage.inputTotalTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
      expect(result.usage.inputCacheReadTokens).toBeLessThanOrEqual(
        result.usage.inputTotalTokens,
      );
      expect(result.usage.inputStandardTokens + result.usage.inputCacheReadTokens).toBe(
        result.usage.inputTotalTokens,
      );
      expect(result.usage.inputCacheWriteTokens).toBeNull();
      expect(result.usage.usageComplete).toBe(true);

      const validation = validatePolishOutput(result, {
        items: LIVE_ITEMS,
        language: "en",
      });
      expect(validation.ok).toBe(true);
    },
    45_000,
  );
});
