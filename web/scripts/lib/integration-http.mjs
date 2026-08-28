/**
 * Parse a smoke response without hiding cancellation. Provider/API error
 * bodies may legitimately be non-JSON, but a caller/deadline abort must keep
 * rejecting so the cancellation proof cannot turn into a normal null body.
 */
export async function readJsonOrNull(response, signal) {
  try {
    return await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/**
 * A valid multi-item workload for observing the provider_started window of a
 * fast official model. Keep this fixture pure so its request-contract and
 * output-budget bounds can be tested without a credential or network call.
 */
export const CANCELLATION_ITEM_COUNT = 25;
const CANCELLATION_ITEM_TEXT =
  "主导微服务架构改造，负责核心链路性能优化与稳定性建设，推进可观测性、容量治理、故障演练和跨团队交付，将延迟、错误率和恢复时间持续降低。";

export function buildCancellationProbeItems() {
  return Array.from({ length: CANCELLATION_ITEM_COUNT }, (_, index) => ({
    id: `c${index}`,
    kind: "experience_bullet",
    text: `第${index + 1}项：${CANCELLATION_ITEM_TEXT.repeat(2)}`,
  }));
}

function safeDiagnosticToken(value, pattern) {
  return typeof value === "string" && pattern.test(value) ? value : "unavailable";
}

/** Format only bounded lifecycle/status facts; never echo an upstream body. */
export function formatCancellationSetupDetail(startedRow, outcome) {
  if (startedRow !== null) {
    const state = safeDiagnosticToken(startedRow?.state, /^[a-z_]{1,64}$/u);
    const status = safeDiagnosticToken(startedRow?.status, /^[a-z_]{1,64}$/u);
    const failureStage = startedRow?.failure_stage === null
      ? "null"
      : safeDiagnosticToken(startedRow?.failure_stage, /^[a-z_]{1,64}$/u);
    const attempts = Number.isInteger(startedRow?.attempt_count) && startedRow.attempt_count >= 0
      ? startedRow.attempt_count
      : "unavailable";
    return `state ${state}; status ${status}; attempts ${attempts}; failure_stage ${failureStage}`;
  }
  if (Number.isInteger(outcome?.status)) {
    const code = safeDiagnosticToken(outcome?.body?.error?.code, /^[A-Z0-9_]{1,64}$/u);
    return `reservation never appeared; HTTP ${outcome.status}, code ${code}`;
  }
  return "reservation never appeared; client request had no safe HTTP verdict";
}
