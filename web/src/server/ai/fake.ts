import { createHash } from "node:crypto";
import type { AiDatabase, ServiceRpc } from "./database";
import { fixtureId, fixtureInstance, fixtureConfiguration, fixturePrice } from "./fixtures";
import { AiError } from "./errors";
import type { RuntimeDependencies } from "./runtime";
import type { PolishInferenceResult } from "./inference";

type Attempt = { attempt_no: 1 | 2; state: string; retry_allowed: boolean | null; transmitted: boolean | null; fact?: string };
type RequestRecord = {
  id: string; user: string; key: string; fingerprint: string;
  snapshot: Record<string, unknown>; state: string; attempts: Attempt[];
  time_canceled: string | null; outcome: string | null; charged: boolean | null;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",") + "}";
  return JSON.stringify(value);
}
export function createFakeRuntime(now: () => Date = () => new Date()) {
  const requests = new Map<string, RequestRecord>();
  const configurations = [1, 2, 3].map(fixtureConfiguration);
  let enabled = true, revision = "1", count = 0;
  const allowedIndices = () => {
    const hour = Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Shanghai", hourCycle: "h23", hour: "2-digit" }).format(now()));
    return hour < 18 ? ["1", "2"] : ["1", "3"];
  };
  const quota = (user: string) => {
    const list = [...requests.values()].filter(request => request.user === user);
    const reserved = list.filter(request => request.state !== "FINALIZED").length;
    const charged = list.filter(request => request.charged === true).length;
    const date = now();
    return { day: date.toISOString().slice(0, 10), limit: "20", reserved: String(reserved), charged: String(charged), remaining: String(Math.max(0, 20 - reserved - charged)), minute_limit: "3", reset_at: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString() };
  };
  const response = (request: RequestRecord, user: string, replayed = false) => ({ request_id: request.id, state: request.state, replayed, quota: quota(user) });
  const db: AiDatabase = {
    async context() { return { ready: true, contract_code: "cv_app_db_2", database_instance_id: fixtureInstance, environment: "local", capabilities: { cv_schema_version: 7, encrypted_envelope_version: 1 } }; },
    async call(name: ServiceRpc, input: Record<string, unknown>) {
      const user = String(input.owner_auth_user_id);
      if (input.contract_code !== "cv_app_db_2" || input.database_instance_id !== fixtureInstance) throw new AiError("CLIENT_UPDATE_REQUIRED");
      if (name === "ai_quota") return quota(user);
      if (name === "ai_availability") return {
        enabled, control_revision: revision, configurations: configurations.filter(configuration => allowedIndices().includes(configuration.config_id)).map(configuration => structuredClone(configuration)),
        default_config_id: enabled ? "1" : null, quota: quota(user), reason: enabled ? null : "DISABLED", database_instance_id: fixtureInstance, contract_code: "cv_app_db_2"
      };
      if (name === "ai_reserve") {
        const existing = [...requests.values()].find(request => request.user === user && request.key === input.client_request_key);
        if (existing) {
          if (existing.fingerprint !== input.request_fingerprint) throw new AiError("CONFLICT", "IDEMPOTENCY_MISMATCH");
          return response(existing, user, true);
        }
        if (!enabled) throw new AiError("UNAVAILABLE", "DISABLED");
        if (input.expected_control_revision !== revision) throw new AiError("CONFLICT", "CONFIG_CHANGED");
        const configuration = configurations.find(configuration => configuration.config_id === input.config_id && configuration.eligible && allowedIndices().includes(configuration.config_id));
        if (!configuration) throw new AiError("CONFLICT", "OPTION_UNAVAILABLE");
        if (configuration.revision !== input.expected_config_revision) throw new AiError("CONFLICT", "CONFIG_CHANGED");
        if (configuration.legal_display.common.document_audit_id !== input.common_document_audit_id || configuration.legal_display.provider.document_audit_id !== input.provider_document_audit_id) throw new AiError("FORBIDDEN", "CONSENT_REQUIRED");
        if (quota(user).remaining === "0") throw new AiError("QUOTA_EXCEEDED");
        const request: RequestRecord = {
          id: fixtureId("req", ++count), user, key: String(input.client_request_key), fingerprint: String(input.request_fingerprint),
          snapshot: structuredClone({
            config_id: configuration.config_id, config_name: configuration.name, config_revision: configuration.revision,
            adapter_id: configuration.adapter_id, execution_contract: configuration.execution_contract, endpoint_url: configuration.endpoint_url, credential_ref: configuration.credential_ref, model_id: configuration.model_id,
            price: fixturePrice, common_acceptance_audit_id: "1", provider_acceptance_audit_id: String(Number(configuration.config_id) + 10),
            provider_document_id: configuration.legal_display.provider.document_id, provider_document_audit_id: configuration.legal_display.provider.document_audit_id
          }),
          state: "RESERVED", attempts: [], time_canceled: null, outcome: null, charged: null
        };
        requests.set(request.id, request);
        return response(request, user);
      }
      const request = requests.get(String(input.request_id));
      if (!request || request.user !== user) throw new AiError("NOT_FOUND");
      if (name === "ai_execution_snapshot") return { request_id: request.id, state: request.state, ...structuredClone(request.snapshot), time_canceled: request.time_canceled, attempts: request.attempts.map(attempt => ({ attempt_no: attempt.attempt_no, state: attempt.state, retry_allowed: attempt.retry_allowed, transmitted: attempt.transmitted })) };
      if (name === "ai_cancel") {
        if (request.state !== "FINALIZED") request.time_canceled ??= now().toISOString();
        return { request_id: request.id, state: request.state, time_canceled: request.time_canceled, quota: quota(user) };
      }
      const no = Number(input.attempt_no);
      if (name === "ai_attempt_start") {
        const existing = request.attempts.find(attempt => attempt.attempt_no === no);
        if (existing) return { request_id: request.id, attempt_no: no, state: existing.state, may_transmit: false };
        const configuration = configurations.find(configuration => configuration.config_id === request.snapshot.config_id);
        if (!enabled || !configuration?.eligible || request.time_canceled || request.state === "FINALIZED" || no !== 1 && no !== 2 || no !== request.attempts.length + 1 || no === 2 && (request.attempts[0].retry_allowed !== true || ["STARTED", "UNKNOWN"].includes(request.attempts[0].state))) throw new AiError("CONFLICT", "REQUEST_NOT_TRANSMITTABLE");
        const attempt: Attempt = { attempt_no: no, state: "STARTED", retry_allowed: null, transmitted: null };
        request.attempts.push(attempt); request.state = "RUNNING";
        return { request_id: request.id, attempt_no: no, state: attempt.state, may_transmit: true };
      }
      if (name === "ai_attempt_complete") {
        const attempt = request.attempts.find(attempt => attempt.attempt_no === no);
        if (!attempt) throw new AiError("NOT_FOUND");
        const fact = createHash("sha256").update(canonical(input)).digest("hex");
        if (attempt.state !== "STARTED") {
          if (attempt.fact !== fact) throw new AiError("CONFLICT", "TERMINAL_FACT_CHANGED");
          return { request_id: request.id, attempt_no: no, state: attempt.state, replayed: true };
        }
        attempt.state = String(input.state); attempt.fact = fact; attempt.retry_allowed = input.retry_allowed === true; attempt.transmitted = input.transmitted === null ? null : input.transmitted === true;
        if (attempt.state === "CANCELED") request.time_canceled ??= now().toISOString();
        return { request_id: request.id, attempt_no: no, state: attempt.state, replayed: false };
      }
      if (name === "ai_finalize") {
        if (request.state !== "FINALIZED") {
          if (request.attempts.some(attempt => ["STARTED", "UNKNOWN"].includes(attempt.state) || attempt.transmitted === null)) request.state = "HELD";
          else {
            request.state = "FINALIZED";
            request.outcome = request.attempts.length === 0 ? "RELEASED" : request.time_canceled ? "CANCELED" : request.attempts.some(attempt => attempt.state === "SUCCEEDED") ? "SUCCEEDED" : request.attempts.some(attempt => attempt.state === "INVALID_OUTPUT") ? "INVALID_OUTPUT" : "FAILED_UPSTREAM";
            request.charged = request.outcome === "SUCCEEDED" || request.outcome === "CANCELED" && request.attempts.some(attempt => attempt.transmitted);
          }
        }
        return { request_id: request.id, state: request.state, outcome: request.outcome, charged: request.charged, quota: quota(user) };
      }
      throw new AiError("INVALID_REQUEST");
    }
  };
  const runtime: RuntimeDependencies = {
    db, secret: "local-fixture-secret-never-for-hosted",
    prepare: (_configuration, onTransmit) => ({ async complete(request, { signal }) {
      signal.throwIfAborted(); onTransmit();
      return {
        schemaVersion: "polish_inference_result", text: JSON.stringify({ items: request.targets.map(target => ({ id: target.id, polished: target.text })) }), finishReason: "stop",
        usage: { schemaVersion: "normalized_usage", inputTotalTokens: 10, inputCacheReadTokens: 0, inputCacheWriteTokens: null, inputStandardTokens: 10, outputTokens: 10, reasoningTokens: null, cacheUsageReporting: "unavailable", usageComplete: true }, route: {}
      } satisfies PolishInferenceResult;
    } })
  };
  return { ...runtime, fixture: {
    configurations,
    setEnabled(value: boolean) {
      if (!value) for (const request of requests.values()) if (request.state !== "FINALIZED") request.time_canceled ??= now().toISOString();
      enabled = value; revision = String(BigInt(revision) + BigInt(1));
    }
  } };
}
