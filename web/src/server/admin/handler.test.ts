import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { AdminConfigurationValidationError, handleAdminGet, handleAdminPost, validateAdminConfiguration } from "./handler";
const instance = "00000000-0000-4000-8000-000000000001",
  key = "00000000-0000-4000-8000-000000000002";
const context = {
  ready: true,
  contract_code: "cv_app_db_2",
  database_instance_id: instance,
  environment: "LOCAL",
  member_id: "1",
  control: {
    enabled: false,
    audience: "ALLOWLIST",
    revision: "1",
    user_daily_limit: "20",
    global_daily_limit: "2000",
    user_minute_limit: "3"
  },
  capabilities: {
    cv_schema_version: 7,
    encrypted_envelope_version: 1
  }
};
const price = {
  currency: "USD",
  input_standard_nanos_per_million: "1000000000",
  input_cache_read_nanos_per_million: "0",
  input_cache_write_nanos_per_million: "0",
  output_nanos_per_million: "2000000000"
};
const configuration = {
  id: "1",
  revision: "1",
  name: "Reviewed service",
  adapter_id: 1,
  endpoint_url: "https://api.example.test/responses",
  model_id: "model-a",
  credential_ref: "AI_PROVIDER_KEY_TEST",
  legal_document_id: "3",
  enabled: false,
  price
};
const base = {
  contract_code: "cv_app_db_2",
  database_instance_id: instance,
  operation_key: key,
  reason: "Save configuration"
};
const rpc = vi.fn(),
  getUser = vi.fn(),
  validateConfiguration = vi.fn();
const deps = {
  environment: () => ({
    name: "local",
    supabaseUrl: "http://127.0.0.1:54321",
    publishableKey: "public"
  }),
  client: () => ({
    auth: {
      getUser
    },
    rpc
  }),
  validateConfiguration
};
const request = (path = "section=controls") => new Request(`http://local.test/api/admin?${path}`, {
  headers: {
    Authorization: "Bearer user-token"
  }
});
const post = (body: unknown) => new Request("http://local.test/api/admin", {
  method: "POST",
  headers: {
    Authorization: "Bearer user-token",
    "Content-Type": "application/json"
  },
  body: JSON.stringify(body)
});
beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({
    data: {
      user: {
        id: key
      }
    },
    error: null
  });
  validateConfiguration.mockResolvedValue(undefined);
  rpc.mockImplementation(async (name: string) => name === "admin_context" ? {
    data: context,
    error: null
  } : {
    data: {
      context,
      data: null
    },
    error: null
  });
});
describe("single-read Admin BFF", () => {
  it("combines live Auth and one read while returning private no-store", async () => {
    const result = await handleAdminGet(request(), deps as never);
    expect(result.status).toBe(200);
    expect(getUser).toHaveBeenCalledExactlyOnceWith("user-token");
    expect(rpc).toHaveBeenCalledExactlyOnceWith("admin_read", {
      p_input: {
        section: "controls",
        contract_code: "cv_app_db_2",
        expected_environment: "LOCAL"
      }
    });
    expect(result.headers.get("cache-control")).toContain("no-store");
  });
  it("binds warm reads to the instance", async () => {
    await handleAdminGet(request(`section=controls&database_instance_id=${instance}`), deps as never);
    expect(rpc.mock.calls[0][1].p_input.database_instance_id).toBe(instance);
  });
  it.each(["section=profiles", "section=configurations&kind=versions", "section=configurations&limit=101", "section=controls&section=users", "section=controls&passed=true", "section=usage&kind=analytics&days=91", "section=configurations&id=pfv_111111111111"])("rejects invalid query %s", async query => {
    expect((await handleAdminGet(request(query), deps as never)).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("validates complete configuration aggregates on reads", async () => {
    rpc.mockResolvedValue({
      data: {
        context,
        data: {
          records: [configuration],
          next_cursor: null
        }
      },
      error: null
    });
    const result = await handleAdminGet(request("section=configurations"), deps as never);
    expect(result.status).toBe(200);
    expect((await result.json()).data.records[0].price).toEqual(price);
  });
  it("fails closed on wrong environment or malformed configuration", async () => {
    rpc.mockResolvedValueOnce({
      data: {
        context: {
          ...context,
          environment: "PRODUCTION"
        },
        data: null
      },
      error: null
    });
    expect((await handleAdminGet(request(), deps as never)).status).toBe(409);
    rpc.mockResolvedValueOnce({
      data: {
        context,
        data: {
          records: [{
            ...configuration,
            price: {}
          }],
          next_cursor: null
        }
      },
      error: null
    });
    expect((await handleAdminGet(request("section=configurations"), deps as never)).status).toBe(503);
  });
  it("does not reach the database after canceled or rejected Auth", async () => {
    getUser.mockResolvedValue({
      data: {
        user: null
      },
      error: new Error("no")
    });
    expect((await handleAdminGet(request(), deps as never)).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
});
describe("atomic current-row mutations", () => {
  it("passes config and price together after non-paid endpoint/credential checks", async () => {
    const fields = {
      ...configuration
    };
    delete (fields as Partial<typeof configuration>).revision;
    rpc.mockImplementation(async (name: string) => name === "admin_context" ? {
      data: context,
      error: null
    } : {
      data: {
        operation_id: "10",
        operation: "configuration_save",
        entity_kind: "configurations",
        entity_id: "1",
        revision: "2",
        time_committed: "2026-11-08T00:00:00Z"
      },
      error: null
    });
    const body = {
      ...base,
      operation: "admin_configuration_save",
      ...fields,
      expected_revision: "1"
    };
    const result = await handleAdminPost(post(body), deps as never);
    expect(result.status).toBe(200);
    expect(validateConfiguration).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls.at(-1)).toEqual(["admin_configuration_save", {
      p_input: {
        ...base,
        ...fields,
        expected_revision: "1"
      }
    }]);
  });
  it("rejects stale instance before validation and mutation", async () => {
    const result = await handleAdminPost(post({
      ...base,
      database_instance_id: key,
      operation: "admin_ai_disable",
      expected_revision: "1"
    }), deps as never);
    expect(result.status).toBe(409);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(validateConfiguration).not.toHaveBeenCalled();
  });
  it.each([["FORBIDDEN", 403], ["CONFLICT", 409]] as const)("propagates live refusal %s", async (code, status) => {
    rpc.mockImplementation(async (name: string) => name === "admin_context" ? {
      data: context,
      error: null
    } : {
      data: null,
      error: {
        message: code
      }
    });
    expect((await handleAdminPost(post({
      ...base,
      operation: "admin_ai_disable",
      expected_revision: "1"
    }), deps as never)).status).toBe(status);
  });
  it("does not write if the selected key or endpoint fails validation", async () => {
    validateConfiguration.mockRejectedValue(new Error("Selected credential unavailable"));
    const fields = {
      ...configuration
    };
    delete (fields as Partial<typeof configuration>).revision;
    expect((await handleAdminPost(post({
      ...base,
      operation: "admin_configuration_save",
      ...fields,
      expected_revision: "1"
    }), deps as never)).status).toBe(400);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it.each([1, 2, 3])("explains an unavailable credential reference for adapter %s without writing", async adapter_id => {
    vi.stubEnv("AI_PROVIDER_KEY_G", "");
    try {
      const fields = { ...configuration };
      delete (fields as Partial<typeof configuration>).revision;
      const result = await handleAdminPost(post({
        ...base,
        operation: "admin_configuration_save",
        ...fields,
        adapter_id,
        credential_ref: "AI_PROVIDER_KEY_G",
        expected_revision: "1"
      }), { ...deps, validateConfiguration: undefined } as never);
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({ error: { code: "INVALID_REQUEST", reason: "CREDENTIAL_UNAVAILABLE" } });
      expect(rpc).toHaveBeenCalledExactlyOnceWith("admin_context");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("rejects former publish/report commands rather than keeping compatibility", async () => {
    expect((await handleAdminPost(post({
      ...base,
      operation: "admin_profile_version_publish",
      passed: true
    }), deps as never)).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});
describe("safe configuration validation reasons", () => {
  const selected = {
    adapter_id: 3 as const,
    endpoint_url: "https://generativelanguage.googleapis.com/v1/interactions",
    model_id: "gemini-3.8-flash",
    credential_ref: "AI_PROVIDER_KEY_GEMINI_LOCAL"
  };
  const env = { AI_PROVIDER_KEY_GEMINI_LOCAL: "synthetic-key-not-transmitted" };
  it("validates a configured credential and resolves the checked endpoint without inference", async () => {
    const resolve = vi.fn().mockResolvedValue({});
    const signal = new AbortController().signal;
    await validateAdminConfiguration(selected, signal, env, resolve);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(selected.endpoint_url, undefined, signal);
  });
  it("distinguishes an invalid destination from unavailable DNS", async () => {
    const resolve = vi.fn().mockRejectedValue(new Error("Internal resolver details must stay private"));
    const signal = new AbortController().signal;
    await expect(validateAdminConfiguration({ ...selected, endpoint_url: "https://127.0.0.1/inference" }, signal, env, resolve)).rejects.toMatchObject({ reason: "ENDPOINT_INVALID" });
    expect(resolve).not.toHaveBeenCalled();
    await expect(validateAdminConfiguration(selected, signal, env, resolve)).rejects.toMatchObject({ reason: "ENDPOINT_UNREACHABLE", message: "ENDPOINT_UNREACHABLE" });
  });
  it.each(["CREDENTIAL_UNAVAILABLE", "ENDPOINT_INVALID", "ENDPOINT_UNREACHABLE"] as const)("returns only the public reason %s", async reason => {
    validateConfiguration.mockRejectedValue(new AdminConfigurationValidationError(reason));
    const fields = { ...configuration };
    delete (fields as Partial<typeof configuration>).revision;
    const result = await handleAdminPost(post({ ...base, operation: "admin_configuration_save", ...fields, expected_revision: "1" }), deps as never);
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ error: { code: "INVALID_REQUEST", reason } });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("admin_context");
  });
  it("does not expose an arbitrary validation exception", async () => {
    validateConfiguration.mockRejectedValue(new Error("private-key-and-transport-details"));
    const fields = { ...configuration };
    delete (fields as Partial<typeof configuration>).revision;
    const result = await handleAdminPost(post({ ...base, operation: "admin_configuration_save", ...fields, expected_revision: "1" }), deps as never);
    expect(await result.json()).toEqual({ error: { code: "INVALID_REQUEST" } });
  });
});
