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
  },
  legal: {}
};
function deps() {
  const rpc = vi.fn().mockResolvedValue({
    data: context,
    error: null
  });
  return {
    rpc,
    environment: () => ({
      name: "local" as const,
      supabaseUrl: "http://127.0.0.1:54321",
      publishableKey: "public"
    }),
    client: () => ({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: {
            user: {
              id: instance
            }
          },
          error: null
        })
      },
      rpc
    })
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
    expect(d.rpc).toHaveBeenCalledWith("admin_context");
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
      data: {
        records: [{
          external_id: "adm_0123456789AB",
          auth_user_id: instance,
          revision: "7",
          time_revoked: null
        }],
        next_cursor: null
      },
      error: null
    });
    const response = await handleAdminGet(new Request("http://localhost/api/admin?section=users&kind=members", {
      headers: {
        Authorization: "Bearer token"
      }
    }), d as never);
    expect(response.status).toBe(200);
    expect(d.rpc).toHaveBeenCalledWith("admin_records", {
      p_kind: "members",
      p_limit: 25,
      p_after: undefined
    });
  });
});
