/** Explicit paid local smoke. Ordinary tests and CI never load credentials or send inference. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { readFileSync, mkdirSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createProviderLiveDbFixture, type LiveAdapterId } from "../../../scripts/provider-live-db-fixture";
import { createAiDatabase } from "@/server/ai/database";
import { readAvailability } from "@/server/ai/availability";
import { executePolish } from "@/server/ai/runtime";
import { prepareProvider } from "@/server/ai/provider";
import { createInferenceFetch } from "@/server/ai/outbound";
import { usageForDatabase } from "@/server/ai/accounting";
import type { NormalizedUsage } from "@/server/ai/inference";
import { polishPostRequestSchema, polishExpectedRouteFromAvailability } from "@/lib/polish/contract";
const supported = [
  { name: "DEEPSEEK", adapterId: 1 as LiveAdapterId, modelId: "deepseek-flash", endpoint: "https://api.deepseek.com/responses", models: "https://api.deepseek.com/models", keyFile: process.env.CV_LIVE_DEEPSEEK_KEY_FILE ?? resolve(homedir(), ".keys/.deepseek.local.key") },
  { name: "MIMO", adapterId: 2 as LiveAdapterId, modelId: "mimo-v2.6-flash", endpoint: "https://api.xiaomimimo.com/v1/responses", models: "https://api.xiaomimimo.com/v1/models", keyFile: process.env.CV_LIVE_MIMO_KEY_FILE ?? resolve(homedir(), ".keys/.mimo.local.key") },
  { name: "GEMINI", adapterId: 3 as LiveAdapterId, modelId: "gemini-3.8-flash", endpoint: "https://generativelanguage.googleapis.com/v1/interactions", models: "https://generativelanguage.googleapis.com/v1/models/gemini-3.8-flash", keyFile: process.env.CV_LIVE_GEMINI_KEY_FILE ?? resolve(homedir(), ".keys/.gemini.local.key") }
].map(provider => ({ ...provider, credentialRef: `AI_PROVIDER_KEY_${provider.name}_LIVE` }));
const selectedNames = process.env.CV_LIVE_PROVIDERS?.split(",");
if (selectedNames && (!selectedNames.length || new Set(selectedNames).size !== selectedNames.length || selectedNames.some(name => !supported.some(provider => provider.name === name)))) throw new Error("Select distinct supported live connections");
const providers = supported.filter(provider => !selectedNames || selectedNames.includes(provider.name));
const maxTransmissionsValue = process.env.CV_LIVE_MAX_TRANSMISSIONS ?? "2";
if (maxTransmissionsValue !== "1" && maxTransmissionsValue !== "2") throw new Error("Choose a live transmission limit of 1 or 2");
const maxTransmissions = Number(maxTransmissionsValue);
const inputCases = {
  default: { language: "en" as const, text: "Maintained backend services and automated tests." },
  hosted_mimo_synthetic: { language: "zh" as const, text: "负责维护后端服务及自动化测试。" }
};
const inputCaseName = process.env.CV_LIVE_INPUT_CASE ?? "default";
if (!Object.hasOwn(inputCases, inputCaseName)) throw new Error("Choose a reviewed synthetic live input case");
if (inputCaseName === "hosted_mimo_synthetic" && (providers.length !== 1 || providers[0].name !== "MIMO")) throw new Error("The hosted MiMo comparison requires MiMo only");
const inputCase = inputCases[inputCaseName as keyof typeof inputCases];
const nativeFetch = globalThis.fetch;
const price = { currency: "CNY", input_standard_nanos_per_million: "1000000", input_cache_read_nanos_per_million: "100000", input_cache_write_nanos_per_million: "0", output_nanos_per_million: "2000000" };
const credentials: Record<string, string> = {};
const secret = randomBytes(32).toString("hex");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const outputPath = resolve(repoRoot, process.env.CV_LIVE_EVIDENCE_PATH ?? "tmp/provider-live-db2-smoke.json");
const outputRelative = relative(repoRoot, outputPath);
if (!["output", "tmp"].some(directory => outputRelative.startsWith(directory + sep))) throw new Error("Live evidence must stay in the repository's ignored output or tmp directory");
const sourcePaths = ["web/test/live/provider-live.test.ts", "scripts/provider-live-db-fixture.ts", "web/src/server/ai/runtime.ts", "web/src/server/ai/provider.ts", "web/src/server/ai/outbound.ts", "web/src/server/ai/mimo.ts", "web/src/server/ai/deepseek.ts", "web/src/server/ai/gemini.ts", "web/src/server/ai/prompt.ts", "web/src/server/ai/validate.ts", "web/src/server/ai/accounting.ts", "web/src/lib/polish/contract.ts"];
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const git = (args: string[]) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const evidence: Record<string, unknown> = {
  contract: "cv_app_db_2", scope: "LOCAL_DISPOSABLE_DB_SYNTHETIC_TEXT_REAL_PROVIDER", timestamp: new Date().toISOString(), hosted_database_used: false,
  pricing: "SYNTHETIC_NOT_INVOICE", request_limit_per_connection: maxTransmissions, output_token_limit: 2048,
  input_case: inputCaseName, input_characters: inputCase.text.length, language: inputCase.language,
  source: { head_sha: git(["rev-parse", "HEAD"]), execution_files_dirty: git(["status", "--porcelain", "--untracked-files=no", "--", ...sourcePaths]).length > 0, file_sha256: Object.fromEntries(sourcePaths.map(path => [path, sha256(readFileSync(resolve(repoRoot, path)))])) },
  auth_fixture: "SYNTHETIC_SQL_SESSION_ON_REAL_LOCAL_AUTH_SCHEMA_NOT_LOGIN_EVIDENCE", connections: {}, cleanup_passed: false
};
let fixture: Awaited<ReturnType<typeof createProviderLiveDbFixture>> | undefined;
let configIds: Record<string, string> = {};
let ownsEvidence = false;
function evidenceText() { return JSON.stringify(evidence, null, 2) + "\n"; }
function reserveEvidence() {
  let ancestor = repoRoot;
  for (const segment of outputRelative.split(sep)) {
    ancestor = resolve(ancestor, segment);
    if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink()) throw new Error("Live evidence cannot follow symbolic links");
  }
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(outputPath, evidenceText(), { flag: "wx", mode: 0o600 });
  ownsEvidence = true;
}
function saveEvidence() { if (ownsEvidence) writeFileSync(outputPath, evidenceText(), { mode: 0o600 }); }
function safeErrorMetadata(error: unknown) {
  const value = error !== null && typeof error === "object" ? error as { name?: unknown; code?: unknown; reason?: unknown; upstreamStatus?: unknown } : {};
  const codes = new Set(["UPSTREAM_ERROR", "UPSTREAM_TIMEOUT", "UNAVAILABLE", "CONFLICT", "UNAUTHORIZED", "FORBIDDEN", "INVALID_REQUEST", "INTERNAL_ERROR", "LIVE_TRANSMISSION_LIMIT"]);
  const reasons = new Set(["HELD", "FAILED_UPSTREAM", "INVALID_OUTPUT", "EXECUTION_CONFIG_UNAVAILABLE", "ALREADY_FINALIZED", "REQUEST_IN_PROGRESS", "CONFIG_CHANGED", "OPTION_UNAVAILABLE"]);
  const names = new Set(["AiError", "MimoResponsesAdapterError", "DeepSeekResponsesAdapterError", "GeminiInteractionsAdapterError", "LiveTransmissionLimitError"]);
  return {
    kind: typeof value.name === "string" && names.has(value.name) ? value.name : "OTHER",
    code: typeof value.code === "string" && codes.has(value.code) ? value.code : "UNCLASSIFIED",
    reason: typeof value.reason === "string" && reasons.has(value.reason) ? value.reason : null,
    upstream_status: Number.isInteger(value.upstreamStatus) && Number(value.upstreamStatus) >= 100 && Number(value.upstreamStatus) <= 599 ? value.upstreamStatus : null
  };
}
function httpFailureKind(status: number) {
  if (status < 400) return status >= 300 ? "REDIRECT_REJECTED" : "NONE";
  if (status === 401 || status === 403) return "AUTH_OR_ACCESS_REJECTED";
  if (status === 402) return "PAYMENT_REJECTED";
  if (status === 429) return "RATE_LIMITED";
  return status >= 500 ? "UPSTREAM_SERVER_ERROR" : "REQUEST_REJECTED";
}
function readKey(path: string) { let key: string; try { key = readFileSync(path, "utf8").trim(); } catch { throw new Error("Explicit local credential file unavailable"); } if (!key || /\s/.test(key)) throw new Error("Expected one raw local credential"); return key; }
function authentication(adapterId: LiveAdapterId, key: string): Record<string, string> { return adapterId === 1 ? { Authorization: `Bearer ${key}` } : adapterId === 2 ? { "api-key": key } : { "x-goog-api-key": key }; }
interface Ledger { requests: Array<{ requestId: string; configId: string; state: string; outcome: string; charged: boolean; modelId: string; currency: string; attempts: Array<{ attemptNo: number; state: string; transmitted: boolean; providerBillable: boolean; estimatedCostNanos: string | null; knownEstimatedCostNanos: string | null; usage: ReturnType<typeof usageForDatabase> }> }>; quota: Array<{ reserved: string; charged: string }> }
beforeAll(async () => {
  if (process.env.CV_PROVIDER_LIVE_SMOKE !== "true" || process.env.CI === "true" || process.env.VERCEL_ENV || process.env.ADMIN_ENVIRONMENT && process.env.ADMIN_ENVIRONMENT.toLowerCase() !== "local") throw new Error("Live smoke requires explicit local paid authorization");
  reserveEvidence();
  for (const provider of providers) {
    const key = readKey(provider.keyFile); credentials[provider.credentialRef] = key;
    let available = false;
    try {
      const response = await nativeFetch(provider.models, { headers: authentication(provider.adapterId, key), redirect: "error", signal: AbortSignal.timeout(20000) });
      const body = response.ok ? await response.json() : null;
      available = response.ok && (provider.adapterId === 3 ? body?.name === `models/${provider.modelId}` : Array.isArray(body?.data) && body.data.some((model: { id?: unknown }) => model.id === provider.modelId));
      evidence.model_metadata = { provider: provider.name, status: response.status, available };
    } catch { /* Only the safe decision is reported. */ }
    saveEvidence();
    if (!available) throw new Error(`${provider.name} model metadata unavailable`);
  }
  fixture = await createProviderLiveDbFixture();
  const configured = await fixture.configure(providers.map(provider => ({ adapterId: provider.adapterId, name: provider.name, displayName: `Local ${provider.name}`, recipientName: provider.name, endpointUrl: provider.endpoint, credentialRef: provider.credentialRef, modelId: provider.modelId, price })));
  configIds = configured.configIds;
  evidence.configuration = { database: fixture.database, instance: fixture.instanceId, config_ids: configIds, synthetic_pricing: true };
  saveEvidence();
});
afterAll(async () => { try { if (fixture) evidence.ledger = await fixture.observe(); } finally { try { if (fixture) { await fixture.dispose(); evidence.cleanup_passed = true; } } finally { for (const reference of Object.keys(credentials)) delete credentials[reference]; saveEvidence(); } } });
it.each(providers)("$name: selected connection settles once and replay sends nothing", async selected => {
  if (!fixture) throw new Error("Fixture unavailable");
  const db = createAiDatabase(fixture.client as unknown as SupabaseClient);
  const availability = await readAvailability(db, fixture.userId, fixture.instanceId, credentials);
  const selectedConfigId = configIds[selected.name];
  const choice = availability.configurations.find(configuration => configuration.configId === selectedConfigId);
  if (!choice || choice.status !== "READY") throw new Error("Selected connection is not ready");
  const request = polishPostRequestSchema.parse({ clientRequestId: crypto.randomUUID(), granularity: "item", sectionId: "profile", language: inputCase.language, items: [{ id: "live0", kind: "profile", text: inputCase.text }], context: { level: 0, references: [] }, expectedRoute: polishExpectedRouteFromAvailability(availability, selectedConfigId) });
  const transmissions: Array<Record<string, unknown>> = [];
  const resultEvidence: Record<string, unknown> = { model: selected.modelId, config_id: selectedConfigId, transmissions, passed: false };
  (evidence.connections as Record<string, unknown>)[selected.name] = resultEvidence;
  let observedUsage: NormalizedUsage | null = null;
  const dependencies = { db, secret, env: credentials, prepare: (configuration: Parameters<typeof prepareProvider>[0], onTransmit: () => void) => {
    const actual = prepareProvider(configuration, credentials, async (input, init) => {
      if (transmissions.length >= maxTransmissions) {
        resultEvidence.retry_blocked_by_local_transmission_limit = true;
        saveEvidence();
        throw Object.assign(new Error("Local live transmission budget exhausted"), { name: "LiveTransmissionLimitError", code: "LIVE_TRANSMISSION_LIMIT", retryable: false });
      }
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      const budget = selected.adapterId === 3 ? body?.generation_config?.max_output_tokens : body?.max_output_tokens;
      if (input !== selected.endpoint || init?.method !== "POST" || init.redirect !== "error" || !body || body.model !== selected.modelId || !Number.isSafeInteger(budget) || budget < 1 || budget > 2048 || typeof body.input !== "string" || body.stream !== false || ["messages", "thinking", "max_tokens", "user_id"].some(field => Object.hasOwn(body, field))) throw new Error("Live protocol or paid budget rejected");
      if (selected.adapterId === 3) {
        if (body.store !== false || body.background !== false || typeof body.system_instruction !== "string" || body.generation_config.thinking_level !== "low" || body.generation_config.thinking_summaries !== "none" || body.response_format?.mime_type !== "application/json" || ["tools", "previous_interaction_id", "user"].some(field => Object.hasOwn(body, field))) throw new Error("Gemini request contract rejected");
      } else {
        if (typeof body.instructions !== "string" || body.reasoning?.effort !== "none" || Object.hasOwn(body, "response_format")) throw new Error("Responses request contract rejected");
        if (selected.adapterId === 1 && (body.text?.format?.type !== "json_object" || !/^[0-9a-f]{64}$/.test(body.user) || Object.hasOwn(body, "store") || Object.hasOwn(body, "tools"))) throw new Error("DeepSeek request contract rejected");
      }
      const observation: Record<string, unknown> = {
        max_output_tokens: budget, endpoint: selected.endpoint, transmitted: false,
        wire: { body_keys: Object.keys(body).sort(), body_sha256: sha256(String(init.body)), input_type: typeof body.input, input_characters: body.input.length, instructions_characters: typeof body.instructions === "string" ? body.instructions.length : null, reasoning_effort_none: body.reasoning?.effort === "none", stream_false: body.stream === false, store_parameter_sent: Object.hasOwn(body, "store") }
      };
      transmissions.push(observation); saveEvidence();
      const safeEgress = createInferenceFetch({ onTransmit: () => { observation.transmitted = true; onTransmit(); } });
      const started = Date.now();
      let response: Response;
      try { response = await safeEgress(input, init); }
      catch (error) {
        observation.elapsed_ms = Date.now() - started;
        observation.transport_error = safeErrorMetadata(error);
        saveEvidence();
        throw error;
      }
      observation.status = response.status; observation.elapsed_ms = Date.now() - started;
      observation.http_failure_kind = httpFailureKind(response.status);
      try {
        const payload = await response.clone().json();
        observation.model_matches = payload?.model === selected.modelId;
        observation.object_matches = payload?.object === (selected.adapterId === 3 ? "interaction" : "response");
        const statuses = ["completed", "in_progress", "incomplete", "failed", "cancelled", "canceled", "queued"];
        observation.response_shape = {
          status: statuses.includes(payload?.status) ? payload.status : "OTHER_OR_MISSING",
          error_present: payload?.error != null,
          errors_present: Array.isArray(payload?.errors) && payload.errors.length > 0,
          usage_present: payload?.usage !== null && typeof payload?.usage === "object",
          output_is_array: Array.isArray(payload?.output),
          provider_request_id_present: typeof payload?.id === "string"
        };
      } catch { observation.response_json_unavailable = true; }
      saveEvidence(); return response;
    });
    return { async complete(...args: Parameters<typeof actual.complete>) {
      try {
        const result = await actual.complete(...args);
        observedUsage = result.usage; resultEvidence.finish_reason = result.finishReason; resultEvidence.normalized_usage = result.usage; return result;
      } catch (error) {
        resultEvidence.adapter_error = safeErrorMetadata(error); saveEvidence(); throw error;
      }
    } };
  } };
  try {
    const result = await executePolish(dependencies, fixture.userId, request, new AbortController().signal);
    expect(result.items).toHaveLength(1);
    expect(transmissions.length).toBeGreaterThan(0); expect(transmissions.length).toBeLessThanOrEqual(maxTransmissions);
    expect(transmissions.at(-1)).toMatchObject({ status: 200, model_matches: true, object_matches: true });
    const count = transmissions.length;
    await expect(executePolish(dependencies, fixture.userId, request, new AbortController().signal)).rejects.toMatchObject({ code: "CONFLICT", reason: "ALREADY_FINALIZED" });
    expect(transmissions).toHaveLength(count);
    const ledger = await fixture.observe() as unknown as Ledger;
    const record = ledger.requests.find(row => row.configId === selectedConfigId);
    expect(record).toMatchObject({ state: "FINALIZED", outcome: "SUCCEEDED", charged: true, modelId: selected.modelId, currency: "CNY" });
    expect(record!.attempts).toHaveLength(count);
    const usage = observedUsage as unknown as NormalizedUsage;
    const expectedNanos = (BigInt(usage.inputStandardTokens) * BigInt(price.input_standard_nanos_per_million) + BigInt(usage.inputCacheReadTokens) * BigInt(price.input_cache_read_nanos_per_million) + BigInt(usage.outputTokens) * BigInt(price.output_nanos_per_million) + BigInt(999999)) / BigInt(1000000);
    expect(record!.attempts.at(-1)).toMatchObject({ state: "SUCCEEDED", transmitted: true, providerBillable: true, usage: usageForDatabase(usage), estimatedCostNanos: expectedNanos.toString(), knownEstimatedCostNanos: expectedNanos.toString() });
    expect(ledger.quota.every(bucket => bucket.reserved === "0")).toBe(true);
    resultEvidence.passed = true; resultEvidence.replay_sent_no_request = true;
  } catch (error) {
    resultEvidence.runtime_error = safeErrorMetadata(error);
    throw new Error(`${selected.name} live smoke failed; inspect sanitized local evidence`);
  }
  finally { saveEvidence(); }
});
