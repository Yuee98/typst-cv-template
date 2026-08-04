/**
 * Real-key integration smoke for the AI polish API (unit 4.1).
 *
 *   pnpm --filter web test:integration        (repo root: pnpm test:integration)
 *
 * Unlike test:db (which skips when no local Supabase is found) this script is
 * a HARD-FAIL preflight: it exists to prove the real chain works, so a missing
 * prerequisite is an error, never a silent skip. It runs the full production
 * wiring — real DeepSeek provider + real local Supabase backend — with NO
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
 * Cost discipline: every request uses a single very short item; the whole run
 * makes AT MOST 2 provider transmissions (one success, one canceled). Token
 * usage and a rough cost estimate are printed at the end from ledger rows.
 *
 * Red lines (roadmap 禁存清单): this script never prints request/response
 * bodies, polished text, access tokens, or any key. Only statuses, error
 * codes, request ids and usage/latency NUMBERS appear in its output.
 *
 * Prerequisites (web/.env.local, never committed):
 *   DEEPSEEK_API_KEY, SUPABASE_SERVICE_ROLE_KEY (from `supabase status`),
 *   AI_USER_ID_HMAC_SECRET (`openssl rand -hex 32`), AI_POLISH_ENABLED=true,
 *   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
 * plus a running local Supabase (`pnpm supabase:start` at the repo root).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createClient } from "@supabase/supabase-js";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptsDir, "..");
const repoRoot = path.resolve(webRoot, "..");

// Rough list-price estimate (USD per 1M tokens) for the end-of-run cost line.
// Order-of-magnitude only — verify against the current DeepSeek pricing page.
const PRICE_PER_MTOK_USD = { inputCached: 0.07, inputUncached: 0.28, output: 1.42 };

const PORT = Number(process.env.INTEGRATION_SMOKE_PORT ?? 3123);
const BASE_URL = `http://127.0.0.1:${PORT}`;

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
    "DEEPSEEK_API_KEY",
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
}

function preflightSupabase() {
  const status = spawnSync("pnpm exec supabase status", {
    cwd: repoRoot,
    shell: true,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (status.error || status.status !== 0) {
    fatal(
      "local Supabase is not running (`supabase status` failed).",
      "Start it with `pnpm supabase:start` at the repo root, then re-run.",
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
// Server build + start (real mode — fake flags are stripped explicitly)
// ---------------------------------------------------------------------------

function ensureServerBuild() {
  const buildId = path.join(webRoot, ".next", "BUILD_ID");
  const polishRoute = path.join(webRoot, ".next", "server", "app", "api", "polish");
  if (existsSync(buildId) && existsSync(polishRoute)) {
    log("server build found; skipping build:server");
    return;
  }
  log("server build missing — running `pnpm build:server` (one-off, may take minutes)…");
  const build = spawnSync("pnpm build:server", {
    cwd: webRoot,
    shell: true,
    stdio: "inherit",
    timeout: 900_000,
  });
  if (build.error || build.status !== 0) {
    fatal("`pnpm build:server` failed; see the build output above.");
  }
  if (!existsSync(buildId) || !existsSync(polishRoute)) {
    fatal("`pnpm build:server` finished but .next still has no server API build.");
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
  const childEnv = { ...process.env };
  // Guarantee REAL provider + REAL backend even if the caller's shell exports
  // the fake flags — this smoke exists to exercise the production wiring.
  delete childEnv.POLISH_FAKE_LLM;
  delete childEnv.POLISH_FAKE_BACKEND;
  for (const name of [
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "AI_USER_ID_HMAC_SECRET",
    "AI_POLISH_ENABLED",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  ]) {
    const value = getEnv(name);
    if (value) childEnv[name] = value;
  }
  const serverOutput = [];
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
    cwd: webRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Server logs are metadata-only by construction (PolishLogEvent has no
  // content fields); buffer them and dump only when the run fails.
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
        console.error("--- server output (tail) ---");
        console.error(serverOutput.join(""));
        console.error("--- end server output ---");
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
  const response = await fetch(`${BASE_URL}/api/polish`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, headers: response.headers, body: json };
}

function makePolishBody(clientRequestId, text) {
  return {
    clientRequestId,
    granularity: "item",
    sectionId: "experience",
    language: "zh",
    items: [{ id: "i0", kind: "experience_bullet", text }],
    context: { level: 0, references: [] },
  };
}

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

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
    .select("*")
    .eq("request_id", requestId)
    .maybeSingle();
  if (error) throw new Error(`ai_request_ledger read failed: ${error.message}`);
  return data;
}

async function getLedgerRowByClientRequestId(service, userId, clientRequestId) {
  const { data, error } = await service
    .from("ai_request_ledger")
    .select("*")
    .eq("user_id", userId)
    .eq("client_request_id", clientRequestId)
    .maybeSingle();
  if (error) throw new Error(`ai_request_ledger read failed: ${error.message}`);
  return data;
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
let featureConfigRestore = null;
let fatalError = null;

try {
  preflightEnv();
  const SUPABASE_URL = getEnv("NEXT_PUBLIC_SUPABASE_URL");
  const SERVICE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const PUBLISHABLE_KEY = getEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");

  preflightSupabase();
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
  log(`server ready on ${BASE_URL} (real DeepSeek provider + real local Supabase)`);

  // DB-side runtime switch (distinct from the AI_POLISH_ENABLED env): the
  // reserve RPC denies with 503 AI_DISABLED while it is off, and test:db
  // restores the post-migration default (false) after every run — so the
  // smoke enables it via the service role when needed and restores the
  // original value during cleanup.
  const { data: featureConfig, error: featureError } = await service
    .from("ai_feature_config")
    .select("ai_polish_enabled")
    .eq("id", true)
    .single();
  if (featureError) fatal(`ai_feature_config read failed: ${featureError.message}`);
  if (featureConfig.ai_polish_enabled !== true) {
    const { error: enableError } = await service
      .from("ai_feature_config")
      .update({ ai_polish_enabled: true })
      .eq("id", true);
    if (enableError) {
      fatal(`failed to enable the DB runtime switch: ${enableError.message}`);
    }
    featureConfigRestore = featureConfig.ai_polish_enabled;
    log(
      "DB runtime switch ai_feature_config.ai_polish_enabled was off — " +
        "enabled via service role (restored on cleanup)",
    );
  }

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
  const beforeTerms = await postPolish(makePolishBody(crypto.randomUUID(), "负责后端服务开发。"), {
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

  // --- 3. Real polish 200 (provider transmission #1).
  const baselineCount = await getDailyRequestCount(service, userId);
  const successBody = makePolishBody(crypto.randomUUID(), "负责后端服务开发，优化接口性能。");
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
    // Cache diagnosis only (never asserted): DeepSeek context-cache split.
    log(
      `cache diagnosis (success): input_cached_tokens=${successRow.input_cached_tokens} ` +
        `input_uncached_tokens=${successRow.input_uncached_tokens} ` +
        `output_tokens=${successRow.output_tokens}`,
    );
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
  const cancelClientRequestId = crypto.randomUUID();
  const controller = new AbortController();
  const cancelFetch = postPolish(
    makePolishBody(
      cancelClientRequestId,
      "主导微服务架构改造，负责核心链路性能优化与稳定性建设，推动接口延迟持续下降。",
    ),
    { token: accessToken, signal: controller.signal },
  ).catch((error) => ({ aborted: true, error }));

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
    const cancelRow = await waitFinalized(
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

  // --- 7. Cost report (metadata only, straight from this user's ledger rows).
  const { data: allRows, error: rowsError } = await service
    .from("ai_request_ledger")
    .select("status,attempt_count,input_cached_tokens,input_uncached_tokens,output_tokens")
    .eq("user_id", userId);
  if (!rowsError && allRows) {
    const providerCalls = allRows.reduce((sum, row) => sum + (row.attempt_count ?? 0), 0);
    const cached = allRows.reduce((sum, row) => sum + (row.input_cached_tokens ?? 0), 0);
    const uncached = allRows.reduce((sum, row) => sum + (row.input_uncached_tokens ?? 0), 0);
    const output = allRows.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0);
    const usd =
      (cached / 1e6) * PRICE_PER_MTOK_USD.inputCached +
      (uncached / 1e6) * PRICE_PER_MTOK_USD.inputUncached +
      (output / 1e6) * PRICE_PER_MTOK_USD.output;
    log(
      `provider transmissions: ${providerCalls} (budget ≤4) | tokens — cached in: ${cached}, ` +
        `uncached in: ${uncached}, out: ${output} | rough cost ≈ $${usd.toFixed(6)}`,
    );
    check("provider transmission budget respected (≤4)", providerCalls <= 4, `got ${providerCalls}`);
  }
  } finally {
    // --- Cleanup: user deletion cascades ledger/usage/terms rows.
    if (userId !== null) {
      const { error } = await service.auth.admin.deleteUser(userId);
      if (error) {
        failures += 1;
        console.error(`FAIL cleanup: deleteUser — ${error.message}`);
      } else {
        log("smoke user deleted (cascades its ledger/usage/terms rows)");
      }
    }
    if (featureConfigRestore !== null) {
      const { error } = await service
        .from("ai_feature_config")
        .update({ ai_polish_enabled: featureConfigRestore })
        .eq("id", true);
      if (error) {
        failures += 1;
        console.error(`FAIL cleanup: restore ai_feature_config — ${error.message}`);
      } else {
        log(`DB runtime switch restored to ai_polish_enabled=${featureConfigRestore}`);
      }
    }
  }
} catch (error) {
  if (error instanceof FatalSmokeError) {
    fatalError = error;
  } else {
    console.error(
      `[test:integration] UNEXPECTED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
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
  console.log("\nAll integration smoke assertions passed (real DeepSeek + real local Supabase)");
}
