import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import {
  parseSupabaseProjectId,
  runCfg001FreshReset,
  waitForAuthReady,
} from "./run-cfg001-fresh-reset.mjs";
import { runDbTests, validateLocalDatabaseUrl } from "./run-db-tests.mjs";

const GOOD_STATUS = [
  'API_URL="http://127.0.0.1:54321"',
  'PUBLISHABLE_KEY="publishable-test-key"',
  'SECRET_KEY="secret-test-key"',
].join("\n");

const INVALID_SUPABASE_PROJECT_CONFIGS = [
  ["missing project id", ""],
  ["literal-string project id", "project_id = 'typst-cv-template'"],
  ["indented project id", "  project_id = \"nested\""],
  ["unsafe project id", 'project_id = "unsafe/project"'],
  ["empty project id", 'project_id = ""'],
  ["duplicate root project id", 'project_id = "first"\nproject_id = "second"'],
  ["numeric project id", "project_id = 1"],
  ["boolean project id", "project_id = true"],
  ["array project id", 'project_id = ["typst-cv-template"]'],
  ["inline-table project id", 'project_id = { value = "typst-cv-template" }'],
  ["missing project id value", "project_id ="],
  ["unterminated project id string", 'project_id = "unterminated'],
  ["quoted project id key", '"project_id" = "typst-cv-template"'],
  ["project id table", '[project_id]\nvalue = "typst-cv-template"'],
  ["project id array table", '[[project_id]]\nvalue = "typst-cv-template"'],
  ["project id dotted table", '[project_id.nested]\nvalue = "typst-cv-template"'],
  ["project id quoted table", '["project_id"]\nvalue = "typst-cv-template"'],
  ["dotted project id", 'project_id.value = "typst-cv-template"'],
  ["multiline basic string decoy", 'note = """\nproject_id = "decoy"\n"""'],
  ["multiline literal string decoy", "note = '''\nproject_id = \"decoy\"\n'''"],
  ["nested project id decoy", 'project_id = "typst-cv-template"\n[api]\nproject_id = "decoy"'],
  ["string project id decoy", 'project_id = "typst-cv-template"\nnote = "project_id = \\"decoy\\""'],
  ["malformed table header", 'project_id = "ok"\n[api'],
  ["unterminated double-quoted line", 'project_id = "ok"\nnote = "oops'],
  ["unterminated literal-quoted line", "project_id = \"ok\"\nnote = 'oops"],
];

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
    const withValues = new Map();
    let withMap = false;
    for (const line of block.slice(1)) {
      if (/^        \S/.test(line) && !/^        (?:uses|run|if|continue-on-error|with):/.test(line) && !/^        #/.test(line)) {
        throw new Error(`DB workflow step ${name} has unknown or quoted property`);
      }
      if (/^        env:/.test(line)) {
        throw new Error(`DB workflow step ${name} must not override job env`);
      }
      if (/^        (?:shell|timeout-minutes|working-directory):/.test(line)) {
        throw new Error(`DB workflow step ${name} has a mutable execution override`);
      }
      const direct = /^        ([a-z][a-z0-9-]*):(?:\s*(.*))?$/.exec(line);
      if (direct && !["uses", "run", "if", "continue-on-error", "with"].includes(direct[1])) {
        throw new Error(`DB workflow step ${name} has unknown property ${direct[1]}`);
      }
      const nested = /^          ([a-z][a-z0-9-]*):\s*(.*)$/.exec(line);
      if (/^          \S/.test(line) && !nested && !/^          #/.test(line)) {
        throw new Error(`DB workflow step ${name} has unknown or quoted with input`);
      }
      if (nested) {
        if (!withMap) throw new Error(`DB workflow step ${name} has relocated with input`);
        withMap = true;
        if (withValues.has(nested[1]) || !nested[2]) throw new Error(`DB workflow step ${name} has ambiguous with input`);
        withValues.set(nested[1], nested[2]);
        continue;
      }
      const property = /^        (uses|run|if|continue-on-error|with):(?:\s*(.*))?$/.exec(line);
      if (!property) continue;

      const [, key, value = ""] = property;
      if (properties.has(key) || (key !== "with" && !value)) {
        throw new Error(`DB workflow step ${name} has an ambiguous ${key} field`);
      }
      if (key === "run" && /^[>|]/.test(value)) {
        throw new Error(`DB workflow step ${name} must not use a multiline run scalar`);
      }
      properties.set(key, value);
      if (key === "with") withMap = true;
    }
    if (withValues.size > 0 && !properties.has("with")) throw new Error(`DB workflow step ${name} has relocated with inputs`);

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
      withValues,
      hasWith: withMap,
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

function freshHarness({
  config = 'project_id = "typst-cv-template"',
  env = {},
  results = [],
  fetchImpl = async () => ({ status: 200 }),
} = {}) {
  const calls = [];
  const fetchCalls = [];
  const logs = [];
  const errors = [];
  return {
    calls,
    fetchCalls,
    logs,
    errors,
    run() {
      return runCfg001FreshReset({
        env,
        fetchImpl(...args) {
          fetchCalls.push(args);
          return fetchImpl(...args);
        },
        sleepImpl: async () => {},
        existsSyncImpl: () => true,
        readFileSyncImpl: () => config,
        logger: (message) => logs.push(message),
        errorLogger: (message) => errors.push(message),
        spawnSyncImpl(command, args, options) {
          calls.push({ command, args, options });
          return results.shift() ?? {
            status: 0,
            stdout: args.includes("status") ? GOOD_STATUS : "",
          };
        },
      });
    },
  };
}

const REQUIRED_WORKFLOW_PATHS = [".github/workflows/db-tests.yml", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "supabase/config.toml", "supabase/migrations/**", "supabase/seed.sql", "web/package.json", "web/scripts/run-cfg001-fresh-reset.mjs", "web/scripts/run-db-tests.mjs", "web/scripts/run-db-tests.test.mjs", "web/vitest.config.mts", "web/src/lib/cv/cloud-storage.ts", "web/src/lib/legal/terms-acceptance.ts", "web/src/server/polish/auth.ts", "web/src/server/polish/deepseek-v2-seed-v1.ts", "web/src/server/polish/deepseek-v2-seed-v1.test.ts", "web/src/server/polish/lifecycle*.ts", "web/src/server/polish/quota.ts", "web/test/db/**", "web/vitest.db.config.mts"];

function assertWorkflowContract(workflow, normalConfig) {
  expect(normalConfig).toMatch(/include:\s*\[[^\]]*"scripts\/\*\*\/\*.test\.mjs"/s);
  const lines = workflow.replace(/\r\n/g, "\n").split("\n");
  expect(lines.filter((line) => /^[^\s#][^:]*:/.test(line)).map((line) => line.split(":")[0]))
    .toEqual(["name", "on", "permissions", "jobs"]);
  expect(lines.filter((line) => line === "on:")).toHaveLength(1);
  expect(lines.filter((line) => line === "jobs:")).toHaveLength(1);
  const onAt = lines.indexOf("on:");
  const onEnd = lines.findIndex((line, index) => index > onAt && /^\S/.test(line));
  const onLines = lines.slice(onAt + 1, onEnd < 0 ? lines.length : onEnd);
  expect(onLines.filter((line) => /^  [^\s#][^:]*:/.test(line)).map((line) => line.trim().split(":")[0]))
    .toEqual(["pull_request", "workflow_dispatch"]);
  const prAt = onLines.findIndex((line) => line === "  pull_request:");
  const prEnd = onLines.findIndex((line, index) => index > prAt && /^  \S/.test(line));
  if (prAt < 0 || prEnd < 0) throw new Error("missing pull_request block");
  const prLines = onLines.slice(prAt + 1, prEnd);
  expect(prLines.filter((line) => /^    [^\s#][^:]*:/.test(line)).map((line) => line.trim().split(":")[0]))
    .toEqual(["paths"]);
  const jobsAt = lines.indexOf("jobs:");
  if (jobsAt < 0) throw new Error("missing jobs root");
  const jobEnd = lines.findIndex((line, index) => index > jobsAt && /^\S/.test(line));
  const jobLines = lines.slice(jobsAt + 1, jobEnd < 0 ? lines.length : jobEnd);
  const jobIds = jobLines.filter((line) => /^  [^\s][^:]*:$/.test(line)).map((line) => line.trim().slice(0, -1));
  expect(jobIds).toEqual(["db-tests"]);
  const directJob = jobLines.filter((line) => /^    [^\s#][^:]*:/.test(line));
  expect(directJob.map((line) => line.trim().split(":")[0])).toEqual(["name", "runs-on", "timeout-minutes", "env", "steps"]);
  expect(directJob).toEqual(expect.arrayContaining(["    name: Web (real-DB tests)", "    runs-on: ubuntu-latest", "    timeout-minutes: 20"]));
  const envDeclarations = jobLines.filter((line) => line === "    env:");
  expect(envDeclarations).toHaveLength(1);
  const envAt = jobLines.indexOf("    env:");
  if (envAt < 0) throw new Error("missing db-tests job env");
  const envLines = jobLines.slice(envAt + 1).filter((line) => /^      [A-Z_]+:/.test(line));
  expect(envLines).toEqual(["      NEXT_TELEMETRY_DISABLED: \"1\"", "      DB_TESTS_REQUIRED: \"1\""]);
  const envBlockEnd = jobLines.findIndex((line, index) => index > envAt && /^    \S/.test(line));
  for (const line of jobLines.slice(envAt + 1, envBlockEnd < 0 ? jobLines.length : envBlockEnd)) {
    if (line.trim() && !/^      [A-Z_]+:\s*"[^"]*"$/.test(line) && !/^      #/.test(line)) {
      throw new Error("db-tests job env contains unknown or quoted key");
    }
  }
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
  expect(steps[0].hasWith).toBe(false);
  expect(steps[0].withValues.size).toBe(0);
  expect(steps[1].hasWith).toBe(true);
  expect(steps[1].withValues).toEqual(new Map([["version", "2.109.0"]]));
  expect(steps[2].withValues).toEqual(new Map([["node-version", "24"], ["package-manager-cache", "false"]]));
  for (const step of steps.filter((step) => step.run)) expect(step.hasWith).toBe(false);
  expect(workflow).not.toMatch(/^        env:/m);
  const parsedPaths = prLines.filter((line) => /^      - ".*"$/.test(line)).map((line) => line.trim().slice(3, -1));
  expect(parsedPaths).toEqual(REQUIRED_WORKFLOW_PATHS);
  const requiredPaths = REQUIRED_WORKFLOW_PATHS;
  for (const path of requiredPaths) {
    expect(workflow).toContain(`      - "${path}"`);
  }
  expect(workflow.match(/^      - "[^"]+"$/gm)).toEqual(expect.arrayContaining(requiredPaths.map((path) => `      - "${path}"`)));
}

function replaceExactlyOnce(value, search, replacement, label) {
  if (!search) throw new Error(`workflow mutation ${label} has an empty target`);
  const first = value.indexOf(search);
  if (first < 0 || value.indexOf(search, first + search.length) >= 0) {
    throw new Error(`workflow mutation ${label} did not match exactly once`);
  }
  return `${value.slice(0, first)}${replacement}${value.slice(first + search.length)}`;
}

function moveNamedWorkflowStepBefore(workflow, lineEnding, movingName, targetName) {
  const lines = workflow.split(lineEnding);
  const findUniqueStep = (name) => {
    const matches = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line === `      - name: ${name}`);
    if (matches.length !== 1) {
      throw new Error(`workflow mutation move ${name} did not find exactly one named step`);
    }
    return matches[0].index;
  };
  const movingStart = findUniqueStep(movingName);
  const movingEnd = lines.findIndex((line, index) => index > movingStart && line.startsWith("      - "));
  const movingStep = lines.splice(movingStart, movingEnd < 0 ? lines.length - movingStart : movingEnd - movingStart);
  const targetStart = findUniqueStep(targetName);
  lines.splice(targetStart, 0, ...movingStep);
  return lines.join(lineEnding);
}

function assertWorkflowMutationRejected(workflow, normalConfig, label, mutate) {
  for (const [lineEndingName, lineEnding] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
    const source = workflow.replace(/\r\n|\n/g, lineEnding);
    const mutated = mutate(source, lineEnding);
    expect(mutated, `${label} ${lineEndingName} must change the workflow`).not.toBe(source);
    expect(() => assertWorkflowContract(mutated, normalConfig), `${label} ${lineEndingName}`).toThrow();
  }
}

it("accepts exactly one safe top-level Supabase project id", () => {
  expect(parseSupabaseProjectId('project_id = "typst-cv-template"')).toBe(
    "typst-cv-template",
  );
  expect(parseSupabaseProjectId('project_id="cv.test_1" # local')).toBe(
    "cv.test_1",
  );
  for (const [label, config] of INVALID_SUPABASE_PROJECT_CONFIGS) {
    expect(parseSupabaseProjectId(config), label).toBeNull();
  }
});

it("rejects every invalid project authority before status, reset, Docker, Vitest, or fetch", async () => {
  for (const [label, config] of INVALID_SUPABASE_PROJECT_CONFIGS) {
    const subject = freshHarness({ config });
    expect(await subject.run(), label).toBe(1);
    expect(subject.calls, label).toHaveLength(0);
    expect(subject.fetchCalls, label).toHaveLength(0);
    expect(subject.errors.join("\n"), label).toMatch(/invalid or ambiguous project_id/);
  }
});

it("derives the checked-in gateway name from its only root project authority", async () => {
  const configPath = fileURLToPath(new URL("../../supabase/config.toml", import.meta.url));
  const config = await readFile(configPath, "utf8");
  expect(parseSupabaseProjectId(config)).toBe("typst-cv-template");

  const subject = freshHarness({ config });
  expect(await subject.run()).toBe(0);
  expect(subject.calls[3]).toMatchObject({
    command: "docker",
    args: ["restart", "supabase_kong_typst-cv-template"],
  });
});

it("restarts only the configured local gateway before the fresh CFG suite", async () => {
  const subject = freshHarness({ env: { PARENT_MARKER: "preserved" } });
  expect(await subject.run()).toBe(0);
  expect(subject.calls).toHaveLength(5);

  const [beforeStatus, reset, afterStatus, restart, test] = subject.calls;
  expect(beforeStatus.command).toBe(process.execPath);
  expect(beforeStatus.args.slice(-3)).toEqual(["status", "-o", "env"]);
  expect(reset.command).toBe(process.execPath);
  expect(reset.args.slice(-2)).toEqual(["db", "reset"]);
  expect(afterStatus.args.slice(-3)).toEqual(["status", "-o", "env"]);
  expect(restart.command).toBe("docker");
  expect(restart.args).toEqual([
    "restart",
    "supabase_kong_typst-cv-template",
  ]);
  expect(restart.options.timeout).toBe(120_000);
  expect(test.command).toBe(process.execPath);
  expect(test.args.slice(-3)).toEqual([
    "run",
    "--config",
    "vitest.db.config.mts",
  ]);
  expect(test.options.env).toMatchObject({
    PARENT_MARKER: "preserved",
    CFG001_FRESH_RESET: "1",
    SUPABASE_TEST_URL: "http://127.0.0.1:54321/",
    SUPABASE_TEST_PUBLISHABLE_KEY: "publishable-test-key",
    SUPABASE_TEST_SECRET_KEY: "secret-test-key",
  });
  expect([...subject.logs, ...subject.errors].join("\n")).not.toContain(
    "secret-test-key",
  );
});

it("waits for an exact Auth health success and bounds retries", async () => {
  const statuses = [502, 503, 200];
  const urls = [];
  let sleeps = 0;
  expect(
    await waitForAuthReady("http://127.0.0.1:54321", {
      attempts: 3,
      intervalMs: 0,
      sleepImpl: async () => {
        sleeps += 1;
      },
      fetchImpl: async (url) => {
        urls.push(url);
        return { status: statuses.shift() };
      },
    }),
  ).toBe(true);
  expect(urls).toEqual([
    "http://127.0.0.1:54321/auth/v1/health",
    "http://127.0.0.1:54321/auth/v1/health",
    "http://127.0.0.1:54321/auth/v1/health",
  ]);
  expect(sleeps).toBe(2);

  const nonSuccessStatuses = [204, 401, 404, 503];
  expect(
    await waitForAuthReady("http://127.0.0.1:54321", {
      attempts: nonSuccessStatuses.length,
      intervalMs: 0,
      sleepImpl: async () => {},
      fetchImpl: async () => ({ status: nonSuccessStatuses.shift() }),
    }),
  ).toBe(false);
});

it("settles a stuck Auth health fetch with a referenced timeout", async () => {
  const timeoutHandle = { kind: "auth-health-timeout" };
  const cleared = [];
  let requestSignal;
  const ready = await waitForAuthReady("http://127.0.0.1:54321", {
    attempts: 1,
    requestTimeoutMs: 123,
    setTimeoutImpl(callback, milliseconds) {
      expect(milliseconds).toBe(123);
      queueMicrotask(callback);
      return timeoutHandle;
    },
    clearTimeoutImpl(handle) {
      cleared.push(handle);
    },
    fetchImpl: async (_url, { signal }) => {
      requestSignal = signal;
      return new Promise(() => {
        // Deliberately ignore abort: the timeout side of Promise.race must
        // settle the wait even when the fetch implementation never does.
      });
    },
  });

  expect(ready).toBe(false);
  expect(requestSignal?.aborted).toBe(true);
  expect(cleared).toEqual([timeoutHandle]);
});

it("fails closed before reset for ambiguous project authority", async () => {
  const subject = freshHarness({
    config: 'project_id = "first"\nproject_id = "second"',
  });
  expect(await subject.run()).toBe(1);
  expect(subject.calls).toHaveLength(0);
  expect(subject.errors.join("\n")).toMatch(/invalid or ambiguous project_id/);
});

it("fails closed before reset for malformed, duplicate, or blank status", async () => {
  const malformedStatuses = [
    `${GOOD_STATUS}\nAPI_URL="http://127.0.0.1:54321"`,
    `${GOOD_STATUS}\nMALFORMED`,
    GOOD_STATUS.replace(
      'PUBLISHABLE_KEY="publishable-test-key"',
      'PUBLISHABLE_KEY="   "',
    ),
    GOOD_STATUS.replace('SECRET_KEY="secret-test-key"', ""),
  ];
  for (const stdout of malformedStatuses) {
    const subject = freshHarness({ results: [{ status: 0, stdout }] });
    expect(await subject.run(), stdout).toBe(1);
    expect(subject.calls).toHaveLength(1);
    expect(subject.errors.join("\n")).toMatch(/safe loopback credentials/);
    expect(subject.errors.join("\n")).not.toContain("secret-test-key");
  }
});

it("does not run Vitest after gateway restart failure", async () => {
  for (const restartResult of [
    { status: 1 },
    { status: null },
    { status: null, signal: "SIGTERM" },
    {
      status: null,
      error: new Error("secret-test-key must stay redacted"),
    },
  ]) {
    const subject = freshHarness({
      results: [
        { status: 0, stdout: GOOD_STATUS },
        { status: 0 },
        { status: 0, stdout: GOOD_STATUS },
        restartResult,
      ],
    });
    expect(await subject.run()).toBe(1);
    expect(subject.calls).toHaveLength(4);
    expect(subject.errors.join("\n")).toMatch(/gateway restart failed/);
    expect(subject.errors.join("\n")).not.toContain("secret-test-key");
  }
});

it("does not run Vitest when Auth never becomes ready", async () => {
  const subject = freshHarness({
    fetchImpl: async () => ({ status: 502 }),
  });
  expect(await subject.run()).toBe(1);
  expect(subject.calls).toHaveLength(4);
  expect(subject.errors.join("\n")).toMatch(/Auth did not become ready/);
});

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

it("workflow mutation replacement rejects a missing target", () => {
  expect(() => replaceExactlyOnce("on:\n", "jobs:\n", "", "missing root")).toThrow(/did not match exactly once/);
});

it("pins Supabase SQL to LF and canonicalizes every routine authority digest", async () => {
  const attributesPath = fileURLToPath(new URL("../../.gitattributes", import.meta.url));
  const authorityTestPath = fileURLToPath(
    new URL("../test/db/deepseek-v2-cfg-seed.test.ts", import.meta.url),
  );
  const [attributes, authorityTest] = await Promise.all([
    readFile(attributesPath, "utf8"),
    readFile(authorityTestPath, "utf8"),
  ]);
  const normalizedAuthorityTest = authorityTest.replace(/\r\n/g, "\n");

  const attributeRules = attributes
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  expect(attributeRules).toContain("supabase/**/*.sql text eol=lf");

  expect(normalizedAuthorityTest).toContain(
    "pg_catalog.chr(13) || pg_catalog.chr(10),\n      pg_catalog.chr(10)",
  );
  expect(normalizedAuthorityTest).toContain(
    "pg_catalog.chr(13),\n    pg_catalog.chr(10)",
  );
  expect(normalizedAuthorityTest.match(/\$\{CANONICAL_ROUTINE_DEFINITION_SQL\}/g)).toHaveLength(4);
  expect(normalizedAuthorityTest).not.toMatch(
    /extensions\.digest\(\s*pg_catalog\.pg_get_functiondef\(procedure\.oid\)/,
  );
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
    ["duplicate runner", (source, eol) => replaceExactlyOnce(
      source,
      `      - name: ${runnerName}${eol}        run: ${runnerCommand}${eol}`,
      `      - name: ${runnerName}${eol}        run: ${runnerCommand}${eol}      - name: Duplicate runner${eol}        run: ${runnerCommand}${eol}`,
      "duplicate runner",
    )],
    ["required job environment value", (source) => replaceExactlyOnce(
      source,
      'DB_TESTS_REQUIRED: "1"',
      'DB_TESTS_REQUIRED: "0"',
      "required job environment value",
    )],
    ["duplicate job environment key", (source, eol) => replaceExactlyOnce(
      source,
      `      DB_TESTS_REQUIRED: "1"${eol}`,
      `      DB_TESTS_REQUIRED: "1"${eol}      DB_TESTS_REQUIRED: "1"${eol}`,
      "duplicate job environment key",
    )],
    ["quoted job environment key", (source) => replaceExactlyOnce(
      source,
      'DB_TESTS_REQUIRED: "1"',
      '"DB_TESTS_REQUIRED": "1"',
      "quoted job environment key",
    )],
    ["job condition", (source, eol) => replaceExactlyOnce(
      source,
      `    env:${eol}`,
      `    if: false${eol}    env:${eol}`,
      "job condition",
    )],
    ["renamed required mutation", (source) => replaceExactlyOnce(
      source,
      "Run CFG-001 fresh-reset gate",
      "Run unexpected gate",
      "renamed required mutation",
    )],
    ["duplicate required mutation name", (source) => replaceExactlyOnce(
      source,
      "Run CFG-001 fresh-reset gate",
      "Run real-DB suite",
      "duplicate required mutation name",
    )],
    ...REQUIRED_WORKFLOW_PATHS.map((path) => [
      `omitted required path ${path}`,
      (source, eol) => replaceExactlyOnce(source, `      - "${path}"${eol}`, "", `required path ${path}`),
    ]),
    ["paths-ignore", (source, eol) => replaceExactlyOnce(
      source,
      `    paths:${eol}`,
      `    paths-ignore:${eol}`,
      "paths-ignore",
    )],
    ["post-mutation condition", (source, eol) => replaceExactlyOnce(
      source,
      `        run: pnpm --filter web test:db${eol}`,
      `        if: always()${eol}        run: pnpm --filter web test:db${eol}`,
      "post-mutation condition",
    )],
    ["post-mutation continue-on-error", (source, eol) => replaceExactlyOnce(
      source,
      `        run: pnpm --filter web test:db${eol}`,
      `        continue-on-error: true${eol}        run: pnpm --filter web test:db${eol}`,
      "post-mutation continue-on-error",
    )],
    ["post-mutation shell", (source, eol) => replaceExactlyOnce(
      source,
      `        run: pnpm --filter web test:db${eol}`,
      `        shell: bash${eol}        run: pnpm --filter web test:db${eol}`,
      "post-mutation shell",
    )],
    ["quoted step condition", (source, eol) => replaceExactlyOnce(
      source,
      `        run: pnpm --filter web test:db${eol}`,
      `        "if": false${eol}        run: pnpm --filter web test:db${eol}`,
      "quoted step condition",
    )],
    ["quoted step environment", (source, eol) => replaceExactlyOnce(
      source,
      `        run: pnpm --filter web test:db${eol}`,
      `        "env": { DB_TESTS_REQUIRED: "0" }${eol}        run: pnpm --filter web test:db${eol}`,
      "quoted step environment",
    )],
    ["quoted node input", (source) => replaceExactlyOnce(
      source,
      "          node-version: 24",
      "          \"node-version\": 24",
      "quoted node input",
    )],
    ["quoted checkout input", (source, eol) => replaceExactlyOnce(
      source,
      `        uses: actions/checkout@v7${eol}`,
      `        uses: actions/checkout@v7${eol}        with:${eol}          "ref": main${eol}`,
      "quoted checkout input",
    )],
    ["relocated pull request trigger", (source, eol) => replaceExactlyOnce(
      replaceExactlyOnce(source, `  pull_request:${eol}`, `  other:${eol}`, "remove root pull request"),
      `  workflow_dispatch:${eol}`,
      `  pull_request:${eol}`,
      "relocate pull request trigger",
    )],
    ["missing pull request trigger", (source, eol) => replaceExactlyOnce(
      source,
      `  pull_request:${eol}`,
      `  other:${eol}`,
      "missing pull request trigger",
    )],
    ["decoy duplicate pull request trigger", (source, eol) => replaceExactlyOnce(
      source,
      `on:${eol}`,
      `on:${eol}  pull_request:${eol}    paths:${eol}      - "decoy"${eol}`,
      "decoy duplicate pull request trigger",
    )],
    ["decoy job", (source, eol) => replaceExactlyOnce(
      source,
      `jobs:${eol}`,
      `jobs:${eol}  decoy:${eol}    steps:${eol}      - name: noop${eol}        run: true${eol}`,
      "decoy job",
    )],
    ["duplicate jobs root", (source, eol) => replaceExactlyOnce(
      source,
      `jobs:${eol}`,
      `jobs:${eol}jobs:${eol}`,
      "duplicate jobs root",
    )],
    ["duplicate on root", (source, eol) => replaceExactlyOnce(
      source,
      `on:${eol}`,
      `on:${eol}on:${eol}`,
      "duplicate on root",
    )],
    ...["|", ">", "|-", ">-", "|+", ">+"].map((style) => [
      `multiline run scalar ${style}`,
      (source, eol) => replaceExactlyOnce(
        source,
        `        run: pnpm --filter web test:db${eol}`,
        `        run: ${style}${eol}          pnpm --filter web test:db${eol}`,
        `multiline run scalar ${style}`,
      ),
    ]),
    ["runner order", (source, eol) => moveNamedWorkflowStepBefore(
      source,
      eol,
      "Start local Supabase",
      runnerName,
    )],
  ];
  for (const [label, mutate] of mutations) {
    assertWorkflowMutationRejected(workflow, normalConfig, label, mutate);
  }
});
