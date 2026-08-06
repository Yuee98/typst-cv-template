// Credential-free server-mode launcher for Playwright.
//
// The launcher owns the build and start lifecycle so the E2E command does not
// depend on a shell-specific `&&` chain or on a developer's .env.local file.
// It always uses a fixed loopback port and neutralizes hosted-service secrets.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = "4173";

const env = {
  ...process.env,
  CI: "true",
  NEXT_TELEMETRY_DISABLED: "1",
  POLISH_FAKE_LLM: "true",
  POLISH_FAKE_BACKEND: "true",
  AI_POLISH_ENABLED: "true",
  NEXT_PUBLIC_AI_POLISH_ENABLED: "false",
  // Empty values override any matching .env.local entry that Next may find;
  // the E2E run must never contact a hosted Supabase or DeepSeek service.
  NEXT_PUBLIC_SUPABASE_URL: "",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  DEEPSEEK_API_KEY: "",
  DEEPSEEK_BASE_URL: "",
  AI_USER_ID_HMAC_SECRET: "",
  PORT: port,
  HOSTNAME: "127.0.0.1",
};

function runToCompletion(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: webRoot,
      env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} exited with ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
        return;
      }
      resolve();
    });
  });
}

const modeScript = join(webRoot, "scripts", "run-next-mode.mjs");
const syncScript = join(webRoot, "scripts", "sync-typst-assets.mjs");
await runToCompletion(process.execPath, [syncScript]);
await runToCompletion(process.execPath, [modeScript, "build", "server"]);

const require = createRequire(import.meta.url);
const nextBin = join(dirname(require.resolve("next/package.json")), "dist", "bin", "next");
const server = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", port], {
  cwd: webRoot,
  env,
  stdio: "inherit",
});

let stopping = false;
function stopServer(signal) {
  if (stopping) return;
  stopping = true;
  server.kill(signal);
}

process.once("SIGINT", () => stopServer("SIGINT"));
process.once("SIGTERM", () => stopServer("SIGTERM"));

server.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
server.once("exit", (code, signal) => {
  if (signal && !stopping) {
    console.error(`next start exited with ${signal}`);
    process.exitCode = 1;
  } else if (!signal) {
    process.exitCode = code ?? 1;
  }
});
