/**
 * Public facade for the polish client layer.
 *
 * The transport implementation and deterministic development mock live in
 * focused modules; this file retains the stable imports used by the flow and
 * re-exports their public types/helpers for compatibility.
 */
import {
  createPolishHttpClient,
  DEFAULT_POLISH_CLIENT_TIMEOUT_MS,
} from "./polish-http-client";
import {
  createMockPolishClient,
  MOCK_CLIENT_CODEWORDS,
  MOCK_POLISH_AVAILABILITY_RESPONSE,
  mockPolishText,
} from "./polish-mock-client";
import { PolishApiError } from "./polish-api-error";
import type {
  PolishAvailabilityResponse,
  PolishQuotaResponse,
  PolishRequest,
  PolishSuccessResponse,
} from "@/lib/polish/contract";

export interface PolishApiClient {
  polish(
    request: PolishRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PolishSuccessResponse>;
  getAvailability(options?: { signal?: AbortSignal }): Promise<PolishAvailabilityResponse>;
  getQuota(options?: { signal?: AbortSignal }): Promise<PolishQuotaResponse>;
}
export { PolishApiError };

export { createPolishHttpClient, DEFAULT_POLISH_CLIENT_TIMEOUT_MS };
export type { CreatePolishHttpClientOptions } from "./polish-http-client";
export {
  createMockPolishClient,
  MOCK_CLIENT_CODEWORDS,
  MOCK_POLISH_AVAILABILITY_RESPONSE,
  mockPolishText,
};
export type { CreateMockPolishClientOptions } from "./polish-mock-client";

export function createPolishClientFromEnv(
  options: import("./polish-http-client").CreatePolishHttpClientOptions,
): PolishApiClient {
  if (
    process.env.NEXT_PUBLIC_AI_POLISH_MOCK === "true" &&
    process.env.NODE_ENV !== "production"
  ) {
    return createMockPolishClient();
  }
  return createPolishHttpClient(options);
}
