import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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
    include: ["test/db/**/*.test.ts"],
    // All files share one local Supabase (singleton feature config, global
    // daily counters, UTC-day rows), so files must run strictly in sequence.
    fileParallelism: false,
    // Concurrent-reserve bursts, auth user provisioning and minute-window
    // settling are slower than pure unit tests.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
