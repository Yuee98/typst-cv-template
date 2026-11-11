/** Opt-in local Postgres regression. No hosted endpoint or application database writes. */
import test from "node:test";
import assert from "node:assert/strict";
import childProcess, { type SpawnSyncOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { jsonQuery, jsonQueryReadOnly } from "./db-common.ts";

test("read-only queries survive discarded startup options and reject SELECT write effects", { skip: process.env.CV_READONLY_REGRESSION !== "1", timeout: 45_000 }, t => {
  const container = process.env.CV_READONLY_CONTAINER ?? "cv-rebuild-sql-test";
  assert(["cv-rebuild-sql-test", "supabase_db_typst-cv-template"].includes(container), "Only the two known local fixture containers are allowed");
  assert(!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT, "Use the verified local Docker context without environment routing overrides");
  const originalSpawn = childProcess.spawnSync;
  const docker = (args: string[], input?: string) => {
    const result = originalSpawn("docker", args, { input, encoding: "utf8", timeout: 15_000 });
    if (result.error || result.status !== 0) throw new Error("Disposable local Docker/SQL fixture command failed; captured output withheld");
    return result.stdout.trim();
  };
  const context = JSON.parse(docker(["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"]));
  assert(typeof context === "string" && context.startsWith("unix://"), "Only a local Unix Docker socket is allowed");
  assert.equal(JSON.parse(docker(["inspect", "--format", "{{json .State.Running}}", container])), true);
  const database = `cv_readonly_${randomBytes(8).toString("hex")}`;
  const psql = (statement: string, target = "postgres", user = "supabase_admin") => docker(["exec", "-i", container, "psql", "-XAt", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", target], statement);
  let created = false;
  const executed: { state: string | null; statement: string }[] = [];
  try {
    assert.equal(psql(`select count(*) from pg_database where datname='${database}';`), "0");
    psql(`create database ${database} owner postgres;`); created = true;
    psql(`alter database ${database} set default_transaction_read_only=off;alter database ${database} set statement_timeout='2min';alter database ${database} set lock_timeout='0';`);
    psql("create table public.probe(value integer not null);insert into public.probe values(0);create function public.probe_write() returns integer language plpgsql as $$begin update public.probe set value=value+1;return 1;end$$;", database, "postgres");
    // The pooler behavior is modeled only at the process boundary: discard
    // startup options, route to this new database, then run the real helper SQL.
    const replacement = ((command: string, args: readonly string[], options: SpawnSyncOptions) => {
      assert.equal(command, "docker");
      assert(Array.isArray(args) && args.includes("supabase_db_typst-cv-template"));
      const routed = args.filter((arg, index) => !(arg === "-e" && String(args[index + 1]).startsWith("PGOPTIONS=")) && !String(arg).startsWith("PGOPTIONS="))
        .map((arg, index, filtered) => arg === "supabase_db_typst-cv-template" ? container : index > 0 && filtered[index - 1] === "-d" ? database : arg);
      routed.push("-v", "VERBOSITY=sqlstate");
      const result = originalSpawn(command, routed, { ...options, timeout: 15_000 });
      executed.push({ state: String(result.stderr ?? "").match(/\b25006\b/)?.[0] ?? null, statement: String(options?.input ?? "") });
      return result;
    }) as typeof childProcess.spawnSync;
    childProcess.spawnSync = replacement; syncBuiltinESMExports();
    const observed = jsonQueryReadOnly("select jsonb_build_object('transaction_read_only',current_setting('transaction_read_only'),'statement_timeout',current_setting('statement_timeout'),'lock_timeout',current_setting('lock_timeout'));", true);
    let rejected = false;
    try { jsonQueryReadOnly("select to_jsonb(public.probe_write());", true); } catch { rejected = true; }
    const after = Number(psql("select value from public.probe;", database, "postgres"));
    t.diagnostic(JSON.stringify({ discarded_pgoptions: true, observed, write_rejected: rejected, sqlstate: executed.at(-1)?.state, synthetic_value_after_readonly: after }));
    assert.deepEqual(observed, { transaction_read_only: "on", statement_timeout: "20s", lock_timeout: "3s" });
    assert.equal(rejected, true);
    assert.equal(executed.at(-1)?.state, "25006");
    assert.equal(after, 0);
    assert.equal(jsonQuery("select to_jsonb(public.probe_write());", true), 1, "Default non-readonly behavior must remain unchanged");
    assert.equal(psql("select value from public.probe;", database, "postgres"), "1");
  } finally {
    childProcess.spawnSync = originalSpawn; syncBuiltinESMExports();
    if (created) psql(`drop database ${database};`);
  }
});
