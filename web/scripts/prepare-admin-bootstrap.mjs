/** Generate owner-executed SQL only; never connect to Supabase or grant access. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";

const HELP = `Usage: node scripts/prepare-admin-bootstrap.mjs
  --user-id <existing-confirmed-auth-uuid>
  --environment <local|preview|production> --reason <reason>
  [--env-file <file>] [--out <new-sql-file>]

Reads NEXT_PUBLIC_SUPABASE_URL and ADMIN_ENVIRONMENT from the process, or
exclusively from --env-file. No implicit .env loading or secret keys required.
Prints SQL to stdout, or creates --out without overwriting an existing file.
Execute the SQL as postgres in the matching Supabase project's SQL Editor.
`;

function literal(value) {
  // Explicit escape-string syntax is independent of the owner's session setting.
  return `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

export function prepareAdminBootstrap({ userId, environment, reason }, env) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(userId ?? "")) {
    throw new Error("Provide an existing Auth user UUID with --user-id.");
  }
  if (!["local", "preview", "production"].includes(environment)) {
    throw new Error("--environment must be local, preview or production.");
  }
  if (env.ADMIN_ENVIRONMENT !== environment) {
    throw new Error("ADMIN_ENVIRONMENT is missing or does not match --environment.");
  }
  if (env.VERCEL === "1" && env.VERCEL_ENV !== (environment === "local" ? "development" : environment)) {
    throw new Error("Vercel and Admin environments do not match.");
  }
  if (typeof reason !== "string" || !reason || reason.trim() !== reason || [...reason].length > 500
    || [...reason].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)) {
    throw new Error("--reason must contain 1-500 characters, without surrounding whitespace or control characters.");
  }

  let url;
  try {
    url = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is missing or invalid.");
  }
  const hosted = /^([a-z0-9-]+)\.supabase\.co$/.exec(url.hostname);
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)
    || (environment === "local"
      ? !local || url.protocol !== "http:" || url.port !== "54321"
      : !hosted || url.protocol !== "https:" || Boolean(url.port))) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL does not match the Admin environment URL policy.");
  }

  const projectRef = environment === "local" ? "local" : hosted[1];
  const authIssuer = `${url.origin}/auth/v1`;
  return `-- First administrator initialization; execute as database owner.
-- Target environment: ${environment}; project: ${projectRef}
-- Supabase URL: ${url.origin}
-- Confirm this is the project open in SQL Editor before executing.
begin;

select public.admin_bootstrap_v1(
  p_user_id := ${literal(userId.toLowerCase())}::uuid,
  p_environment := ${literal(environment)},
  p_project_ref := ${literal(projectRef)},
  p_auth_issuer := ${literal(authIssuer)},
  p_reason := ${literal(reason)}
);

select environment, project_ref, control_plane_mode, revision
from public.admin_environment;
select user_id, revoked_at, revision from public.admin_principals;

commit;
`;
}

export function runAdminBootstrapCli(argv, processEnv = process.env) {
  let options;
  try {
    options = parseArgs({ args: argv, options: {
      "user-id": { type: "string" }, environment: { type: "string" },
      reason: { type: "string" }, "env-file": { type: "string" },
      out: { type: "string" }, help: { type: "boolean" },
    } }).values;
  } catch {
    throw new Error("Invalid arguments; use --help for usage.");
  }
  if (options.help) return HELP;
  let env = processEnv;
  if (options["env-file"] !== undefined) {
    try {
      // Do not combine a selected deployment file with stale process values.
      env = parseEnv(readFileSync(options["env-file"], "utf8"));
    } catch {
      throw new Error("Unable to read the selected environment file.");
    }
  }
  const sql = prepareAdminBootstrap({
    userId: options["user-id"], environment: options.environment, reason: options.reason,
  }, env);
  if (options.out !== undefined) {
    try {
      mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
      writeFileSync(options.out, sql, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch {
      throw new Error("Unable to create SQL output; choose a new file in a writable directory.");
    }
    return "SQL file created. No database changes made. Review its target and execute it as database owner.\n";
  }
  return sql;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(runAdminBootstrapCli(process.argv.slice(2)));
  } catch (error) {
    // Errors above are fixed messages, never raw env values, keys or file contents.
    process.stderr.write(`[admin:bootstrap] ${error.message}\n`);
    process.exitCode = 1;
  }
}
