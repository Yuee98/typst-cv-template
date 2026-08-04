/**
 * AI polish metrics + global cost alert (unit 4.1).
 *
 *   pnpm --filter web metrics:ai              (repo root: pnpm metrics:ai)
 *   node scripts/ai-metrics.mjs --hours=48 --no-alert
 *
 * Reads ai_request_ledger (last --hours=N hours, default 24) via the service
 * role and prints: request volume by status, p50/p95 latency of succeeded
 * rows, retry rates, invalid-output rate, DeepSeek context-cache hit rate and
 * token usage. Then compares TODAY's ai_global_usage_daily against
 * ai_feature_config.global_daily_limit and exits non-zero on threshold:
 *
 *   usage >=  80% of the global daily limit → prints ALERT,    exit 1
 *   usage >= 100% of the global daily limit → prints CRITICAL, exit 2
 *   (--no-alert downgrades both to a printed line with exit 0)
 *
 * This is a LOCAL / MANUAL inspection alert — wiring it into an online
 * alerting channel is a post-roadmap item.
 *
 * Environment (web/.env.local; process.env takes precedence):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Output is metadata only (counts, latencies, token totals) — no request
 * content, user ids, or keys are ever printed.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createClient } from "@supabase/supabase-js";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptsDir, "..");

const ALERT_THRESHOLD = 0.8;
const EXIT_ALERT = 1;
const EXIT_CRITICAL = 2;
const EXIT_USAGE = 3;

/** Hard usage/IO failure: reported, then the run ends with EXIT_USAGE. */
class UsageExit extends Error {}

function failUsage(message) {
  console.error(`[metrics:ai] ${message}`);
  throw new UsageExit(message);
}

// ---------------------------------------------------------------------------
// Args + env
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let hours = 24;
  let alert = true;
  for (const arg of argv) {
    if (arg === "--no-alert") {
      alert = false;
    } else if (arg.startsWith("--hours=")) {
      hours = Number(arg.slice("--hours=".length));
      if (!Number.isFinite(hours) || hours <= 0) {
        console.error(`[metrics:ai] invalid --hours value: ${arg}`);
        process.exit(EXIT_USAGE);
      }
    } else {
      console.error(`[metrics:ai] unknown argument: ${arg}`);
      console.error("usage: node scripts/ai-metrics.mjs [--hours=N] [--no-alert]");
      process.exit(EXIT_USAGE);
    }
  }
  return { hours, alert };
}

function loadEnvFile(filePath) {
  // node:util parseEnv — the SAME parser Node uses for --env-file.
  if (!existsSync(filePath)) return {};
  return parseEnv(readFileSync(filePath, "utf8"));
}

const fileEnv = loadEnvFile(path.join(webRoot, ".env.local"));
const getEnv = (name) => process.env[name]?.trim() || fileEnv[name]?.trim() || "";

const { hours, alert } = parseArgs(process.argv.slice(2));

const SUPABASE_URL = getEnv("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "[metrics:ai] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing. " +
      "Fill web/.env.local (see web/README.md「AI polish local smoke & metrics」).",
  );
  process.exit(EXIT_USAGE);
}

const service = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const FINALIZED_STATUSES = [
  "succeeded",
  "canceled",
  "failed_upstream",
  "invalid_output",
  "released",
  "abandoned",
];
const FAILED_STATUSES = ["failed_upstream", "invalid_output"];

function percentile(sortedNumbers, p) {
  if (sortedNumbers.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sortedNumbers.length));
  return sortedNumbers[rank - 1];
}

function pct(part, whole) {
  return whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;
}

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchLedgerRows(cutoffIso) {
  const { data, error } = await service
    .from("ai_request_ledger")
    .select(
      "status,state,attempt_count,latency_ms,usage_complete," +
        "input_cached_tokens,input_uncached_tokens,output_tokens",
    )
    .gte("reserved_at", cutoffIso)
    .limit(10_000);
  if (error) {
    failUsage(`ai_request_ledger read failed: ${error.message}`);
  }
  if (data.length === 10_000) {
    console.error("[metrics:ai] WARNING: row cap (10000) hit — window metrics are truncated.");
  }
  return data;
}

function printMetrics(rows, hours) {
  const finalized = rows.filter((row) => row.state === "finalized");
  const byStatus = Object.fromEntries(FINALIZED_STATUSES.map((status) => [status, 0]));
  for (const row of finalized) {
    if (row.status in byStatus) byStatus[row.status] += 1;
  }
  const succeeded = finalized.filter((row) => row.status === "succeeded");
  const failed = finalized.filter((row) => FAILED_STATUSES.includes(row.status));
  const retried = (cohort) => cohort.filter((row) => (row.attempt_count ?? 0) > 1).length;
  const latencies = succeeded
    .map((row) => row.latency_ms)
    .filter((value) => Number.isInteger(value))
    .sort((a, b) => a - b);

  // Cache hit rate and token sums: succeeded rows with COMPLETE usage only —
  // partial accounting (usage_complete=false) must not skew cost metrics.
  const usageCohort = succeeded.filter((row) => row.usage_complete === true);
  const sum = (cohort, column) =>
    cohort.reduce((total, row) => total + (row[column] ?? 0), 0);
  const cached = sum(usageCohort, "input_cached_tokens");
  const uncached = sum(usageCohort, "input_uncached_tokens");
  const output = sum(usageCohort, "output_tokens");
  const cacheHitRate =
    cached + uncached === 0 ? "n/a" : `${((cached / (cached + uncached)) * 100).toFixed(1)}%`;

  console.log(`\n== AI polish metrics — last ${hours}h ==`);
  console.log(`requests total: ${rows.length} (finalized: ${finalized.length})`);
  console.log(
    `status distribution: ${FINALIZED_STATUSES.map((s) => `${s}=${byStatus[s]}`).join(" ")}`,
  );
  console.log(
    `latency_ms (succeeded, n=${latencies.length}): ` +
      `p50=${percentile(latencies, 0.5) ?? "n/a"} p95=${percentile(latencies, 0.95) ?? "n/a"}`,
  );
  console.log(
    `retry rate (attempt_count>1): succeeded ${retried(succeeded)}/${succeeded.length} ` +
      `(${pct(retried(succeeded), succeeded.length)}), ` +
      `failed ${retried(failed)}/${failed.length} (${pct(retried(failed), failed.length)})`,
  );
  console.log(
    `invalid output rate: ${byStatus.invalid_output}/${finalized.length} ` +
      `(${pct(byStatus.invalid_output, finalized.length)})`,
  );
  console.log(
    `cache hit rate (succeeded, usage_complete; n=${usageCohort.length}): ${cacheHitRate} ` +
      `(cached ${cached} / total in ${cached + uncached})`,
  );
  console.log(
    `token usage (succeeded, usage_complete): input_cached=${cached} ` +
      `input_uncached=${uncached} output=${output}`,
  );
}

// ---------------------------------------------------------------------------
// Global cost alert
// ---------------------------------------------------------------------------

async function globalCostAlert() {
  const { data: usageRow, error: usageError } = await service
    .from("ai_global_usage_daily")
    .select("provider_started_count")
    .eq("day", utcToday())
    .maybeSingle();
  if (usageError) {
    failUsage(`ai_global_usage_daily read failed: ${usageError.message}`);
  }
  const { data: configRow, error: configError } = await service
    .from("ai_feature_config")
    .select("global_daily_limit")
    .eq("id", true)
    .single();
  if (configError) {
    failUsage(`ai_feature_config read failed: ${configError.message}`);
  }

  const used = usageRow?.provider_started_count ?? 0;
  const limit = configRow.global_daily_limit;
  // limit=0 means "nothing allowed today": any usage is over-limit.
  const ratio = limit > 0 ? used / limit : used > 0 ? Number.POSITIVE_INFINITY : 0;
  console.log(
    `\n== Global cost circuit breaker (UTC today) ==\n` +
      `provider transmissions: ${used} / global_daily_limit ${limit} ` +
      `(${(ratio * 100).toFixed(1)}%)`,
  );

  if (ratio >= 1) {
    console.error(
      `CRITICAL: global daily provider-call limit reached/exceeded (${used}/${limit}). ` +
        "New polish attempts are being rejected by the circuit breaker.",
    );
    return alert ? EXIT_CRITICAL : 0;
  }
  if (ratio >= ALERT_THRESHOLD) {
    console.error(
      `ALERT: global daily provider-call usage at ${(ratio * 100).toFixed(1)}% of the limit ` +
        `(${used}/${limit}, threshold ${ALERT_THRESHOLD * 100}%).`,
    );
    return alert ? EXIT_ALERT : 0;
  }
  console.log("OK: global usage below the 80% alert threshold.");
  return 0;
}

// ---------------------------------------------------------------------------

const cutoffIso = new Date(Date.now() - hours * 3_600_000).toISOString();
// process.exitCode, never process.exit(), once network clients exist: exiting
// mid-drain trips a libuv assertion crash on Windows (UV_HANDLE_CLOSING).
try {
  const rows = await fetchLedgerRows(cutoffIso);
  printMetrics(rows, hours);
  process.exitCode = await globalCostAlert();
} catch (error) {
  if (error instanceof UsageExit) {
    process.exitCode = EXIT_USAGE;
  } else {
    throw error;
  }
}
