// Runs the dedicated Admin Playwright config and always removes its output.
// A failure during MFA enrollment must not leave a DOM snapshot containing a
// temporary TOTP seed on disk or in CI artifacts.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const playwrightCli = join(
  dirname(require.resolve("@playwright/test/package.json")),
  "cli.js",
);

let exitCode = 1;
try {
  exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [playwrightCli, "test", "--config", "playwright.admin.config.ts"],
      { cwd: webRoot, env: process.env, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Admin Playwright exited with ${signal}`));
      else resolve(code ?? 1);
    });
  });
} finally {
  await rm(join(webRoot, "test-results-admin"), {
    recursive: true,
    force: true,
  });
}

process.exitCode = exitCode;
