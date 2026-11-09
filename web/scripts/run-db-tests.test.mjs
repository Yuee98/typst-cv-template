import { expect, it, vi } from "vitest";
import { parseSupabaseStatus, runDbTests, validateLocalDatabaseUrl } from "./run-db-tests.mjs";

it.each(["https://example.supabase.co", "http://192.168.1.1", "http://user:pass@localhost", "file:///tmp/db"])("refuses unsafe database endpoint %s", url => {
  expect(validateLocalDatabaseUrl(url).ok).toBe(false);
});
it("accepts loopback HTTP only", () => {
  expect(validateLocalDatabaseUrl("http://127.0.0.1:54321").ok).toBe(true);
  expect(validateLocalDatabaseUrl("http://[::1]:54321").ok).toBe(true);
});
it("does not execute tests with hosted credentials", async () => {
  const spawnSyncImpl = vi.fn();
  const code = await runDbTests({ env: { SUPABASE_TEST_URL: "https://test.supabase.co", SUPABASE_TEST_PUBLISHABLE_KEY: "test", SUPABASE_TEST_SECRET_KEY: "test" }, spawnSyncImpl, logger: () => {} });
  expect(code).toBe(1); expect(spawnSyncImpl).not.toHaveBeenCalled();
});
it("fails required mode if local runtime is unavailable", async () => {
  expect(await runDbTests({ env: { DB_TESTS_REQUIRED: "1" }, spawnSyncImpl: () => ({ status: 1 }), logger: () => {} })).toBe(1);
});
it("rejects duplicate or incomplete status instead of guessing keys", () => {
  expect(parseSupabaseStatus('API_URL="http://localhost"\nAPI_URL="http://localhost"')).toBeNull();
});
