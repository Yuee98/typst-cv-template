/**
 * Transport/client error with the structured fields consumed by the polish
 * flow and error presentation. Kept in a leaf module so HTTP and mock
 * implementations share one runtime class without importing the facade.
 */
export class PolishApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly resetAt?: string;
  readonly retryAfterSeconds?: number;
  readonly requestId?: string;

  constructor(init: {
    code: string;
    message?: string;
    status?: number;
    resetAt?: string;
    retryAfterSeconds?: number;
    requestId?: string;
  }) {
    super(init.message ?? init.code);
    this.name = "PolishApiError";
    this.code = init.code;
    this.status = init.status;
    this.resetAt = init.resetAt;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.requestId = init.requestId;
  }
}
