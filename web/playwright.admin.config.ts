import { defineConfig, devices } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";

function parseStatus(stdout: string) {
  const values: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) { if (!line.trim()) continue; const match = /^([A-Z][A-Z0-9_]*)="([^"]*)"$/.exec(line.trim()); if (!match || match[1] in values) return null; values[match[1]] = match[2].trim(); }
  return values.API_URL && values.PUBLISHABLE_KEY && values.SECRET_KEY ? { url: values.API_URL, publishableKey: values.PUBLISHABLE_KEY, secretKey: values.SECRET_KEY } : null;
}
const invocationRoot = process.cwd();
const repoRoot = basename(invocationRoot) === "web"
  ? resolve(invocationRoot, "..")
  : invocationRoot;
const status = spawnSync("pnpm", ["exec", "supabase", "status", "-o", "env"], {
  cwd: repoRoot,
  shell: process.platform === "win32",
  encoding: "utf8",
  timeout: 120_000,
});
const detected = parseStatus(status.stdout);
if (status.status !== 0 || status.error || !detected)
  throw new Error("Admin E2E requires local Supabase status -o env");
const endpoint = new URL(detected.url);
if (
  endpoint.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname) ||
  endpoint.port !== "54321" ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash ||
  !["", "/"].includes(endpoint.pathname)
) throw new Error("Admin E2E refuses a non-canonical local Supabase endpoint");
process.env.NEXT_PUBLIC_SUPABASE_URL = endpoint.origin;
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = detected.publishableKey;
process.env.SUPABASE_SERVICE_ROLE_KEY = detected.secretKey;
process.env.ADMIN_ENVIRONMENT = "local";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "admin-control-plane.spec.ts",
  outputDir: "test-results-admin",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4173",
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  globalSetup: "./e2e/admin-e2e-global-setup.mjs",
  globalTeardown: "./e2e/admin-e2e-global-teardown.mjs",
  webServer: { command: "node scripts/run-admin-e2e-server.mjs", url: "http://127.0.0.1:4173/en/admin", timeout: 240_000, reuseExistingServer: false, stdout: "pipe", stderr: "pipe" },
});
