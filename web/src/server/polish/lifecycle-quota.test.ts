import { describe, expect, it, vi } from "vitest";
import { polishQuotaResponseSchema } from "@/lib/polish/contract";
import { PolishQuotaError } from "./quota";
import { POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS } from "./lifecycle";
import { VALID_TOKEN, REQUEST_ID, RESET_AT_Z, quotaRequest, makeDeps, handlersOf, expectErrorShape } from "./lifecycle-fixtures";

describe("GET /api/polish/quota", () => {
  it("200 quota shape: login checked, AI terms NOT required", async () => {
    const mocks = makeDeps([], {
      hasAcceptedCurrentAiTerms: vi.fn(async () => {
        throw new Error("must not be called by the quota route");
      }),
    });
    const response = await handlersOf(mocks).GET(quotaRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);

    const body = (await response.json()) as unknown;
    expect(polishQuotaResponseSchema.safeParse(body).success).toBe(true);
    expect((body as { requestId: string }).requestId).toBe(REQUEST_ID);
    expect((body as { quota: unknown }).quota).toEqual({ limit: 20, remaining: 19, resetAt: RESET_AT_Z });

    expect(mocks.verifyAccessToken).toHaveBeenCalledWith(VALID_TOKEN);
    expect(mocks.hasAcceptedCurrentAiTerms).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("401 UNAUTHORIZED without a token", async () => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).GET(quotaRequest({ token: null }));

    await expectErrorShape(response, 401, "UNAUTHORIZED");
    expect(mocks.getQuota).not.toHaveBeenCalled();
  });

  it("503 AI_DISABLED when the deployment switch is off", async () => {
    const mocks = makeDeps([], { aiPolishEnabled: false });
    const response = await handlersOf(mocks).GET(quotaRequest());

    await expectErrorShape(response, 503, "AI_DISABLED");
    expect(response.headers.get("retry-after")).toBe(
      String(POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS),
    );
  });

  it("500 INTERNAL_ERROR when the quota read fails", async () => {
    const mocks = makeDeps([], {
      getQuota: vi.fn(async () => {
        throw new PolishQuotaError("INTERNAL_ERROR", "get quota RPC failed");
      }),
    });
    const response = await handlersOf(mocks).GET(quotaRequest());

    await expectErrorShape(response, 500, "INTERNAL_ERROR");
  });
});

