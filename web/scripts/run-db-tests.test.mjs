import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { runDbTests, validateLocalDatabaseUrl } from "./run-db-tests.mjs";

const GOOD_STATUS = [
  'API_URL="http://127.0.0.1:54321"',
  'PUBLISHABLE_KEY="publishable-test-key"',
  'SECRET_KEY="secret-test-key"',
].join("\n");

function harness({ env = {}, results = [], fetchImpl = async () => new Response() } = {}) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    run() {
      return runDbTests({
        env,
        fetchImpl,
        logger: (message) => logs.push(message),
        spawnSyncImpl(command, args, options) {
          calls.push({ command, args, options });
          return results.shift() ?? { status: 0, stdout: GOOD_STATUS };
        },
      });
    },
  };
}

it("required mode fails status, spawn, and timeout errors", async () => {
  for (const result of [
    { status: 1 },
    { error: new Error("ENOENT"), status: null },
    { error: new Error("ETIMEDOUT"), signal: "SIGTERM", status: null },
  ]) {
    const subject = harness({ env: { DB_TESTS_REQUIRED: "1" }, results: [result] });
    expect(await subject.run()).toBe(1);
    expect(subject.calls).toHaveLength(1);
    expect(subject.logs.join("\n")).toMatch(/ERROR/);
  }
});

it("required mode fails malformed CLI status without logging keys", async () => {
  const subject = harness({
    env: { DB_TESTS_REQUIRED: "1" },
    results: [{ status: 0, stdout: 'API_URL="http://127.0.0.1:54321"\nSECRET_KEY="secret-value"' }],
  });
  expect(await subject.run()).toBe(1);
  expect(subject.calls).toHaveLength(1);
  expect(subject.logs.join("\n")).not.toMatch(/secret-value/);
});

it("required mode fails partial explicit credentials", async () => {
  const subject = harness({
    env: { DB_TESTS_REQUIRED: "1", SUPABASE_TEST_URL: "http://127.0.0.1:54321" },
  });
  expect(await subject.run()).toBe(1);
  expect(subject.calls).toHaveLength(0);
});

it("required mode fails an unreachable local API before Vitest", async () => {
  const subject = harness({
    env: { DB_TESTS_REQUIRED: "1" },
    results: [{ status: 0, stdout: GOOD_STATUS }],
    fetchImpl: async () => {
      throw new Error("connection refused");
    },
  });
  expect(await subject.run()).toBe(1);
  expect(subject.calls).toHaveLength(1);
});

it("hosted and credential-bearing URLs are rejected before Vitest", async () => {
  for (const url of ["https://example.supabase.co", "http://key:secret@127.0.0.1:54321"]) {
    const subject = harness({
      env: {
        SUPABASE_TEST_URL: url,
        SUPABASE_TEST_PUBLISHABLE_KEY: "publishable-test-key",
        SUPABASE_TEST_SECRET_KEY: "secret-test-key",
      },
    });
    expect(await subject.run(), url).toBe(1);
    expect(subject.calls, url).toHaveLength(0);
    expect(subject.logs.join("\n")).not.toMatch(/secret-test-key|key:secret/);
  }
});

it("optional developer invocation still skips unavailable Supabase", async () => {
  const subject = harness({ results: [{ error: new Error("ENOENT"), status: null }] });
  expect(await subject.run()).toBe(0);
  expect(subject.logs.join("\n")).toMatch(/SKIP/);
});

it("valid loopback launches ordinary DB config and clears fresh-reset selector", async () => {
  const subject = harness({
    env: { CFG001_FRESH_RESET: "1" },
    results: [{ status: 0, stdout: GOOD_STATUS }, { status: 0 }],
  });
  expect(await subject.run()).toBe(0);
  expect(subject.calls[1].args).toEqual(["exec", "vitest", "run", "--config", "vitest.db.config.mts"]);
  expect(subject.calls[1].options.env.CFG001_FRESH_RESET).toBeUndefined();
  expect(subject.calls[1].options.env.SUPABASE_TEST_URL).toBe("http://127.0.0.1:54321/");
});

it("Vitest spawn errors, signals, and exit failures always propagate", async () => {
  for (const result of [
    { error: new Error("spawn failed"), status: null },
    { signal: "SIGTERM", status: null },
    { status: 7 },
  ]) {
    const subject = harness({ results: [{ status: 0, stdout: GOOD_STATUS }, result] });
    expect(await subject.run()).toBe(result.status === 7 ? 7 : 1);
  }
});

it("URL guard accepts only HTTP loopback endpoints", () => {
  expect(validateLocalDatabaseUrl("http://localhost:54321").ok).toBe(true);
  expect(validateLocalDatabaseUrl("http://[::1]:54321").ok).toBe(true);
  expect(validateLocalDatabaseUrl("ftp://127.0.0.1").ok).toBe(false);
  expect(validateLocalDatabaseUrl("http://10.0.0.2").ok).toBe(false);
});

it("DB workflow runs the credential-free runner contract before real-DB mutation", async () => {
  // This test is part of the ordinary `pnpm test` suite as well as the
  // dedicated workflow step. Keeping the workflow assertion here means a
  // future removal of that step is caught by the normal CI gate rather than
  // silently dropping nine runner-level safety checks.
  const workflowPath = fileURLToPath(new URL("../../.github/workflows/db-tests.yml", import.meta.url));
  const workflow = await readFile(workflowPath, "utf8");
  expect(workflow).toContain('      - "web/scripts/run-db-tests.test.mjs"');
  const runnerStep = [
    "      - name: Verify DB test runner contract (credential-free)",
    "        run: pnpm --filter web exec vitest run scripts/run-db-tests.test.mjs",
  ].join("\n");

  const runnerStepIndex = workflow.indexOf(runnerStep);
  const supabaseStartIndex = workflow.indexOf("      - name: Start local Supabase");
  expect(runnerStepIndex).toBeGreaterThan(-1);
  expect(supabaseStartIndex).toBeGreaterThan(runnerStepIndex);
});
