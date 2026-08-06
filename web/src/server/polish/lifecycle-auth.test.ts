import { describe, expect, it, vi } from "vitest";
import { POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS } from "./lifecycle";
import { postRequest, echoSuccess, makeDeps, handlersOf, expectErrorShape } from "./lifecycle-fixtures";

describe("POST /api/polish — deployment switch and auth", () => {
  it("503 AI_DISABLED when the deployment switch is off, before any auth work", async () => {
    const mocks = makeDeps([echoSuccess], { aiPolishEnabled: false });
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 503, "AI_DISABLED");
    expect(response.headers.get("retry-after")).toBe(
      String(POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS),
    );
    expect(mocks.verifyAccessToken).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("401 UNAUTHORIZED without an Authorization header", async () => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(postRequest({ token: null }));

    await expectErrorShape(response, 401, "UNAUTHORIZED");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("401 UNAUTHORIZED for an invalid/expired token", async () => {
    const mocks = makeDeps();
    const response = await handlersOf(mocks).POST(postRequest({ token: "wrong-token" }));

    await expectErrorShape(response, 401, "UNAUTHORIZED");
    expect(mocks.verifyAccessToken).toHaveBeenCalledWith("wrong-token");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("403 AI_TERMS_REQUIRED when the current AI terms are not accepted", async () => {
    const mocks = makeDeps([echoSuccess], {
      hasAcceptedCurrentAiTerms: vi.fn(async () => false),
    });
    const response = await handlersOf(mocks).POST(postRequest());

    await expectErrorShape(response, 403, "AI_TERMS_REQUIRED");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
});

