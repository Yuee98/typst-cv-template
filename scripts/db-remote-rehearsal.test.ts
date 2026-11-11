import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function sandbox(applicationHooks: unknown = []) {
  const directory = mkdtempSync(join(tmpdir(), "cv-g3-startup-"));
  for (const path of ["scripts", "bin", "supabase/migrations", "tmp/cv-remote-rehearsal/supabase"]) mkdirSync(join(directory, path), { recursive: true });
  for (const name of ["db-remote-rehearsal.ts", "db-common.ts", "db-safety.ts", "db-test-revalidation.ts"]) copyFileSync(new URL(name, import.meta.url), join(directory, "scripts", name));
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(join(directory, "supabase/migrations/20261108000000_fixture.sql"), "begin;select 1;commit;");
  writeFileSync(join(directory, "supabase/baseline.json"), JSON.stringify(["20261108000000_fixture.sql"]));
  writeFileSync(join(directory, "tmp/cv-remote-rehearsal/supabase/config.toml"), 'project_id = "cv-remote-rehearsal"');
  writeFileSync(join(directory, "state.json"), JSON.stringify({ tcpChecks: 0, finalReady: false, applicationHooks }));
  writeFileSync(join(directory, "bin/git"), `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='rev-parse') console.log('a'.repeat(40));
else if(args[0]==='ls-tree') console.log('supabase/migrations/20261108000000_fixture.sql');
else process.exit(1);
`, { mode: 0o755 });
  // Deterministic process-boundary fixture: the temporary server always accepts
  // Unix sockets, while the final TCP listener starts on the second readiness poll.
  writeFileSync(join(directory, "bin/docker"), `#!/usr/bin/env node
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const directory=process.env.CV_G3_PROBE_DIRECTORY,args=process.argv.slice(2);
appendFileSync(join(directory,'calls.jsonl'),JSON.stringify(args)+'\\n');
if(args[0]==='ps') process.exit(0);
if(args[0]==='run') {console.log('fresh-fixture-id');process.exit(0);}
if(args[0]==='inspect') {console.log(JSON.stringify([{Name:'/'+args[1],Image:'sha256:fixture',NetworkSettings:{Ports:{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:args[1]==='supabase_db_typst-cv-template'?'54322':'54622'}]}}}]));process.exit(0);}
if(args.includes('pg_isready')) {
 const state=JSON.parse(readFileSync(join(directory,'state.json'),'utf8'));
 if(args[args.indexOf('-h')+1]==='127.0.0.1') {
  state.tcpChecks++;state.finalReady=state.tcpChecks>=2;writeFileSync(join(directory,'state.json'),JSON.stringify(state));process.exit(state.finalReady?0:1);
 }
 process.exit(0);
}
if(args.includes('pg_dump')) {console.log('-- synthetic DDL/metadata');process.exit(0);}
if(args.includes('psql')) {
 const sql=readFileSync(0,'utf8');
 appendFileSync(join(directory,'sql.jsonl'),JSON.stringify(sql)+'\\n');
 if(sql.includes('APPLICATION_PLATFORM_HOOKS')) {console.log(JSON.stringify(JSON.parse(readFileSync(join(directory,'state.json'),'utf8')).applicationHooks));process.exit(0);}
 if(sql.includes('to_regclass'))console.log('f');
 else if(sql.includes('select count(*) from auth.users'))console.log('0');
 else if(sql.includes('jsonb_build_object'))console.log(JSON.stringify({auth_tables:23,storage_tables:10,auth_migrations:77,storage_migrations:61}));
 process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
  return {
    directory,
    run(mode: string) {
      return spawnSync(process.execPath, [join(directory, "scripts/db-remote-rehearsal.ts"), `--mode=${mode}`], {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${join(directory, "bin")}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
          CV_G3_PROBE_DIRECTORY: directory,
          REHEARSAL_DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54622/postgres"
        },
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024
      });
    },
    calls(): string[][] {
      return readFileSync(join(directory, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    },
    dispose() { rmSync(directory, { recursive: true, force: true }); }
  };
}

test("raw G3 startup waits for the final TCP server rather than the temporary Unix socket", () => {
  const fixture = sandbox();
  try {
    const child = fixture.run("start-db");
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    const state = JSON.parse(readFileSync(join(fixture.directory, "state.json"), "utf8"));
    assert.equal(state.tcpChecks, 2);
    assert.equal(state.finalReady, true);
    const readiness = fixture.calls().filter(args => args.includes("pg_isready"));
    assert.equal(readiness.length, 2);
    assert(readiness.every(args => args[args.indexOf("-h") + 1] === "127.0.0.1"));
    const result = JSON.parse(readFileSync(join(fixture.directory, "tmp/g3-instance.json"), "utf8"));
    assert.equal(result.container_id, "fresh-fixture-id");
  } finally { fixture.dispose(); }
});

test("standalone platform copy refuses a temporary server before dumping or dropping any schema", () => {
  const fixture = sandbox();
  try {
    const child = fixture.run("platform");
    assert.equal(child.error, undefined);
    assert.notEqual(child.status, 0);
    const calls = fixture.calls();
    assert(calls.some(args => args.includes("pg_isready")));
    assert(!calls.some(args => args.includes("pg_dump") || args.includes("psql")));
  } finally { fixture.dispose(); }
});

test("platform copy keeps source DDL and ACL untouched when the exact application hook inventory is empty", () => {
  const fixture = sandbox();
  try {
    assert.equal(fixture.run("start-db").status, 0);
    const copied = fixture.run("platform");
    assert.equal(copied.status, 0, copied.stderr);
    const origin = JSON.parse(readFileSync(join(fixture.directory, "tmp/g3-platform-origin.json"), "utf8"));
    assert.deepEqual(origin.application_owned_platform_hooks, []);
    assert.equal(origin.metadata_only, true);
    const dumps = fixture.calls().filter(args => args.includes("pg_dump"));
    assert.equal(dumps.length, 2);
    assert(dumps.every(args => !args.includes("--no-acl") && !args.includes("--no-privileges")));
  } finally { fixture.dispose(); }
});
test("an application-owned Auth hook fails closed before any dump or destructive target SQL", () => {
  const fixture = sandbox([{ schema: "auth", table: "users", trigger: "app_delete", function_schema: "common" }]);
  try {
    assert.equal(fixture.run("start-db").status, 0);
    const copied = fixture.run("platform");
    assert.notEqual(copied.status, 0);
    assert.match(copied.stderr, /Application-owned platform hooks require explicit review/);
    assert(!fixture.calls().some(args => args.includes("pg_dump")));
    const statements = readFileSync(join(fixture.directory, "sql.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert(statements.every(sql => !/drop\s+schema/i.test(sql)));
  } finally { fixture.dispose(); }
});
