/** Fixed server-side diagnostics. Never serialize an upstream error or its context. */
export interface ProviderFailureContext {
  config_id: string;
  adapter_id: 1 | 2 | 3;
  request_id: string;
  attempt_no: 1 | 2;
  transmitted: boolean;
  retryable: boolean;
}

export type ProviderFailureClass = "HTTP_TERMINAL" | "HTTP_RETRYABLE" | "NO_HTTP_UNKNOWN" | "PRE_TRANSMIT_ERROR";

export interface ProviderFailureDiagnostic extends ProviderFailureContext {
  event: "provider_attempt_failure";
  http_status: number | null;
  class: ProviderFailureClass;
}

export type ProviderDiagnosticLogger = (record: ProviderFailureDiagnostic) => void;

function ownValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function isDatabaseId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) &&
    (value.length < 19 || value <= "9223372036854775807");
}

const defaultLogger: ProviderDiagnosticLogger = record => console.warn(JSON.stringify(record));

/**
 * Diagnostics cannot affect attempt completion or settlement. Context comes from
 * validated runtime values, but is checked again without invoking accessors.
 * Even descriptor traps, JSON serialization and logger failures are contained.
 */
export function reportProviderFailure(context: ProviderFailureContext, error: unknown, logger: ProviderDiagnosticLogger = defaultLogger): void {
  try {
    const configId = ownValue(context, "config_id");
    const adapterId = ownValue(context, "adapter_id");
    const requestId = ownValue(context, "request_id");
    const attemptNo = ownValue(context, "attempt_no");
    const transmitted = ownValue(context, "transmitted");
    const retryable = ownValue(context, "retryable");
    if (!isDatabaseId(configId) || adapterId !== 1 && adapterId !== 2 && adapterId !== 3 ||
      typeof requestId !== "string" || !/^req_[0-9A-HJKMNP-TV-Z]{12}$/.test(requestId) ||
      attemptNo !== 1 && attemptNo !== 2 || typeof transmitted !== "boolean" || typeof retryable !== "boolean") return;

    const status = ownValue(error, "upstreamStatus");
    const httpStatus = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    const classification: ProviderFailureClass = httpStatus !== null
      ? retryable ? "HTTP_RETRYABLE" : "HTTP_TERMINAL"
      : transmitted ? "NO_HTTP_UNKNOWN" : "PRE_TRANSMIT_ERROR";
    logger({
      event: "provider_attempt_failure",
      config_id: configId,
      adapter_id: adapterId,
      request_id: requestId,
      attempt_no: attemptNo,
      transmitted,
      http_status: httpStatus,
      retryable,
      class: classification
    });
  } catch {
    // Failure to observe must never change the outcome of the actual operation.
  }
}
