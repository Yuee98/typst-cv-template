import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminCommittedOperationSchema, adminContextSchema, adminPageSchema } from "@/lib/admin/contract";
import { handleAdminGet, handleAdminPost } from "@/server/admin/handler";
import { createAdminRequestClient } from "@/server/admin/request-client";
import { createAnonClient, createServiceClient, DB_TEST_ENV, getLedgerRow, RUN_DB_TESTS, signInAsUser, type TestUser } from "./helpers";
import { completePayload, SettlementHarness } from "./provider-attempt-settlement-fixtures";
import { runOwnerSql, startOwnerSql } from "./runtime-contract-fixtures";

const base = { p_environment: "local", p_project_ref: null };
const providerId = "706513a5-462b-4bba-93b0-53e50661416e";
const sql = (value: string) => `'${value.replaceAll("'", "''")}'`;
function ownerJson<T>(statement: string): T {
  const line = runOwnerSql(`\\pset format unaligned\n\\pset tuples_only on\n${statement}`).stdout.split(/\r?\n/u).map(line => line.trim()).findLast(line => line.startsWith("{"));
  if (!line) throw new Error("Owner JSON missing");
  return JSON.parse(line) as T;
}

describe.skipIf(!RUN_DB_TESTS)("Admin preparation while legacy AI remains live", () => {
  let service: SupabaseClient, admin: SupabaseClient, ordinary: SupabaseClient;
  let harness: SettlementHarness, adminUser: TestUser, ordinaryUser: TestUser;
  let token: string, ordinaryToken: string, sessionId: string;
  let ownsEnvironment = false;
  let providerBefore: Record<string, unknown>;
  let policyRequest: Record<string, unknown>;
  let profileId: string, versionId: string, priceId: string;
  let policyOperationId: string, policyAuditId: string;

  const deps = {
    environment: () => ({ name: "local" as const, supabaseUrl: DB_TEST_ENV!.url, publishableKey: DB_TEST_ENV!.publishableKey }),
    client: createAdminRequestClient,
  };
  const post = (body: Record<string, unknown>, bearer = token) => handleAdminPost(new Request("http://local.test/api/admin", {
    method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), deps);
  async function commit(body: Record<string, unknown>) {
    const response = await post({ reason: "legacy draft preparation", idempotencyKey: crypto.randomUUID(), ...body });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    return adminCommittedOperationSchema.parse(await response.json());
  }
  function state() {
    return ownerJson(`select jsonb_build_object(
      'features',(select to_jsonb(t) from public.ai_feature_config t where id=true),
      'environment',(select to_jsonb(t) from public.admin_environment t where id=true),
      'control',(select to_jsonb(t) from public.admin_ai_control_state_v1 t where id=true),
      'legal',public.current_ai_terms_version(),
      'expected',(select jsonb_agg(to_jsonb(t) order by signature) from public.admin_runtime_authority_expected_v3 t),
      'receipts',(select jsonb_agg(to_jsonb(t) order by receipt_id) from public.admin_runtime_authority_receipts_v3 t),
      'activeProfile',(select to_jsonb(t) from public.ai_provider_profile_versions t where id=${sql(harness.fixture.profileVersionId)}),
      'activePrice',(select to_jsonb(t) from public.ai_price_versions t where id=${sql(harness.fixture.priceVersionId)}),
      'activePolicy',(select to_jsonb(t) from public.ai_routing_policy_versions t where id=${sql(harness.fixture.policyVersionId)}),
      'authority',(select jsonb_agg(jsonb_build_object('definition',encode(extensions.digest(pg_get_functiondef(proc.oid),'sha256'),'hex'),'acl',proc.proacl::text) order by expected.signature)
        from public.admin_runtime_authority_expected_v3 expected join pg_proc proc on proc.oid=to_regprocedure(expected.signature))
    );`);
  }
  const identityArgs = () => ({ ...base, p_provider_id: providerId, p_profile_key: `test.draft.${crypto.randomUUID()}`, p_display_name: "Draft profile", p_model_vendor: "deepseek", p_reason: "legacy preparation", p_idempotency_key: crypto.randomUUID() });

  beforeAll(async () => {
    const counts = ownerJson<{ count: number }>("select json_build_object('count',count(*)) from public.admin_environment;");
    expect(counts.count).toBe(0);
    service = createServiceClient(); harness = new SettlementHarness(service);
    await harness.setup();
    adminUser = await harness.makeUser("draft-admin"); ordinaryUser = await harness.makeUser("draft-ordinary");
    admin = await signInAsUser(adminUser); ordinary = await signInAsUser(ordinaryUser);
    token = (await admin.auth.getSession()).data.session!.access_token;
    ordinaryToken = (await ordinary.auth.getSession()).data.session!.access_token;
    sessionId = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).session_id;
    providerBefore = ownerJson(`select to_jsonb(t) from public.ai_providers t where id=${sql(providerId)};`);
    runOwnerSql(`select public.admin_bootstrap_v2(${sql(adminUser.id)},'local','live drafting test bootstrap');`);
    ownsEnvironment = true;
  });

  afterAll(async () => {
    if (ownsEnvironment) {
      // Only synthetic actor rows and this test's original Provider defaults
      // are restored. Immutable catalog fixtures stay until a fresh reset.
      runOwnerSql(`begin; set local session_replication_role=replica;
        update public.ai_providers set (display_name,default_adapter_id,default_endpoint_url,default_credential_env_name,default_model_id,archived_at,revision)=
          (select display_name,default_adapter_id,default_endpoint_url,default_credential_env_name,default_model_id,archived_at,revision
           from jsonb_populate_record(null::public.ai_providers,${sql(JSON.stringify(providerBefore))}::jsonb)) where id=${sql(providerId)};
        delete from public.admin_committed_operations where actor_user_id=${sql(adminUser.id)};
        delete from public.admin_principals where user_id=${sql(adminUser.id)};
        delete from public.admin_environment where id=true and environment='local'; commit;`);
    }
    if (harness) await harness.cleanup();
  });

  it("creates audited drafts without stopping existing reserve/start/retry/settlement", async () => {
    const before = state();
    const reserved = await harness.reserveV2(ordinaryUser);
    const first = await harness.startAttempt(reserved.reservationId, 1);
    const identity = await commit({ operation: "provider_profile_create", providerId, profileKey: `test.draft.api.${crypto.randomUUID()}`, displayName: "Prepared profile", modelVendor: "deepseek" });
    if (identity.result.schemaVersion !== "admin_profile_identity_result_v1") throw new Error("Wrong identity result");
    profileId = identity.result.profileId;
    const versionRequest = { operation: "profile_version_create", profileId, expectedLatestVersion: "0", adapterId: "deepseek_chat_v1", wireApiKind: "chat_completions_v1", endpointUrl: "https://api.deepseek.com/chat/completions", credentialEnvName: "AI_PROVIDER_KEY_DRAFT_NOT_CONFIGURED", modelId: "draft-only-model", capabilityContractId: "deepseek_chat_json_object_v1", cachePolicyId: "deepseek_automatic_context_cache_v1", legalManifestId: "deepseek-official-2026-08-23-v1", displayDisclosureKey: "draft.not-yet-bound", config: { thinking: "disabled", structuredOutput: "json_object", providerSubjectField: "user_id" } };
    const version = await commit(versionRequest);
    expect((await post({ ...versionRequest, reason: "stale version", idempotencyKey: crypto.randomUUID() })).status).toBe(409);
    if (version.result.schemaVersion !== "admin_profile_version_result_v1") throw new Error("Wrong version result");
    versionId = version.result.profileVersionId;
    expect(version.result.status).toBe("draft");
    const priceRequest = { operation: "price_version_create", profileVersionId: versionId, pricingLane: "default", expectedLatestVersion: "0", currency: "CNY", calculatorKind: "linear_token_v1", validFrom: "2026-01-01T00:00:00Z", validTo: null, providerEffectiveFrom: null, providerEffectiveTo: null, sourceUrl: "https://example.test/draft-price", sourceCheckedAt: new Date().toISOString(), sourceSnapshotSha256: "9".repeat(64), parameters: {}, components: { input_standard: "100", input_cache_read: "10", output: "200" } };
    const price = await commit(priceRequest);
    expect((await post({ ...priceRequest, reason: "stale version", idempotencyKey: crypto.randomUUID() })).status).toBe(409);
    if (price.result.schemaVersion !== "admin_price_version_result_v1") throw new Error("Wrong price result");
    priceId = price.result.priceVersionId;
    expect(price.result.sealed).toBe(false);
    policyRequest = { operation: "routing_policy_draft_create", policyKey: `test.draft.policy.${crypto.randomUUID()}`, expectedLatestVersion: "0", rules: { schemaVersion: "routing_rules_v1", defaultRoute: { profileVersionId: versionId, priceVersionId: priceId }, windows: [] }, defaultProfileVersionId: versionId, legalBundleVersion: "draft.future-legal-bundle", runtimeContractId: harness.fixture.runtimeContractId, reason: "save before readiness", idempotencyKey: crypto.randomUUID() };
    const policy = await commit(policyRequest);
    policyOperationId = policy.operationId; policyAuditId = policy.auditId;
    expect(policy.result).toMatchObject({ schemaVersion: "admin_routing_policy_draft_result_v1", status: "draft" });
    expect(policy.result).not.toHaveProperty("validationReportIds");
    const replay = await commit(policyRequest);
    expect(replay.operationId).toBe(policy.operationId);
    expect(replay.auditId).toBe(policy.auditId);
    expect((await post({ ...policyRequest, reason: "different payload" })).status).toBe(409);
    const audit = await handleAdminGet(new Request(`http://local.test/api/admin?section=audit&id=${policy.auditId}`, { headers: { Authorization: `Bearer ${token}` } }), deps);
    expect(audit.status).toBe(200);
    expect(adminPageSchema.parse(await audit.json()).items[0]).toMatchObject({ id: policy.auditId, operation: "routing_policy_draft_create" });
    const context = await admin.rpc("admin_get_context_v1", base);
    expect(context.error).toBeNull();
    expect(adminContextSchema.parse(context.data)).toMatchObject({ environment: { controlPlaneMode: "legacy" }, capabilities: { drafts: true, writes: false }, features: { aiEnabled: true } });
    expect(state()).toEqual(before);
    await harness.complete(completePayload(first.attemptId, { p_status: "failed_upstream", p_retry_eligible: true }));
    const retry = await harness.startAttempt(reserved.reservationId, 2);
    await harness.complete(completePayload(retry.attemptId));
    await harness.finalize(reserved.reservationId);
    expect(await getLedgerRow(service, reserved.reservationId)).toMatchObject({ state: "finalized", status: "succeeded", attempt_count: 2, profile_version_id: reserved.routeSnapshot.profileVersionId, price_version_id: reserved.routeSnapshot.priceVersionId });
    const next = await harness.reserveV2(ordinaryUser);
    expect(next.routeSnapshot).toEqual(reserved.routeSnapshot);
    const snapshot = await service.rpc("get_ai_polish_execution_snapshot_v5", { p_reservation_id: next.reservationId, p_user_id: ordinaryUser.id, ...base });
    expect(snapshot.error).toBeNull();
    expect(snapshot.data).toMatchObject({ ok: true, schemaVersion: "ai_polish_execution_snapshot_v1" });
    const started = await service.rpc("start_ai_polish_provider_attempt_v5", { p_reservation_id: next.reservationId, p_attempt_no: 1, p_runtime_config_receipt: null });
    expect(started.error).toBeNull(); expect(started.data).toMatchObject({ ok: true, alreadyStarted: false });
    expect(state()).toEqual(before);
  });

  it("creates provider directories and discovers zero-version identities with bounded options", async () => {
    const before = state();
    const request = { operation: "provider_create", providerKey: `test.custom.${crypto.randomUUID()}`, displayName: "Local custom directory", recipientKey: "custom-test", gatewayKind: "custom_compatible", defaultAdapterId: "deepseek_chat_v1", defaultEndpointUrl: "https://example.test/chat/completions", defaultCredentialEnvName: "AI_PROVIDER_KEY_TEST_UNUSED", defaultModelId: "test-model", reason: "prepare custom directory", idempotencyKey: crypto.randomUUID() };
    const created = await commit(request);
    expect((await commit(request)).operationId).toBe(created.operationId);
    expect((await post({ ...request, idempotencyKey: crypto.randomUUID() })).status).toBe(409);
    expect((await post({ ...request, idempotencyKey: crypto.randomUUID() }, ordinaryToken)).status).toBe(403);
    if (created.result.schemaVersion !== "admin_provider_result_v1") throw new Error();
    const concurrent = { ...request, providerKey: 'test.concurrent.' + crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
    const race = await Promise.all([post(concurrent), post({ ...concurrent, idempotencyKey: crypto.randomUUID() })]);
    expect(race.map(response => response.status).sort()).toEqual([200,409]);
    const newProvider = created.result.providerId;
    const identity = await commit({ operation: "provider_profile_create", providerId: newProvider, profileKey: `test.custom.profile.${crypto.randomUUID()}`, displayName: "Custom identity", modelVendor: "custom-test" });
    if (identity.result.schemaVersion !== "admin_profile_identity_result_v1") throw new Error();
    const get = (query: string, bearer = token) => handleAdminGet(new Request(`http://local.test/api/admin?section=options&${query}`, { headers: { Authorization: `Bearer ${bearer}` } }), deps);
    const result = await get(`kind=identities&parent=${newProvider}`);
    expect(result.status).toBe(200);
    expect((await result.json()).items).toEqual([expect.objectContaining({ id: identity.result.profileId, latestVersion: 0, parentId: newProvider })]);
    expect((await (await get(`kind=identities&parent=${providerId}&id=${identity.result.profileId}`)).json()).items).toEqual([]);
    expect((await get("kind=providers", ordinaryToken)).status).toBe(403);
    const first = await (await get("kind=providers&limit=1")).json();
    const next = await (await get(`kind=providers&limit=1&after=${first.nextCursor}`)).json();
    expect(first.items).toHaveLength(1); expect(next.items).toHaveLength(1); expect(next.items[0].id).not.toBe(first.items[0].id);
    expect((await (await get(`kind=providers&id=${newProvider}`)).json()).items[0].id).toBe(newProvider);
    expect((await (await get("kind=providers&search=no-such-provider-unique-marker")).json()).items).toEqual([]);
    const version = await commit({ operation: "profile_version_create", profileId: identity.result.profileId, expectedLatestVersion: "0", adapterId: "deepseek_chat_v1", wireApiKind: "chat_completions_v1", endpointUrl: request.defaultEndpointUrl, credentialEnvName: request.defaultCredentialEnvName, modelId: request.defaultModelId, capabilityContractId: "deepseek_chat_json_object_v1", cachePolicyId: "deepseek_automatic_context_cache_v1", legalManifestId: "custom-test", displayDisclosureKey: "custom-test", config: { providerSubjectField: "user_id", structuredOutput: "json_object", thinking: "disabled" } });
    expect(version.result).toMatchObject({ status: "draft" });
    const prices = await (await get('kind=prices&parent=' + versionId)).json();
    expect(prices.items).toEqual([expect.objectContaining({ id: priceId, parentId: versionId, status: 'unsealed' })]);
    expect((await (await get('kind=prices&parent=' + harness.fixture.profileVersionId + '&id=' + priceId)).json()).items).toEqual([]);
    for (const client of [createAnonClient(), service]) {
      expect((await client.rpc("admin_authoring_options_v1", { ...base, p_kind: "providers" })).error?.code).toBe("42501");
      expect((await client.rpc("admin_create_provider_v1", { ...base, p_provider_key: request.providerKey, p_display_name: request.displayName, p_recipient_key: request.recipientKey, p_gateway_kind: request.gatewayKind, p_default_adapter_id: request.defaultAdapterId, p_default_endpoint_url: request.defaultEndpointUrl, p_default_credential_env_name: request.defaultCredentialEnvName, p_default_model_id: request.defaultModelId, p_reason: request.reason, p_idempotency_key: crypto.randomUUID() })).error?.code).toBe("42501");
    }
    expect((await admin.rpc("admin_authoring_options_v1", { ...base, p_environment: "preview", p_kind: "providers" })).error?.message).toBe("ENVIRONMENT_MISMATCH");
    expect(state()).toEqual(before);
  });

  it("persists all 32 windows through the public API for first and successor policies", async () => {
    const route = { profileVersionId: versionId, priceVersionId: priceId };
    const rules = { schemaVersion: "routing_rules_v1", defaultRoute: route, windows: Array.from({ length: 32 }, (_, i) => ({ weekdays: [7,1,2,3,4,5,6], startMinute: i * 40, endMinute: (i + 1) * 40, route })) };
    const request = { ...policyRequest, policyKey: `test.max.${crypto.randomUUID()}`, rules, reason: "界".repeat(500), idempotencyKey: crypto.randomUUID() };
    expect(Buffer.byteLength(JSON.stringify(request))).toBeGreaterThan(4096);
    for (const expectedLatestVersion of ["0", "1"]) {
      const result = await commit({ ...request, expectedLatestVersion, idempotencyKey: crypto.randomUUID() });
      if (result.result.schemaVersion !== "admin_routing_policy_draft_result_v1") throw new Error();
      const stored = ownerJson<{ rules: unknown }>(`select jsonb_build_object('rules',rules) from public.ai_routing_policy_versions where id=${sql(result.result.policyVersionId)};`);
      expect(stored.rules).toEqual(rules);
    }
    for (const invalid of [{ ...rules, windows: [...rules.windows, rules.windows[0]] }, { ...rules, unexpected: true }]) {
      const body = { ...request, policyKey: `test.invalid.${crypto.randomUUID()}`, rules: invalid, idempotencyKey: crypto.randomUUID() };
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(16384);
      expect((await post(body)).status).not.toBe(200);
    }
  });

  it("changes only future Provider defaults, including archive behavior", async () => {
    const before = state();
    const frozen = ownerJson(`select to_jsonb(t) from public.ai_provider_profile_versions t where id=${sql(versionId)};`);
    const defaults = await commit({ operation: "provider_defaults_update", providerId, displayName: "Prepared defaults", defaultAdapterId: "deepseek_chat_v1", defaultEndpointUrl: "https://api.deepseek.com/new-draft-path", defaultCredentialEnvName: "AI_PROVIDER_KEY_FUTURE_ONLY", defaultModelId: "future-only", archived: true, expectedRevision: String(providerBefore.revision) });
    expect(defaults.result).toMatchObject({ archived: true });
    expect((await post({ operation: "provider_defaults_update", providerId, displayName: "stale defaults", defaultAdapterId: "deepseek_chat_v1", defaultEndpointUrl: "https://api.deepseek.com/chat/completions", defaultCredentialEnvName: "AI_PROVIDER_KEY_FUTURE_ONLY", defaultModelId: "future-only", archived: true, expectedRevision: String(providerBefore.revision), reason: "stale revision", idempotencyKey: crypto.randomUUID() })).status).toBe(409);
    expect((await admin.rpc("admin_create_provider_profile_v1", identityArgs())).error?.message).toBe("PROVIDER_UNAVAILABLE");
    expect(ownerJson(`select to_jsonb(t) from public.ai_provider_profile_versions t where id=${sql(versionId)};`)).toEqual(frozen);
    const reserved = await harness.reserveV2(ordinaryUser);
    await harness.startAttempt(reserved.reservationId, 1);
    expect(state()).toEqual(before);
    if (defaults.result.schemaVersion !== "admin_provider_result_v1") throw new Error("Wrong defaults result");
    await commit({ operation: "provider_defaults_update", providerId, displayName: providerBefore.display_name, defaultAdapterId: providerBefore.default_adapter_id, defaultEndpointUrl: providerBefore.default_endpoint_url, defaultCredentialEnvName: providerBefore.default_credential_env_name, defaultModelId: providerBefore.default_model_id, archived: false, expectedRevision: defaults.result.revision });
  });

  it("rejects malformed and cross-profile drafts and serializes expected versions", async () => {
    const concurrentUser = await harness.makeUser("draft-concurrent");
    const request = { ...policyRequest, policyKey: `test.draft.concurrent.${crypto.randomUUID()}`, idempotencyKey: crypto.randomUUID() };
    const results = await Promise.all([
      post(request),
      post({ ...request, idempotencyKey: crypto.randomUUID() }),
      harness.reserveV2(concurrentUser),
    ]);
    expect([results[0].status, results[1].status].sort()).toEqual([200, 409]);
    for (const rules of [
      {},
      { schemaVersion: "routing_rules_v1", defaultRoute: { profileVersionId: versionId, priceVersionId: harness.fixture.priceVersionId }, windows: [] },
      { schemaVersion: "routing_rules_v1", defaultRoute: { profileVersionId: versionId, priceVersionId: priceId }, windows: [{ weekdays: [1], startMinute: 50, endMinute: 20, route: { profileVersionId: versionId, priceVersionId: priceId } }] },
    ]) {
      expect((await post({ ...request, policyKey: `test.draft.invalid.${crypto.randomUUID()}`, idempotencyKey: crypto.randomUUID(), rules })).status).not.toBe(200);
    }
    expect(runOwnerSql(`update public.ai_provider_profile_versions set model_id='changed' where id=${sql(versionId)};`, { expectFailure: true }).stderr).toContain("immutable");
  });

  it("keeps direct runtime RPCs gated even with valid administrator identity", async () => {
    const options = { ...base, p_reason: "must remain gated", p_idempotency_key: crypto.randomUUID() };
    const calls = [
      ["admin_transition_profile_version_v2", { p_profile_version_id: versionId, p_to_status: "validated", p_validation_report_id: crypto.randomUUID() }],
      ["admin_transition_routing_policy_v2", { p_policy_version_id: harness.fixture.policyVersionId, p_to_status: "active", p_validation_report_ids: [] }],
      ["admin_seal_price_for_activation_v2", { p_price_version_id: priceId, p_runtime_contract_id: harness.fixture.runtimeContractId }],
      ["admin_disable_ai_v1", { p_expected_control_revision: 0 }],
      ["admin_set_global_daily_limit_v1", { p_global_daily_limit: 10, p_expected_global_daily_limit: 2000000, p_expected_control_revision: 0 }],
      ["admin_set_membership_v1", { p_target_user_id: ordinaryUser.id, p_enabled: true, p_expected_revision: 0 }],
      ["admin_set_ai_routing_pointer_v2", { p_policy_version_id: harness.fixture.policyVersionId, p_validation_report_ids: [], p_expected_control_revision: 0, p_expected_policy_version_id: harness.fixture.policyVersionId, p_expected_config_generation: 0 }],
      ["admin_reopen_ai_v2", { p_readback_report_id: crypto.randomUUID(), p_expected_closing_cycle_id: crypto.randomUUID(), p_expected_control_revision: 0, p_expected_policy_version_id: harness.fixture.policyVersionId, p_expected_config_generation: 0 }],
    ] as const;
    const before = state();
    for (const [name, args] of calls) expect((await admin.rpc(name, { ...options, ...args })).error?.message, name).toBe("WRITES_DISABLED");
    expect(state()).toEqual(before);
  });

  it("rejects unauthorized, revoked, banned, dead-session and wrong-environment authors", async () => {
    for (const client of [createAnonClient(), ordinary, service]) expect((await client.rpc("admin_create_provider_profile_v1", identityArgs())).error?.code).toBe("42501");
    expect((await post({ ...policyRequest, idempotencyKey: crypto.randomUUID() }, ordinaryToken)).status).toBe(403);
    expect((await admin.rpc("admin_create_provider_profile_v1", { ...identityArgs(), p_environment: "preview" })).error?.message).toBe("ENVIRONMENT_MISMATCH");
    for (const changes of [
      [`update public.admin_principals set revoked_at=clock_timestamp() where user_id=${sql(adminUser.id)};`, `update public.admin_principals set revoked_at=null where user_id=${sql(adminUser.id)};`],
      [`update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=${sql(adminUser.id)};`, `update auth.users set banned_until=null where id=${sql(adminUser.id)};`],
      [`update auth.sessions set not_after=clock_timestamp()-interval '1 hour' where id=${sql(sessionId)};`, `update auth.sessions set not_after=null where id=${sql(sessionId)};`],
    ]) {
      runOwnerSql(changes[0]);
      try { expect((await admin.rpc("admin_create_provider_profile_v1", identityArgs())).error?.code).toBe("42501"); expect((await admin.rpc("admin_authoring_options_v1", { ...base, p_kind: "providers" })).error?.code).toBe("42501"); }
      finally { runOwnerSql(changes[1]); }
    }
    expect((await admin.from("ai_provider_profile_versions").update({ status: "active" }).eq("id", versionId)).error?.code).toBe("42501");
  });

  it("replays a committed draft after the later real cutover without changing its payload", () => {
    const claims = JSON.stringify(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()));
    const request = policyRequest;
    const output = runOwnerSql(`begin;
      update public.ai_feature_config set ai_polish_enabled=false where id=true;
      select public.admin_cutover_authority_v3('{}'::uuid[],0,0,'test later runtime cutover');
      set local request.jwt.claims=${sql(claims)};
      set local role authenticated;
      select public.admin_create_routing_policy_draft_v1('local',null,${sql(String(request.policyKey))},0,${sql(JSON.stringify(request.rules))}::jsonb,${sql(versionId)},${sql(String(request.legalBundleVersion))},${sql(String(request.runtimeContractId))},${sql(String(request.reason))},${sql(String(request.idempotencyKey))});
      rollback;`);
    expect(output.stdout).toContain('"operationKind": "routing_policy_draft_create"');
    expect(output.stdout).toContain(`"operationId": "${policyOperationId}"`);
    expect(output.stdout).toContain(`"auditId": "${policyAuditId}"`);
  });

  it("serializes preparation with concurrent membership revocation", async () => {
    const claims = JSON.stringify(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()));
    const args = identityArgs();
    const marker = `draft_revoke_${crypto.randomUUID()}`;
    const holder = spawn("docker", ["exec", "-i", "supabase_db_typst-cv-template", "psql", "-U", "postgres", "-d", "postgres", "--set", "ON_ERROR_STOP=1", "--no-psqlrc"], { stdio: "pipe" });
    let stderr = "";
    holder.stderr.on("data", chunk => { stderr += chunk; });
    const held = new Promise<void>((resolve, reject) => {
      let output = "";
      holder.stdout.on("data", chunk => { output += chunk; if (output.includes(marker)) resolve(); });
      holder.once("error", reject);
      holder.once("close", () => reject(new Error("Lock holder ended before release")));
    });
    const finished = new Promise<number | null>(resolve => holder.once("close", resolve));
    holder.stdin.write(`begin; select 1 from public.admin_environment where id=true for update;
      update public.admin_principals set revoked_at=clock_timestamp() where user_id=${sql(adminUser.id)};\n\\echo ${marker}\n`);
    await held;
    const author = startOwnerSql(`set application_name=${sql(marker)}; begin; set local request.jwt.claims=${sql(claims)}; set local role authenticated;
      select public.admin_create_provider_profile_v1('local',null,${sql(providerId)},${sql(args.p_profile_key)},'blocked author','deepseek','revocation race','${args.p_idempotency_key}'); commit;`);
    try {
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (!blocked && Date.now() < deadline) {
        blocked = ownerJson<{ blocked: boolean }>(`select json_build_object('blocked',exists(select 1 from pg_stat_activity where application_name=${sql(marker)} and cardinality(pg_blocking_pids(pid))>0));`).blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true);
      holder.stdin.end("commit;\n");
      expect(await finished, stderr).toBe(0);
      const result = await author;
      expect(result.status).not.toBe(0); expect(result.stderr).toContain("FORBIDDEN");
    } finally {
      if (!holder.stdin.writableEnded) holder.stdin.end("rollback;\n");
      await Promise.allSettled([finished, author]);
      runOwnerSql(`update public.admin_principals set revoked_at=null where user_id=${sql(adminUser.id)};`);
    }
  });
});
