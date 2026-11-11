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
export function sql(statement: string, local = process.argv.includes("--local"), readOnly = false) {
  // Poolers can discard startup PGOPTIONS. The transaction itself must carry
  // these guarantees, including when a fixed SELECT calls a writing function.
  const query = readOnly ? `BEGIN READ ONLY;\nSET LOCAL statement_timeout = '20s';\nSET LOCAL lock_timeout = '3s';\n${statement}\nCOMMIT;\n` : statement;
  const args = ["-XAt", ...(readOnly ? ["-q"] : []), "-v", "ON_ERROR_STOP=1"];
  if (local || process.argv.includes("--rehearsal")) return run("docker", ["exec", "-i", process.argv.includes("--rehearsal") ? "supabase_db_cv-remote-rehearsal" : "supabase_db_typst-cv-template", "psql", ...args, "-U", "postgres", "-d", "postgres"], query);
  const raw = process.env.REBUILD_DATABASE_URL;
  if (!raw) throw new Error("REBUILD_DATABASE_URL is required; no developer .env or saved link is used.");
  const caFile = process.env.REBUILD_CA_CERT_FILE;
  if (!caFile || !isAbsolute(caFile)) throw new Error("REBUILD_CA_CERT_FILE must name an explicit absolute target CA file");
  const env = hostedPostgresEnvironment(process.env, readFileSync(caFile, "utf8"));
  return run("psql", args, query, env);
}
export function jsonQuery(statement: string, local?: boolean) {
  return JSON.parse(sql(statement, local));
}
/** Opt-in: SELECT syntax alone does not prevent a called function from writing. */
export function jsonQueryReadOnly(statement: string, local?: boolean) {
  return JSON.parse(sql(statement, local, true));
}
export function buildMigrationManifest(entries: { name: string; digest: string }[], baselineNames: string[]) {
  const validName = /^\d{14}_[a-z0-9_]+\.sql$/;
  if (!entries.length || entries.some(entry => !validName.test(entry.name) || !/^[a-f0-9]{64}$/.test(entry.digest))) throw new Error("Invalid migration manifest entries");
  if (!Array.isArray(baselineNames) || !baselineNames.length || baselineNames.some(name => typeof name !== "string" || !validName.test(name))) throw new Error("Explicit baseline migration names are required");
  if (new Set(entries.map(entry => entry.name)).size !== entries.length || new Set(baselineNames).size !== baselineNames.length) throw new Error("Duplicate migration names");
  if (new Set(entries.map(entry => entry.name.slice(0, 14))).size !== entries.length) throw new Error("Migration timestamps must be unique");
  if (entries.some((entry, index) => index > 0 && entries[index - 1].name >= entry.name)) throw new Error("Migration names must be ordered");
  if (baselineNames.some((name, index) => entries[index]?.name !== name)) throw new Error("Baseline must be the complete unchanged prefix of the migration chain");
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    files: entries,
    baseline_digest: hash(entries.slice(0, baselineNames.length)),
    migration_manifest_digest: hash(entries)
  };
}
export function migrationManifest() {
  const dir = resolve(root, "supabase/migrations");
  const files = readdirSync(dir).filter(name => name.endsWith(".sql")).sort();
  if (files.some(name => !/^\d{14}_[a-z0-9_]+\.sql$/.test(name))) throw new Error("Unexpected SQL file in the migration chain");
  if (!files.length) throw new Error("No baseline migrations");
  const entries = files.map(name => ({
    name,
    digest: createHash("sha256").update(readFileSync(resolve(dir, name))).digest("hex")
  }));
  // The reviewed baseline is explicit; schema-based splitting never relies on a file count.
  const baselineNames: unknown = JSON.parse(readFileSync(resolve(root, "supabase/baseline.json"), "utf8"));
  if (!Array.isArray(baselineNames)) throw new Error("Baseline must be a list of migration names");
  return buildMigrationManifest(entries, baselineNames);
}
export function input(name: string, fallback?: string) {
  const arg = process.argv.find(value => value.startsWith(`--${name}=`));
  const value = arg?.slice(name.length + 3) ?? fallback;
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}
