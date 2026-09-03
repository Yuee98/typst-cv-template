import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODE_ID = /^[a-z0-9][a-z0-9._-]{0,199}$/;
const BUILD_ID = /^[a-z0-9][a-z0-9._:-]{0,199}$/;
const PROJECT_REF = /^[a-z0-9-]{1,100}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_COMMIT = /^(?:sha1:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/;
const OFFSET_TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;
const ENVIRONMENTS = new Set(["local", "preview", "production"]);
const INPUT_KEYS = [
  "schemaVersion",
  "id",
  "environment",
  "projectRef",
  "runtimeBuildId",
  "bindingManifestRevision",
  "bindingManifestSha256",
  "codeCapabilityIds",
  "reviewedEvidenceIds",
  "reviewedSourceCommitOid",
  "reviewedSourceSha256",
  "validUntil",
].sort();

function strictRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("reviewed deployment input must be an object");
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(INPUT_KEYS)) {
    throw new Error("reviewed deployment input has missing or unknown fields");
  }
  return value;
}

function exactSet(value, pattern, minimum, maximum, label) {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    value.some((item) => typeof item !== "string" || !pattern.test(item)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label} is invalid`);
  }
  return [...value].sort();
}

export function parseReviewedDeploymentImport(value, now = Date.now()) {
  const input = strictRecord(value);
  if (
    input.schemaVersion !== "admin_reviewed_deployment_import_v1" ||
    typeof input.id !== "string" ||
    !UUID.test(input.id) ||
    !ENVIRONMENTS.has(input.environment) ||
    typeof input.projectRef !== "string" ||
    !PROJECT_REF.test(input.projectRef) ||
    typeof input.runtimeBuildId !== "string" ||
    !BUILD_ID.test(input.runtimeBuildId) ||
    typeof input.bindingManifestRevision !== "string" ||
    !CODE_ID.test(input.bindingManifestRevision) ||
    typeof input.bindingManifestSha256 !== "string" ||
    !SHA256.test(input.bindingManifestSha256) ||
    typeof input.reviewedSourceCommitOid !== "string" ||
    !SOURCE_COMMIT.test(input.reviewedSourceCommitOid) ||
    typeof input.reviewedSourceSha256 !== "string" ||
    !SHA256.test(input.reviewedSourceSha256) ||
    typeof input.validUntil !== "string" ||
    !OFFSET_TIMESTAMP.test(input.validUntil)
  ) {
    throw new Error("reviewed deployment identity is invalid");
  }
  const validUntil = Date.parse(input.validUntil);
  if (!Number.isFinite(validUntil) || validUntil <= now) {
    throw new Error("reviewed deployment validity is invalid");
  }
  return Object.freeze({
    ...input,
    codeCapabilityIds: Object.freeze(
      exactSet(input.codeCapabilityIds, CODE_ID, 1, 32, "code capability IDs"),
    ),
    reviewedEvidenceIds: Object.freeze(
      exactSet(input.reviewedEvidenceIds, CODE_ID, 1, 64, "reviewed evidence IDs"),
    ),
    validUntil: new Date(validUntil).toISOString(),
  });
}

function literal(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function textArray(values) {
  return `array[${values.map(literal).join(",")}]::text[]`;
}

export function reviewedDeploymentImportSql(input) {
  const value = parseReviewedDeploymentImport(input);
  return [
    "\\set ON_ERROR_STOP on",
    "begin;",
    "select public.admin_import_reviewed_deployment_v1(",
    `  ${literal(value.id)}::uuid,`,
    `  ${literal(value.environment)}, ${literal(value.projectRef)},`,
    `  ${literal(value.runtimeBuildId)},`,
    `  ${literal(value.bindingManifestRevision)},`,
    `  ${literal(value.bindingManifestSha256)},`,
    `  ${textArray(value.codeCapabilityIds)},`,
    `  ${textArray(value.reviewedEvidenceIds)},`,
    `  ${literal(value.reviewedSourceCommitOid)},`,
    `  ${literal(value.reviewedSourceSha256)},`,
    `  ${literal(value.validUntil)}::timestamptz`,
    ");",
    "commit;",
    "",
  ].join("\n");
}

export function runReviewedDeploymentImport(
  args,
  {
    readFile = readFileSync,
    spawn = spawnSync,
    stdout = process.stdout,
    env = process.env,
  } = {},
) {
  const execute = args.includes("--execute");
  const filtered = args.filter((value) => value !== "--execute");
  const ackIndex = filtered.indexOf("--ack");
  const acknowledgement = ackIndex >= 0 ? filtered[ackIndex + 1] : null;
  if (ackIndex >= 0) filtered.splice(ackIndex, 2);
  if (filtered.length !== 1 || ackIndex >= 0 && !acknowledgement) {
    throw new Error("usage: admin-reviewed-deployment-import [--execute --ack environment/project] input.json");
  }
  const input = parseReviewedDeploymentImport(
    JSON.parse(readFile(path.resolve(filtered[0]), "utf8")),
  );
  const sql = reviewedDeploymentImportSql(input);
  if (!execute) {
    stdout.write(sql);
    return 0;
  }
  if (acknowledgement !== `${input.environment}/${input.projectRef}`) {
    throw new Error("execution acknowledgement does not match the reviewed environment");
  }
  if (
    typeof env.PGHOST !== "string" ||
    env.PGHOST.length === 0 ||
    typeof env.PGDATABASE !== "string" ||
    env.PGDATABASE.length === 0 ||
    typeof env.PGUSER !== "string" ||
    !/^(?:postgres(?:\.[a-z0-9-]+)?|supabase_admin)$/.test(env.PGUSER)
  ) {
    throw new Error("explicit DB-owner PGHOST, PGDATABASE and PGUSER are required");
  }
  const result = spawn(
    "psql",
    ["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--file", "-"],
    {
      input: sql,
      stdio: ["pipe", "inherit", "inherit"],
      encoding: "utf8",
      env,
    },
  );
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("owner import failed");
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runReviewedDeploymentImport(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "owner import failed");
    process.exitCode = 1;
  }
}
