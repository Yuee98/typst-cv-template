import { COMPILED_CAPABILITIES } from "../ai/provider";
import { describe, expect, it, vi } from "vitest";
import { produceAdminValidationReport } from "./validation-service";
const instance = "00000000-0000-4000-8000-000000000001";
const env = {
  ADMIN_ENVIRONMENT: "local",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public",
  AI_PROVIDER_KEY_DEEPSEEK_PRIMARY: "not-a-real-key"
};
const profile = {
  provider_code: "DEEPSEEK",
  capability: {
    code: "DEEPSEEK_RESPONSES",
    adapter_kind: "deepseek_responses_v1",
    wire_api_kind: "responses_v1",
    execution_contract: "cv_polish_1",
    calculator_kind: "linear_token_v1",
    cache_policy: "automatic",
    descriptor_digest: COMPILED_CAPABILITIES.DEEPSEEK.descriptor_digest
  },
  endpoint_url: "https://api.deepseek.com/responses",
  credential_ref: "AI_PROVIDER_KEY_DEEPSEEK_PRIMARY",
  model_id: "configured-model",
  adapter_config: {
    reasoningEffort: "none",
    structuredOutput: "json_object",
    providerSubjectField: "user"
  },
  config_digest: "b".repeat(64)
};
const target = {
  target_kind: "POLICY" as const,
  target_id: "plv_0123456789AB",
  database_instance_id: instance
};
const candidate = {
  ...target,
  passed: true,
  reasons: [],
  environment: "LOCAL",
  dependency_digest: "c".repeat(64),
  data: {
    profiles: [profile]
  }
};
const report = {
  external_id: "val_0123456789AB",
  target_kind: "POLICY",
  target_id: target.target_id,
  dependency_digest: candidate.dependency_digest,
  passed: true,
  reasons: [],
  time_checked: new Date().toISOString(),
  time_expires: new Date(Date.now() + 120000).toISOString()
};
describe("configuration validation producer", () => {
  it("checks every candidate and records only server observations", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({
      data: candidate,
      error: null
    }).mockResolvedValueOnce({
      data: report,
      error: null
    });
    const result = await produceAdminValidationReport(target, {
      environment: env,
      client: {
        rpc
      }
    });
    expect(result.passed).toBe(true);
    expect(rpc.mock.calls[1][1].p_input).toEqual({
      ...target,
      contract_code: "cv_app_db_1",
      dependency_digest: candidate.dependency_digest,
      passed: true,
      reasons: []
    });
  });
  it("records an unavailable nondefault candidate as failed without transmission", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({
      data: {
        ...candidate,
        data: {
          profiles: [profile, {
            ...profile,
            credential_ref: "AI_PROVIDER_KEY_MIMO_OTHER"
          }]
        }
      },
      error: null
    }).mockResolvedValueOnce({
      data: {
        ...report,
        passed: false,
        reasons: ["PROVIDER_CONFIGURATION_INVALID"]
      },
      error: null
    });
    expect((await produceAdminValidationReport(target, {
      environment: env,
      client: {
        rpc
      }
    })).passed).toBe(false);
  });
  it("rejects reports bound to a different dependency set", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({
      data: candidate,
      error: null
    }).mockResolvedValueOnce({
      data: {
        ...report,
        dependency_digest: "d".repeat(64)
      },
      error: null
    });
    await expect(produceAdminValidationReport(target, {
      environment: env,
      client: {
        rpc
      }
    })).rejects.toThrow();
  });
  it("rejects an environment or instance mismatch before recording evidence", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        ...candidate,
        environment: "PRODUCTION"
      },
      error: null
    });
    await expect(produceAdminValidationReport(target, {
      environment: env,
      client: {
        rpc
      }
    })).rejects.toThrow();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
