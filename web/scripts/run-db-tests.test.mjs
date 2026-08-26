import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { runDbTests, validateLocalDatabaseUrl } from "./run-db-tests.mjs";

const GOOD_STATUS = [
  'API_URL="http://127.0.0.1:54321"',
  'PUBLISHABLE_KEY="publishable-test-key"',
  'SECRET_KEY="secret-test-key"',
].join("\n");

function parseWorkflowSteps(workflow) {
  const lines = workflow.replace(/\r\n/g, "\n").split("\n");
  const stepsDeclarations = lines
    .map((line, index) => (line === "    steps:" ? index : -1))
    .filter((index) => index >= 0);

  if (stepsDeclarations.length !== 1) {
    throw new Error("DB workflow must contain exactly one job steps declaration");
  }

  const stepsStart = stepsDeclarations[0] + 1;
  const stepsEnd = lines.findIndex(
    (line, index) => index >= stepsStart && /^    \S/.test(line),
  );
  const stepLines = lines.slice(stepsStart, stepsEnd === -1 ? lines.length : stepsEnd);
  const stepStarts = stepLines
    .map((line, index) => (/^      - /.test(line) ? index : -1))
    .filter((index) => index >= 0);

  if (stepStarts.length === 0) {
    throw new Error("DB workflow must contain at least one step");
  }

  return stepStarts.map((start, index) => {
    const block = stepLines.slice(start, stepStarts[index + 1] ?? stepLines.length);
    const name = /^      - name: (.+)$/.exec(block[0])?.[1];
    if (!name) {
      throw new Error("Every DB workflow step must begin with an explicit name");
    }

    const properties = new Map();
    for (const line of block.slice(1)) {
      if (/^        env:/.test(line)) {
        throw new Error(`DB workflow step ${name} must not override job env`);
      }
      if (/^        (?:shell|timeout-minutes|working-directory):/.test(line)) {
        throw new Error(`DB workflow step ${name} has a mutable execution override`);
      }
      const property = /^        (uses|run|if|continue-on-error):(?:\s*(.*))?$/.exec(line);
      if (!property) continue;

      const [, key, value = ""] = property;
      if (properties.has(key) || !value) {
        throw new Error(`DB workflow step ${name} has an ambiguous ${key} field`);
      }
      if (key === "run" && /^[>|]/.test(value)) {
        throw new Error(`DB workflow step ${name} must not use a multiline run scalar`);
      }
      properties.set(key, value);
    }

    const uses = properties.get("uses");
    const run = properties.get("run");
    if ((uses === undefined) === (run === undefined)) {
      throw new Error(`DB workflow step ${name} must have exactly one of uses or run`);
    }

    return {
      name,
      uses,
      run,
      hasCondition: properties.has("if") || properties.has("continue-on-error"),
    };
  });
}

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

function assertWorkflowContract(workflow, normalConfig) {
  expect(normalConfig).toMatch(/include:\s*\[[^\]]*"scripts\/\*\*\/\*.test\.mjs"/s);
  const lines = workflow.replace(/\r\n/g, "\n").split("\n");
  const jobsAt = lines.indexOf("jobs:");
  if (jobsAt < 0) throw new Error("missing jobs root");
  const jobEnd = lines.findIndex((line, index) => index > jobsAt && /^\S/.test(line));
  const jobLines = lines.slice(jobsAt + 1, jobEnd < 0 ? lines.length : jobEnd);
  const jobIds = jobLines.filter((line) => /^  [^\s][^:]*:$/.test(line)).map((line) => line.trim().slice(0, -1));
  expect(jobIds).toEqual(["db-tests"]);
  const envAt = jobLines.findIndex((line) => line === "    env:");
  if (envAt < 0) throw new Error("missing db-tests job env");
  const envLines = jobLines.slice(envAt + 1).filter((line) => /^      [A-Z_]+:/.test(line));
  expect(envLines).toEqual(["      NEXT_TELEMETRY_DISABLED: \"1\"", "      DB_TESTS_REQUIRED: \"1\""]);
  const steps = parseWorkflowSteps(workflow);
  expect(steps.map((step) => step.name)).toEqual([
    "Checkout", "Setup Supabase CLI", "Setup Node", "Enable Corepack",
    "Install dependencies", "Verify DB test runner contract (credential-free)",
    "Start local Supabase", "Run CFG-001 fresh-reset gate", "Run real-DB suite",
  ]);
  const commands = {
    runner: "pnpm --filter web exec vitest run scripts/run-db-tests.test.mjs",
    start: "pnpm exec supabase start -x studio,storage-api,imgproxy,edge-runtime,vector,pooler",
    fresh: "pnpm --filter web test:db:cfg001-fresh",
    full: "pnpm --filter web test:db",
  };
  const find = (command) => steps.map((step, index) => ({ step, index })).filter(({ step }) => step.run === command);
  for (const command of Object.values(commands)) expect(find(command)).toHaveLength(1);
  const indexes = Object.fromEntries(Object.entries(commands).map(([key, command]) => [key, find(command)[0].index]));
  expect(indexes.runner).toBeLessThan(indexes.start);
  expect(indexes.start).toBeLessThan(indexes.fresh);
  expect(indexes.fresh).toBeLessThan(indexes.full);
  for (const step of steps) expect(step.hasCondition).toBe(false);
  expect(workflow).not.toMatch(/^        env:/m);
  const requiredPaths = [".github/workflows/db-tests.yml", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "supabase/config.toml", "supabase/migrations/**", "supabase/seed.sql", "web/package.json", "web/scripts/run-cfg001-fresh-reset.mjs", "web/scripts/run-db-tests.mjs", "web/scripts/run-db-tests.test.mjs", "web/vitest.config.mts", "web/vitest.db.config.mts", "web/test/db/**"];
  for (const path of requiredPaths) {
    expect(workflow).toContain(`      - "${path}"`);
  }
  expect(workflow.match(/^      - "[^"]+"$/gm)).toEqual(expect.arrayContaining(requiredPaths.map((path) => `      - "${path}"`)));
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

it("rejects whitespace and partially present explicit credentials in every mode", async () => {
  for (const env of [
    { SUPABASE_TEST_URL: "   ", SUPABASE_TEST_PUBLISHABLE_KEY: " ", SUPABASE_TEST_SECRET_KEY: " " },
    { SUPABASE_TEST_URL: " http://127.0.0.1:54321 ", SUPABASE_TEST_PUBLISHABLE_KEY: " key ", SUPABASE_TEST_SECRET_KEY: "" },
    { SUPABASE_TEST_URL: 123, SUPABASE_TEST_PUBLISHABLE_KEY: "key", SUPABASE_TEST_SECRET_KEY: "secret" },
  ]) {
    const subject = harness({ env });
    expect(await subject.run()).toBe(1);
    expect(subject.calls).toHaveLength(0);
  }
});

it("rejects malformed CLI status even in optional mode", async () => {
  for (const stdout of ["", `${GOOD_STATUS}\nAPI_URL=duplicate`, GOOD_STATUS.replace('SECRET_KEY="secret-test-key"', 'SECRET_KEY="   "'), GOOD_STATUS.replace(/\n/g, "\r\n") + "\r\nAPI_URL=\"duplicate\""]) {
    const subject = harness({ results: [{ status: 0, stdout }] });
    expect(await subject.run()).toBe(1);
    expect(subject.calls).toHaveLength(1);
    expect(subject.logs.join("\n")).toMatch(/ERROR/);
  }
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
    { status: null },
    { status: 7 },
  ]) {
    const subject = harness({ results: [{ status: 0, stdout: GOOD_STATUS }, result] });
    expect(await subject.run()).toBe(result.status === 7 ? 7 : 1);
    expect(subject.calls[1].options.timeout).toBe(600_000);
  }
});

it("URL guard accepts only HTTP loopback endpoints", () => {
  expect(validateLocalDatabaseUrl("http://localhost:54321").ok).toBe(true);
  expect(validateLocalDatabaseUrl("http://[::1]:54321").ok).toBe(true);
  expect(validateLocalDatabaseUrl("ftp://127.0.0.1").ok).toBe(false);
  expect(validateLocalDatabaseUrl("http://10.0.0.2").ok).toBe(false);
});

it("DB workflow structural parser rejects nameless and multiline-run steps", () => {
  const workflow = (step) => ["jobs:", "  db-tests:", "    steps:", step].join("\n");

  expect(() =>
    parseWorkflowSteps(workflow("      - run: pnpm exec supabase start")),
  ).toThrow(/explicit name/);
  expect(() =>
    parseWorkflowSteps(
      workflow(["      - name: Start local Supabase", "        run: |-", "          pnpm exec supabase start"].join("\n")),
    ),
  ).toThrow(/multiline run scalar/);
  expect(() =>
    parseWorkflowSteps(workflow("      - name: Bad\n        run: one\n        run: two")),
  ).toThrow(/ambiguous run/);
  expect(() =>
    parseWorkflowSteps(workflow("      - name: Bad\n        uses:")),
  ).toThrow(/ambiguous uses/);
  expect(() =>
    parseWorkflowSteps(workflow("      - name: Bad\n        run: one\n        uses: actions/checkout@v7")),
  ).toThrow(/exactly one/);
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
  assertWorkflowContract(workflow, normalConfig);

  // The normal unit-test config must continue discovering this file, while
  // the dedicated workflow must run it before any Docker-backed mutation.
  expect(normalConfig).toMatch(/include:\s*\[[^\]]*"scripts\/\*\*\/\*.test\.mjs"/s);
  expect(workflow).toMatch(/env:\s*\n\s+NEXT_TELEMETRY_DISABLED: "1"\s+\n\s+DB_TESTS_REQUIRED: "1"/);
  expect(workflow).not.toMatch(/DB_TESTS_REQUIRED:\s*"1"[\s\S]*?\n\s{8,}env:/);

  const steps = parseWorkflowSteps(workflow);

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
  expect(runnerStep.hasCondition).toBe(false);

  for (const mutation of steps.slice(runnerIndex + 1)) {
    expect(mutation.hasCondition).toBe(false);
  }

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
    expect(actual.hasCondition).toBe(false);
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

  const mutations = [
    workflow.replace(runnerCommand, `${runnerCommand}\n      - name: Duplicate runner\n        run: ${runnerCommand}`),
    workflow.replace("DB_TESTS_REQUIRED: \"1\"", "DB_TESTS_REQUIRED: \"0\""),
    workflow.replace("Run CFG-001 fresh-reset gate", "Run unexpected gate"),
    workflow.replace("Run CFG-001 fresh-reset gate", "Run real-DB suite"),
    workflow.replace('      - "web/test/db/**"', ""),
    workflow.replace("        run: pnpm --filter web test:db\r\n", "        if: always()\r\n        run: pnpm --filter web test:db\r\n"),
    workflow.replace("        run: pnpm --filter web test:db\r\n", "        shell: bash\r\n        run: pnpm --filter web test:db\r\n"),
  ];
  for (const [mutationIndex, mutated] of mutations.entries()) {
    expect(() => assertWorkflowContract(mutated, normalConfig), `mutation ${mutationIndex}`).toThrow();
  }
});
