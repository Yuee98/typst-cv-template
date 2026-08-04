/**
 * Unit tests for the smoke's pure safety predicates (CP4 round-1 P0-1 /
 * P0-2.3): the guards that keep the real-key smoke off hosted projects and
 * on the official DeepSeek origin must themselves be proven.
 */

import { describe, expect, it } from "vitest";

import {
  checkLocalSupabaseUrl,
  isOfficialDeepSeekBaseUrl,
  OFFICIAL_DEEPSEEK_ORIGIN,
} from "./local-safety.mjs";

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

describe("isOfficialDeepSeekBaseUrl", () => {
  it("accepts the official origin (with trailing slash or sub-path)", () => {
    expect(isOfficialDeepSeekBaseUrl(OFFICIAL_DEEPSEEK_ORIGIN)).toBe(true);
    expect(isOfficialDeepSeekBaseUrl("https://api.deepseek.com/")).toBe(true);
    expect(isOfficialDeepSeekBaseUrl("https://api.deepseek.com/v1")).toBe(true);
  });

  it("rejects proxies, mocks, and lookalike hosts", () => {
    for (const url of [
      "http://localhost:9999",
      "http://127.0.0.1:8080",
      "https://api.deepseek.com.evil.example",
      "http://api.deepseek.com", // plain http is not the official origin
      "https://deepseek-proxy.internal",
      "not-a-url",
    ]) {
      expect(isOfficialDeepSeekBaseUrl(url)).toBe(false);
    }
  });
});
