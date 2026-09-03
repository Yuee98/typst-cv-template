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
const postRequest = (body: unknown, token = "user-jwt") =>
  new Request("https://site.test/api/admin", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

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
  it("preserves current authorization and environment denials from DB", async () => {
    for (const message of ["FORBIDDEN", "ENVIRONMENT_MISMATCH"]) {
      const { deps } = setup(null, { code: "42501", message });
      const response = await handleAdminGet(request(), deps);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { code: message } });
    }
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

  it("rejects malformed bodies before auth or producer work", async () => {
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
      expect(getUser).not.toHaveBeenCalled();
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
