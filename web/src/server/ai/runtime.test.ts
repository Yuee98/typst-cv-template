import { describe, it, expect, vi } from "vitest";
import { polishPostRequestSchema, polishExpectedRouteFromAvailability } from "@/lib/polish/contract";
import { createFakeRuntime } from "./fake";
import { fixtureInstance } from "./fixtures";
import { readAvailability } from "./availability";
import { executePolish, parseQuota } from "./runtime";
import type { InferenceProvider } from "./provider";
const user = "10000000-0000-4000-8000-000000000002";
const signal = () => new AbortController().signal;
async function setup() {
  const deps = createFakeRuntime(() => new Date("2026-11-07T00:00:00Z"));
  const availability = await readAvailability(deps.db, user, fixtureInstance, {}, false);
  const request = polishPostRequestSchema.parse({
    clientRequestId: crypto.randomUUID(),
    granularity: "item",
    sectionId: "experience",
    language: "zh",
    items: [{
      id: "i0",
      kind: "experience_bullet",
      text: "负责核心服务开发，将 P99 延迟降低 40%。"
    }],
    context: {
      level: 0,
      references: []
    },
    expectedRoute: polishExpectedRouteFromAvailability(availability)
  });
  return {
    deps,
    availability,
    request
  };
}
describe("current database execution", () => {
  it("runs selected frozen option, charges one and never re-sends a replay", async () => {
    const {
      deps,
      request
    } = await setup();
    const prepare = vi.fn(deps.prepare!);
    const runtime = {
      ...deps,
      prepare
    };
    const result = await executePolish(runtime, user, request, signal());
    expect(result.items[0].polished).toBe(request.items[0].text);
    expect(result.quota.remaining).toBe(19);
    await expect(executePolish(runtime, user, request, signal())).rejects.toMatchObject({
      code: "CONFLICT",
      reason: "ALREADY_FINALIZED"
    });
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it("permits a single executor for concurrent identical requests", async () => {
    const {
      deps,
      request
    } = await setup();
    const result = await Promise.allSettled([executePolish(deps, user, request, signal()), executePolish(deps, user, request, signal())]);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });
  it("same idempotency key with another selection conflicts", async () => {
    const {
      deps,
      request,
      availability
    } = await setup();
    await executePolish(deps, user, request, signal());
    await expect(executePolish(deps, user, {
      ...request,
      expectedRoute: polishExpectedRouteFromAvailability(availability, availability.configurations[1].configId)!
    }, signal())).rejects.toMatchObject({
      code: "CONFLICT",
      reason: "IDEMPOTENCY_MISMATCH"
    });
  });
  it("does not call the provider when start grants no transmission", async () => {
    const {
      deps,
      request
    } = await setup();
    const original = deps.db.call;
    const complete = vi.fn();
    deps.prepare = () => ({
      complete
    });
    deps.db.call = async (name, input) => name === "ai_attempt_start" ? {
      request_id: "req_000000000001",
      attempt_no: 1,
      state: "STARTED",
      may_transmit: false
    } : original(name, input);
    await expect(executePolish(deps, user, request, signal())).rejects.toMatchObject({
      code: "CONFLICT"
    });
    expect(complete).not.toHaveBeenCalled();
  });
  it("never retries unknown transport, retaining held reservation", async () => {
    const {
      deps,
      request
    } = await setup();
    const complete = vi.fn<InferenceProvider["complete"]>(async () => {
      throw new Error("unknown transport");
    });
    deps.prepare = (_profile, onTransmit) => ({
      complete: async (...args: Parameters<InferenceProvider["complete"]>) => {
        onTransmit();
        return complete(...args);
      }
    });
    await expect(executePolish(deps, user, request, signal())).rejects.toMatchObject({
      code: "UNAVAILABLE",
      reason: "HELD"
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it("does not send a second attempt if completion persistence fails", async () => {
    const {
      deps,
      request
    } = await setup();
    const originalPrepare = deps.prepare!;
    const complete = vi.fn();
    deps.prepare = (profile, onTransmit) => {
      const p = originalPrepare(profile, onTransmit);
      return {
        complete: async (...args) => {
          complete();
          const r = await p.complete(...args);
          return {
            ...r,
            text: "invalid json"
          };
        }
      };
    };
    const original = deps.db.call;
    deps.db.call = async (name, input) => {
      if (name === "ai_attempt_complete") throw new Error("response lost");
      return original(name, input);
    };
    await expect(executePolish(deps, user, request, signal())).rejects.toThrow();
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it("retries invalid output once against the same frozen provider", async () => {
    const {
      deps,
      request
    } = await setup();
    const original = deps.prepare!;
    let calls = 0;
    const profiles: string[] = [];
    deps.prepare = (profile, onTransmit) => {
      profiles.push(profile.model_id);
      const p = original(profile, onTransmit);
      return {
        complete: async (...args) => {
          calls++;
          const r = await p.complete(...args);
          return calls === 1 ? {
            ...r,
            text: "invalid"
          } : r;
        }
      };
    };
    await executePolish(deps, user, request, signal());
    expect(calls).toBe(2);
    expect(profiles).toEqual(["fixture-model-1"]);
  });
  it("rejects stale database instances before transmission", async () => {
    const {
      deps,
      request
    } = await setup();
    await expect(executePolish(deps, user, {
      ...request,
      expectedRoute: {
        ...request.expectedRoute,
        databaseInstanceId: crypto.randomUUID()
      }
    }, signal())).rejects.toMatchObject({
      code: "CLIENT_UPDATE_REQUIRED"
    });
  });
  it("pre-transmission configuration failure releases without attempts", async () => {
    const {
      deps,
      request
    } = await setup();
    deps.prepare = () => {
      throw new Error("no credential");
    };
    await expect(executePolish(deps, user, request, signal())).rejects.toMatchObject({
      reason: "EXECUTION_CONFIG_UNAVAILABLE"
    });
    const q = await deps.db.call("ai_quota", {
      contract_code: "cv_app_db_2",
      owner_auth_user_id: user,
      database_instance_id: fixtureInstance
    });
    expect(q).toMatchObject({
      remaining: "20"
    });
  });
  it("cancellation before attempt releases reservation", async () => {
    const {
      deps,
      request
    } = await setup();
    const controller = new AbortController();
    controller.abort();
    await expect(executePolish(deps, user, request, controller.signal)).rejects.toMatchObject({
      reason: "RELEASED"
    });
  });
});
describe("lost admission responses", () => {
  it("holds a started attempt and never transmits or recovers transmission from replay", async () => {
    const {
      deps,
      request
    } = await setup();
    const original = deps.db.call;
    const complete = vi.fn();
    deps.prepare = () => ({
      complete
    });
    deps.db.call = async (name, input) => {
      const result = await original(name, input);
      if (name === "ai_attempt_start") throw new Error("admission response lost");
      return result;
    };
    await expect(executePolish(deps, user, request, signal())).rejects.toThrow("admission response lost");
    await expect(executePolish(deps, user, request, signal())).rejects.toMatchObject({
      code: "CONFLICT",
      reason: "REQUEST_IN_PROGRESS"
    });
    expect(complete).not.toHaveBeenCalled();
    const q = await original("ai_quota", {
      contract_code: "cv_app_db_2",
      owner_auth_user_id: user,
      database_instance_id: fixtureInstance
    });
    expect(q).toMatchObject({
      remaining: "19"
    });
  });
});
describe("failed upstream billing evidence", () => {
  it.each([401, 403])("settles an HTTP %s rejection even when its diagnostic logger throws", async upstreamStatus => {
    const { deps, request, availability } = await setup();
    const expectedRoute = polishExpectedRouteFromAvailability(availability, availability.configurations[1].configId);
    if (!expectedRoute) throw new Error("The diagnostic regression requires the eligible MiMo fixture.");
    const original = deps.db.call;
    const calls: string[] = [];
    const attemptFacts: Array<Record<string, unknown>> = [];
    const finalResults: unknown[] = [];
    deps.db.call = async (name, input) => {
      calls.push(name);
      if (name === "ai_attempt_complete") attemptFacts.push(input);
      const result = await original(name, input);
      if (name === "ai_finalize") finalResults.push(result);
      return result;
    };
    const complete = vi.fn<InferenceProvider["complete"]>(async () => {
      throw Object.assign(new Error("PRIVATE_UPSTREAM_MESSAGE"), { code: "UPSTREAM_ERROR", upstreamStatus, body: "PRIVATE_CV_BODY" });
    });
    deps.prepare = (_configuration, onTransmit) => ({ complete: async (...args) => {
      onTransmit();
      return complete(...args);
    } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("PRIVATE_LOGGER_FAILURE"); });
    try {
      await expect(executePolish(deps, user, {
        ...request,
        expectedRoute
      }, signal())).rejects.toMatchObject({ code: "UNAVAILABLE", reason: "FAILED_UPSTREAM" });
      expect(complete).toHaveBeenCalledTimes(1);
      expect(calls.filter(name => name === "ai_attempt_complete")).toHaveLength(1);
      expect(calls.filter(name => name === "ai_finalize")).toHaveLength(1);
      expect(attemptFacts).toEqual([expect.objectContaining({ state: "FAILED_UPSTREAM", attempt_no: 1, transmitted: true, provider_billable: null, retry_allowed: false, usage_complete: false })]);
      expect(finalResults).toEqual([expect.objectContaining({ state: "FINALIZED", outcome: "FAILED_UPSTREAM", charged: false, quota: expect.objectContaining({ reserved: "0", charged: "0", remaining: "20" }) })]);
      expect(await original("ai_quota", { contract_code: "cv_app_db_2", database_instance_id: fixtureInstance, owner_auth_user_id: user })).toMatchObject({ reserved: "0", charged: "0", remaining: "20" });
      // This assertion is intentionally last: RED must show that settlement is
      // already correct, but no production diagnostic was emitted yet.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(warn.mock.calls[0][0])).toEqual({ event: "provider_attempt_failure", config_id: availability.configurations[1].configId, adapter_id: 2, request_id: "req_000000000001", attempt_no: 1, transmitted: true, http_status: upstreamStatus, retryable: false, class: "HTTP_TERMINAL" });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE_");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not treat an HTTP error without usage as proof of zero provider cost", async () => {
    const {
      deps,
      request
    } = await setup();
    const original = deps.db.call;
    const facts: Record<string, unknown>[] = [];
    deps.db.call = async (name, input) => {
      if (name === "ai_attempt_complete") facts.push(input);
      return original(name, input);
    };
    deps.prepare = (_profile, onTransmit) => ({
      complete: async () => {
        onTransmit();
        throw Object.assign(new Error("provider failed"), {
          code: "UPSTREAM_ERROR",
          upstreamStatus: 500
        });
      }
    });
    await expect(executePolish(deps, user, request, signal())).rejects.toMatchObject({
      code: "UNAVAILABLE",
      reason: "FAILED_UPSTREAM"
    });
    expect(facts).toHaveLength(2);
    expect(facts.every(fact => fact.provider_billable === null && fact.usage_complete === false && !("estimated_cost_nanos" in fact))).toBe(true);
  });
});
describe("canonical database quota", () => {
  const wire = { limit: "20", remaining: "19", reset_at: "2026-11-08T00:00:00+00:00" };
  it("converts canonical decimal strings to safe HTTP numbers", () => {
    expect(parseQuota(wire)).toEqual({ limit: 20, remaining: 19, resetAt: "2026-11-08T00:00:00.000Z" });
    expect(parseQuota({ ...wire, limit: "0", remaining: "0" })).toMatchObject({ limit: 0, remaining: 0 });
    expect(parseQuota({ ...wire, limit: String(Number.MAX_SAFE_INTEGER), remaining: String(Number.MAX_SAFE_INTEGER) })).toMatchObject({ limit: Number.MAX_SAFE_INTEGER, remaining: Number.MAX_SAFE_INTEGER });
  });
  it("rejects numeric database quota fields", () => {
    for (const field of ["limit", "remaining"]) {
      for (const value of [0, 19]) expect(() => parseQuota({ ...wire, [field]: value })).toThrow();
    }
  });
  it("rejects leading zeroes, fractions and alternate decimal spellings", () => {
    for (const field of ["limit", "remaining"]) {
      for (const value of ["00", "01", "1.0", "1.5", "+1", "-0", "-1", " 1", "1 ", "1e1", ""]) expect(() => parseQuota({ ...wire, [field]: value })).toThrow();
    }
  });
  it("rejects decimal strings outside the safe HTTP integer range", () => {
    for (const field of ["limit", "remaining"]) {
      for (const value of ["9007199254740992", "9007199254740993", "9".repeat(400)]) expect(() => parseQuota({ ...wire, [field]: value })).toThrow();
    }
  });
  it("uses the database decimal-string contract throughout fake quota, reservation and settlement", async () => {
    const { deps, request } = await setup();
    const call = deps.db.call;
    const observed: unknown[] = [];
    deps.db.call = async (name, input) => {
      const result = await call(name, input);
      if (name === "ai_quota") observed.push(result);
      else if (result && typeof result === "object" && "quota" in result) observed.push(result.quota);
      return result;
    };
    const input = { contract_code: "cv_app_db_2", owner_auth_user_id: user, database_instance_id: fixtureInstance };
    await deps.db.call("ai_quota", input);
    const result = await executePolish(deps, user, request, signal());
    await deps.db.call("ai_quota", input);
    expect(observed).toHaveLength(4);
    for (const quota of observed) expect(quota).toMatchObject({ limit: "20", remaining: expect.stringMatching(/^(?:0|[1-9][0-9]*)$/) });
    expect(observed.map(quota => parseQuota(quota).remaining)).toEqual([20, 19, 19, 19]);
    expect(result.quota).toMatchObject({ limit: 20, remaining: 19 });
  });
  it("stops fake reservations at string-zero remaining quota", async () => {
    const { deps, request } = await setup();
    deps.prepare = vi.fn(deps.prepare!);
    for (let i = 0; i < 20; i++) await executePolish(deps, user, { ...request, clientRequestId: crypto.randomUUID() }, signal());
    expect(await deps.db.call("ai_quota", { contract_code: "cv_app_db_2", owner_auth_user_id: user, database_instance_id: fixtureInstance })).toMatchObject({ limit: "20", remaining: "0" });
    await expect(executePolish(deps, user, { ...request, clientRequestId: crypto.randomUUID() }, signal())).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(deps.prepare).toHaveBeenCalledTimes(20);
  });
});

describe("mutable configuration and frozen request boundaries", () => {
  it("uses the reserved endpoint, model and credential reference after the current configuration changes", async () => {
    const { deps, request } = await setup();
    const original = deps.db.call;
    const prepared: Array<Record<string, unknown>> = [];
    const prepare = deps.prepare!;
    deps.prepare = (configuration, onTransmit) => {
      prepared.push({ ...configuration });
      return prepare(configuration, onTransmit);
    };
    deps.db.call = async (name, input) => {
      const result = await original(name, input);
      if (name === "ai_reserve") Object.assign(deps.fixture.configurations[0], { name: "rotated-internal-name", display_name: "A new public name", endpoint_url: "https://another-supplier.example/responses", model_id: "another-model", credential_ref: "AI_PROVIDER_KEY_ROTATED", revision: "2" });
      return result;
    };
    await executePolish(deps, user, request, signal());
    expect(prepared).toEqual([expect.objectContaining({ endpoint_url: "https://api.deepseek.com/responses", model_id: "fixture-model-1", credential_ref: "AI_PROVIDER_KEY_FIXTURE_1" })]);
    const snapshot = await original("ai_execution_snapshot", { contract_code: "cv_app_db_2", owner_auth_user_id: user, database_instance_id: fixtureInstance, request_id: "req_000000000001" });
    expect(snapshot).toMatchObject({ config_name: "internal-connection-1", config_display_name: "DeepSeek" });
  });
  it("does not resurrect a reserved request after disable followed by enable", async () => {
    const { deps, request } = await setup();
    const original = deps.db.call, complete = vi.fn();
    deps.prepare = () => ({ complete });
    deps.db.call = async (name, input) => {
      const result = await original(name, input);
      if (name === "ai_reserve") { deps.fixture.setEnabled(false); deps.fixture.setEnabled(true); }
      return result;
    };
    await expect(executePolish(deps, user, request, signal())).rejects.toMatchObject({ reason: "REQUEST_NOT_TRANSMITTABLE" });
    expect(complete).not.toHaveBeenCalled();
    expect(await original("ai_quota", { contract_code: "cv_app_db_2", database_instance_id: fixtureInstance, owner_auth_user_id: user })).toMatchObject({ remaining: "20" });
  });
  it("isolates subject HMACs by the frozen connection and recipient endpoint", async () => {
    const subjects: string[] = [];
    for (const [configId, endpoint, recipientAudit] of [["1", "https://first.example/responses", "11"], ["2", "https://first.example/responses", "11"], ["1", "https://second.example/responses", "11"], ["1", "https://first.example/responses", "12"]]) {
      const { deps, request } = await setup(), original = deps.db.call, prepare = deps.prepare!;
      deps.db.call = async (name, input) => {
        const result = await original(name, input);
        return name === "ai_execution_snapshot" ? { ...(result as Record<string, unknown>), config_id: configId, endpoint_url: endpoint, provider_document_audit_id: recipientAudit } : result;
      };
      deps.prepare = (configuration, onTransmit) => {
        const provider = prepare(configuration, onTransmit);
        return { complete: async (input, options) => { subjects.push(input.providerSubjectId); return provider.complete(input, options); } };
      };
      await executePolish(deps, user, request, signal());
    }
    expect(new Set(subjects).size).toBe(4);
    expect(subjects.every(subject => /^[0-9a-f]{64}$/.test(subject))).toBe(true);
  });
  it("sends structured usage facts without client cost, provider code or attempt identifiers", async () => {
    const { deps, request } = await setup(), original = deps.db.call;
    const facts: Array<Record<string, unknown>> = [];
    deps.db.call = async (name, input) => { if (name === "ai_attempt_complete") facts.push(input); return original(name, input); };
    await executePolish(deps, user, request, signal());
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ attempt_no: 1, usage_complete: true, usage: { input_total: "10", cache_write: null, output: "10" } });
    expect(Object.keys(facts[0]).sort()).toEqual(["contract_code", "owner_auth_user_id", "database_instance_id", "request_id", "attempt_no", "state", "transmitted", "provider_billable", "retry_allowed", "usage_complete", "usage"].sort());
  });
});

describe("late settlement after cancellation authority disappears", () => {
  it("finalizes persisted terminal facts even if cancellation fails after the account was deleted", async () => {
    const { deps, request } = await setup(), original = deps.db.call, prepare = deps.prepare!;
    const controller = new AbortController();
    const calls: string[] = [];
    deps.db.call = async (name, input) => {
      calls.push(name);
      if (name === "ai_cancel") throw Object.assign(new Error("account no longer active"), { code: "UNAUTHORIZED" });
      return original(name, input);
    };
    deps.prepare = (configuration, onTransmit) => {
      const provider = prepare(configuration, onTransmit);
      return { complete: async (...args) => { const result = await provider.complete(...args); controller.abort(); return result; } };
    };
    // The response and usage are already known. A failed cancel cannot suppress
    // its trusted terminal write or the service-only finalization path.
    await expect(executePolish(deps, user, request, controller.signal)).rejects.toMatchObject({ code: "UNAVAILABLE", reason: "CANCELED" });
    expect(calls).toContain("ai_cancel");
    expect(calls.slice(-2)).toEqual(["ai_attempt_complete", "ai_finalize"]);
    const quota = await original("ai_quota", { contract_code: "cv_app_db_2", database_instance_id: fixtureInstance, owner_auth_user_id: user });
    expect(quota).toMatchObject({ reserved: "0", charged: "1" });
  });
});

describe("strict terminal acknowledgment", () => {
  it("does not retry when completion committed but its acknowledgment is malformed", async () => {
    const { deps, request } = await setup(), original = deps.db.call, prepare = deps.prepare!;
    let transmissions = 0;
    deps.prepare = (configuration, onTransmit) => {
      const provider = prepare(configuration, onTransmit);
      return { complete: async (...args) => { transmissions++; const response = await provider.complete(...args); return { ...response, text: "invalid JSON" }; } };
    };
    deps.db.call = async (name, input) => { const result = await original(name, input); return name === "ai_attempt_complete" ? null : result; };
    await expect(executePolish(deps, user, request, signal())).rejects.toThrow();
    expect(transmissions).toBe(1);
  });
});

describe("cancellation while waiting before another transmission", () => {
  it.each(["snapshot", "retry_backoff"] as const)("still finalizes known facts when cancel fails during %s", async phase => {
    const { deps, request } = await setup(), original = deps.db.call;
    const controller = new AbortController();
    const calls: string[] = [];
    let transmissions = 0;
    deps.prepare = (_configuration, onTransmit) => ({ complete: async () => {
      transmissions++;
      onTransmit();
      throw Object.assign(new Error("known rate-limit response"), { code: "UPSTREAM_ERROR", upstreamStatus: 429, retryAfterMs: 5000 });
    } });
    deps.db.call = async (name, input) => {
      calls.push(name);
      if (name === "ai_cancel") throw Object.assign(new Error("cancellation authority disappeared"), { code: "UNAUTHORIZED" });
      const result = await original(name, input);
      if (phase === "snapshot" && name === "ai_execution_snapshot") controller.abort();
      if (phase === "retry_backoff" && name === "ai_attempt_complete") setTimeout(() => controller.abort(), 0);
      return result;
    };
    await expect(executePolish(deps, user, request, controller.signal)).rejects.toMatchObject({ code: "UNAVAILABLE", reason: phase === "snapshot" ? "RELEASED" : "FAILED_UPSTREAM" });
    expect(transmissions).toBe(phase === "snapshot" ? 0 : 1);
    expect(calls).toContain("ai_cancel");
    expect(calls.at(-1)).toBe("ai_finalize");
    expect(await original("ai_quota", { contract_code: "cv_app_db_2", database_instance_id: fixtureInstance, owner_auth_user_id: user })).toMatchObject({ reserved: "0", charged: "0", remaining: "20" });
  });
});
