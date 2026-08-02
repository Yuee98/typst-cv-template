/**
 * Runs the real-DB integration suite (test/db, unit 1.4) against a local
 * Supabase instance.
 *
 * Connection settings are auto-detected from `supabase status -o env` run at
 * the repo root. When the Supabase CLI or the local instance is unavailable
 * the run is SKIPPED with exit code 0 (never a hard failure), so this script
 * is safe on machines without Docker. CI provides the same auto-detection
 * after `supabase start`; the three SUPABASE_TEST_* variables can also be
 * exported manually to bypass CLI detection.
 *
 * Local usage:
 *   pnpm supabase:start        # repo root, once
 *   pnpm supabase:reset        # optional but recommended: clean schema+seed
 *   pnpm --filter web test:db
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptsDir, "..");
const repoRoot = path.resolve(webRoot, "..");

function log(message) {
  console.log(`[test:db] ${message}`);
}

function skip(reason) {
  log(`SKIP: ${reason}`);
  log("Start local Supabase (`pnpm supabase:start` at the repo root), then re-run.");
  process.exit(0);
}

function detectFromSupabaseCli() {
  const result = spawnSync("pnpm exec supabase status -o env", {
    cwd: repoRoot,
    shell: true,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const values = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^([A-Z_]+)="([^"]*)"$/.exec(line.trim());
    if (match) {
      values[match[1]] = match[2];
    }
  }
  if (!values.API_URL || !values.PUBLISHABLE_KEY || !values.SECRET_KEY) {
    return null;
  }
  return {
    url: values.API_URL,
    publishableKey: values.PUBLISHABLE_KEY,
    secretKey: values.SECRET_KEY,
  };
}

function fromProcessEnv() {
  const { SUPABASE_TEST_URL, SUPABASE_TEST_PUBLISHABLE_KEY, SUPABASE_TEST_SECRET_KEY } =
    process.env;
  if (SUPABASE_TEST_URL && SUPABASE_TEST_PUBLISHABLE_KEY && SUPABASE_TEST_SECRET_KEY) {
    return {
      url: SUPABASE_TEST_URL,
      publishableKey: SUPABASE_TEST_PUBLISHABLE_KEY,
      secretKey: SUPABASE_TEST_SECRET_KEY,
    };
  }
  return null;
}

async function isReachable(url) {
  try {
    // Any HTTP response (even 4xx) proves PostgREST is up; only network
    // errors mean "no local Supabase".
    await fetch(`${url}/rest/v1/`, { signal: AbortSignal.timeout(3_000) });
    return true;
  } catch {
    return false;
  }
}

const detected = fromProcessEnv() ?? detectFromSupabaseCli();
if (!detected) {
  skip("could not detect a local Supabase instance (supabase CLI status failed).");
}
if (!(await isReachable(detected.url))) {
  skip(`local Supabase at ${detected.url} is unreachable.`);
}

log(`running against ${detected.url}`);
const run = spawnSync("pnpm exec vitest run --config vitest.db.config.mts", {
  cwd: webRoot,
  shell: true,
  stdio: "inherit",
  env: {
    ...process.env,
    SUPABASE_TEST_URL: detected.url,
    SUPABASE_TEST_PUBLISHABLE_KEY: detected.publishableKey,
    SUPABASE_TEST_SECRET_KEY: detected.secretKey,
  },
});
process.exit(run.status ?? 1);
