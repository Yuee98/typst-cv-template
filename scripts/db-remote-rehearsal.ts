import { spawnSync, spawn } from "node:child_process";
/** G3: dedicated local rehearsal of the application allowlist rebuild protocol. */
import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, renameSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { root, run, migrationManifest, input } from "./db-common.ts";
import { validateRehearsalIdentity } from "./db-safety.ts";
const mode = input("mode", "plan");
if (!["plan", "prepare", "start", "start-db", "platform", "tls", "legacy", "seed", "archive-unconnected", "archive-native-failure", "run", "recover", "incremental", "checkpoint-guards", "verify"].includes(mode)) throw new Error("Invalid rehearsal mode");
const workdir = resolve(root, "tmp/cv-remote-rehearsal");
const cli = resolve(root, "node_modules/.bin/supabase");
const stateFile = resolve(root, "tmp/db-rebuild-rehearsal.json");
const proofFile = resolve(root, "tmp/remote-rehearsal-proof.json");
const container = "supabase_db_cv-remote-rehearsal";
const user = "00000000-0000-4000-8000-000000000081";
const session = "00000000-0000-4000-8000-000000000082";
const factor = "00000000-0000-4000-8000-000000000083";
const object = "00000000-0000-4000-8000-000000000084";
const manifest = migrationManifest();
const sourceSha = run("git", ["rev-parse", "HEAD"]);
const historicalSha = input("historical-sha", "ccbeb1a4fc2baba9dbc2c15a4ba183a1be3558aa");
if (!/^[0-9a-f]{40}$/.test(historicalSha)) throw new Error("Historical fixture must be a full commit SHA");
const historical = run("git", ["ls-tree", "-r", "--name-only", historicalSha, "supabase/migrations"]).split("\n").filter(name => name.endsWith(".sql"));
function cliRun(args: string[]) {
  return run(cli, [...args, "--workdir", workdir]);
}
function targetSql(statement: string) {
  return run("docker", ["exec", "-i", container, "psql", "-XAt", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", "postgres"], statement);
}
function verifyTarget() {
  const inspected = JSON.parse(run("docker", ["inspect", container]))[0];
  const url = process.env.REHEARSAL_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54622/postgres";
  validateRehearsalIdentity(url, inspected);
  return url;
}
function hashes() {
  return JSON.parse(targetSql(`select jsonb_build_object(
'user',(select row_to_json(u) from auth.users u where id='${user}'),
'session',(select row_to_json(s) from auth.sessions s where id='${session}'),
'mfa',(select row_to_json(f) from auth.mfa_factors f where id='${factor}'),
'identity',(select row_to_json(i) from auth.identities i where id='00000000-0000-4000-8000-000000000085'),
'refresh_token',(select row_to_json(t) from auth.refresh_tokens t where token='cv-rehearsal-refresh-token-not-valid'),
'bucket',(select row_to_json(b) from storage.buckets b where id='cv-rehearsal-sentinel'),
'object',(select row_to_json(o) from storage.objects o where id='${object}'),
'unrelated_cron',(select row_to_json(j) from cron.job j where jobname='cv-rehearsal-platform-sentinel'),
'role',(select row_to_json(r) from(select rolname,rolcanlogin,rolsuper,rolinherit,rolbypassrls from pg_roles where rolname='cv_rehearsal_retained_role') r),
'role_membership',(select jsonb_agg(jsonb_build_object('role',r.rolname,'member',m.rolname,'admin',a.admin_option,'inherit',a.inherit_option,'set',a.set_option) order by r.rolname,m.rolname) from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member where r.rolname='cv_rehearsal_retained_role'),
'platform_versions',jsonb_build_object('auth',(select jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text) from auth.schema_migrations t),'storage',(select jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text) from storage.migrations t)),
'platform_acl',(select jsonb_agg(to_jsonb(x) order by x.identity) from(
select 'schema:'||n.nspname identity,pg_get_userbyid(n.nspowner) owner,(select jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),'grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,'privilege',a.privilege_type,'grantable',a.is_grantable) order by a.grantee,a.privilege_type,a.grantor) from aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a where a.grantee is distinct from(select oid from pg_roles where rolname='app_api_owner')) acl from pg_namespace n where n.nspname in ('auth','storage')
union all
select n.nspname||'.'||c.relname,pg_get_userbyid(c.relowner),(select jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),'grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,'privilege',a.privilege_type,'grantable',a.is_grantable) order by a.grantee,a.privilege_type,a.grantor) from aclexplode(coalesce(c.relacl,acldefault((case when c.relkind='S' then 'S' else 'r' end)::"char",c.relowner))) a where a.grantee is distinct from(select oid from pg_roles where rolname='app_api_owner')) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('auth','storage') and c.relkind in ('r','p','v','S')
union all
select n.nspname||'.'||c.relname||'.'||d.attname,pg_get_userbyid(c.relowner),(select jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),'grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,'privilege',a.privilege_type,'grantable',a.is_grantable) order by a.grantee,a.privilege_type,a.grantor) from aclexplode(d.attacl) a where a.grantee is distinct from(select oid from pg_roles where rolname='app_api_owner')) from pg_attribute d join pg_class c on c.oid=d.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('auth','storage') and d.attacl is not null
)x));`));
}
function fingerprint(value: Record<string, unknown>, allowMissing = false) {
  const entries = Object.entries(value);
  if (!allowMissing && entries.some(([, value]) => value === null)) throw new Error("Platform sentinel missing");
  return Object.fromEntries(entries.map(([key, value]) => [key, value === null ? null : createHash("sha256").update(JSON.stringify(value)).digest("hex")]));
}
function save(proof: Record<string, unknown>) {
  writeFileSync(proofFile, JSON.stringify(proof, null, 2));
}
function seedSentinels() {
  targetSql(`insert into auth.users(id,email,email_confirmed_at) values('${user}','remote-rehearsal@fixture.invalid',clock_timestamp()) on conflict do nothing;
 insert into auth.identities(id,provider_id,user_id,identity_data,provider,created_at,updated_at) values('00000000-0000-4000-8000-000000000085','${user}','${user}',jsonb_build_object('sub','${user}','email','remote-rehearsal@fixture.invalid'),'email',clock_timestamp(),clock_timestamp()) on conflict do nothing;
 insert into auth.sessions(id,user_id,created_at,updated_at,not_after) values('${session}','${user}',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 day') on conflict do nothing;
 insert into auth.refresh_tokens(token,user_id,session_id,revoked,created_at,updated_at) values('cv-rehearsal-refresh-token-not-valid','${user}','${session}',false,clock_timestamp(),clock_timestamp()) on conflict do nothing;
 insert into auth.mfa_factors(id,user_id,status,factor_type,secret,created_at,updated_at) values('${factor}','${user}','verified','totp','local-rehearsal-only',clock_timestamp(),clock_timestamp()) on conflict do nothing;
 insert into storage.buckets(id,name,public) values('cv-rehearsal-sentinel','cv-rehearsal-sentinel',false) on conflict do nothing;
 insert into storage.objects(id,bucket_id,name,metadata) values('${object}','cv-rehearsal-sentinel','fixture.json','{"fixture":true}') on conflict do nothing;
 do $$begin if not exists(select 1 from pg_roles where rolname='cv_rehearsal_retained_role') then create role cv_rehearsal_retained_role nologin noinherit nobypassrls;end if;if not exists(select 1 from pg_roles where rolname='cv_rehearsal_retained_member') then create role cv_rehearsal_retained_member nologin noinherit nobypassrls;end if;end$$;
 grant usage on schema auth to cv_rehearsal_retained_role;grant select(id) on auth.users to cv_rehearsal_retained_role;grant cv_rehearsal_retained_role to cv_rehearsal_retained_member with inherit false,set true;
 select cron.schedule('cv-rehearsal-platform-sentinel','* * * * *','select 1');update cron.job set active=false where jobname='cv-rehearsal-platform-sentinel';`);
  return fingerprint(hashes());
}
function runtimeArgs() {
  return [resolve(root, "scripts/db-rebuild.ts"), "--target=rehearsal", "--rehearsal", `--source-sha=${sourceSha}`, `--admin-user=${user}`];
}
function expectRebuildRefusal(databaseUrl: string) {
  const result = spawnSync(process.execPath, [...runtimeArgs(), "--mode=rebuild"], {
    cwd: root,
    env: {
      ...process.env,
      REBUILD_DATABASE_URL: databaseUrl
    },
    encoding: "utf8"
  });
  if (result.error || result.status === 0 || !result.stderr.includes("Existing current application objects or database instance require inspection/resume")) throw new Error("Rebuild did not reach the expected existing-application refusal");
}
async function runInterruptedRebuild(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [...runtimeArgs(), "--mode=rebuild", "--stop-after-migrations"], {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.resume();
  let exited = false;
  const ended = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => {
      exited = true;
      resolve();
    });
  });
  const expected = JSON.stringify(manifest.files.map(file => file.name.split('_')[0]));
  try {
    for (let i = 0; i < 240 && !exited; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (exited) break;
      let complete = false;
      try {
        complete = JSON.stringify(JSON.parse(targetSql("select jsonb_agg(version order by version) from supabase_migrations.schema_migrations;"))) === expected;
      } catch {/* A disconnected reset may briefly replace migration history. */}
      if (complete) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (!exited && child.pid) process.kill(-child.pid, "SIGTERM");
        break;
      }
    }
    if (!exited && child.pid) process.kill(-child.pid, "SIGTERM");
    await ended;
  } finally {
    if (!exited && child.pid) try {
      process.kill(-child.pid, "SIGTERM");
    } catch {/* Already exited. */}
  }
}
function finishRehearsal(databaseUrl: string, proof: Record<string, unknown>) {
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  if (!["reset_started", "migrations", "catalog_verified", "DB-ready"].includes(state.phase)) throw new Error("Unexpected durable phase after interrupted reset");
  const history = JSON.parse(targetSql("select jsonb_agg(version order by version) from supabase_migrations.schema_migrations;"));
  if (JSON.stringify(history) !== JSON.stringify(manifest.files.map(file => file.name.split('_')[0]))) throw new Error("Application rebuild did not finish the expected SQL manifest");
  const after = fingerprint(hashes(), true);
  proof.platform_after = after;
  proof.platform_preservation_passed = JSON.stringify(proof.platform_before) === JSON.stringify(after);
  save(proof);
  if (!proof.platform_preservation_passed) throw new Error("Application allowlist rebuild changed platform sentinels");
  const env = {
    ...process.env,
    REBUILD_DATABASE_URL: databaseUrl
  };
  const args = runtimeArgs();
  const recovery: string[] = [];
  if (state.phase === "reset_started") {
    const plan = JSON.parse(run(process.execPath, [...args, "--mode=plan"], undefined, env));
    const path = resolve(root, "tmp/g3-reset-recovery-evidence.json");
    writeFileSync(path, JSON.stringify({
      method: state.reset_method,
      cleanup_sql_digest: state.cleanup_sql_digest,
      retired_inventory_digest: state.retired_inventory_digest,
      operation_id: state.operation_id,
      project: state.project,
      source_sha: sourceSha,
      baseline_digest: manifest.baseline_digest,
      migration_manifest_digest: manifest.migration_manifest_digest,
      reset_catalog_digest: plan.reset_catalog_digest,
      reset_completed: true,
      platform_preservation_passed: true
    }, null, 2));
    recovery.push(`--reset-recovery-evidence=${path}`);
    proof.checkpoint_loss_recovery_passed = false;
    save(proof);
  }
  run(process.execPath, [...args, "--mode=resume", ...recovery], undefined, env);
  const initialized = JSON.parse(readFileSync(stateFile, "utf8"));
  if (initialized.phase !== "DB-ready" || !initialized.instance) throw new Error("Resume did not atomically initialize the environment");
  targetSql("create schema if not exists rehearsal_probe;create table if not exists rehearsal_probe.resume_sentinel(id integer primary key check(id=1));insert into rehearsal_probe.resume_sentinel values(1) on conflict do nothing;");
  run(process.execPath, [...args, "--mode=resume"], undefined, env);
  const repeated = JSON.parse(readFileSync(stateFile, "utf8"));
  if (repeated.instance !== initialized.instance || targetSql("select count(*) from rehearsal_probe.resume_sentinel;") !== "1") throw new Error("Resume repeated destruction or changed initialized instance");
  run(process.execPath, [...args, "--mode=verify"], undefined, env);
  proof.remote_mode_resume_passed = true;
  proof.checkpoint_loss_recovery_passed = recovery.length > 0 || proof.checkpoint_loss_recovery_passed === true;
  proof.database_instance_id = initialized.instance;
  proof.new_history = repeated.history;
  delete proof.failure;
  save(proof);
  console.log(JSON.stringify({
    proof_file: proofFile,
    platform_preservation_passed: true,
    remote_mode_resume_passed: true,
    checkpoint_loss_recovery_passed: proof.checkpoint_loss_recovery_passed
  }));
}
if (mode === "plan") {
  console.log(JSON.stringify({
    target: "loopback-only",
    container,
    workdir,
    source_sha: sourceSha,
    historical_source_sha: historicalSha,
    historical_migrations: historical.length,
    ...manifest,
    execution: false
  }));
} else if (mode === "prepare") {
  if (existsSync(workdir) || existsSync(stateFile)) throw new Error("Existing rehearsal is retained for inspection; choose verify/resume instead of preparing over it");
  if (historical.length !== 60) throw new Error("Historical HEAD is no longer the retired 60-file chain; provide a reviewed historical fixture before rerunning");
  mkdirSync(resolve(workdir, "supabase/migrations"), {
    recursive: true
  });
  let config = readFileSync(resolve(root, "supabase/config.toml"), "utf8").replace(/^project_id\s*=.*$/m, 'project_id = "cv-remote-rehearsal"');
  for (const [from, to] of [[54320, 54620], [54321, 54621], [54322, 54622], [54323, 54623], [54327, 54627], [8083, 8183]]) config = config.replaceAll(String(from), String(to));
  config = config.replace(/(\[analytics\]\s*\n(?:#[^\n]*\n)*)enabled\s*=\s*true/, "$1enabled = false");
  config = config.replace(/(\[edge_runtime\]\s*\n(?:#[^\n]*\n)*)enabled\s*=\s*true/, "$1enabled = false");
  config = config.replace(/(\[db.seed\]\s*\n(?:#[^\n]*\n)*)enabled\s*=\s*true/, "$1enabled = false");
  writeFileSync(resolve(workdir, "supabase/config.toml"), config);
  for (const name of historical) writeFileSync(resolve(workdir, name), run("git", ["show", `${historicalSha}:${name}`]) + "\n");
  console.log(`Prepared isolated historical CLI project: ${workdir}`);
} else if (mode === "start-db") {
  if (!existsSync(resolve(workdir, "supabase/config.toml"))) throw new Error("Prepare the isolated historical checkout first");
  const existing = run("docker", ["ps", "-a", "--filter", `name=^/${container}$`, "--format", "{{.ID}}"]);
  if (existing) throw new Error("Existing rehearsal container retained; do not overwrite it");
  const source = JSON.parse(run("docker", ["inspect", "supabase_db_typst-cv-template"]))[0];
  if (source.Name !== "/supabase_db_typst-cv-template") throw new Error("Unexpected platform source");
  const id = run("docker", ["run", "--pull=never", "--detach", "--name", container, "--publish", "127.0.0.1:54622:5432", "--env", "POSTGRES_PASSWORD=postgres", "--env", "POSTGRES_DB=postgres", "--label", "com.typst-cv.rehearsal=application_allowlist", source.Image]);
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      // The image's temporary init server accepts Unix sockets before platform
      // migrations finish. Only the final server listens on TCP loopback.
      run("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres", "-d", "postgres"]);
      ready = true;
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  if (!ready) throw new Error("Dedicated rehearsal database did not become ready");
  writeFileSync(resolve(root, "tmp/g3-instance.json"), JSON.stringify({
    container,
    container_id: id,
    image_id: source.Image,
    method: "application_allowlist"
  }, null, 2));
  console.log(JSON.stringify({
    container,
    container_id: id,
    ready: true
  }));
} else if (mode === "start") {
  if (!existsSync(resolve(workdir, "supabase/config.toml"))) throw new Error("Prepare the isolated project first");
  console.log("Starting dedicated historical local stack; no hosted project is linked.");
  const progress = resolve(root, "tmp/g3-cli-start.log");
  const fd = openSync(progress, "a");
  const started = spawnSync(cli, ["start", "--exclude", "studio,realtime,logflare,vector,postgres-meta,imgproxy,supavisor,edge-runtime", "--workdir", workdir], {
    cwd: root,
    env: {
      ...process.env,
      SUPABASE_TELEMETRY_DISABLED: "1"
    },
    stdio: ["ignore", "ignore", fd]
  });
  closeSync(fd);
  if (started.status !== 0) throw new Error(`Dedicated rehearsal start failed; inspect ${progress}`);
  console.log("Dedicated rehearsal stack started.");
} else if (mode === "platform") {
  verifyTarget();
  // Also fail closed when this phase is invoked independently during cold init.
  run("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres", "-d", "postgres"]);
  if (targetSql("select to_regclass('supabase_migrations.schema_migrations') is not null;") === "t") throw new Error("Cannot replace platform schemas after application migration history exists");
  if (targetSql("select count(*) from auth.users;") !== "0") throw new Error("Rehearsal platform has existing users; retain it for inspection");
  const source = "supabase_db_typst-cv-template";
  const inspected = JSON.parse(run("docker", ["inspect", source]))[0];
  if (inspected.Name !== `/${source}` || !(inspected.NetworkSettings.Ports["5432/tcp"] ?? []).some((binding: {
    HostPort: string;
  }) => binding.HostPort === "54322")) throw new Error("Unexpected local platform source");
  // The platform clone must not import application hooks whose functions live
  // outside Auth/Storage. Current anonymization uses RI FK actions, not hooks.
  // Keep the original platform DDL/ACL intact; a future hook needs explicit review.
  const applicationHooks: unknown = JSON.parse(run("docker", ["exec", "-i", source, "psql", "-XAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], `/* APPLICATION_PLATFORM_HOOKS */
    select coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'trigger',t.tgname,'function_schema',fn.nspname,'function_name',p.proname,'definition',pg_get_triggerdef(t.oid)) order by n.nspname,c.relname,t.tgname),'[]'::jsonb)
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    join pg_proc p on p.oid=t.tgfoid join pg_namespace fn on fn.oid=p.pronamespace
    where not t.tgisinternal and n.nspname in('auth','storage') and fn.nspname in('common','cv','ai','legal','admin','audit');`));
  if (!Array.isArray(applicationHooks) || applicationHooks.length !== 0) throw new Error("Application-owned platform hooks require explicit review before platform copy");
  const ddl = run("docker", ["exec", source, "pg_dump", "-U", "postgres", "-d", "postgres", "--schema-only", "--schema=auth", "--schema=storage"]);
  const metadata = run("docker", ["exec", source, "pg_dump", "-U", "postgres", "-d", "postgres", "--data-only", "--table=auth.schema_migrations", "--table=storage.migrations"]);
  targetSql("drop schema auth,storage cascade;");
  targetSql(ddl);
  targetSql(metadata);
  const origin = {
    source_container: source,
    target_container: container,
    metadata_only: true,
    application_owned_platform_hooks: applicationHooks,
    ddl_sha256: createHash("sha256").update(ddl).digest("hex"),
    migration_metadata_sha256: createHash("sha256").update(metadata).digest("hex"),
    platform: JSON.parse(targetSql("select jsonb_build_object('postgres_version',version(),'auth_tables',(select count(*) from information_schema.tables where table_schema='auth'),'storage_tables',(select count(*) from information_schema.tables where table_schema='storage'),'auth_migrations',(select count(*) from auth.schema_migrations),'storage_migrations',(select count(*) from storage.migrations));"))
  };
  writeFileSync(resolve(root, "tmp/g3-platform-origin.json"), JSON.stringify(origin, null, 2));
  console.log(JSON.stringify(origin));
} else if (mode === "tls") {
  verifyTarget();
  const directory = mkdtempSync(resolve(root, "tmp/g3-tls-"));
  try {
    const key = resolve(directory, "server.key"),
      cert = resolve(directory, "server.crt");
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", key, "-out", cert]);
    chmodSync(key, 0o600);
    chmodSync(cert, 0o600);
    run("docker", ["cp", key, `${container}:/tmp/cv-g3-server.key`]);
    run("docker", ["cp", cert, `${container}:/tmp/cv-g3-server.crt`]);
    run("docker", ["exec", "-u", "root", container, "chown", "postgres:postgres", "/tmp/cv-g3-server.key", "/tmp/cv-g3-server.crt"]);
    run("docker", ["exec", "-u", "root", container, "chmod", "600", "/tmp/cv-g3-server.key", "/tmp/cv-g3-server.crt"]);
    targetSql("alter system set ssl='on';");
    targetSql("alter system set ssl_cert_file='/tmp/cv-g3-server.crt';");
    targetSql("alter system set ssl_key_file='/tmp/cv-g3-server.key';");
    targetSql("select pg_reload_conf();");
    console.log(JSON.stringify({
      container,
      tls_enabled: true,
      certificate: run("openssl", ["x509", "-in", cert, "-noout", "-fingerprint", "-sha256"])
    }));
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true
    });
  }
} else if (mode === "legacy") {
  const databaseUrl = verifyTarget();
  if (targetSql("select to_regclass('supabase_migrations.schema_migrations') is not null;") === "t") throw new Error("Historical migration history already exists; inspect before retry");
  console.log("Applying retired migration chain to dedicated local rehearsal database.");
  cliRun(["migration", "up", "--db-url", databaseUrl]);
  console.log("Retired migration chain applied.");
} else if (mode === "archive-unconnected") {
  verifyTarget();
  if (!process.argv.includes("--verified-preconnection-failure")) throw new Error("Explicit reviewed preconnection failure verification is required");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const proof = JSON.parse(readFileSync(proofFile, "utf8"));
  const history = JSON.parse(targetSql("select jsonb_agg(version order by version) from supabase_migrations.schema_migrations;"));
  if (state.target !== "rehearsal" || state.phase !== "reset_started" || JSON.stringify(history) !== JSON.stringify(historical.map(name => name.split('/').at(-1)!.split('_')[0])) || JSON.stringify(fingerprint(hashes())) !== JSON.stringify(proof.platform_before) || targetSql("select count(*) from information_schema.tables where table_schema in ('cv','ai','legal','admin','audit');") !== "0") throw new Error("Cannot prove that the initial reset never altered the rehearsal database");
  const archive = resolve(root, `tmp/db-rebuild-rehearsal-unconnected-${state.operation_id}.json`);
  renameSync(stateFile, archive);
  proof.preconnection_failure_archive = archive;
  proof.preconnection_failure_reason = "LOCAL_DATABASE_REFUSED_TLS_BEFORE_CONNECTION";
  save(proof);
  console.log(JSON.stringify({
    archived_unconnected_operation: archive,
    reset_executed: false
  }));
} else if (mode === "archive-native-failure") {
  verifyTarget();
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const proof = JSON.parse(readFileSync(proofFile, "utf8"));
  const after = fingerprint(hashes(), true);
  if (state.target !== "rehearsal" || state.phase !== "reset_started" || after.user !== null || after.session !== null || after.mfa !== null || after.bucket !== proof.platform_before.bucket || after.object !== proof.platform_before.object) throw new Error("Native failure evidence differs from the inspected Auth-loss case");
  const inspected = JSON.parse(run("docker", ["inspect", container]))[0];
  proof.method = "native_cli_reset";
  proof.native_reset_sql_completed = true;
  proof.platform_after = after;
  proof.platform_preservation_passed = false;
  proof.remote_mode_resume_passed = false;
  proof.failure = "NATIVE_REMOTE_RESET_TRUNCATES_AUTH_USERS_SESSIONS_MFA";
  proof.container_id = inspected.Id;
  proof.container_mounts = inspected.Mounts.map((mount: {
    Type: string;
    Name?: string;
    Destination: string;
  }) => ({
    type: mount.Type,
    name: mount.Name,
    destination: mount.Destination
  }));
  save(proof);
  const directory = resolve(root, `tmp/database-rehearsals/native-reset-failure-${state.operation_id}`);
  mkdirSync(directory, {
    recursive: true
  });
  run("docker", ["stop", container]);
  const retained = `supabase_db_cv-native-failed-${state.operation_id.slice(0, 8)}`;
  run("docker", ["rename", container, retained]);
  renameSync(workdir, resolve(directory, "workdir"));
  renameSync(stateFile, resolve(directory, "operation-state.json"));
  renameSync(proofFile, resolve(directory, "proof.json"));
  for (const [name, dest] of [["g3-platform-origin.json", "platform-origin.json"], ["g3-reset-recovery-evidence.json", "recovery-evidence.json"], ["g3-cli-start.log", "cli-start.log"]]) {
    const path = resolve(root, "tmp", name);
    if (existsSync(path)) renameSync(path, resolve(directory, dest));
  }
  console.log(JSON.stringify({
    archived_native_failure: directory,
    retained_container: retained,
    container_id: inspected.Id,
    auth_preservation: false
  }));
} else if (mode === "seed") {
  verifyTarget();
  if (existsSync(stateFile)) throw new Error("Cannot seed over an existing rebuild operation");
  console.log(JSON.stringify({
    platform_before: seedSentinels()
  }));
} else if (mode === "run") {
  const databaseUrl = verifyTarget();
  if (existsSync(stateFile)) throw new Error("An operation already exists; retain it and inspect/resume without reset");
  const version = run(cli, ["--version"]);
  if (version !== "2.109.0") throw new Error("Rehearsal requires pinned CLI 2.109.0");
  const platform = JSON.parse(targetSql("select jsonb_build_object('auth_columns',(select count(*) from information_schema.columns where table_schema='auth' and table_name='sessions'),'auth_migrations',(select count(*) from auth.schema_migrations),'storage_migrations',(select count(*) from storage.migrations),'history',(select count(*) from supabase_migrations.schema_migrations));"));
  if (platform.auth_columns < 10 || platform.auth_migrations < 1 || platform.storage_migrations < 1 || platform.history !== 60) throw new Error("A genuine initialized Supabase Auth/Storage platform and historical migration chain are required; stubs cannot provide preservation evidence");
  const before = seedSentinels();
  const proof: Record<string, unknown> = {
    method: "application_allowlist",
    cleanup_sql_digest: createHash("sha256").update(readFileSync(resolve(root, "supabase/retired-application-reset.sql"))).digest("hex"),
    retired_inventory_digest: createHash("sha256").update(readFileSync(resolve(root, "scripts/database-retired-objects.json"))).digest("hex"),
    instance: existsSync(resolve(root, "tmp/g3-instance.json")) ? JSON.parse(readFileSync(resolve(root, "tmp/g3-instance.json"), "utf8")) : null,
    cli_version: version,
    source_sha: sourceSha,
    ...manifest,
    historical_source_sha: historicalSha,
    old_chain_passed: true,
    platform_preservation_passed: false,
    remote_mode_resume_passed: false,
    container,
    platform_before: before,
    platform_origin: existsSync(resolve(root, "tmp/g3-platform-origin.json")) ? JSON.parse(readFileSync(resolve(root, "tmp/g3-platform-origin.json"), "utf8")) : null
  };
  save(proof);
  try {
    await runInterruptedRebuild({
      ...process.env,
      REBUILD_DATABASE_URL: databaseUrl
    });
    finishRehearsal(databaseUrl, proof);
  } catch (error) {
    proof.failure = error instanceof Error ? error.message : "Rehearsal failed";
    save(proof);
    throw new Error(`Disposable rehearsal failed; inspect ${proofFile}. No hosted database was contacted.`);
  }
} else if (mode === "recover") {
  const databaseUrl = verifyTarget();
  const proof = JSON.parse(readFileSync(proofFile, "utf8"));
  if (proof.baseline_digest !== manifest.baseline_digest || proof.migration_manifest_digest !== manifest.migration_manifest_digest) throw new Error("Cannot recover against a different manifest");
  finishRehearsal(databaseUrl, proof);
} else if (mode === "incremental") {
  const databaseUrl = verifyTarget();
  const proof = JSON.parse(readFileSync(proofFile, "utf8"));
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  if (proof.method !== "application_allowlist" || !proof.platform_preservation_passed || !proof.remote_mode_resume_passed || proof.baseline_digest !== manifest.baseline_digest || proof.files.length >= manifest.files.length || proof.files.some((entry: {
    name: string;
    digest: string;
  }, index: number) => JSON.stringify(entry) !== JSON.stringify(manifest.files[index]))) throw new Error("Incremental rehearsal requires an unchanged deployed baseline and append-only migrations");
  const instance = state.instance;
  const before = fingerprint(hashes());
  run(process.execPath, [...runtimeArgs(), "--mode=resume"], undefined, {
    ...process.env,
    REBUILD_DATABASE_URL: databaseUrl
  });
  const after = JSON.parse(readFileSync(stateFile, "utf8"));
  if (after.instance !== instance || targetSql("select count(*) from rehearsal_probe.resume_sentinel;") !== "1" || JSON.stringify(before) !== JSON.stringify(fingerprint(hashes()))) throw new Error("Incremental resume changed instance, sentinel or platform data");
  proof.initial_migration_manifest_digest ??= proof.migration_manifest_digest;
  proof.initial_history ??= proof.new_history;
  Object.assign(proof, manifest, {
    new_history: after.history,
    incremental_resume_passed: true
  });
  save(proof);
  console.log(JSON.stringify({
    incremental_resume_passed: true,
    database_instance_id: instance,
    migrations: after.history.length
  }));
} else if (mode === "checkpoint-guards") {
  const databaseUrl = verifyTarget();
  const proof = JSON.parse(readFileSync(proofFile, "utf8"));
  const expectedHistory = manifest.files.map(entry => entry.name.split('_')[0]);
  if (proof.method !== "application_allowlist" || proof.source_sha !== sourceSha || proof.baseline_digest !== manifest.baseline_digest || proof.migration_manifest_digest !== manifest.migration_manifest_digest || !proof.platform_preservation_passed || !proof.remote_mode_resume_passed || JSON.stringify(proof.new_history) !== JSON.stringify(expectedHistory)) throw new Error("Checkpoint tests require the complete verified migration chain");
  if (JSON.stringify(JSON.parse(targetSql("select jsonb_agg(version order by version) from supabase_migrations.schema_migrations;"))) !== JSON.stringify(expectedHistory)) throw new Error("Checkpoint test target history differs from the verified chain");
  const original = readFileSync(stateFile, "utf8"),
    state = JSON.parse(original),
    before = fingerprint(hashes());
  const missing = resolve(root, "tmp/g3-checkpoint-backup.json");
  if (state.phase !== "DB-ready" || state.instance !== proof.database_instance_id || JSON.stringify(before) !== JSON.stringify(proof.platform_before)) throw new Error("Checkpoint tests require the initialized instance and preserved platform");
  renameSync(stateFile, missing);
  try {
    expectRebuildRefusal(databaseUrl);
  } finally {
    if (existsSync(stateFile)) throw new Error("Missing-checkpoint rebuild created unexpected intent");
    renameSync(missing, stateFile);
  }
  // Independent guard: neither a missing checkpoint nor repaired-away history may authorize another clear.
  const historyRows = targetSql("select coalesce(jsonb_agg(to_jsonb(t) order by version),'[]') from supabase_migrations.schema_migrations t;");
  renameSync(stateFile, missing);
  try {
    targetSql("delete from supabase_migrations.schema_migrations;");
    expectRebuildRefusal(databaseUrl);
  } finally {
    targetSql(`insert into supabase_migrations.schema_migrations select * from jsonb_populate_recordset(null::supabase_migrations.schema_migrations,'${historyRows.replaceAll("'", "''")}'::jsonb);`);
    if (existsSync(stateFile)) throw new Error("Repaired-history rebuild unexpectedly created intent");
    renameSync(missing, stateFile);
  }
  const fault = {
    ...state,
    phase: "reset_started",
    maintenance: true
  };
  writeFileSync(stateFile, JSON.stringify(fault, null, 2));
  const env = {
    ...process.env,
    REBUILD_DATABASE_URL: databaseUrl
  };
  try {
    const plan = JSON.parse(run(process.execPath, [...runtimeArgs(), "--mode=plan"], undefined, env));
    const evidence = resolve(root, "tmp/g3-constructed-checkpoint-evidence.json");
    writeFileSync(evidence, JSON.stringify({
      method: state.reset_method,
      cleanup_sql_digest: state.cleanup_sql_digest,
      retired_inventory_digest: state.retired_inventory_digest,
      operation_id: state.operation_id,
      project: state.project,
      source_sha: sourceSha,
      baseline_digest: manifest.baseline_digest,
      migration_manifest_digest: manifest.migration_manifest_digest,
      reset_catalog_digest: plan.reset_catalog_digest,
      reset_completed: true,
      platform_preservation_passed: true
    }, null, 2));
    run(process.execPath, [...runtimeArgs(), "--mode=resume", `--reset-recovery-evidence=${evidence}`], undefined, env);
  } catch (error) {
    writeFileSync(stateFile, original);
    throw error;
  }
  const after = JSON.parse(readFileSync(stateFile, "utf8"));
  if (after.instance !== state.instance || targetSql("select count(*) from rehearsal_probe.resume_sentinel;") !== "1" || JSON.stringify(before) !== JSON.stringify(fingerprint(hashes()))) throw new Error("Checkpoint guard modified data or instance");
  proof.missing_checkpoint_rebuild_refused = true;
  proof.missing_history_and_checkpoint_rebuild_refused = true;
  proof.constructed_checkpoint_recovery_passed = true;
  proof.checkpoint_fault_method = "TEST_CONSTRUCTED_STATE_ONLY_NO_REPEAT_RESET";
  save(proof);
  console.log(JSON.stringify({
    missing_checkpoint_rebuild_refused: true,
    constructed_checkpoint_recovery_passed: true,
    missing_history_and_checkpoint_rebuild_refused: true,
    database_instance_id: after.instance
  }));
} else {
  verifyTarget();
  const proof = JSON.parse(readFileSync(proofFile, "utf8"));
  if (proof.baseline_digest !== manifest.baseline_digest || proof.migration_manifest_digest !== manifest.migration_manifest_digest || proof.platform_preservation_passed !== true || proof.remote_mode_resume_passed !== true) throw new Error("Rehearsal proof is absent, incomplete or stale");
  console.log(JSON.stringify(proof));
}
