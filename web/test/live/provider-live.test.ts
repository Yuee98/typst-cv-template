/** Paid, explicitly selected local smoke. Ordinary unit/DB/CI suites exclude this file. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createProviderLiveDbFixture } from "../../../scripts/provider-live-db-fixture";
import { createAiDatabase } from "@/server/ai/database";
import { readAvailability } from "@/server/ai/availability";
import { executePolish, parseQuota } from "@/server/ai/runtime";
import { prepareProvider } from "@/server/ai/provider";
import { calculateCost, usageForDatabase } from "@/server/ai/accounting";
import type { NormalizedUsage } from "@/server/ai/inference";
import { validatePolishOutput } from "@/server/ai/validate";
import { observedConfigChecks } from "@/server/admin/validation-service";
import { polishPostRequestSchema, polishExpectedRouteFromAvailability } from "@/lib/polish/contract";
const supportedProviders = [{
  code: "DEEPSEEK" as const,
  modelId: "deepseek-flash",
  credentialRef: "AI_PROVIDER_KEY_DEEPSEEK_LIVE",
  keyFile: process.env.CV_LIVE_DEEPSEEK_KEY_FILE ?? resolve(homedir(), ".keys/.deepseek.local.key"),
  modelsEndpoint: "https://api.deepseek.com/models",
  endpoint: "https://api.deepseek.com/responses"
}, {
  code: "MIMO" as const,
  modelId: "mimo-v2.6-flash",
  credentialRef: "AI_PROVIDER_KEY_MIMO_LIVE",
  keyFile: process.env.CV_LIVE_MIMO_KEY_FILE ?? resolve(homedir(), ".keys/.mimo.local.key"),
  modelsEndpoint: "https://api.xiaomimimo.com/v1/models",
  endpoint: "https://api.xiaomimimo.com/v1/responses"
}, {
  code: "GEMINI" as const,
  modelId: "gemini-3.8-flash",
  credentialRef: "AI_PROVIDER_KEY_GEMINI_LIVE",
  keyFile: process.env.CV_LIVE_GEMINI_KEY_FILE ?? resolve(homedir(), ".keys/.gemini.local.key"),
  modelsEndpoint: "https://generativelanguage.googleapis.com/v1/models/gemini-3.8-flash",
  endpoint: "https://generativelanguage.googleapis.com/v1/interactions"
}];
const selectedCodes = process.env.CV_LIVE_PROVIDERS?.split(",");
if (selectedCodes && (selectedCodes.length === 0 || new Set(selectedCodes).size !== selectedCodes.length || selectedCodes.some(code => !supportedProviders.some(provider => provider.code === code)))) {
  throw new Error("CV_LIVE_PROVIDERS must select distinct supported Provider codes");
}
const providers = supportedProviders.filter(provider => !selectedCodes || selectedCodes.includes(provider.code));
const nativeFetch = globalThis.fetch;
const syntheticComponents = {
  INPUT_STANDARD: "1000000",
  INPUT_CACHE_READ: "100000",
  INPUT_CACHE_WRITE: "0",
  OUTPUT: "2000000"
};
const credentials: Record<string, string> = {};
const secret = randomBytes(32).toString("hex");
const outputPath = resolve(process.cwd(), providers.length === 1 ? `../tmp/provider-live-${providers[0].code.toLowerCase()}-smoke.json` : "../tmp/provider-live-smoke.json");
const evidence: Record<string, unknown> = {
  scope: "SYNTHETIC_TEXT_LOCAL_DATABASE_REAL_PROVIDER",
  timestamp: new Date().toISOString(),
  hosted_database_used: false,
  pricing: "SYNTHETIC_FIXTURE_RATES_NOT_PROVIDER_INVOICE",
  generation_request_limit_per_provider: 2,
  output_token_limit_per_request: 2048,
  required_wire_protocols: Object.fromEntries(providers.map(provider => [provider.code, provider.code === "GEMINI" ? "GEMINI_INTERACTIONS" : "RESPONSES"])),
  model_discovery: [],
  providers: {},
  cleanup_passed: false
};
let fixture: Awaited<ReturnType<typeof createProviderLiveDbFixture>> | undefined;
function saveEvidence() {
  mkdirSync(dirname(outputPath), {
    recursive: true
  });
  writeFileSync(outputPath, JSON.stringify(evidence, null, 2) + "\n");
}
function readKey(file: string) {
  let key: string;
  try {
    key = readFileSync(file, "utf8").trim();
  } catch {
    throw new Error("Live Provider credential file is unavailable");
  }
  if (!key || /\s/.test(key)) throw new Error("Live Provider credential file must contain one raw key");
  return key;
}
function safeUsage(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  return Object.fromEntries(["total_tokens", "input_tokens", "output_tokens", "total_input_tokens", "total_output_tokens", "total_thought_tokens", "total_cached_tokens", "total_tool_use_tokens"].filter(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0).map(key => [key, value[key]]));
}
beforeAll(async () => {
  if (process.env.CV_PROVIDER_LIVE_SMOKE !== "true" || process.env.CI === "true" || process.env.VERCEL_ENV) {
    throw new Error("Live Provider smoke is local and explicitly selected only");
  }
  for (const provider of providers) {
    const key = readKey(provider.keyFile);
    credentials[provider.credentialRef] = key;
    let response: Response;
    let body: {
      data?: Array<{
        id?: unknown;
      }>;
      name?: unknown;
    } | null;
    try {
      response = await nativeFetch(provider.modelsEndpoint, {
        headers: provider.code === "DEEPSEEK" ? {
          Authorization: `Bearer ${key}`
        } : provider.code === "GEMINI" ? {
          "x-goog-api-key": key
        } : {
          "api-key": key
        },
        redirect: "error",
        signal: AbortSignal.timeout(20_000)
      });
      body = response.ok ? await response.json() : null;
    } catch {
      throw new Error(`${provider.code} model discovery unavailable`);
    }
    const available = provider.code === "GEMINI" ? body?.name === `models/${provider.modelId}` : Array.isArray(body?.data) && body.data.some((model: {
      id?: unknown;
    }) => model.id === provider.modelId);
    (evidence.model_discovery as unknown[]).push({
      provider: provider.code,
      status: response.status,
      model: provider.modelId,
      available
    });
    saveEvidence();
    if (!response.ok || !available) throw new Error(`${provider.code} model discovery failed; see sanitized local evidence`);
  }
  fixture = await createProviderLiveDbFixture();
  const configured = await fixture.configure(providers.map(provider => ({
    providerCode: provider.code,
    modelId: provider.modelId,
    credentialRef: provider.credentialRef,
    // These deliberately synthetic rates exercise the real frozen-price arithmetic.
    priceComponents: syntheticComponents
  })), profiles => observedConfigChecks(profiles, credentials));
  evidence.configuration = {
    database: fixture.database,
    database_instance_id: fixture.instanceId,
    option_ids: configured.optionIds,
    model_ids: configured.modelIds,
    synthetic_pricing: configured.syntheticPricing
  };
  saveEvidence();
});
afterAll(async () => {
  try {
    if (fixture) evidence.ledger = await fixture.observe();
  } finally {
    try {
      if (fixture) await fixture.dispose();
      evidence.cleanup_passed = true;
    } finally {
      for (const name of Object.keys(credentials)) delete credentials[name];
      saveEvidence();
    }
  }
});
it.each(providers)("$code: real selected Provider output settles once in a disposable database", async selected => {
  if (!fixture) throw new Error("Live database fixture is unavailable");
  const db = createAiDatabase(fixture.client as unknown as SupabaseClient);
  const availability = await readAvailability(db, fixture.userId, fixture.instanceId, credentials);
  const option = availability.options.find(option => option.modelName === selected.modelId);
  if (!option || option.status !== "READY") throw new Error(`${selected.code} selected option is not ready`);
  if (selected.code === "MIMO" && availability.options.length > 1) expect(option.optionId).not.toBe(availability.defaultOptionId);
  const before = parseQuota(await db.call("ai_quota", {
    contract_code: "cv_app_db_1",
    database_instance_id: fixture.instanceId,
    owner_auth_user_id: fixture.userId
  }));
  const beforeLedger = await fixture.observe();
  const reservedBefore = beforeLedger.quota.reduce((sum: bigint, row: {
    reserved: string;
  }) => sum + BigInt(row.reserved), BigInt(0));
  const request = polishPostRequestSchema.parse({
    clientRequestId: crypto.randomUUID(),
    granularity: "item",
    sectionId: "profile",
    language: "en",
    items: [{
      id: "live0",
      kind: "profile",
      text: "Maintained backend services and automated tests."
    }],
    context: {
      level: 0,
      references: []
    },
    expectedRoute: polishExpectedRouteFromAvailability(availability, option.optionId)
  });
  const transmissions: Array<Record<string, unknown>> = [];
  const providerEvidence: Record<string, unknown> = {
    requested_model: selected.modelId,
    selected_option: option.optionId,
    nondefault_selection: option.optionId !== availability.defaultOptionId,
    transmissions,
    passed: false
  };
  (evidence.providers as Record<string, unknown>)[selected.code] = providerEvidence;
  const dependencies = {
    db,
    secret,
    env: credentials,
    prepare: (profile: Parameters<typeof prepareProvider>[0], onTransmit: () => void) => {
      const frozen = profile as {
        provider_code: string;
      };
      if (frozen.provider_code !== selected.code) throw new Error("Live test selected Provider mismatch");
      const actual = prepareProvider(profile, credentials, async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        const gemini = selected.code === "GEMINI";
        const budget = gemini ? body?.generation_config?.max_output_tokens : body?.max_output_tokens;
        const legacyFields = ["messages", "thinking", "max_tokens", "user_id"];
        if (!body || url !== selected.endpoint || init?.method !== "POST" || init.redirect !== "error" || body.model !== selected.modelId || !Number.isSafeInteger(budget) || budget < 1 || budget > 2048 || transmissions.length >= 2 || legacyFields.some(field => Object.hasOwn(body, field)) || typeof body.input !== "string" || body.stream !== false) {
          throw new Error("Live test protocol, model or request budget rejected");
        }
        if (gemini) {
          if (body.store !== false || body.background !== false || typeof body.system_instruction !== "string" || body.generation_config.thinking_level !== "low" || body.generation_config.thinking_summaries !== "none" || body.response_format?.type !== "text" || body.response_format?.mime_type !== "application/json" || typeof body.response_format?.schema !== "object" || ["tools", "previous_interaction_id", "user", "labels", "reasoning", "instructions", "max_output_tokens"].some(field => Object.hasOwn(body, field))) {
            throw new Error("Live Gemini Interactions privacy or JSON contract rejected");
          }
        } else if (Object.hasOwn(body, "response_format") || typeof body.instructions !== "string" || body.reasoning?.effort !== "none") {
          throw new Error("Live test Responses protocol rejected");
        }
        if (selected.code === "DEEPSEEK" && (body.text?.format?.type !== "json_object" || !/^[0-9a-f]{64}$/.test(body.user) || Object.hasOwn(body, "store") || Object.hasOwn(body, "tools"))) {
          throw new Error("Live DeepSeek Responses privacy or JSON contract rejected");
        }
        const observation: Record<string, unknown> = {
          max_output_tokens: budget,
          endpoint: url,
          wire_protocol: gemini ? "GEMINI_INTERACTIONS" : "RESPONSES",
          legacy_chat_fields_absent: true,
          subject_field: selected.code === "DEEPSEEK" ? "user" : null,
          store_parameter_sent: Object.hasOwn(body, "store")
        };
        transmissions.push(observation);
        onTransmit();
        saveEvidence();
        const started = Date.now();
        const response = await nativeFetch(input, init);
        observation.status = response.status;
        observation.elapsed_ms = Date.now() - started;
        try {
          const payload = await response.clone().json();
          observation.reported_model_matches = payload?.model === selected.modelId;
          observation.observed_model = payload?.model === selected.modelId ? selected.modelId : null;
          observation.response_object_matches_protocol = payload?.object === (gemini ? "interaction" : "response");
          if (gemini) observation.interaction_status_completed = payload?.status === "completed";
          if (selected.code === "DEEPSEEK") observation.response_store_false = payload?.store === false;
          if (selected.code === "MIMO") observation.output_message_states = Array.isArray(payload?.output) ? payload.output.map((item: Record<string, unknown>) => ({
            type: ["message", "reasoning"].includes(String(item?.type)) ? item.type : null,
            role: item?.role === "assistant" ? "assistant" : null,
            status_present: item !== null && typeof item === "object" && Object.hasOwn(item, "status"),
            status: ["completed", "in_progress", "incomplete"].includes(String(item?.status)) ? item.status : null
          })) : null;
          observation.raw_usage = safeUsage(payload?.usage);
        } catch {
          observation.response_json_unavailable = true;
        }
        saveEvidence();
        return response;
      });
      return {
        async complete(...args: Parameters<typeof actual.complete>) {
          try {
            const result = await actual.complete(...args);
            const validation = validatePolishOutput(result, {
              items: request.items,
              language: request.language
            });
            providerEvidence.finish_reason = result.finishReason;
            providerEvidence.normalized_usage = result.usage;
            providerEvidence.validation = validation.ok ? "PASSED" : validation.stage;
            saveEvidence();
            return result;
          } catch (error) {
            const safe = error as {
              code?: unknown;
              upstreamStatus?: unknown;
            };
            providerEvidence.adapter_error = safe.code === "UPSTREAM_ERROR" || safe.code === "UPSTREAM_TIMEOUT" ? safe.code : "OTHER_ERROR";
            if (Number.isSafeInteger(safe.upstreamStatus)) providerEvidence.upstream_status = safe.upstreamStatus;
            saveEvidence();
            throw error;
          }
        }
      };
    }
  };
  try {
    const result = await executePolish(dependencies, fixture.userId, request, new AbortController().signal);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("live0");
    expect(result.quota.remaining).toBe(before.remaining - 1);
    expect(transmissions.length).toBeGreaterThan(0);
    expect(transmissions.every(item => item.status === 200 && item.reported_model_matches === true && item.response_object_matches_protocol === true)).toBe(true);
    if (selected.code === "GEMINI") expect(transmissions.at(-1)?.interaction_status_completed).toBe(true);
    if (selected.code === "DEEPSEEK") expect(transmissions.every(item => item.response_store_false === true)).toBe(true);
    const count = transmissions.length;
    await expect(executePolish(dependencies, fixture.userId, request, new AbortController().signal)).rejects.toMatchObject({
      code: "CONFLICT",
      reason: "ALREADY_FINALIZED"
    });
    expect(transmissions).toHaveLength(count);
    providerEvidence.replay_sent_no_request = true;
    providerEvidence.quota_remaining = result.quota.remaining;
    const ledger = await fixture.observe();
    evidence.ledger = ledger;
    const record = ledger.requests.find((row: {
      providerCode: string;
    }) => row.providerCode === selected.code);
    expect(record).toMatchObject({
      state: "FINALIZED",
      outcome: "SUCCEEDED",
      charged: true,
      modelId: selected.modelId,
      currency: "CNY"
    });
    expect(record.attempts).toHaveLength(count);
    const lastAttempt = record.attempts.at(-1);
    const usage = providerEvidence.normalized_usage as NormalizedUsage;
    const expected = calculateCost(usage, {
      currency: "CNY",
      calculator_kind: "linear_token_v1",
      parameters: {},
      components: syntheticComponents
    });
    expect(lastAttempt).toMatchObject({
      state: "SUCCEEDED",
      transmitted: true,
      providerBillable: true,
      usage: usageForDatabase(usage)
    });
    expect(lastAttempt.estimatedCostNanos).toBe(expected.estimated);
    expect(lastAttempt.knownEstimatedCostNanos).toBe(expected.known);
    const reservedAfter = ledger.quota.reduce((sum: bigint, row: {
      reserved: string;
    }) => sum + BigInt(row.reserved), BigInt(0));
    expect(reservedAfter).toBe(reservedBefore);
    providerEvidence.durable_settlement_verified = true;
    providerEvidence.passed = true;
  } catch (error) {
    providerEvidence.passed = false;
    const safe = error as {
      code?: unknown;
      reason?: unknown;
    };
    if (["CONFLICT", "UNAVAILABLE", "FORBIDDEN", "INTERNAL_ERROR"].includes(String(safe.code))) {
      providerEvidence.runtime_error_code = safe.code;
      if (typeof safe.reason === "string" && /^[A-Z0-9_]{1,80}$/.test(safe.reason)) providerEvidence.runtime_error_reason = safe.reason;
    }
    throw new Error(`${selected.code} live pipeline failed; inspect ${outputPath.split("/").at(-1)} (sanitized)`);
  } finally {
    saveEvidence();
  }
});
