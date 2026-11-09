import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrationManifest, root } from "./db-common.ts";

const project = "a".repeat(20);
const admin = "00000000-0000-4000-8000-000000000099";
const instance = "00000000-0000-4000-8000-000000000087";
const otherInstance = "00000000-0000-4000-8000-000000000086";
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const manifest = migrationManifest();
const hashFile = (path: string) => createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
const cleanup = { reset_method: "application_allowlist", cleanup_sql_digest: hashFile("supabase/retired-application-reset.sql"), retired_inventory_digest: hashFile("scripts/database-retired-objects.json") };

function runEntry(mode: "plan" | "rebuild" | "resume" | "verify", phase: "DB-ready" | "accepted" | null, authCase: "missing" | "disabled", instanceCase: "matching" | "mismatch" | "missing" = "matching") {
  const directory = mkdtempSync(join(tmpdir(), "cv-rebuild-entry-"));
  try {
    const bin = join(directory, "bin"), stateDirectory = join(directory, "state"), log = join(directory, "calls.jsonl");
    mkdirSync(bin); mkdirSync(stateDirectory, { mode: 0o700 });
    writeFileSync(join(bin, "package.json"), '{"type":"module"}');
    const commandGuard = join(directory, "commands.mjs");
    writeFileSync(commandGuard, `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; const spawn=cp.spawnSync; cp.spawnSync=(command,...args)=>{ if(command!=='git'&&command!=='psql') throw new Error('Unstubbed command refused'); return spawn(command,...args); }; syncBuiltinESMExports();`);
    // Run the real entry and checkpoint implementation. Only process commands
    // are fake: git reports the current candidate as clean/on-main; psql models
    // read-only preflight responses, never a live Auth/SQL/hosted connection.
    const stub = `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
const tool = basename(process.argv[1]), args = process.argv.slice(2);
const sql = tool === 'psql' ? readFileSync(0, 'utf8') : '';
appendFileSync(process.env.ENTRY_LOG, JSON.stringify({ tool, args, sql }) + '\\n');
if (tool === 'git') {
  if (args.join(' ') === 'rev-parse HEAD') console.log(process.env.ENTRY_SHA);
  else if (!['merge-base --is-ancestor ' + process.env.ENTRY_SHA + ' origin/main', 'status --porcelain --untracked-files=normal'].includes(args.join(' '))) process.exit(80);
} else if (sql.includes("'server_version_num'")) console.log(JSON.stringify({ server_version_num:'170006', database:'postgres', current_user:'postgres' }));
else if (sql.includes("'application_tables'")) console.log(JSON.stringify({ application_tables:process.env.ENTRY_PHASE ? 30 : 0, environment_relation:Boolean(process.env.ENTRY_PHASE) && process.env.ENTRY_INSTANCE_CASE !== 'missing', instance_id:null }));
else if (sql.includes('information_schema.columns')) console.log('true');
else if (sql.includes('database_instance_id::text')) console.log(JSON.stringify(process.env.ENTRY_INSTANCE_CASE === 'mismatch' ? process.env.ENTRY_OTHER_INSTANCE : process.env.ENTRY_INSTANCE));
else if (sql.includes('jsonb_agg(version order by version)')) console.log(process.env.ENTRY_PHASE ? process.env.ENTRY_HISTORY : '[]');
else if (sql.includes("'public_tables'")) console.log(JSON.stringify({ public_tables:[], public_functions:[], application_objects:[] }));
else if (sql.includes('from auth.users')) {
  if (!sql.includes('deleted_at is null') || !sql.includes('banned_until < clock_timestamp()')) process.exit(81);
  const users = process.env.ENTRY_AUTH_CASE === 'missing' ? [] : [{ id:process.env.ENTRY_ADMIN, disabled:true }];
  console.log(JSON.stringify(users.some(user => user.id === process.env.ENTRY_ADMIN && !user.disabled)));
} else process.exit(82); // Refuse every unrecognized SQL, including job/DDL calls.
`;
    for (const command of ["git", "psql"]) writeFileSync(join(bin, command), stub, { mode: 0o700 });
    const checkpoint = join(stateDirectory, `test-${project}.json`);
    const state = { operation_id: "00000000-0000-4000-8000-000000000088", target: "test", project, source_sha: sourceSha, baseline_digest: manifest.baseline_digest, migration_manifest_digest: manifest.migration_manifest_digest, ...cleanup, phase, ...(phase ? { instance, history: manifest.files.map(file => file.name.split("_")[0]) } : {}), maintenance: phase !== "accepted", intent_time: "2026-11-09T00:00:00Z" };
    const before = phase ? JSON.stringify(state, null, 2) + "\n" : null;
    if (before) writeFileSync(checkpoint, before, { mode: 0o600 });
    const evidence = join(directory, "proof.json");
    writeFileSync(evidence, JSON.stringify({ source_sha: sourceSha, ...manifest, ...cleanup, method: cleanup.reset_method, cli_version: "2.109.0", old_chain_passed: true, platform_preservation_passed: true, remote_mode_resume_passed: true }));
    const result = spawnSync(process.execPath, ["--import", commandGuard, fileURLToPath(new URL("./db-rebuild.ts", import.meta.url)), `--mode=${mode}`, "--target=test", `--source-sha=${sourceSha}`, `--expected-project-ref=${project}`, `--state-dir=${stateDirectory}`, `--confirm-project=${project}`, "--confirm-destruction=DELETE_APPLICATION_DATA", `--admin-user=${admin}`, `--rehearsal-evidence=${evidence}`], {
      cwd: root, encoding: "utf8", timeout: 10_000,
      env: { PATH: bin, ENTRY_LOG: log, ENTRY_SHA: sourceSha, ENTRY_AUTH_CASE: authCase, ENTRY_ADMIN: admin, ENTRY_PHASE: phase ?? "", ENTRY_INSTANCE_CASE: instanceCase, ENTRY_INSTANCE: instance, ENTRY_OTHER_INSTANCE: otherInstance, ENTRY_HISTORY: JSON.stringify(manifest.files.map(file => file.name.split("_")[0])), REBUILD_PROJECT_REF: project, REBUILD_OTHER_PROJECT_REF: "b".repeat(20), REBUILD_SUPABASE_URL: `https://${project}.supabase.co`, REBUILD_DATABASE_URL: `postgresql://postgres:fixture@db.${project}.supabase.co/postgres`, REBUILD_CA_CERT_FILE: fileURLToPath(new URL("./test-fixtures/database-ca.crt", import.meta.url)), REBUILD_EXECUTION_AUTHORIZED: "true", REBUILD_MAINTENANCE_VERIFIED: "true" }
    });
    assert.equal(result.error, undefined);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { tool: string; args: string[]; sql: string });
    const events = readFileSync(join(stateDirectory, `test-${project}.events.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(existsSync(checkpoint) ? readFileSync(checkpoint, "utf8") : null, before, "Checkpoint must stay byte-identical (or absent)");
    assert.equal(existsSync(join(stateDirectory, `${project}.lock`)), false);
    assert.equal(events.some(event => event.event === "checkpoint_saved" || event.event === "administrator_preflight_passed" || mode !== "plan" && event.event === "run_completed"), false);
    const queries = calls.filter(call => call.tool === "psql").map(call => call.sql);
    assert(queries.every(sql => /^select\s/i.test(sql) && !/\b(?:register_jobs|initialize|alter_job)\s*\(/i.test(sql)), "Only read-only preflight statements may be submitted");
    assert.equal(queries.filter(sql => sql.includes("'server_version_num'")).length, 1);
    assert(queries.some(sql => sql.includes("'public_tables'")));
    assert.equal(calls.some(call => call.tool === "git" && call.args[0] === "merge-base"), mode !== "plan");
    assert.equal(result.status, mode === "plan" ? 0 : 1);
    const failure = events.at(-1);
    assert.equal(failure.event, mode === "plan" ? "run_completed" : "run_failed_lock_released");
    return { stdout: result.stdout, stderr: result.stderr, stage: failure.stage, queries, events };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("entry rejects nonexistent or disabled Auth administrators before cleanup or checkpoint writes", () => {
  for (const [mode, phase, authCase] of [["rebuild", null, "missing"], ["resume", "DB-ready", "disabled"]] as const) {
    const result = runEntry(mode, phase, authCase);
    assert.equal(result.stage, "administrator_preflight");
    assert.match(result.stderr, /stopped during administrator_preflight/);
    assert.equal(result.queries.filter(sql => sql.includes(`id='${admin}'::uuid`)).length, 1);
  }
});

test("entry treats accepted checkpoints as terminal for resume and rebuild without rescheduling jobs", () => {
  for (const mode of ["resume", "rebuild"] as const) {
    const result = runEntry(mode, "accepted", "missing");
    assert.equal(result.stage, "catalog_inspection");
    assert.match(result.stderr, /stopped during catalog_inspection/);
    assert.equal(result.queries.some(sql => sql.includes("auth.users")), false);
    assert(result.events.some(event => event.event === "checkpoint_read" && event.phase === "accepted"));
  }
});


for (const mode of ["resume", "verify"] as const) {
  for (const instanceCase of ["mismatch", "missing"] as const) {
    test(`entry rejects ${instanceCase} live instance during ${mode} before Auth, writes or jobs`, () => {
      const result = runEntry(mode, "DB-ready", "disabled", instanceCase);
      assert.equal(result.stage, "instance_binding");
      assert.match(result.stderr, /stopped during instance_binding/);
      assert.equal(result.queries.some(sql => sql.includes("auth.users")), false);
      assert.equal(result.queries.filter(sql => sql.includes("'public_tables'")).length, 1);
      assert(result.events.some(event => event.event === "checkpoint_read" && event.instance === instance));
    });
  }
}

test("a matching instance continues to the existing administrator preflight rather than blanket-rejecting resume", () => {
  const result = runEntry("resume", "DB-ready", "disabled", "matching");
  assert.equal(result.stage, "administrator_preflight");
  assert.equal(result.queries.filter(sql => sql.includes("auth.users")).length, 1);
});


test("plan still diagnoses a stale checkpoint without main ancestry or database writes", () => {
  const result = runEntry("plan", "DB-ready", "disabled", "mismatch");
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.existing_state.instance, instance);
  assert.equal(plan.new_application.instance_id, otherInstance);
  assert.equal(plan.destructive, false);
  assert.equal(result.queries.some(sql => sql.includes("auth.users")), false);
});
