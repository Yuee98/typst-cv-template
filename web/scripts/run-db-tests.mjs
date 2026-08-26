/**
 * Runs real-DB tests against local Supabase. Developer runs skip when it is
 * unavailable; CI sets DB_TESTS_REQUIRED=1 so every preflight failure fails.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptsDir, "..");
const repoRoot = path.resolve(webRoot, "..");
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const DB_CHILD_TIMEOUT_MS = 600_000;

function isRequired(env) {
  return env.DB_TESTS_REQUIRED === "1" || env.DB_TESTS_REQUIRED === "true";
}

function logTo(logger, message) {
  logger(`[test:db] ${message}`);
}

function unavailable({ required, logger }, reason) {
  if (required) {
    logTo(logger, `ERROR: ${reason}`);
    return 1;
  }
  logTo(logger, `SKIP: ${reason}`);
  logTo(logger, "Start local Supabase (`pnpm supabase:start` at the repo root), then re-run.");
  return 0;
}

function normalizeHostname(hostname) {
  return hostname.replace(/^\[|\]$/g, "");
}

/** Refuses anything that could direct mutating tests outside local Supabase. */
export function validateLocalDatabaseUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "URL is malformed" };
  }
  if (url.protocol !== "http:") return { ok: false, reason: "URL must use HTTP" };
  if (url.username || url.password) return { ok: false, reason: "URL credentials are not allowed" };
  if (!LOOPBACK_HOSTNAMES.has(normalizeHostname(url.hostname))) {
    return { ok: false, reason: "URL host must be loopback" };
  }
  return { ok: true, url: url.toString() };
}

function parseSupabaseStatus(stdout) {
  const values = {};
  for (const line of (stdout ?? "").split(/\r?\n/)) {
    if (line.trim() && !/^[A-Z_]+="[^"]*"$/.test(line.trim())) return null;
    const match = /^([A-Z_]+)="([^"]*)"$/.exec(line.trim());
    if (match) {
      if (match[1] in values) return null;
      values[match[1]] = match[2].trim();
    }
  }
  if (!values.API_URL || !values.PUBLISHABLE_KEY || !values.SECRET_KEY) return null;
  return {
    url: values.API_URL,
    publishableKey: values.PUBLISHABLE_KEY,
    secretKey: values.SECRET_KEY,
  };
}

function explicitCredentials(env) {
  const present = ["SUPABASE_TEST_URL", "SUPABASE_TEST_PUBLISHABLE_KEY", "SUPABASE_TEST_SECRET_KEY"]
    .map((key) => Object.prototype.hasOwnProperty.call(env, key));
  if (!present.some(Boolean)) return { kind: "absent" };
  const values = {
    url: typeof env.SUPABASE_TEST_URL === "string" ? env.SUPABASE_TEST_URL.trim() : "",
    publishableKey: typeof env.SUPABASE_TEST_PUBLISHABLE_KEY === "string" ? env.SUPABASE_TEST_PUBLISHABLE_KEY.trim() : "",
    secretKey: typeof env.SUPABASE_TEST_SECRET_KEY === "string" ? env.SUPABASE_TEST_SECRET_KEY.trim() : "",
  };
  return Object.values(values).every(Boolean)
    ? { kind: "complete", values }
    : { kind: "invalid" };
}

function runSupabaseStatus(spawnSyncImpl) {
  return spawnSyncImpl("pnpm", ["exec", "supabase", "status", "-o", "env"], {
    cwd: repoRoot,
    shell: process.platform === "win32",
    encoding: "utf8",
    timeout: 120_000,
  });
}

async function isReachable(url, fetchImpl) {
  try {
    // Even a 4xx response proves local PostgREST is reachable.
    await fetchImpl(`${url.replace(/\/+$/, "")}/rest/v1/`, {
      signal: AbortSignal.timeout(3_000),
    });
    return true;
  } catch {
    return false;
  }
}

/** Injectable runner; returns an exit code instead of calling process.exit. */
export async function runDbTests({
  env = process.env,
  spawnSyncImpl = spawnSync,
  fetchImpl = fetch,
  logger = console.log,
} = {}) {
  const context = { required: isRequired(env), logger };
  const explicit = explicitCredentials(env);
  let detected;

  if (explicit.kind === "invalid") {
    logTo(logger, "ERROR: SUPABASE_TEST_* credentials are incomplete or blank.");
    return 1;
  }
  if (explicit.kind === "complete") {
    detected = explicit.values;
  } else {
    const status = runSupabaseStatus(spawnSyncImpl);
    if (status.error || status.signal || status.status !== 0) {
      return unavailable(context, "could not obtain local Supabase status.");
    }
    detected = parseSupabaseStatus(status.stdout);
    if (!detected) {
      logTo(logger, "ERROR: local Supabase status output is malformed or incomplete.");
      return 1;
    }
  }

  const validUrl = validateLocalDatabaseUrl(detected.url);
  if (!validUrl.ok) {
    // An unsafe target is never a harmless local skip.
    logTo(logger, `ERROR: refusing database test endpoint: ${validUrl.reason}.`);
    return 1;
  }
  if (!(await isReachable(validUrl.url, fetchImpl))) {
    return unavailable(context, "local Supabase API is unreachable.");
  }

  logTo(logger, "running the full real-DB suite against local Supabase.");
  const fullSuiteEnv = {
    ...env,
    SUPABASE_TEST_URL: validUrl.url,
    SUPABASE_TEST_PUBLISHABLE_KEY: detected.publishableKey,
    SUPABASE_TEST_SECRET_KEY: detected.secretKey,
  };
  // The ordinary gate must never inherit the isolated fresh-reset selector.
  delete fullSuiteEnv.CFG001_FRESH_RESET;

  const run = spawnSyncImpl("pnpm", ["exec", "vitest", "run", "--config", "vitest.db.config.mts"], {
    cwd: webRoot,
    shell: process.platform === "win32",
    stdio: "inherit",
    timeout: DB_CHILD_TIMEOUT_MS,
    env: fullSuiteEnv,
  });
  if (run.error || run.signal || run.status === null || run.status !== 0) {
    return typeof run.status === "number" && run.status !== 0 ? run.status : 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runDbTests();
}
