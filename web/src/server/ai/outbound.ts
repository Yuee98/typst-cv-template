import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

type Address = { address: string; family: number };
export type EndpointResolver = (hostname: string) => Promise<Address[]>;
const defaultResolver: EndpointResolver = hostname => lookup(hostname, { all: true, verbatim: true });
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function decodeResponse(body: Buffer, encoding: string | null): Buffer {
  const codings = encoding?.split(",").map(value => value.trim().toLowerCase()) ?? [];
  if (codings.length > 4) throw new Error("Too many inference response encodings");
  let decoded = body;
  for (const coding of codings.reverse()) {
    const options = { maxOutputLength: MAX_RESPONSE_BYTES };
    if (coding === "gzip") decoded = gunzipSync(decoded, options);
    else if (coding === "deflate") decoded = inflateSync(decoded, options);
    else if (coding === "br") decoded = brotliDecompressSync(decoded, options);
    else if (coding !== "identity") throw new Error("Unsupported inference response encoding");
  }
  return decoded;
}

/** Only globally routable addresses are valid inference destinations. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 100 && b >= 64 && b <= 127 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
      a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) !== 6) return false;
  const value = address.toLowerCase();
  // Reject mapped IPv4, transition mechanisms, documentation and special-use
  // ranges. Ordinary public IPv6 unicast is within 2000::/3.
  const [first, second] = value.split(":").map(part => Number.parseInt(part || "0", 16));
  return first >= 0x2000 && first <= 0x3fff &&
    !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) &&
    first !== 0x2002 && first !== 0x3fff && !value.includes(".");
}

/** An endpoint is a complete HTTPS URL, not an official-provider allowlist. */
export function validateEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error("Invalid inference endpoint");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) throw new Error("Private inference endpoint");
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new Error("Private inference endpoint");
  if (url.href !== value) throw new Error("Inference endpoint must be canonical");
  return url;
}

function abortable<T>(work: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function resolveEndpoint(value: string, resolver: EndpointResolver = defaultResolver, signal?: AbortSignal | null) {
  const url = validateEndpoint(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await abortable(resolver(hostname), signal);
  signal?.throwIfAborted();
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address) || isIP(item.address) !== item.family)) throw new Error("Inference endpoint resolved to a non-public address");
  return { url, address: addresses[0], addresses };
}

/** Pin the checked DNS result to the actual socket; a second lookup is forbidden. */
export function pinnedLookup(value: Address | readonly Address[]): NonNullable<RequestOptions["lookup"]> {
  const addresses: readonly Address[] = Array.isArray(value) ? value : [value as Address];
  return (_hostname, options, callback) => {
    const family = typeof options === "object" ? options.family : options;
    const matching = family === 4 || family === 6 ? addresses.filter(address => address.family === family) : addresses;
    if (!matching.length) { callback(new Error("No validated address for the requested family"), []); return; }
    if (typeof options === "object" && options.all) callback(null, [...matching]);
    else callback(null, matching[0].address, matching[0].family);
  };
}

/** Shared Node-only egress for every adapter. Injected fetch is solely a test seam. */
export function createInferenceFetch(options: {
  onTransmit?: () => void;
  resolver?: EndpointResolver;
  fetch?: typeof fetch;
  request?: typeof httpsRequest;
} = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (typeof input !== "string" || init?.method !== "POST" || typeof init.body !== "string" || init.redirect !== "error") throw new Error("Unsupported inference HTTP request");
    const url = validateEndpoint(input);
    // No DNS or real network is used by an explicitly injected test transport.
    if (options.fetch) {
      init.signal?.throwIfAborted();
      options.onTransmit?.();
      return options.fetch(input, init);
    }
    const { addresses } = await resolveEndpoint(input, options.resolver, init.signal);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
    headers["content-length"] = String(Buffer.byteLength(init.body));
    headers["accept-encoding"] = "gzip, deflate, br";
    return new Promise<Response>((resolve, reject) => {
      const send = options.request ?? httpsRequest;
      const req = send(url, {
        method: "POST", headers, agent: false,
        lookup: pinnedLookup(addresses),
        servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname,
        rejectUnauthorized: true,
        signal: init.signal ?? undefined
      }, res => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            res.destroy(new Error("Inference response exceeds the body limit"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
            }
            const status = res.statusCode ?? 502;
            const body = [204, 205, 304].includes(status) ? null : decodeResponse(Buffer.concat(chunks), responseHeaders.get("content-encoding"));
            const response = new Response(body === null ? null : new Uint8Array(body), { status, headers: responseHeaders });
            Object.defineProperty(response, "url", { value: input });
            resolve(response);
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on("error", reject);
      init.signal?.throwIfAborted();
      options.onTransmit?.();
      req.end(init.body);
    });
  }) as typeof fetch;
}
