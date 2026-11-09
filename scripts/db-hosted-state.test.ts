import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { openHostedState, readPrivateCheckpoint } from "./db-hosted-state.ts";
import type { RebuildState } from "./db-safety.ts";
const project = "a".repeat(20), source = "b".repeat(40);
const moduleUrl = new URL("./db-hosted-state.ts", import.meta.url).href;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cv-hosted-state-"));
  const options = { directory, target: "test" as const, project, mode: "rebuild" as const, sourceSha: source };
  const state: RebuildState = { operation_id: "00000000-0000-4000-8000-000000000081", target: "test", project, source_sha: source, baseline_digest: "c".repeat(64), migration_manifest_digest: "d".repeat(64), phase: "intent", maintenance: true, intent_time: "2026-11-09T00:00:00Z", reset_method: "application_allowlist", cleanup_sql_digest: "e".repeat(64), retired_inventory_digest: "f".repeat(64) };
  return { directory, options, state, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}
function events(path: string) { return readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)); }

test("local state requires an absolute private owned directory and does not chmod unsafe existing paths", () => {
  const f = fixture();
  try {
    assert.throws(() => openHostedState({ ...f.options, directory: "relative" }), /absolute/);
    chmodSync(f.directory, 0o755);
    assert.throws(() => openHostedState(f.options), /0700/);
    assert.equal(statSync(f.directory).mode & 0o777, 0o755);
    chmodSync(f.directory, 0o700);
    const link = join(f.directory, "link"); symlinkSync(f.directory, link);
    assert.throws(() => openHostedState({ ...f.options, directory: link }), /symlink/);
  } finally { f.dispose(); }
});

test("checkpoint replacement stays complete and private; arbitrary fields and credentials never enter state or events", () => {
  const f = fixture();
  try {
    const store = openHostedState(f.options); assert.equal(store.read(), null);
    const poisoned = { ...f.state, admin_user: "private-auth-identity", env: "private-environment", sql: "private-sql", password: "private-password" };
    store.write(poisoned);
    const updated = { ...f.state, phase: "DB-ready", instance: "00000000-0000-4000-8000-000000000082", history: ["20261108123038"] };
    store.write(updated); assert.deepEqual(store.read(), updated);
    assert.equal(statSync(store.paths.checkpoint).mode & 0o777, 0o600);
    assert.equal(statSync(store.paths.events).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(f.directory).filter(name => name.includes(".tmp-")), []);
    const data = readFileSync(store.paths.checkpoint, "utf8") + readFileSync(store.paths.events, "utf8");
    for (const secret of ["private-auth-identity", "private-environment", "private-sql", "private-password"]) assert.equal(data.includes(secret), false);
    assert.ok(events(store.paths.events).some(row => row.event === "checkpoint_saved" && row.phase === "DB-ready"));
    store.finish(updated); assert.equal(existsSync(store.paths.lock), false);
  } finally { f.dispose(); }
});

test("invalid checkpoint updates leave the last valid JSON intact", () => {
  const f = fixture();
  try {
    const store = openHostedState(f.options); store.write(f.state);
    const before = readFileSync(store.paths.checkpoint, "utf8");
    assert.throws(() => store.write({ ...f.state, source_sha: "invalid" }));
    assert.equal(readFileSync(store.paths.checkpoint, "utf8"), before);
    assert.deepEqual(readdirSync(f.directory).filter(name => name.includes(".tmp-")), []);
    store.fail("invalid_checkpoint", true); assert.equal(existsSync(store.paths.lock), true);
  } finally { f.dispose(); }
});

test("private accepted-test snapshots reject relative, unsafe and symlinked inputs", () => {
  const f = fixture();
  try {
    const store = openHostedState(f.options);
    const accepted = { ...f.state, phase: "accepted", maintenance: false };
    store.write(accepted); store.finish(accepted);
    assert.deepEqual(readPrivateCheckpoint(store.paths.checkpoint).state, accepted);
    assert.match(readPrivateCheckpoint(store.paths.checkpoint).digest, /^[0-9a-f]{64}$/);
    assert.throws(() => readPrivateCheckpoint("relative"), /absolute/);
    chmodSync(store.paths.checkpoint, 0o644);
    assert.throws(() => readPrivateCheckpoint(store.paths.checkpoint), /0600/);
    chmodSync(store.paths.checkpoint, 0o600);
    const link = join(f.directory, "test-link.json"); symlinkSync(store.paths.checkpoint, link);
    assert.throws(() => readPrivateCheckpoint(link), /0600|links/);
  } finally { f.dispose(); }
});

test("a failed event append cannot erase an already durable checkpoint or report a successful operation", () => {
  const f = fixture();
  try {
    const store = openHostedState(f.options); chmodSync(store.paths.events, 0o644);
    assert.throws(() => store.write(f.state), /0600/);
    assert.deepEqual(readPrivateCheckpoint(store.paths.checkpoint).state, f.state);
    assert.equal(existsSync(store.paths.lock), true);
    store.fail("event_write", true);
    chmodSync(store.paths.events, 0o600);
    assert.equal(events(store.paths.events).some(row => row.event === "run_completed"), false);
  } finally { f.dispose(); }
});

test("captured read-only/preflight failures release only their own lock and log no exception payload", () => {
  const f = fixture();
  try {
    const store = openHostedState({ ...f.options, mode: "plan" });
    store.fail("catalog_inspection", false);
    assert.equal(existsSync(store.paths.lock), false);
    assert.equal(events(store.paths.events).at(-1).event, "run_failed_lock_released");
    const next = openHostedState({ ...f.options, mode: "verify" }); next.finish();
  } finally { f.dispose(); }
});

test("one project lock excludes another target alias and an unknown mutation failure is never auto-reclaimed", () => {
  const f = fixture();
  try {
    const first = openHostedState(f.options); first.fail("application_cleanup", true);
    assert.throws(() => openHostedState({ ...f.options, target: "prod" }), /lock exists/);
    const lock = JSON.parse(readFileSync(first.paths.lock, "utf8"));
    assert.equal(lock.pid, process.pid); assert.equal(lock.attempt_id, first.attemptId);
    assert.ok(lock.created_at); assert.equal(existsSync(first.paths.lock), true);
    // Explicit test-owner cleanup after inspection, never automatic TTL/PID logic.
    unlinkSync(first.paths.lock);
    const next = openHostedState(f.options); next.finish();
  } finally { f.dispose(); }
});

test("a real competing process cannot enter, and SIGKILL leaves an inspectable orphan lock", { timeout: 10_000 }, async () => {
  const f = fixture();
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {openHostedState} from ${JSON.stringify(moduleUrl)}; const s=openHostedState(${JSON.stringify(f.options)}); console.log('READY'); setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const [output] = await once(child.stdout, "data"); assert.match(String(output), /READY/);
    const contender = spawnSync(process.execPath, ["--input-type=module", "-e", `import {openHostedState} from ${JSON.stringify(moduleUrl)}; openHostedState(${JSON.stringify(f.options)});`], { encoding: "utf8", timeout: 5_000 });
    assert.notEqual(contender.status, 0); assert.match(contender.stderr, /lock exists/);
    child.kill("SIGKILL"); await once(child, "exit");
    const lockPath = join(f.directory, `${project}.lock`);
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, child.pid);
    assert.throws(() => openHostedState(f.options), /lock exists/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    f.dispose();
  }
});

test("a hosted invocation is rejected in GitHub Actions before any database command or state file", () => {
  const f = fixture();
  try {
    const bin = join(f.directory, "bin"); mkdirSync(bin);
    const marker = join(f.directory, "unexpected-psql");
    writeFileSync(join(bin, "psql"), `#!/bin/sh\nprintf blocked > '${marker}'\nexit 1\n`, { mode: 0o700 });
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./db-rebuild.ts", import.meta.url)), "--target=test", "--mode=plan", `--source-sha=${spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()}`, `--expected-project-ref=${project}`, `--state-dir=${join(f.directory, "state")}`], {
      env: { ...process.env, GITHUB_ACTIONS: "true", PATH: `${bin}:${process.env.PATH}`, REBUILD_DATABASE_URL: "postgresql://postgres:DO_NOT_LOG_THIS@invalid.test/postgres" }, encoding: "utf8", timeout: 5_000
    });
    assert.equal(result.status, 1); assert.match(result.stderr, /stopped during preflight/);
    assert.equal(result.stderr.includes("DO_NOT_LOG_THIS"), false);
    assert.equal(existsSync(marker), false); assert.equal(existsSync(join(f.directory, "state")), false);
  } finally { f.dispose(); }
});
