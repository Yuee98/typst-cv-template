/** Disposable two-connection AI ledger checks. Never contacts a Provider or hosted database. */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { root, run, quote } from "./db-common.ts";
const container = process.env.CV_DB_CONCURRENCY_CONTAINER ?? "cv-rebuild-sql-test";
if (!["cv-rebuild-sql-test", "supabase_db_typst-cv-template"].includes(container)) throw new Error("Only reviewed local test containers are allowed");
const database = "cv_ai_concurrency";
const asyncExec = promisify(execFile);
function owner(statement: string, db = database) {
  return run("docker", ["exec", "-i", container, "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", db], statement);
}
async function worker(name: string, input: Record<string, unknown>, application = "cv_ai_concurrency_worker") {
  const {
    stdout
  } = await asyncExec("docker", ["exec", container, "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database, "-c", `begin;set local application_name=${quote(application)};set local role service_role;select public.${name}(${quote(JSON.stringify(input))}::jsonb);commit;`], {
    maxBuffer: 1024 * 1024
  });
  return JSON.parse(stdout.trim());
}
async function blockRuntime() {
  const child = spawn("docker", ["exec", "-i", container, "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", database], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stderr.resume();
  const ended = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const acquired = new Promise<number>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Runtime fixture lock was not acquired")), 10000);
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      const match = /CLOCK_LOCKED:(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", () => {
      clearTimeout(timer);
      reject(new Error("Runtime fixture lock connection closed early"));
    });
  });
  child.stdin.write("begin;select id from ai.runtime_control where id=1 for update;select 'CLOCK_LOCKED:'||pg_backend_pid();\n");
  try {
    return {
      pid: await acquired,
      release: async () => {
        child.stdin.end("commit;\n\\q\n");
        assert.equal(await ended, 0);
      }
    };
  } catch (error) {
    child.stdin.end();
    await ended;
    throw error;
  }
}
async function waitForBlockedWorker(application: string, holder: number) {
  for (let i = 0; i < 100; i++) {
    const waiting = owner(`select count(*) from pg_catalog.pg_stat_activity where datname=${quote(database)} and application_name=${quote(application)} and wait_event_type='Lock' and ${holder}=any(pg_catalog.pg_blocking_pids(pid));`);
    if (waiting === "1") return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Service RPC did not observably wait for the runtime fixture lock");
}
async function acrossClockBoundary(name: string, input: Record<string, unknown>, before: string, after: string, application: string) {
  owner(`update fixture_clock.state set observed_at=${quote(before)}::timestamptz;`);
  const holder = await blockRuntime();
  const pending = worker(name, input, application).then(value => ({
    ok: true as const,
    value
  }), error => ({
    ok: false as const,
    error: error as {
      stderr?: string;
    }
  }));
  try {
    await waitForBlockedWorker(application, holder.pid);
    owner(`update fixture_clock.state set observed_at=${quote(after)}::timestamptz;`);
  } finally {
    await holder.release();
  }
  return pending;
}
function occupancy() {
  return owner("select jsonb_build_object('requests',(select count(*) from ai.requests),'attempts',(select count(*) from ai.attempts),'user_reserved',(select coalesce(sum(reserved_count),0) from ai.user_usage_daily),'user_charged',(select coalesce(sum(charged_count),0) from ai.user_usage_daily),'rate',(select coalesce(sum(request_count),0) from ai.rate_minutes),'global',(select coalesce(sum(admitted_count),0) from ai.global_usage_daily),'profile',(select coalesce(sum(request_count),0) from ai.profile_usage_daily));");
}
if (!process.argv.includes("--run-disposable")) {
  console.log(JSON.stringify({
    container,
    database,
    execute: false
  }));
  process.exit(0);
}
const inspected = JSON.parse(run("docker", ["inspect", container]))[0];
if (inspected.Name !== `/${container}`) throw new Error("Unexpected local test container");
if (owner(`select count(*) from pg_database where datname=${quote(database)};`, "template1") !== "0") throw new Error("Existing concurrency test database retained; inspect it before a fresh run");
let created = false;
try {
  owner(`create database ${database};`, "template1");
  created = true;
  owner("create schema extensions;create extension pgcrypto with schema extensions;create extension btree_gist with schema extensions;drop schema public;");
  const dump = run("docker", ["exec", container, "pg_dump", "-U", "supabase_admin", "-d", "postgres", ...['public', 'common', 'cv', 'ai', 'legal', 'admin', 'audit', 'auth', 'supabase_migrations'].map(schema => `--schema=${schema}`)]);
  owner(dump);
  owner("grant usage on schema extensions to app_api_owner;grant execute on function extensions.gen_random_bytes(integer),extensions.digest(text,text) to app_api_owner;truncate ai.requests,ai.attempts,ai.user_usage_daily,ai.global_usage_daily,ai.profile_usage_daily,ai.rate_minutes restart identity cascade;");
  const fixture = readFileSync(resolve(root, "supabase/tests/rebuild-ai-boundaries.sql"), "utf8");
  owner(fixture.slice(0, fixture.indexOf('-- RUNTIME_FIXTURE_SETUP_END')) + "\ncommit;");
  const context = JSON.parse(owner("select public.app_context();"));
  const base = {
    contract_code: "cv_app_db_1",
    database_instance_id: context.database_instance_id,
    owner_auth_user_id: "00000000-0000-4000-8000-000000000091"
  };
  const availability = await worker("ai_availability", base);
  const option = availability.options[0];
  const reserve = {
    ...base,
    client_request_key: crypto.randomUUID(),
    request_fingerprint: "concurrent-fixture",
    selected_option_id: option.option_id,
    expected_generation: availability.generation,
    expected_policy_version_id: availability.policy_version_id,
    expected_profile_version_id: option.profile_version_id,
    disclosure_id: option.disclosure_id,
    content_digest: option.content_digest
  };
  const reservations = await Promise.all([worker("ai_reserve", reserve), worker("ai_reserve", reserve)]);
  assert.equal(reservations.filter(result => result.replayed === false).length, 1);
  assert.equal(reservations[0].request_id, reservations[1].request_id);
  const request = {
    ...base,
    request_id: reservations[0].request_id
  };
  const starts = await Promise.all([worker("ai_attempt_start", {
    ...request,
    attempt_no: 1
  }), worker("ai_attempt_start", {
    ...request,
    attempt_no: 1
  })]);
  assert.equal(starts.filter(result => result.may_transmit === true).length, 1);
  assert.equal(starts[0].attempt_id, starts[1].attempt_id);
  const fact = {
    ...request,
    attempt_id: starts[0].attempt_id,
    state: "SUCCEEDED",
    transmitted: true,
    provider_billable: true,
    retry_allowed: false,
    usage: {
      input_total: "3",
      input_standard: "2",
      cache_read: "1",
      cache_write: null,
      output: "4",
      reasoning: "2"
    }
  };
  const terminals = await Promise.all([worker("ai_attempt_complete", fact), worker("ai_attempt_complete", fact)]);
  assert.equal(terminals.filter(result => result.replayed === false).length, 1);
  const finalized = await Promise.all([worker("ai_finalize", request), worker("ai_finalize", request)]);
  for (const result of finalized) {
    assert.equal(result.state, "FINALIZED");
    assert.equal(result.outcome, "SUCCEEDED");
    assert.equal(result.quota.remaining, "99");
  }
  const buckets = JSON.parse(owner("select jsonb_build_object('reserved',(select reserved_count from ai.user_usage_daily),'charged',(select charged_count from ai.user_usage_daily),'global',(select sum(admitted_count) from ai.global_usage_daily),'attempts',(select count(*) from ai.attempts),'profiles',(select sum(request_count) from ai.profile_usage_daily));"));
  assert.deepEqual(buckets, {
    reserved: 0,
    charged: 1,
    global: 1,
    attempts: 1,
    profiles: 1
  });

  // Controlled clock substitution exists only in this disposable database. It preserves
  // each production function's body, permissions and lock order; no production clock changes.
  owner(`create schema fixture_clock;
    create table fixture_clock.state(observed_at timestamptz not null);
    insert into fixture_clock.state values('2026-11-09T09:59:59.900Z');
    create function fixture_clock.now() returns timestamptz language sql volatile security definer set search_path='' as $$select observed_at from fixture_clock.state$$;
    revoke all on schema fixture_clock from public;revoke all on function fixture_clock.now() from public;
    grant usage on schema fixture_clock to app_api_owner;grant execute on function fixture_clock.now() to app_api_owner;`);
  for (const name of ["ai_availability", "ai_reserve", "ai_attempt_start"]) {
    const definition = owner(`select pg_get_functiondef('public.${name}(jsonb)'::regprocedure);`);
    assert.equal((definition.match(/clock_timestamp\(\)/g) ?? []).length, 1, `Expected one observed-clock call in ${name}`);
    owner(definition.replace("clock_timestamp()", "fixture_clock.now()"));
  }
  function prepared(available: typeof availability, selected: typeof option, fingerprint: string) {
    return {
      ...base,
      client_request_key: crypto.randomUUID(),
      request_fingerprint: fingerprint,
      selected_option_id: selected.option_id,
      expected_generation: available.generation,
      expected_policy_version_id: available.policy_version_id,
      expected_profile_version_id: selected.profile_version_id,
      disclosure_id: selected.disclosure_id,
      content_digest: selected.content_digest
    };
  }
  const beforeBoundary = await worker("ai_availability", base);
  assert.equal(beforeBoundary.rule_ordinal, 1);
  const optionB = beforeBoundary.options.find((candidate: typeof option) => candidate.provider_code === "MIMO");
  assert(optionB && optionB.status === "READY", "B is offered before the Shanghai 18:00 boundary");
  const beforeOccupancy = occupancy();
  const invalidated = await acrossClockBoundary("ai_reserve", prepared(beforeBoundary, optionB, "wait-clock-route"), "2026-11-09T09:59:59.900Z", "2026-11-09T10:00:00.100Z", "cv_route_boundary_waiter");
  assert.equal(invalidated.ok, false);
  if (!invalidated.ok) assert.match(invalidated.error.stderr ?? "", /OPTION_UNAVAILABLE/);
  assert.equal(occupancy(), beforeOccupancy, "Invalidated B creates no request, attempt or quota/rate/provider occupancy");
  const afterBoundary = await worker("ai_availability", base);
  assert.equal(afterBoundary.rule_ordinal, 2);
  assert(!afterBoundary.options.some((candidate: typeof option) => candidate.option_id === optionB.option_id));
  owner("update fixture_clock.state set observed_at='2026-11-09T23:59:59.900Z';");
  const beforeUtcDay = await worker("ai_availability", base);
  const optionA = beforeUtcDay.options.find((candidate: typeof option) => candidate.option_id === beforeUtcDay.default_option_id);
  assert(optionA && optionA.status === "READY");
  const dayReservation = await acrossClockBoundary("ai_reserve", prepared(beforeUtcDay, optionA, "wait-clock-quota-day"), "2026-11-09T23:59:59.900Z", "2026-11-10T00:00:00.100Z", "cv_quota_day_waiter");
  assert(dayReservation.ok);
  assert.equal(dayReservation.value.quota.day, "2026-11-10");
  const reservedDay = JSON.parse(owner(`select jsonb_build_object('day',quota_day,'at',time_reserved,'new_reserved',(select reserved_count from ai.user_usage_daily where day='2026-11-10'),'old_rows',(select count(*) from ai.user_usage_daily where day='2026-11-09'),'minute_rows',(select count(*) from ai.rate_minutes where minute_bucket='2026-11-10T00:00:00Z')) from ai.requests where external_id=${quote(dayReservation.value.request_id)};`));
  assert.deepEqual(reservedDay, {
    day: "2026-11-10",
    at: "2026-11-10T00:00:00.1+00:00",
    new_reserved: 1,
    old_rows: 0,
    minute_rows: 1
  });

  // A fresh request only milliseconds before the next midnight avoids a 24-hour stale request.
  owner("update fixture_clock.state set observed_at='2026-11-10T23:59:59.800Z';");
  const admissionAvailability = await worker("ai_availability", base);
  const admissionOption = admissionAvailability.options.find((candidate: typeof option) => candidate.option_id === admissionAvailability.default_option_id);
  const admissionReservation = await worker("ai_reserve", prepared(admissionAvailability, admissionOption, "wait-clock-provider-day"));
  assert.equal(admissionReservation.quota.day, "2026-11-10");
  const admission = await acrossClockBoundary("ai_attempt_start", {
    ...base,
    request_id: admissionReservation.request_id,
    attempt_no: 1
  }, "2026-11-10T23:59:59.900Z", "2026-11-11T00:00:00.100Z", "cv_admission_day_waiter");
  assert(admission.ok && admission.value.may_transmit === true);
  const admittedDay = JSON.parse(owner(`select jsonb_build_object('quota_day',quota_day,'provider_day',provider_admission_day,'new_admitted',(select admitted_count from ai.global_usage_daily where day='2026-11-11'),'old_rows',(select count(*) from ai.global_usage_daily where day='2026-11-10'),'started_at',(select time_started from ai.attempts where request_id=r.id)) from ai.requests r where external_id=${quote(admissionReservation.request_id)};`));
  assert.deepEqual(admittedDay, {
    quota_day: "2026-11-10",
    provider_day: "2026-11-11",
    new_admitted: 1,
    old_rows: 0,
    started_at: "2026-11-11T00:00:00.1+00:00"
  });
  console.log(JSON.stringify({
    passed: true,
    checks: ["concurrent reserve deduplication", "single attempt transmission grant", "terminal idempotency", "single settlement and buckets", "locked reserve rechecks Shanghai route without occupancy", "locked reserve and admission use their post-lock UTC day"],
    clock_fixture: "Only the disposable clone substitutes observed time; pg_blocking_pids proves real two-connection waits before owner advances the clock.",
    container,
    database
  }));
} finally {
  if (created) owner(`drop database ${database} with(force);`, "template1");
}
