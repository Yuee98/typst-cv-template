import { describe, expect, it, vi } from "vitest";

import { polishErrorResponseSchema } from "@/lib/polish/contract";
import {
  isPolishDeploymentEnabled,
  withPolishDeploymentGate,
} from "./deployment-gate";
import { POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS } from "./lifecycle-http";

describe("AI polish deployment gate", () => {
  it.each([undefined, "", "false", "TRUE", "1"])(
    "treats %j as disabled",
    (value) => {
      expect(isPolishDeploymentEnabled(value)).toBe(false);
    },
  );

  it("enables only the exact string true", () => {
    expect(isPolishDeploymentEnabled("true")).toBe(true);
  });

  it("returns a fixed no-store 503 without reading the request or calling downstream", async () => {
    const downstream = vi.fn(async () => new Response(null, { status: 204 }));
    const request = new Request("https://test.local/api/polish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ private: "must-not-be-read" }),
    });
    const handler = withPolishDeploymentGate(
      false,
      downstream,
      () => "deployment-disabled-request-id",
    );

    const response = await handler(request);

    expect(downstream).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-request-id")).toBe("deployment-disabled-request-id");
    expect(response.headers.get("retry-after")).toBe(
      String(POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS),
    );
    expect(polishErrorResponseSchema.parse(await response.json())).toEqual({
      requestId: "deployment-disabled-request-id",
      error: {
        code: "AI_DISABLED",
        message: "AI polish is not available.",
        retryAfterSeconds: POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS,
      },
    });
  });

  it("delegates the original request unchanged when enabled", async () => {
    const request = new Request("https://test.local/api/polish/quota");
    const expected = new Response(null, { status: 204 });
    const downstream = vi.fn(async () => expected);
    const handler = withPolishDeploymentGate(true, downstream);

    expect(handler).toBe(downstream);
    await expect(handler(request)).resolves.toBe(expected);
    expect(downstream).toHaveBeenCalledOnce();
    expect(downstream).toHaveBeenCalledWith(request);
  });
});
