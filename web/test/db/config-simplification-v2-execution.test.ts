import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRealPolishRuntimeAuthorityV2 } from "@/server/polish/handler-runtime-authority";
import { produceAdminRuntimeReadback } from "@/server/admin/readback-service";
import { produceAdminValidationReport } from "@/server/admin/validation-service";
import { readPreparedProviderExecutionV2 } from "@/server/polish/prepared-provider-execution-v2";
import {
  completePolishProviderAttemptV2,
  finalizePolishRequestV2,
  getPolishExecutionSnapshotV2,
  startPolishProviderAttemptV2,
} from "@/server/polish/quota";

import {
  createConfigSimplificationUser,
  createConfigSimplificationV2Fixture,
  type ConfigSimplificationV2Fixture,
} from "./config-simplification-fixtures";
import {
  DB_TEST_ENV,
  createServiceClient,
  createTestUser,
  deleteTestUser,
  RUN_DB_TESTS,
  signInAsUser,
  sleep,
  type TestUser,
} from "./helpers";
import { runOwnerSql, startOwnerSql, type OwnerSqlResult } from "./runtime-contract-fixtures";

const CONTEXT = { p_environment: "local", p_project_ref: "local" } as const;
type GrantRole = "public" | "anon" | "authenticated" | "service_role";
type PrivilegeSnapshot = Readonly<{
  functions: Readonly<Record<string, Readonly<Record<GrantRole, boolean>>>>;
  feature: Readonly<Record<"ai_polish_enabled" | "global_daily_limit" | "enabled_user_allowlist", boolean>>;
  config: Readonly<{
    ai_polish_enabled: boolean;
    global_daily_limit: number;
    enabled_user_allowlist: string[];
    config_generation: number;
    active_routing_policy_version_id: string | null;
    routing_updated_at: string | null;
    routing_updated_by: string | null;
    routing_change_reason: string | null;
  }>;
  control: Readonly<{
    revision: number;
    closing_cycle_id: string | null;
    closed_at: string | null;
    closed_by: string | null;
    reopened_at: string | null;
  }>;
}>;

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function readOwnerJson<T>(statement: string): T {
  const result = runOwnerSql(statement);
  const line = result.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .findLast((value) => value.startsWith("{"));
  if (!line) throw new Error(`owner query returned no JSON: ${result.stdout}`);
  return JSON.parse(line) as T;
}

function capturePrivileges(): PrivilegeSnapshot {
  return readOwnerJson<PrivilegeSnapshot>(String.raw`
    select json_build_object(
      'functions',(
        select json_object_agg(signature,json_build_object(
          'public',exists(select 1 from pg_catalog.aclexplode(coalesce(proc.proacl,pg_catalog.acldefault('f',proc.proowner))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE'),
          'anon',pg_catalog.has_function_privilege('anon',proc.oid,'EXECUTE'),
          'authenticated',pg_catalog.has_function_privilege('authenticated',proc.oid,'EXECUTE'),
          'service_role',pg_catalog.has_function_privilege('service_role',proc.oid,'EXECUTE')
        ))
        from public.admin_runtime_authority_expected_v3 spec
        join pg_catalog.pg_proc proc on proc.oid=pg_catalog.to_regprocedure(spec.signature)
      ),
      'feature',json_build_object(
        'ai_polish_enabled',pg_catalog.has_column_privilege('service_role','public.ai_feature_config','ai_polish_enabled','UPDATE'),
        'global_daily_limit',pg_catalog.has_column_privilege('service_role','public.ai_feature_config','global_daily_limit','UPDATE'),
        'enabled_user_allowlist',pg_catalog.has_column_privilege('service_role','public.ai_feature_config','enabled_user_allowlist','UPDATE')
      ),
      'config',(select row_to_json(row) from (
        select ai_polish_enabled,global_daily_limit,enabled_user_allowlist,config_generation,
          active_routing_policy_version_id,routing_updated_at,routing_updated_by,routing_change_reason
        from public.ai_feature_config where id=true
      ) row),
      'control',(select row_to_json(row) from (
        select revision,closing_cycle_id,closed_at,closed_by,reopened_at
        from public.admin_ai_control_state_v1 where id=true
      ) row)
    );
  `);
}

function restorePrivileges(snapshot: PrivilegeSnapshot, adminUserId: string): void {
  const restores = Object.entries(snapshot.functions).flatMap(([signature, functionGrants]) => {
    const statements = [
      `revoke all on function ${signature} from public,anon,authenticated,service_role;`,
    ];
    for (const role of ["public", "anon", "authenticated", "service_role"] as const) {
      if (functionGrants[role]) statements.push(`grant execute on function ${signature} to ${role};`);
    }
    return statements;
  });
  const config = snapshot.config;
  const feature = snapshot.feature;
  const grants = (Object.entries(feature) as Array<[keyof typeof feature, boolean]>)
    .map(([column, allowed]) => allowed ? `grant update(${column}) on public.ai_feature_config to service_role;` : "")
    .filter(Boolean)
    .join("\n");
  const result = runOwnerSql(String.raw`
    begin;
    ${restores.join("\n")}
    revoke update(ai_polish_enabled,global_daily_limit,enabled_user_allowlist) on public.ai_feature_config from service_role;
    ${grants}
    update public.ai_feature_config set
      ai_polish_enabled=${config.ai_polish_enabled},
      global_daily_limit=${config.global_daily_limit},
      enabled_user_allowlist=array[${config.enabled_user_allowlist.map((id) => `${sql(id)}::uuid`).join(",")}]::uuid[]
    where id=true;
    update public.admin_ai_control_state_v1 set
      revision=${snapshot.control.revision},
      closing_cycle_id=${snapshot.control.closing_cycle_id === null ? "null" : `${sql(snapshot.control.closing_cycle_id)}::uuid`},
      closed_at=${snapshot.control.closed_at === null ? "null" : `${sql(snapshot.control.closed_at)}::timestamptz`},
      closed_by=${snapshot.control.closed_by === null ? "null" : `${sql(snapshot.control.closed_by)}::uuid`},
      reopened_at=${snapshot.control.reopened_at === null ? "null" : `${sql(snapshot.control.reopened_at)}::timestamptz`}
    where id=true;
    -- The local DB suite requires a pristine Admin bootstrap. This narrow
    -- cleanup removes only rows generated for this test actor; replica mode
    -- is transaction-local and is never used to create execution authority.
    set local session_replication_role=replica;
    delete from public.admin_committed_operations where actor_user_id=${sql(adminUserId)}::uuid;
    delete from public.admin_principals where user_id=${sql(adminUserId)}::uuid;
    delete from public.admin_environment where id=true;
    commit;
  `);
  expect(result.status, result.stderr).toBe(0);
}

function totpCode(secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.replaceAll("=", "").toUpperCase()) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("invalid TOTP secret");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value =
    (((digest[offset] & 0x7f) << 24) |
      (digest[offset + 1] << 16) |
      (digest[offset + 2] << 8) |
      digest[offset + 3]) %
    1_000_000;
  return value.toString().padStart(6, "0");
}

function producerEnvironment(): Readonly<Record<string, string | undefined>> {
  if (!DB_TEST_ENV) throw new Error("real DB environment is unavailable");
  return {
    ADMIN_ENVIRONMENT: "local",
    NEXT_PUBLIC_SUPABASE_URL: DB_TEST_ENV.url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DB_TEST_ENV.publishableKey,
    AI_PROVIDER_KEY_DEEPSEEK_PRIMARY: "fixture-deepseek-secret",
  };
}

function holdStateRow(table: "ai_feature_config" | "admin_environment") {
  const child = spawn("docker", ["exec", "-i", "supabase_db_typst-cv-template", "psql", "-U", "postgres", "-d", "postgres", "--set", "ON_ERROR_STOP=1", "--no-psqlrc"], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let released = false;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const result = new Promise<OwnerSqlResult>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; if (stdout.includes("CONTROL_ROW_HELD")) readyResolve(); });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => { readyReject(error); reject(error); });
    child.on("close", (status) => {
      if (!stdout.includes("CONTROL_ROW_HELD")) readyReject(new Error(stderr || "row barrier exited before acquiring its lock"));
      resolve({ status: status ?? -1, stdout, stderr });
    });
  });
  child.stdin.write(`begin; set local idle_in_transaction_session_timeout='20s'; select id from public.${table} where id=true for update;\n\\echo CONTROL_ROW_HELD\n`);
  return { ready, result, release: () => { if (!released) { released = true; child.stdin.end("rollback;\n"); } } };
}

async function waitForDatabaseLock(application: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const value = readOwnerJson<{ blocked: boolean }>(`select json_build_object('blocked',exists(select 1 from pg_stat_activity where application_name=${sql(application)} and wait_event_type='Lock'));`);
    if (value.blocked) return;
    await sleep(50);
  }
  throw new Error(`operation ${application} did not reach its expected database lock`);
}

describe.skipIf(!RUN_DB_TESTS)(
  "CFG-005 V2 configuration-owned execution (real DB)",
  () => {
    let service: SupabaseClient;
    let admin: SupabaseClient;
    let fixture: ConfigSimplificationV2Fixture;
    let adminUser: TestUser;
    let executionUser: TestUser;
    let reportId: string;
    let policyVersionId: string;
    let privilegeSnapshot: PrivilegeSnapshot;
    let factorId: string | null = null;
    let ownsEnvironment = false;

    async function state() {
      return readOwnerJson<{
        environment: { revision: number };
        control: { revision: number; closing_cycle_id: string | null };
        config: {
          config_generation: number;
          active_routing_policy_version_id: string | null;
          ai_polish_enabled: boolean;
        };
      }>(String.raw`
        select json_build_object(
          'environment',(select row_to_json(row) from (select revision from public.admin_environment where id=true) row),
          'control',(select row_to_json(row) from (select revision,closing_cycle_id from public.admin_ai_control_state_v1 where id=true) row),
          'config',(select row_to_json(row) from (select config_generation,active_routing_policy_version_id,ai_polish_enabled from public.ai_feature_config where id=true) row)
        );
      `);
    }

    async function recordReport(): Promise<string> {
      const candidate = await service.rpc("get_admin_config_validation_candidate_v2", {
        p_runtime_contract_id: fixture.runtimeContractId,
        p_runtime_target_id: fixture.runtimeTargetId,
      });
      expect(candidate.error).toBeNull();
      expect(candidate.data).toMatchObject({
        schemaVersion: "admin_config_validation_candidate_v2",
        profileExecutionConfig: { endpointUrl: fixture.endpointUrl, credentialEnvName: fixture.credentialEnvName },
        runtimeTarget: { runtimeTargetId: fixture.runtimeTargetId },
      });
      const report = await produceAdminValidationReport(
        { runtimeContractId: fixture.runtimeContractId, runtimeTargetId: fixture.runtimeTargetId },
        {
          environment: producerEnvironment(),
          client: {
            rpc: async (functionName, args) => {
              const result = await (service.rpc as unknown as (
                name: string, input: Record<string, unknown>,
              ) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>)(functionName, args);
              return result;
            },
          },
        },
      );
      expect(report).toMatchObject({ schemaVersion: "admin_config_validation_report_v2", passed: true });
      return report.reportId;
    }

    beforeAll(async () => {
      if (!DB_TEST_ENV) throw new Error("real DB environment is unavailable");
      service = createServiceClient();
      adminUser = await createTestUser(service, "config-simplification-execution");
      privilegeSnapshot = capturePrivileges();
      admin = await signInAsUser(adminUser);
      const token = (await admin.auth.getSession()).data.session!.access_token;
      const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as { iss: string };
      const environments = runOwnerSql("select count(*) from public.admin_environment;").stdout.match(/\n\s*(\d+)\s*\n/u)?.[1];
      expect(environments).toBe("0");
      runOwnerSql(`select public.admin_bootstrap_v1(${sql(adminUser.id)},'local','local',${sql(claims.iss)},'CFG-005 V2 execution bootstrap');`);
      ownsEnvironment = true;
      fixture = createConfigSimplificationV2Fixture();

      // This proves the callable DB authority surface before authenticated
      // configuration publication. It is not a direct control-mode update.
      const beforeCutover = await state();
      const cutover = runOwnerSql(`select public.admin_cutover_authority_v3('{}'::uuid[],${beforeCutover.environment.revision},${beforeCutover.control.revision},'CFG-005 V2 execution authority cutover');`);
      expect(cutover.status, cutover.stderr).toBe(0);

      const enrolled = await admin.auth.mfa.enroll({ factorType: "totp", friendlyName: "config-simplification-execution" });
      expect(enrolled.error).toBeNull();
      if (!enrolled.data?.id || !enrolled.data.totp?.secret) throw new Error("local TOTP enrollment returned no factor");
      factorId = enrolled.data.id;
      const verified = await admin.auth.mfa.challengeAndVerify({ factorId, code: totpCode(enrolled.data.totp.secret) });
      expect(verified.error).toBeNull();
      expect(verified.data?.access_token).toBeTruthy();

      reportId = await recordReport();
      // A report is append-only, so use a valid historical row instead of
      // mutating time. V5 must not consult its expiry during execution.
      const staleInsert = runOwnerSql(String.raw`
        insert into public.admin_config_validation_reports_v2(
          environment,project_ref,runtime_contract_id,runtime_target_id,runtime_target_sha256,
          profile_version_id,price_version_id,provider_id,code_capability_id,code_capability_sha256,
          legal_bundle_version,legal_manifest_id,display_disclosure_key,endpoint_policy_valid,
          credential_binding_valid,credential_configured,compiled_capability_valid,database_binding_valid,
          evidence_ids,checked_at,expires_at,report_sha256
        )
        select environment,project_ref,runtime_contract_id,runtime_target_id,runtime_target_sha256,
          profile_version_id,price_version_id,provider_id,code_capability_id,code_capability_sha256,
          legal_bundle_version,legal_manifest_id,display_disclosure_key,endpoint_policy_valid,
          credential_binding_valid,credential_configured,compiled_capability_valid,database_binding_valid,
          evidence_ids,clock_timestamp()-interval '21 minutes',clock_timestamp()-interval '12 minutes',
          encode(extensions.digest('expired CFG-005 execution report','sha256'),'hex')
        from public.admin_config_validation_reports_v2 where id=${sql(reportId)};
      `);
      expect(staleInsert.status, staleInsert.stderr).toBe(0);
      const expiredCount = runOwnerSql(
        `select count(*) from public.admin_config_validation_reports_v2 where runtime_contract_id=${sql(fixture.runtimeContractId)} and expires_at<clock_timestamp();`,
      ).stdout.match(/\n\s*(\d+)\s*\n/u)?.[1];
      expect(expiredCount).toBe("1");

      for (const toStatus of ["validated", "canary"] as const) {
        const transition = await admin.rpc("admin_transition_profile_version_v2", {
          ...CONTEXT, p_profile_version_id: fixture.profileVersionId, p_to_status: toStatus,
          p_validation_report_id: reportId, p_reason: `${toStatus} V2 execution profile`, p_idempotency_key: crypto.randomUUID(),
        });
        expect(transition.error).toBeNull();
      }

      const policyKey = `test.config-simplification.execution.${crypto.randomUUID()}`;
      const created = await admin.rpc("admin_create_routing_policy_v2", {
        ...CONTEXT, p_policy_key: policyKey, p_expected_latest_version: 0,
        p_rules: { schemaVersion: "routing_rules_v1", defaultRoute: { profileVersionId: fixture.profileVersionId, priceVersionId: fixture.priceVersionId }, windows: [] },
        p_default_profile_version_id: fixture.profileVersionId,
        p_legal_bundle_version: fixture.legalBundleVersion,
        p_runtime_contract_id: fixture.runtimeContractId,
        p_validation_report_ids: [reportId], p_reason: "create V2 execution routing policy", p_idempotency_key: crypto.randomUUID(),
      });
      expect(created.error).toBeNull();
      policyVersionId = (created.data as { result: { policyVersionId: string } }).result.policyVersionId;
      for (const toStatus of ["validated", "canary"] as const) {
        const transition = await admin.rpc("admin_transition_routing_policy_v2", {
          ...CONTEXT, p_policy_version_id: policyVersionId, p_to_status: toStatus,
          p_validation_report_ids: [reportId], p_reason: `${toStatus} V2 execution routing policy`, p_idempotency_key: crypto.randomUUID(),
        });
        expect(transition.error).toBeNull();
      }

      const beforePointer = await state();
      const pointer = await admin.rpc("admin_set_ai_routing_pointer_v2", {
        ...CONTEXT, p_policy_version_id: policyVersionId, p_validation_report_ids: [reportId],
        p_expected_control_revision: beforePointer.control.revision, p_expected_policy_version_id: null,
        p_expected_config_generation: beforePointer.config.config_generation,
        p_reason: "publish V2 execution routing policy", p_idempotency_key: crypto.randomUUID(),
      });
      expect(pointer.error).toBeNull();
      const afterPointer = await state();
      const readbackCandidate = await service.rpc("get_admin_runtime_readback_candidate_v3", {
        p_policy_version_id: policyVersionId, p_validation_report_ids: [reportId], ...CONTEXT,
      });
      expect(readbackCandidate.error).toBeNull();
      expect(readbackCandidate.data).toMatchObject({ schemaVersion: "admin_runtime_readback_candidate_v3", policyVersionId, validationReportIds: [reportId] });
      const readback = await produceAdminRuntimeReadback(
        { policyVersionId, validationReportIds: [reportId] },
        {
          environment: producerEnvironment(),
          client: {
            rpc: async (functionName, args) => {
              const result = await (service.rpc as unknown as (
                name: string, input: Record<string, unknown>,
              ) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>)(functionName, args);
              return result;
            },
          },
        },
      );
      expect(readback).toMatchObject({ schemaVersion: "admin_runtime_readback_v3", policyVersionId });
      const readbackReportId = readback.reportId;
      const reopened = await admin.rpc("admin_reopen_ai_v2", {
        ...CONTEXT, p_readback_report_id: readbackReportId,
        p_expected_closing_cycle_id: afterPointer.control.closing_cycle_id,
        p_expected_control_revision: afterPointer.control.revision,
        p_expected_policy_version_id: policyVersionId,
        p_expected_config_generation: afterPointer.config.config_generation,
        p_reason: "reopen V2 execution after readback", p_idempotency_key: crypto.randomUUID(),
      });
      expect(reopened.error).toBeNull();
      executionUser = await createConfigSimplificationUser(service, fixture);
    });

    afterAll(async () => {
      if (admin && policyVersionId && reportId) {
        const current = await state();
        if (current.config.ai_polish_enabled) {
          await admin.rpc("admin_disable_ai_v1", {
            ...CONTEXT, p_expected_control_revision: current.control.revision,
            p_reason: "close CFG-005 V2 execution test", p_idempotency_key: crypto.randomUUID(),
          });
        }
        const closed = await state();
        if (closed.config.active_routing_policy_version_id === policyVersionId) {
          await admin.rpc("admin_clear_ai_routing_pointer_v2", {
            ...CONTEXT, p_validation_report_ids: [reportId], p_expected_control_revision: closed.control.revision,
            p_expected_policy_version_id: policyVersionId, p_expected_config_generation: closed.config.config_generation,
            p_reason: "clear CFG-005 V2 execution test pointer", p_idempotency_key: crypto.randomUUID(),
          });
        }
      }
      if (factorId && admin) await admin.auth.mfa.unenroll({ factorId });
      if (executionUser) await deleteTestUser(service, executionUser.id);
      if (ownsEnvironment) {
        restorePrivileges(privilegeSnapshot, adminUser.id);
        const restored = capturePrivileges();
        expect(restored.functions).toEqual(privilegeSnapshot.functions);
        expect(restored.feature).toEqual(privilegeSnapshot.feature);
      }
      if (adminUser) await deleteTestUser(service, adminUser.id);
    });

    it("serves enabled V2 availability over HTTP after Admin publication and reopen", async () => {
      const current = await state();
      const availability = await service.rpc("get_ai_polish_availability_v2", {
        p_user_id: executionUser.id,
      });
      expect(availability.error).toBeNull();
      expect(availability.data).toMatchObject({
        schemaVersion: "ai_polish_availability_v2",
        enabled: true,
        configGeneration: String(current.config.config_generation),
        routingPolicyVersionId: policyVersionId,
        profileVersionId: fixture.profileVersionId,
        runtimeContractId: fixture.runtimeContractId,
        legalBundleVersion: fixture.legalBundleVersion,
        displayDisclosureKey: fixture.displayDisclosureKey,
        termsAccepted: true,
        legalDisplay: {
          legalBundleVersion: fixture.legalBundleVersion,
          displayDisclosureKey: fixture.displayDisclosureKey,
        },
      });
    });

    it("uses a V3 receipt for controlled one-send transport and settlement with expired historical reports", async () => {
      const config = await service.from("ai_feature_config").select("config_generation").eq("id", true).single();
      expect(config.error).toBeNull();
      const reserved = await service.rpc("reserve_ai_polish_request_v2", {
        p_user_id: executionUser.id, p_request_id: crypto.randomUUID(), p_client_request_id: crypto.randomUUID(),
        p_expected_route: {
          schema_version: "expected_route_v1", config_generation: String(config.data!.config_generation),
          profile_version_id: fixture.profileVersionId, legal_bundle_version: fixture.legalBundleVersion,
          runtime_contract_id: fixture.runtimeContractId,
        },
      });
      expect(reserved.error).toBeNull();
      expect(reserved.data?.allowed).toBe(true);
      const reservationId = reserved.data!.reservationId as string;
      const route = reserved.data!.routeSnapshot;

      const sent: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
      const fakeFetch: typeof fetch = async (input, init) => {
        sent.push({ input, init });
        return new Response(JSON.stringify({
          id: "cfg005-deepseek-request", model: fixture.modelId,
          choices: [{ message: { content: '{"items":[]}' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 1, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 2 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      };
      const authority = createRealPolishRuntimeAuthorityV2({
        ADMIN_ENVIRONMENT: "local", NEXT_PUBLIC_SUPABASE_URL: DB_TEST_ENV!.url,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DB_TEST_ENV!.publishableKey,
        [fixture.credentialEnvName]: "fixture-deepseek-secret",
      }, { fetch: fakeFetch });
      const snapshot = await getPolishExecutionSnapshotV2(service, {
        reservationId, userId: executionUser.id, reserveRoute: route,
        runtimeEnvironment: { environment: "local", projectRef: "local" },
        runtimeTargetResolver: authority.runtimeTargetResolver,
        runtimeTargetResolverV2: authority.runtimeTargetResolverV2,
      });
      expect(snapshot.schemaVersion).toBe("ai_polish_execution_snapshot_v3");
      if (snapshot.schemaVersion !== "ai_polish_execution_snapshot_v3") throw new Error("V2 reservation did not return the V3 execution envelope");
      expect(snapshot.runtimeConfigReceipt).toMatchObject({ schemaVersion: "runtime_config_receipt_v1", runtimeTargetId: fixture.runtimeTargetId });
      expect(snapshot.runtimeConfigReceipt).not.toHaveProperty("reportId");
      expect(snapshot.runtimeConfigReceipt).not.toHaveProperty("expiresAt");

      const crossed = await service.rpc("start_ai_polish_provider_attempt_v5", {
        p_reservation_id: reservationId, p_attempt_no: 1,
        p_runtime_config_receipt: { ...snapshot.runtimeConfigReceipt, providerId: crypto.randomUUID() },
      });
      expect(crossed.error).toBeNull();
      expect(crossed.data).toEqual({ ok: false, reason: "SERVICE_UNAVAILABLE" });
      const beforeStart = await service.from("ai_request_ledger").select("attempt_count").eq("reservation_id", reservationId).single();
      expect(beforeStart.data?.attempt_count).toBe(0);
      expect(sent).toHaveLength(0);

      const started = await startPolishProviderAttemptV2(service, {
        reservationId, attemptNo: 1, expectedRoute: route, runtimeConfigReceipt: snapshot.runtimeConfigReceipt,
      });
      const execution = authority.resolveProvider(snapshot.profileExecutionConfig, {
        schemaVersion: "runtime_execution_target_v2", runtimeContractId: snapshot.runtimeEvidence.runtimeContractId,
        legalBundleVersion: snapshot.routeSnapshot.legalBundleVersion, profileVersionId: snapshot.routeSnapshot.profileVersionId,
        profile: snapshot.profileExecutionConfig, evidence: snapshot.runtimeEvidence, runtimeConfigReceipt: snapshot.runtimeConfigReceipt,
      });
      const { provider } = readPreparedProviderExecutionV2(execution, snapshot.profileExecutionConfig);
      const result = await provider.complete({
        schemaVersion: "polish_inference_request_v2",
        prompt: { blocks: [
          { id: "developer", role: "developer", stability: "stable", content: "Return a JSON object." },
          { id: "item-1", role: "user", stability: "variable", content: "Polish this item." },
        ], explicitCacheBoundaryAfter: "developer" },
        outputContract: { kind: "json_object", schemaName: "cfg005_test", schema: { type: "object" } },
        maxOutputTokens: 16, providerSubjectId: "cfg005-provider-subject", promptVersion: "cfg005-prompt-v1",
        validatorVersion: "cfg005-validator-v1", language: "en", targets: [{ id: "item-1", text: "Polish this item." }],
      }, { signal: new AbortController().signal, timeoutMs: 1_000 });
      expect(sent).toHaveLength(1);
      expect(String(sent[0]!.input)).toBe(fixture.endpointUrl);
      expect(sent[0]!.init).toMatchObject({ method: "POST", redirect: "error" });
      expect(result.route.actualUpstreamEndpoint).toBe(fixture.endpointUrl);

      const completed = await completePolishProviderAttemptV2(service, {
        attempt: started,
        fact: {
          schemaVersion: "polish_attempt_completed_v2",
          started: { schemaVersion: "polish_attempt_started_v2", attemptNo: 1, startedAtMs: Date.now(), deadlineAtMs: Date.now() + 1_000 },
          status: "succeeded", transmitted: true, retryEligible: false, providerBillable: true,
          usageObservation: { kind: "observed", usage: result.usage },
          route: {
            schemaVersion: "route_observation_v1", actualUpstreamEndpoint: result.route.actualUpstreamEndpoint ?? null,
            actualModelId: result.route.actualModelId ?? null, gatewayRequestId: result.route.gatewayRequestId ?? null,
            providerRequestId: result.route.providerRequestId ?? null, routerAttemptCount: 1,
          },
          cost: { schemaVersion: "cost_observation_v1", estimatedCost: { currency: "CNY", nanos: "3" }, estimationStatus: "complete", incompleteReasons: [], providerReportedCost: null },
          finishReason: result.finishReason, failureStage: null, error: null,
          transportStartedAtMs: Date.now(), completedAtMs: Date.now() + 1, latencyMs: 1,
        },
        profileExecutionConfig: snapshot.profileExecutionConfig,
        billingCurrency: snapshot.priceSnapshot.currency,
        routeObservationSecret: "config-simplification-route-observation",
      });
      expect(completed.status).toBe("succeeded");
      const settled = await finalizePolishRequestV2(service, {
        reservationId, settlementKind: "attempt_v2", status: "succeeded", transmitted: true, providerBillable: true,
        metadata: { granularity: "item", itemCount: 1, contextLevel: 0, language: "en", promptVersion: "cfg005-prompt-v1", validatorVersion: "cfg005-validator-v1" },
      });
      expect(settled.status).toBe("succeeded");
      expect(sent).toHaveLength(1);

      // Authority receipts are deployment-surface evidence, not one-close
      // cycle permits. A normal later close/readback/reopen must retain the
      // same V2 runtime authority without another cutover.
      const beforeLaterClose = await state();
      const disabled = await admin.rpc("admin_disable_ai_v1", {
        ...CONTEXT, p_expected_control_revision: beforeLaterClose.control.revision,
        p_reason: "close V2 execution for authority-scope regression",
        p_idempotency_key: crypto.randomUUID(),
      });
      expect(disabled.error).toBeNull();
      const afterLaterClose = await state();
      const laterReadback = await produceAdminRuntimeReadback(
        { policyVersionId, validationReportIds: [reportId] },
        {
          environment: producerEnvironment(),
          client: {
            rpc: async (functionName, args) => (service.rpc as unknown as (
              name: string, input: Record<string, unknown>,
            ) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>)(functionName, args),
          },
        },
      );
      const laterReopen = await admin.rpc("admin_reopen_ai_v2", {
        ...CONTEXT, p_readback_report_id: laterReadback.reportId,
        p_expected_closing_cycle_id: afterLaterClose.control.closing_cycle_id,
        p_expected_control_revision: afterLaterClose.control.revision,
        p_expected_policy_version_id: policyVersionId,
        p_expected_config_generation: afterLaterClose.config.config_generation,
        p_reason: "reopen V2 execution after later authority readback",
        p_idempotency_key: crypto.randomUUID(),
      });
      expect(laterReopen.error).toBeNull();
    });

    async function closeAndReadback() {
      const current = await state();
      if (current.config.ai_polish_enabled) {
        const disabled = await admin.rpc("admin_disable_ai_v1", {
          ...CONTEXT, p_expected_control_revision: current.control.revision,
          p_reason: "prepare control concurrency regression", p_idempotency_key: crypto.randomUUID(),
        });
        expect(disabled.error).toBeNull();
      }
      reportId = await recordReport();
      const readback = await produceAdminRuntimeReadback({ policyVersionId, validationReportIds: [reportId] }, {
        environment: producerEnvironment(),
        client: { rpc: async (name, args) => (service.rpc as unknown as (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>)(name, args) },
      });
      return { readback, current: await state() };
    }

    async function authenticatedSql(application: string, statement: string): Promise<OwnerSqlResult> {
      const token = (await admin.auth.getSession()).data.session!.access_token;
      const claims = Buffer.from(token.split(".")[1], "base64url").toString();
      return startOwnerSql(`begin; set local application_name=${sql(application)}; set local statement_timeout='12s'; set local role authenticated; set local request.jwt.claims=${sql(claims)}; ${statement}; rollback;`);
    }

    it.each(["candidate/pointer", "record/reopen"] as const)("serializes readback versus %s without deadlock", async (kind) => {
      const { readback, current } = await closeAndReadback();
      const readerName = `cfg005.reader.${crypto.randomUUID()}`;
      const writerName = `cfg005.writer.${crypto.randomUUID()}`;
      // Holding feature state queues readback first. With feature-first reads,
      // the writer can then hold environment and create the inverse-lock cycle.
      const barrier = holdStateRow("ai_feature_config");
      let reader: Promise<OwnerSqlResult> | undefined;
      let writer: Promise<OwnerSqlResult> | undefined;
      let results: OwnerSqlResult[] = [];
      try {
        await barrier.ready;
        const statement = kind === "candidate/pointer"
          ? `select public.get_admin_runtime_readback_candidate_v3(${sql(policyVersionId)},array[${sql(reportId)}::uuid],'local','local')`
          : `select public.record_admin_runtime_readback_v3('local','local',${sql(policyVersionId)},array[${sql(reportId)}::uuid],${sql(current.control.closing_cycle_id!)},${current.control.revision},${current.config.config_generation})`;
        reader = startOwnerSql(`begin; set local application_name=${sql(readerName)}; set local statement_timeout='12s'; set local role service_role; set local request.jwt.claims='{"role":"service_role"}'; ${statement}; rollback;`);
        await waitForDatabaseLock(readerName);
        writer = authenticatedSql(writerName, kind === "candidate/pointer"
          ? `select public.admin_clear_ai_routing_pointer_v2('local','local',array[${sql(reportId)}::uuid],${current.control.revision},${sql(policyVersionId)},${current.config.config_generation},'serialize pointer with readback',${sql(crypto.randomUUID())})`
          : `select public.admin_reopen_ai_v2('local','local',${sql(readback.reportId)},${sql(current.control.closing_cycle_id!)},${current.control.revision},${sql(policyVersionId)},${current.config.config_generation},'serialize reopen with readback',${sql(crypto.randomUUID())})`);
        await waitForDatabaseLock(writerName);
        barrier.release();
        results = await Promise.all([reader, writer]);
      } finally {
        barrier.release();
        await Promise.allSettled([barrier.result, ...(reader ? [reader] : []), ...(writer ? [writer] : [])]);
      }
      for (const result of results) {
        expect(result.stderr).not.toMatch(/deadlock|40P01|lock timeout|statement timeout/iu);
        expect(result.status, result.stderr).toBe(0);
      }
      expect(results).toHaveLength(2);
      const after = await state();
      expect(after.config).toEqual(current.config);
      expect(after.control).toEqual(current.control);
    });

    it("keeps the gate closed when reopen waits past immutable evidence expiry", async () => {
      const { readback, current } = await closeAndReadback();
      const shortReportId = crypto.randomUUID();
      const shortReadbackId = crypto.randomUUID();
      const operationId = crypto.randomUUID();
      const application = `cfg005.expiry.${crypto.randomUUID()}`;
      const barrier = holdStateRow("admin_environment");
      let reopen: Promise<OwnerSqlResult> | undefined;
      let result: OwnerSqlResult | undefined;
      try {
        await barrier.ready;
        // Owner fixtures copy actual validated facts into immutable near-expiry
        // rows. No guard is disabled and real database time crosses the expiry.
        runOwnerSql(`
          insert into public.admin_config_validation_reports_v2(
            id,environment,project_ref,runtime_contract_id,runtime_target_id,runtime_target_sha256,
            profile_version_id,price_version_id,provider_id,code_capability_id,code_capability_sha256,
            legal_bundle_version,legal_manifest_id,display_disclosure_key,endpoint_policy_valid,
            credential_binding_valid,credential_configured,compiled_capability_valid,database_binding_valid,
            evidence_ids,checked_at,expires_at,report_sha256)
          select ${sql(shortReportId)},environment,project_ref,runtime_contract_id,runtime_target_id,runtime_target_sha256,
            profile_version_id,price_version_id,provider_id,code_capability_id,code_capability_sha256,
            legal_bundle_version,legal_manifest_id,display_disclosure_key,endpoint_policy_valid,
            credential_binding_valid,credential_configured,compiled_capability_valid,database_binding_valid,
            evidence_ids,clock_timestamp()-interval '9 minutes',clock_timestamp()+interval '3 seconds',
            encode(extensions.digest(${sql(shortReportId)},'sha256'),'hex')
          from public.admin_config_validation_reports_v2 where id=${sql(reportId)};
          insert into public.admin_runtime_readback_reports_v2 select (jsonb_populate_record(null::public.admin_runtime_readback_reports_v2,
            to_jsonb(readback)||jsonb_build_object('id',${sql(shortReadbackId)},'validation_report_ids',jsonb_build_array(${sql(shortReportId)}),
              'checked_at',clock_timestamp()-interval '9 minutes','expires_at',(select expires_at from public.admin_config_validation_reports_v2 where id=${sql(shortReportId)}),
              'report_sha256',encode(extensions.digest(${sql(shortReadbackId)},'sha256'),'hex')))).*
          from public.admin_runtime_readback_reports_v2 readback where id=${sql(readback.reportId)};
        `);
        reopen = authenticatedSql(application, `select public.admin_reopen_ai_v2('local','local',${sql(shortReadbackId)},${sql(current.control.closing_cycle_id!)},${current.control.revision},${sql(policyVersionId)},${current.config.config_generation},'reject evidence expired during lock wait',${sql(operationId)})`);
        await waitForDatabaseLock(application);
        const deadline = Date.now() + 7_000;
        let expired = false;
        while (Date.now() < deadline) {
          expired = readOwnerJson<{ expired: boolean }>(`select json_build_object('expired',expires_at<clock_timestamp()) from public.admin_runtime_readback_reports_v2 where id=${sql(shortReadbackId)};`).expired;
          if (expired) break;
          await sleep(50);
        }
        expect(expired).toBe(true);
        barrier.release();
        result = await reopen;
      } finally {
        barrier.release();
        await Promise.allSettled([barrier.result, ...(reopen ? [reopen] : [])]);
      }
      expect(result?.status).not.toBe(0);
      expect(result?.stderr).toMatch(/NOT_READY|VALIDATION_REPORT/);
      expect(result?.stderr).not.toMatch(/deadlock|40P01|lock timeout|statement timeout/iu);
      expect((await state()).config.ai_polish_enabled).toBe(false);
      expect(readOwnerJson<{ count: number }>(`select json_build_object('count',count(*)) from public.admin_committed_operations where actor_user_id=${sql(adminUser.id)} and idempotency_key=${sql(operationId)};`).count).toBe(0);
    });
  },
);
