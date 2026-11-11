import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cvSchema } from "../web/src/lib/cv/schema.ts";
import { migrationManifest, root } from "./db-common.ts";
import { APPLICATION_GATES } from "./db-test-revalidation.ts";
import { currentCleanup, loadTestRevalidation } from "./db-test-revalidate.ts";

const source = "b".repeat(40), original = "a".repeat(40), project = "c".repeat(20), instance = "00000000-0000-4000-8000-000000000071";
const manifest = migrationManifest(), cleanup = currentCleanup();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cv-revalidation-entry-")), bin = join(directory, "bin"), log = join(directory, "calls.jsonl");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  const json = (name: string, value: unknown) => { const path = join(directory, name); writeFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 }); return path; };
  const state = { operation_id: "00000000-0000-4000-8000-000000000072", target: "test", project, source_sha: original, ...manifest, ...cleanup, instance, history: manifest.files.map(file => file.name.split("_")[0]), phase: "accepted", maintenance: false, intent_time: "2026-11-09T00:00:00Z" };
  const statePath = json("original.json", state), originalBytes = readFileSync(statePath);
  const rehearsalPath = json("remote-rehearsal-proof.json", { source_sha: source, ...manifest, ...cleanup, method: cleanup.reset_method, cli_version: "2.109.0", old_chain_passed: true, platform_preservation_passed: true, remote_mode_resume_passed: true });
  const zipPath = join(directory, "ci.zip");
  execFileSync("zip", ["-q", zipPath, "remote-rehearsal-proof.json"], { cwd: directory }); chmodSync(zipPath, 0o600);
  const archiveDigest = hash(readFileSync(zipPath));
  const ciPath = json("ci.json", { format: "candidate_ci_evidence_1", repository: "Yuee98/typst-cv-template", source_sha: source, web_run_id: 11, database_run_id: 12, artifact_id: 13, artifact_archive: { path: "ci.zip", sha256: archiveDigest } });
  const gatePath = json("gate.json", { observed: true, description: "Synthetic operator acceptance reference; not an HTTP/browser test" });
  const appPath = json("application.json", { format: "test_application_acceptance_1", source_sha: source, project, database_instance_id: instance, environment: "PREVIEW", deployment_id: "synthetic-deployment", deployed_source_sha: source, gates: Object.fromEntries(APPLICATION_GATES.map(name => [name, { passed: true, evidence: { path: "gate.json", sha256: hash(readFileSync(gatePath)) } }])) });
  const catalog = { tables: ["cv.documents", "ai.adapters", "ai.configurations", "ai.prices", "ai.routing_rules", "ai.routing_rule_configurations", "ai.runtime_control", "ai.allowed_users", "ai.requests", "ai.request_snapshots", "ai.attempts", "ai.user_quota_daily", "ai.global_quota_daily", "ai.rate_minutes", "ai.configuration_usage_daily", "legal.documents", "legal.acceptances", "admin.environment", "admin.members", "admin.operations", ...["configurations", "prices", "rules", "rule_members", "runtime_control", "allowed_users", "documents", "acceptances", "members", "environment"].map(name => `audit.${name}`)], unstructured_columns: [], ...Object.fromEntries(["unprotected", "public_tables", "unsafe_functions", "bad_owner", "api_owner_members", "owner_outgoing_roles", "owner_platform_column_access", "public_execute", "api_table_writes"].map(key => [key, 0])), privileged_owner: false, cv_schema: cvSchema.toJSONSchema(), context: { ready: true, contract_code: "cv_app_db_2", environment: "PREVIEW", database_instance_id: instance }, history: state.history };
  const guard = join(directory, "commands.mjs");
  writeFileSync(guard, `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; const spawn=cp.spawnSync; cp.spawnSync=(command,...args)=>{if(!['git','gh','psql','unzip'].includes(command))throw new Error('Unstubbed command refused'); return spawn(command,...args)}; syncBuiltinESMExports();`);
  const stub = `#!${process.execPath}
import {appendFileSync,readFileSync} from 'node:fs'; import {basename} from 'node:path';
const tool=basename(process.argv[1]),args=process.argv.slice(2),sql=tool==='psql'?readFileSync(0,'utf8'):'';
appendFileSync(process.env.ENTRY_LOG,JSON.stringify({tool,args,sql,pgoptions:process.env.PGOPTIONS??null})+'\\n');
if(tool==='git'){
 if(args.join(' ')==='rev-parse HEAD')console.log(process.env.ENTRY_SHA);
 else if(args[0]!=='merge-base'&&args.join(' ')!=='status --porcelain --untracked-files=normal')process.exit(81);
}else if(tool==='gh'){
 const path=args[1]; const run={id:path.endsWith('/11')?11:12,head_sha:process.env.ENTRY_SHA,path:path.endsWith('/11')?'.github/workflows/ci.yml':'.github/workflows/db-tests.yml',status:'completed',conclusion:'success',event:path.endsWith('/11')?'push':'workflow_dispatch',run_attempt:1};
 console.log(JSON.stringify(path.includes('/artifacts/')?{id:13,name:'database-rehearsal-evidence',expired:false,digest:'sha256:'+process.env.ENTRY_ZIP_DIGEST,workflow_run:{id:12,head_sha:process.env.ENTRY_SHA}}:run));
}else{
 if(!/^select\\s/i.test(sql)||!process.env.ENTRY_PROD&&!process.env.PGOPTIONS?.includes('default_transaction_read_only=on'))process.exit(83);
 if(sql.includes("'server_version_num'"))console.log(JSON.stringify({server_version_num:'170006',database:'postgres',current_user:'postgres'}));
 else if(process.env.ENTRY_PROD&&sql.includes("'application_tables'"))console.log(JSON.stringify({application_tables:0,environment_relation:false,instance_id:null}));
 else if(process.env.ENTRY_PROD&&sql.includes('jsonb_agg(version order by version)'))console.log('[]');
 else if(process.env.ENTRY_PROD&&sql.includes("'public_tables'"))console.log(JSON.stringify({public_tables:[],public_functions:[],application_objects:[]}));
 else if(process.env.ENTRY_PROD&&sql.includes('from auth.users'))console.log('false');
 else if(sql.includes("'tables'")){const data=JSON.parse(process.env.ENTRY_CATALOG);if(process.env.ENTRY_CASE==='instance')data.context.database_instance_id=null;console.log(JSON.stringify(data));}
 else if(sql.includes('from ai.runtime_control'))console.log(JSON.stringify({enabled:true,audience:'ALLOWLIST',revision:'36',user_daily_limit:'20',global_daily_limit:'2000',user_minute_limit:'3'}));
 else process.exit(84);
}
`;
  for (const tool of ["git", "gh", "psql"]) writeFileSync(join(bin, tool), stub, { mode: 0o700 });
  const output = join(directory, "revalidation.json");
  const environment = { PATH: `${bin}:/usr/bin:/bin`, ENTRY_LOG: log, ENTRY_SHA: source, ENTRY_CATALOG: JSON.stringify(catalog), ENTRY_ZIP_DIGEST: archiveDigest, REBUILD_PROJECT_REF: project, REBUILD_OTHER_PROJECT_REF: "d".repeat(20), REBUILD_SUPABASE_URL: `https://${project}.supabase.co`, REBUILD_DATABASE_URL: `postgresql://postgres:fixture@db.${project}.supabase.co/postgres`, REBUILD_CA_CERT_FILE: fileURLToPath(new URL("./test-fixtures/database-ca.crt", import.meta.url)), PGOPTIONS: "-c default_transaction_read_only=off" };
  function execute(readOnly: boolean, entryCase = "ok") {
    const result = spawnSync(process.execPath, ["--import", guard, fileURLToPath(new URL("./db-test-revalidate.ts", import.meta.url)), `--source-sha=${source}`, `--expected-project-ref=${project}`, `--test-state=${statePath}`, `--ci-evidence=${ciPath}`, `--rehearsal-evidence=${rehearsalPath}`, `--application-evidence=${appPath}`, `--output=${output}`, ...(readOnly ? ["--execute-read-only"] : [])], { cwd: root, encoding: "utf8", timeout: 15_000, env: { ...environment, ENTRY_CASE: entryCase } });
    assert.equal(result.error, undefined);
    assert.deepEqual(readFileSync(statePath), originalBytes, "Original accepted bytes must remain untouched");
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { tool: string; args: string[]; sql: string; pgoptions: string | null }) : [];
    return { result, calls };
  }
  function productionEntry() {
    const productionProject = "d".repeat(20), stateDirectory = join(directory, "production-state"); mkdirSync(stateDirectory, { mode: 0o700 });
    writeFileSync(log, "");
    const result = spawnSync(process.execPath, ["--import", guard, fileURLToPath(new URL("./db-rebuild.ts", import.meta.url)), "--mode=rebuild", "--target=prod", `--source-sha=${source}`, `--expected-project-ref=${productionProject}`, `--state-dir=${stateDirectory}`, `--confirm-project=${productionProject}`, "--confirm-destruction=DELETE_APPLICATION_DATA", "--admin-user=00000000-0000-4000-8000-000000000079", `--rehearsal-evidence=${rehearsalPath}`, `--test-state=${statePath}`, `--test-revalidation=${output}`], { cwd: root, encoding: "utf8", timeout: 15_000, env: { ...environment, ENTRY_PROD: "true", REBUILD_PROJECT_REF: productionProject, REBUILD_OTHER_PROJECT_REF: project, REBUILD_SUPABASE_URL: `https://${productionProject}.supabase.co`, REBUILD_DATABASE_URL: `postgresql://postgres:fixture@db.${productionProject}.supabase.co/postgres`, REBUILD_EXECUTION_AUTHORIZED: "true", REBUILD_MAINTENANCE_VERIFIED: "true" } });
    assert.equal(result.error, undefined);
    assert.deepEqual(readFileSync(statePath), originalBytes);
    assert.equal(existsSync(join(stateDirectory, `prod-${productionProject}.json`)), false);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { tool: string; sql: string });
    assert.equal(calls.some(call => call.tool === "gh"), false, "Production consumes archived CI evidence offline");
    assert(calls.filter(call => call.tool === "psql").every(call => /^select\s/i.test(call.sql) && !/\b(?:initialize|register_jobs|alter_job)\s*\(/i.test(call.sql)));
    const events = readFileSync(join(stateDirectory, `prod-${productionProject}.events.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.some(event => event.event === "checkpoint_saved"), false);
    return { result, events, calls };
  }
  return { directory, output, statePath, state, originalBytes, rehearsalPath, ciPath, appPath, gatePath, execute, productionEntry, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

test("default revalidation plan validates local materials with zero hosted/CI commands and no new state", () => {
  const f = fixture();
  try {
    const { result, calls } = f.execute(false);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).connects_to_database, false);
    assert(calls.every(call => call.tool === "git"));
    assert.equal(existsSync(f.output), false);
    assert.equal(readdirSync(f.directory).some(name => name.startsWith("verification-") || name.endsWith(".lock") || name.endsWith(".events.jsonl")), false);
  } finally { f.dispose(); }
});

test("explicit read-only entry validates CI/G3 and live identity, preserving AI-on and every checkpoint byte", () => {
  const f = fixture();
  try {
    const { result, calls } = f.execute(true);
    assert.equal(result.status, 0, result.stderr);
    const proof = JSON.parse(readFileSync(f.output, "utf8"));
    assert.equal(proof.accepted_checkpoint_sha256, hash(f.originalBytes));
    assert.equal(proof.source_sha, source);
    const report = JSON.parse(readFileSync(join(f.directory, proof.evidence.verification.path), "utf8"));
    assert.equal(report.runtime.enabled, true);
    assert.equal(report.runtime.revision, "36");
    const archived = loadTestRevalidation(f.output, f.state, hash(f.originalBytes), source, project, manifest, cleanup, hash(readFileSync(f.rehearsalPath)));
    assert.equal(archived.proof.source_sha, source, "Archived evidence loads offline without gh or a database connection");
    assert.deepEqual(readFileSync(f.statePath), f.originalBytes);
    assert.equal(calls.filter(call => call.tool === "gh").length, 3);
    const queries = calls.filter(call => call.tool === "psql");
    assert.equal(queries.length, 3);
    assert(queries.every(call => /^select\s/i.test(call.sql) && call.pgoptions?.includes("default_transaction_read_only=on") && !/\b(?:initialize|register_jobs|alter_job)\s*\(/i.test(call.sql)));
  } finally { f.dispose(); }
});

test("offline production consumption rejects altered proof bindings and missing archived support", () => {
  const f = fixture();
  try {
    assert.equal(f.execute(true).result.status, 0);
    const bytes = readFileSync(f.output), proof = JSON.parse(bytes.toString("utf8"));
    const load = () => loadTestRevalidation(f.output, f.state, hash(f.originalBytes), source, project, manifest, cleanup, hash(readFileSync(f.rehearsalPath)));
    for (const change of [{ accepted_checkpoint_sha256: "9".repeat(64) }, { database_instance_id: "00000000-0000-4000-8000-000000000079" }, { application_deployment_id: "other-deployment" }, { ci: { ...proof.ci, web_run: { ...proof.ci.web_run, head_sha: original } } }]) {
      writeFileSync(f.output, JSON.stringify({ ...proof, ...change })); assert.throws(load);
    }
    writeFileSync(f.output, bytes);
    unlinkSync(f.gatePath); assert.throws(load);
  } finally { f.dispose(); }
});

test("wrong live instance fails without publishing a proof, writing a checkpoint or invoking mutation SQL", () => {
  const f = fixture();
  try {
    const { result, calls } = f.execute(true, "instance");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /read_only_catalog/);
    assert.equal(existsSync(f.output), false);
    assert(calls.filter(call => call.tool === "psql").every(call => /^select\s/i.test(call.sql)));
  } finally { f.dispose(); }
});

test("a changed application evidence file and mismatched CI ZIP are rejected before any hosted query", () => {
  for (const kind of ["application", "zip"] as const) {
    const f = fixture();
    try {
      if (kind === "application") writeFileSync(f.gatePath, '{"changed":true}');
      else writeFileSync(f.rehearsalPath, readFileSync(f.rehearsalPath, "utf8") + " ");
      const { result, calls } = f.execute(true);
      assert.equal(result.status, 1);
      assert.equal(calls.some(call => call.tool === "psql" || call.tool === "gh"), false);
      assert.equal(existsSync(f.output), false);
    } finally { f.dispose(); }
  }
});

test("real prod entry requires both original and detached evidence before Auth preflight or any durable write", () => {
  for (const valid of [true, false]) {
    const f = fixture();
    try {
      assert.equal(f.execute(true).result.status, 0);
      if (!valid) {
        const proof = JSON.parse(readFileSync(f.output, "utf8"));
        writeFileSync(f.output, JSON.stringify({ ...proof, accepted_checkpoint_sha256: "9".repeat(64) }));
      }
      const { result, events, calls } = f.productionEntry();
      assert.equal(result.status, 1);
      assert.equal(events.at(-1).stage, valid ? "administrator_preflight" : "mutation_authorization");
      assert.equal(events.some(event => event.event === "accepted_test_checked" && event.test_revalidation_digest), valid);
      assert.equal(calls.some(call => call.tool === "psql" && call.sql.includes("from auth.users")), valid);
    } finally { f.dispose(); }
  }
});
