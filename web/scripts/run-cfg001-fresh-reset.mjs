/**
 * Hard-fail CFG-001 seed gate.
 *
 * Unlike the ordinary real-DB runner, this command never skips. It accepts
 * only a Supabase instance reported on loopback, resets that instance, then
 * runs the isolated CFG-001 database file with its strict fresh-state checks.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseSupabaseStatus,
  validateLocalDatabaseUrl,
} from "./run-db-tests.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptsDir, "..");
const repoRoot = path.resolve(webRoot, "..");
const supabaseCli = path.join(
  repoRoot,
  "node_modules",
  "supabase",
  "dist",
  "supabase.js",
);
const vitestCli = path.join(webRoot, "node_modules", "vitest", "vitest.mjs");
const supabaseConfig = path.join(repoRoot, "supabase", "config.toml");
const CHILD_TIMEOUT_MS = 300_000;
const KONG_RESTART_TIMEOUT_MS = 120_000;

function logTo(logger, message) {
  logger(`[test:db:cfg001-fresh] ${message}`);
}

function failedChild(result) {
  return Boolean(
    result.error ||
      result.signal ||
      result.status === null ||
      result.status !== 0,
  );
}

function parseLocalStatus(stdout) {
  const values = parseSupabaseStatus(String(stdout ?? ""));
  if (!values) {
    return null;
  }

  const validated = validateLocalDatabaseUrl(values.url);
  if (!validated.ok) {
    return null;
  }
  return {
    url: validated.url,
    publishableKey: values.publishableKey,
    secretKey: values.secretKey,
  };
}

function stripTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return line.slice(0, index);
    }
  }
  return quote === null ? line : null;
}

function containsProjectIdToken(line) {
  return /(?:^|[^A-Za-z0-9_-])project_id(?:$|[^A-Za-z0-9_-])/.test(line);
}

function isSafeTomlTableHeader(line) {
  const dottedBareKey = "[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*";
  return new RegExp(`^\\[${dottedBareKey}\\]$|^\\[\\[${dottedBareKey}\\]\\]$`).test(line);
}

export function parseSupabaseProjectId(config) {
  let projectId = null;
  let rootTable = true;
  for (const originalLine of String(config).replace(/\r\n?/g, "\n").split("\n")) {
    // The runner does not need a general TOML parser, but a project authority
    // decoy in either TOML multiline string form must never be accepted.
    if (originalLine.includes('"""') || originalLine.includes("'''")) {
      return null;
    }
    const line = stripTomlComment(originalLine);
    if (line === null) return null;
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("[")) {
      if (!isSafeTomlTableHeader(trimmed) || containsProjectIdToken(line)) return null;
      rootTable = false;
      continue;
    }

    if (!containsProjectIdToken(line)) continue;
    const match = /^project_id[ \t]*=[ \t]*"([A-Za-z0-9._-]+)"[ \t]*$/.exec(line);
    if (!rootTable || projectId !== null || !match) return null;
    projectId = match[1];
  }
  return projectId;
}

export async function waitForAuthReady(
  apiUrl,
  {
    fetchImpl = fetch,
    sleepImpl = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    attempts = 30,
    intervalMs = 1_000,
    requestTimeoutMs = 3_000,
  } = {},
) {
  const healthUrl = new URL("/auth/v1/health", apiUrl).toString();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(healthUrl, {
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.status === 200) {
        return true;
      }
    } catch {
      // A reset can briefly make Kong/Auth unreachable; retry within the bound.
    }
    if (attempt + 1 < attempts) {
      await sleepImpl(intervalMs);
    }
  }
  return false;
}

/** Injectable runner; returns an exit code instead of calling process.exit. */
export async function runCfg001FreshReset({
  env = process.env,
  spawnSyncImpl = spawnSync,
  fetchImpl = fetch,
  sleepImpl,
  existsSyncImpl = fs.existsSync,
  readFileSyncImpl = fs.readFileSync,
  logger = console.log,
  errorLogger = console.error,
} = {}) {
  const fail = (message) => {
    logTo(errorLogger, `ERROR: ${message}`);
    return 1;
  };
  const runNode = (script, args, options = {}) =>
    spawnSyncImpl(process.execPath, [script, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS,
      ...options,
    });
  const readLocalStatus = () => {
    const result = runNode(supabaseCli, ["status", "-o", "env"]);
    if (failedChild(result)) {
      return null;
    }
    return parseLocalStatus(result.stdout);
  };

  if (!existsSyncImpl(supabaseCli)) {
    return fail("the workspace Supabase CLI is not installed.");
  }
  if (!existsSyncImpl(vitestCli)) {
    return fail("the web Vitest dependency is not installed.");
  }
  if (!existsSyncImpl(supabaseConfig)) {
    return fail("supabase/config.toml is missing.");
  }

  let config;
  try {
    config = readFileSyncImpl(supabaseConfig, "utf8");
  } catch {
    return fail("supabase/config.toml could not be read.");
  }
  const projectId = parseSupabaseProjectId(config);
  if (!projectId) {
    return fail("supabase/config.toml has an invalid or ambiguous project_id.");
  }

  if (!readLocalStatus()) {
    return fail("local Supabase is unavailable or did not report safe loopback credentials.");
  }
  logTo(logger, "resetting verified loopback Supabase");
  const reset = runNode(supabaseCli, ["db", "reset"], {
    stdio: "inherit",
    encoding: undefined,
  });
  if (failedChild(reset)) {
    return fail("Supabase reset failed.");
  }

  const local = readLocalStatus();
  if (!local) {
    return fail("reset Supabase did not report safe loopback credentials.");
  }

  // `supabase db reset` can recreate Auth with a new container address while a
  // long-lived Kong process still holds the old upstream. Restart only this
  // verified local project's gateway so the fresh gate cannot false-fail 502.
  const kongContainer = `supabase_kong_${projectId}`;
  const restart = spawnSyncImpl("docker", ["restart", kongContainer], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: KONG_RESTART_TIMEOUT_MS,
  });
  if (failedChild(restart)) {
    return fail("local Supabase gateway restart failed.");
  }
  const authReady = await waitForAuthReady(local.url, {
    fetchImpl,
    ...(sleepImpl ? { sleepImpl } : {}),
  });
  if (!authReady) {
    return fail("local Supabase Auth did not become ready after gateway restart.");
  }

  logTo(logger, `running against ${local.url}`);
  const test = runNode(
    vitestCli,
    ["run", "--config", "vitest.db.config.mts"],
    {
      cwd: webRoot,
      stdio: "inherit",
      encoding: undefined,
      env: {
        ...env,
        CFG001_FRESH_RESET: "1",
        SUPABASE_TEST_URL: local.url,
        SUPABASE_TEST_PUBLISHABLE_KEY: local.publishableKey,
        SUPABASE_TEST_SECRET_KEY: local.secretKey,
      },
    },
  );
  if (failedChild(test)) {
    return typeof test.status === "number" && test.status !== 0 ? test.status : 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCfg001FreshReset();
}
