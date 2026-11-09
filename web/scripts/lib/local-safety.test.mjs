import { describe, expect, it } from "vitest";

import { checkLocalSupabaseUrl } from "./local-safety.mjs";

describe("checkLocalSupabaseUrl", () => {
  it("rejects a hosted Supabase project URL", () => {
    const result = checkLocalSupabaseUrl("https://example.supabase.co");
    expect(result.ok).toBe(false);
  });

  it("rejects loopback over https (local Supabase is plain http)", () => {
    expect(checkLocalSupabaseUrl("https://127.0.0.1:54321").ok).toBe(false);
    expect(checkLocalSupabaseUrl("https://localhost").ok).toBe(false);
  });

  it("rejects arbitrary LAN hosts", () => {
    for (const url of [
      "http://192.168.1.10:54321",
      "http://10.0.0.5",
      "http://172.16.0.2:54321",
      "http://supabase.internal",
    ]) {
      expect(checkLocalSupabaseUrl(url).ok).toBe(false);
    }
  });

  it("rejects malformed URLs", () => {
    for (const url of ["", "not-a-url", "http://", "://127.0.0.1", "54321"]) {
      expect(checkLocalSupabaseUrl(url).ok).toBe(false);
    }
  });

  it("accepts the configured local Supabase URLs", () => {
    for (const url of [
      "http://127.0.0.1:54321",
      "http://localhost:54321",
      "http://[::1]:54321",
    ]) {
      expect(checkLocalSupabaseUrl(url).ok).toBe(true);
    }
  });
});
