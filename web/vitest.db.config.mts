import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const isCfg001FreshReset = process.env.CFG001_FRESH_RESET === "1";
const isCfg002FreshReset = process.env.CFG002_FRESH_RESET === "1";
const isCfg003FreshReset = process.env.CFG003_FRESH_RESET === "1";

if ([isCfg001FreshReset, isCfg002FreshReset, isCfg003FreshReset].filter(Boolean).length > 1) {
  throw new Error("CFG001_FRESH_RESET, CFG002_FRESH_RESET, and CFG003_FRESH_RESET are mutually exclusive");
}

// Real-DB integration suite (unit 1.4): runs against a LOCAL Supabase
// instance, completely separate from the mocked unit suite
// (`vitest.config.mts`, `pnpm test`). Never pointed at a hosted project —
// the tests create/delete auth users and toggle the feature switch.
//
// Run via `pnpm --filter web test:db` (scripts/run-db-tests.mjs auto-detects
// `supabase status` and skips cleanly when no local instance is up).
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: isCfg001FreshReset
      ? ["test/db/deepseek-v2-cfg-seed.test.ts"]
      : isCfg002FreshReset
        ? ["test/db/mimo-v2-cfg-seed.test.ts"]
        : isCfg003FreshReset
          ? ["test/db/g4-routing-policy-cfg-seed.test.ts"]
          : ["test/db/**/*.test.ts"],
    exclude: isCfg001FreshReset || isCfg002FreshReset || isCfg003FreshReset
      ? []
      : [
        "test/db/deepseek-v2-cfg-seed.test.ts",
        "test/db/mimo-v2-cfg-seed.test.ts",
        "test/db/g4-routing-policy-cfg-seed.test.ts",
      ],
    // All files share one local Supabase (singleton feature config, global
    // daily counters, UTC-day rows), so files must run strictly in sequence.
    fileParallelism: false,
    // Concurrent-reserve bursts, auth user provisioning and minute-window
    // settling are slower than pure unit tests.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
