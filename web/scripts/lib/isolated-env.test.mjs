import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { isolateProviderEnvironment } from "./isolated-env.mjs";
it("blocks inherited and dotenv provider inputs without changing unrelated configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "cv-isolation-"));
  try {
    const file = join(dir, ".env.local");
    writeFileSync(file, 'export AI_PROVIDER_KEY_MIMO_PRIVATE="secret"\nAI_PROVIDER_KEY_GEMINI_DOTENV=secret\nGOOGLE_API_KEY=secret\nDEEPSEEK_BASE_URL=https://example.test\n');
    const result = isolateProviderEnvironment({ AI_PROVIDER_KEY_DEEPSEEK_PRIMARY: "secret", AI_PROVIDER_KEY_GEMINI_PRIMARY: "secret", GEMINI_API_KEY: "secret", OPENAI_API_KEY: "secret", PORT: "4173" }, file);
    expect(result).toEqual({ AI_PROVIDER_KEY_DEEPSEEK_PRIMARY: "", AI_PROVIDER_KEY_MIMO_PRIVATE: "", AI_PROVIDER_KEY_GEMINI_PRIMARY: "", AI_PROVIDER_KEY_GEMINI_DOTENV: "", GOOGLE_API_KEY: "", GEMINI_API_KEY: "", DEEPSEEK_BASE_URL: "", OPENAI_API_KEY: "", PORT: "4173" });
  } finally { rmSync(dir, { recursive: true }); }
});
it("tolerates an absent optional env file", () => {
  expect(isolateProviderEnvironment({}, "/nonexistent/cv-test.env")).toEqual({});
});
