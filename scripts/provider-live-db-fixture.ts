/**
 * Local disposable SQL fixture for a caller-controlled Provider live smoke.
 * This module never reads Provider keys or makes network requests. The caller owns
 * prepareProvider/executePolish and the explicit paid-request budget.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const SOURCE_CONTAINER = "supabase_db_typst-cv-template";
const DATABASE = "cv_provider_live_fixture";
const CONTRACT = "cv_app_db_1";
const SERVICE_RPCS = new Set(["ai_availability", "ai_quota", "ai_reserve", "ai_execution_snapshot", "ai_attempt_start", "ai_attempt_complete", "ai_cancel", "ai_finalize", "config_validation_candidate", "config_validation_record", "runtime_readback_candidate", "runtime_readback_record"]);
const ADMIN_WRITES = new Set(["admin_profile_create", "admin_profile_version_create", "admin_profile_version_publish", "admin_price_version_create", "admin_price_version_publish", "admin_policy_create", "admin_policy_version_create", "admin_policy_version_publish", "admin_ai_set_policy", "admin_ai_set_allowed_user", "admin_ai_reopen"]);
const APP_ERRORS = new Set(["UNAUTHORIZED", "FORBIDDEN", "CONFLICT", "NOT_FOUND", "INVALID_REQUEST", "STEP_UP_REQUIRED", "NOT_READY", "UNAVAILABLE", "RATE_LIMITED", "QUOTA_EXCEEDED", "INTERNAL_ERROR", "CLIENT_UPDATE_REQUIRED"]);
type Row = Record<string, any>;
export type LiveProviderCode = "DEEPSEEK" | "MIMO" | "GEMINI";
export interface LiveProviderConfiguration {
  providerCode: LiveProviderCode;
  credentialRef: string;
  modelId?: string;
  currency?: string;
  /** Synthetic nanos per million tokens. These are deliberately not upstream prices. */
  priceComponents: Record<"INPUT_STANDARD" | "INPUT_CACHE_READ" | "INPUT_CACHE_WRITE" | "OUTPUT", string>;
}
export type LiveCandidateValidator = (profiles: readonly Record<string, unknown>[]) => string[] | Promise<string[]>;
export interface SafeSqlError {
  code: string;
  message: string;
  details: string;
}
export interface LiveSqlClient {
  rpc(name: string, args?: {
    p_input?: Record<string, unknown>;
  }): Promise<{
    data: unknown;
    error: SafeSqlError | null;
  }>;
}
export interface ProviderLiveDbFixture {
  readonly userId: string;
  readonly instanceId: string;
  readonly database: string;
  readonly client: LiveSqlClient;
  configure(providers: readonly LiveProviderConfiguration[], validate: LiveCandidateValidator): Promise<{
    availability: Row;
    optionIds: Partial<Record<LiveProviderCode, string>>;
    modelIds: Partial<Record<LiveProviderCode, string>>;
    syntheticPricing: true;
  }>;
  verifyPolicyCommits(): Promise<{
    validCommitted: true;
    invalidCommitRejected: true;
    immediateCheckRejected: true;
  }>;
  observe(): Promise<Row>;
  analytics(days?: number): Promise<Row>;
  dispose(): Promise<void>;
}
function literal(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
function json(value: unknown) {
  return `${literal(JSON.stringify(value))}::jsonb`;
}
function capture(args: string[], input?: string) {
  return spawnSync("docker", args, {
    input,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
}
function safeError(stderr: string, fallback = "LOCAL_SQL_FIXTURE_REJECTED"): SafeSqlError {
  const match = /ERROR:\s+([0-9A-Z]{5}):\s+([^\r\n]+)/.exec(stderr);
  const detail = /^DETAIL:\s+([^\r\n]+)/m.exec(stderr)?.[1]?.trim();
  const code = match?.[1] ?? "XX000";
  const permission = /^permission denied for (schema|table|sequence|function|relation) ([A-Za-z_][A-Za-z0-9_]*)$/.exec(match?.[2]?.trim() ?? "");
  if (permission) fallback = `PERMISSION_DENIED_${permission[1]}_${permission[2]}`.toUpperCase();
  const message = match && APP_ERRORS.has(match[2].trim()) ? match[2].trim() : "INTERNAL_ERROR";
  return {
    code,
    message,
    details: detail && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(detail) ? detail : fallback
  };
}
function checked(args: string[], input?: string) {
  const result = capture(args, input);
  if (result.error || result.status !== 0) {
    const error = safeError(result.stderr ?? "");
    throw new Error(`Local fixture failed: ${error.message}/${error.details} (${error.code})`);
  }
  return result.stdout.trim();
}
function psql(statement: string, database = DATABASE, role = "postgres") {
  return checked(["exec", "-i", SOURCE_CONTAINER, "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-U", role, "-d", database], statement);
}
function query(statement: string) {
  return JSON.parse(psql(statement));
}
function checkedInput(configurations: readonly LiveProviderConfiguration[]) {
  if (!configurations.length || configurations.length > 3 || new Set(configurations.map(item => item.providerCode)).size !== configurations.length) throw new Error("Choose each supported Provider at most once");
  for (const item of configurations) {
    if (!["DEEPSEEK", "MIMO", "GEMINI"].includes(item.providerCode) || !new RegExp(`^AI_PROVIDER_KEY_${item.providerCode}_[A-Z0-9_]+$`).test(item.credentialRef)) throw new Error("Invalid supported Provider credential reference");
    if (item.modelId !== undefined && (!item.modelId.trim() || item.modelId.length > 200)) throw new Error("Invalid model ID");
    if (!/^[A-Z]{3}$/.test(item.currency ?? "CNY")) throw new Error("Invalid synthetic currency");
    const required = ["INPUT_STANDARD", "INPUT_CACHE_READ", "INPUT_CACHE_WRITE", "OUTPUT"];
    if (Object.keys(item.priceComponents).length !== 4 || required.some(key => !Object.hasOwn(item.priceComponents, key))) throw new Error("Four synthetic price components are required");
    for (const amount of Object.values(item.priceComponents)) if (!/^(0|[1-9][0-9]*)$/.test(amount) || BigInt(amount) > BigInt("9223372036854775807")) throw new Error("Invalid synthetic nanos amount");
  }
}
export async function createProviderLiveDbFixture(): Promise<ProviderLiveDbFixture> {
  if (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith("unix://")) throw new Error("A local Unix Docker daemon is required");
  const dockerContext = JSON.parse(checked(["context", "inspect"]))[0];
  if (!dockerContext?.Endpoints?.docker?.Host?.startsWith("unix://")) throw new Error("Remote Docker contexts are forbidden");
  const inspected = JSON.parse(checked(["inspect", SOURCE_CONTAINER]))[0];
  if (inspected.Name !== `/${SOURCE_CONTAINER}` || !inspected.State?.Running) throw new Error("Expected running local Supabase container");
  if (!(inspected.NetworkSettings?.Ports?.["5432/tcp"] ?? []).some((binding: Row) => binding.HostPort === "54322")) throw new Error("Unexpected local source database port");
  const sourceContext = JSON.parse(psql("select public.app_context();", "postgres"));
  if (sourceContext.contract_code !== CONTRACT || sourceContext.environment !== "LOCAL") throw new Error("Source must be the current LOCAL database");
  if (psql(`select count(*) from pg_catalog.pg_database where datname=${literal(DATABASE)};`, "template1", "supabase_admin") !== "0") throw new Error("A live fixture database already exists; refusing to overwrite it");
  let created = false;
  let disposed = false;
  const userId = randomUUID();
  const sessionId = randomUUID();
  const factorId = randomUUID();
  const jwt = {
    sub: userId,
    session_id: sessionId,
    aal: "aal2",
    amr: [{
      method: "totp",
      timestamp: Math.floor(Date.now() / 1000)
    }]
  };
  let instanceId = "";
  let configured = false;
  const dispose = async () => {
    if (disposed || !created) return;
    psql(`drop database ${DATABASE} with (force);`, "template1", "supabase_admin");
    disposed = true;
  };
  function guard() {
    if (disposed || !created) throw new Error("Live fixture is closed");
  }
  function common() {
    return {
      contract_code: CONTRACT,
      database_instance_id: instanceId
    };
  }
  function executeRpc(name: string, payload?: Record<string, unknown>, actor: "service_role" | "authenticated" = "service_role") {
    guard();
    if (name !== "app_context" && name !== "legal_current" && !SERVICE_RPCS.has(name) && !ADMIN_WRITES.has(name) && !["admin_record", "admin_analytics"].includes(name) && !["legal_accept_document", "legal_accept_disclosure"].includes(name)) throw new Error("Unreviewed fixture RPC");
    let parameters = payload === undefined ? "" : json(payload);
    if (name === "admin_record") parameters = `${literal(String(payload?.p_kind))},${literal(String(payload?.p_external_id))}`;
    if (name === "admin_analytics") {
      const days = payload?.p_days;
      if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 90) throw new Error("Invalid local analytics day range");
      parameters = String(days);
    }
    const statement = `begin;select set_config('request.jwt.claims',${literal(JSON.stringify(actor === "authenticated" ? jwt : {
      role: "service_role"
    }))},true);set local role ${actor};select public.${name}(${parameters});commit;`;
    const result = capture(["exec", "-i", SOURCE_CONTAINER, "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-U", "postgres", "-d", DATABASE], statement);
    if (result.error || result.status !== 0) return {
      data: null,
      error: safeError(result.stderr ?? "")
    };
    // set_config emits one JSON line; the final line is the actual RPC result.
    const lines = result.stdout.trim().split(/\r?\n/);
    try {
      return {
        data: JSON.parse(lines.at(-1)!),
        error: null
      };
    } catch {
      return {
        data: null,
        error: {
          code: "XX000",
          message: "INTERNAL_ERROR",
          details: "INVALID_LOCAL_RPC_JSON"
        }
      };
    }
  }
  function requiredRpc(name: string, payload?: Record<string, unknown>, actor: "service_role" | "authenticated" = "service_role"): Row {
    const result = executeRpc(name, payload, actor);
    if (result.error) throw new Error(`Local ${name}: ${result.error.message}/${result.error.details} (${result.error.code})`);
    return result.data as Row;
  }
  function admin(name: string, payload: Row) {
    return requiredRpc(name, {
      ...common(),
      operation_key: randomUUID(),
      reason: "Local synthetic Provider live-smoke configuration",
      ...payload
    }, "authenticated").result as Row;
  }
  function record(kind: string, externalId: string) {
    return requiredRpc("admin_record", {
      p_kind: kind,
      p_external_id: externalId
    }, "authenticated");
  }
  async function validateTarget(kind: "PROFILE" | "PRICE" | "POLICY", id: string, validate: LiveCandidateValidator) {
    const candidate = requiredRpc("config_validation_candidate", {
      ...common(),
      target_kind: kind,
      target_id: id
    });
    const reasons = await validate(candidate.data.profiles);
    if (!Array.isArray(reasons) || reasons.some(reason => !/^[A-Z][A-Z0-9_]{0,63}$/.test(reason))) throw new Error("Validation callback must return safe reason codes");
    const report = requiredRpc("config_validation_record", {
      ...common(),
      target_kind: kind,
      target_id: id,
      dependency_digest: candidate.dependency_digest,
      passed: reasons.length === 0,
      reasons
    });
    if (!report.passed) throw new Error(`Local ${kind} candidate did not pass validation`);
    return report;
  }
  try {
    psql(`create database ${DATABASE} owner postgres;`, "template1", "supabase_admin");
    created = true;
    psql("create schema extensions;create extension pgcrypto with schema extensions;create extension btree_gist with schema extensions;create extension if not exists \"uuid-ossp\" with schema extensions;drop schema public;", DATABASE, "supabase_admin");
    const schemas = ["public", "common", "cv", "ai", "legal", "admin", "audit", "auth", "supabase_migrations"];
    const dump = checked(["exec", SOURCE_CONTAINER, "pg_dump", "-U", "supabase_admin", "-d", "postgres", "--no-publications", "--no-subscriptions", ...schemas.map(schema => `--schema=${schema}`)]);
    psql(dump, DATABASE, "supabase_admin");
    psql("grant usage on schema extensions to app_api_owner;grant execute on function extensions.gen_random_bytes(integer),extensions.digest(text,text) to app_api_owner;", DATABASE, "supabase_admin");
    psql(`truncate ai.requests,ai.attempts,ai.user_usage_daily,ai.global_usage_daily,ai.profile_usage_daily,ai.rate_minutes restart identity cascade;
      delete from legal.current_state;delete from admin.environment;delete from admin.members;
      insert into auth.users(id,email,email_confirmed_at) values(${literal(userId)},${literal(`live-smoke-${userId}@fixture.invalid`)},clock_timestamp());
      insert into auth.sessions(id,user_id) values(${literal(sessionId)},${literal(userId)});
      insert into auth.mfa_factors(id,user_id,status,factor_type,created_at,updated_at) values(${literal(factorId)},${literal(userId)},'verified','totp',clock_timestamp(),clock_timestamp());
      select admin.initialize('LOCAL',${literal(userId)});`);
    instanceId = requiredRpc("app_context").database_instance_id;
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    userId,
    instanceId,
    database: DATABASE,
    client: {
      async rpc(name, args) {
        if (name !== "app_context" && !SERVICE_RPCS.has(name)) throw new Error("Runtime fixture client permits only current AI service RPCs");
        return executeRpc(name, args?.p_input);
      }
    },
    async configure(configurations, validate) {
      guard();
      checkedInput(configurations);
      if (configured) throw new Error("Fixture configuration can only be initialized once");
      configured = true;
      const models: Partial<Record<LiveProviderCode, string>> = {};
      const providerIds: Partial<Record<LiveProviderCode, string>> = {};
      for (const item of configurations) {
        const catalog = query(`select jsonb_build_object('provider_id',p.external_id,'model_id',d.model_id) from ai.providers p join legal.disclosures d on d.provider_id=p.id join legal.current_state c on c.ai_bundle_id=d.bundle_id where p.code=${literal(item.providerCode)} limit 1;`);
        models[item.providerCode] = item.modelId ?? catalog.model_id;
        providerIds[item.providerCode] = catalog.provider_id;
      }
      const today = new Date().toISOString().slice(0, 10);
      const text = {
        zh: {
          title: "本地合成数据 Provider 冒烟测试",
          effectiveDate: today,
          intro: ["仅供本地合成样本测试，不是面向真实用户的法律承诺。"],
          sections: [{
            heading: "范围",
            body: ["只发送本次显式构造的合成简历文字，不发送数据库既有文档；测试价格仅用于验证公式，并非上游账单价格。"]
          }]
        },
        en: {
          title: "Local synthetic Provider smoke",
          effectiveDate: today,
          intro: ["Local synthetic fixtures only; this is not a legal commitment to real users."],
          sections: [{
            heading: "Scope",
            body: ["Only explicit synthetic resume text is transmitted. Fixture prices exercise accounting and are not upstream billing rates."]
          }]
        }
      };
      const manifest = {
        purpose: "LOCAL_SYNTHETIC_LIVE_SMOKE_ONLY",
        productionConsent: false,
        syntheticPricing: true,
        models
      };
      const disclosures = configurations.map(item => ({
        provider_code: item.providerCode,
        model_id: models[item.providerCode],
        content: {
          zh: {
            providerLabel: item.providerCode,
            modelLabel: models[item.providerCode],
            blocks: [{
              kind: "paragraph",
              text: "仅本地合成数据测试；不承诺生产服务条款、供应商价格或数据政策。"
            }]
          },
          en: {
            providerLabel: item.providerCode,
            modelLabel: models[item.providerCode],
            blocks: [{
              kind: "paragraph",
              text: "Local synthetic live smoke only; no production terms, vendor pricing or data-policy claims."
            }]
          }
        }
      }));
      const bundle = query(`do $fixture$declare v_document jsonb;v_bundle jsonb;v_disclosure jsonb;v_provider ai.providers;v_item jsonb;v_manifest jsonb:=${json(manifest)};v_content jsonb;v_digest text;begin
        v_content=${json(text)};
        v_document=common.insert_entity('legal.document_versions',jsonb_build_object('document_code','AI_TERMS','version',(select max(version)+1 from legal.document_versions where document_code='AI_TERMS'),'renderer_contract','legal_document_1','content',v_content,'content_digest',common.digest(v_content)));
        v_bundle=common.insert_entity('legal.bundles',jsonb_build_object('code','LOCAL_LIVE_SMOKE_'||gen_random_uuid()::text,'ai_document_version_id',(v_document->>'id')::bigint,'manifest',v_manifest,'manifest_digest',common.digest(v_manifest)));
        for v_item in select * from jsonb_array_elements(${json(disclosures)}) loop
          select * into v_provider from ai.providers where code=v_item->>'provider_code';v_content=v_item->'content';
          v_digest=common.digest(jsonb_build_object('content',v_content,'ai_document_digest',v_document->>'content_digest','manifest_digest',v_bundle->>'manifest_digest'));
          perform common.insert_entity('legal.disclosures',jsonb_build_object('bundle_id',(v_bundle->>'id')::bigint,'provider_id',v_provider.id,'disclosure_code','LOCAL_'||v_provider.code,'renderer_contract','legal_display_1','model_id',v_item->>'model_id','recipient_code',v_provider.recipient_code,'content',v_content,'content_digest',v_digest));
        end loop;
        update legal.bundles set time_sealed=clock_timestamp() where id=(v_bundle->>'id')::bigint;
        perform admin.publish_legal_current((select d.external_id from legal.document_versions d join legal.current_state c on c.terms_document_version_id=d.id),v_bundle->>'external_id');
      end;$fixture$;select public.legal_current();`);
      const acceptBase = {
        ...common(),
        expected_auth_user_id: userId
      };
      requiredRpc("legal_accept_document", {
        ...acceptBase,
        document_version_id: bundle.terms.external_id,
        content_digest: bundle.terms.content_digest
      }, "authenticated");
      const versions: {
        key: string;
        profile_version_id: string;
        price_lane_code: string;
        display_order: number;
      }[] = [];
      for (const [index, item] of configurations.entries()) {
        const disclosure = bundle.ai_bundle.disclosures.find((entry: Row) => entry.provider_code === item.providerCode);
        requiredRpc("legal_accept_disclosure", {
          ...acceptBase,
          disclosure_id: disclosure.external_id,
          content_digest: disclosure.content_digest,
          bundle_id: bundle.ai_bundle.external_id,
          manifest_digest: bundle.ai_bundle.manifest_digest
        }, "authenticated");
        const profile = admin("admin_profile_create", {
          provider_id: providerIds[item.providerCode],
          code: `LIVE_${item.providerCode}_${randomUUID().slice(0, 8).toUpperCase()}`,
          name: `Local ${item.providerCode} smoke`,
          description: "Synthetic live fixture; never a production configuration"
        });
        const execution = {
          DEEPSEEK: {
            capabilityCode: "DEEPSEEK_RESPONSES",
            endpointUrl: "https://api.deepseek.com/responses",
            adapterConfig: { reasoningEffort: "none", structuredOutput: "json_object", providerSubjectField: "user" }
          },
          MIMO: {
            capabilityCode: "MIMO_RESPONSES",
            endpointUrl: "https://api.xiaomimimo.com/v1/responses",
            adapterConfig: { reasoningEffort: "none", structuredOutput: "prompt_only", sendProviderSubjectId: false }
          },
          GEMINI: {
            capabilityCode: "GEMINI_INTERACTIONS",
            endpointUrl: "https://generativelanguage.googleapis.com/v1/interactions",
            adapterConfig: { thinkingLevel: "low", thinkingSummaries: "none", structuredOutput: "json_schema", sendProviderSubjectId: false, store: false, background: false }
          }
        }[item.providerCode];
        const version = admin("admin_profile_version_create", {
          profile_id: profile.external_id,
          expected_revision: profile.revision,
          capability_code: execution.capabilityCode,
          endpoint_url: execution.endpointUrl,
          credential_ref: item.credentialRef,
          model_id: models[item.providerCode],
          adapter_config: execution.adapterConfig,
          disclosure_id: disclosure.external_id
        });
        let report = await validateTarget("PROFILE", version.external_id, validate);
        admin("admin_profile_version_publish", {
          external_id: version.external_id,
          expected_status: "DRAFT",
          config_digest: version.config_digest,
          expected_revision: record("profiles", profile.external_id).revision,
          validation_id: report.external_id
        });
        const price = admin("admin_price_version_create", {
          profile_version_id: version.external_id,
          expected_revision: record("profiles", profile.external_id).revision,
          lane_code: "SYNTHETIC_LIVE_SMOKE",
          currency: item.currency ?? "CNY",
          calculator_kind: "linear_token_v1",
          parameters: {},
          valid_from: new Date(Date.now() - 60000).toISOString(),
          components: item.priceComponents
        });
        report = await validateTarget("PRICE", price.external_id, validate);
        admin("admin_price_version_publish", {
          external_id: price.external_id,
          expected_status: "DRAFT",
          config_digest: price.config_digest,
          expected_revision: record("profiles", profile.external_id).revision,
          validation_id: report.external_id
        });
        versions.push({
          key: item.providerCode,
          profile_version_id: version.external_id,
          price_lane_code: "SYNTHETIC_LIVE_SMOKE",
          display_order: index
        });
      }
      const policy = admin("admin_policy_create", {
        code: `LIVE_${randomUUID().slice(0, 8).toUpperCase()}`,
        name: "Local synthetic live policy",
        description: "Only a disposable local test database"
      });
      const policyVersion = admin("admin_policy_version_create", {
        policy_id: policy.external_id,
        expected_revision: policy.revision,
        bundle_id: bundle.ai_bundle.external_id,
        options: versions,
        rules: [{
          ordinal: 0,
          is_fallback: true,
          option_keys: versions.map(item => item.key),
          default_option_key: versions[0].key
        }]
      });
      let report = await validateTarget("POLICY", policyVersion.external_id, validate);
      admin("admin_policy_version_publish", {
        external_id: policyVersion.external_id,
        expected_status: "DRAFT",
        config_digest: policyVersion.config_digest,
        expected_revision: record("policies", policy.external_id).revision,
        validation_id: report.external_id
      });
      const control = () => query("select jsonb_build_object('revision',revision::text) from ai.runtime_control where id=1;");
      report = await validateTarget("POLICY", policyVersion.external_id, validate);
      admin("admin_ai_set_policy", {
        expected_revision: control().revision,
        policy_version_id: policyVersion.external_id,
        validation_id: report.external_id
      });
      admin("admin_ai_set_allowed_user", {
        expected_revision: control().revision,
        auth_user_id: userId,
        allowed: true
      });
      const candidate = requiredRpc("runtime_readback_candidate", common());
      const reasons = await validate(candidate.data.profiles);
      if (!Array.isArray(reasons) || reasons.some(reason => !/^[A-Z][A-Z0-9_]{0,63}$/.test(reason))) throw new Error("Unsafe readback verdict");
      const readback = requiredRpc("runtime_readback_record", {
        ...common(),
        dependency_digest: candidate.dependency_digest,
        passed: reasons.length === 0,
        reasons
      });
      if (!readback.passed) throw new Error("Readback did not pass");
      admin("admin_ai_reopen", {
        expected_revision: control().revision,
        readback_id: readback.external_id
      });
      const availability = requiredRpc("ai_availability", {
        ...common(),
        owner_auth_user_id: userId
      });
      const optionIds: Partial<Record<LiveProviderCode, string>> = {};
      for (const option of availability.options) optionIds[option.provider_code as LiveProviderCode] = option.option_id;
      return {
        availability,
        optionIds,
        modelIds: models,
        syntheticPricing: true as const
      };
    },
    async verifyPolicyCommits() {
      guard();
      if (!configured) throw new Error("Configure the fixture before checking policy commits");
      const available = requiredRpc("ai_availability", {
        ...common(),
        owner_auth_user_id: userId
      });
      if (!available.enabled || !available.policy_version_id) throw new Error("Authenticated policy RPC did not commit a usable policy");
      const parent = admin("admin_policy_create", {
        code: `NEGATIVE_${randomUUID().slice(0, 8).toUpperCase()}`,
        name: "Incomplete graph rejection",
        description: "Only a disposable local commit regression fixture"
      });
      for (const forceImmediate of [false, true]) {
        // A temporary owner-created test helper queues an intentionally incomplete row.
        // It is created and invoked inside the failing transaction and is rolled back.
        // No authenticated schema/table privileges are added, and no product code is replaced.
        const statement = `begin;set constraints all deferred;
          create function public.cv_live_incomplete_graph_probe() returns void language plpgsql security definer set search_path='' as $probe$
          begin
            insert into ai.policy_versions(policy_id,version,legal_bundle_id,config_digest)
            select p.id,1,c.ai_bundle_id,repeat('0',64) from ai.policies p cross join legal.current_state c where p.external_id=${literal(parent.external_id)} and c.id=1;
          end;$probe$;
          revoke all on function public.cv_live_incomplete_graph_probe() from public,anon,service_role;
          grant execute on function public.cv_live_incomplete_graph_probe() to authenticated;
          select set_config('request.jwt.claims',${literal(JSON.stringify(jwt))},true);
          set local role authenticated;
          select public.cv_live_incomplete_graph_probe();
          ${forceImmediate ? "set constraints all immediate;" : ""}
          commit;`;
        const result = capture(["exec", "-i", SOURCE_CONTAINER, "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-U", "postgres", "-d", DATABASE], statement);
        const error = safeError(result.stderr ?? "");
        if (result.status === 0 || error.code !== "P0001" || error.message !== "INVALID_REQUEST" || error.details !== "INCOMPLETE_POLICY_GRAPH") throw new Error(`Deferred graph rejection failed: ${error.message}/${error.details} (${error.code})`);
        const remaining = psql(`select count(*) from ai.policy_versions v join ai.policies p on p.id=v.policy_id where p.external_id=${literal(parent.external_id)};`);
        if (remaining !== "0") throw new Error("Rejected policy graph was partially committed");
      }
      return {
        validCommitted: true as const,
        invalidCommitRejected: true as const,
        immediateCheckRejected: true as const
      };
    },
    async analytics(days = 30) {
      return requiredRpc("admin_analytics", { p_days: days }, "authenticated");
    },
    async observe() {
      guard();
      return query(`select jsonb_build_object('syntheticPricing',true,'requests',coalesce((select jsonb_agg(jsonb_build_object('requestId',r.external_id,'state',r.state,'outcome',r.outcome,'charged',r.charged,'providerCode',p.code,'modelId',v.model_id,'currency',r.billing_currency,'usage',r.usage,'estimatedCostNanos',r.estimated_cost_nanos::text,'knownEstimatedCostNanos',r.known_estimated_cost_nanos::text,'providerReportedCostNanos',r.provider_reported_cost_nanos::text,'incompleteReasons',r.incomplete_reasons,'attempts',(select jsonb_agg(jsonb_build_object('attemptId',a.external_id,'attemptNo',a.attempt_no,'state',a.state,'transmitted',a.transmitted,'providerBillable',a.provider_billable,'usage',a.usage,'estimatedCostNanos',a.estimated_cost_nanos::text,'knownEstimatedCostNanos',a.known_estimated_cost_nanos::text,'incompleteReasons',a.incomplete_reasons) order by a.attempt_no) from ai.attempts a where a.request_id=r.id)) order by r.id) from ai.requests r join ai.profile_versions v on v.id=r.profile_version_id join ai.providers p on p.id=v.provider_id where r.owner_auth_user_id=${literal(userId)}),'[]'),'quota',coalesce((select jsonb_agg(jsonb_build_object('day',day,'reserved',reserved_count::text,'charged',charged_count::text,'inputTokensKnownLowerBound',input_tokens::text,'outputTokensKnownLowerBound',output_tokens::text,'incompleteUsageCount',incomplete_usage_count::text)) from ai.user_usage_daily where auth_user_id=${literal(userId)}),'[]'));`);
    },
    dispose
  };
}
export async function withProviderLiveDbFixture<T>(action: (fixture: ProviderLiveDbFixture) => Promise<T>): Promise<T> {
  const fixture = await createProviderLiveDbFixture();
  try {
    return await action(fixture);
  } finally {
    await fixture.dispose();
  }
}
