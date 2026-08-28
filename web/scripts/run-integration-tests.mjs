/**
 * Real-key integration smoke for the AI polish API (unit 4.1).
 *
 *   pnpm --filter web test:integration        (repo root: pnpm test:integration)
 *
 * Unlike test:db (which skips when no local Supabase is found) this script is
 * a HARD-FAIL preflight: it exists to prove the real chain works, so a missing
 * prerequisite is an error, never a silent skip. It runs the full production
 * wiring — a selected real official provider + real local Supabase backend — with NO
 * POLISH_FAKE_LLM / POLISH_FAKE_BACKEND flags, and is therefore LOCAL-ONLY:
 * it is not part of CI (real API calls cost money) and refuses to run when
 * CI=true.
 *
 * Chain under test (roadmap「集成冒烟」):
 *   gotrue password grant (real login) → terms gate → POST /api/polish 200 →
 *   ai_request_ledger / ai_usage_daily side effects → clientRequestId dedup
 *   409 → cancel-while-in-flight settlement (status=canceled, charged;
 *   billability null/unknown when the abort lands before usage returns).
 *
 * Cost discipline: the run makes 2 USER-VISIBLE polish requests (one success,
 * one canceled); each may use up to 2 internal provider attempts, so the
 * budget is ≤4 provider transmissions (typical: 2). The run validates the
 * DB-frozen usage/cost aggregates without printing token or cost values.
 *
 * Release-gate integrity (CP4 round-1):
 *   - NEXT_PUBLIC_SUPABASE_URL must be loopback http, AND must match the
 *     URL/keys reported by `supabase status` — the script creates smoke users
 *     and terms acceptances with the service key, but never flips runtime
 *     configuration, so it must never touch a hosted project.
 *   - the server build is REBUILT by default every run (testing the current
 *     head); --reuse-build is an explicit iteration-only opt-in.
 *   - build and start both get explicit POLISH_FAKE_LLM=false /
 *     POLISH_FAKE_BACKEND=false / CI=false (process.env beats .env.local).
 *   - fake, custom, proxy, and cross-profile upstream configuration is
 *     rejected. The V2 adapter resolves its endpoint from the code-owned
 *     route authority, so this harness must not imply proxy coverage.
 *
 * Red lines (roadmap 禁存清单): this script never prints request/response
 * bodies, polished text, access tokens, or any key. Only statuses, error
 * codes, request ids and usage/latency NUMBERS appear in its output.
 *
 * Prerequisites (web/.env.local, never committed):
 *   DEEPSEEK_API_KEY or MIMO_API_KEY (selected by --profile),
 *   SUPABASE_SERVICE_ROLE_KEY (from `supabase status`),
 *   AI_USER_ID_HMAC_SECRET (`openssl rand -hex 32`), AI_POLISH_ENABLED=true,
 *   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
 * plus a running local Supabase (the workspace Supabase CLI at the repo root).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createClient } from "@supabase/supabase-js";
import {
  buildExpectedRouteV1,
  evaluateRunLedgerEvidence,
  resolveIntegrationProfile,
  sameExpectedRouteV1,
} from "./lib/integration-ledger-evidence.mjs";
import { checkLocalSupabaseUrl, isOfficialDeepSeekBaseUrl } from "./lib/local-safety.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptsDir, "..");
const repoRoot = path.resolve(webRoot, "..");
const supabaseCli = path.join(repoRoot, "node_modules", "supabase", "dist", "supabase.js");
const syncTypstAssetsScript = path.join(scriptsDir, "sync-typst-assets.mjs");
const runNextModeScript = path.join(scriptsDir, "run-next-mode.mjs");

const PORT = Number(process.env.INTEGRATION_SMOKE_PORT ?? 3123);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AVAILABILITY_TIMEOUT_MS = 10_000;
const POLISH_REQUEST_TIMEOUT_MS = 75_000;
const UPSTREAM_URL_ENV_NAMES = Object.freeze([
  "DEEPSEEK_BASE_URL", "MIMO_BASE_URL", "AI_BASE_URL", "OPENROUTER_BASE_URL",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
  "GLOBAL_AGENT_HTTP_PROXY", "GLOBAL_AGENT_HTTPS_PROXY",
]);

// Explicit opt-in (off by default — the default is release-gate safe).
//   --reuse-build            skip build:server and reuse the existing .next
let reuseBuild = false;
let profileName = "deepseek";
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--reuse-build") {
    reuseBuild = true;
  } else if (arg === "--profile") {
    profileName = args[index + 1] ?? "";
    index += 1;
  } else if (arg.startsWith("--profile=")) {
    profileName = arg.slice("--profile=".length);
  } else {
    console.error(`[test:integration] unknown argument: ${arg}`);
    console.error(
      "usage: node scripts/run-integration-tests.mjs [--profile deepseek|mimo] [--reuse-build]",
    );
    process.exit(1);
  }
}

let failures = 0;

function log(message) {
  console.log(`[test:integration] ${message}`);
}

function check(label, ok, detail) {
  if (ok) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Fatal preflight/setup failure: reported, then the run unwinds to cleanup. */
class FatalSmokeError extends Error {}

function fatal(message, detail) {
  console.error(`[test:integration] FATAL: ${message}${detail ? `\n${detail}` : ""}`);
  throw new FatalSmokeError(message);
}

function preflightProfile() {
  try {
    return resolveIntegrationProfile(profileName);
  } catch (error) {
    fatal(error instanceof Error ? error.message : "invalid integration profile");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `probe()` until it returns a truthy value; null on timeout. */
async function pollUntil(probe, { timeoutMs, intervalMs }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Environment (web/.env.local, with process.env taking precedence)
// ---------------------------------------------------------------------------

function loadEnvFile(filePath) {
  // node:util parseEnv — the SAME parser Node uses for --env-file, so quoting
  // and comment edge cases behave exactly like `next start`'s own loading.
  if (!existsSync(filePath)) return {};
  return parseEnv(readFileSync(filePath, "utf8"));
}

const fileEnv = loadEnvFile(path.join(webRoot, ".env.local"));
const getEnv = (name) => process.env[name]?.trim() || fileEnv[name]?.trim() || "";

function preflightEnv() {
  if (process.env.CI === "true") {
    fatal(
      "refusing to run under CI=true: the integration smoke spends real DeepSeek " +
        "tokens and is a local-only tool (it must never be wired into CI).",
    );
  }
  const required = [
    integrationProfile.credentialEnv,
    "SUPABASE_SERVICE_ROLE_KEY",
    "AI_USER_ID_HMAC_SECRET",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  ];
  const missing = required.filter((name) => !getEnv(name));
  if (missing.length > 0) {
    fatal(
      `web/.env.local is missing required variable(s): ${missing.join(", ")}`,
      "See web/README.md「AI polish local smoke & metrics」for how to fill them.",
    );
  }
  if (getEnv("AI_POLISH_ENABLED") !== "true") {
    fatal('AI_POLISH_ENABLED must be "true" in web/.env.local for the real smoke.');
  }
  for (const name of ["POLISH_FAKE_LLM", "POLISH_FAKE_BACKEND"]) {
    if (getEnv(name) === "true") {
      fatal(`${name}=true is incompatible with a real-provider integration proof.`);
    }
  }
}

/**
 * P0-1: the configured Supabase URL must be loopback http BEFORE any client
 * is constructed — the smoke creates users and accepts terms with the
 * service-role key, so a hosted/staging URL here is a destructive-safety bug.
 */
function preflightLocalSupabaseUrl(supabaseUrl) {
  const result = checkLocalSupabaseUrl(supabaseUrl);
  if (!result.ok) {
    fatal(
      `refusing non-local Supabase URL (${result.reason}).`,
      "The real-key integration smoke creates users and accepts AI terms; " +
        "NEXT_PUBLIC_SUPABASE_URL must be http://127.0.0.1 / localhost / [::1].",
    );
  }
}

/**
 * Reject custom, proxy, and unused provider upstream overrides before any
 * mutation. The V2 adapter resolves exact endpoints from route authority;
 * accepting a custom variable would falsely imply proxy coverage.
 */
function preflightUpstream() {
  const deepseekBaseUrl = getEnv("DEEPSEEK_BASE_URL");
  if (integrationProfile.name !== "deepseek" && deepseekBaseUrl) {
    fatal(
      "DEEPSEEK_BASE_URL is forbidden for the MiMo smoke, including the official origin.",
      "The selected route must be code/DB-owned without an ambient cross-profile override.",
    );
  }
  if (deepseekBaseUrl && !isOfficialDeepSeekBaseUrl(deepseekBaseUrl)) {
    fatal(
      "DEEPSEEK_BASE_URL is set to a non-official origin — this smoke proves only exact official provider routes.",
      "Unset custom/proxy upstream variables before running.",
    );
  }
  for (const name of UPSTREAM_URL_ENV_NAMES.filter((name) => name !== "DEEPSEEK_BASE_URL")) {
    if (getEnv(name)) {
      fatal(`${name} is unsupported by the exact-route integration smoke.`, "Unset custom upstream variables before running.");
    }
  }
}

/**
 * P0-1 (strong form): the configured URL/keys must match the LOCAL instance
 * the Supabase CLI reports — otherwise the service key belongs to a DIFFERENT
 * project than the verified-local one. Never prints key material, only names.
 */
function preflightSupabaseCliMatch() {
  if (!existsSync(supabaseCli)) {
    fatal("the workspace Supabase CLI is not installed.");
  }
  const status = spawnSync(process.execPath, [supabaseCli, "status", "-o", "env"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (status.error || status.status !== 0) {
    fatal(
      "local Supabase is not running (`supabase status` failed).",
      "Start the verified local Supabase project, then re-run.",
    );
  }
  const reported = {};
  for (const line of status.stdout.split(/\r?\n/)) {
    const match = /^([A-Z_]+)="([^"]*)"$/.exec(line.trim());
    if (match) reported[match[1]] = match[2];
  }
  if (!reported.API_URL || !reported.PUBLISHABLE_KEY || !reported.SECRET_KEY) {
    fatal("could not parse `supabase status -o env` output (API_URL/keys missing).");
  }
  const stripSlash = (value) => value.replace(/\/+$/, "");
  if (stripSlash(reported.API_URL) !== stripSlash(getEnv("NEXT_PUBLIC_SUPABASE_URL"))) {
    fatal(
      `NEXT_PUBLIC_SUPABASE_URL (${stripSlash(getEnv("NEXT_PUBLIC_SUPABASE_URL"))}) does not ` +
        `match the local instance's API_URL (${stripSlash(reported.API_URL)}).`,
      "Refusing to run: the smoke would mutate a different project than the CLI-verified local one.",
    );
  }
  if (reported.PUBLISHABLE_KEY !== getEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")) {
    fatal(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY does not match the publishable key reported " +
        "by `supabase status` for the local instance (value never printed).",
    );
  }
  if (reported.SECRET_KEY !== getEnv("SUPABASE_SERVICE_ROLE_KEY")) {
    fatal(
      "SUPABASE_SERVICE_ROLE_KEY does not match the secret key reported by `supabase status` " +
        "for the local instance (value never printed).",
    );
  }
}

async function preflightReachable(supabaseUrl) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/`, { signal: AbortSignal.timeout(3_000) });
  } catch {
    fatal(`local Supabase at ${supabaseUrl} is unreachable.`);
  }
}

// ---------------------------------------------------------------------------
// Server build + start (real mode — fake flags are overridden explicitly)
// ---------------------------------------------------------------------------

/**
 * P0-2.2: deleting POLISH_FAKE_* from the child env is NOT enough — Next
 * reloads absent variables from .env.local, and a CI=true line there would
 * activate the fake-in-production CI exemption. process.env beats .env
 * files, so build AND start get explicit "false" values. CI is forced to
 * "false" for the same reason (the guard checks exact-string "true").
 */
function realModeEnv() {
  return {
    POLISH_FAKE_LLM: "false",
    POLISH_FAKE_BACKEND: "false",
    CI: "false",
  };
}

/** The server config shared by build and start, from .env.local/process.env. */
function forwardedServerEnv() {
  // Explicit empty values win over .env.local loading in child Next processes.
  // A selected smoke profile must never gain a second credential or fallback.
  const env = {
    DEEPSEEK_API_KEY: "",
    MIMO_API_KEY: "",
    OPENROUTER_API_KEY: "",
  };
  for (const name of UPSTREAM_URL_ENV_NAMES) env[name] = "";
  for (const name of [
    integrationProfile.credentialEnv,
    "SUPABASE_SERVICE_ROLE_KEY",
    "AI_USER_ID_HMAC_SECRET",
    "AI_POLISH_ENABLED",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  ]) {
    const value = getEnv(name);
    if (value) env[name] = value;
  }
  return env;
}

function ensureServerBuild() {
  const buildId = path.join(webRoot, ".next", "BUILD_ID");
  const polishRoute = path.join(webRoot, ".next", "server", "app", "api", "polish");
  // P0-2.1: a reused .next can belong to a previous commit and produce a
  // false green — the default is ALWAYS to rebuild the current head;
  // --reuse-build stays as an explicit iteration-only opt-in.
  if (reuseBuild && existsSync(buildId) && existsSync(polishRoute)) {
    log("--reuse-build: reusing the existing .next build (iteration opt-in, not a release proof)");
    return;
  }
  log(
    reuseBuild
      ? "--reuse-build requested but no server build found — rebuilding the server directly…"
      : "building the current head (default; may take minutes — --reuse-build opts out for iteration)…",
  );
  const childEnv = { ...process.env, ...realModeEnv(), ...forwardedServerEnv() };
  const syncAssets = spawnSync(process.execPath, [syncTypstAssetsScript], {
    cwd: webRoot,
    stdio: "inherit",
    timeout: 900_000,
    env: childEnv,
  });
  if (syncAssets.error || syncAssets.status !== 0) {
    fatal("direct Typst asset sync failed; see the build output above.");
  }
  const build = spawnSync(process.execPath, [runNextModeScript, "build", "server"], {
    cwd: webRoot,
    stdio: "inherit",
    timeout: 900_000,
    env: childEnv,
  });
  if (build.error || build.status !== 0) {
    fatal("direct server build failed; see the build output above.");
  }
  if (!existsSync(buildId) || !existsSync(polishRoute)) {
    fatal("direct server build finished but .next still has no server API build.");
  }
}

function startServer() {
  const require = createRequire(import.meta.url);
  const nextBin = path.join(
    path.dirname(require.resolve("next/package.json")),
    "dist",
    "bin",
    "next",
  );
  const childEnv = {
    ...process.env,
    ...realModeEnv(),
    ...forwardedServerEnv(),
  };
  const serverOutput = [];
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
    cwd: webRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain child output so it cannot block, but never print it: an upstream or
  // framework error must not turn a smoke failure into provider-content logs.
  const capture = (chunk) => {
    serverOutput.push(chunk.toString());
    if (serverOutput.length > 200) serverOutput.shift();
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return {
    child,
    dumpOutput() {
      if (serverOutput.length > 0) {
        console.error("--- server output redacted to preserve no-content logging ---");
      }
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const exited = await Promise.race([
        new Promise((resolve) => child.once("exit", () => resolve(true))),
        sleep(5_000).then(() => false),
      ]);
      if (!exited) child.kill("SIGKILL");
    },
  };
}

async function waitForServer(server) {
  const ready = await pollUntil(
    async () => {
      if (server.child.exitCode !== null) {
        fatal(
          `the server exited during startup (code ${server.child.exitCode}).`,
          "Is the port already in use? Override with INTEGRATION_SMOKE_PORT.",
        );
      }
      try {
        const response = await fetch(`${BASE_URL}/api/polish/quota`, {
          signal: AbortSignal.timeout(2_000),
        });
        // Deployment switch on + no token → 401 is the READY signal.
        if (response.status === 401) return true;
        if (response.status === 503) {
          fatal(
            "the server answers 503 AI_DISABLED — AI_POLISH_ENABLED=true did not " +
              "reach the server process (check web/.env.local).",
          );
        }
      } catch {
        // connection refused — still starting
      }
      return false;
    },
    { timeoutMs: 90_000, intervalMs: 500 },
  );
  if (!ready) {
    server.dumpOutput();
    fatal(`server did not become ready on ${BASE_URL} within 90s.`);
  }
}

// ---------------------------------------------------------------------------
// HTTP + DB helpers
// ---------------------------------------------------------------------------

async function postPolish(body, { token, signal } = {}) {
  const headers = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const deadline = AbortSignal.timeout(POLISH_REQUEST_TIMEOUT_MS);
  const response = await fetch(`${BASE_URL}/api/polish`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, headers: response.headers, body: json };
}

function makePolishBody(clientRequestId, text, expectedRoute) {
  if (expectedRoute?.schemaVersion !== "expected_route_v1") {
    throw new Error("refusing to build a polish request without a strict expected route");
  }
  return {
    clientRequestId,
    granularity: "item",
    sectionId: "experience",
    language: "zh",
    items: [{ id: "i0", kind: "experience_bullet", text }],
    context: { level: 0, references: [] },
    expectedRoute,
  };
}

async function getAuthenticatedAvailability(accessToken, expectedRoute = null) {
  const response = await fetch(`${BASE_URL}/api/polish/availability`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null);
  if (response.status !== 200 || body?.availability?.enabled !== true) {
    fatal("selected integration profile is not authenticated-and-available on the prepared local route.");
  }
  let route;
  try {
    route = buildExpectedRouteV1(body.availability, integrationProfile);
  } catch (error) {
    fatal(error instanceof Error ? error.message : "availability route validation failed");
  }
  if (expectedRoute !== null && !sameExpectedRouteV1(expectedRoute, route)) {
    fatal("availability route changed during the smoke; refusing another provider transmission.");
  }
  return Object.freeze({ route, termsAccepted: body.availability.termsAccepted === true });
}

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

const REQUEST_LEDGER_SELECT = [
  "reservation_id", "request_id", "state", "status", "quota_charged", "provider_billable",
  "usage_complete", "attempt_count", "provider_started_at", "latency_ms", "failure_stage",
  "input_cached_tokens", "input_uncached_tokens", "output_tokens", "incomplete_fields",
  "route_schema_version", "config_generation", "routing_policy_version_id", "profile_version_id",
  "price_version_id", "legal_bundle_version", "runtime_contract_id", "runtime_contract_sha256",
  "gateway_kind", "model_id", "wire_api_kind", "display_disclosure_key", "billing_currency",
  "cost_basis", "known_estimated_cost_nanos", "estimated_cost_nanos", "provider_reported_currency",
  "provider_reported_cost_nanos", "cost_reconciliation_status",
].join(",");

const ATTEMPT_LEDGER_SELECT = [
  "attempt_no", "status", "transmitted", "provider_billable", "usage_observation_kind",
  "usage_complete", "input_cache_read_tokens", "input_cache_write_tokens", "input_standard_tokens",
  "output_tokens", "reasoning_tokens", "route_schema_version", "config_generation", "routing_policy_version_id",
  "profile_version_id", "price_version_id", "legal_bundle_version", "runtime_contract_id",
  "runtime_contract_sha256", "gateway_kind", "model_id", "wire_api_kind", "display_disclosure_key",
  "endpoint_alias", "actual_upstream_endpoint", "actual_model_id", "billing_currency",
  "estimated_currency", "estimated_cost_nanos", "provider_reported_currency",
  "provider_reported_cost_nanos",
].join(",");

async function getDailyRequestCount(service, userId) {
  const { data, error } = await service
    .from("ai_usage_daily")
    .select("request_count")
    .eq("user_id", userId)
    .eq("day", utcToday())
    .maybeSingle();
  if (error) throw new Error(`ai_usage_daily read failed: ${error.message}`);
  return data?.request_count ?? 0;
}

async function getLedgerRowByRequestId(service, requestId) {
  const { data, error } = await service
    .from("ai_request_ledger")
    .select(REQUEST_LEDGER_SELECT)
    .eq("request_id", requestId)
    .maybeSingle();
  if (error) throw new Error(`ai_request_ledger read failed: ${error.message}`);
  return data;
}

async function getLedgerRowByClientRequestId(service, userId, clientRequestId) {
  const { data, error } = await service
    .from("ai_request_ledger")
    .select(REQUEST_LEDGER_SELECT)
    .eq("user_id", userId)
    .eq("client_request_id", clientRequestId)
    .maybeSingle();
  if (error) throw new Error(`ai_request_ledger read failed: ${error.message}`);
  return data;
}

async function getAttemptRowsByReservationId(service, reservationId) {
  const { data, error } = await service
    .from("ai_provider_attempt_ledger")
    .select(ATTEMPT_LEDGER_SELECT)
    .eq("reservation_id", reservationId)
    .order("attempt_no", { ascending: true });
  if (error) throw new Error(`ai_provider_attempt_ledger read failed: ${error.message}`);
  return data ?? [];
}

async function waitFinalized(fetchRow, label) {
  const row = await pollUntil(
    async () => {
      const current = await fetchRow();
      return current && current.state === "finalized" ? current : false;
    },
    { timeoutMs: 20_000, intervalMs: 100 },
  );
  check(`${label}: ledger row reaches state=finalized`, row !== null, "timed out after 20s");
  return row;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let service = null;
let server = null;
let userId = null;
let fatalError = null;
let integrationProfile = null;

try {
  integrationProfile = preflightProfile();
  log(`profile: ${integrationProfile.name} (${integrationProfile.profileKey})`);
  preflightEnv();
  const SUPABASE_URL = getEnv("NEXT_PUBLIC_SUPABASE_URL");
  const SERVICE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const PUBLISHABLE_KEY = getEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");

  preflightLocalSupabaseUrl(SUPABASE_URL);
  preflightUpstream();
  preflightSupabaseCliMatch();
  await preflightReachable(SUPABASE_URL);
  ensureServerBuild();

  const NO_SESSION = {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  };
  service = createClient(SUPABASE_URL, SERVICE_KEY, NO_SESSION);
  const anon = createClient(SUPABASE_URL, PUBLISHABLE_KEY, NO_SESSION);

  server = startServer();
  try {
    await waitForServer(server);
  log(`server ready on ${BASE_URL} (real official ${integrationProfile.displayDisclosure.providerName} provider + real local Supabase)`);
  // This harness never activates a route or flips the DB feature switch. A
  // separate local driver must prepare the exact selected route; authenticated
  // availability below is the fail-closed proof before any request is sent.

  // --- Real auth chain: admin-created one-off user + gotrue password grant.
  const email = `smoke-${crypto.randomUUID()}@example.com`;
  const password = `Smoke!${crypto.randomUUID()}`;
  const { data: created, error: createError } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) {
    fatal(`failed to create the smoke user: ${createError?.message}`);
  }
  userId = created.user.id;

  const { data: session, error: signInError } = await anon.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError || !session.session?.access_token) {
    fatal(`gotrue password grant failed: ${signInError?.message ?? "no session"}`);
  }
  const accessToken = session.session.access_token;
  log("smoke user created and signed in via the real password grant");

  const availabilityBeforeTerms = await getAuthenticatedAvailability(accessToken);
  check(
    "authenticated availability: terms are not yet accepted",
    availabilityBeforeTerms.termsAccepted === false,
  );
  const expectedRoute = availabilityBeforeTerms.route;

  // --- 1. Auth denials.
  const noToken = await postPolish({});
  check(
    "POST /api/polish without a token → 401 UNAUTHORIZED",
    noToken.status === 401 && noToken.body?.error?.code === "UNAUTHORIZED",
    `got status ${noToken.status}, code ${noToken.body?.error?.code}`,
  );

  const fakeToken = await postPolish({}, { token: "not-a-real-token" });
  check(
    "POST /api/polish with a fake token → 401 UNAUTHORIZED",
    fakeToken.status === 401 && fakeToken.body?.error?.code === "UNAUTHORIZED",
    `got status ${fakeToken.status}, code ${fakeToken.body?.error?.code}`,
  );

  // --- 2. Terms gate, then acceptance via service role.
  const beforeTerms = await postPolish(makePolishBody(crypto.randomUUID(), "负责后端服务开发。", expectedRoute), {
    token: accessToken,
  });
  check(
    "POST /api/polish before accepting AI terms → 403 AI_TERMS_REQUIRED",
    beforeTerms.status === 403 && beforeTerms.body?.error?.code === "AI_TERMS_REQUIRED",
    `got status ${beforeTerms.status}, code ${beforeTerms.body?.error?.code}`,
  );

  const { data: termsVersion, error: termsVersionError } = await service.rpc(
    "current_ai_terms_version",
  );
  if (termsVersionError || typeof termsVersion !== "string") {
    fatal(`current_ai_terms_version() failed: ${termsVersionError?.message}`);
  }
  const { error: acceptError } = await service.from("user_terms_acceptances").insert({
    user_id: userId,
    document_key: "ai_terms",
    version: termsVersion,
  });
  if (acceptError) fatal(`terms acceptance insert failed: ${acceptError.message}`);
  log(`AI terms accepted via service role (version ${termsVersion})`);

  const availabilityAfterTerms = await getAuthenticatedAvailability(accessToken, expectedRoute);
  check("authenticated availability: terms accepted without route drift", availabilityAfterTerms.termsAccepted === true);

  // --- 3. Real polish 200 (provider transmission #1).
  const baselineCount = await getDailyRequestCount(service, userId);
  const successBody = makePolishBody(crypto.randomUUID(), "负责后端服务开发，优化接口性能。", expectedRoute);
  const success = await postPolish(successBody, { token: accessToken });
  check("POST /api/polish (real chain) → 200", success.status === 200, `got ${success.status}`);

  let successRequestId = null;
  if (success.status === 200 && success.body) {
    successRequestId = typeof success.body.requestId === "string" ? success.body.requestId : null;
    check("200: requestId is a non-empty string", successRequestId !== null);
    check(
      "200: X-Request-Id echoes body requestId",
      success.headers.get("x-request-id") === successRequestId,
    );
    check(
      "200: Cache-Control no-store",
      (success.headers.get("cache-control") ?? "").includes("no-store"),
    );
    const items = success.body.items;
    check(
      "200: exactly one result whose id matches the requested target",
      Array.isArray(items) && items.length === 1 && items[0]?.id === "i0",
    );
    // The polished TEXT itself is on the no-store list: assert non-blank, never print.
    check(
      "200: polished text is non-blank",
      typeof items?.[0]?.polished === "string" && items[0].polished.trim().length > 0,
    );
    const quota = success.body.quota;
    check(
      "200: quota {limit, remaining, resetAt} present",
      Number.isInteger(quota?.limit) &&
        Number.isInteger(quota?.remaining) &&
        typeof quota?.resetAt === "string",
    );
  }

  // --- 4. DB side effects of the succeeded request.
  let successRow = null;
  if (successRequestId !== null) {
    successRow = await waitFinalized(
      () => getLedgerRowByRequestId(service, successRequestId),
      "success settlement",
    );
  }
  if (successRow) {
    check("success ledger: status=succeeded", successRow.status === "succeeded", `got ${successRow.status}`);
    check("success ledger: quota_charged=true", successRow.quota_charged === true);
    check("success ledger: provider_billable=true", successRow.provider_billable === true);
    check(
      "success ledger: attempt_count >= 1",
      Number.isInteger(successRow.attempt_count) && successRow.attempt_count >= 1,
      `got ${successRow.attempt_count}`,
    );
    check(
      "success ledger: latency_ms recorded",
      Number.isInteger(successRow.latency_ms),
      `got ${successRow.latency_ms}`,
    );
    check("success ledger: usage_complete=true", successRow.usage_complete === true);
  }

  const afterSuccessCount = await getDailyRequestCount(service, userId);
  check(
    "ai_usage_daily: user request_count incremented by 1",
    afterSuccessCount === baselineCount + 1,
    `baseline ${baselineCount} → ${afterSuccessCount}`,
  );

  // --- 5. Dedup: same clientRequestId resent → 409 (no provider call).
  const dedup = await postPolish(successBody, { token: accessToken });
  check(
    "resend with the same clientRequestId → 409 dedup",
    dedup.status === 409 &&
      (dedup.body?.error?.code === "DUPLICATE_REQUEST" ||
        dedup.body?.error?.code === "REQUEST_IN_PROGRESS"),
    `got status ${dedup.status}, code ${dedup.body?.error?.code}`,
  );

  // --- 6. Cancel while the provider call is in flight (transmission #2).
  await getAuthenticatedAvailability(accessToken, expectedRoute);
  const cancelClientRequestId = crypto.randomUUID();
  const controller = new AbortController();
  const cancelFetch = postPolish(
    makePolishBody(
      cancelClientRequestId,
      "主导微服务架构改造，负责核心链路性能优化与稳定性建设，推动接口延迟持续下降。",
      expectedRoute,
    ),
    { token: accessToken, signal: controller.signal },
  ).catch(() => ({ aborted: true }));

  const startedRow = await pollUntil(
    async () => {
      const row = await getLedgerRowByClientRequestId(service, userId, cancelClientRequestId);
      return row && (row.state === "provider_started" || row.state === "finalized") ? row : false;
    },
    { timeoutMs: 20_000, intervalMs: 25 },
  );
  check(
    "cancel setup: reservation reaches provider_started",
    startedRow !== null && startedRow.state === "provider_started",
    startedRow === null
      ? "reservation never appeared"
      : `state was already ${startedRow.state} (provider call finished before the abort window)`,
  );

  let cancelRow = null;
  if (startedRow && startedRow.state === "provider_started") {
    // Let the upstream transmission get genuinely underway, then hang up.
    await sleep(250);
    controller.abort();
    const cancelOutcome = await cancelFetch;
    check(
      "cancel: client fetch aborted",
      cancelOutcome.aborted === true,
      "the fetch completed before the abort landed",
    );
    cancelRow = await waitFinalized(
      () => getLedgerRowByRequestId(service, startedRow.request_id),
      "cancel settlement",
    );
    if (cancelRow) {
      // Designed settlement (roadmap settlement table): a user cancel after
      // the provider call was entered is CHARGED, settled as canceled. The
      // mid-flight abort means no usage came back, so billability is UNKNOWN
      // (null — CP2 round3 honest accounting), never provably free (false).
      check("cancel ledger: status=canceled", cancelRow.status === "canceled", `got ${cancelRow.status}`);
      check("cancel ledger: quota_charged=true", cancelRow.quota_charged === true);
      check(
        "cancel ledger: failure_stage=canceled",
        cancelRow.failure_stage === "canceled",
        `got ${cancelRow.failure_stage}`,
      );
      check(
        "cancel ledger: attempt_count=1 (provider was entered once)",
        cancelRow.attempt_count === 1,
        `got ${cancelRow.attempt_count}`,
      );
      check(
        "cancel ledger: provider_billable=null (billability unknown mid-flight)",
        cancelRow.provider_billable === null,
        `got ${cancelRow.provider_billable}`,
      );
    }
  } else {
    controller.abort();
    await cancelFetch.catch(() => undefined);
  }

  // --- 7. Evidence readback: exactly this run's two request ids and their
  // immutable attempt children. No user-wide scan can accidentally include a
  // prior run in the transmission budget or cost aggregation.
  check(
    "ledger evidence: both run request ids finalized",
    successRow !== null && cancelRow !== null,
    "expected the succeeded and canceled request ledgers",
  );
  if (successRow && cancelRow) {
    const records = await Promise.all(
      [successRow, cancelRow].map(async (parent) => ({
        parent,
        attempts: await getAttemptRowsByReservationId(service, parent.reservation_id),
      })),
    );
    const evidence = evaluateRunLedgerEvidence(records, { profile: integrationProfile });
    for (const [index, result] of evidence.requestResults.entries()) {
      check(
        `ledger evidence: request ${index + 1} parent/child route, terminal, transmission, usage, and cost facts agree`,
        result.ok,
        result.ok ? undefined : result.issues.join(","),
      );
    }
    check(
      "ledger evidence: transmitted attempt budget respected (≤4)",
      evidence.transmissions <= 4,
      `got ${evidence.transmissions}`,
    );
    check(`ledger evidence: official ${integrationProfile.displayDisclosure.providerName} proof verdict`, evidence.ok);
  }
  } finally {
    // --- Cleanup: user deletion cascades ledger/usage/terms rows.
    if (userId !== null) {
      const { error } = await service.auth.admin.deleteUser(userId);
      if (error) {
        failures += 1;
        console.error(`FAIL cleanup: deleteUser — ${error.message}`);
      } else {
        log("smoke user deleted");
        // P2-9: the cascade itself is a smoke assertion — verify zero
        // leftover rows in every user-scoped table instead of trusting prose.
        for (const table of [
          "ai_request_ledger",
          "ai_usage_daily",
          "ai_rate_minutes",
          "user_terms_acceptances",
        ]) {
          const zeroed = await pollUntil(
            async () => {
              const { count, error: countError } = await service
                .from(table)
                .select("*", { count: "exact", head: true })
                .eq("user_id", userId);
              return countError === null && count === 0;
            },
            { timeoutMs: 10_000, intervalMs: 100 },
          );
          check(`cleanup: no ${table} rows left for the smoke user`, zeroed === true);
        }
      }
    }
  }
} catch (error) {
  if (error instanceof FatalSmokeError) {
    fatalError = error;
  } else {
    console.error("[test:integration] UNEXPECTED: details redacted to preserve no-content logging.");
    failures += 1;
  }
} finally {
  if (server !== null) await server.stop();
}

// process.exitCode, never process.exit(), once network clients exist: exiting
// mid-drain trips a libuv assertion crash on Windows (UV_HANDLE_CLOSING).
if (fatalError !== null || failures > 0) {
  if (server !== null) server.dumpOutput();
  console.error(
    fatalError !== null
      ? "\nintegration smoke aborted (see FATAL above)"
      : `\n${failures} integration assertion(s) failed`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `\nAll integration smoke assertions passed (real official ${integrationProfile.displayDisclosure.providerName} + real local Supabase)`,
  );
}
