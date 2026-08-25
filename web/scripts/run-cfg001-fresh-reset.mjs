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

function fail(message) {
  console.error(`[test:db:cfg001-fresh] ERROR: ${message}`);
  process.exit(1);
}

function runNode(script, args, options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 300_000,
    ...options,
  });
  if (result.error) {
    fail(result.error.message);
  }
  return result;
}

function readLocalStatus() {
  const result = runNode(supabaseCli, ["status", "-o", "env"]);
  if (result.status !== 0) {
    fail("local Supabase is not running or its status could not be read.");
  }

  const values = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^([A-Z_]+)="([^"]*)"$/.exec(line.trim());
    if (match) {
      values[match[1]] = match[2];
    }
  }
  if (!values.API_URL || !values.PUBLISHABLE_KEY || !values.SECRET_KEY) {
    fail("Supabase status did not return the required local credentials.");
  }

  let apiUrl;
  try {
    apiUrl = new URL(values.API_URL);
  } catch {
    fail("Supabase status returned an invalid API_URL.");
  }
  if (
    apiUrl.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(apiUrl.hostname)
  ) {
    fail(`refusing to reset non-loopback Supabase URL ${apiUrl.origin}.`);
  }

  return {
    url: values.API_URL,
    publishableKey: values.PUBLISHABLE_KEY,
    secretKey: values.SECRET_KEY,
  };
}

if (!fs.existsSync(supabaseCli)) {
  fail("the workspace Supabase CLI is not installed.");
}
if (!fs.existsSync(vitestCli)) {
  fail("the web Vitest dependency is not installed.");
}

readLocalStatus();
console.log("[test:db:cfg001-fresh] resetting verified loopback Supabase");
const reset = runNode(supabaseCli, ["db", "reset"], {
  stdio: "inherit",
  encoding: undefined,
});
if (reset.status !== 0) {
  fail(`Supabase reset failed with exit code ${reset.status ?? "unknown"}.`);
}

const local = readLocalStatus();
console.log(`[test:db:cfg001-fresh] running against ${local.url}`);
const test = runNode(
  vitestCli,
  ["run", "--config", "vitest.db.config.mts"],
  {
    cwd: webRoot,
    stdio: "inherit",
    encoding: undefined,
    env: {
      ...process.env,
      CFG001_FRESH_RESET: "1",
      SUPABASE_TEST_URL: local.url,
      SUPABASE_TEST_PUBLISHABLE_KEY: local.publishableKey,
      SUPABASE_TEST_SECRET_KEY: local.secretKey,
    },
  },
);
process.exit(test.status ?? 1);
