/**
 * AI polish metrics + global cost alert (unit 4.1).
 *
 *   pnpm --filter web metrics:ai              (repo root: pnpm metrics:ai)
 *   node scripts/ai-metrics.mjs --hours=48 --no-alert
 *
 * Reads the persisted request and provider-attempt ledgers (last
 * --hours=N hours, default 24) via the service role and prints disjoint
 * request-level and attempt-level sections grouped by safe route dimensions,
 * usage and cost reconciliation. It also retains the legacy request summary,
 * then compares TODAY's ai_global_usage_daily against
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
 * Output is metadata only (counts, route dimensions, latencies, token/cost
 * totals) — no request content, user ids, raw provider IDs, credentials or
 * endpoint URLs are ever printed.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createClient } from "@supabase/supabase-js";
import {
  buildMetrics,
  classifyGlobalUsage,
  collectAllPages,
  summarizeTokenUsage,
} from "./lib/metrics-logic.mjs";

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

/**
 * P1-6: Supabase caps a single page at 1000 rows by default — a bare
 * .limit(10_000) silently truncates (the global circuit breaker allows 2000
 * attempts/day, so a busy day ALWAYS exceeds one page). Paginate
 * deterministically on (reserved_at, reservation_id) until a short page.
 */
async function fetchRequestRows(cutoffIso) {
  return collectAllPages(async (offset, end) => {
    const { data, error } = await service
      .from("ai_request_ledger")
      .select(
        "reservation_id,reserved_at,status,state,attempt_count,latency_ms," +
          "usage_complete,input_cached_tokens,input_uncached_tokens,output_tokens," +
          "input_cache_read_tokens,input_cache_write_tokens,input_standard_tokens,reasoning_tokens," +
          "known_estimated_cost_nanos,estimated_cost_nanos,provider_reported_currency," +
          "provider_reported_cost_nanos,cost_reconciliation_status," +
          "route_schema_version,config_generation,routing_policy_version_id,profile_version_id," +
          "price_version_id,legal_bundle_version,runtime_contract_id,runtime_contract_sha256," +
          "gateway_kind,model_id,wire_api_kind,display_disclosure_key,billing_currency",
      )
      .gte("reserved_at", cutoffIso)
      .order("reserved_at", { ascending: true })
      .order("reservation_id", { ascending: true })
      .range(offset, end);
    if (error) {
      failUsage(`ai_request_ledger read failed: ${error.message}`);
    }
    return data;
  });
}

async function fetchAttemptRows(cutoffIso) {
  return collectAllPages(async (offset, end) => {
    const { data, error } = await service
      .from("ai_provider_attempt_ledger")
      .select(
        "reservation_id,attempt_no,status,usage_observation_kind,usage_complete," +
          "input_cache_read_tokens,input_cache_write_tokens,input_standard_tokens,output_tokens,reasoning_tokens," +
          "estimated_cost_nanos,provider_reported_currency,provider_reported_cost_nanos," +
          "cost_reconciliation_status,route_schema_version,config_generation," +
          "routing_policy_version_id,profile_version_id,price_version_id,legal_bundle_version," +
          "runtime_contract_id,runtime_contract_sha256,gateway_kind,model_id,wire_api_kind," +
          "display_disclosure_key,billing_currency,latency_ms",
      )
      .gte("started_at", cutoffIso)
      .order("started_at", { ascending: true })
      .order("reservation_id", { ascending: true })
      .order("attempt_no", { ascending: true })
      .range(offset, end);
    if (error) {
      failUsage(`ai_provider_attempt_ledger read failed: ${error.message}`);
    }
    return data;
  });
}

function printMetrics({ requests, attempts }, hours) {
  const rows = requests;
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

  // P1-7 cost cohorts — never discard KNOWN tokens: the server records every
  // known retry token even when the user quota is refunded (invalid_output is
  // explicitly billable; failed_upstream/canceled rows can carry usage; an
  // incomplete row's recorded totals remain a valid LOWER bound).
  const tokenLine = ({ inputCached, inputUncached, output }) =>
    `input_cached=${inputCached} input_uncached=${inputUncached} output=${output}`;
  const cacheRate = ({ inputCached, inputUncached }) => {
    const cached = inputCached;
    const uncached = inputUncached;
    return cached + uncached === 0 ? "n/a" : `${((cached / (cached + uncached)) * 100).toFixed(1)}%`;
  };
  const usage = summarizeTokenUsage(finalized);

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
    `token usage — known cost, finalized rows with recorded usage (n=${usage.known.count}): ` +
      tokenLine(usage.known.totals),
  );
  console.log(
    `token usage — complete accounting (usage_complete=true, n=${usage.complete.count}): ` +
      tokenLine(usage.complete.totals),
  );
  console.log(
    `token usage — known LOWER BOUND from incomplete rows (n=${usage.incompleteKnown.count}): ` +
      tokenLine(usage.incompleteKnown.totals),
  );
  console.log(
    `cache hit rate (all complete rows with input usage, n=${usage.completeWithInput.count}): ` +
      cacheRate(usage.completeWithInput.totals),
  );
  console.log(
    `cache hit rate (succeeded, complete, n=${usage.succeededCompleteWithInput.count}): ` +
      cacheRate(usage.succeededCompleteWithInput.totals),
  );

  // OBS-001 keeps request aggregates and provider attempts disjoint.  The
  // service-role read is the provenance boundary; no caller-supplied events
  // enter this CLI, and only the pure builder's safe projections are printed.
  const metrics = buildMetrics({ requests, attempts });
  console.log("\n== Request-level ledger metrics ==");
  console.log(JSON.stringify(metrics.requestLevel));
  console.log("\n== Attempt-level ledger metrics ==");
  console.log(JSON.stringify(metrics.attemptLevel));
  console.log("\n== Metrics alerts ==");
  console.log(JSON.stringify(metrics.alerts));
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
  console.log(
    `\n== Global cost circuit breaker (UTC today) ==\n` +
      `provider transmissions: ${used} / global_daily_limit ${limit}` +
      (limit > 0 ? ` (${((used / limit) * 100).toFixed(1)}%)` : ""),
  );

  const globalUsage = classifyGlobalUsage(used, limit, ALERT_THRESHOLD);

  // Edge: the DB allows limit=0 (provider gate rejects EVERY attempt). With
  // used=0 the ratio math would print a misleading OK — say what it means.
  if (globalUsage.level === "disabled") {
    console.error(
      "NOTICE: global_daily_limit is 0 — the provider gate rejects ALL polish attempts " +
        "today (deliberate config, not an idle day). Set a positive limit to re-enable.",
    );
    return 0;
  }

  const ratio = globalUsage.ratio;

  if (globalUsage.level === "critical") {
    console.error(
      `CRITICAL: global daily provider-call limit reached/exceeded (${used}/${limit}). ` +
        "New polish attempts are being rejected by the circuit breaker.",
    );
    return alert ? EXIT_CRITICAL : 0;
  }
  if (globalUsage.level === "alert") {
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
  const [requests, attempts] = await Promise.all([
    fetchRequestRows(cutoffIso),
    fetchAttemptRows(cutoffIso),
  ]);
  printMetrics({ requests, attempts }, hours);
  process.exitCode = await globalCostAlert();
} catch (error) {
  if (error instanceof UsageExit) {
    process.exitCode = EXIT_USAGE;
  } else {
    throw error;
  }
}
