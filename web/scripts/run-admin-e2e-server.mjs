// Server-mode launcher for the real local-Supabase Admin browser gate.
// AI stays disabled and no Provider credential is inherited or loaded.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const providerSecretName = /^(?:AI_PROVIDER_KEY_[A-Z0-9_]+|DEEPSEEK_API_KEY|MIMO_API_KEY|OPENROUTER_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)$/u;
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !providerSecretName.test(name)),
);

Object.assign(env, {
  CI: "true",
  NEXT_TELEMETRY_DISABLED: "1",
  STATIC_EXPORT: "false",
  ADMIN_ENVIRONMENT: "local",
  NEXT_PUBLIC_AI_POLISH_ENABLED: "false",
  AI_POLISH_ENABLED: "false",
  POLISH_FAKE_LLM: "",
  POLISH_FAKE_BACKEND: "",
  AI_RUNTIME_BUILD_ID: "",
  AI_PROVIDER_BINDING_MANIFEST: "",
  AI_USER_ID_HMAC_SECRET: "",
  DEEPSEEK_API_KEY: "",
  MIMO_API_KEY: "",
  OPENROUTER_API_KEY: "",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  DEEPSEEK_BASE_URL: "",
  MIMO_BASE_URL: "",
  OPENROUTER_BASE_URL: "",
  PORT: "4173",
  HOSTNAME: "127.0.0.1",
});

// Next loads .env.local itself. Shadow any provider namespace names found
// there without reading or printing their values.
try {
  for (const line of readFileSync(join(root, ".env.local"), "utf8").split(/\r?\n/u)) {
    const match = /^\s*(AI_PROVIDER_KEY_[A-Z0-9_]+)\s*=/.exec(line);
    if (match) env[match[1]] = "";
  }
} catch {
  // A local env file is optional.
}

if (
  !env.NEXT_PUBLIC_SUPABASE_URL ||
  !env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  !env.SUPABASE_SERVICE_ROLE_KEY
) {
  throw new Error("Admin E2E server requires local Supabase credentials");
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd: root,
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${file} exited with ${signal}`));
      else if (code === 0) resolve();
      else reject(new Error(`${file} exited ${code ?? "unknown"}`));
    });
  });
}

await run(join(root, "scripts", "sync-typst-assets.mjs"), []);
await run(join(root, "scripts", "run-next-mode.mjs"), ["build", "server"]);

const nextBin = join(
  dirname(createRequire(import.meta.url).resolve("next/package.json")),
  "dist",
  "bin",
  "next",
);
const server = spawn(
  process.execPath,
  [nextBin, "start", "-H", "127.0.0.1", "-p", "4173"],
  { cwd: root, env, stdio: "inherit" },
);
let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  server.kill(signal);
}
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
server.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
server.once("exit", (code, signal) => {
  if (!stopping && signal) process.exitCode = 1;
  else if (!signal) process.exitCode = code ?? 1;
});
