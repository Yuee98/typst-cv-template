/**
 * Hard-fail CFG-003 routing-policy seed gate. The target is proved loopback
 * both before and after reset; this command never falls back to the ordinary
 * optional DB run.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseSupabaseProjectId,
  waitForAuthReady,
} from "./run-cfg001-fresh-reset.mjs";
import {
  parseSupabaseStatus,
  validateLocalDatabaseUrl,
} from "./run-db-tests.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptsDir, "..");
const repoRoot = path.resolve(webRoot, "..");
const supabaseCli = path.join(repoRoot, "node_modules", "supabase", "dist", "supabase.js");
const vitestCli = path.join(webRoot, "node_modules", "vitest", "vitest.mjs");
const supabaseConfig = path.join(repoRoot, "supabase", "config.toml");
const requiredMigrations = [
  path.join(repoRoot, "supabase", "migrations", "20260824007000_seed_g4_routing_policy.sql"),
  path.join(repoRoot, "supabase", "migrations", "20260824008000_seed_weekday_routing_policy.sql"),
];
const requiredTest = path.join(webRoot, "test", "db", "g4-routing-policy-cfg-seed.test.ts");
const CHILD_TIMEOUT_MS = 300_000;
const KONG_RESTART_TIMEOUT_MS = 120_000;

function failedChild(result) {
  return Boolean(result?.error || result?.signal || result?.status === null || result?.status !== 0);
}

function parseLocalStatus(stdout) {
  const values = parseSupabaseStatus(String(stdout ?? ""));
  if (!values) return null;
  const validated = validateLocalDatabaseUrl(values.url);
  return validated.ok
    ? { url: validated.url, publishableKey: values.publishableKey, secretKey: values.secretKey }
    : null;
}

/** Injectable runner; returns an exit code instead of calling process.exit. */
export async function runCfg003FreshReset({
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
    errorLogger(`[test:db:cfg003-fresh] ERROR: ${message}`);
    return 1;
  };
  const runNode = (script, args, options = {}) => spawnSyncImpl(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
    ...options,
  });
  const readLocalStatus = () => {
    const result = runNode(supabaseCli, ["status", "-o", "env"]);
    return failedChild(result) ? null : parseLocalStatus(result.stdout);
  };

  if (!existsSyncImpl(supabaseCli)) return fail("the workspace Supabase CLI is not installed.");
  if (!existsSyncImpl(vitestCli)) return fail("the web Vitest dependency is not installed.");
  if (!existsSyncImpl(supabaseConfig)) return fail("supabase/config.toml is missing.");
  if (requiredMigrations.some((migration) => !existsSyncImpl(migration))) return fail("a required CFG-003 routing-policy migration is missing.");
  if (!existsSyncImpl(requiredTest)) return fail("the required CFG-003 routing-policy database test is missing.");

  let config;
  try {
    config = readFileSyncImpl(supabaseConfig, "utf8");
  } catch {
    return fail("supabase/config.toml could not be read.");
  }
  const projectId = parseSupabaseProjectId(config);
  if (!projectId) return fail("supabase/config.toml has an invalid or ambiguous project_id.");
  if (!readLocalStatus()) return fail("local Supabase is unavailable or did not report safe loopback credentials.");

  logger("[test:db:cfg003-fresh] resetting verified loopback Supabase");
  const reset = runNode(supabaseCli, ["db", "reset"], { stdio: "inherit", encoding: undefined });
  if (failedChild(reset)) return fail("Supabase reset failed.");

  const local = readLocalStatus();
  if (!local) return fail("reset Supabase did not report safe loopback credentials.");
  const restart = spawnSyncImpl("docker", ["restart", `supabase_kong_${projectId}`], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: KONG_RESTART_TIMEOUT_MS,
  });
  if (failedChild(restart)) return fail("local Supabase gateway restart failed.");
  if (!await waitForAuthReady(local.url, { fetchImpl, ...(sleepImpl ? { sleepImpl } : {}) })) {
    return fail("local Supabase Auth did not become ready after gateway restart.");
  }

  const test = runNode(vitestCli, ["run", "--config", "vitest.db.config.mts"], {
    cwd: webRoot,
    stdio: "inherit",
    encoding: undefined,
    env: {
      ...env,
      CFG001_FRESH_RESET: undefined,
      CFG002_FRESH_RESET: undefined,
      CFG003_FRESH_RESET: "1",
      SUPABASE_TEST_URL: local.url,
      SUPABASE_TEST_PUBLISHABLE_KEY: local.publishableKey,
      SUPABASE_TEST_SECRET_KEY: local.secretKey,
    },
  });
  return failedChild(test) ? (typeof test.status === "number" && test.status !== 0 ? test.status : 1) : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCfg003FreshReset();
}
