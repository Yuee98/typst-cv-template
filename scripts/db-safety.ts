/** Pure guards shared by deployment tooling; this module performs no I/O. */
import { createHash, X509Certificate } from "node:crypto";
import { isAbsolute } from "node:path";
export const phases = ["intent", "reset_started", "migrations", "catalog_verified", "DB-ready", "accepted"] as const;
export type RebuildState = {
  operation_id: string;
  target: string;
  project: string;
  source_sha: string;
  baseline_digest: string;
  migration_manifest_digest: string;
  phase: string;
  history?: string[];
  instance?: string;
  intent_time: string;
  maintenance: boolean;
  reset_method?: "application_allowlist" | "local_native";
  cleanup_sql_digest?: string;
  retired_inventory_digest?: string;
};
const sha = (value: unknown) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const digest = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export function parseRebuildState(value: unknown): RebuildState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid durable rebuild state");
  const s = value as RebuildState;
  if (!/^[0-9a-f-]{36}$/.test(s.operation_id ?? "") || !["local", "rehearsal", "test", "prod"].includes(s.target) || !s.project || !sha(s.source_sha) || !digest(s.baseline_digest) || !digest(s.migration_manifest_digest) || !phases.includes(s.phase as typeof phases[number]) || typeof s.maintenance !== "boolean" || !Number.isFinite(Date.parse(s.intent_time)) || !s.maintenance && s.phase !== "accepted") throw new Error("Incomplete or inconsistent durable rebuild state");
  return s;
}
export function validateProjectIdentity(target: string, project: string, env: NodeJS.ProcessEnv) {
  if (!["test", "prod"].includes(target) || !project || env.REBUILD_PROJECT_REF !== project || !env.REBUILD_OTHER_PROJECT_REF || env.REBUILD_OTHER_PROJECT_REF === project) throw new Error("Environment project identity mismatch");
  const api = new URL(env.REBUILD_SUPABASE_URL ?? "");
  const db = new URL(env.REBUILD_DATABASE_URL ?? "");
  if (api.protocol !== "https:" || api.hostname !== `${project}.supabase.co` || api.port || api.username || api.password || api.search || api.hash || db.search || db.hash || db.pathname !== "/postgres" || !['postgres:', 'postgresql:'].includes(db.protocol) || !(db.hostname === `db.${project}.supabase.co` || db.hostname.endsWith('.pooler.supabase.com') && decodeURIComponent(db.username) === `postgres.${project}`)) throw new Error("API/database/ref do not identify the same project");
}
export function cleanPostgresEnvironment(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("PG")));
}
/** Only the explicitly supplied target CA may establish hosted database trust. */
export function hostedPostgresEnvironment(env: NodeJS.ProcessEnv, certificatePem: string): NodeJS.ProcessEnv {
  const file = env.REBUILD_CA_CERT_FILE;
  if (!file || !isAbsolute(file)) throw new Error("REBUILD_CA_CERT_FILE must name an explicit absolute target CA file");
  if (!/^-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----$/.test(certificatePem.trim())) throw new Error("Target CA file must contain one PEM X509 certificate");
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch {
    throw new Error("Target CA file is not a valid X509 certificate");
  }
  if (!certificate.ca) throw new Error("Target certificate must be an X509 CA certificate");
  const url = new URL(env.REBUILD_DATABASE_URL ?? "");
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.pathname !== "/postgres" || url.search || url.hash) throw new Error("Invalid hosted PostgreSQL connection");
  return {
    ...cleanPostgresEnvironment(env),
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: "postgres",
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: file,
    PGCONNECT_TIMEOUT: "15"
  };
}
export function requireMaintenanceAuthorization(env: NodeJS.ProcessEnv) {
  if (env.REBUILD_EXECUTION_AUTHORIZED !== "true" || env.REBUILD_MAINTENANCE_VERIFIED !== "true") throw new Error("Explicit authorization and verified API/integration maintenance are required for every mutating phase");
}
export function validateRehearsalIdentity(raw: string, inspected: {
  Name: string;
  NetworkSettings: {
    Ports: Record<string, Array<{
      HostIp: string;
      HostPort: string;
    }> | null>;
  };
}) {
  const url = new URL(raw);
  const bindings = inspected.NetworkSettings.Ports["5432/tcp"] ?? [];
  if (inspected.Name !== "/supabase_db_cv-remote-rehearsal" || !["127.0.0.1", "localhost"].includes(url.hostname) || !['postgres:', 'postgresql:'].includes(url.protocol) || decodeURIComponent(url.username) !== "postgres" || url.pathname !== "/postgres" || url.search || url.hash || !bindings.some(binding => binding.HostPort === url.port)) throw new Error("Remote-mode rehearsal is restricted to its dedicated loopback container");
}
const transactionError = () => new Error("Resumed migration must have exactly one explicit outer transaction");
const whitespace = (character: string | undefined) => character !== undefined && /\s/.test(character);
const identifierStart = (character: string | undefined) => character !== undefined && /[a-z_\u0080-\uffff]/i.test(character);
const identifierPart = (character: string | undefined) => character !== undefined && /[a-z_0-9$\u0080-\uffff]/i.test(character);
function skipWhitespace(source: string, cursor: number) {
  while (whitespace(source[cursor])) cursor++;
  return cursor;
}
/** Each comment character is consumed once; block comments nest in PostgreSQL. */
function skipSqlTrivia(source: string, cursor: number) {
  for (;;) {
    cursor = skipWhitespace(source, cursor);
    if (source.startsWith("--", cursor)) {
      cursor += 2;
      while (cursor < source.length && source[cursor] !== "\n" && source[cursor] !== "\r") cursor++;
    } else if (source.startsWith("/*", cursor)) {
      cursor += 2;
      let depth = 1;
      while (cursor < source.length && depth > 0) {
        if (source.startsWith("/*", cursor)) {
          depth++;
          cursor += 2;
        } else if (source.startsWith("*/", cursor)) {
          depth--;
          cursor += 2;
        } else cursor++;
      }
      if (depth !== 0) throw transactionError();
    } else return cursor;
  }
}
function identifierEnd(source: string, cursor: number) {
  while (identifierPart(source[cursor])) cursor++;
  return cursor;
}
function quotedEnd(source: string, cursor: number, quote: string, escapes: boolean) {
  cursor++;
  while (cursor < source.length) {
    if (escapes && source[cursor] === "\\") cursor += 2;
    else if (source[cursor] === quote) {
      if (source[cursor + 1] !== quote) return cursor + 1;
      cursor += 2;
    } else cursor++;
  }
  throw transactionError();
}
/**
 * Identify statement boundaries only, without interpreting SQL. In particular,
 * comments/quoted bodies cannot hide a second transaction from the history write.
 * All scanning advances a cursor; no repeated variable-length regex alternatives.
 */
export function migrationWithHistory(source: string, version: string, name: string) {
  if (!/^\d+$/.test(version) || !/^\d+_[a-z_0-9]+\.sql$/.test(name) || !name.startsWith(`${version}_`)) throw new Error("Invalid migration history identity");
  const headerEnd = skipSqlTrivia(source, 0);
  const beginEnd = identifierEnd(source, headerEnd);
  if (source.slice(headerEnd, beginEnd).toLowerCase() !== "begin") throw transactionError();
  const beginSemicolon = skipWhitespace(source, beginEnd);
  if (source[beginSemicolon] !== ";") throw transactionError();
  const bodyStart = beginSemicolon + 1;
  const label = name.slice(version.length + 1, -4);
  let cursor = bodyStart;
  let statementStart = true;
  while (cursor < source.length) {
    cursor = skipSqlTrivia(source, cursor);
    if (cursor === source.length) break;
    const character = source[cursor];
    if (identifierStart(character)) {
      const end = identifierEnd(source, cursor);
      const keyword = source.slice(cursor, end).toLowerCase();
      if (statementStart) {
        if (keyword === "commit") {
          const semicolon = skipWhitespace(source, end);
          if (source[semicolon] !== ";" || skipWhitespace(source, semicolon + 1) !== source.length) throw transactionError();
          return `${source.slice(0, headerEnd)}begin;${source.slice(bodyStart, cursor)}\ninsert into supabase_migrations.schema_migrations(version,name) values('${version}','${label}');\ncommit;`;
        }
        if (["begin", "rollback", "end", "abort"].includes(keyword)) throw transactionError();
        if (keyword === "start" || keyword === "prepare") {
          const next = skipSqlTrivia(source, end);
          if (source.slice(next, identifierEnd(source, next)).toLowerCase() === "transaction") throw transactionError();
        }
      }
      cursor = end;
    } else if (character === "'" || character === '"') {
      // Standard strings use doubled quotes. Only E'...' recognizes backslashes.
      const escapes = character === "'" && source[cursor - 1]?.toLowerCase() === "e" && !identifierPart(source[cursor - 2]);
      cursor = quotedEnd(source, cursor, character, escapes);
    } else if (character === "$") {
      let end = cursor + 1;
      if (/[0-9]/.test(source[end] ?? "")) {
        while (/[0-9]/.test(source[end] ?? "")) end++;
        cursor = end;
      } else {
        if (identifierStart(source[end])) {
          end++;
          while (identifierPart(source[end]) && source[end] !== "$") end++;
        }
        if (source[end] !== "$") throw transactionError();
        const delimiter = source.slice(cursor, end + 1);
        const close = source.indexOf(delimiter, end + 1);
        if (close < 0) throw transactionError();
        cursor = close + delimiter.length;
      }
    } else if (character === ";") {
      statementStart = true;
      cursor++;
      continue;
    } else {
      // Do not interpret psql metacommands/substitutions or unmatched comment ends.
      if (character === "\\" || character === "\0" || source.startsWith("*/", cursor) || character === ":" && source[cursor + 1] !== ":") throw transactionError();
      cursor += character === ":" ? 2 : 1;
    }
    statementStart = false;
  }
  throw transactionError();
}
export function requireAcceptedTest(state: RebuildState, project: string | undefined, sourceSha: string, manifest: {
  baseline_digest: string;
  migration_manifest_digest: string;
}) {
  if (state.target !== "test" || state.project !== project || state.phase !== "accepted" || state.source_sha !== sourceSha || state.baseline_digest !== manifest.baseline_digest || state.migration_manifest_digest !== manifest.migration_manifest_digest) throw new Error("Prod requires accepted test evidence for the other project at the same SHA and digests");
}
export function validateDatabaseServer(identity: {
  server_version_num: string;
  database: string;
  current_user: string;
}) {
  const number = Number(identity.server_version_num);
  if (!Number.isInteger(number) || Math.floor(number / 10000) !== 17 || identity.database !== "postgres") throw new Error("Rebuild requires PostgreSQL 17 and the postgres database before any destructive intent");
}
export function requireFreshApplicationState(state: {
  application_tables: number;
  environment_relation: boolean;
  instance_id: string | null;
}) {
  if (state.application_tables > 0 || state.environment_relation || state.instance_id !== null) throw new Error("Existing current application objects or database instance require inspection/resume; rebuilding is forbidden even without migration history");
}
/** Every previously planned migration stays byte-identical, including appended fixes. */
export function requireAppendOnlyManifest(previousDigest: string, files: Array<{
  name: string;
  digest: string;
}>) {
  const unchangedPrefix = files.some((_, index) => index >= 3 && createHash("sha256").update(JSON.stringify(files.slice(0, index + 1))).digest("hex") === previousDigest);
  if (!unchangedPrefix) throw new Error("Existing operation requires unchanged migration files; only append new migrations");
}
export function requireRecoveryEvidence(proof: Record<string, unknown>, state: RebuildState, manifest: {
  baseline_digest: string;
  migration_manifest_digest: string;
}, catalogDigest: string) {
  if (proof.method !== state.reset_method || proof.cleanup_sql_digest !== state.cleanup_sql_digest || proof.retired_inventory_digest !== state.retired_inventory_digest || proof.operation_id !== state.operation_id || proof.project !== state.project || proof.source_sha !== state.source_sha || proof.baseline_digest !== manifest.baseline_digest || proof.migration_manifest_digest !== manifest.migration_manifest_digest || proof.reset_catalog_digest !== catalogDigest || proof.reset_completed !== true || proof.platform_preservation_passed !== true) throw new Error("Recovery method, identity, manifests or inspected catalog do not match durable intent");
}
export function requireRehearsalEvidence(proof: Record<string, unknown>, sourceSha: string, manifest: {
  baseline_digest: string;
  migration_manifest_digest: string;
}, cleanup: {
  reset_method: string;
  cleanup_sql_digest: string;
  retired_inventory_digest: string;
}) {
  if (proof.source_sha !== sourceSha || proof.method !== cleanup.reset_method || proof.cleanup_sql_digest !== cleanup.cleanup_sql_digest || proof.retired_inventory_digest !== cleanup.retired_inventory_digest || proof.cli_version !== "2.109.0" || proof.baseline_digest !== manifest.baseline_digest || proof.migration_manifest_digest !== manifest.migration_manifest_digest || proof.old_chain_passed !== true || proof.platform_preservation_passed !== true || proof.remote_mode_resume_passed !== true) throw new Error("Matching disposable remote-mode source SHA, allowlist and preservation/resume evidence required");
}
