import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerAdminClient } from "./admin-client";
import { createServerAuthClient } from "./auth-client";

const SUPABASE_URL = "https://example.supabase.co";

function stubBaseEnv() {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createServerAuthClient", () => {
  it("fails loud when NEXT_PUBLIC_SUPABASE_URL is missing", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
    expect(() => createServerAuthClient()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("fails loud when NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is missing", () => {
    stubBaseEnv();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    expect(() => createServerAuthClient()).toThrow(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  });

  it("creates a client when the env is present", () => {
    stubBaseEnv();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
    expect(createServerAuthClient()).toBeDefined();
  });
});

describe("createServerAdminClient", () => {
  it("fails loud when NEXT_PUBLIC_SUPABASE_URL is missing", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
    expect(() => createServerAdminClient()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("fails loud when SUPABASE_SERVICE_ROLE_KEY is missing", () => {
    stubBaseEnv();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(() => createServerAdminClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("creates a client when the env is present", () => {
    stubBaseEnv();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
    expect(createServerAdminClient()).toBeDefined();
  });
});
