import {
  MAX_BODY_BYTES,
  POLISH_ERROR_HTTP_STATUS,
  type PolishErrorCode,
  type PolishErrorResponse,
} from "@/lib/polish/contract";

export const POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS = 300;

export function baseHeaders(requestId: string): Record<string, string> {
  return { "Cache-Control": "no-store", "X-Request-Id": requestId };
}
export function errorResponse(
  requestId: string,
  code: PolishErrorCode,
  message: string,
  options?: { resetAt?: string; retryAfterSeconds?: number },
): Response {
  const body: PolishErrorResponse = {
    requestId,
    error: {
      code,
      message,
      ...(options?.resetAt !== undefined ? { resetAt: options.resetAt } : {}),
      ...(options?.retryAfterSeconds !== undefined ? { retryAfterSeconds: options.retryAfterSeconds } : {}),
    },
  };
  const headers = baseHeaders(requestId);
  if (options?.retryAfterSeconds !== undefined) headers["Retry-After"] = String(options.retryAfterSeconds);
  return Response.json(body, { status: POLISH_ERROR_HTTP_STATUS[code], headers });
}

type BoundedBodyFailure = { ok: false; code: "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE"; message: string };
export type BoundedBody = { ok: true; text: string } | BoundedBodyFailure;

function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mime = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mime === "application/json";
}

export async function readBoundedBody(request: Request): Promise<BoundedBody> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return { ok: false, code: "INVALID_REQUEST", message: "Content-Type must be application/json." };
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return { ok: false, code: "PAYLOAD_TOO_LARGE", message: `Request body exceeds the ${MAX_BODY_BYTES}-byte limit.` };
    }
  }
  if (request.body === null) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, code: "PAYLOAD_TOO_LARGE", message: `Request body exceeds the ${MAX_BODY_BYTES}-byte limit.` };
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return { ok: true, text: chunks.join("") };
}

export function secondsUntil(iso: string, now: number): number {
  return Math.max(1, Math.ceil((Date.parse(iso) - now) / 1000));
}

export function toIsoUtc(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toISOString();
}
