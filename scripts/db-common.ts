import { hostedPostgresEnvironment } from "./db-safety.ts";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function quote(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
export function run(command: string, args: string[], input?: string, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: root,
    input,
    encoding: "utf8",
    env: {
      ...env,
      SUPABASE_TELEMETRY_DISABLED: "1"
    },
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    // Connection strings/passwords can appear in subprocess errors. Emit no captured text.
    throw new Error(`${command} failed (${result.status ?? "unavailable"}); inspect the local tool separately without exposing credentials.`);
  }
  return result.stdout.trim();
}
export function sql(statement: string, local = process.argv.includes("--local")) {
  if (local || process.argv.includes("--rehearsal")) return run("docker", ["exec", "-i", process.argv.includes("--rehearsal") ? "supabase_db_cv-remote-rehearsal" : "supabase_db_typst-cv-template", "psql", "-XAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], statement);
  const raw = process.env.REBUILD_DATABASE_URL;
  if (!raw) throw new Error("REBUILD_DATABASE_URL is required; no developer .env or saved link is used.");
  const caFile = process.env.REBUILD_CA_CERT_FILE;
  if (!caFile || !isAbsolute(caFile)) throw new Error("REBUILD_CA_CERT_FILE must name an explicit absolute target CA file");
  return run("psql", ["-XAt", "-v", "ON_ERROR_STOP=1"], statement, hostedPostgresEnvironment(process.env, readFileSync(caFile, "utf8")));
}
export function jsonQuery(statement: string, local?: boolean) {
  return JSON.parse(sql(statement, local));
}
export function migrationManifest() {
  const dir = resolve(root, "supabase/migrations");
  const files = readdirSync(dir).filter(name => /^\d+_[a-z_]+\.sql$/.test(name)).sort();
  if (!files.length) throw new Error("No baseline migrations");
  const entries = files.map(name => ({
    name,
    digest: createHash("sha256").update(readFileSync(resolve(dir, name))).digest("hex")
  }));
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  // Four initial files define the immutable rebuild baseline. Later fixes append.
  return {
    files: entries,
    baseline_digest: hash(entries.slice(0, 4)),
    migration_manifest_digest: hash(entries)
  };
}
export function input(name: string, fallback?: string) {
  const arg = process.argv.find(value => value.startsWith(`--${name}=`));
  const value = arg?.slice(name.length + 3) ?? fallback;
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}
