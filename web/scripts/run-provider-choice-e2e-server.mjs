// Chromium provider-choice fixture: real Next HTTP + paired fake execution only.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolateProviderEnvironment } from "./lib/isolated-env.mjs";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fakeDatabasePort = 54329;
const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(fakeDatabasePort, "127.0.0.1", resolve);
});
await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));

const env = {
  ...isolateProviderEnvironment(process.env, join(webRoot, ".env.local")),
  CI: "true",
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_OPTIONS: "",
  STATIC_EXPORT: "false",
  VERCEL: "",
  VERCEL_ENV: "",
  ADMIN_ENVIRONMENT: "local",
  POLISH_FAKE_BACKEND: "true",
  POLISH_FAKE_LLM: "true",
  NEXT_PUBLIC_AI_POLISH_MOCK: "false",
  AI_POLISH_ENABLED: "true",
  NEXT_PUBLIC_AI_POLISH_ENABLED: "true",
  NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${fakeDatabasePort}`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_provider_choice_local_fixture",
  SUPABASE_SERVICE_ROLE_KEY: "",
  AI_USER_ID_HMAC_SECRET: "",
  PORT: "4173",
  HOSTNAME: "127.0.0.1",
};

function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: webRoot, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal || code !== 0) reject(new Error(`Provider-choice build failed (${signal ?? code})`));
      else resolve();
    });
  });
}
await run(join(webRoot, "scripts/sync-typst-assets.mjs"), []);
await run(join(webRoot, "scripts/run-next-mode.mjs"), ["build", "server"]);
const nextBin = join(dirname(createRequire(import.meta.url).resolve("next/package.json")), "dist/bin/next");
const clockModule = new URL("../e2e/provider-choice-clock.mjs", import.meta.url).href;
const server = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", "4173"], {
  cwd: webRoot,
  env: { ...env, NODE_OPTIONS: `--import=${clockModule}` },
  stdio: "inherit",
});
let stopping = false;
function stop(signal) { if (!stopping) { stopping = true; server.kill(signal); } }
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
server.once("error", () => { process.exitCode = 1; });
server.once("exit", (code, signal) => { process.exitCode = signal && stopping ? 0 : code ?? 1; });
