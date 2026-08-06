import { describe, expect, it } from "vitest";
import { polishSuccessResponseSchema, type PolishRequest } from "@/lib/polish/contract";
import { POLISH_TRANSPORT_ERROR_CODES } from "./polish-errors";
import { createMockPolishClient, mockPolishText, PolishApiError } from "./polish-client";
import { makeRequest } from "./polish-client-test-fixtures";

describe("mockPolishText", () => {
  it("collapses redundant whitespace when that changes the text", () => {
    expect(mockPolishText("  padded   text  here ")).toBe("padded text here");
  });

  it("adds a visible deterministic marker otherwise", () => {
    expect(mockPolishText("主导订单系统重构。")).toBe("[mock] 主导订单系统重构。");
  });
});

describe("createMockPolishClient", () => {
  it("returns a contract-valid deterministic success", async () => {
    const client = createMockPolishClient({ delayMs: 1 });
    const result = await client.polish(makeRequest());
    expect(polishSuccessResponseSchema.safeParse(result).success).toBe(true);
    expect(result.items[0].polished).toBe("[mock] 五年后端开发经验，专注高并发分布式系统。");
    expect(result.quota.remaining).toBe(19);

    const again = await client.polish(
      makeRequest({ clientRequestId: "123e4567-e89b-42d3-a456-426614174001" }),
    );
    expect(again.items[0].polished).toBe(result.items[0].polished);
  });

  it("decrements the in-memory quota and exhausts it", async () => {
    const client = createMockPolishClient({ delayMs: 1, quotaLimit: 1 });
    const quotaBefore = await client.getQuota();
    expect(quotaBefore.quota).toMatchObject({ limit: 1, remaining: 1 });

    await client.polish(makeRequest());
    const quotaAfter = await client.getQuota();
    expect(quotaAfter.quota.remaining).toBe(0);

    const error = (await client
      .polish(makeRequest({ clientRequestId: "123e4567-e89b-42d3-a456-426614174002" }))
      .catch((e: unknown) => e)) as PolishApiError;
    expect(error.code).toBe("QUOTA_EXCEEDED");
    expect(error.resetAt).toBeDefined();
  });

  it("rejects a reused clientRequestId as DUPLICATE_REQUEST", async () => {
    const client = createMockPolishClient({ delayMs: 1 });
    await client.polish(makeRequest());
    const error = (await client.polish(makeRequest()).catch((e: unknown) => e)) as PolishApiError;
    expect(error.code).toBe("DUPLICATE_REQUEST");
    expect(error.status).toBe(409);
  });

  it("honors the FAIL_UPSTREAM and FAIL_JSON codewords", async () => {
    const client = createMockPolishClient({ delayMs: 1 });
    const upstream = (await client
      .polish(makeRequest({ styleInstruction: "FAIL_UPSTREAM" }))
      .catch((e: unknown) => e)) as PolishApiError;
    expect(upstream.code).toBe("UPSTREAM_ERROR");

    const json = (await client
      .polish(makeRequest({ styleInstruction: "FAIL_JSON" }))
      .catch((e: unknown) => e)) as PolishApiError;
    expect(json.code).toBe("INVALID_MODEL_OUTPUT");
  });

  it("rejects a malformed request as INVALID_REQUEST", async () => {
    const client = createMockPolishClient({ delayMs: 1 });
    const bad = { ...makeRequest(), granularity: "section" } as PolishRequest;
    const error = (await client.polish(bad).catch((e: unknown) => e)) as PolishApiError;
    expect(error.code).toBe("INVALID_REQUEST");
  });

  it("SLOW outlasts a caller abort and surfaces REQUEST_ABORTED", async () => {
    const client = createMockPolishClient({ delayMs: 1, slowDelayMs: 5_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const error = (await client
      .polish(makeRequest({ styleInstruction: "SLOW" }), { signal: controller.signal })
      .catch((e: unknown) => e)) as PolishApiError;
    expect(error.code).toBe(POLISH_TRANSPORT_ERROR_CODES.requestAborted);
  });
});
