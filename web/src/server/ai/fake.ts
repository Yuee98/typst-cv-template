import type { AiDatabase, ServiceRpc } from "./database";
import { fixtureDigest, fixtureId, fixtureInstance, fixtureOption, fixtureProfile } from "./fixtures";
import { AiError } from "./errors";
import type { RuntimeDependencies } from "./runtime";
import type { PolishInferenceResult } from "./inference";
type RequestRecord = {
  id: string;
  user: string;
  key: string;
  fingerprint: string;
  option: number;
  state: string;
  attempts: Array<{
    id: string;
    state: string;
    retry: boolean;
    transmitted: boolean;
  }>;
  canceled: boolean;
  outcome: string | null;
};
export function createFakeRuntime(now: () => Date = () => new Date()): RuntimeDependencies & {
  db: AiDatabase;
} {
  const requests = new Map<string, RequestRecord>();
  let count = 0;
  const quota = (user: string) => {
    const list = [...requests.values()].filter(r => r.user === user);
    const used = list.filter(r => r.state !== "FINALIZED" || r.outcome === "SUCCEEDED" || r.outcome === "CANCELED").length;
    const d = now();
    return {
      limit: "20",
      remaining: String(Math.max(0, 20 - used)),
      reset_at: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString()
    };
  };
  const db: AiDatabase = {
    async context() {
      return {
        ready: true,
        contract_code: "cv_app_db_1",
        database_instance_id: fixtureInstance,
        environment: "local",
        capabilities: []
      };
    },
    async call(name: ServiceRpc, input: Record<string, unknown>) {
      const user = String(input.owner_auth_user_id);
      if (input.contract_code !== "cv_app_db_1" || input.database_instance_id !== fixtureInstance) throw new AiError("CLIENT_UPDATE_REQUIRED");
      if (name === "ai_availability") {
        const date = now();
        const hour = Number(new Intl.DateTimeFormat("en", {
          timeZone: "Asia/Shanghai",
          hourCycle: "h23",
          hour: "2-digit"
        }).format(date));
        const indices = hour < 18 ? [1, 2] : [1, 3];
        return {
          enabled: true,
          generation: "1",
          policy_version_id: fixtureId("plv", 1),
          rule_ordinal: hour < 18 ? 1 : 2,
          options: indices.map(fixtureOption),
          default_option_id: fixtureId("opt", 1),
          observed_at: date.toISOString(),
          next_change_at: new Date(date.getTime() + 60000).toISOString(),
          reason: null,
          database_instance_id: fixtureInstance,
          contract_code: "cv_app_db_1"
        };
      }
      if (name === "ai_quota") return quota(user);
      if (name === "ai_reserve") {
        const existing = [...requests.values()].find(r => r.user === user && r.key === input.client_request_key);
        if (existing) {
          if (existing.fingerprint !== input.request_fingerprint) throw new AiError("CONFLICT", "IDEMPOTENCY_MISMATCH");
          return {
            request_id: existing.id,
            state: existing.state,
            replayed: true,
            quota: quota(user)
          };
        }
        if (input.expected_generation !== "1" || input.expected_policy_version_id !== fixtureId("plv", 1)) throw new AiError("CONFLICT", "CONFIG_CHANGED");
        const hour = Number(new Intl.DateTimeFormat("en", {
          timeZone: "Asia/Shanghai",
          hourCycle: "h23",
          hour: "2-digit"
        }).format(now()));
        const option = (hour < 18 ? [1, 2] : [1, 3]).map(fixtureOption).find(o => o.option_id === input.selected_option_id);
        if (!option || option.profile_version_id !== input.expected_profile_version_id) throw new AiError("CONFLICT", "OPTION_UNAVAILABLE");
        if (quota(user).remaining === "0") throw new AiError("QUOTA_EXCEEDED");
        const r: RequestRecord = {
          id: fixtureId("req", ++count),
          user,
          key: String(input.client_request_key),
          fingerprint: String(input.request_fingerprint),
          option: Number(String(input.selected_option_id).split("_")[1]),
          state: "RESERVED",
          attempts: [],
          canceled: false,
          outcome: null
        };
        requests.set(r.id, r);
        return {
          request_id: r.id,
          state: r.state,
          replayed: false,
          quota: quota(user)
        };
      }
      const r = requests.get(String(input.request_id));
      if (!r || r.user !== user) throw new AiError("NOT_FOUND");
      if (name === "ai_execution_snapshot") return {
        request_id: r.id,
        state: r.state,
        selected_option_id: fixtureId("opt", r.option),
        policy_version_id: fixtureId("plv", 1),
        profile_id: fixtureId("prf", r.option),
        profile_version_id: fixtureId("pfv", r.option),
        price_version_id: fixtureId("pcv", r.option),
        ...fixtureProfile(r.option),
        provider_id: fixtureOption(r.option).provider_id,
        recipient_code: fixtureOption(r.option).recipient_code,
        price: {
          currency: "CNY",
          calculator_kind: "linear_token_v1",
          parameters: {},
          components: {
            INPUT_STANDARD: "100",
            INPUT_CACHE_READ: "10",
            INPUT_CACHE_WRITE: "0",
            OUTPUT: "100"
          }
        },
        disclosure_id: fixtureId("lds", r.option),
        content_digest: fixtureDigest,
        cancel_sequence: r.canceled ? "1" : "0",
        attempts: r.attempts
      };
      if (name === "ai_cancel") {
        r.canceled = true;
        return {
          request_id: r.id,
          state: r.state,
          cancel_sequence: "1"
        };
      }
      if (name === "ai_attempt_start") {
        const no = Number(input.attempt_no),
          existing = r.attempts[no - 1];
        if (existing) return {
          attempt_id: existing.id,
          attempt_no: no,
          state: existing.state,
          may_transmit: false
        };
        if (r.canceled || r.state === "FINALIZED" || no < 1 || no > 2 || no !== r.attempts.length + 1 || no === 2 && !r.attempts[0].retry) throw new AiError("CONFLICT", "ATTEMPT_NOT_ALLOWED");
        const a = {
          id: fixtureId("att", count * 2 + no),
          state: "STARTED",
          retry: false,
          transmitted: false
        };
        r.attempts.push(a);
        r.state = "RUNNING";
        return {
          attempt_id: a.id,
          attempt_no: no,
          state: a.state,
          may_transmit: true
        };
      }
      if (name === "ai_attempt_complete") {
        const a = r.attempts.find(a => a.id === input.attempt_id);
        if (!a) throw new AiError("NOT_FOUND");
        if (a.state !== "STARTED") throw new AiError("CONFLICT");
        a.state = String(input.state);
        a.retry = input.retry_allowed === true;
        a.transmitted = input.transmitted === true;
        return {
          attempt_id: a.id,
          state: a.state,
          replayed: false
        };
      }
      if (name === "ai_finalize") {
        if (r.state !== "FINALIZED") {
          if (r.attempts.some(a => a.state === "STARTED" || a.state === "UNKNOWN")) r.state = "HELD";else {
            r.state = "FINALIZED";
            r.outcome = r.canceled ? r.attempts.some(a => a.transmitted) ? "CANCELED" : "RELEASED" : r.attempts.some(a => a.state === "SUCCEEDED") ? "SUCCEEDED" : r.attempts.length === 0 ? "RELEASED" : "FAILED_UPSTREAM";
          }
        }
        return {
          request_id: r.id,
          state: r.state,
          outcome: r.outcome,
          charged: r.outcome === "SUCCEEDED" || r.outcome === "CANCELED",
          quota: quota(user)
        };
      }
      throw new AiError("INVALID_REQUEST");
    }
  };
  return {
    db,
    secret: "local-fixture-secret-never-for-hosted",
    prepare: (_profile, onTransmit) => ({
      async complete(request, {
        signal
      }) {
        signal.throwIfAborted();
        onTransmit();
        return {
          schemaVersion: "polish_inference_result",
          text: JSON.stringify({
            items: request.targets.map(t => ({
              id: t.id,
              polished: t.text
            }))
          }),
          finishReason: "stop",
          usage: {
            schemaVersion: "normalized_usage",
            inputTotalTokens: 10,
            inputCacheReadTokens: 0,
            inputCacheWriteTokens: null,
            inputStandardTokens: 10,
            outputTokens: 10,
            reasoningTokens: null,
            cacheUsageReporting: "unavailable",
            usageComplete: true
          },
          route: {}
        } as PolishInferenceResult;
      }
    })
  };
}
