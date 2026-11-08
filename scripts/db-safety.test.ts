import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { hostedPostgresEnvironment, requireRehearsalEvidence, requireFreshApplicationState, requireRecoveryEvidence, validateDatabaseServer, requireAcceptedTest, migrationWithHistory, validateRehearsalIdentity, checkPromotion, cleanPostgresEnvironment, parseRebuildState, requireMaintenanceAuthorization, validateProjectIdentity, requireAppendOnlyManifest } from "./db-safety.ts";
const manifest = {
  baseline_digest: "1".repeat(64),
  migration_manifest_digest: "2".repeat(64)
};
const state = {
  operation_id: "10000000-0000-4000-8000-000000000001",
  target: "prod",
  project: "prod-ref",
  source_sha: "a".repeat(40),
  ...manifest,
  phase: "DB-ready",
  intent_time: "2026-11-07T00:00:00Z",
  maintenance: true
};
const env = {
  PROD_SUPABASE_PROJECT_REF: "prod-ref",
  NEXT_PUBLIC_SUPABASE_URL: "https://prod-ref.supabase.co",
  DB_REBUILD_STATE_PROD: JSON.stringify(state)
};
test("maintenance cannot be bypassed with wrong source, manifest, phase or project", () => {
  assert.doesNotThrow(() => checkPromotion(env, state.source_sha, manifest));
  assert.throws(() => checkPromotion(env, "b".repeat(40), manifest));
  assert.throws(() => checkPromotion(env, state.source_sha, {
    ...manifest,
    migration_manifest_digest: "3".repeat(64)
  }));
  assert.throws(() => checkPromotion({
    ...env,
    DB_REBUILD_STATE_PROD: JSON.stringify({
      ...state,
      phase: "reset_started"
    })
  }, state.source_sha, manifest));
  assert.throws(() => checkPromotion({
    ...env,
    NEXT_PUBLIC_SUPABASE_URL: "https://test-ref.supabase.co"
  }, state.source_sha, manifest));
});
test("daily promotions require correct Pages project and valid durable state", () => {
  assert.doesNotThrow(() => checkPromotion({
    ...env,
    DB_REBUILD_STATE_PROD: ""
  }, state.source_sha, manifest));
  assert.throws(() => checkPromotion({
    ...env,
    PROD_SUPABASE_PROJECT_REF: ""
  }, state.source_sha, manifest));
  assert.throws(() => checkPromotion({
    ...env,
    DB_REBUILD_STATE_PROD: "{}"
  }, state.source_sha, manifest));
  assert.throws(() => parseRebuildState({
    ...state,
    maintenance: false
  }));
  assert.doesNotThrow(() => parseRebuildState({
    ...state,
    maintenance: false,
    phase: "accepted"
  }));
});
test("target checks require distinct environment mappings and matching direct or pooler identities", () => {
  const e = {
    REBUILD_PROJECT_REF: "test-ref",
    REBUILD_OTHER_PROJECT_REF: "prod-ref",
    REBUILD_SUPABASE_URL: "https://test-ref.supabase.co",
    REBUILD_DATABASE_URL: "postgresql://postgres:local@db.test-ref.supabase.co/postgres"
  };
  assert.doesNotThrow(() => validateProjectIdentity("test", "test-ref", e));
  assert.throws(() => validateProjectIdentity("test", "test-ref", {
    ...e,
    REBUILD_OTHER_PROJECT_REF: ""
  }));
  assert.throws(() => validateProjectIdentity("test", "test-ref", {
    ...e,
    REBUILD_DATABASE_URL: "postgresql://postgres:local@db.prod-ref.supabase.co/postgres"
  }));
  assert.doesNotThrow(() => validateProjectIdentity("test", "test-ref", {
    ...e,
    REBUILD_DATABASE_URL: "postgresql://postgres.test-ref:local@aws.pooler.supabase.com/postgres"
  }));
});
test("every mutation requires maintenance authorization", () => {
  assert.throws(() => requireMaintenanceAuthorization({
    REBUILD_EXECUTION_AUTHORIZED: "true"
  }));
  assert.doesNotThrow(() => requireMaintenanceAuthorization({
    REBUILD_EXECUTION_AUTHORIZED: "true",
    REBUILD_MAINTENANCE_VERIFIED: "true"
  }));
});
test("old libpq routing/options do not leak into explicitly selected target", () => {
  const safe = cleanPostgresEnvironment({
    PATH: "/usr/bin",
    PGHOST: "other",
    PGSERVICE: "other",
    PGOPTIONS: "options",
    PGPASSWORD: "secret"
  });
  assert.deepEqual(safe, {
    PATH: "/usr/bin"
  });
});
test("remote-mode rehearsal never accepts the ordinary local stack or a hosted URL", () => {
  const inspected = {
    Name: "/supabase_db_cv-remote-rehearsal",
    NetworkSettings: {
      Ports: {
        "5432/tcp": [{
          HostIp: "0.0.0.0",
          HostPort: "54622"
        }]
      }
    }
  };
  assert.doesNotThrow(() => validateRehearsalIdentity("postgresql://postgres:local@127.0.0.1:54622/postgres", inspected));
  assert.throws(() => validateRehearsalIdentity("postgresql://postgres:local@db.prod.supabase.co:54622/postgres", inspected));
  assert.throws(() => validateRehearsalIdentity("postgresql://postgres:local@127.0.0.1:54322/postgres", inspected));
  assert.throws(() => validateRehearsalIdentity("postgresql://postgres:local@127.0.0.1:54622/postgres?host=db.prod.supabase.co", inspected));
  assert.throws(() => validateRehearsalIdentity("postgresql://postgres:local@127.0.0.1:54622/postgres", {
    ...inspected,
    Name: "/supabase_db_typst-cv-template"
  }));
});
test("resume keeps schema DDL and migration history in a single file transaction", () => {
  const applied = migrationWithHistory("-- reviewed file\nbegin;\ncreate table example(id int);\ncommit;\n", "20261107120000", "20261107120000_example.sql");
  assert.equal((applied.match(/^commit;/gim) ?? []).length, 1);
  assert(applied.indexOf("create table") < applied.indexOf("insert into supabase_migrations"));
  assert(applied.indexOf("insert into supabase_migrations") < applied.lastIndexOf("commit;"));
  assert.throws(() => migrationWithHistory("create table example(id int);", "20261107120000", "20261107120000_example.sql"));
  assert.throws(() => migrationWithHistory("begin;\ncreate table example(id int);\ncommit;\nbegin;\ncommit;", "20261107120000", "20261107120000_example.sql"));
});
const migrationVersion = "20261107120000";
const migrationName = `${migrationVersion}_example.sql`;
const historyInsert = `\ninsert into supabase_migrations.schema_migrations(version,name) values('${migrationVersion}','example');\ncommit;`;
test("migration trivia scanning preserves whitespace and nested/adjacent comment headers", () => {
  for (const header of ["", " \t\r\n", "-- reviewed\r\n", "-- reviewed\r", "/**//**/\n", "/* outer /* nested */ tail */\n-- next\n", "/* begin; commit; */ -- rollback;\n"]) {
    const body = "\nselect 1;\r\n";
    assert.equal(migrationWithHistory(`${header}BeGiN \t;${body}COMMIT \n;\r\n`, migrationVersion, migrationName), `${header}begin;${body}${historyInsert}`);
  }
});
test("all actual migrations retain byte-identical headers/bodies and history injection output", () => {
  const directory = new URL("../supabase/migrations/", import.meta.url);
  const files = readdirSync(directory).filter(name => name.endsWith(".sql")).sort();
  assert(files.length >= 8);
  for (const name of files) {
    const source = readFileSync(new URL(name, directory), "utf8");
    // The frozen files have canonical BEGIN/COMMIT lines. Build the previous
    // output directly, without retaining the vulnerable regex in a test helper.
    const begin = /^begin;$/im.exec(source);
    const commit = source.lastIndexOf("commit;");
    assert(begin && commit > begin.index, name);
    const version = name.split("_")[0];
    const label = name.slice(version.length + 1, -4);
    const expected = `${source.slice(0, begin.index)}begin;${source.slice(begin.index + begin[0].length, commit)}\ninsert into supabase_migrations.schema_migrations(version,name) values('${version}','${label}');\ncommit;`;
    assert.equal(migrationWithHistory(source, version, name), expected, name);
  }
});
test("quoted strings, identifiers and case-sensitive dollar bodies do not create transaction boundaries", () => {
  const body = String.raw`
select 'it''s ; BEGIN; COMMIT; ROLLBACK;', '\';
select E'escaped \'; COMMIT; BEGIN; still inside the string';
create table "quoted"";COMMIT;BEGIN;" (id integer);
do $tag$ BEGIN; COMMIT; /* opaque */ $TAG$ ROLLBACK; $tag$;
do $$ BEGIN; END; ABORT; $$;
prepare "transaction" as select 1;
select 1::integer, $1;
`;
  assert.equal(migrationWithHistory(`begin;${body}commit;`, migrationVersion, migrationName), `begin;${body}${historyInsert}`);
});
test("only escape strings treat a backslash as escaping a quote", () => {
  // A generic backslash-string scanner would swallow the first quote and could
  // hide the real early COMMIT. PostgreSQL standard strings do not do that.
  assert.throws(() => migrationWithHistory(String.raw`begin;select '\';commit;begin;select '';commit;`, migrationVersion, migrationName));
});
test("transaction commands cannot hide inline or behind comments", () => {
  for (const body of [
    "select 1;commit;begin;select 2;", "begin;select 1;", "BEGIN TRANSACTION;", "rollback;", "rollback to savepoint x;", "end;", "abort;", "END WORK;", "START TRANSACTION;", "start/* one /* nested */ */transaction;", "START-- next token\nTRANSACTION;", "PREPARE TRANSACTION 'prepared';", "prepare/* reviewed */transaction 'prepared';", "prepare-- next token\r\ntransaction 'prepared';", "select 1;COMMIT/**/;select 2;"
  ]) assert.throws(() => migrationWithHistory(`begin;${body}commit;`, migrationVersion, migrationName), /exactly one explicit outer transaction/, body);
  assert.throws(() => migrationWithHistory("begin;select 1;commit;-- trailing comment", migrationVersion, migrationName));
});
test("malformed or unterminated lexical states fail closed", () => {
  for (const source of [
    "/* open begin;select 1;commit;", "/* outer /* nested */ begin;select 1;commit;", "-- no newline begin;select 1;commit;", "*/begin;select 1;commit;", "begin;select 1;/* open commit;", "begin;select 1;/* outer /* nested */ commit;", "begin;select 'open;commit;", 'begin;select "open;commit;', "begin;select E'open\\';commit;", "begin;do $$open;commit;", "begin;do $tag$wrong close $TAG$;commit;", "begin;do $bad-tag$body$bad-tag$;commit;", "begin;select 1;*/commit;", "begin;\\gexec\ncommit;", "begin;select :'psql_variable';commit;", "begin;select \0;commit;", "begin;select 1;", "select 1;commit;", "beginning;select 1;commit;"
  ]) assert.throws(() => migrationWithHistory(source, migrationVersion, migrationName), /exactly one explicit outer transaction/, source);
});
test("adversarial comment partitions and large trivia finish within a child-process deadline", { timeout: 10_000 }, () => {
  const module = new URL("./db-safety.ts", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { migrationWithHistory } from ${JSON.stringify(module)};
    const apply = source => migrationWithHistory(source, '${migrationVersion}', '${migrationName}');
    // CQL-01: each *//* lets the old regex reconsider previous comment partitions.
    assert.throws(() => apply('/*' + '*//*'.repeat(200000)));
    assert.doesNotThrow(() => apply('/*' + '*//*'.repeat(200000) + '*/begin;select 1;commit;'));
    assert.throws(() => apply('/*'.repeat(100000) + '*/'.repeat(99999)));
    assert.doesNotThrow(() => apply('-- reviewed\\n'.repeat(100000) + 'begin;' + '\\n'.repeat(200000) + 'select 1;commit;'));
    assert.throws(() => apply('begin;' + '\\n'.repeat(200000) + 'select 1;commit;begin;commit;'));
    console.log('bounded migration scanner passed');
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
  assert.equal(child.error, undefined, "migration scanner exceeded its child-process deadline");
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "bounded migration scanner passed");
});
test("hosted connections cannot override libpq routing, TLS or database", () => {
  const identity = {
    REBUILD_PROJECT_REF: "test-ref",
    REBUILD_OTHER_PROJECT_REF: "prod-ref",
    REBUILD_SUPABASE_URL: "https://test-ref.supabase.co"
  };
  for (const suffix of ["/postgres?host=other", "/postgres?sslmode=disable", "/postgres#override", "/template1"]) {
    assert.throws(() => validateProjectIdentity("test", "test-ref", {
      ...identity,
      REBUILD_DATABASE_URL: `postgresql://postgres:local@db.test-ref.supabase.co${suffix}`
    }));
  }
});
test("production requires accepted test proof for the actual other project and both digests", () => {
  const verified = {
    ...state,
    target: "test",
    project: "test-ref",
    phase: "accepted",
    maintenance: false
  };
  assert.doesNotThrow(() => requireAcceptedTest(verified, "test-ref", state.source_sha, manifest));
  assert.throws(() => requireAcceptedTest({
    ...verified,
    target: "prod"
  }, "test-ref", state.source_sha, manifest));
  assert.throws(() => requireAcceptedTest({
    ...verified,
    project: "other"
  }, "test-ref", state.source_sha, manifest));
  assert.throws(() => requireAcceptedTest({
    ...verified,
    baseline_digest: "0".repeat(64)
  }, "test-ref", state.source_sha, manifest));
});
test("unsupported PostgreSQL/database targets fail before destructive intent", () => {
  assert.doesNotThrow(() => validateDatabaseServer({
    server_version_num: "170006",
    database: "postgres",
    current_user: "postgres"
  }));
  assert.throws(() => validateDatabaseServer({
    server_version_num: "160010",
    database: "postgres",
    current_user: "postgres"
  }));
  assert.throws(() => validateDatabaseServer({
    server_version_num: "170006",
    database: "template1",
    current_user: "postgres"
  }));
});
test("instance and current tables block rebuilding independently of migration history", () => {
  assert.doesNotThrow(() => requireFreshApplicationState({
    application_tables: 0,
    environment_relation: false,
    instance_id: null
  }));
  assert.throws(() => requireFreshApplicationState({
    application_tables: 31,
    environment_relation: false,
    instance_id: null
  }));
  assert.throws(() => requireFreshApplicationState({
    application_tables: 0,
    environment_relation: true,
    instance_id: null
  }));
  assert.throws(() => requireFreshApplicationState({
    application_tables: 0,
    environment_relation: false,
    instance_id: state.operation_id
  }));
});
test("recovery proof binds method and the cleanup SQL/inventory digests", () => {
  const intent = {
    ...state,
    reset_method: "application_allowlist" as const,
    cleanup_sql_digest: "3".repeat(64),
    retired_inventory_digest: "4".repeat(64)
  };
  const proof = {
    method: intent.reset_method,
    cleanup_sql_digest: intent.cleanup_sql_digest,
    retired_inventory_digest: intent.retired_inventory_digest,
    operation_id: intent.operation_id,
    project: intent.project,
    source_sha: intent.source_sha,
    ...manifest,
    reset_catalog_digest: "5".repeat(64),
    reset_completed: true,
    platform_preservation_passed: true
  };
  assert.doesNotThrow(() => requireRecoveryEvidence(proof, intent, manifest, "5".repeat(64)));
  for (const key of ["method", "cleanup_sql_digest", "retired_inventory_digest"]) {
    assert.throws(() => requireRecoveryEvidence({
      ...proof,
      [key]: "wrong"
    }, intent, manifest, "5".repeat(64)));
  }
});
test("hosted rebuild requires rehearsal evidence for the exact source and complete manifest", () => {
  const cleanup = {
    reset_method: "application_allowlist",
    cleanup_sql_digest: "3".repeat(64),
    retired_inventory_digest: "4".repeat(64)
  };
  const proof = {
    source_sha: state.source_sha,
    method: cleanup.reset_method,
    ...cleanup,
    cli_version: "2.109.0",
    ...manifest,
    old_chain_passed: true,
    platform_preservation_passed: true,
    remote_mode_resume_passed: true
  };
  assert.doesNotThrow(() => requireRehearsalEvidence(proof, state.source_sha, manifest, cleanup));
  for (const key of ["source_sha", "method", "cleanup_sql_digest", "retired_inventory_digest", "baseline_digest", "migration_manifest_digest", "cli_version", "old_chain_passed", "platform_preservation_passed", "remote_mode_resume_passed"]) {
    assert.throws(() => requireRehearsalEvidence({
      ...proof,
      [key]: "mismatch"
    }, state.source_sha, manifest, cleanup));
  }
});

// Public parsing fixtures only; no private key or live connection is used.
const caPem = readFileSync(new URL("./test-fixtures/database-ca.crt", import.meta.url), "utf8");
const leafPem = readFileSync(new URL("./test-fixtures/database-leaf.crt", import.meta.url), "utf8");
const certificateEnv = {
  REBUILD_DATABASE_URL: "postgresql://postgres.test-ref:p%40ss@aws.pooler.supabase.com:6543/postgres",
  REBUILD_CA_CERT_FILE: "/controlled/target-ca.crt"
};
test("hosted trust requires an explicit absolute PEM X509 CA file", () => {
  assert.doesNotThrow(() => hostedPostgresEnvironment(certificateEnv, caPem));
  for (const file of ["", "target-ca.crt"]) assert.throws(() => hostedPostgresEnvironment({
    ...certificateEnv,
    REBUILD_CA_CERT_FILE: file
  }, caPem));
  for (const pem of ["", "not a certificate", "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----", leafPem, `${caPem}\n${caPem}`]) assert.throws(() => hostedPostgresEnvironment(certificateEnv, pem));
});
test("hosted connection uses only the selected CA and forces full TLS verification", () => {
  const connection = hostedPostgresEnvironment({
    ...certificateEnv,
    PATH: "/bin",
    PGSSLROOTCERT: "/developer/default-ca.crt",
    PGSSLMODE: "disable",
    PGHOST: "other",
    PGSERVICE: "other",
    PGOPTIONS: "other"
  }, caPem);
  assert.equal(connection.PGSSLROOTCERT, certificateEnv.REBUILD_CA_CERT_FILE);
  assert.equal(connection.PGSSLMODE, "verify-full");
  assert.equal(connection.PGHOST, "aws.pooler.supabase.com");
  assert.equal(connection.PGPORT, "6543");
  assert.equal(connection.PGUSER, "postgres.test-ref");
  assert.equal(connection.PGPASSWORD, "p@ss");
  assert.equal(connection.PGDATABASE, "postgres");
  assert.equal(connection.PATH, "/bin");
  assert.equal(connection.PGSERVICE, undefined);
  assert.equal(connection.PGOPTIONS, undefined);
  assert.throws(() => hostedPostgresEnvironment({
    ...certificateEnv,
    REBUILD_DATABASE_URL: `${certificateEnv.REBUILD_DATABASE_URL}?sslmode=disable`
  }, caPem));
});
test("resume cannot rewrite or remove migrations after the reviewed baseline", () => {
  const previous = Array.from({
    length: 5
  }, (_, index) => ({
    name: `${index + 1}_fixture.sql`,
    digest: String(index + 1).repeat(64)
  }));
  const recorded = createHash("sha256").update(JSON.stringify(previous)).digest("hex");
  const successor = {
    name: "6_fixture.sql",
    digest: "6".repeat(64)
  };
  assert.doesNotThrow(() => requireAppendOnlyManifest(recorded, previous));
  assert.doesNotThrow(() => requireAppendOnlyManifest(recorded, [...previous, successor]));
  assert.throws(() => requireAppendOnlyManifest(recorded, previous.slice(0, 4)));
  const rewritten = previous.map((entry, index) => index === 4 ? {
    ...entry,
    digest: "a".repeat(64)
  } : entry);
  assert.throws(() => requireAppendOnlyManifest(recorded, [...rewritten, successor]));
  assert.throws(() => requireAppendOnlyManifest(recorded, [previous[1], previous[0], ...previous.slice(2), successor]));
});
