/** Isolated two-connection checks. No hosted database or AI provider is contacted. */
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { root, run, quote } from "./db-common.ts";

const container = process.env.CV_DB_CONCURRENCY_CONTAINER ?? "supabase_db_typst-cv-template";
if (!["cv-rebuild-sql-test", "supabase_db_typst-cv-template"].includes(container)) throw new Error("Only reviewed local test containers are allowed");
const database = "cv_ai_concurrency";
const user = "00000000-0000-4000-8000-000000000091";
const execute = promisify(execFile);
function owner(statement: string, db = database) {
  return run("docker", ["exec", "-i", container, "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", db], statement);
}
async function worker(name: string, payload: Record<string, unknown>, application = "cv_v2_concurrency") {
  const { stdout } = await execute("docker", ["exec", container, "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database, "-c",
    `begin;set local application_name=${quote(application)};set local role service_role;set local request.jwt.claims='{"role":"service_role"}';select public.${name}(${quote(JSON.stringify(payload))}::jsonb);commit;`], { maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.trim());
}
async function holder() {
  const child = spawn("docker", ["exec", "-i", container, "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", database], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const ended = new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
  const locked = new Promise<number>((done, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Local control lock timeout")), 10_000);
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      const match = /LOCKED:(\d+)/.exec(output);
      if (match) { clearTimeout(timer); done(Number(match[1])); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); reject(new Error("Lock holder ended early")); });
  });
  child.stdin.write("begin;select id from ai.runtime_control where id=1 for update;select 'LOCKED:'||pg_backend_pid();\n");
  try {
    return { pid: await locked, release: async () => { child.stdin.end("commit;\n"); assert.equal(await ended, 0); } };
  } catch (error) { child.stdin.end(); await ended; throw error; }
}
async function observeWait(application: string, pid: number) {
  for (let count = 0; count < 100; count++) {
    if (owner(`select count(*) from pg_catalog.pg_stat_activity where datname=${quote(database)} and application_name=${quote(application)} and wait_event_type='Lock' and ${pid}=any(pg_catalog.pg_blocking_pids(pid));`) === "1") return;
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error("Worker did not observably wait for the control lock");
}
function clearFacts() {
  owner("truncate ai.requests,ai.user_quota_daily,ai.global_quota_daily,ai.rate_minutes,ai.configuration_usage_daily restart identity cascade;update ai.runtime_control set user_daily_limit=20,global_daily_limit=2000,user_minute_limit=20;");
}
function inspectCounts() {
  return JSON.parse(owner("select jsonb_build_object('requests',(select count(*) from ai.requests),'attempts',(select count(*) from ai.attempts),'reserved',(select coalesce(sum(reserved_count),0) from ai.user_quota_daily),'charged',(select coalesce(sum(charged_count),0) from ai.user_quota_daily),'admitted',(select coalesce(sum(admitted_count),0) from ai.global_quota_daily),'settled',(select coalesce(sum(settled_count),0) from ai.configuration_usage_daily));"));
}
if (!process.argv.includes("--run-disposable")) {
  console.log(JSON.stringify({ container, database, execute: false }));
  process.exit(0);
}
const inspected = JSON.parse(run("docker", ["inspect", container]))[0];
if (inspected.Name !== `/${container}`) throw new Error("Unexpected local container");
if (owner(`select count(*) from pg_database where datname=${quote(database)};`, "template1") !== "0") throw new Error("Existing concurrency database retained: inspect before starting a fresh run");
let created = false;
try {
  owner(`create database ${database};`, "template1"); created = true;
  owner("create schema extensions;create extension pgcrypto with schema extensions;create extension btree_gist with schema extensions;drop schema public;");
  // Copy schema, not developer data or Auth tokens. Seed only reviewed public catalogue and synthetic fixtures.
  const dump = run("docker", ["exec", container, "pg_dump", "--schema-only", "-U", "supabase_admin", "-d", "postgres",
    ...["public", "common", "cv", "ai", "legal", "admin", "audit", "auth"].map(schema => `--schema=${schema}`)]);
  owner(dump);
  owner("grant usage on schema extensions to app_api_owner;grant execute on function extensions.gen_random_bytes(integer),extensions.digest(text,text) to app_api_owner;");
  const catalog = readdirSync(resolve(root, "supabase/migrations")).filter(name => /_catalog_seed\.sql$/.test(name)).sort();
  if (!catalog.length) throw new Error("Reviewed catalogue migration is missing");
  for (const file of catalog) owner(readFileSync(resolve(root, "supabase/migrations", file), "utf8"));
  const fixture = spawnSync("docker", ["exec", "-i", container, "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], { input: "begin;\n" + readFileSync(resolve(root, "supabase/test-fixtures/ai-runtime.sql"), "utf8") + "\ncommit;", encoding: "utf8" });
  if (fixture.status !== 0) throw new Error("Synthetic disposable fixture failed: " + fixture.stderr.split("\n").filter(line => /^(ERROR|DETAIL|CONTEXT):/.test(line)).slice(0, 4).join(" "));
  const context = JSON.parse(owner("select public.app_context();"));
  const base = { contract_code: "cv_app_db_2", database_instance_id: context.database_instance_id, owner_auth_user_id: user };
  async function reservePayload() {
    const availability = await worker("ai_availability", base);
    const config = availability.configurations.find((item: { eligible: boolean; consent_required: boolean }) => item.eligible && !item.consent_required);
    assert(config, "Synthetic fixture must supply a usable explicitly accepted configuration");
    return {
      ...base, config_id: config.config_id, expected_config_revision: config.revision,
      expected_control_revision: availability.control_revision, client_request_key: randomUUID(),
      request_fingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
      common_document_audit_id: config.legal_display.common.document_audit_id,
      provider_document_audit_id: config.legal_display.provider.document_audit_id
    };
  }
  clearFacts();
  const input = await reservePayload();
  const reserved = await Promise.all([worker("ai_reserve", input), worker("ai_reserve", input)]);
  assert.equal(new Set(reserved.map(value => value.request_id)).size, 1);
  assert.equal(reserved.filter(value => value.replayed).length, 1);
  assert.equal(inspectCounts().reserved, 1);
  const request = { ...base, request_id: reserved[0].request_id };
  const started = await Promise.all([worker("ai_attempt_start", { ...request, attempt_no: 1 }), worker("ai_attempt_start", { ...request, attempt_no: 1 })]);
  assert.equal(started.filter(value => value.may_transmit).length, 1, "Only one concurrent start grants transmission");
  const terminal = { ...request, attempt_no: 1, state: "SUCCEEDED", transmitted: true, provider_billable: true, retry_allowed: false, usage_complete: true,
    usage: { input_total: "10", input_standard: "10", cache_read: "0", cache_write: "0", output: "2", reasoning: "1" } };
  const completed = await Promise.all([worker("ai_attempt_complete", terminal), worker("ai_attempt_complete", terminal)]);
  assert.equal(completed.filter(value => value.replayed).length, 1);
  await assert.rejects(worker("ai_attempt_complete", { ...terminal, usage: { ...terminal.usage, output: "3" } }));
  await Promise.all([worker("ai_finalize", request), worker("ai_finalize", request)]);
  assert.deepEqual(inspectCounts(), { requests: 1, attempts: 1, reserved: 0, charged: 1, admitted: 1, settled: 1 });

  clearFacts(); owner("update ai.runtime_control set user_daily_limit=1;");
  const limited = await reservePayload();
  const race = await Promise.allSettled([worker("ai_reserve", limited), worker("ai_reserve", { ...limited, client_request_key: randomUUID() })]);
  assert.equal(race.filter(value => value.status === "fulfilled").length, 1, "User quota must be enforced atomically");
  assert.equal(inspectCounts().reserved, 1);

  clearFacts();
  owner("create schema fixture_clock;create table fixture_clock.state(id integer primary key,observed_at timestamptz not null);insert into fixture_clock.state values(1,'2026-12-31T23:59:59Z');grant usage on schema fixture_clock to app_api_owner;grant select on fixture_clock.state to app_api_owner;create or replace function common.now() returns timestamptz language sql volatile set search_path='' as $$select observed_at from fixture_clock.state where id=1$$;grant execute on function common.now() to app_api_owner;");
  const crossing = await reservePayload();
  const lock = await holder();
  const pending = worker("ai_reserve", crossing, "cv_v2_day_boundary");
  try {
    await observeWait("cv_v2_day_boundary", lock.pid);
    owner("update fixture_clock.state set observed_at='2027-01-01T00:00:01Z';");
  } finally { await lock.release(); }
  const after = await pending;
  const dates = JSON.parse(owner(`select jsonb_build_object('reserve',(select reserve_day from ai.requests where external_id=${quote(after.request_id)}),'quota',(select day from ai.user_quota_daily));`));
  assert.equal(dates.reserve, "2027-01-01");
  assert.equal(dates.quota, "2027-01-01", "UTC day is observed after the control lock");

  clearFacts();
  owner("update fixture_clock.state set observed_at='2026-12-31T23:59:59Z';");
  const beforeMidnight = await worker("ai_reserve", await reservePayload());
  const admissionLock = await holder();
  const admission = worker("ai_attempt_start", { ...base, request_id: beforeMidnight.request_id, attempt_no: 1 }, "cv_v2_admission_boundary").then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  try {
    await observeWait("cv_v2_admission_boundary", admissionLock.pid);
    owner("update fixture_clock.state set observed_at='2027-01-01T00:00:01Z';");
  } finally { await admissionLock.release(); }
  const admitted = await admission;
  assert(admitted.ok, "First attempt should be admitted on the newly observed UTC day");
  assert.equal(admitted.value.may_transmit, true);
  const separated = JSON.parse(owner(`select jsonb_build_object('reserve',(select reserve_day from ai.requests where external_id=${quote(beforeMidnight.request_id)}),'admission',(select provider_admission_day from ai.requests where external_id=${quote(beforeMidnight.request_id)}),'user_day',(select day from ai.user_quota_daily),'global_day',(select day from ai.global_quota_daily));`));
  assert.deepEqual(separated, { reserve: "2026-12-31", admission: "2027-01-01", user_day: "2026-12-31", global_day: "2027-01-01" });

  clearFacts();
  owner("update fixture_clock.state set observed_at='2027-01-04T09:59:59Z';");
  const choices = (await worker("ai_availability", base)).configurations.filter((item: { eligible: boolean; consent_required: boolean }) => item.eligible && !item.consent_required);
  assert(choices.length >= 2, "Time-boundary scenario needs two explicitly accepted configurations");
  const first = choices[0].config_id, second = choices[1].config_id;
  owner(`begin;insert into ai.routing_rules(id,weekday,start_minute,end_minute,enabled) overriding system value values(9001,1,0,1080,true),(9002,1,1080,1440,true);insert into ai.routing_rule_configurations(rule_id,config_id,is_default) values(9001,${quote(first)}::bigint,true),(9002,${quote(second)}::bigint,true);commit;`);
  const expiring = await reservePayload();
  assert.equal(expiring.config_id, first);
  const ruleLock = await holder();
  const expired = worker("ai_reserve", expiring, "cv_v2_rule_boundary").then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  try {
    await observeWait("cv_v2_rule_boundary", ruleLock.pid);
    owner("update fixture_clock.state set observed_at='2027-01-04T10:00:01Z';");
  } finally { await ruleLock.release(); }
  assert.equal((await expired).ok, false, "A selection expiring at 18:00 Shanghai must not reserve after waiting for the lock");
  assert.deepEqual(inspectCounts(), { requests: 0, attempts: 0, reserved: 0, charged: 0, admitted: 0, settled: 0 });
  const eligibleAfterBoundary = (await worker("ai_availability", base)).configurations.filter((item: { eligible: boolean }) => item.eligible).map((item: { config_id: string }) => item.config_id);
  assert(!eligibleAfterBoundary.includes(first));
  assert(eligibleAfterBoundary.includes(second));
  console.log(JSON.stringify({ disposable: true, reservation_idempotency: true, single_transmission: true, terminal_idempotency: true, single_settlement: true, atomic_user_limit: true, locked_day_boundary: true, separate_admission_day: true, expired_rule_has_no_occupancy: true }));
} finally {
  if (created && !process.env.CV_KEEP_CONCURRENCY_DB) owner(`drop database ${database} with(force);`, "template1");
}
