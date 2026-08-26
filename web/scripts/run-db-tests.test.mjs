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
  const normalConfigPath = fileURLToPath(new URL("../vitest.config.mts", import.meta.url));
  const [workflow, normalConfig] = await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(normalConfigPath, "utf8"),
  ]);

  // The normal unit-test config must continue discovering this file, while
  // the dedicated workflow must run it before any Docker-backed mutation.
  expect(normalConfig).toMatch(/include:\s*\[[^\]]*"scripts\/\*\*\/\*.test\.mjs"/s);

  const stepsStart = workflow.search(/^    steps:\r?$/m);
  expect(stepsStart).toBeGreaterThanOrEqual(0);
  const stepBlocks = workflow
    .slice(stepsStart)
    .replace(/^    steps:\r?\n/, "")
    .split(/(?=^      - name: )/m)
    .filter((block) => block.startsWith("      - name: "));
  expect(stepBlocks).not.toHaveLength(0);

  const steps = stepBlocks.map((block) => {
    const lines = block.split(/\r?\n/);
    const name = /^      - name: (.+)$/.exec(lines[0])?.[1];
    const uses = lines.find((line) => /^        uses: /.test(line))?.slice("        uses: ".length);
    const run = lines.find((line) => /^        run: /.test(line))?.slice("        run: ".length);
    return { name, uses, run, block };
  });

  const runnerName = "Verify DB test runner contract (credential-free)";
  const runnerCommand = "pnpm --filter web exec vitest run scripts/run-db-tests.test.mjs";
  const runnerIndexes = steps
    .map((step, index) => (step.name === runnerName ? index : -1))
    .filter((index) => index >= 0);
  expect(runnerIndexes).toHaveLength(1);

  const runnerIndex = runnerIndexes[0];
  const runnerStep = steps[runnerIndex];
  expect(runnerStep.uses).toBeUndefined();
  expect(runnerStep.run).toBe(runnerCommand);
  expect(runnerStep.block).not.toMatch(/^\s*(?:if|continue-on-error):/m);

  const allowedPreflightSteps = [
    { name: "Checkout", uses: "actions/checkout@v7" },
    { name: "Setup Supabase CLI", uses: "supabase/setup-cli@v1" },
    { name: "Setup Node", uses: "actions/setup-node@v6" },
    { name: "Enable Corepack", run: "corepack enable" },
    { name: "Install dependencies", run: "pnpm install --frozen-lockfile" },
  ];
  expect(steps.slice(0, runnerIndex)).toHaveLength(allowedPreflightSteps.length);
  for (const [index, expected] of allowedPreflightSteps.entries()) {
    const actual = steps[index];
    expect(actual.name).toBe(expected.name);
    expect(actual.uses).toBe(expected.uses);
    expect(actual.run).toBe(expected.run);
    expect(actual.block).not.toMatch(/^\s*(?:if|continue-on-error):/m);
  }

  const requiredMutationSteps = [
    {
      name: "Start local Supabase",
      run: "pnpm exec supabase start -x studio,storage-api,imgproxy,edge-runtime,vector,pooler",
    },
    { name: "Run CFG-001 fresh-reset gate", run: "pnpm --filter web test:db:cfg001-fresh" },
    { name: "Run real-DB suite", run: "pnpm --filter web test:db" },
  ];
  const mutationSteps = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) =>
      step.run &&
      (/^pnpm exec supabase (?:start|db\s+reset)(?:\s|$)/.test(step.run) ||
        /^pnpm --filter web test:db(?::cfg001-fresh)?$/.test(step.run) ||
        /\bvitest(?:\.mjs)?\s+run\s+--config\s+vitest\.db\.config\.mts(?:\s|$)/.test(step.run)),
    );
  expect(mutationSteps).not.toHaveLength(0);
  for (const { index } of mutationSteps) {
    expect(index).toBeGreaterThan(runnerIndex);
  }

  for (const expected of requiredMutationSteps) {
    const matches = steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.name === expected.name && step.run === expected.run);
    expect(matches).toHaveLength(1);
    expect(matches[0].index).toBeGreaterThan(runnerIndex);
  }
});
