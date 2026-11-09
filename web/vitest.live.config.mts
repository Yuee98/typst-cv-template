import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

if (process.env.CV_PROVIDER_LIVE_SMOKE !== "true") {
  throw new Error("Live Provider tests require the explicit test:providers:live command.");
}
if (process.env.CI === "true" || process.env.VERCEL_ENV) {
  throw new Error("Paid Provider smoke tests run only in an explicitly selected local session.");
}

export default defineConfig({
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/live/provider-live.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
