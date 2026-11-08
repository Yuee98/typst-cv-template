import { parseRebuildState, validateProjectIdentity, requireMaintenanceAuthorization, validateRehearsalIdentity, migrationWithHistory, requireAcceptedTest, validateDatabaseServer, requireFreshApplicationState, requireRecoveryEvidence, requireRehearsalEvidence, requireAppendOnlyManifest, type RebuildState } from "./db-safety.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { input, jsonQuery, migrationManifest, root, run, sql } from "./db-common.ts";
import { checkContract } from "./db-contract-check.ts";
type State = RebuildState;
const mode = input("mode", "plan");
const target = input("target", process.argv.includes("--local") ? "local" : undefined);
const local = target === "local";
const rehearsal = target === "rehearsal";
const localState = local || rehearsal;
if (rehearsal !== process.argv.includes("--rehearsal")) throw new Error("Rehearsal target requires its explicit isolated mode");
if (!["plan", "rebuild", "resume", "verify"].includes(mode) || !["local", "rehearsal", "test", "prod"].includes(target)) throw new Error("Invalid mode or target");
if (local !== process.argv.includes("--local")) throw new Error("Local target requires explicit --local");
const sha = input("source-sha", run("git", ["rev-parse", "HEAD"]));
if (!/^[0-9a-f]{40}$/.test(sha) || run("git", ["rev-parse", "HEAD"]) !== sha) throw new Error("Checkout must equal complete source SHA");
const manifest = migrationManifest();
const cleanupPath = resolve(root, "supabase/retired-application-reset.sql");
const inventoryPath = resolve(root, "scripts/database-retired-objects.json");
const cleanup = local ? null : {
  reset_method: "application_allowlist" as const,
  cleanup_sql_digest: createHash("sha256").update(readFileSync(cleanupPath)).digest("hex"),
  retired_inventory_digest: createHash("sha256").update(readFileSync(inventoryPath)).digest("hex")
};
const project = local ? "typst-cv-template" : rehearsal ? "cv-remote-rehearsal" : input("expected-project-ref");
if (rehearsal) validateRehearsalIdentity(process.env.REBUILD_DATABASE_URL ?? "", JSON.parse(run("docker", ["inspect", "supabase_db_cv-remote-rehearsal"]))[0]);
if (!localState) {
  validateProjectIdentity(target, project, process.env);
  run("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
  if (run("git", ["status", "--porcelain", "--untracked-files=normal"]).length) throw new Error("Hosted operations require a clean checkout bound to source SHA");
}
const file = localState ? resolve(root, rehearsal ? "tmp/db-rebuild-rehearsal.json" : "tmp/db-rebuild-local.json") : null;
const variable = `DB_REBUILD_STATE_${target.toUpperCase()}`;
const repo = process.env.GITHUB_REPOSITORY;
function readState(): State | null {
  if (localState) return existsSync(file!) ? parseRebuildState(JSON.parse(readFileSync(file!, "utf8"))) : null;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Hosted runs require GitHub repository and authenticated durable Actions-variable state");
  const variables = JSON.parse(run("gh", ["api", `repos/${repo}/actions/variables?per_page=100`]));
  if (variables.total_count > 100) throw new Error("Variable pagination required; refusing incomplete state lookup");
  const entry = variables.variables.find((value: {
    name: string;
  }) => value.name === variable);
  return entry ? parseRebuildState(JSON.parse(entry.value)) : null;
}
function saveState(value: State) {
  if (localState) {
    mkdirSync(resolve(root, "tmp"), {
      recursive: true
    });
    writeFileSync(file!, JSON.stringify(value, null, 2));
    return;
  }
  const exists = readState() !== null;
  // The workflow owns a shared environment mutex. Persistent state survives job loss.
  run("gh", ["api", "--method", exists ? "PATCH" : "POST", `repos/${repo}/actions/variables${exists ? `/${variable}` : ""}`, "--input", "-"], JSON.stringify({
    name: variable,
    value: JSON.stringify(value)
  }));
}
function applyMissingMigrations(applied: string[]) {
  const expected = manifest.files.map(entry => entry.name.split("_")[0]);
  if (applied.some((version, index) => version !== expected[index])) throw new Error("History is not a prefix of current manifest");
  for (const entry of manifest.files.slice(applied.length)) {
    const version = entry.name.split("_")[0];
    sql(migrationWithHistory(readFileSync(resolve(root, "supabase/migrations", entry.name), "utf8"), version, entry.name), local);
  }
}
const serverIdentity = jsonQuery("select jsonb_build_object('server_version_num',current_setting('server_version_num'),'database',current_database(),'current_user',current_user,'session_user',session_user,'server_address',inet_server_addr(),'server_port',inet_server_port());", local);
validateDatabaseServer(serverIdentity);
const old = readState();
if (old && (old.target !== target || old.project !== project || old.baseline_digest !== manifest.baseline_digest)) throw new Error("Existing operation belongs to another target or baseline");
if (old) requireAppendOnlyManifest(old.migration_manifest_digest, manifest.files);
const newApplication = jsonQuery("select jsonb_build_object('application_tables',(select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname in ('cv','ai','legal','admin','audit') and c.relkind in ('r','p')),'environment_relation',to_regclass('admin.environment') is not null,'instance_id',null);", local);
if (newApplication.environment_relation && jsonQuery("select to_jsonb(exists(select 1 from information_schema.columns where table_schema='admin' and table_name='environment' and column_name='database_instance_id'));", local)) newApplication.instance_id = jsonQuery("select coalesce((select to_jsonb(database_instance_id::text) from admin.environment where id=1),'null'::jsonb);", local);
const history: string[] = jsonQuery("select coalesce(jsonb_agg(version order by version),'[]') from supabase_migrations.schema_migrations;", local);
const inspection = jsonQuery(`select jsonb_build_object(
 'public_tables',(select coalesce(jsonb_agg(c.relname order by c.relname),'[]') from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')),
 'public_functions',(select coalesce(jsonb_agg(p.proname order by p.proname),'[]') from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')),
 'application_objects',(select coalesce(jsonb_agg(n.nspname||'.'||c.relname||':'||c.relkind::text order by n.nspname,c.relname),'[]') from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname in ('common','cv','ai','legal','admin','audit'))
);`, local);
const inspectionDigest = createHash("sha256").update(JSON.stringify({
  history,
  inspection
})).digest("hex");
if (mode === "plan") {
  console.log(JSON.stringify({
    target,
    project,
    source_sha: sha,
    ...manifest,
    server_identity: serverIdentity,
    new_application: newApplication,
    cleanup,
    existing_state: old,
    history,
    reset_inspection: inspection,
    reset_catalog_digest: inspectionDigest,
    destructive: false
  }));
} else if (mode === "verify") {
  console.log(JSON.stringify({
    ...checkContract(local),
    target,
    project,
    source_sha: sha,
    operation: old
  }));
} else {
  if (!localState) {
    requireMaintenanceAuthorization(process.env);
    if (input("confirm-project") !== project || input("confirm-destruction") !== "DELETE_APPLICATION_DATA") throw new Error("Explicit destructive run inputs required");
    const proof = JSON.parse(readFileSync(input("rehearsal-evidence"), "utf8"));
    requireRehearsalEvidence(proof, sha, manifest, cleanup!);
    if (target === "prod") {
      const test = JSON.parse(run("gh", ["api", `repos/${repo}/actions/variables/DB_REBUILD_STATE_TEST`])).value;
      const verified = parseRebuildState(JSON.parse(test));
      requireAcceptedTest(verified, process.env.REBUILD_OTHER_PROJECT_REF, sha, manifest);
    }
  }
  if (mode === "rebuild" && !old) requireFreshApplicationState(newApplication);
  if (mode === "rebuild" && (old || history.some(version => manifest.files.some(entry => entry.name.startsWith(`${version}_`))))) throw new Error("Operation/baseline already exists; resume or verify, never reset again");
  if (mode === "resume" && !old) throw new Error("Missing durable intent; refusing to infer reset status");
  const state: State = old ?? {
    operation_id: crypto.randomUUID(),
    target,
    project,
    source_sha: sha,
    baseline_digest: manifest.baseline_digest,
    migration_manifest_digest: manifest.migration_manifest_digest,
    phase: "intent",
    intent_time: new Date().toISOString(),
    maintenance: true,
    ...(cleanup ?? {
      reset_method: "local_native" as const
    })
  };
  // Appended fixes are supported; the explicitly recorded baseline files remain frozen after rollout.
  if (!local && old && (old.reset_method !== "application_allowlist" || old.cleanup_sql_digest !== cleanup?.cleanup_sql_digest || old.retired_inventory_digest !== cleanup?.retired_inventory_digest)) throw new Error("Operation cleanup method or allowlist differs from its durable intent");
  Object.assign(state, {
    server_identity: serverIdentity
  });
  state.maintenance = true;
  state.source_sha = sha;
  state.migration_manifest_digest = manifest.migration_manifest_digest;
  if (run(resolve(root, "node_modules/.bin/supabase"), ["--version"]) !== "2.109.0") throw new Error("Rebuild requires the rehearsed Supabase CLI version");
  saveState(state);
  if (mode === "rebuild") {
    if (!localState && process.env.REBUILD_MAINTENANCE_VERIFIED !== "true") throw new Error("Record API/integration pause verification before reset");
    state.phase = "reset_started";
    saveState(state);
    if (local) run(resolve(root, "node_modules/.bin/supabase"), ["db", "reset", "--local", "--no-seed", "--yes"]);else sql(readFileSync(cleanupPath, "utf8"), false);
    state.phase = "migrations";
    saveState(state);
    if (!local) applyMissingMigrations(jsonQuery("select coalesce(jsonb_agg(version order by version),'[]') from supabase_migrations.schema_migrations;", false));
    if (rehearsal && process.argv.includes("--stop-after-migrations")) throw new Error("Intentional disposable rehearsal interruption after migrations");
  } else {
    if (state.phase === "intent" || state.phase === "reset_started") {
      const proof = JSON.parse(readFileSync(input("reset-recovery-evidence"), "utf8"));
      const allowed = new Set(manifest.files.flatMap(entry => [...readFileSync(resolve(root, "supabase/migrations", entry.name), "utf8").matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.([a-z_0-9]+)/gi)].map(match => match[1])));
      requireRecoveryEvidence(proof, state, manifest, inspectionDigest);
      if (inspection.public_tables.length || inspection.public_functions.some((name: string) => !allowed.has(name))) throw new Error("Interrupted reset recovery contains unexpected public objects");
      // A reviewed empty/partial new baseline may only advance by missing migrations. Never reset again.
      state.phase = "migrations";
      saveState(state);
    }
    applyMissingMigrations(history);
  }
  const checked = checkContract(local);
  if (checked.context.ready && checked.context.environment !== (localState ? "LOCAL" : target === "test" ? "PREVIEW" : "PRODUCTION")) throw new Error("Initialized database environment does not match target");
  state.phase = "catalog_verified";
  state.history = checked.history;
  saveState(state);
  const admin = input("admin-user");
  if (!/^[0-9a-f-]{36}$/i.test(admin)) throw new Error("Invalid existing Auth admin UUID");
  const name = localState ? "LOCAL" : target === "test" ? "PREVIEW" : "PRODUCTION";
  sql(`select admin.initialize('${name}','${admin}'::uuid);`, local);
  const initialized = jsonQuery("select public.app_context();", local);
  sql("select ai.register_jobs();", local);
  state.instance = initialized.database_instance_id;
  state.phase = "DB-ready";
  saveState(state);
  const acceptance = process.argv.find(value => value.startsWith("--acceptance-evidence="));
  if (acceptance) {
    const proof = JSON.parse(readFileSync(acceptance.slice("--acceptance-evidence=".length), "utf8"));
    if (proof.source_sha !== sha || proof.migration_manifest_digest !== manifest.migration_manifest_digest || proof.database_instance_id !== state.instance || proof.all_gates_passed !== true || proof.applications_verified !== true) throw new Error("Acceptance evidence does not match this database/application release");
    state.phase = "accepted";
    state.maintenance = false;
    saveState(state);
  }
  console.log(JSON.stringify(state));
}
