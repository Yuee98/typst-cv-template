/** Operator-local hosted checkpoints. No database, GitHub, credentials or network I/O. */
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseRebuildState, type RebuildState } from "./db-safety.ts";

type Target = "test" | "prod";
type Mode = "plan" | "rebuild" | "resume" | "verify";
type Facts = Partial<RebuildState> & { old_source_sha?: string; reset_catalog_digest?: string; test_state_digest?: string; stage?: string; result?: "PASS" | "FAIL" };
const fields = ["operation_id", "phase", "maintenance", "source_sha", "old_source_sha", "baseline_digest", "migration_manifest_digest", "instance", "history", "reset_method", "cleanup_sql_digest", "retired_inventory_digest", "reset_catalog_digest", "test_state_digest", "stage", "result"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function privateFile(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error("Local checkpoint/event files must be owned regular 0600 files without links");
}
function minimalState(value: unknown) {
  const state = parseRebuildState(value);
  if (!uuid.test(state.operation_id) || state.instance !== undefined && !uuid.test(state.instance) || state.history !== undefined && (!Array.isArray(state.history) || state.history.some(version => !/^\d{14}$/.test(version)))) throw new Error("Invalid local checkpoint metadata");
  // Explicitly omit unknown properties, including any accidental admin identity,
  // SQL, environment or connection details. The checkpoint is not a report.
  return Object.fromEntries(["operation_id", "target", "project", "source_sha", "baseline_digest", "migration_manifest_digest", "phase", "history", "instance", "intent_time", "maintenance", "reset_method", "cleanup_sql_digest", "retired_inventory_digest"].filter(key => state[key as keyof RebuildState] !== undefined).map(key => [key, state[key as keyof RebuildState]])) as RebuildState;
}
export function readPrivateCheckpoint(path: string) {
  if (!isAbsolute(path)) throw new Error("Checkpoint path must be absolute");
  privateFile(path);
  const text = readFileSync(path, "utf8");
  return { state: minimalState(JSON.parse(text)), digest: createHash("sha256").update(text).digest("hex") };
}
export function openHostedState(options: { directory: string; target: Target; project: string; mode: Mode; sourceSha: string }) {
  if (!isAbsolute(options.directory) || !/^[a-z0-9]{20}$/.test(options.project) || !/^[0-9a-f]{40}$/.test(options.sourceSha) || !["test", "prod"].includes(options.target) || !["plan", "rebuild", "resume", "verify"].includes(options.mode)) throw new Error("An absolute private state directory and exact project ref are required");
  if (!existsSync(options.directory)) mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(options.directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o777) !== 0o700 || directoryStat.uid !== process.getuid?.()) throw new Error("State directory must be owned 0700 and not a symlink");
  const directory = realpathSync(options.directory);
  const stem = `${options.target}-${options.project}`;
  const paths = { checkpoint: join(directory, `${stem}.json`), events: join(directory, `${stem}.events.jsonl`), lock: join(directory, `${options.project}.lock`) };
  const attemptId = randomUUID();
  const start = new Date().toISOString();
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW;
  let locked = false, finished = false;
  function record(event: string, facts: Facts = {}) {
    if (existsSync(paths.events)) privateFile(paths.events);
    const allowed = Object.fromEntries(fields.filter(key => facts[key] !== undefined).map(key => [key, facts[key]]));
    const row = { time: new Date().toISOString(), attempt_id: attemptId, target: options.target, project: options.project, mode: options.mode, source_sha: options.sourceSha, requested_source_sha: options.sourceSha, event, ...allowed };
    const fd = openSync(paths.events, flags, 0o600);
    try {
      if ((fstatSync(fd).mode & 0o777) !== 0o600) throw new Error("Unsafe event file permissions");
      writeFileSync(fd, JSON.stringify(row) + "\n"); fsyncSync(fd);
    } finally { closeSync(fd); }
  }
  record("run_started");
  try {
    const fd = openSync(paths.lock, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: start, attempt_id: attemptId, target: options.target, project: options.project, mode: options.mode })); fsyncSync(fd); }
    finally { closeSync(fd); }
    locked = true;
  } catch {
    record("target_lock_refused", { result: "FAIL" });
    throw new Error("Local target lock exists or cannot be created; inspect its process and actual catalog before manual removal");
  }
  function assertLock() {
    privateFile(paths.lock);
    if (JSON.parse(readFileSync(paths.lock, "utf8")).attempt_id !== attemptId) throw new Error("Local target lock ownership changed");
  }
  function read() {
    assertLock();
    const state = existsSync(paths.checkpoint) ? readPrivateCheckpoint(paths.checkpoint).state : null;
    record("checkpoint_read", state ?? {});
    return state;
  }
  function write(value: RebuildState) {
    assertLock();
    const state = minimalState(value);
    if (state.target !== options.target || state.project !== options.project) throw new Error("Checkpoint identifies another target");
    if (existsSync(paths.checkpoint)) privateFile(paths.checkpoint);
    const temporary = `${paths.checkpoint}.tmp-${randomUUID()}`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(state, null, 2) + "\n"); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, paths.checkpoint);
      const parent = openSync(directory, "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    // State must survive first; an event failure is uncertain and keeps the lock.
    record("checkpoint_saved", state);
  }
  function finish(facts: Facts = {}) {
    assertLock(); record("run_completed", { ...facts, result: "PASS" });
    unlinkSync(paths.lock); locked = false; finished = true;
  }
  function fail(stage = "operation", retainLock = true) {
    if (finished) return;
    if (!retainLock && locked) {
      try { assertLock(); unlinkSync(paths.lock); locked = false; } catch { /* Never remove another attempt's lock. */ }
    }
    try { record(locked ? "run_failed_lock_retained" : "run_failed_lock_released", { result: "FAIL", stage }); } catch { /* Do not expose the original exception or mask an uncertain checkpoint. */ }
    finished = true;
    // No PID/TTL reclamation. SIGKILL/uncertain mutation failures retain the lock.
  }
  return { paths, attemptId, read, write, record, finish, fail, get locked() { return locked; } };
}
