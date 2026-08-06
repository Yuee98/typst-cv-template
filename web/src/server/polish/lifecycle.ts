import { handlePolishPost } from "./lifecycle-post";
import { handleQuotaGet } from "./lifecycle-quota";
export { POLISH_UNAVAILABLE_RETRY_AFTER_SECONDS } from "./lifecycle-http";
export type { PolishFinalizeCall, PolishLogEvent, PolishRouteDeps } from "./lifecycle-types";
import type { PolishRouteDeps, PolishRouteHandlers } from "./lifecycle-types";

export type { PolishRouteHandlers } from "./lifecycle-types";

export function createPolishHandlers(deps: PolishRouteDeps): PolishRouteHandlers {
  return {
    POST: (request) => handlePolishPost(request, deps),
    GET: (request) => handleQuotaGet(request, deps),
  };
}
