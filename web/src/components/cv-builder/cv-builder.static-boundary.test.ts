import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./cv-builder.tsx", import.meta.url)), "utf8");

describe("CvBuilder static AI boundary", () => {
  it("keeps the flow and dialog behind a direct compile-time AI flag guard", () => {
    expect(source).not.toMatch(/^import .*polish\/(polish-dialog|use-polish-flow)/m);
    expect(source).toMatch(
      /process\.env\.NEXT_PUBLIC_AI_POLISH_ENABLED === "true"\s*\/\/ eslint-disable-next-line @typescript-eslint\/no-require-imports[^\n]*\s*\?\s*require\("\.\/polish\/polish-dialog"\)\.PolishFlowProvider\s*:\s*null/,
    );
  });
});
