import { afterEach, describe, expect, it, vi } from "vitest";
import { reportProviderFailure, type ProviderFailureContext } from "./provider-diagnostics";

const context: ProviderFailureContext = {
  config_id: "3",
  adapter_id: 2,
  request_id: "req_0123456789AB",
  attempt_no: 1,
  transmitted: true,
  retryable: false
};

afterEach(() => vi.restoreAllMocks());

describe("provider failure diagnostics", () => {
  it.each([[401, false, "HTTP_TERMINAL"], [403, false, "HTTP_TERMINAL"], [429, true, "HTTP_RETRYABLE"]] as const)("records HTTP %s without upstream content", (status, retryable, classification) => {
    const logger = vi.fn();
    reportProviderFailure({ ...context, retryable }, { upstreamStatus: status, message: "PRIVATE_PROVIDER_MESSAGE", body: "PRIVATE_CV_BODY", headers: { "api-key": "PRIVATE_KEY" } }, logger);
    expect(logger).toHaveBeenCalledExactlyOnceWith({ event: "provider_attempt_failure", ...context, retryable, http_status: status, class: classification });
    expect(JSON.stringify(logger.mock.calls)).not.toContain("PRIVATE_");
  });

  it.each([100, 599])("accepts only a bounded integer HTTP status (%s)", upstreamStatus => {
    const logger = vi.fn();
    reportProviderFailure(context, { upstreamStatus }, logger);
    expect(logger.mock.calls[0][0].http_status).toBe(upstreamStatus);
  });

  it.each([undefined, null, "403", 0, 99, 600, 403.5, Number.NaN, Number.POSITIVE_INFINITY])("never coerces an invalid HTTP status (%s)", upstreamStatus => {
    const logger = vi.fn();
    reportProviderFailure(context, { upstreamStatus }, logger);
    expect(logger).toHaveBeenCalledExactlyOnceWith({ event: "provider_attempt_failure", ...context, http_status: null, class: "NO_HTTP_UNKNOWN" });
  });

  it("distinguishes a pre-transmit failure without inventing an HTTP status", () => {
    const logger = vi.fn();
    reportProviderFailure({ ...context, transmitted: false, retryable: true }, new Error("PRIVATE_DNS_DETAILS"), logger);
    expect(logger).toHaveBeenCalledExactlyOnceWith({ event: "provider_attempt_failure", ...context, transmitted: false, retryable: true, http_status: null, class: "PRE_TRANSMIT_ERROR" });
  });

  it.each([
    { config_id: "0" }, { config_id: "9223372036854775808" }, { config_id: "3\nPRIVATE_KEY" },
    { adapter_id: "2" }, { adapter_id: 4 }, { request_id: "PRIVATE_USER_ID" },
    { attempt_no: 3 }, { transmitted: "true" }, { retryable: "false" }
  ])("omits diagnostics with invalid primitive context: %j", invalid => {
    const logger = vi.fn();
    reportProviderFailure({ ...context, ...invalid } as unknown as ProviderFailureContext, { upstreamStatus: 403 }, logger);
    expect(logger).not.toHaveBeenCalled();
  });

  it("supports the largest database identifier and the second attempt", () => {
    const logger = vi.fn();
    reportProviderFailure({ ...context, config_id: "9223372036854775807", adapter_id: 3, attempt_no: 2 }, { upstreamStatus: 403 }, logger);
    expect(logger.mock.calls[0][0]).toMatchObject({ config_id: "9223372036854775807", adapter_id: 3, attempt_no: 2 });
  });

  it("never invokes an upstream getter, toJSON or unrelated property", () => {
    const getter = vi.fn(() => { throw new Error("PRIVATE_GETTER"); });
    const toJSON = vi.fn(() => { throw new Error("PRIVATE_JSON"); });
    const error = Object.defineProperties({}, { upstreamStatus: { get: getter }, message: { get: getter }, cause: { get: getter }, toJSON: { value: toJSON } });
    const logger = vi.fn();
    expect(() => reportProviderFailure(context, error, logger)).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledExactlyOnceWith({ event: "provider_attempt_failure", ...context, http_status: null, class: "NO_HTTP_UNKNOWN" });
  });

  it("never invokes context getters or serializes extra context properties", () => {
    const getter = vi.fn(() => "PRIVATE_USER_ID");
    const toJSON = vi.fn(() => ({ secret: "PRIVATE_KEY" }));
    const logger = vi.fn();
    const input = Object.defineProperty({ ...context, body: "PRIVATE_CV_BODY", endpoint: "PRIVATE_URL", toJSON }, "request_id", { get: getter });
    expect(() => reportProviderFailure(input, { upstreamStatus: 403 }, logger)).not.toThrow();
    expect(logger).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    const extraContext = { ...context, body: "PRIVATE_CV_BODY", endpoint: "PRIVATE_URL", toJSON };
    reportProviderFailure(extraContext, { upstreamStatus: 403 }, logger);
    expect(toJSON).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.mock.calls)).not.toContain("PRIVATE_");
    expect(Object.keys(logger.mock.calls[0][0]).sort()).toEqual(["event", "config_id", "adapter_id", "request_id", "attempt_no", "transmitted", "http_status", "retryable", "class"].sort());
  });

  it.each(["error", "context"] as const)("contains throwing %s Proxy descriptor traps", where => {
    const malicious = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("PRIVATE_PROXY_DETAILS"); } });
    const logger = vi.fn();
    expect(() => reportProviderFailure(where === "context" ? malicious as ProviderFailureContext : context, where === "error" ? malicious : { upstreamStatus: 403 }, logger)).not.toThrow();
    expect(logger).not.toHaveBeenCalled();
  });

  it("uses a fixed JSON server warning by default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportProviderFailure(context, { upstreamStatus: 403, toJSON() { return { key: "PRIVATE_KEY" }; } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toHaveLength(1);
    expect(JSON.parse(warn.mock.calls[0][0])).toEqual({ event: "provider_attempt_failure", ...context, http_status: 403, class: "HTTP_TERMINAL" });
  });

  it("does not let a throwing logger interrupt its caller", () => {
    const logger = vi.fn(() => { throw new Error("PRIVATE_LOGGER_FAILURE"); });
    expect(() => reportProviderFailure(context, { upstreamStatus: 403 }, logger)).not.toThrow();
    expect(logger).toHaveBeenCalledTimes(1);
  });

  it("also contains a failure from the default server warning", () => {
    vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("PRIVATE_CONSOLE_FAILURE"); });
    expect(() => reportProviderFailure(context, { upstreamStatus: 403 })).not.toThrow();
  });
});
