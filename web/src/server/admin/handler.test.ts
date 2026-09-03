import { describe, expect, it, vi } from "vitest";
import context from "../../../test/fixtures/admin-contract-v1.json";
import { handleAdminGet, handleAdminPost } from "./handler";
import { resolveAdminEnvironment } from "./environment";

const environment = {
  name: "local" as const,
  projectRef: "local",
  supabaseUrl: "http://127.0.0.1:54321",
  publishableKey: "public-test-key",
};
function setup(data: unknown = context, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  const getUser = vi
    .fn()
    .mockResolvedValue({
      data: { user: { id: context.actor.userId } },
      error: null,
    });
  const client = vi.fn().mockReturnValue({ rpc, auth: { getUser } });
  return {
    rpc,
    getUser,
    client,
    deps: { environment: () => environment, client },
  };
}
const request = (query = "", token = "user-jwt") =>
  new Request(`https://site.test/api/admin${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
const postRequest = (body: unknown, token = "user-jwt") =>
  new Request("https://site.test/api/admin", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const streamingPostRequest = (
  chunks: Uint8Array[],
  contentLength?: number,
) => {
  const headers = new Headers({
    Authorization: "Bearer user-jwt",
    "Content-Type": "application/json",
  });
  if (contentLength !== undefined)
    headers.set("Content-Length", String(contentLength));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request("https://site.test/api/admin", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
};
const committed = {
  schemaVersion: "admin_committed_operation_v1",
  operationId: "11111111-1111-4111-8111-111111111111",
  operationKind: "admin_membership_set",
  idempotencyKey: "22222222-2222-4222-8222-222222222222",
  result: {
    schemaVersion: "admin_membership_result_v1",
    userId: "44444444-4444-4444-8444-444444444444",
    enabled: true,
    revision: "2",
  },
  auditId: "33333333-3333-4333-8333-333333333333",
  committedAt: "2026-09-04T00:00:00.000Z",
};
const analytics = {
  schemaVersion: "admin_ai_analytics_v1",
  range: {
    from: "2026-08-28T00:00:00.000Z",
    to: "2026-09-04T00:00:00.000Z",
    timezone: "UTC",
    retentionDays: 90,
    retentionBoundary: "2026-06-06T00:00:00.000Z",
    rangeMayBeTruncated: false,
    requestTimeField: "reserved_at",
    attemptTimeField: "started_at",
  },
  requests: {
    total: 3, finalized: 3, succeeded: 2, failedUpstream: 1,
    invalidOutput: 0, canceled: 0, released: 0, abandoned: 0,
    retried: 1, latencyP50Ms: 100, latencyP95Ms: 200,
  },
  attempts: {
    total: 4, transmitted: 3, succeeded: 2, failedUpstream: 1,
    invalidOutput: 0, timedOut: 0, canceled: 0, unknown: 0, unsettled: 1,
  },
  usage: {
    completeRows: 2, incompleteRows: 2, inputCacheReadTokens: "10",
    inputCacheWriteTokens: "0", inputStandardTokens: "30",
    outputTokens: "20", reasoningTokens: "0",
  },
  costsByCurrency: [],
  costGroupsTruncated: false,
  routes: [],
  routeGroupsTruncated: false,
};
const controlState = {
  schemaVersion: "admin_ai_control_state_v1",
  aiEnabled: false,
  globalDailyLimit: 25,
  activePolicyVersionId: "55555555-5555-4555-8555-555555555555",
  configGeneration: "8",
  controlRevision: "12",
  closingCycleId: "66666666-6666-4666-8666-666666666666",
  closedAt: "2026-09-04T00:00:00.000Z",
  reopenedAt: null,
  writesEnabled: true,
};
const runtimeReadbackRequest = {
  operation: "record_runtime_readback" as const,
  reviewedDeploymentId: "11111111-1111-4111-8111-111111111111",
  policyVersionId: "55555555-5555-4555-8555-555555555555",
  validationReportIds: ["77777777-7777-4777-8777-777777777777"],
};
function runtimeReadback() {
  const checkedAt = new Date(Date.now() - 1_000);
  return {
    schemaVersion: "admin_runtime_readback_v1" as const,
    reportId: "88888888-8888-4888-8888-888888888888",
    closingCycleId: controlState.closingCycleId,
    controlRevision: controlState.controlRevision,
    configGeneration: controlState.configGeneration,
    policyVersionId: runtimeReadbackRequest.policyVersionId,
    legalBundleVersion: "legal.bundle.v1",
    reviewedDeploymentId: runtimeReadbackRequest.reviewedDeploymentId,
    runtimeBuildId: "build-2026-09-04",
    bindingManifestRevision: "manifest-2026-09-04",
    bindingManifestSha256: "a".repeat(64),
    validationReportIds: runtimeReadbackRequest.validationReportIds,
    effectiveRoutes: [{ runtimeTargetId: "target.deepseek.v1" }],
    checkedAt: checkedAt.toISOString(),
    expiresAt: new Date(checkedAt.getTime() + 9 * 60_000).toISOString(),
    reportSha256: "b".repeat(64),
  };
}

const validationRequest = {
  operation: "validate_runtime_target" as const,
  reviewedDeploymentId: "11111111-1111-4111-8111-111111111111",
  runtimeContractId: "runtime.deepseek-v2.v1",
  runtimeTargetId: "runtime-target.deepseek.v1",
};
function validationReport() {
  const checkedAt = new Date(Date.now() - 1_000);
  return {
    schemaVersion: "admin_validation_report_v1" as const,
    reportId: "22222222-2222-4222-8222-222222222222",
    reviewedDeploymentId: validationRequest.reviewedDeploymentId,
    environment: "local" as const,
    projectRef: "local",
    runtimeBuildId: "build-2026-09-04",
    bindingManifestRevision: "manifest-2026-09-04",
    bindingManifestSha256: "1".repeat(64),
    runtimeContractId: validationRequest.runtimeContractId,
    runtimeTargetId: validationRequest.runtimeTargetId,
    runtimeTargetSha256: "2".repeat(64),
    profileVersionId: "33333333-3333-4333-8333-333333333333",
    priceVersionId: "44444444-4444-4444-8444-444444444444",
    providerId: "55555555-5555-4555-8555-555555555555",
    codeCapabilityId: "runtime-capability.deepseek-chat-v1.2026-09-04",
    codeCapabilitySha256: "3".repeat(64),
    legalBundleVersion: "2026-08-23-multi-provider-v1",
    legalManifestId: "deepseek-official-2026-08-23-v1",
    displayDisclosureKey: "deepseek-official-v1",
    checks: {
      endpointPolicy: true,
      manifestBinding: true,
      credentialConfigured: true,
      compiledCapability: true,
      databaseBinding: true,
    },
    passed: true,
    evidenceIds: ["evidence.reviewed-build"],
    checkedAt: checkedAt.toISOString(),
    expiresAt: new Date(checkedAt.getTime() + 9 * 60_000).toISOString(),
    reportSha256: "4".repeat(64),
  };
}
describe("Admin read HTTP boundary", () => {
  it("verifies and carries the same bearer into a per-request client", async () => {
    const { deps, client, getUser, rpc } = setup();
    const response = await handleAdminGet(request(), deps);
    expect(client).toHaveBeenCalledWith(environment, "user-jwt");
    expect(getUser).toHaveBeenCalledWith("user-jwt");
    expect(rpc).toHaveBeenCalledWith("admin_get_context_v1", {
      p_environment: "local",
      p_project_ref: "local",
    });
    expect(await response.json()).toEqual(context);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Authorization");
  });
  it("does not query for an absent or invalid session", async () => {
    const { deps, getUser, rpc } = setup();
    expect(
      (await handleAdminGet(new Request("https://site.test/api/admin"), deps))
        .status,
    ).toBe(401);
    getUser.mockResolvedValue({
      data: { user: null },
      error: { message: "expired" },
    });
    expect((await handleAdminGet(request(), deps)).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([
    "?section=users&limit=101",
    "?section=users&limit=1&limit=2",
    "?section=sql",
    "?section=users&id=bad",
    "?section=users&after=bad",
    "?section=users&search=" + "x".repeat(101),
    "?section=overview&limit=1",
    "?section=analytics&days=0",
    "?section=analytics&days=32",
    "?section=analytics&id=11111111-1111-4111-8111-111111111111",
    "?section=users&days=7",
    "?secret=anything",
  ])("rejects unbounded/unknown query %s", async (query) => {
    const { deps, rpc } = setup();
    expect((await handleAdminGet(request(query), deps)).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("fails closed on unexpected fields and does not echo raw DB errors", async () => {
    const unsafe = setup({ ...context, secret: "hidden-value" });
    const response = await handleAdminGet(request(), unsafe.deps);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("hidden-value");
    const upstream = setup(null, {
      code: "P0001",
      message: "SQL and credential hidden-value",
    });
    expect(
      await (await handleAdminGet(request(), upstream.deps)).json(),
    ).toEqual({ error: { code: "UNAVAILABLE" } });
  });
  it("returns only the bounded analytics projection", async () => {
    const setupData = setup(analytics);
    const response = await handleAdminGet(
      request("?section=analytics&days=7"),
      setupData.deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(analytics);
    expect(setupData.rpc).toHaveBeenCalledWith(
      "admin_get_ai_analytics_v1",
      expect.objectContaining({
        p_environment: "local",
        p_project_ref: "local",
        p_from: expect.any(String),
        p_to: expect.any(String),
      }),
    );
  });
  it("returns the strict runtime control state without list parameters", async () => {
    const setupData = setup(controlState);
    const response = await handleAdminGet(
      request("?section=controls"),
      setupData.deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(controlState);
    expect(setupData.rpc).toHaveBeenCalledWith(
      "admin_get_ai_control_state_v1",
      { p_environment: "local", p_project_ref: "local" },
    );
    expect(
      (await handleAdminGet(request("?section=controls&limit=1"), setupData.deps))
        .status,
    ).toBe(400);
  });
  it("preserves current authorization and environment denials from DB", async () => {
    for (const message of ["FORBIDDEN", "ENVIRONMENT_MISMATCH"]) {
      const { deps } = setup(null, { code: "42501", message });
      const response = await handleAdminGet(request(), deps);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { code: message } });
    }
  });
});

describe("Admin mutation HTTP boundary", () => {
  it("maps a strict membership mutation to the authenticated RPC", async () => {
    const setupData = setup(committed);
    const response = await handleAdminPost(postRequest({
      operation: "membership_set",
      targetUserId: "44444444-4444-4444-8444-444444444444",
      enabled: true,
      expectedRevision: "1",
      reason: "grant reviewed administrator",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    }), setupData.deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(committed);
    expect(setupData.rpc).toHaveBeenCalledWith("admin_set_membership_v1", expect.objectContaining({
      p_target_user_id: "44444444-4444-4444-8444-444444444444",
      p_enabled: true,
      p_expected_revision: "1",
      p_reason: "grant reviewed administrator",
    }));
  });

  it("maps an evidence-bound policy creation without accepting derived hashes", async () => {
    const policyResult = {
      ...committed,
      operationKind: "routing_policy_create",
      result: {
        schemaVersion: "admin_routing_policy_result_v1",
        policyVersionId: "55555555-5555-4555-8555-555555555555",
        policyKey: "weekday.v2",
        version: 2,
        status: "draft",
        configSha256: "a".repeat(64),
        lifecycleAuditId: "66666666-6666-4666-8666-666666666666",
        validationReportIds: ["77777777-7777-4777-8777-777777777777"],
      },
    };
    const setupData = setup(policyResult);
    const rules = {
      schemaVersion: "routing_rules_v1",
      defaultRoute: {
        profileVersionId: "88888888-8888-4888-8888-888888888888",
        priceVersionId: "99999999-9999-4999-8999-999999999999",
      },
      windows: [],
    };
    const response = await handleAdminPost(postRequest({
      operation: "routing_policy_create",
      policyKey: "weekday.v2",
      expectedLatestVersion: "1",
      rules,
      defaultProfileVersionId: "88888888-8888-4888-8888-888888888888",
      legalBundleVersion: "2026-09-04.v1",
      runtimeContractId: "runtime.v3",
      validationReportIds: ["77777777-7777-4777-8777-777777777777"],
      reason: "create reviewed successor policy",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    }), setupData.deps);
    expect(response.status).toBe(200);
    expect(setupData.rpc).toHaveBeenCalledWith(
      "admin_create_routing_policy_v1",
      expect.objectContaining({
        p_policy_key: "weekday.v2",
        p_expected_latest_version: "1",
        p_rules: rules,
        p_validation_report_ids: ["77777777-7777-4777-8777-777777777777"],
      }),
    );
  });

  it("exposes the fixed step-up protocol code", async () => {
    const setupData = setup(null, {
      code: "42501",
      message: "STEP_UP_REQUIRED",
    });
    const response = await handleAdminPost(postRequest({
      operation: "disable_ai",
      expectedControlRevision: "0",
      reason: "disable for maintenance",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    }), setupData.deps);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "STEP_UP_REQUIRED" },
    });
  });

  it.each([
    { operation: "membership_set", targetUserId: "44444444-4444-4444-8444-444444444444", enabled: true, expectedRevision: "1", reason: "x", idempotencyKey: "22222222-2222-4222-8222-222222222222", actor: "forged" },
    { operation: "global_daily_limit_set", globalDailyLimit: 1, expectedGlobalDailyLimit: 0, expectedControlRevision: "0", reason: "x", idempotencyKey: "bad" },
  ])("rejects malformed or extra mutation fields before RPC", async (body) => {
    const setupData = setup(committed);
    const response = await handleAdminPost(postRequest(body), setupData.deps);
    expect(response.status).toBe(400);
    expect(setupData.rpc).not.toHaveBeenCalled();
  });

  it("fails closed when a mutation returns an unexpected shape", async () => {
    const setupData = setup({ ...committed, unexpected: true });
    const response = await handleAdminPost(postRequest({
      operation: "disable_ai",
      expectedControlRevision: "0",
      reason: "disable for maintenance",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    }), setupData.deps);
    expect(response.status).toBe(503);
  });

  it("rejects an operation-kind mismatch from the RPC", async () => {
    const setupData = setup({ ...committed, operationKind: "ai_disable" });
    const response = await handleAdminPost(postRequest({
      operation: "membership_set",
      targetUserId: "44444444-4444-4444-8444-444444444444",
      enabled: true,
      expectedRevision: "1",
      reason: "grant reviewed administrator",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    }), setupData.deps);
    expect(response.status).toBe(503);
  });

  it.each([
    { label: "missing length", contentLength: undefined },
    { label: "understated length", contentLength: 32 },
  ])("bounds a chunked oversized body with $label", async ({ contentLength }) => {
    const setupData = setup(committed);
    const producer = vi.fn();
    const response = await handleAdminPost(
      streamingPostRequest([
        new TextEncoder().encode('{"operation":"validate_runtime_target","padding":"'),
        new Uint8Array(4_096),
        new TextEncoder().encode('"}'),
      ], contentLength),
      { ...setupData.deps, produceValidation: producer },
    );
    expect(response.status).toBe(400);
    expect(setupData.rpc).not.toHaveBeenCalled();
    expect(producer).not.toHaveBeenCalled();
  });

  it("counts multibyte UTF-8 bytes rather than JavaScript characters", async () => {
    const setupData = setup(committed);
    const producer = vi.fn();
    const encoded = new TextEncoder().encode(
      JSON.stringify({ operation: "validate_runtime_target", padding: "界".repeat(1_400) }),
    );
    expect(encoded.byteLength).toBeGreaterThan(4_096);
    const response = await handleAdminPost(
      streamingPostRequest([encoded]),
      { ...setupData.deps, produceValidation: producer },
    );
    expect(response.status).toBe(400);
    expect(setupData.rpc).not.toHaveBeenCalled();
    expect(producer).not.toHaveBeenCalled();
  });
});

describe("Admin validation HTTP boundary", () => {
  it("requires a current Admin session before invoking the trusted producer", async () => {
    const { deps, client, getUser, rpc } = setup();
    const produceValidation = vi.fn().mockResolvedValue(validationReport());
    const response = await handleAdminPost(postRequest(validationRequest), {
      ...deps,
      produceValidation,
    });
    expect(client).toHaveBeenCalledWith(environment, "user-jwt");
    expect(getUser).toHaveBeenCalledWith("user-jwt");
    expect(rpc).toHaveBeenCalledWith("admin_get_context_v1", {
      p_environment: "local",
      p_project_ref: "local",
    });
    expect(produceValidation).toHaveBeenCalledWith({
      reviewedDeploymentId: validationRequest.reviewedDeploymentId,
      runtimeContractId: validationRequest.runtimeContractId,
      runtimeTargetId: validationRequest.runtimeTargetId,
    });
    expect(await response.json()).toMatchObject({
      schemaVersion: "admin_validation_report_v1",
      passed: true,
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("authenticates before parsing and rejects malformed bodies before producer work", async () => {
    for (const body of [
      {},
      { ...validationRequest, unexpected: true },
      { ...validationRequest, runtimeTargetId: "invalid target" },
    ]) {
      const { deps, getUser, rpc } = setup();
      const produceValidation = vi.fn();
      expect(
        (await handleAdminPost(postRequest(body), {
          ...deps,
          produceValidation,
        })).status,
      ).toBe(400);
      expect(getUser).toHaveBeenCalledOnce();
      expect(rpc).not.toHaveBeenCalled();
      expect(produceValidation).not.toHaveBeenCalled();
    }
  });

  it("does not let a denied caller reach the service-role producer", async () => {
    const denied = setup(null, { code: "42501", message: "FORBIDDEN" });
    const produceValidation = vi.fn();
    const response = await handleAdminPost(postRequest(validationRequest), {
      ...denied.deps,
      produceValidation,
    });
    expect(response.status).toBe(403);
    expect(produceValidation).not.toHaveBeenCalled();
  });

  it("rejects unsafe producer output without echoing it", async () => {
    const { deps } = setup();
    const response = await handleAdminPost(postRequest(validationRequest), {
      ...deps,
      produceValidation: vi.fn().mockResolvedValue({
        ...validationReport(),
        credential: "hidden-value",
      }),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("hidden-value");
  });
});

describe("Admin runtime readback HTTP boundary", () => {
  it("authorizes the Admin before invoking the trusted runtime producer", async () => {
    const setupData = setup(context);
    const produceReadback = vi.fn().mockResolvedValue(runtimeReadback());
    const response = await handleAdminPost(postRequest(runtimeReadbackRequest), {
      ...setupData.deps,
      produceReadback,
    });
    expect(response.status).toBe(200);
    expect(setupData.rpc).toHaveBeenCalledWith("admin_get_context_v1", {
      p_environment: "local",
      p_project_ref: "local",
    });
    expect(produceReadback).toHaveBeenCalledWith({
      reviewedDeploymentId: runtimeReadbackRequest.reviewedDeploymentId,
      policyVersionId: runtimeReadbackRequest.policyVersionId,
      validationReportIds: runtimeReadbackRequest.validationReportIds,
    });
    expect(await response.json()).toMatchObject({
      schemaVersion: "admin_runtime_readback_v1",
      policyVersionId: runtimeReadbackRequest.policyVersionId,
    });
  });

  it("rejects malformed or unsafe readback producer output", async () => {
    const setupData = setup(context);
    const invalid = await handleAdminPost(
      postRequest({ ...runtimeReadbackRequest, validationReportIds: [] }),
      { ...setupData.deps, produceReadback: vi.fn() },
    );
    expect(invalid.status).toBe(400);
    const unsafe = await handleAdminPost(postRequest(runtimeReadbackRequest), {
      ...setupData.deps,
      produceReadback: vi.fn().mockResolvedValue({
        ...runtimeReadback(),
        credential: "hidden-value",
      }),
    });
    expect(unsafe.status).toBe(503);
    expect(await unsafe.text()).not.toContain("hidden-value");
  });
});

describe("deployment environment", () => {
  const env = {
    ADMIN_ENVIRONMENT: "local",
    NEXT_PUBLIC_SUPABASE_URL: environment.supabaseUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public",
  };
  it("requires explicit environment and exact local/hosted project identity", () => {
    expect(resolveAdminEnvironment(env).projectRef).toBe("local");
    for (const override of [
      { ADMIN_ENVIRONMENT: undefined },
      { ADMIN_ENVIRONMENT: "production" },
      { VERCEL: "1", VERCEL_ENV: "production" },
      { NEXT_PUBLIC_SUPABASE_URL: "http://localhost:9999" },
      { NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co.attacker.test" },
      { NEXT_PUBLIC_SUPABASE_URL: "http://secret@127.0.0.1:54321" },
    ])
      expect(() => resolveAdminEnvironment({ ...env, ...override })).toThrow();
    expect(
      resolveAdminEnvironment({
        ...env,
        ADMIN_ENVIRONMENT: "preview",
        NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
      }).projectRef,
    ).toBe("abc");
  });
});
