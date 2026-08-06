import { polishRequestSchema } from "@/lib/polish/contract";
import { POLISH_TRANSPORT_ERROR_CODES } from "./polish-errors";
import { PolishApiError } from "./polish-api-error";
import type { PolishApiClient } from "./polish-client";

// ---------------------------------------------------------------------------
// Development mock
// ---------------------------------------------------------------------------

/** Codewords scanned in `styleInstruction`, mirroring the 0.4 fake provider. */
export const MOCK_CLIENT_CODEWORDS = {
  failUpstream: "FAIL_UPSTREAM",
  failJson: "FAIL_JSON",
  slow: "SLOW",
} as const;

export interface CreateMockPolishClientOptions {
  /** Simulated latency per call (SLOW overrides it with `slowDelayMs`). */
  delayMs?: number;
  /** Latency for the SLOW codeword; should exceed any client timeout in use. */
  slowDelayMs?: number;
  /** Daily quota limit; each successful polish consumes one. */
  quotaLimit?: number;
}

/** Deterministic pseudo-polish: whitespace collapse, else a visible marker. */
export function mockPolishText(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  return collapsed !== text ? collapsed : `[mock] ${text}`;
}

function nextUtcMidnight(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PolishApiError({ code: POLISH_TRANSPORT_ERROR_CODES.requestAborted }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new PolishApiError({ code: POLISH_TRANSPORT_ERROR_CODES.requestAborted }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * In-memory mock of the polish API for development without a backend. The
 * response envelope matches polishSuccessResponseSchema /
 * polishQuotaResponseSchema exactly; quota and dedup state live for the
 * lifetime of the returned client instance.
 */
export function createMockPolishClient(
  options: CreateMockPolishClientOptions = {},
): PolishApiClient {
  const delayMs = options.delayMs ?? 600;
  const slowDelayMs = options.slowDelayMs ?? 60_000;
  const quotaLimit = options.quotaLimit ?? 20;
  let used = 0;
  let requestCounter = 0;
  const seenClientRequestIds = new Set<string>();

  function quota() {
    return {
      limit: quotaLimit,
      remaining: Math.max(0, quotaLimit - used),
      resetAt: nextUtcMidnight(),
    };
  }

  return {
    async polish(polishRequest, polishOptions) {
      const parsed = polishRequestSchema.safeParse(polishRequest);
      if (!parsed.success) {
        throw new PolishApiError({ code: "INVALID_REQUEST", status: 400 });
      }
      if (seenClientRequestIds.has(polishRequest.clientRequestId)) {
        throw new PolishApiError({
          code: "DUPLICATE_REQUEST",
          message: "mock: clientRequestId already consumed",
          status: 409,
        });
      }

      const instruction = polishRequest.styleInstruction ?? "";
      const slow = instruction.includes(MOCK_CLIENT_CODEWORDS.slow);
      await abortableDelay(slow ? slowDelayMs : delayMs, polishOptions?.signal);

      if (instruction.includes(MOCK_CLIENT_CODEWORDS.failUpstream)) {
        throw new PolishApiError({ code: "UPSTREAM_ERROR", status: 502 });
      }
      if (instruction.includes(MOCK_CLIENT_CODEWORDS.failJson)) {
        // The real pipeline would burn a retry and surface this from the
        // orchestrator; the mock maps the codeword straight to it.
        throw new PolishApiError({ code: "INVALID_MODEL_OUTPUT", status: 502 });
      }

      const remaining = quotaLimit - used;
      if (remaining <= 0) {
        throw new PolishApiError({
          code: "QUOTA_EXCEEDED",
          status: 429,
          resetAt: nextUtcMidnight(),
        });
      }

      seenClientRequestIds.add(polishRequest.clientRequestId);
      used += 1;
      requestCounter += 1;
      return {
        requestId: `mock-req-${requestCounter}`,
        items: polishRequest.items.map((item) => ({
          id: item.id,
          polished: mockPolishText(item.text),
        })),
        quota: quota(),
      };
    },

    async getQuota(quotaOptions) {
      await abortableDelay(Math.min(delayMs, 200), quotaOptions?.signal);
      return { requestId: "mock-quota", quota: quota() };
    },
  };
}
