import { EventEmitter } from "node:events";
import { request as httpsRequest } from "node:https";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createInferenceFetch, isPublicAddress, pinnedLookup, resolveEndpoint, validateEndpoint } from "./outbound";

const endpoint = "https://relay.example/custom/responses";
const init = { method: "POST", body: "{}", redirect: "error" as const };
function responseFetch(body: Buffer, headers: Record<string, string> = {}, statusCode = 200) {
  const request = vi.fn((_url: URL, _options: unknown, receive: (response: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => queueMicrotask(() => {
      const res = Object.assign(new EventEmitter(), { statusCode, headers });
      receive(res);
      res.emit("data", body);
      res.emit("end");
    });
    return req;
  });
  return createInferenceFetch({ request: request as unknown as typeof httpsRequest, resolver: async () => [{ address: "8.8.8.8", family: 4 }] });
}
describe("inference endpoint boundary", () => {
  it.each(["http://relay.example/responses", "https://user:pass@relay.example/responses", "https://relay.example/responses?key=secret", "https://relay.example/responses#fragment", "https://127.0.0.1/responses", "https://[::1]/responses", "https://169.254.169.254/latest/meta-data", "https://relay.local/responses"])("rejects unsafe URL %s", value => expect(() => validateEndpoint(value)).toThrow());
  it("accepts a custom supplier without an official-domain allowlist", () => expect(validateEndpoint(endpoint).href).toBe(endpoint));
  it.each(["0.0.0.0", "10.20.30.40", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "fc00::1", "fe80::1", "2001:0000::1", "2001:db8::1", "2002:7f00:1::1", "3fff::1"])("rejects non-public and transition address %s", value => expect(isPublicAddress(value)).toBe(false));
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])("accepts public unicast %s", value => expect(isPublicAddress(value)).toBe(true));
  it("rejects DNS with any private answer before credentials can be sent", async () => {
    const onTransmit = vi.fn(), request = vi.fn();
    const send = createInferenceFetch({ resolver: async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }], request: request as unknown as typeof httpsRequest, onTransmit });
    await expect(send(endpoint, init)).rejects.toThrow("non-public");
    expect(request).not.toHaveBeenCalled();
    expect(onTransmit).not.toHaveBeenCalled();
  });
  it("rejects an empty or contradictory DNS result", async () => {
    await expect(resolveEndpoint(endpoint, async () => [])).rejects.toThrow();
    await expect(resolveEndpoint(endpoint, async () => [{ address: "8.8.8.8", family: 6 }])).rejects.toThrow();
  });
  it("cancels an unresolved DNS lookup without starting a connection", async () => {
    const controller = new AbortController(), request = vi.fn(), onTransmit = vi.fn();
    const send = createInferenceFetch({ resolver: () => new Promise(() => {}), request: request as unknown as typeof httpsRequest, onTransmit });
    const result = send(endpoint, { ...init, signal: controller.signal });
    controller.abort(new Error("cancelled"));
    await expect(result).rejects.toThrow("cancelled");
    expect(request).not.toHaveBeenCalled();
    expect(onTransmit).not.toHaveBeenCalled();
  });
  it("pins lookup to the validated address, including Node's all-address mode", () => {
    const resolve = pinnedLookup({ address: "8.8.8.8", family: 4 });
    const callback = vi.fn();
    resolve("changed-dns.example", {}, callback);
    expect(callback).toHaveBeenLastCalledWith(null, "8.8.8.8", 4);
    resolve("changed-dns.example", { all: true }, callback);
    expect(callback).toHaveBeenLastCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
  });
  it("keeps dual-stack connection fallback within the checked DNS answers", () => {
    const addresses = [{ address: "2606:4700:4700::1111", family: 6 }, { address: "8.8.8.8", family: 4 }];
    const resolve = pinnedLookup(addresses), callback = vi.fn();
    resolve("relay.example", { all: true }, callback);
    expect(callback).toHaveBeenLastCalledWith(null, addresses);
    resolve("relay.example", { family: 4 }, callback);
    expect(callback).toHaveBeenLastCalledWith(null, "8.8.8.8", 4);
  });
  it("uses the pinned socket and verifies original TLS hostname; never follows redirects", async () => {
    const resolver = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    const onTransmit = vi.fn();
    let socketOptions: Record<string, unknown> = {};
    let sentBody: unknown;
    const request = vi.fn((_url: URL, options: Record<string, unknown>, receive: (response: EventEmitter) => void) => {
      socketOptions = options;
      const req = new EventEmitter() as EventEmitter & { end(body: unknown): void };
      req.end = body => {
        sentBody = body;
        const res = Object.assign(new EventEmitter(), { statusCode: 302, headers: { location: "https://127.0.0.1/private" } });
        receive(res);
        res.emit("end");
      };
      return req;
    });
    const send = createInferenceFetch({ resolver, request: request as unknown as typeof httpsRequest, onTransmit });
    const response = await send(endpoint, { ...init, headers: { Authorization: "Bearer fixture-secret" } });
    expect(response.status).toBe(302);
    expect(response.url).toBe(endpoint);
    expect(request).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(socketOptions).toMatchObject({ servername: "relay.example", rejectUnauthorized: true, agent: false, headers: { authorization: "Bearer fixture-secret", "accept-encoding": "gzip, deflate, br" } });
    const callback = vi.fn();
    (socketOptions.lookup as ReturnType<typeof pinnedLookup>)("relay.example", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    expect(sentBody).toBe("{}");
    expect(onTransmit).toHaveBeenCalledTimes(1);
  });
  it("supports explicit no-network fetch injection while retaining URL validation", async () => {
    const fetch = vi.fn(async () => new Response("{}")), resolver = vi.fn(), onTransmit = vi.fn();
    const send = createInferenceFetch({ fetch, resolver, onTransmit });
    await send(endpoint, init);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(resolver).not.toHaveBeenCalled();
    expect(onTransmit).toHaveBeenCalledTimes(1);
    await expect(send("https://127.0.0.1/private", init)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync]
  ] as const)("decodes a bounded %s JSON response", async (encoding, compress) => {
    const send = responseFetch(compress(Buffer.from('{"ok":true}')), { "content-encoding": encoding });
    expect(await (await send(endpoint, init)).json()).toEqual({ ok: true });
  });
  it("bounds decompressed size instead of trusting a small compressed payload", async () => {
    const compressed = gzipSync(Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(compressed.length).toBeLessThan(100000);
    await expect(responseFetch(compressed, { "content-encoding": "gzip" })(endpoint, init)).rejects.toThrow();
  });
  it("rejects unknown response encodings", async () => {
    await expect(responseFetch(Buffer.from("{}"), { "content-encoding": "unknown" })(endpoint, init)).rejects.toThrow("encoding");
  });
  const invalidResponses: Array<{ status: number; headers: Record<string, string> }> = [
    { status: 600, headers: {} },
    { status: 200, headers: { "invalid\nheader": "value" } }
  ];
  it.each(invalidResponses)("rejects asynchronous response construction failures: %j", async ({ status, headers }) => {
    await expect(responseFetch(Buffer.from("{}"), headers, status)(endpoint, init)).rejects.toThrow();
  });
});
