import { describe, expect, it, vi } from "vitest";
import { produceAdminRuntimeReadback } from "./readback-service";
const instance = "00000000-0000-4000-8000-000000000001";
const environment = {
  ADMIN_ENVIRONMENT: "local",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public"
};
describe("runtime readback producer", () => {
  it("cannot approve an empty candidate set", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        database_instance_id: instance,
        environment: "LOCAL",
        dependency_digest: "a".repeat(64),
        target_id: "plv_0123456789AB",
        passed: true,
        reasons: [],
        data: {
          profiles: []
        }
      },
      error: null
    });
    await expect(produceAdminRuntimeReadback({
      database_instance_id: instance
    }, {
      environment,
      client: {
        rpc
      }
    })).rejects.toThrow();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("rejects stale instances before recording a report", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        database_instance_id: "00000000-0000-4000-8000-000000000002",
        environment: "LOCAL",
        dependency_digest: "a".repeat(64),
        target_id: "plv_0123456789AB",
        passed: true,
        reasons: [],
        data: {
          profiles: [{}]
        }
      },
      error: null
    });
    await expect(produceAdminRuntimeReadback({
      database_instance_id: instance
    }, {
      environment,
      client: {
        rpc
      }
    })).rejects.toThrow();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
