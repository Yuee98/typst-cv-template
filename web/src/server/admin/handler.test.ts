import { describe, expect, it, vi } from "vitest";
import { handleAdminGet, handleAdminPost } from "./handler";
const instance = "00000000-0000-4000-8000-000000000001";
const context = {
  ready: true,
  capabilities: [],
  environment: "LOCAL",
  database_instance_id: instance,
  contract_code: "cv_app_db_1",
  member_id: "adm_0123456789AB",
  aal: "aal1",
  control: {
    enabled: false,
    active_policy_version_id: null,
    audience: "ALLOWLIST",
    generation: "1",
    close_cycle: "1",
    revision: "1",
    user_daily_limit: "20",
    global_daily_limit: "2000",
    user_minute_limit: "3"
  }
};
function deps() {
  const getUser = vi.fn().mockResolvedValue({ data: { user: { id: instance } }, error: null });
  const rpc = vi.fn().mockResolvedValue({
    data: { context, data: null },
    error: null
  });
  return {
    rpc,
    getUser,
    environment: () => ({
      name: "local" as const,
      supabaseUrl: "http://127.0.0.1:54321",
      publishableKey: "public"
    }),
    client: vi.fn(() => ({
      auth: {
        getUser
      },
      rpc
    }))
  };
}
const request = (body: unknown) => new Request("http://localhost/api/admin", {
  method: "POST",
  headers: {
    Authorization: "Bearer token",
    "Content-Type": "application/json"
  },
  body: JSON.stringify(body)
});

describe("single-transaction Admin reads", () => {
  const getRequest = (query: string, signal?: AbortSignal) => new Request(`http://localhost/api/admin?${query}`, {
    headers: { Authorization: "Bearer original-token" }, signal
  });

  it.each([
    ["section=providers", { section: "providers", kind: "providers", limit: 25 }, { records: [], next_cursor: null }],
    ["section=profiles&kind=identities&after=prf_0123456789AB&limit=10", { section: "profiles", kind: "profiles", after: "prf_0123456789AB", limit: 10 }, { records: [], next_cursor: null }],
    ["section=profiles&id=pfv_0123456789AB", { section: "profiles", kind: "profile_versions", external_id: "pfv_0123456789AB" }, { external_id: "pfv_0123456789AB" }],
    ["section=users&id=adm_0123456789AB", { section: "users", kind: "members", external_id: "adm_0123456789AB" }, { external_id: "adm_0123456789AB" }],
    ["section=analytics&days=14", { section: "analytics", days: 14 }, { usage: [] }],
    ["section=controls", { section: "controls" }, null],
  ])("%s verifies the bearer once and executes only one read RPC", async (query, fields, payload) => {
    const d = deps();
    d.rpc.mockResolvedValue({ data: { context, data: payload }, error: null });
    const req = getRequest(query);
    const response = await handleAdminGet(req, d as never);
    expect(response.status).toBe(200);
    expect(d.client).toHaveBeenCalledWith(expect.anything(), "original-token", req.signal);
    expect(d.getUser).toHaveBeenCalledExactlyOnceWith("original-token");
    expect(d.rpc).toHaveBeenCalledExactlyOnceWith("admin_read", { p_input: {
      ...fields, contract_code: "cv_app_db_1", expected_environment: "LOCAL"
    } });
    expect(await response.json()).toEqual({ context, data: payload });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Authorization");
  });

  it("binds warm reads to the existing database instance", async () => {
    const d = deps();
    await handleAdminGet(getRequest(`section=overview&database_instance_id=${instance}`), d as never);
    expect(d.rpc).toHaveBeenCalledWith("admin_read", { p_input: {
      section: "overview", database_instance_id: instance, contract_code: "cv_app_db_1", expected_environment: "LOCAL"
    } });
  });

  it.each([
    "section=overview&section=users", "section=overview&limit=25", "section=controls&kind=members",
    "section=analytics&kind=versions", "section=users&kind=versions", "section=providers&kind=identities",
    "section=profiles&id=pfv_0123456789AB&after=cursor", "section=profiles&id=pfv_0123456789AB&limit=25",
    "section=users&after=", "section=users&limit=0", "section=users&limit=101", "section=users&limit=01",
    "section=analytics&days=0", "section=analytics&days=32", "section=analytics&days=7.5",
    "section=overview&database_instance_id=", "section=overview&database_instance_id=not-a-uuid",
    "section=unknown", "section=providers&id=wrong", "section=users&unexpected=1"
  ])("rejects unsupported query %s before the database RPC", async query => {
    const d = deps();
    const response = await handleAdminGet(getRequest(query), d as never);
    expect(response.status).toBe(400);
    expect(d.rpc).not.toHaveBeenCalled();
  });

  it.each(["environment", "instance"])("fails closed on an unexpected response %s", async field => {
    const d = deps();
    d.rpc.mockResolvedValue({ data: { context: {
      ...context, ...(field === "environment" ? { environment: "PRODUCTION" } : { database_instance_id: "00000000-0000-4000-8000-000000000099" })
    }, data: null }, error: null });
    const response = await handleAdminGet(getRequest(`section=overview&database_instance_id=${instance}`), d as never);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "CLIENT_UPDATE_REQUIRED" } });
  });

  it.each([context, { context, data: [] }, { context: { ...context, legal: {} }, data: null }, { context, data: { wrong: true } }])("rejects old or malformed read output", async data => {
    const d = deps();
    d.rpc.mockResolvedValue({ data, error: null });
    const response = await handleAdminGet(getRequest("section=providers"), d as never);
    expect(response.status).toBe(503);
  });

  it("does not send a database read after the initiating request was cancelled during Auth", async () => {
    const d = deps(), controller = new AbortController();
    let finish!: (value: unknown) => void;
    d.getUser.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = handleAdminGet(getRequest("section=providers", controller.signal), d as never);
    controller.abort();
    finish({ data: { user: { id: instance } }, error: null });
    await pending;
    expect(d.rpc).not.toHaveBeenCalled();
  });
});
describe("admin HTTP boundary", () => {
  it("requires verified bearer authentication", async () => {
    const d = deps();
    expect((await handleAdminGet(new Request("http://localhost/api/admin"), d as never)).status).toBe(401);
    expect(d.rpc).not.toHaveBeenCalled();
  });
  it("reads the sole current context and caches no private data", async () => {
    const d = deps();
    const response = await handleAdminGet(new Request("http://localhost/api/admin?section=overview", {
      headers: {
        Authorization: "Bearer token"
      }
    }), d as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(d.rpc).toHaveBeenCalledWith("admin_read", { p_input: { section: "overview", contract_code: "cv_app_db_1", expected_environment: "LOCAL" } });
    expect(await response.json()).toEqual({ context, data: null });
  });
  it("rejects old commands and client-supplied producer reports", async () => {
    const d = deps();
    for (const body of [{
      operation: "disable_ai"
    }, {
      operation: "validate",
      passed: true
    }]) expect((await handleAdminPost(request(body), d as never)).status).toBe(400);
    expect(d.rpc).not.toHaveBeenCalled();
  });
  it("passes only validated current write fields and propagates step-up", async () => {
    const d = deps();
    d.rpc.mockResolvedValueOnce({
      data: context,
      error: null
    }).mockResolvedValue({
      data: null,
      error: {
        message: "STEP_UP_REQUIRED"
      }
    });
    const response = await handleAdminPost(request({
      operation: "admin_ai_disable",
      contract_code: "cv_app_db_1",
      database_instance_id: instance,
      operation_key: instance,
      reason: "emergency",
      expected_revision: "9007199254740993"
    }), d as never);
    expect(response.status).toBe(403);
    expect(d.rpc).toHaveBeenCalledWith("admin_ai_disable", {
      p_input: {
        contract_code: "cv_app_db_1",
        database_instance_id: instance,
        operation_key: instance,
        reason: "emergency",
        expected_revision: "9007199254740993"
      }
    });
  });
  it("rejects stale instance before invoking a privileged producer", async () => {
    const d = deps();
    d.rpc.mockResolvedValue({ data: context, error: null });
    const producer = vi.fn();
    const response = await handleAdminPost(request({
      operation: "validate",
      contract_code: "cv_app_db_1",
      database_instance_id: "00000000-0000-4000-8000-000000000099",
      target_kind: "POLICY",
      target_id: "plv_0123456789AB"
    }), {
      ...d,
      produceValidation: producer
    } as never);
    expect(response.status).toBe(409);
    expect(producer).not.toHaveBeenCalled();
  });
  it("rejects a deployment environment mismatch before an Admin write", async () => {
    const d = deps();
    d.rpc.mockResolvedValue({
      data: {
        ...context,
        environment: "PRODUCTION"
      },
      error: null
    });
    const response = await handleAdminPost(request({
      operation: "admin_ai_disable",
      contract_code: "cv_app_db_1",
      database_instance_id: instance,
      operation_key: instance,
      reason: "emergency",
      expected_revision: "1"
    }), d as never);
    expect(response.status).toBe(409);
    expect(d.rpc).toHaveBeenCalledTimes(1);
    expect(d.rpc).toHaveBeenCalledWith("admin_context");
  });
  it("lists administrator memberships with current revisions for grant and revoke", async () => {
    const d = deps();
    d.rpc.mockResolvedValue({
      data: { context, data: {
        records: [{
          external_id: "adm_0123456789AB",
          auth_user_id: instance,
          revision: "7",
          time_revoked: null
        }],
        next_cursor: null
      } },
      error: null
    });
    const response = await handleAdminGet(new Request("http://localhost/api/admin?section=users&kind=members", {
      headers: {
        Authorization: "Bearer token"
      }
    }), d as never);
    expect(response.status).toBe(200);
    expect(d.rpc).toHaveBeenCalledWith("admin_read", { p_input: { section: "users", kind: "members", limit: 25, contract_code: "cv_app_db_1", expected_environment: "LOCAL" } });
  });
});
