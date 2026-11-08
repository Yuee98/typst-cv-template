/** Disposable local SQL fixture. Never reads Provider keys or calls an inference API. */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { validateEndpoint } from "../web/src/server/ai/outbound.ts";
const SOURCE_CONTAINER = "supabase_db_typst-cv-template";
const DATABASE = "cv_provider_live_fixture";
const CONTRACT = "cv_app_db_2";
const RPCS = new Set(["app_context", "legal_current", "legal_accept_document", "legal_accept_ai", "admin_read", "admin_legal_document_save", "admin_configuration_save", "admin_rule_save", "admin_ai_update", "admin_ai_disable", "admin_allowed_user_set", "ai_availability", "ai_quota", "ai_reserve", "ai_execution_snapshot", "ai_attempt_start", "ai_attempt_complete", "ai_cancel", "ai_finalize"]);
const APP_ERRORS = new Set(["UNAUTHORIZED", "FORBIDDEN", "CONFLICT", "NOT_FOUND", "INVALID_REQUEST", "NOT_READY", "UNAVAILABLE", "RATE_LIMITED", "QUOTA_EXCEEDED", "INTERNAL_ERROR", "CLIENT_UPDATE_REQUIRED"]);
type Row = Record<string, unknown>;
export type LiveAdapterId = 1 | 2 | 3;
export interface LiveProviderConfiguration {
  adapterId: LiveAdapterId;
  name: string;
  endpointUrl: string;
  credentialRef: string;
  modelId: string;
  price: { currency: string; input_standard_nanos_per_million: string; input_cache_read_nanos_per_million: string; input_cache_write_nanos_per_million: string; output_nanos_per_million: string };
}
export interface SafeSqlError { code: string; message: string; details: string }
export interface LiveSqlClient { rpc(name: string, args?: { p_input?: Row }): Promise<{ data: unknown; error: SafeSqlError | null }> }
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const json = (value: unknown) => `${literal(JSON.stringify(value))}::jsonb`;
function capture(args: string[], input?: string) { return spawnSync("docker", args, { input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }); }
function safeError(stderr: string): SafeSqlError {
  const match = /ERROR:\s+([0-9A-Z]{5}):\s+([^\r\n]+)/.exec(stderr);
  const detail = /^DETAIL:\s+([^\r\n]+)/m.exec(stderr)?.[1]?.trim();
  return { code: match?.[1] ?? "XX000", message: match && APP_ERRORS.has(match[2].trim()) ? match[2].trim() : "INTERNAL_ERROR", details: detail && /^[A-Z][A-Z0-9_]{0,127}$/.test(detail) ? detail : "LOCAL_SQL_FIXTURE_REJECTED" };
}
function checked(args: string[], input?: string) {
  const result = capture(args, input);
  if (result.error || result.status !== 0) { const error = safeError(result.stderr ?? ""); throw new Error(`Local fixture: ${error.message}/${error.details} (${error.code})`); }
  return result.stdout.trim();
}
function psql(statement: string, database = DATABASE) { return checked(["exec", "-i", SOURCE_CONTAINER, "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-U", "supabase_admin", "-d", database], statement); }
const object = (value: unknown): Row => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local SQL object"); return value as Row; };
export function validateLiveConfigurations(configurations: readonly LiveProviderConfiguration[]) {
  if (!configurations.length || configurations.length > 3 || new Set(configurations.map(configuration => configuration.name)).size !== configurations.length) throw new Error("Choose one to three distinct named configurations");
  for (const configuration of configurations) {
    if (![1, 2, 3].includes(configuration.adapterId) || !/^AI_PROVIDER_KEY_[A-Z0-9_]+$/.test(configuration.credentialRef) || !configuration.modelId.trim() || configuration.modelId.length > 200 || !configuration.name.trim()) throw new Error("Invalid local execution configuration");
    validateEndpoint(configuration.endpointUrl);
    if (!/^[A-Z]{3}$/.test(configuration.price.currency)) throw new Error("Invalid synthetic currency");
    for (const field of ["input_standard_nanos_per_million", "input_cache_read_nanos_per_million", "input_cache_write_nanos_per_million", "output_nanos_per_million"] as const) {
      const amount = configuration.price[field];
      if (typeof amount !== "string" || !/^(0|[1-9][0-9]*)$/.test(amount) || BigInt(amount) > BigInt("9223372036854775807")) throw new Error("Four explicit synthetic integer rates are required");
    }
  }
}
export async function createProviderLiveDbFixture() {
  if (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith("unix://")) throw new Error("A local Unix Docker daemon is required");
  const dockerContext = JSON.parse(checked(["context", "inspect"]))[0];
  if (!dockerContext?.Endpoints?.docker?.Host?.startsWith("unix://")) throw new Error("Remote Docker contexts are forbidden");
  const inspected = JSON.parse(checked(["inspect", SOURCE_CONTAINER]))[0];
  if (inspected.Name !== `/${SOURCE_CONTAINER}` || !inspected.State?.Running || !(inspected.NetworkSettings?.Ports?.["5432/tcp"] ?? []).some((binding: { HostPort: string }) => binding.HostPort === "54322")) throw new Error("Expected the fixed local Supabase database");
  const source = object(JSON.parse(psql("select public.app_context();", "postgres")));
  if (source.contract_code !== CONTRACT || source.environment !== "LOCAL" || source.ready !== true) throw new Error("Source must be the ready current LOCAL database");
  if (psql(`select count(*) from pg_catalog.pg_database where datname=${literal(DATABASE)};`, "template1") !== "0") throw new Error("Fixture database exists; refusing to overwrite it");
  const userId = randomUUID(), sessionId = randomUUID();
  const claims = { sub: userId, role: "authenticated", session_id: sessionId, aal: "aal1", amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) }] };
  let created = false, disposed = false, configured = false, instanceId = "";
  const guard = () => { if (!created || disposed) throw new Error("Fixture is closed"); };
  const common = () => ({ contract_code: CONTRACT, database_instance_id: instanceId });
  const dispose = async () => { if (created && !disposed) { psql(`drop database ${DATABASE} with (force);`, "template1"); disposed = true; } };
  function rpc(name: string, payload?: Row, authenticated = false) {
    guard();
    if (!RPCS.has(name)) throw new Error("Unreviewed fixture RPC");
    const role = authenticated ? "authenticated" : "service_role";
    const statement = `begin;select set_config('request.jwt.claims',${json(authenticated ? claims : { role: "service_role" })}::text,true);set local role ${role};select public.${name}(${payload === undefined ? "" : json(payload)});commit;`;
    const result = capture(["exec", "-i", SOURCE_CONTAINER, "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-U", "supabase_admin", "-d", DATABASE], statement);
    if (result.error || result.status !== 0) return { data: null, error: safeError(result.stderr ?? "") };
    try { return { data: JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!), error: null }; }
    catch { return { data: null, error: { code: "XX000", message: "INTERNAL_ERROR", details: "INVALID_LOCAL_RPC_JSON" } }; }
  }
  function required(name: string, input?: Row, authenticated = false): Row {
    const result = rpc(name, input, authenticated);
    if (result.error) throw new Error(`Local ${name}: ${result.error.message}/${result.error.details}`);
    return object(result.data);
  }
  function admin(name: string, input: Row) { return required(name, { ...common(), operation_key: randomUUID(), reason: "Local disposable synthetic Provider fixture", ...input }, true); }
  const currentDocuments = () => required("legal_current").documents as Row[];
  function document(kind: string, label: string, scope: Row = {}) {
    const receipt = admin("admin_legal_document_save", {
      id: null, expected_revision: null, kind, zh_title: `本地测试 ${label}`, en_title: `Local fixture ${label}`,
      zh_body: "仅供本地集成测试；本披露不代表供应商实际政策。", en_body: "Synthetic integration fixture. These terms do not describe the supplier's actual policies.",
      effective_date: new Date().toISOString().slice(0, 10), recipient_name: null, adapter_id: null, endpoint_url: null, model_id: null, enabled: true, ...scope
    });
    const target = currentDocuments().find(item => item.document_id === receipt.entity_id);
    if (!target) throw new Error("Created legal document was not read back");
    return target;
  }
  try {
    psql(`create database ${DATABASE} owner postgres;`, "template1"); created = true;
    psql('create schema extensions;create extension pgcrypto with schema extensions;create extension btree_gist with schema extensions;create extension if not exists "uuid-ossp" with schema extensions;drop schema public;');
    const schemas = ["public", "common", "cv", "ai", "legal", "admin", "audit", "auth"];
    const ddl = checked(["exec", SOURCE_CONTAINER, "pg_dump", "-U", "supabase_admin", "-d", "postgres", "--schema-only", "--no-publications", "--no-subscriptions", ...schemas.map(schema => `--schema=${schema}`)]);
    psql(ddl);
    psql(`grant usage on schema extensions to app_api_owner;grant execute on function extensions.gen_random_bytes(integer),extensions.digest(text,text) to app_api_owner;
      insert into ai.adapters(id,name) values(1,'DeepSeek Responses'),(2,'MiMo Responses'),(3,'Gemini Interactions');
      insert into ai.runtime_control(id) values(1);
      insert into auth.users(id,email,email_confirmed_at) values(${literal(userId)},${literal(`fixture-${userId}@fixture.invalid`)},clock_timestamp());
      insert into auth.sessions(id,user_id) values(${literal(sessionId)},${literal(userId)});
      set role postgres;select admin.initialize('LOCAL',${literal(userId)});reset role;`);
    instanceId = String(required("app_context").database_instance_id);
  } catch (error) { await dispose(); throw error; }
  return {
    userId, instanceId, database: DATABASE,
    client: { async rpc(name: string, args?: { p_input?: Row }) { return rpc(name, args?.p_input, name.startsWith("legal_accept")); } } satisfies LiveSqlClient,
    admin,
    async configure(configurations: readonly LiveProviderConfiguration[]) {
      guard(); validateLiveConfigurations(configurations);
      if (configured) throw new Error("Fixture is already configured");
      const terms = document("TERMS", "Terms"), commonDocument = document("AI_COMMON", "AI common terms");
      required("legal_accept_document", { ...common(), expected_auth_user_id: userId, document_id: terms.document_id, document_audit_id: terms.document_audit_id }, true);
      const configIds: Record<string, string> = {};
      for (const configuration of configurations) {
        const provider = document("AI_PROVIDER", configuration.name, { recipient_name: configuration.name, adapter_id: configuration.adapterId, endpoint_url: configuration.endpointUrl, model_id: configuration.modelId });
        required("legal_accept_ai", { ...common(), expected_auth_user_id: userId, common: { document_id: commonDocument.document_id, document_audit_id: commonDocument.document_audit_id }, provider: { document_id: provider.document_id, document_audit_id: provider.document_audit_id } }, true);
        const receipt = admin("admin_configuration_save", { id: null, expected_revision: null, name: configuration.name, adapter_id: configuration.adapterId, endpoint_url: configuration.endpointUrl, credential_ref: configuration.credentialRef, model_id: configuration.modelId, legal_document_id: provider.document_id, enabled: true, price: configuration.price });
        configIds[configuration.name] = String(receipt.entity_id);
      }
      admin("admin_rule_save", { id: null, expected_revision: null, weekday: null, start_minute: null, end_minute: null, enabled: true, members: Object.values(configIds).map((id, index) => ({ config_id: id, is_default: index === 0 })) });
      const context = required("admin_read", { ...common(), expected_environment: "LOCAL", section: "controls" }, true);
      admin("admin_ai_update", { expected_revision: object(object(context.context).control).revision, enabled: true, audience: "ALL", user_daily_limit: "20", global_daily_limit: "100", user_minute_limit: "20" });
      configured = true;
      return { availability: required("ai_availability", { ...common(), owner_auth_user_id: userId }), configIds, syntheticPricing: true as const };
    },
    async observe() {
      guard();
      return object(JSON.parse(psql(`select jsonb_build_object('requests',coalesce((select jsonb_agg(jsonb_build_object('requestId',r.external_id,'configId',s.config_id::text,'state',r.state,'outcome',r.outcome,'charged',r.charged,'modelId',s.model_id,'currency',s.currency,'attempts',(select coalesce(jsonb_agg(jsonb_build_object('attemptNo',a.attempt_no,'state',a.state,'transmitted',a.transmitted,'providerBillable',a.provider_billable,'estimatedCostNanos',a.estimated_cost_nanos::text,'knownEstimatedCostNanos',a.known_estimated_cost_nanos::text,'usage',jsonb_build_object('input_total',a.input_total::text,'input_standard',a.input_standard::text,'cache_read',a.cache_read::text,'cache_write',a.cache_write::text,'output',a.output::text,'reasoning',a.reasoning::text)) order by a.attempt_no),'[]'::jsonb) from ai.attempts a where a.request_id=r.id)) order by r.id) from ai.requests r join ai.request_snapshots s on s.request_id=r.id),'[]'::jsonb),'quota',coalesce((select jsonb_agg(jsonb_build_object('reserved',reserved_count::text,'charged',charged_count::text)) from ai.user_quota_daily),'[]'::jsonb));`)));
    },
    async analytics(days = 7) { if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("Invalid analytics range"); return required("admin_read", { ...common(), expected_environment: "LOCAL", section: "usage", kind: "analytics", days }, true); },
    dispose
  };
}
