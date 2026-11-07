import { readFileSync } from "node:fs";
// Denied inputs, not supported application aliases. E2E must not inherit live upstream credentials.
const secretInput = /^(?:AI_PROVIDER_KEY_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_API_KEY|[A-Z][A-Z0-9_]*_BASE_URL)$/;
export function isolateProviderEnvironment(source, envFile) {
  const env = { ...source };
  for (const name of Object.keys(env)) if (secretInput.test(name)) env[name] = "";
  try {
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const name = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1];
      if (name && secretInput.test(name)) env[name] = "";
    }
  } catch (error) { if (error.code !== "ENOENT") throw new Error("Unable to verify isolated environment inputs"); }
  return env;
}
