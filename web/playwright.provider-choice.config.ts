import { defineConfig, devices } from "@playwright/test";

// Independent credential-free fixture: never read local Supabase status or a hosted URL.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "provider-choice.spec.ts",
  outputDir: "test-results/provider-choice",
  timeout: 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4173",
    serviceWorkers: "block",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command: "node scripts/run-provider-choice-e2e-server.mjs",
    url: "http://127.0.0.1:4173/en",
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
