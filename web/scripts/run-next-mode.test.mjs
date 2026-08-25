import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./run-next-mode.mjs", import.meta.url)), "utf8");

describe("run-next-mode static AI boundary", () => {
  it("injects a false public AI flag only for static builds", () => {
    expect(source).toContain('...(mode === "static" ? { NEXT_PUBLIC_AI_POLISH_ENABLED: "false" } : {}),');
  });

  it("keeps the conflicting static flag guard ahead of generated-route mutation", () => {
    expect(source.indexOf("checkFlagConsistency(mode);")).toBeLessThan(source.indexOf("await syncApiRoutes(mode);"));
  });
});
